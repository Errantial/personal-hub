import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Temporal,
  calendarWriteSchema,
  calendarResponseSchema,
  calendarListSchema,
  calendarRecordSchema,
  occurrencesResponseSchema,
  expandEvent,
  rangeSchema,
  dateOnly,
  deleteItemSchema,
  restoreItemSchema,
  recurrenceSchema,
  recurrenceDates,
} from '@hub/contracts';
import type {
  CalendarRecord,
  CalendarInput,
  EventException,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule as mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { syncEventReminderOffsets } from './recurrence.js';
import { transactionDatabase } from '../planner/nested-database.js';
import { restorePlannerItem } from '../planner/restore.js';
import { captureCanvasSource } from '../connections/canvas-provenance.js';
import {
  academicPlannerLabels,
  extendAcademicEventLabels,
} from './academic-provenance.js';
import {
  academicLabels,
  mergeAcademicLabels,
  active,
  eventColumns,
  strongest,
  version,
} from './common.js';

export async function readEvent(
  tx: QueryExecutor,
  owner: string,
  id: string,
): Promise<CalendarRecord> {
  const [row] = await tx.query(
    `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [owner, id],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'This event is no longer available.');
  return calendarRecordSchema.parse(row);
}
export async function readExceptions(
  tx: QueryExecutor,
  id: string,
): Promise<EventException[]> {
  const rows = await tx.query<EventException & Record<string, unknown>>(
    `SELECT to_char(x.original_date,'YYYY-MM-DD') AS "originalDate",x.cancelled,x.replacement,
      c.sensitivity AS "courseSensitivity",t.sensitivity AS "topicSensitivity"
      FROM event_exceptions x JOIN events e ON e.id=x.event_id
      LEFT JOIN courses c ON c.id=(x.replacement->>'courseId')::uuid AND c.owner_id=e.owner_id
      LEFT JOIN topics t ON t.id=(x.replacement->>'topicId')::uuid AND t.owner_id=e.owner_id
      WHERE x.event_id=$1`,
    [id],
  );
  return rows.map((row) => ({
    originalDate: row.originalDate,
    cancelled: row.cancelled,
    replacement: row.replacement
      ? {
          ...row.replacement,
          sensitivity: strongest(
            row.replacement.sensitivity,
            String(row.courseSensitivity ?? 'unlabeled'),
            String(row.topicSensitivity ?? 'unlabeled'),
          ),
        }
      : null,
  }));
}
export function occurrenceExists(event: CalendarRecord, date: string) {
  return expandEvent(
    event,
    date,
    Temporal.PlainDate.from(date).add({ days: 1 }).toString(),
    event.timeZone,
  ).some((value) => value.originalDate === date);
}
export function normalizeEvent(input: CalendarInput): CalendarInput {
  return input.allDay
    ? {
        ...input,
        startsAt: `${input.startDate}T00:00:00.000Z`,
        endsAt: `${input.endDate}T00:00:00.000Z`,
      }
    : input;
}
export async function createStudyEvent(
  tx: QueryExecutor,
  owner: string,
  input: CalendarInput,
  workloadLabels?: string[],
) {
  // Uses the same validated calendar input, academic ancestors, labels and row shape.
  const values = normalizeEvent(
    calendarWriteSchema.parse({ ...input, operationId: randomUUID() }),
  );
  if (!values.courseId || values.allDay || values.recurrence)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'Use a one-time timed study block.',
    );
  const inherited = await academicLabels(
    tx,
    owner,
    values.courseId,
    values.topicId,
  );
  const labels = mergeAcademicLabels(
    undefined,
    inherited.complete && workloadLabels === undefined
      ? [
          ...inherited.labels,
          ...[values.sensitivity].filter((v) => v !== 'unlabeled'),
        ]
      : null,
  );
  const [row] = await tx.query(
    `INSERT INTO events(id,owner_id,title,notes,starts_at,ends_at,time_zone,sensitivity,all_day,start_date,end_date,recurrence,course_id,topic_id,study_status,academic_labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,NULL,NULL,NULL,$9,$10,'planned',$11::text[]) RETURNING ${eventColumns}`,
    [
      randomUUID(),
      owner,
      values.title,
      values.notes,
      values.startsAt,
      values.endsAt,
      values.timeZone,
      strongest(
        values.sensitivity,
        ...inherited.labels,
        ...(workloadLabels ?? []),
      ),
      values.courseId,
      values.topicId,
      labels,
    ],
  );
  return calendarRecordSchema.parse(row);
}
/**
 * Creates, updates or deletes one calendar event through the versioned,
 * receipted mutation. Routes and the agent worker (D57) share it.
 */
export async function saveEvent(
  database: Database,
  owner: string,
  method: 'POST' | 'PUT' | 'DELETE',
  target: string | null,
  body: unknown,
): Promise<z.infer<typeof calendarResponseSchema>> {
  if (method === 'DELETE') {
    const id = z.string().uuid().parse(target);
    const input = deleteItemSchema.parse(body);
    return mutate(
      database,
      owner,
      input.operationId,
      { kind: 'calendar.delete', id, input },
      async (tx) => {
        version(await active(tx, 'events', owner, id), input.expectedVersion);
        const [row] = await tx.query(
          `UPDATE events SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING ${eventColumns}`,
          [owner, id],
        );
        await tx.query(
          `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
             updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
             AND status IN ('queued','running','paused')`,
          [owner, id],
        );
        return calendarResponseSchema.parse({ event: row });
      },
    );
  }
  const input = calendarWriteSchema.parse(body);
  if (method === 'PUT' && input.clientId)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'clientId is only supported when creating an event.',
    );
  const id =
    method === 'PUT'
      ? z.string().uuid().parse(target)
      : (input.clientId ?? randomUUID());
  return mutate(
    database,
    owner,
    input.operationId,
    { method, id: method === 'PUT' ? id : null, input },
    async (tx) => {
      if (method === 'PUT' && input.canvasSourceRef)
        throw new ApiError(
          400,
          'SOURCE_IMMUTABLE',
          'Planner source links cannot be replaced.',
        );
      const source =
        method === 'POST'
          ? await captureCanvasSource(tx, owner, input.canvasSourceRef)
          : null;
      if (method === 'POST' && input.clientId) {
        const [existing] = await tx.query(
          'SELECT id FROM events WHERE owner_id=$1 AND id=$2',
          [owner, id],
        );
        if (existing)
          throw new ApiError(
            409,
            'OPERATION_CONFLICT',
            'This event ID is already in use.',
          );
      }
      if (source && (!input.courseId || input.allDay || input.recurrence))
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'Select a class and a one-time timed study block.',
        );
      // Lock academic ancestors before the event, matching source-label propagation.
      const inherited = await academicLabels(
        tx,
        owner,
        input.courseId,
        input.topicId,
      );
      const old =
        method === 'PUT' ? await active(tx, 'events', owner, id) : null;
      if (old) version(old, input.expectedVersion);
      if (method === 'PUT')
        await extendAcademicEventLabels(tx, owner, id, inherited.labels);
      const values = normalizeEvent(input);
      const explicit =
        body && typeof body === 'object' && 'sensitivity' in body;
      const ownLabel = explicit
        ? values.sensitivity
        : String(old?.sensitivity ?? values.sensitivity);
      const capturedLabels = mergeAcademicLabels(
        old?.academic_labels,
        inherited.complete
          ? [
              ...inherited.labels,
              ...(input.courseId || input.topicId
                ? [ownLabel].filter((label) => label !== 'unlabeled')
                : []),
            ]
          : null,
      );
      values.sensitivity = strongest(
        ownLabel,
        ...inherited.labels,
        ...(method === 'PUT'
          ? await academicPlannerLabels(tx, owner, 'event', id)
          : []),
      );
      const params = [
        id,
        owner,
        values.title,
        values.notes,
        values.startsAt,
        values.endsAt,
        values.timeZone,
        values.sensitivity,
        values.allDay,
        values.startDate,
        values.endDate,
        JSON.stringify(values.recurrence),
        values.courseId,
        values.topicId,
        values.studyStatus,
        JSON.stringify(
          values.reminderOffsets ??
            (method === 'PUT' ? old?.reminder_offsets : null) ??
            [],
        ),
      ];
      const [row] =
        method === 'POST'
          ? await tx.query(
              `INSERT INTO events (id,owner_id,title,notes,starts_at,ends_at,time_zone,sensitivity,all_day,start_date,end_date,recurrence,course_id,topic_id,study_status,reminder_offsets,canvas_source_id,canvas_source_snapshot,canvas_assignment_id,canvas_assignment_snapshot,academic_labels) VALUES (${params.map((_, i) => `$${i + 1}`).join(',')},$17,$18::jsonb,$19,$20::jsonb,$21::text[]) ON CONFLICT (id) DO NOTHING RETURNING ${eventColumns}`,
              [
                ...params,
                source?.inputKind !== 'assignment-api'
                  ? (source?.itemId ?? null)
                  : null,
                source && source.inputKind !== 'assignment-api'
                  ? JSON.stringify(source)
                  : null,
                source?.inputKind === 'assignment-api' ? source.itemId : null,
                source?.inputKind === 'assignment-api'
                  ? JSON.stringify(source)
                  : null,
                capturedLabels,
              ],
            )
          : await tx.query(
              `UPDATE events SET title=$3,notes=$4,starts_at=$5,ends_at=$6,time_zone=$7,sensitivity=$8,all_day=$9,start_date=$10,end_date=$11,recurrence=$12,course_id=$13,topic_id=$14,study_status=$15,reminder_offsets=$16::jsonb,academic_labels=$17::text[],version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_id=$2 RETURNING ${eventColumns}`,
              [...params, capturedLabels],
            );
      if (!row)
        throw new ApiError(
          409,
          method === 'POST' ? 'OPERATION_CONFLICT' : 'VERSION_CONFLICT',
          method === 'POST'
            ? 'This identifier is already in use.'
            : 'This event changed elsewhere. Reload before trying again.',
        );
      // A changed series anchor/rule invalidates occurrence exceptions and linked occurrence reminders.
      if (
        old &&
        ((old.starts_at instanceof Date
          ? old.starts_at.toISOString()
          : new Date(String(old.starts_at)).toISOString()) !==
          values.startsAt ||
          old.time_zone !== values.timeZone ||
          old.all_day !== values.allDay ||
          JSON.stringify(
            old.recurrence ? recurrenceSchema.parse(old.recurrence) : null,
          ) !== JSON.stringify(values.recurrence))
      ) {
        await tx.query('DELETE FROM event_exceptions WHERE event_id=$1', [id]);
        await tx.query(
          "UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND target_id=$2 AND target_kind='event' AND occurrence_date IS NOT NULL AND status IN ('queued','running','paused')",
          [owner, id],
        );
      }
      await syncEventReminderOffsets(tx, owner, id);
      return calendarResponseSchema.parse({ event: row });
    },
  );
}
export function registerCalendar(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get('/api/v1/calendar/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await database.query(
      `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=$2`,
      [user.id, id],
    );
    if (!row)
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This event is no longer available.',
      );
    return calendarResponseSchema.parse({ event: row });
  });
  app.post('/api/v1/calendar/:id/restore', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = restoreItemSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'calendar.restore', id, input },
      async (tx) => {
        const event = await restorePlannerItem(
          tx,
          'events',
          eventColumns,
          user.id,
          id,
          input.expectedVersion,
        );
        await syncEventReminderOffsets(tx, user.id, id);
        return calendarResponseSchema.parse({ event });
      },
    );
  });
  app.get('/api/v1/calendar', async (request) => {
    const user = await auth.requireUser(request);
    return calendarListSchema.parse({
      events: await database.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY starts_at,id`,
        [user.id],
      ),
    });
  });
  app.get('/api/v1/calendar/occurrences', async (request) => {
    const user = await auth.requireUser(request);
    const range = rangeSchema.parse(request.query);
    const rows = await database.query(
      `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND deleted_at IS NULL`,
      [user.id],
    );
    const occurrences = [];
    for (const row of rows) {
      const event = calendarRecordSchema.parse(row);
      occurrences.push(
        ...expandEvent(
          event,
          range.from,
          range.to,
          range.timeZone,
          await readExceptions(database, event.id),
        ),
      );
    }
    return occurrencesResponseSchema.parse({
      occurrences: occurrences.sort((a, b) =>
        a.startsAt.localeCompare(b.startsAt),
      ),
    });
  });
  for (const method of ['POST', 'PUT'] as const)
    app.route({
      method,
      url: `/api/v1/calendar${method === 'PUT' ? '/:id' : ''}`,
      handler: async (request) => {
        const user = await auth.requireUser(request);
        const id =
          method === 'PUT'
            ? z.object({ id: z.string().uuid() }).parse(request.params).id
            : null;
        return saveEvent(database, user.id, method, id, request.body);
      },
    });
  app.delete('/api/v1/calendar/:id', async (request) => {
    const user = await auth.requireUser(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return saveEvent(database, user.id, 'DELETE', id, request.body);
  });
  for (const method of ['PUT', 'DELETE'] as const)
    app.route({
      method,
      url: '/api/v1/calendar/:id/occurrences/:date',
      handler: async (request) => {
        const user = await auth.requireUser(request);
        const { id, date } = z
          .object({ id: z.string().uuid(), date: dateOnly })
          .parse(request.params);
        const input =
          method === 'PUT'
            ? calendarWriteSchema.parse(request.body)
            : deleteItemSchema.parse(request.body);
        if ('canvasSourceRef' in input && input.canvasSourceRef)
          throw new ApiError(
            400,
            'SOURCE_IMMUTABLE',
            'Planner source links cannot be replaced.',
          );
        return mutate(
          database,
          user.id,
          input.operationId,
          { kind: 'occurrence', method, id, date, input },
          async (tx) => {
            const inherited =
              'title' in input
                ? await academicLabels(
                    tx,
                    user.id,
                    input.courseId,
                    input.topicId,
                  )
                : null;
            version(
              await active(tx, 'events', user.id, id),
              input.expectedVersion,
            );
            const event = await readEvent(tx, user.id, id);
            if (!event.recurrence || !occurrenceExists(event, date))
              throw new ApiError(
                404,
                'NOT_FOUND',
                'This occurrence does not exist.',
              );
            const scope = 'scope' in input ? (input.scope ?? 'this') : 'this';
            const anchor = event.startDate
              ? event.startDate
              : Temporal.Instant.from(event.startsAt)
                  .toZonedDateTimeISO(event.timeZone)
                  .toPlainDate()
                  .toString();
            if (scope === 'future' && date === anchor) {
              if (method === 'DELETE') {
                await tx.query(
                  `UPDATE events SET deleted_at=CURRENT_TIMESTAMP,
                     updated_at=CURRENT_TIMESTAMP,version=version+1
                   WHERE owner_id=$1 AND id=$2`,
                  [user.id, id],
                );
                await tx.query(
                  `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
                     updated_at=CURRENT_TIMESTAMP
                   WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
                     AND status IN ('queued','running','paused')`,
                  [user.id, id],
                );
                return calendarResponseSchema.parse({
                  event: await readEvent(tx, user.id, id),
                });
              }
              return saveEvent(transactionDatabase(tx), user.id, 'PUT', id, {
                ...input,
                expectedVersion: input.expectedVersion,
                operationId: randomUUID(),
              });
            }
            if (scope === 'future' && date !== anchor) {
              if (method === 'DELETE') {
                const until = Temporal.PlainDate.from(date)
                  .subtract({ days: 1 })
                  .toString();
                await tx.query(
                  `UPDATE events SET recurrence=$3::jsonb,version=version+1,
                     updated_at=CURRENT_TIMESTAMP
                   WHERE owner_id=$1 AND id=$2`,
                  [
                    user.id,
                    id,
                    JSON.stringify({ ...event.recurrence, until, count: null }),
                  ],
                );
                await tx.query(
                  'DELETE FROM event_exceptions WHERE event_id=$1 AND original_date >= $2',
                  [id, date],
                );
                await tx.query(
                  `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
                     updated_at=CURRENT_TIMESTAMP
                   WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
                     AND occurrence_date >= $3
                     AND status IN ('queued','running','paused')`,
                  [user.id, id, date],
                );
                return calendarResponseSchema.parse({
                  event: await readEvent(tx, user.id, id),
                });
              }
              const [raw] = await tx.query<Record<string, unknown>>(
                'SELECT * FROM events WHERE owner_id=$1 AND id=$2 FOR UPDATE',
                [user.id, id],
              );
              if (!raw) throw new ApiError(404, 'NOT_FOUND', 'Event missing.');
              if (!('title' in input))
                throw new ApiError(
                  400,
                  'INVALID_INPUT',
                  'Choose the event fields to save.',
                );
              const values = normalizeEvent(input as CalendarInput);
              const futureId = randomUUID();
              const until = Temporal.PlainDate.from(date)
                .subtract({ days: 1 })
                .toString();
              const anchorDate = Temporal.PlainDate.from(
                event.startDate ??
                  Temporal.Instant.from(event.startsAt)
                    .toZonedDateTimeISO(event.timeZone)
                    .toPlainDate()
                    .toString(),
              );
              const before = recurrenceDates(
                event.recurrence,
                anchorDate,
                anchorDate,
                Temporal.PlainDate.from(date).subtract({ days: 1 }),
              ).length;
              const remaining = event.recurrence.count
                ? Math.max(1, event.recurrence.count - before)
                : null;
              const futureRecurrence = values.recurrence
                ? {
                    ...values.recurrence,
                    count:
                      values.recurrence.count !== null && remaining !== null
                        ? Math.min(values.recurrence.count, remaining)
                        : values.recurrence.count,
                  }
                : null;
              const labels = inherited!.complete
                ? mergeAcademicLabels(event.academicLabels, [
                    ...inherited!.labels,
                    ...[input.sensitivity].filter(
                      (label) => label !== 'unlabeled',
                    ),
                  ])
                : event.academicLabels;
              await tx.query(
                `INSERT INTO events(id,owner_id,title,notes,starts_at,ends_at,
                   time_zone,sensitivity,all_day,start_date,end_date,recurrence,
                   course_id,topic_id,study_status,reminder_offsets,
                   canvas_source_id,canvas_source_snapshot,canvas_assignment_id,
                   canvas_assignment_snapshot,academic_labels,ai_origin,ai_labels)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,
                   $15,$16::jsonb,$17,$18::jsonb,$19,$20::jsonb,$21::text[],
                   $22,$23::text[])`,
                [
                  futureId,
                  user.id,
                  values.title,
                  values.notes,
                  values.startsAt,
                  values.endsAt,
                  values.timeZone,
                  strongest(
                    event.sensitivity,
                    input.sensitivity,
                    ...inherited!.labels,
                  ),
                  values.allDay,
                  values.startDate,
                  values.endDate,
                  futureRecurrence ? JSON.stringify(futureRecurrence) : null,
                  values.courseId,
                  values.topicId,
                  values.studyStatus,
                  JSON.stringify(values.reminderOffsets ?? []),
                  raw.canvas_source_id,
                  raw.canvas_source_snapshot
                    ? JSON.stringify(raw.canvas_source_snapshot)
                    : null,
                  raw.canvas_assignment_id,
                  raw.canvas_assignment_snapshot
                    ? JSON.stringify(raw.canvas_assignment_snapshot)
                    : null,
                  labels,
                  raw.ai_origin,
                  raw.ai_labels,
                ],
              );
              await tx.query(
                `UPDATE events SET recurrence=$3::jsonb,version=version+1,
                   updated_at=CURRENT_TIMESTAMP
                 WHERE owner_id=$1 AND id=$2`,
                [
                  user.id,
                  id,
                  JSON.stringify({ ...event.recurrence, until, count: null }),
                ],
              );
              await tx.query(
                'UPDATE event_exceptions SET event_id=$3 WHERE event_id=$1 AND original_date >= $2',
                [id, date, futureId],
              );
              await tx.query(
                `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
                   updated_at=CURRENT_TIMESTAMP
                 WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
                   AND occurrence_date >= $3
                   AND status IN ('queued','running','paused')`,
                [user.id, id, date],
              );
              await syncEventReminderOffsets(tx, user.id, futureId);
              return calendarResponseSchema.parse({
                event: await readEvent(tx, user.id, futureId),
              });
            }
            if (scope === 'series') {
              if (method === 'DELETE') {
                await tx.query(
                  `UPDATE events SET deleted_at=CURRENT_TIMESTAMP,
                     updated_at=CURRENT_TIMESTAMP,version=version+1
                   WHERE owner_id=$1 AND id=$2`,
                  [user.id, id],
                );
                await tx.query(
                  `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
                     updated_at=CURRENT_TIMESTAMP
                   WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
                     AND status IN ('queued','running','paused')`,
                  [user.id, id],
                );
                return calendarResponseSchema.parse({
                  event: await readEvent(tx, user.id, id),
                });
              }
              return saveEvent(transactionDatabase(tx), user.id, 'PUT', id, {
                ...input,
                expectedVersion: input.expectedVersion,
                operationId: randomUUID(),
              });
            }
            let replacement: CalendarInput | null = null;
            let capturedLabels = event.academicLabels;
            if ('title' in input) {
              if (input.recurrence)
                throw new ApiError(
                  400,
                  'INVALID_INPUT',
                  'An occurrence cannot repeat.',
                );
              replacement = normalizeEvent(input);
              await extendAcademicEventLabels(
                tx,
                user.id,
                id,
                inherited!.labels,
              );
              capturedLabels = mergeAcademicLabels(
                event.academicLabels,
                inherited!.complete
                  ? [
                      ...inherited!.labels,
                      ...[input.sensitivity].filter(
                        (label) => label !== 'unlabeled',
                      ),
                    ]
                  : null,
              );
              replacement.sensitivity = strongest(
                event.sensitivity,
                input.sensitivity,
                ...inherited!.labels,
              );
            }
            await tx.query(
              'INSERT INTO event_exceptions (event_id,original_date,cancelled,replacement) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id,original_date) DO UPDATE SET cancelled=EXCLUDED.cancelled,replacement=EXCLUDED.replacement',
              [
                id,
                date,
                method === 'DELETE',
                replacement ? JSON.stringify(replacement) : null,
              ],
            );
            await tx.query(
              "UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND target_id=$2 AND target_kind='event' AND occurrence_date=$3 AND status IN ('queued','running','paused')",
              [user.id, id, date],
            );
            await tx.query(
              'UPDATE events SET version=version+1,academic_labels=$2::text[],updated_at=CURRENT_TIMESTAMP WHERE id=$1',
              [id, capturedLabels],
            );
            return calendarResponseSchema.parse({
              event: await readEvent(tx, user.id, id),
            });
          },
        );
      },
    });
}
