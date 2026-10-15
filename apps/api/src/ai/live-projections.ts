import {
  Temporal,
  calendarRecordSchema,
  sensitivitySchema,
  taskSchema,
} from '@hub/contracts';
import type { CalendarRecord, Task } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { eventColumns } from '../features/common.js';
import { taskColumns } from '../planner/routes.js';
import { sourceDigest } from './live-manifest.js';
import type { LiveSource } from './live-manifest.js';

// Live planner projections (docs/live-context-admission-design.md). These are
// exactly the fields the Assistant has always sent; the manifest binds each
// projected value by digest so the final guard can detect any change.

/**
 * Records written from a turn that read mail: their origin was not retained,
 * so they stay out of live context until it can be.
 */
const appliedFromMail = `SELECT (i->'applied'->>'id')::uuid FROM ai_conversation_turns t, jsonb_array_elements(t.items) i
  WHERE t.owner_id=$1 AND jsonb_array_length(t.mail)>0 AND jsonb_typeof(i->'applied')='object'`;

export const openTask = (task: Task) =>
  task.sensitivity === 'unlabeled' &&
  !task.canvasSource &&
  !task.academicSource &&
  !task.mailSource;
export const openEvent = (event: CalendarRecord) =>
  event.sensitivity === 'unlabeled' &&
  Array.isArray(event.academicLabels) &&
  event.academicLabels.length === 0 &&
  !event.canvasSource &&
  !event.academicSource &&
  !event.courseId &&
  !event.topicId;

export type PlannerContext = {
  tasks: Task[];
  events: CalendarRecord[];
  withheld: number;
};

/**
 * Planner items the model may see and change. `limit` reads the current
 * window; `ids` re-reads exactly the given rows (for the final guard) and
 * returns only those still eligible.
 */
export async function livePlannerContext(
  tx: QueryExecutor,
  owner: string,
  select: { limit: 150 } | { tasks: string[]; events: string[] },
): Promise<PlannerContext> {
  const byIds = 'tasks' in select;
  const tasks = (
    await tx.query(
      byIds
        ? `SELECT ${taskColumns},id IN (${appliedFromMail}) AS "fromMail" FROM tasks WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL AND completed=false`
        : `SELECT ${taskColumns},id IN (${appliedFromMail}) AS "fromMail" FROM tasks WHERE owner_id=$1 AND deleted_at IS NULL AND completed=false ORDER BY due_date NULLS LAST,created_at DESC LIMIT 150`,
      byIds ? [owner, select.tasks] : [owner],
    )
  ).map((row) => ({ task: taskSchema.parse(row), fromMail: !!row.fromMail }));
  const events = (
    await tx.query(
      byIds
        ? `SELECT ${eventColumns},id IN (${appliedFromMail}) AS "fromMail" FROM events WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`
        : `SELECT ${eventColumns},id IN (${appliedFromMail}) AS "fromMail" FROM events WHERE owner_id=$1 AND deleted_at IS NULL AND ends_at >= CURRENT_TIMESTAMP - interval '1 day' AND starts_at < CURRENT_TIMESTAMP + interval '30 days' ORDER BY starts_at,id LIMIT 150`,
      byIds ? [owner, select.events] : [owner],
    )
  )
    .map((row) => ({
      event: calendarRecordSchema.parse(row),
      fromMail: !!row.fromMail,
    }))
    // Repeating series are not offered (one change would move every
    // occurrence) and, as before, are not counted as withheld.
    .filter((e) => e.event.recurrence === null);
  const openTasks = tasks.filter((t) => !t.fromMail && openTask(t.task));
  const openEvents = events.filter((e) => !e.fromMail && openEvent(e.event));
  return {
    tasks: openTasks.map((t) => t.task),
    events: openEvents.map((e) => e.event),
    withheld:
      tasks.length - openTasks.length + events.length - openEvents.length,
  };
}

const local = (instant: string, timeZone: string) =>
  Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' });

export const projectTask = (task: Task, ref: string) => ({
  ref,
  title: task.title,
  dueDate: task.dueDate,
  priority: task.priority,
});

export const projectEvent = (
  event: CalendarRecord,
  ref: string,
  timeZone: string,
) => ({
  ref,
  title: event.title,
  ...(event.allDay
    ? {
        allDay: true,
        start: event.startDate,
        end: Temporal.PlainDate.from(event.endDate!)
          .subtract({ days: 1 })
          .toString(),
      }
    : {
        start: local(event.startsAt, timeZone),
        end: local(event.endsAt, timeZone),
      }),
});

/** Manifest entries for the planner context, refs t1… and e1… as sent. */
export function plannerSources(
  owner: string,
  requestId: string,
  context: Pick<PlannerContext, 'tasks' | 'events'>,
  timeZone: string,
): LiveSource[] {
  return [
    ...context.tasks.map((task, index): LiveSource => {
      const ref = `t${index + 1}`;
      return {
        projection: 'planner-task-v1',
        kind: 'task',
        id: task.id,
        version: task.version,
        ref,
        labels: ['unlabeled'],
        digest: sourceDigest(
          owner,
          requestId,
          'planner-task-v1',
          task.id,
          projectTask(task, ref),
        ),
      };
    }),
    ...context.events.map((event, index): LiveSource => {
      const ref = `e${index + 1}`;
      return {
        projection: 'planner-event-v1',
        kind: 'event',
        id: event.id,
        version: event.version,
        ref,
        labels: ['unlabeled'],
        digest: sourceDigest(
          owner,
          requestId,
          'planner-event-v1',
          event.id,
          projectEvent(event, ref, timeZone),
        ),
      };
    }),
  ];
}

/** What one mail source looked like when sent: header, or header and body. */
export type MailProjected = {
  projection:
    'mail-header-v1' | 'mail-body-v1' | 'mail-classify-v1' | 'mail-task-v1';
  id: string;
  ref: string;
  projected: unknown;
  truncated?: boolean;
};

/**
 * Manifest entries for mail, with message and connector identity and both
 * labels. A message without a verified body origin is never a source.
 */
export async function mailSources(
  tx: QueryExecutor,
  owner: string,
  requestId: string,
  items: MailProjected[],
): Promise<LiveSource[]> {
  if (!items.length) return [];
  const rows = await tx.query(
    `SELECT m.id,m.version,m.text_origin,m.sensitivity,c.sensitivity AS "connectorSensitivity",c.id AS "connectorId",c.version AS "connectorVersion"
     FROM email_messages m JOIN email_connectors c ON c.id=m.connector_id AND c.owner_id=m.owner_id
     WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[])`,
    [owner, [...new Set(items.map((item) => item.id))]],
  );
  return items.map((item): LiveSource => {
    const row = rows.find((candidate) => candidate.id === item.id);
    if (!row || row.text_origin !== 'message-body-v1')
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'Mail text origin is not verified for AI context.',
      );
    return {
      projection: item.projection,
      kind: 'mail-message',
      id: item.id,
      version: Number(row.version),
      ref: item.ref,
      labels: [
        ...new Set([
          sensitivitySchema.parse(row.sensitivity),
          sensitivitySchema.parse(row.connectorSensitivity),
        ]),
      ],
      connector: {
        id: String(row.connectorId),
        version: Number(row.connectorVersion),
      },
      ...(item.truncated === undefined ? {} : { truncated: item.truncated }),
      digest: sourceDigest(
        owner,
        requestId,
        item.projection,
        item.id,
        item.projected,
      ),
    };
  });
}
