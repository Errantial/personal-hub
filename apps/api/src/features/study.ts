import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deleteItemSchema,
  studyPreferencesWriteSchema,
  studyPreferencesInputSchema,
  studyGoalWriteSchema,
  studyRangeSchema,
  studyPreviewInputSchema,
  studyDraftWriteSchema,
  studyDraftEditSchema,
  studyHistoryQuerySchema,
  studyPlansResponseSchema,
  studyProgressSchema,
  studyWorkloadQuerySchema,
} from '@hub/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutateSchedule } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { active, academicLabels, stamp, version } from './common.js';
import {
  captureStudyWorkload,
  readWorkloadContext,
  inspectStudyWorkload,
  linkStudyEventContext,
} from './study-workload.js';
import { createStudyEvent } from './calendar.js';
import {
  verifyStudySuggestion,
  studyPlanOrigin,
} from './study-assistant-origin.js';
import { retainPlannerOrigin } from './ai-planner-origin.js';
import {
  readStudyPreferences,
  readStudyGoals,
  studyContext,
  buildStudyPreview,
  validateStudySlots,
  readStudyPlan,
  studyPlanColumns,
  studyMinutes,
  priorities,
} from './study-engine.js';
const idOf = (params: unknown) =>
  z.object({ id: z.string().uuid() }).parse(params).id;
