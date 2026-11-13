import { randomUUID } from 'node:crypto';
import {
  academicWorkSchema,
  academicWorkUpdateSchema,
  academicWorkWriteSchema,
  calendarRecordSchema,
  courseFields,
  courseSchema,
  dateOnly,
  sensitivitySchema,
  studyPreferencesInputSchema,
  studyPreferencesSchema,
  taskSchema,
  topicSchema,
  trackedDeadlineDueOverrideSchema,
  trackedDeadlinePrioritySchema,
  trackedDeadlineSchema,
  trackedDeadlineUpdateSchema,
} from '@hub/contracts';
import type {
  AcademicWork,
  AssistantProposal,
  Course,
  Topic,
  TrackedDeadline,
} from '@hub/contracts';
import type {
  AcademicContextItem,
  PlannerContext,
} from './live-projections.js';
import { z } from 'zod';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { taskColumns, saveTask } from '../planner/routes.js';
import { saveEvent } from '../features/calendar.js';
import {
  courseColumns,
  eventColumns,
  topicColumns,
  version,
} from '../features/common.js';
import { restorePlannerItem } from '../planner/restore.js';
import { readStudyPreferences } from '../features/study-engine.js';
import { recordCapabilityAudit } from '../features/capability-audit.js';
import { transactionDatabase } from '../planner/nested-database.js';
import {
  syncEventReminderOffsets,
  syncTaskReminderOffsets,
} from '../features/recurrence.js';
import {
  deleteAcademicRecord,
  saveAcademicRecord,
} from '../features/academics.js';
import {
  changeAcademicWorkDeletion,
  readAcademicWorkRecord,
  saveAcademicWorkRecord,
} from '../features/academic-work.js';
import {
  changeTrackedDeadlineCompletion,
  saveTrackedDeadlineUpdate,
} from '../features/tracked-deadlines.js';
import { readTrackedDeadline } from '../connections/canvas-deadlines.js';
import { lockSchedule } from '../planner/schedule-lock.js';
import type { TrackedDeadlineContextItem } from './tracked-deadline-context.js';

type Risk = 1 | 2 | 3;
type Definition = {
  tier: Risk;
  schema: z.ZodTypeAny;
  summary: (args: Record<string, unknown>) => string;
};

const idVersion = z.strictObject({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
const deleteScope = z.strictObject({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  scope: z.enum(['this', 'future', 'series']).optional(),
});
const preferences = z.strictObject({
  timeZone: studyPreferencesInputSchema.shape.timeZone.optional(),
  sessionMinutes: studyPreferencesInputSchema.shape.sessionMinutes.optional(),
  breakMinutes: studyPreferencesInputSchema.shape.breakMinutes.optional(),
  dailyMaximumMinutes:
    studyPreferencesInputSchema.shape.dailyMaximumMinutes.optional(),
  windows: studyPreferencesInputSchema.shape.windows.optional(),
});

const hasField = (value: Record<string, unknown>, field: string) =>
  Object.prototype.hasOwnProperty.call(value, field);

const courseCreate = z.strictObject(courseFields);
const courseUpdate = z
  .strictObject({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    term: z.string().max(100).optional(),
    instructor: z.string().max(200).optional(),
    notes: z.string().max(10000).optional(),
    sensitivity: sensitivitySchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.term !== undefined ||
      value.instructor !== undefined ||
      value.notes !== undefined ||
      value.sensitivity !== undefined,
    'Provide at least one class change.',
  );
const topicCreate = z.strictObject({
  courseId: z.string().uuid(),
  expectedCourseVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  confidence: z.enum(['unknown', 'low', 'medium', 'high']).default('unknown'),
  progress: z.number().int().min(0).max(100).default(0),
  sensitivity: sensitivitySchema.default('unlabeled'),
});
const topicUpdate = z
  .strictObject({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(10000).optional(),
    confidence: z.enum(['unknown', 'low', 'medium', 'high']).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    sensitivity: sensitivitySchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.notes !== undefined ||
      value.confidence !== undefined ||
      value.progress !== undefined ||
      value.sensitivity !== undefined,
    'Provide at least one topic change.',
  );
const academicWorkCreate = z.strictObject({
  courseId: z.string().uuid(),
  expectedCourseVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['assignment', 'exam', 'project', 'other']).optional(),
  notes: z.string().max(10000).optional(),
  dueDate: dateOnly.nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(60000).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  status: z
    .enum(['planned', 'in_progress', 'submitted', 'cancelled'])
    .optional(),
  sensitivity: sensitivitySchema.optional(),
});
const academicWorkUpdate = z
  .strictObject({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expectedCourseVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(['assignment', 'exam', 'project', 'other']).optional(),
    notes: z.string().max(10000).optional(),
    dueDate: dateOnly.nullable().optional(),
    estimatedMinutes: z.number().int().min(0).max(60000).nullable().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    status: z
      .enum(['planned', 'in_progress', 'submitted', 'cancelled'])
      .optional(),
    sensitivity: sensitivitySchema.optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.kind !== undefined ||
      value.notes !== undefined ||
      value.dueDate !== undefined ||
      value.estimatedMinutes !== undefined ||
      value.priority !== undefined ||
      value.status !== undefined ||
      value.sensitivity !== undefined,
    'Provide at least one work change.',
  );
const academicWorkDelete = z.strictObject({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  expectedCourseVersion: z.number().int().positive(),
});
const trackedDeadlineUpdate = z
  .strictObject({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    titleOverride: z.string().trim().min(1).max(200).nullable().optional(),
    priority: trackedDeadlinePrioritySchema.optional(),
    notes: z.string().max(10000).optional(),
    dueOverride: trackedDeadlineDueOverrideSchema.optional(),
    sensitivity: sensitivitySchema.optional(),
  })
  .refine(
    (value) =>
      value.titleOverride !== undefined ||
      value.priority !== undefined ||
      value.notes !== undefined ||
      value.dueOverride !== undefined ||
      value.sensitivity !== undefined,
    'Provide at least one deadline change.',
  );

export const capabilityDefinitions: Record<string, Definition> = {
  'task.delete': {
    tier: 2,
    schema: deleteScope,
    summary: (args) =>
      args.scope === 'series'
        ? 'Delete repeating task series (approval required)'
        : args.scope === 'future'
          ? 'Delete this and future task occurrences (approval required)'
          : 'Delete task (approval required)',
  },
  'task.restore': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Restore task from Recently deleted',
  },
  'event.delete': {
    tier: 2,
    schema: deleteScope,
    summary: () => 'Delete calendar event series (approval required)',
  },
  'event.restore': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Restore calendar event from Recently deleted',
  },
  'study.preferences.update': {
    tier: 1,
    schema: preferences,
    summary: () => 'Update study availability preferences',
  },
  'course.create': {
    tier: 1,
    schema: courseCreate,
    summary: () => 'Create class',
  },
  'course.update': {
    tier: 1,
    schema: courseUpdate,
    summary: () => 'Update class',
  },
  'course.delete': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Delete class (approval required)',
  },
  'topic.create': {
    tier: 1,
    schema: topicCreate,
    summary: () => 'Create topic',
  },
  'topic.update': {
    tier: 1,
    schema: topicUpdate,
    summary: () => 'Update topic',
  },
  'topic.delete': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Delete topic (approval required)',
  },
  'academicWork.create': {
    tier: 1,
    schema: academicWorkCreate,
    summary: () => 'Create academic work',
  },
  'academicWork.update': {
    tier: 1,
    schema: academicWorkUpdate,
    summary: () => 'Update academic work',
  },
  'academicWork.delete': {
    tier: 2,
    schema: academicWorkDelete,
    summary: () => 'Delete academic work (approval required)',
  },
  'academicWork.restore': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Restore academic work from Recently deleted',
  },
  'trackedDeadline.update': {
    tier: 1,
    schema: trackedDeadlineUpdate,
    summary: () => 'Update imported deadline planning fields',
  },
  'trackedDeadline.complete': {
    tier: 1,
    schema: idVersion,
    summary: () => 'Mark imported deadline complete locally',
  },
  'trackedDeadline.reopen': {
    tier: 1,
    schema: idVersion,
    summary: () => 'Reopen imported deadline locally',
  },
};