export function registerStudy(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/study';
  async function snapshot<T>(
    request: FastifyRequest,
    work: (tx: QueryExecutor, owner: string) => Promise<T>,
  ) {
    const user = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      return work(tx, user.id);
    });
  }
  app.get(`${base}/preferences`, (request) =>
    snapshot(request, readStudyPreferences),
  );
  app.put(`${base}/preferences`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = studyPreferencesWriteSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'study.preferences', input },
      async (tx) => {
        const previous = await readStudyPreferences(tx, owner.id);
        version(previous, input.expectedVersion);
        const settings = studyPreferencesInputSchema.parse(
          Object.fromEntries(
            Object.entries(input).filter(
              ([key]) => !['operationId', 'expectedVersion'].includes(key),
            ),
          ),
        );
        await tx.query(
          'INSERT INTO study_preferences(owner_id,settings,version) VALUES($1,$2::jsonb,2) ON CONFLICT(owner_id) DO UPDATE SET settings=EXCLUDED.settings,version=study_preferences.version+1,updated_at=CURRENT_TIMESTAMP',
          [owner.id, JSON.stringify(settings)],
        );
        return readStudyPreferences(tx, owner.id);
      },
    );
  });
  app.get(`${base}/goals`, (request) =>
    snapshot(request, async (tx, owner) => ({
      goals: (await readStudyGoals(tx, owner)).goals,
    })),
  );
  app.put(`${base}/goals/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const courseId = idOf(request.params);
    const input = studyGoalWriteSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'study.goal', courseId, input },
      async (tx) => {
        await active(tx, 'courses', owner.id, courseId);
        const previous = (await readStudyGoals(tx, owner.id)).goals.find(
          (g) => g.courseId === courseId,
        )!;
        version(previous, input.expectedVersion);
        await tx.query(
          'INSERT INTO study_goals(owner_id,course_id,minutes_per_week,priority,target_date,version) VALUES($1,$2,$3,$4,$5,2) ON CONFLICT(owner_id,course_id) DO UPDATE SET minutes_per_week=$3,priority=$4,target_date=$5,version=study_goals.version+1,updated_at=CURRENT_TIMESTAMP',
          [
            owner.id,
            courseId,
            input.minutesPerWeek,
            input.priority,
            input.targetDate,
          ],
        );
        return (await readStudyGoals(tx, owner.id)).goals.find(
          (g) => g.courseId === courseId,
        )!;
      },
    );
  });
  app.get(`${base}/priorities`, (request) =>
    snapshot(request, async (tx, owner) => {
      const range = studyRangeSchema.parse(request.query);
      const context = await studyContext(tx, owner, range.from, range.to);
      return {
        priorities: priorities(context, range.from, range.to),
        contextRevision: context.contextRevision,
      };
    }),
  );
  app.post(`${base}/preview`, (request) =>
    snapshot(request, async (tx, owner) => {
      const range = studyPreviewInputSchema.parse(request.body);
      if (range.assistant)
        await verifyStudySuggestion(tx, owner, range.assistant, range);
      return buildStudyPreview(
        await studyContext(tx, owner, range.from, range.to),
        range.from,
        range.to,
      );
    }),
  );
  app.post(`${base}/plans`, async (request, reply) => {
    const owner = await auth.requireUser(request);
    const input = studyDraftWriteSchema.parse(request.body);
    const result = await mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'study.draft', input },
      async (tx) => {
        const origin = input.assistant
          ? await verifyStudySuggestion(tx, owner.id, input.assistant, input)
          : null;
        const context = await studyContext(tx, owner.id, input.from, input.to);
        if (context.contextRevision !== input.expectedContextRevision)
          throw new ApiError(
            409,
            'STUDY_CONTEXT_CONFLICT',
            'Reload the study preview.',
          );
        const preview = buildStudyPreview(context, input.from, input.to);
        const id = randomUUID();
        await tx.query(
          'INSERT INTO study_plans(id,owner_id,preview) VALUES($1,$2,$3::jsonb)',
          [id, owner.id, JSON.stringify(preview)],
        );
        await captureStudyWorkload(
          tx,
          owner.id,
          id,
          context.contextRevision,
          context.academicWork,
        );
        if (origin && input.assistant)
          await tx.query(
            'INSERT INTO study_plan_ai_origins(owner_id,plan_id,turn_id,suggestion_id,digest,capture) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
            [
              owner.id,
              id,
              input.assistant.turnId,
              input.assistant.suggestionId,
              origin.digest,
              JSON.stringify(origin.capture),
            ],
          );
        return readStudyPlan(tx, owner.id, id);
      },
      {
        isolation: 'repeatable read',
        authorize: async (tx) => {
          if (!(await auth.currentUser(request, tx)))
            throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        },
      },
    );
    return reply.code(201).send(result);
  });
  app.get(`${base}/plans`, (request) =>
    snapshot(request, async (tx, owner) => {
      const input = studyHistoryQuerySchema.parse(request.query);
      const [cursor] = input.before
        ? await tx.query(
            'SELECT id,to_char(created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS timestamp FROM study_plans WHERE owner_id=$1 AND id=$2',
            [owner, input.before],
          )
        : [];
      if (input.before && !cursor)
        throw new ApiError(404, 'NOT_FOUND', 'Plan cursor not available.');
      const rows = await tx.query(
        `SELECT ${studyPlanColumns} FROM study_plans WHERE owner_id=$1 AND deleted_at IS NULL ${cursor ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
        cursor
          ? [owner, input.limit + 1, cursor.timestamp, cursor.id]
          : [owner, input.limit + 1],
      );
      return studyPlansResponseSchema.parse({
        plans: rows.slice(0, input.limit),
        nextBefore:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      });
    }),
  );
  app.get(`${base}/plans/:id`, (request) =>
    snapshot(request, (tx, owner) =>
      readStudyPlan(tx, owner, idOf(request.params)),
    ),
  );
  app.get(`${base}/plans/:id/workload`, (request) =>
    snapshot(request, (tx, owner) =>
      inspectStudyWorkload(
        tx,
        owner,
        idOf(request.params),
        studyWorkloadQuerySchema.parse(request.query),
      ),
    ),
  );
  app.get('/api/v1/calendar/:id/workload', (request) =>
    snapshot(request, async (tx, owner) => {
      const id = idOf(request.params);
      const [event] = await tx.query<{
        id: string;
        version: number;
        deletedAt: string | null;
      }>(
        `SELECT id,version,${stamp('deleted_at', 'deletedAt')} FROM events WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      if (!event)
        throw new ApiError(404, 'NOT_FOUND', 'Calendar block not available.');
      const [link] = await tx.query<{ planId: string }>(
        'SELECT plan_id AS "planId" FROM study_event_contexts WHERE owner_id=$1 AND event_id=$2',
        [owner, id],
      );
      return inspectStudyWorkload(
        tx,
        owner,
        link?.planId ?? null,
        studyWorkloadQuerySchema.parse(request.query),
        event,
      );
    }),
  );
  app.put(`${base}/plans/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const id = idOf(request.params);
    const input = studyDraftEditSchema.parse(request.body);
    return mutateSchedule(
      database,
      owner.id,
      input.operationId,
      { kind: 'study.edit', id, input },
      async (tx) => {
        const plan = await readStudyPlan(tx, owner.id, id);
        version(plan, input.expectedVersion);
        if (plan.status !== 'draft')
          throw new ApiError(
            409,
            'STUDY_PLAN_STATE',
            'Only draft plans can be edited.',
          );
        await studyPlanOrigin(tx, owner.id, id, plan.preview);
        const context = await studyContext(
          tx,
          owner.id,
          plan.preview.from,
          plan.preview.to,
        );
        if (context.contextRevision !== input.expectedContextRevision)
          throw new ApiError(
            409,
            'STUDY_CONTEXT_CONFLICT',
            'Reload the study preview.',
          );
        const preview = buildStudyPreview(
          context,
          plan.preview.from,
          plan.preview.to,
        );
        validateStudySlots(context, preview, input.slots);
        preview.slots = input.slots;
        preview.warnings = preview.warnings.filter(
          (w) => w !== 'INSUFFICIENT_TIME',
        );
        if (
          preview.priorities.some(
            (p) =>
              input.slots
                .filter((s) => s.courseId === p.courseId)
                .reduce(
                  (sum, s) =>
                    sum + (+new Date(s.endsAt) - +new Date(s.startsAt)) / 60000,
                  0,
                ) < p.remainingMinutes,
          )
        )
          preview.warnings.push('INSUFFICIENT_TIME');
        await tx.query(
          'UPDATE study_plans SET preview=$3::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
          [owner.id, id, JSON.stringify(preview)],
        );
        await captureStudyWorkload(
          tx,
          owner.id,
          id,
          context.contextRevision,
          context.academicWork,
        );
        return readStudyPlan(tx, owner.id, id);
      },
      {
        isolation: 'repeatable read',
        authorize: async (tx) => {
          if (!(await auth.currentUser(request, tx)))
            throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        },
      },
    );
  });
  for (const action of ['approve', 'cancel', 'hide'] as const)
    app.route({
      method: action === 'hide' ? 'DELETE' : 'POST',
      url: `${base}/plans/:id${action === 'hide' ? '' : `/${action}`}`,
      handler: async (request) => {
        const owner = await auth.requireUser(request);
        const id = idOf(request.params);
        const input = deleteItemSchema.parse(request.body);
        return mutateSchedule(
          database,
          owner.id,
          input.operationId,
          { kind: `study.${action}`, id, input },
          async (tx) => {
            const plan = await readStudyPlan(tx, owner.id, id);
            version(plan, input.expectedVersion);
            if (action === 'hide') {
              if (plan.status === 'approved')
                throw new ApiError(
                  409,
                  'STUDY_PLAN_STATE',
                  'Cancel an approved plan before hiding it.',
                );
              await tx.query(
                'UPDATE study_plans SET deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
                [owner.id, id],
              );
              return readStudyPlan(tx, owner.id, id, true);
            }
            if (action === 'approve') {
              const assistantOrigin = await studyPlanOrigin(
                tx,
                owner.id,
                id,
                plan.preview,
              );
              if (plan.status !== 'draft')
                throw new ApiError(
                  409,
                  'STUDY_PLAN_STATE',
                  'Only draft plans can be approved.',
                );
              if (!plan.preview.slots.length)
                throw new ApiError(
                  409,
                  'STUDY_EMPTY',
                  'Add study blocks before approval.',
                );
              // Match academic ancestor lock order before reading current labels and context.
              for (const slot of [...plan.preview.slots].sort(
                (a, b) =>
                  a.courseId.localeCompare(b.courseId) ||
                  (a.topicId ?? '').localeCompare(b.topicId ?? ''),
              ))
                await academicLabels(tx, owner.id, slot.courseId, slot.topicId);
              const context = await studyContext(
                tx,
                owner.id,
                plan.preview.from,
                plan.preview.to,
              );
              if (context.contextRevision !== plan.preview.contextRevision)
                throw new ApiError(
                  409,
                  'STUDY_CONTEXT_CONFLICT',
                  'Reload and revise this draft before approval.',
                );
              const localToday = TemporalNow(context.preferences.timeZone);
              if (
                plan.preview.slots.some(
                  (slot) => +new Date(slot.startsAt) <= Date.now(),
                ) ||
                plan.preview.from < localToday
              )
                throw new ApiError(
                  409,
                  'STUDY_PAST',
                  'Revise the plan to future study time.',
                );
              validateStudySlots(context, plan.preview, plan.preview.slots);
              const workloadContext = await readWorkloadContext(
                tx,
                owner.id,
                id,
              );
              if (!workloadContext && context.academicWork.length)
                throw new ApiError(
                  409,
                  'STUDY_WORKLOAD_UNCAPTURED',
                  'Reload and revise this draft to capture workload sources.',
                );
              const [sourceCount] = await tx.query<{ count: number }>(
                'SELECT count(*)::int AS count FROM study_workload_sources WHERE owner_id=$1 AND plan_id=$2',
                [owner.id, id],
              );
              if (
                workloadContext &&
                (workloadContext.contextRevision !== context.contextRevision ||
                  workloadContext.sourceCount !== context.academicWork.length ||
                  sourceCount?.count !== workloadContext.sourceCount)
              )
                throw new ApiError(
                  409,
                  'PROVENANCE_UNAVAILABLE',
                  'Reload and revise this draft to capture complete workload history.',
                );
              // Ranking can affect every slot, including classes without open work.
              // Planning links do not verify source-text origin; keep AI provenance incomplete.
              const workloadLabels = context.academicWork.length
                ? [
                    ...new Set(
                      context.academicWork
                        .flatMap((w) => [w.sensitivity, ...w.academicLabels])
                        .filter((label) => label !== 'unlabeled'),
                    ),
                  ]
                : undefined;
              if (assistantOrigin) {
                if (!workloadLabels)
                  throw new ApiError(
                    409,
                    'STUDY_ORIGIN_CHANGED',
                    'Review a new academic answer.',
                  );
                workloadLabels.push(
                  ...assistantOrigin.capture.labels.filter(
                    (label) => label !== 'unlabeled',
                  ),
                );
              }
              const links = [];
              for (const slot of plan.preview.slots) {
                const course = context.courses.find(
                  (c) => c.id === slot.courseId,
                )!;
                const topic = context.topics.find((t) => t.id === slot.topicId);
                const event = await createStudyEvent(
                  tx,
                  owner.id,
                  {
                    ...slot,
                    title: `Study: ${topic?.name ?? course.name}`.slice(0, 200),
                    notes: '',
                    timeZone: context.preferences.timeZone,
                    sensitivity: 'unlabeled',
                    allDay: false,
                    startDate: null,
                    endDate: null,
                    recurrence: null,
                    studyStatus: 'planned',
                  },
                  workloadLabels,
                );
                if (workloadContext)
                  await linkStudyEventContext(tx, owner.id, id, event.id);
                if (assistantOrigin) {
                  const [originRow] = await tx.query(
                    'SELECT turn_id FROM study_plan_ai_origins WHERE owner_id=$1 AND plan_id=$2',
                    [owner.id, id],
                  );
                  await retainPlannerOrigin(
                    tx,
                    owner.id,
                    'event',
                    event.id,
                    String(originRow!.turn_id),
                    assistantOrigin.capture,
                  );
                }
                links.push({
                  eventId: event.id,
                  approvedVersion: event.version,
                });
              }
              await tx.query(
                "UPDATE study_plans SET status='approved',event_links=$3::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
                [owner.id, id, JSON.stringify(links)],
              );
            } else {
              if (plan.status === 'cancelled')
                throw new ApiError(
                  409,
                  'STUDY_PLAN_STATE',
                  'This plan is already cancelled.',
                );
              const preserved = [];
              for (const link of [...plan.eventLinks].sort((a, b) =>
                a.eventId.localeCompare(b.eventId),
              )) {
                const [event] = await tx.query(
                  'SELECT version,study_status,deleted_at FROM events WHERE owner_id=$1 AND id=$2 FOR UPDATE',
                  [owner.id, link.eventId],
                );
                if (
                  !event ||
                  event.deleted_at ||
                  event.version !== link.approvedVersion ||
                  event.study_status !== 'planned'
                ) {
                  preserved.push(link.eventId);
                  continue;
                }
                await tx.query(
                  "UPDATE events SET study_status='cancelled',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
                  [owner.id, link.eventId],
                );
                await tx.query(
                  "UPDATE reminders SET status='cancelled',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND target_kind='event' AND target_id=$2 AND status IN ('queued','running','paused')",
                  [owner.id, link.eventId],
                );
              }
              await tx.query(
                "UPDATE study_plans SET status='cancelled',preserved_event_ids=$3::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
                [owner.id, id, JSON.stringify(preserved)],
              );
            }
            return readStudyPlan(tx, owner.id, id);
          },
          {
            isolation: 'repeatable read',
            authorize: async (tx) => {
              if (!(await auth.currentUser(request, tx)))
                throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
            },
          },
        );
      },
    });
  app.get(`${base}/progress`, (request) =>
    snapshot(request, async (tx, owner) => {
      const range = studyRangeSchema.parse(request.query);
      const context = await studyContext(tx, owner, range.from, range.to);
      const days = TemporalDays(range.from, range.to);
      return studyProgressSchema.parse({
        ...range,
        timeZone: context.preferences.timeZone,
        courses: context.courses.map((course) => {
          const targetMinutes = Math.ceil(
            ((context.goals.find((g) => g.courseId === course.id)
              ?.minutesPerWeek ?? 0) *
              days) /
              7,
          );
          const completedMinutes = studyMinutes(
            context,
            course.id,
            'completed',
          );
          return {
            courseId: course.id,
            courseName: course.name,
            targetMinutes,
            plannedMinutes: studyMinutes(context, course.id, 'planned'),
            completedMinutes,
            cancelledMinutes: studyMinutes(context, course.id, 'cancelled'),
            deletedMinutes: studyMinutes(context, course.id, '', true),
            completionPercent: targetMinutes
              ? Math.min(100, (completedMinutes / targetMinutes) * 100)
              : null,
          };
        }),
      });
    }),
  );
}
import { Temporal } from '@hub/contracts';
const TemporalNow = (zone: string) =>
  Temporal.Now.plainDateISO(zone).toString();
const TemporalDays = (from: string, to: string) =>
  Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