type Resolver = (
  args: Record<string, unknown>,
  context: PlannerContext,
  academic: AcademicContextItem[],
  deadlines: TrackedDeadlineContextItem[],
) => Record<string, unknown> | null;

const refIndex = (value: unknown, prefix: string) => {
  if (typeof value !== 'string') return null;
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(value);
  return match ? Number(match[1]) : null;
};
const withoutRef = (args: Record<string, unknown>) => {
  const rest = { ...args };
  delete rest.ref;
  return rest;
};
const withoutCourseRef = (args: Record<string, unknown>) => {
  const rest = { ...args };
  delete rest.courseRef;
  return rest;
};
const courseAt = (context: PlannerContext, value: unknown) => {
  const index = refIndex(value, 'c');
  return index ? ((context.courses ?? [])[index - 1] ?? null) : null;
};
const topicAt = (context: PlannerContext, value: unknown) => {
  const index = refIndex(value, 'p');
  return index ? ((context.topics ?? [])[index - 1] ?? null) : null;
};
const academicAt = (academic: AcademicContextItem[], value: unknown) => {
  const index = refIndex(value, 'w');
  return index ? (academic[index - 1] ?? null) : null;
};
const deadlineAt = (
  deadlines: TrackedDeadlineContextItem[],
  value: unknown,
) => {
  const index = refIndex(value, 'd');
  return index ? (deadlines[index - 1] ?? null) : null;
};

const resolvers: Record<string, Resolver> = {
  'task.delete': (args, context) => {
    const index = refIndex(args.ref, 't');
    const target = index ? context.tasks[index - 1] : null;
    if (!target) return null;
    return {
      id: target.id,
      expectedVersion: target.version,
      ...(args.scope === 'this' ||
      args.scope === 'future' ||
      args.scope === 'series'
        ? { scope: args.scope }
        : {}),
    };
  },
  'event.delete': (args, context) => {
    const index = refIndex(args.ref, 'e');
    const target = index ? context.events[index - 1] : null;
    if (!target) return null;
    return {
      id: target.id,
      expectedVersion: target.version,
      ...(args.scope === 'this' ||
      args.scope === 'future' ||
      args.scope === 'series'
        ? { scope: args.scope }
        : {}),
    };
  },
  'course.update': (args, context) => {
    const target = courseAt(context, args.ref);
    if (!target) return null;
    return {
      ...withoutRef(args),
      id: target.id,
      expectedVersion: target.version,
    };
  },
  'course.delete': (args, context) => {
    const target = courseAt(context, args.ref);
    if (!target) return null;
    return { id: target.id, expectedVersion: target.version };
  },
  'topic.create': (args, context) => {
    const course = courseAt(context, args.courseRef);
    if (!course) return null;
    return {
      ...withoutCourseRef(args),
      courseId: course.id,
      expectedCourseVersion: course.version,
    };
  },
  'topic.update': (args, context) => {
    const target = topicAt(context, args.ref);
    if (!target) return null;
    return {
      ...withoutRef(args),
      id: target.id,
      expectedVersion: target.version,
    };
  },
  'topic.delete': (args, context) => {
    const target = topicAt(context, args.ref);
    if (!target) return null;
    return { id: target.id, expectedVersion: target.version };
  },
  'academicWork.create': (args, context) => {
    const course = courseAt(context, args.courseRef);
    if (!course) return null;
    return {
      ...withoutCourseRef(args),
      courseId: course.id,
      expectedCourseVersion: course.version,
    };
  },
  'academicWork.update': (args, _context, academic) => {
    const target = academicAt(academic, args.ref);
    if (!target) return null;
    return {
      ...withoutRef(args),
      id: target.id,
      expectedVersion: target.version,
      expectedCourseVersion: target.courseVersion,
    };
  },
  'academicWork.delete': (args, _context, academic) => {
    const target = academicAt(academic, args.ref);
    if (!target) return null;
    return {
      id: target.id,
      expectedVersion: target.version,
      expectedCourseVersion: target.courseVersion,
    };
  },
  'trackedDeadline.update': (args, _context, _academic, deadlines) => {
    const target = deadlineAt(deadlines, args.ref);
    if (!target || target.projected.completed) return null;
    return {
      ...withoutRef(args),
      id: target.id,
      expectedVersion: target.version,
    };
  },
  'trackedDeadline.complete': (args, _context, _academic, deadlines) => {
    const target = deadlineAt(deadlines, args.ref);
    if (!target || target.projected.completed) return null;
    return { id: target.id, expectedVersion: target.version };
  },
  'trackedDeadline.reopen': (args, _context, _academic, deadlines) => {
    const target = deadlineAt(deadlines, args.ref);
    if (!target || !target.projected.completed) return null;
    return { id: target.id, expectedVersion: target.version };
  },
};

/** Resolves a model tool call (refs, not private IDs) into a checked proposal. */
export function modelCapabilityProposal(
  capability: string,
  rawArguments: string,
  context: PlannerContext,
  academic: AcademicContextItem[] = [],
  deadlines: TrackedDeadlineContextItem[] = [],
): AssistantProposal | null {
  const definition = capabilityDefinitions[capability];
  if (!definition) return null;
  let arguments_: Record<string, unknown>;
  try {
    arguments_ = JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    return null;
  }
  const resolver = resolvers[capability];
  if (resolver) {
    const resolved = resolver(arguments_, context, academic, deadlines);
    if (!resolved) return null;
    arguments_ = resolved;
  }
  const parsed = definition.schema.safeParse(arguments_);
  if (!parsed.success) return null;
  return proposal(
    capability,
    parsed.data as Record<string, unknown>,
    definition.tier,
  );
}

export function capabilityNames() {
  return Object.keys(capabilityDefinitions);
}

function proposal(
  capability: string,
  args: Record<string, unknown>,
  tier: Risk,
): AssistantProposal {
  return {
    kind: 'capability',
    capability,
    arguments: args,
    summary: capabilityDefinitions[capability]!.summary(args),
    tier,
  };
}

function recordId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function capabilityTargetId(
  args: Record<string, unknown>,
  before: unknown,
  after: unknown,
): string | null {
  const afterObject = after as
    { id?: unknown; course?: { id?: unknown } } | null | undefined;
  const beforeObject = before as
    { id?: unknown; course?: { id?: unknown } } | null | undefined;
  const target =
    recordId(after) ??
    (typeof afterObject?.course?.id === 'string'
      ? afterObject.course.id
      : null) ??
    recordId(before) ??
    (typeof beforeObject?.course?.id === 'string'
      ? beforeObject.course.id
      : null) ??
    (typeof args.id === 'string' ? args.id : null);
  return target;
}

async function readCourseRecord(
  tx: QueryExecutor,
  owner: string,
  id: string,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT ${courseColumns} FROM courses WHERE owner_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
  return courseSchema.parse(row);
}

async function readTopicRecord(tx: QueryExecutor, owner: string, id: string) {
  const [row] = await tx.query(
    `SELECT ${topicColumns} FROM topics WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Topic not available.');
  return topicSchema.parse(row);
}

async function readCourseTopics(
  tx: QueryExecutor,
  owner: string,
  courseId: string,
) {
  const rows = await tx.query(
    `SELECT ${topicColumns} FROM topics WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL ORDER BY name,id`,
    [owner, courseId],
  );
  return rows.map((row) => topicSchema.parse(row));
}

async function readTopicsByIds(
  tx: QueryExecutor,
  owner: string,
  ids: string[],
) {
  if (!ids.length) return [] as Topic[];
  const rows = await tx.query(
    `SELECT ${topicColumns} FROM topics WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id`,
    [owner, ids],
  );
  return rows.map((row) => topicSchema.parse(row));
}

async function checkCourseVersion(
  tx: QueryExecutor,
  owner: string,
  courseId: string,
  expectedVersion: number,
  requireActive: boolean,
) {
  const [row] = await tx.query(
    'SELECT version,deleted_at AS "deletedAt" FROM courses WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [owner, courseId],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
  if (Number(row.version) !== expectedVersion)
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'Reload before editing this item.',
    );
  if (requireActive && row.deletedAt)
    throw new ApiError(
      409,
      'ACADEMIC_CLASS_ARCHIVED',
      'This class is archived.',
    );
}

export async function executeCapability(
  database: Database,
  owner: string,
  turnId: string,
  capability: string,
  raw: unknown,
  operationId: string,
  agentId?: string,
  autoApproved = false,
) {
  const definition = capabilityDefinitions[capability];
  if (!definition)
    throw new ApiError(400, 'CAPABILITY_UNKNOWN', 'Unknown agent capability.');
  const args = definition.schema.parse(raw) as Record<string, unknown>;
  if (capability === 'event.delete' && args.scope && args.scope !== 'series')
    throw new ApiError(
      400,
      'CAPABILITY_SCOPE',
      'Event occurrence deletion is not available to this capability.',
    );
  const summary = definition.summary(args);
  const [existing] = await database.query(
    'SELECT id FROM ai_capability_audit WHERE owner_id=$1 AND operation_id=$2 AND tool=$3 LIMIT 1',
    [owner, operationId, capability],
  );
  if (existing) return { id: String(existing.id), version: 1 };
  const auditId = await database.transaction(async (tx) => {
    let before: unknown = null;
    let after: unknown = null;
    if (capability === 'task.delete' || capability === 'task.restore') {
      const id = String(args.id);
      const snapshot = async () => {
        const [row] = await tx.query(
          `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
          [owner, id],
        );
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Task not available.');
        const task = taskSchema.parse(row);
        if (!task.seriesId) return task;
        const [series] = await tx.query<Record<string, unknown>>(
          `SELECT id,deleted_at AS "deletedAt",
             to_char(cancelled_from,'YYYY-MM-DD') AS "cancelledFrom",
             version,rule,time_zone AS "timeZone",
             to_char(anchor_date,'YYYY-MM-DD') AS "anchorDate"
           FROM recurrence_series WHERE owner_id=$1 AND id=$2`,
          [owner, task.seriesId],
        );
        const occurrences = await tx.query<Record<string, unknown>>(
          `SELECT ${taskColumns},auto_generated AS "autoGenerated"
           FROM tasks WHERE owner_id=$1 AND series_id=$2 ORDER BY occurrence_key`,
          [owner, task.seriesId],
        );
        return {
          task,
          series: series ?? null,
          occurrences: occurrences.map((occurrence) => ({
            ...taskSchema.parse(occurrence),
            autoGenerated: Boolean(occurrence.autoGenerated),
          })),
        };
      };
      if (capability === 'task.delete') before = await snapshot();
      else {
        const [row] = await tx.query(
          `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
          [owner, id],
        );
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Task not available.');
        before = taskSchema.parse(row);
      }
      if (capability === 'task.delete')
        await saveTask(transactionDatabase(tx), owner, 'DELETE', id, {
          operationId,
          expectedVersion: args.expectedVersion,
          ...(args.scope ? { scope: args.scope } : {}),
        });
      else
        await restorePlannerItem(
          tx,
          'tasks',
          taskColumns,
          owner,
          id,
          Number(args.expectedVersion),
        );
      if (capability === 'task.delete') after = await snapshot();
      else {
        const [next] = await tx.query(
          `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
          [owner, id],
        );
        after = taskSchema.parse(next);
      }
    } else if (
      capability === 'event.delete' ||
      capability === 'event.restore'
    ) {
      const id = String(args.id);
      const [row] = await tx.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'Calendar event not available.');
      before = calendarRecordSchema.parse(row);
      if (capability === 'event.delete')
        await saveEvent(transactionDatabase(tx), owner, 'DELETE', id, {
          operationId,
          expectedVersion: args.expectedVersion,
        });
      else
        await restorePlannerItem(
          tx,
          'events',
          eventColumns,
          owner,
          id,
          Number(args.expectedVersion),
        );
      const [next] = await tx.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      after = calendarRecordSchema.parse(next);
    } else if (capability === 'study.preferences.update') {
      const current = await readStudyPreferences(tx, owner);
      before = current;
      const settings = studyPreferencesInputSchema.parse({
        timeZone: current.timeZone,
        sessionMinutes: current.sessionMinutes,
        breakMinutes: current.breakMinutes,
        dailyMaximumMinutes: current.dailyMaximumMinutes,
        windows: current.windows,
        ...args,
      });
      await tx.query(
        'INSERT INTO study_preferences(owner_id,settings,version) VALUES($1,$2::jsonb,2) ON CONFLICT(owner_id) DO UPDATE SET settings=EXCLUDED.settings,version=study_preferences.version+1,updated_at=CURRENT_TIMESTAMP',
        [owner, JSON.stringify(settings)],
      );
      after = studyPreferencesSchema.parse({
        ...settings,
        version: Number(current.version) + 1,
        updatedAt: new Date().toISOString(),
      });
    } else if (
      capability.startsWith('course.') ||
      capability.startsWith('topic.')
    ) {
      const table = capability.startsWith('course.') ? 'courses' : 'topics';
      const action = capability.slice(capability.indexOf('.') + 1);
      const id = action === 'create' ? randomUUID() : String(args.id);
      if (action === 'create') {
        if (table === 'courses') {
          const saved = await saveAcademicRecord(
            tx,
            owner,
            table,
            'POST',
            id,
            courseCreate.parse(args),
            hasField(args, 'sensitivity'),
          );
          after = (saved as { course: Course }).course;
        } else {
          const input = topicCreate.parse(args);
          const saved = await saveAcademicRecord(
            tx,
            owner,
            table,
            'POST',
            id,
            input,
            hasField(args, 'sensitivity'),
            true,
          );
          after = (saved as { topic: Topic }).topic;
        }
      } else if (action === 'update') {
        if (table === 'courses') {
          const current = await readCourseRecord(tx, owner, id);
          before = current;
          const saved = await saveAcademicRecord(
            tx,
            owner,
            table,
            'PUT',
            id,
            {
              id,
              expectedVersion: Number(args.expectedVersion),
              name: args.name ?? current.name,
              term: args.term ?? current.term,
              instructor: args.instructor ?? current.instructor,
              notes: args.notes ?? current.notes,
              sensitivity: args.sensitivity ?? current.sensitivity,
            },
            hasField(args, 'sensitivity'),
          );
          after = (saved as { course: Course }).course;
        } else {
          const current = await readTopicRecord(tx, owner, id);
          before = current;
          const saved = await saveAcademicRecord(
            tx,
            owner,
            table,
            'PUT',
            id,
            {
              courseId: current.courseId,
              expectedVersion: Number(args.expectedVersion),
              name: args.name ?? current.name,
              notes: args.notes ?? current.notes,
              confidence: args.confidence ?? current.confidence,
              progress: args.progress ?? current.progress,
              sensitivity: args.sensitivity ?? current.sensitivity,
            },
            hasField(args, 'sensitivity'),
          );
          after = (saved as { topic: Topic }).topic;
        }
      } else {
        const current =
          table === 'courses'
            ? await readCourseRecord(tx, owner, id, true)
            : await readTopicRecord(tx, owner, id);
        const activeTopics =
          table === 'courses' ? await readCourseTopics(tx, owner, id) : [];
        before =
          table === 'courses'
            ? { course: current, topics: activeTopics }
            : current;
        const deleted = await deleteAcademicRecord(
          tx,
          owner,
          table,
          id,
          Number(args.expectedVersion),
        );
        after =
          table === 'courses'
            ? {
                course: (deleted as { course: Course }).course,
                topics: await readTopicsByIds(
                  tx,
                  owner,
                  activeTopics.map((topic) => topic.id),
                ),
              }
            : (deleted as { topic: Topic }).topic;
      }
    } else if (capability.startsWith('academicWork.')) {
      const action = capability.slice(capability.indexOf('.') + 1);
      await lockSchedule(tx, owner);
      if (action === 'create') {
        const { expectedCourseVersion, ...input } =
          academicWorkCreate.parse(args);
        await checkCourseVersion(
          tx,
          owner,
          input.courseId,
          expectedCourseVersion,
          true,
        );
        const id = randomUUID();
        const saved = await saveAcademicWorkRecord(
          tx,
          owner,
          'POST',
          id,
          academicWorkWriteSchema.parse({ operationId, ...input }),
          hasField(args, 'sensitivity'),
        );
        after = saved.work;
      } else if (action === 'update') {
        const id = String(args.id);
        const current = await readAcademicWorkRecord(tx, owner, id);
        before = current;
        await checkCourseVersion(
          tx,
          owner,
          current.courseId,
          Number(args.expectedCourseVersion),
          true,
        );
        const status =
          args.status === undefined ? current.status : String(args.status);
        if (current.grade !== null && status !== 'submitted')
          throw new ApiError(
            409,
            'ACADEMIC_SCORE_REVIEW_REQUIRED',
            'Review and clear the recorded score individually before changing its submission status.',
          );
        const saved = await saveAcademicWorkRecord(
          tx,
          owner,
          'PUT',
          id,
          academicWorkUpdateSchema.parse({
            operationId,
            expectedVersion: args.expectedVersion,
            courseId: current.courseId,
            title: args.title ?? current.title,
            kind: args.kind ?? current.kind,
            notes: args.notes ?? current.notes,
            dueDate:
              args.dueDate !== undefined ? args.dueDate : current.dueDate,
            estimatedMinutes:
              args.estimatedMinutes !== undefined
                ? args.estimatedMinutes
                : current.estimatedMinutes,
            priority: args.priority ?? current.priority,
            status,
            grade: current.grade,
            sensitivity: args.sensitivity ?? current.sensitivity,
          }),
          hasField(args, 'sensitivity'),
        );
        after = saved.work;
      } else if (action === 'delete') {
        const id = String(args.id);
        const current = await readAcademicWorkRecord(tx, owner, id);
        before = current;
        await checkCourseVersion(
          tx,
          owner,
          current.courseId,
          Number(args.expectedCourseVersion),
          false,
        );
        const saved = await changeAcademicWorkDeletion(
          tx,
          owner,
          'delete',
          id,
          Number(args.expectedVersion),
        );
        after = saved.work;
      } else {
        const id = String(args.id);
        const current = await readAcademicWorkRecord(tx, owner, id);
        before = current;
        const saved = await changeAcademicWorkDeletion(
          tx,
          owner,
          'restore',
          id,
          Number(args.expectedVersion),
        );
        after = saved.work;
      }
    } else if (capability.startsWith('trackedDeadline.')) {
      const action = capability.slice(capability.indexOf('.') + 1);
      const id = String(args.id);
      const current = await readTrackedDeadline(tx, owner, id);
      version(current, Number(args.expectedVersion));
      before = current;
      if (action === 'update') {
        if (current.completedAt)
          throw new ApiError(
            409,
            'TRACKED_DEADLINE_COMPLETED',
            'Reopen this imported deadline before editing it.',
          );
        const input = trackedDeadlineUpdateSchema.parse({
          operationId,
          expectedVersion: args.expectedVersion,
          titleOverride:
            args.titleOverride !== undefined
              ? args.titleOverride
              : current.titleOverride,
          priority: args.priority ?? current.priority,
          notes: args.notes ?? current.notes,
          dueOverride: args.dueOverride ?? current.dueOverride,
          sensitivity: args.sensitivity ?? current.sensitivity,
        });
        after = await saveTrackedDeadlineUpdate(tx, owner, id, input);
      } else if (action === 'complete') {
        if (current.completedAt)
          throw new ApiError(
            409,
            'TRACKED_DEADLINE_COMPLETED',
            'This imported deadline is already complete locally.',
          );
        after = await changeTrackedDeadlineCompletion(
          tx,
          owner,
          'complete',
          id,
          Number(args.expectedVersion),
        );
      } else {
        if (!current.completedAt)
          throw new ApiError(
            409,
            'TRACKED_DEADLINE_OPEN',
            'This imported deadline is already open locally.',
          );
        after = await changeTrackedDeadlineCompletion(
          tx,
          owner,
          'reopen',
          id,
          Number(args.expectedVersion),
        );
      }
    }
    return recordCapabilityAudit(
      tx,
      owner,
      turnId,
      proposal(capability, args, definition.tier),
      'applied',
      {
        agentId,
        operationId,
        before,
        after,
        targetId: capabilityTargetId(args, before, after),
        undoable: true,
        reason: summary,
        tool: capability,
        autoApproved,
      },
    );
  });
  return { id: auditId, version: 1 };
}

const conflict = (message: string) =>
  new ApiError(409, 'VERSION_CONFLICT', message);

function dueColumns(override: TrackedDeadline['dueOverride']) {
  return {
    dueAt: override.kind === 'timed' ? override.dueAt : null,
    dueDate: override.kind === 'date' ? override.dueDate : null,
    dueTimeZone: override.kind === 'timed' ? override.timeZone : null,
  };
}

async function undoCourseCreate(
  tx: QueryExecutor,
  owner: string,
  after: Course,
) {
  const [current] = await tx.query(
    'SELECT version,deleted_at AS "deletedAt" FROM courses WHERE owner_id=$1 AND id=$2',
    [owner, after.id],
  );
  if (
    !current ||
    current.deletedAt ||
    Number(current.version) !== after.version
  )
    throw conflict('This class changed again; undo would overwrite it.');
  const [dependent] = await tx.query(
    `SELECT
       EXISTS(SELECT 1 FROM topics WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL) AS topics,
       EXISTS(SELECT 1 FROM events WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL) AS events,
       EXISTS(SELECT 1 FROM academic_work WHERE owner_id=$1 AND course_id=$2 AND deleted_at IS NULL) AS work`,
    [owner, after.id],
  );
  if (dependent?.topics || dependent?.events || dependent?.work)
    throw conflict(
      'This class has newer topics, events or work; undo would remove them.',
    );
  await tx.query(
    'UPDATE courses SET deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
    [owner, after.id],
  );
}

async function undoCourseUpdate(
  tx: QueryExecutor,
  owner: string,
  before: Course,
  after: Course,
) {
  const [row] = await tx.query(
    `UPDATE courses SET name=$3,term=$4,instructor=$5,notes=$6,sensitivity=$7,
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$8 AND deleted_at IS NULL
     RETURNING id`,
    [
      owner,
      after.id,
      before.name,
      before.term,
      before.instructor,
      before.notes,
      before.sensitivity,
      after.version,
    ],
  );
  if (!row)
    throw conflict('This class changed again; undo would overwrite it.');
}

async function undoCourseDelete(
  tx: QueryExecutor,
  owner: string,
  before: { course: Course; topics: Topic[] },
  after: { course: Course; topics: Topic[] },
) {
  const [row] = await tx.query(
    `UPDATE courses SET deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NOT NULL
     RETURNING id`,
    [owner, after.course.id, after.course.version],
  );
  if (!row)
    throw conflict('This class changed again; undo would overwrite it.');
  const afterById = new Map(after.topics.map((topic) => [topic.id, topic]));
  for (const topic of before.topics) {
    if (topic.deletedAt) continue;
    const target = afterById.get(topic.id);
    if (!target)
      throw conflict('A class topic changed again; undo would overwrite it.');
    const [restored] = await tx.query(
      `UPDATE topics SET deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NOT NULL
       RETURNING id`,
      [owner, topic.id, target.version],
    );
    if (!restored)
      throw conflict('A class topic changed again; undo would overwrite it.');
  }
}

async function undoTopicCreate(tx: QueryExecutor, owner: string, after: Topic) {
  const [current] = await tx.query(
    'SELECT version,deleted_at AS "deletedAt" FROM topics WHERE owner_id=$1 AND id=$2',
    [owner, after.id],
  );
  if (
    !current ||
    current.deletedAt ||
    Number(current.version) !== after.version
  )
    throw conflict('This topic changed again; undo would overwrite it.');
  const [event] = await tx.query(
    'SELECT id FROM events WHERE owner_id=$1 AND topic_id=$2 AND deleted_at IS NULL LIMIT 1',
    [owner, after.id],
  );
  if (event)
    throw conflict('This topic has calendar events; undo would unlink them.');
  await tx.query(
    'UPDATE topics SET deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
    [owner, after.id],
  );
}

async function undoTopicUpdate(
  tx: QueryExecutor,
  owner: string,
  before: Topic,
  after: Topic,
) {
  const [row] = await tx.query(
    `UPDATE topics SET name=$3,notes=$4,confidence=$5,progress=$6,sensitivity=$7,
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$8 AND deleted_at IS NULL
     RETURNING id`,
    [
      owner,
      after.id,
      before.name,
      before.notes,
      before.confidence,
      before.progress,
      before.sensitivity,
      after.version,
    ],
  );
  if (!row)
    throw conflict('This topic changed again; undo would overwrite it.');
}

async function undoTopicDelete(tx: QueryExecutor, owner: string, after: Topic) {
  const [course] = await tx.query(
    'SELECT deleted_at AS "deletedAt" FROM courses WHERE owner_id=$1 AND id=$2',
    [owner, after.courseId],
  );
  if (!course) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
  if (course.deletedAt)
    throw new ApiError(
      409,
      'ACADEMIC_CLASS_ARCHIVED',
      'The class is archived; this topic cannot be restored.',
    );
  const [row] = await tx.query(
    `UPDATE topics SET deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NOT NULL
     RETURNING id`,
    [owner, after.id, after.version],
  );
  if (!row)
    throw conflict('This topic changed again; undo would overwrite it.');
}

async function undoAcademicWorkCreate(
  tx: QueryExecutor,
  owner: string,
  after: AcademicWork,
) {
  const [row] = await tx.query(
    `UPDATE academic_work SET deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL
     RETURNING id`,
    [owner, after.id, after.version],
  );
  if (!row)
    throw conflict(
      'This academic work changed again; undo would overwrite it.',
    );
}

async function undoAcademicWorkUpdate(
  tx: QueryExecutor,
  owner: string,
  before: AcademicWork,
  after: AcademicWork,
) {
  const [row] = await tx.query(
    `UPDATE academic_work SET course_id=$3,title=$4,kind=$5,notes=$6,due_date=$7,
       estimated_minutes=$8,priority=$9,status=$10,grade=$11::jsonb,
       sensitivity=$12,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$13 AND deleted_at IS NULL
     RETURNING id`,
    [
      owner,
      after.id,
      before.courseId,
      before.title,
      before.kind,
      before.notes,
      before.dueDate,
      before.estimatedMinutes,
      before.priority,
      before.status,
      before.grade === null ? null : JSON.stringify(before.grade),
      before.sensitivity,
      after.version,
    ],
  );
  if (!row)
    throw conflict(
      'This academic work changed again; undo would overwrite it.',
    );
}

async function undoAcademicWorkDelete(
  tx: QueryExecutor,
  owner: string,
  after: AcademicWork,
) {
  const [course] = await tx.query(
    'SELECT deleted_at AS "deletedAt" FROM courses WHERE owner_id=$1 AND id=$2',
    [owner, after.courseId],
  );
  if (!course) throw new ApiError(404, 'NOT_FOUND', 'Class not available.');
  if (course.deletedAt)
    throw new ApiError(
      409,
      'ACADEMIC_CLASS_ARCHIVED',
      'The class is archived; this record cannot be restored.',
    );
  const [row] = await tx.query(
    `UPDATE academic_work SET deleted_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NOT NULL
     RETURNING id`,
    [owner, after.id, after.version],
  );
  if (!row)
    throw conflict(
      'This academic work changed again; undo would overwrite it.',
    );
}

async function undoAcademicWorkRestore(
  tx: QueryExecutor,
  owner: string,
  after: AcademicWork,
) {
  const [row] = await tx.query(
    `UPDATE academic_work SET deleted_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL
     RETURNING id`,
    [owner, after.id, after.version],
  );
  if (!row)
    throw conflict(
      'This academic work changed again; undo would overwrite it.',
    );
}

async function undoTrackedDeadlineUpdate(
  tx: QueryExecutor,
  owner: string,
  before: TrackedDeadline,
  after: TrackedDeadline,
) {
  const due = dueColumns(before.dueOverride);
  const [row] = await tx.query(
    `UPDATE tracked_deadlines SET title_override=$3,priority=$4,notes=$5,
       due_override_kind=$6,due_at_override=$7,due_date_override=$8,
       due_time_zone=$9,sensitivity=$10,version=version+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$11 RETURNING id`,
    [
      owner,
      after.id,
      before.titleOverride,
      before.priority,
      before.notes,
      before.dueOverride.kind,
      due.dueAt,
      due.dueDate,
      due.dueTimeZone,
      before.sensitivity,
      after.version,
    ],
  );
  if (!row)
    throw conflict(
      'This imported deadline changed again; undo would overwrite it.',
    );
}

async function undoTrackedDeadlineCompletion(
  tx: QueryExecutor,
  owner: string,
  before: TrackedDeadline,
  after: TrackedDeadline,
  completed: boolean,
) {
  const [row] = await tx.query(
    `UPDATE tracked_deadlines SET completed_at=$3,version=version+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND id=$2 AND version=$4 RETURNING id`,
    [owner, after.id, completed ? before.completedAt : null, after.version],
  );
  if (!row)
    throw conflict(
      'This imported deadline changed again; undo would overwrite it.',
    );
}

export async function undoCapability(
  database: Database,
  owner: string,
  auditId: string,
  operationId: string = randomUUID(),
) {
  return database.transaction(async (tx) => {
    const [row] = await tx.query(
      `SELECT capability,tool,operation_id,before,after,undoable,undone_at
       FROM ai_capability_audit WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
      [owner, auditId],
    );
    if (!row || !row.undoable)
      throw new ApiError(404, 'NOT_FOUND', 'This action cannot be undone.');
    if (row.undone_at)
      throw new ApiError(
        409,
        'ALREADY_UNDONE',
        'This action was already undone.',
      );
    const before =
      typeof row.before === 'string' ? JSON.parse(row.before) : row.before;
    const after =
      typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
    if (row.tool === 'task.delete') {
      const beforeObject = before as Record<string, unknown>;
      const afterObject = after as Record<string, unknown>;
      const series = beforeObject.series as
        Record<string, unknown> | null | undefined;
      if (series && Array.isArray(beforeObject.occurrences)) {
        const seriesId = String(series.id);
        await tx.query(
          `UPDATE recurrence_series SET deleted_at=$3,
             cancelled_from=$4::date,version=version+1,
             updated_at=CURRENT_TIMESTAMP
           WHERE owner_id=$1 AND id=$2`,
          [
            owner,
            seriesId,
            series.deletedAt ?? null,
            series.cancelledFrom ?? null,
          ],
        );
        const beforeOccurrences = beforeObject.occurrences as Record<
          string,
          unknown
        >[];
        const afterOccurrences = (afterObject.occurrences ?? []) as Record<
          string,
          unknown
        >[];
        const afterById = new Map(
          afterOccurrences.map((occurrence) => [
            String(occurrence.id),
            occurrence,
          ]),
        );
        const beforeIds = new Set(
          beforeOccurrences.map((occurrence) => String(occurrence.id)),
        );
        for (const occurrence of beforeOccurrences) {
          if (occurrence.deletedAt) continue;
          const current = afterById.get(String(occurrence.id));
          if (current?.deletedAt)
            await restorePlannerItem(
              tx,
              'tasks',
              taskColumns,
              owner,
              String(occurrence.id),
              Number(current.version),
            );
        }
        for (const occurrence of afterOccurrences) {
          if (
            !beforeIds.has(String(occurrence.id)) &&
            occurrence.autoGenerated
          ) {
            await tx.query(
              'DELETE FROM reminders WHERE owner_id=$1 AND target_kind=$2 AND target_id=$3',
              [owner, 'task', occurrence.id],
            );
            await tx.query('DELETE FROM tasks WHERE owner_id=$1 AND id=$2', [
              owner,
              occurrence.id,
            ]);
          }
        }
        const active = await tx.query<{ id: string }>(
          `SELECT id FROM tasks WHERE owner_id=$1 AND series_id=$2
             AND deleted_at IS NULL`,
          [owner, seriesId],
        );
        for (const task of active)
          await syncTaskReminderOffsets(tx, owner, task.id);
      } else {
        const target = after as { id: string; version: number };
        await restorePlannerItem(
          tx,
          'tasks',
          taskColumns,
          owner,
          target.id,
          target.version,
        );
        await syncTaskReminderOffsets(tx, owner, target.id);
      }
    } else if (row.tool === 'task.restore') {
      const target = after as { id: string; version: number };
      const [deleted] = await tx.query(
        `UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP,version=version+1
         WHERE owner_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL
         RETURNING id`,
        [owner, target.id, target.version],
      );
      if (!deleted)
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'This task changed again; undo would overwrite it.',
        );
      await tx.query(
        `UPDATE reminders SET status='cancelled',cancel_reason='sync',
           version=version+1,updated_at=CURRENT_TIMESTAMP
         WHERE owner_id=$1 AND target_kind='task' AND target_id=$2
           AND status IN ('queued','running','paused')`,
        [owner, target.id],
      );
    } else if (row.tool === 'event.delete') {
      const target = after as { id: string; version: number };
      await restorePlannerItem(
        tx,
        'events',
        eventColumns,
        owner,
        target.id,
        target.version,
      );
      await syncEventReminderOffsets(tx, owner, target.id);
    } else if (row.tool === 'event.restore') {
      await saveEvent(transactionDatabase(tx), owner, 'DELETE', after.id, {
        operationId,
        expectedVersion: after.version,
      });
    } else if (row.tool === 'study.preferences.update') {
      const current = await readStudyPreferences(tx, owner);
      if (current.version !== after.version)
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'Study preferences changed again; undo would overwrite them.',
        );
      const restored = studyPreferencesInputSchema.parse({
        timeZone: before.timeZone,
        sessionMinutes: before.sessionMinutes,
        breakMinutes: before.breakMinutes,
        dailyMaximumMinutes: before.dailyMaximumMinutes,
        windows: before.windows,
      });
      await tx.query(
        'UPDATE study_preferences SET settings=$2::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
        [owner, JSON.stringify(restored)],
      );
    } else if (row.tool === 'course.create') {
      await undoCourseCreate(tx, owner, courseSchema.parse(after));
    } else if (row.tool === 'course.update') {
      await undoCourseUpdate(
        tx,
        owner,
        courseSchema.parse(before),
        courseSchema.parse(after),
      );
    } else if (row.tool === 'course.delete') {
      const beforeObject = before as { course: unknown; topics: unknown[] };
      const afterObject = after as { course: unknown; topics: unknown[] };
      await undoCourseDelete(
        tx,
        owner,
        {
          course: courseSchema.parse(beforeObject.course),
          topics: (beforeObject.topics ?? []).map((topic) =>
            topicSchema.parse(topic),
          ),
        },
        {
          course: courseSchema.parse(afterObject.course),
          topics: (afterObject.topics ?? []).map((topic) =>
            topicSchema.parse(topic),
          ),
        },
      );
    } else if (row.tool === 'topic.create') {
      await undoTopicCreate(tx, owner, topicSchema.parse(after));
    } else if (row.tool === 'topic.update') {
      await undoTopicUpdate(
        tx,
        owner,
        topicSchema.parse(before),
        topicSchema.parse(after),
      );
    } else if (row.tool === 'topic.delete') {
      await undoTopicDelete(tx, owner, topicSchema.parse(after));
    } else if (row.tool === 'academicWork.create') {
      await undoAcademicWorkCreate(tx, owner, academicWorkSchema.parse(after));
    } else if (row.tool === 'academicWork.update') {
      await undoAcademicWorkUpdate(
        tx,
        owner,
        academicWorkSchema.parse(before),
        academicWorkSchema.parse(after),
      );
    } else if (row.tool === 'academicWork.delete') {
      await undoAcademicWorkDelete(tx, owner, academicWorkSchema.parse(after));
    } else if (row.tool === 'academicWork.restore') {
      await undoAcademicWorkRestore(tx, owner, academicWorkSchema.parse(after));
    } else if (row.tool === 'trackedDeadline.update') {
      await undoTrackedDeadlineUpdate(
        tx,
        owner,
        trackedDeadlineSchema.parse(before),
        trackedDeadlineSchema.parse(after),
      );
    } else if (row.tool === 'trackedDeadline.complete') {
      await undoTrackedDeadlineCompletion(
        tx,
        owner,
        trackedDeadlineSchema.parse(before),
        trackedDeadlineSchema.parse(after),
        false,
      );
    } else if (row.tool === 'trackedDeadline.reopen') {
      await undoTrackedDeadlineCompletion(
        tx,
        owner,
        trackedDeadlineSchema.parse(before),
        trackedDeadlineSchema.parse(after),
        true,
      );
    } else {
      throw new ApiError(
        400,
        'CAPABILITY_NOT_UNDOABLE',
        'This action cannot be undone.',
      );
    }
    await tx.query(
      'UPDATE ai_capability_audit SET undone_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
      [owner, auditId],
    );
    await tx.query(
      `INSERT INTO ai_capability_audit
        (id,owner_id,capability,action,target_kind,target_id,decision,reason,
         operation_id,before,after,undoable,tool,auto_approved)
       VALUES($1,$2,$3,'restore',$4,$5,'applied',$6,$7,$8::jsonb,$9::jsonb,
         false,'undo',false)`,
      [
        randomUUID(),
        owner,
        row.capability,
        row.tool === 'task.delete' || row.tool === 'task.restore'
          ? 'task'
          : row.tool === 'event.delete' || row.tool === 'event.restore'
            ? 'event'
            : null,
        capabilityTargetId({}, before, after),
        `Undid ${row.tool ?? 'capability action'}.`,
        operationId,
        JSON.stringify(after),
        JSON.stringify(before),
      ],
    );
    return { undone: true };
  });
}
