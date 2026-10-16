import {
  Temporal,
  calendarRecordSchema,
  sensitivitySchema,
  taskSchema,
} from '@hub/contracts';
import type {
  AssistantAcademicSent,
  AssistantMemorySent,
  CalendarRecord,
  Task,
} from '@hub/contracts';
import { z } from 'zod';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { eventColumns } from '../features/common.js';
import { taskColumns } from '../planner/routes.js';
import { readMemorySettings } from '../features/memory.js';
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

export const openTask = (task: Task, aiOrigin = 'owner-entered') =>
  aiOrigin === 'owner-entered' &&
  task.sensitivity === 'unlabeled' &&
  !task.canvasSource &&
  !task.academicSource &&
  !task.mailSource;
export const openEvent = (event: CalendarRecord, aiOrigin = 'owner-entered') =>
  aiOrigin === 'owner-entered' &&
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
        ? `SELECT ${taskColumns},ai_origin AS "aiOrigin",id IN (${appliedFromMail}) AS "fromMail" FROM tasks WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL AND completed=false`
        : `SELECT ${taskColumns},ai_origin AS "aiOrigin",id IN (${appliedFromMail}) AS "fromMail" FROM tasks WHERE owner_id=$1 AND deleted_at IS NULL AND completed=false ORDER BY due_date NULLS LAST,created_at DESC LIMIT 150`,
      byIds ? [owner, select.tasks] : [owner],
    )
  ).map((row) => ({
    task: taskSchema.parse(row),
    aiOrigin: String(row.aiOrigin ?? 'owner-entered'),
    fromMail: !!row.fromMail,
  }));
  const events = (
    await tx.query(
      byIds
        ? `SELECT ${eventColumns},ai_origin AS "aiOrigin",id IN (${appliedFromMail}) AS "fromMail" FROM events WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`
        : `SELECT ${eventColumns},ai_origin AS "aiOrigin",id IN (${appliedFromMail}) AS "fromMail" FROM events WHERE owner_id=$1 AND deleted_at IS NULL AND ends_at >= CURRENT_TIMESTAMP - interval '1 day' AND starts_at < CURRENT_TIMESTAMP + interval '30 days' ORDER BY starts_at,id LIMIT 150`,
      byIds ? [owner, select.events] : [owner],
    )
  )
    .map((row) => ({
      event: calendarRecordSchema.parse(row),
      aiOrigin: String(row.aiOrigin ?? 'owner-entered'),
      fromMail: !!row.fromMail,
    }))
    // Repeating series are not offered (one change would move every
    // occurrence) and, as before, are not counted as withheld.
    .filter((e) => e.event.recurrence === null);
  const openTasks = tasks.filter(
    (t) => !t.fromMail && openTask(t.task, t.aiOrigin),
  );
  const openEvents = events.filter(
    (e) => !e.fromMail && openEvent(e.event, e.aiOrigin),
  );
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

type Sensitivity = z.infer<typeof sensitivitySchema>;

/** One explicitly selected work item, pinned to work and class versions. */
export type AcademicSelected = {
  id: string;
  expectedVersion: number;
  expectedCourseVersion: number;
};

/** Exactly the allowlisted planning fields; nothing else may be sent. */
export type AcademicProjected = {
  ref: string;
  title: string;
  kind: string;
  dueDate: string | null;
  estimatedMinutes: number | null;
  status: string;
  priority: number;
};

export type AcademicContextItem = {
  id: string;
  version: number;
  courseId: string;
  courseVersion: number;
  labels: Sensitivity[];
  ref: string;
  projected: AcademicProjected;
};

export type AcademicContext = {
  items: AcademicContextItem[];
  /** Selected items the destination's labels kept out. */
  withheld: number;
  /** The same items as persisted on the turn, for later coverage display. */
  sent: AssistantAcademicSent[];
};

export const projectAcademic = (
  work: {
    title: string;
    kind: string;
    dueDate: string | null;
    estimatedMinutes: number | null;
    status: string;
    priority: number;
  },
  ref: string,
): AcademicProjected => ({
  ref,
  title: work.title,
  kind: work.kind,
  dueDate: work.dueDate,
  estimatedMinutes: work.estimatedMinutes,
  status: work.status,
  priority: work.priority,
});

/**
 * Resolves explicit academic selections to projections, labels and manifest
 * entries. Identity, deletion and version problems block the ask before any
 * hold; a label the destination may not receive withholds that item instead.
 */
export async function academicContext(
  tx: QueryExecutor,
  owner: string,
  select: AcademicSelected[],
  allowed: Sensitivity[],
): Promise<AcademicContext> {
  const items: AcademicContextItem[] = [];
  let withheld = 0;
  for (const ref of select) {
    const [row] = await tx.query(
      `SELECT w.id,w.version,w.title,w.kind,to_char(w.due_date,'YYYY-MM-DD') AS "dueDate",w.estimated_minutes AS "estimatedMinutes",w.priority,w.status,w.sensitivity,w.academic_labels AS "academicLabels",w.course_id AS "courseId",(w.deleted_at IS NOT NULL) AS "workDeleted",c.version AS "courseVersion",c.sensitivity AS "courseSensitivity",(c.deleted_at IS NOT NULL) AS "courseArchived"
       FROM academic_work w JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
       WHERE w.owner_id=$1 AND w.id=$2`,
      [owner, ref.id],
    );
    if (!row || row.workDeleted)
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This academic item is no longer available.',
      );
    if (Number(row.version) !== ref.expectedVersion)
      throw new ApiError(409, 'VERSION_CONFLICT', 'Reload academic context.');
    if (Number(row.courseVersion) !== ref.expectedCourseVersion)
      throw new ApiError(409, 'VERSION_CONFLICT', 'Reload academic context.');
    if (row.courseArchived)
      throw new ApiError(
        409,
        'ACADEMIC_CLASS_ARCHIVED',
        'This class is archived.',
      );
    const history = sensitivitySchema
      .array()
      .max(2)
      .parse(row.academicLabels ?? []);
    const labels = [
      ...new Set<Sensitivity>([
        sensitivitySchema.parse(row.sensitivity),
        sensitivitySchema.parse(row.courseSensitivity),
        ...history,
      ]),
    ];
    if (labels.some((label) => !allowed.includes(label))) {
      withheld += 1;
      continue;
    }
    const name = `w${items.length + 1}`;
    const projected = projectAcademic(
      {
        title: String(row.title),
        kind: String(row.kind),
        dueDate: (row.dueDate as string | null) ?? null,
        estimatedMinutes: (row.estimatedMinutes as number | null) ?? null,
        status: String(row.status),
        priority: Number(row.priority),
      },
      name,
    );
    items.push({
      id: String(row.id),
      version: Number(row.version),
      courseId: String(row.courseId),
      courseVersion: Number(row.courseVersion),
      labels,
      ref: name,
      projected,
    });
  }
  return {
    items,
    withheld,
    sent: items.map((item) => ({
      id: item.id,
      ref: item.ref,
      title: item.projected.title,
      kind: item.projected.kind as AssistantAcademicSent['kind'],
      dueDate: item.projected.dueDate,
      estimatedMinutes: item.projected.estimatedMinutes,
      status: item.projected.status as AssistantAcademicSent['status'],
      priority: item.projected.priority,
    })),
  };
}

/** Manifest entries for selected academic work, refs w1… as sent. */
export function academicSources(
  owner: string,
  requestId: string,
  items: AcademicContextItem[],
): LiveSource[] {
  return items.map((item): LiveSource => ({
    projection: 'academic-work-v1',
    kind: 'academic-work',
    id: item.id,
    version: item.version,
    ref: item.ref,
    labels: item.labels,
    academicCourse: { id: item.courseId, version: item.courseVersion },
    digest: sourceDigest(
      owner,
      requestId,
      'academic-work-v1',
      item.id,
      item.projected,
    ),
  }));
}

/** One explicitly selected memory item, pinned to record and global settings versions. */
export type MemorySelected = {
  id: string;
  expectedVersion: number;
  expectedSettingsVersion: number;
};

/** Exactly the allowlisted planning fields; nothing else may be sent. */
export type MemoryProjected = {
  ref: string;
  kind: 'preference' | 'goal' | 'fact';
  title: string;
  content: string;
  observedOn: string | null;
};

export type MemoryContextItem = {
  id: string;
  version: number;
  settingsVersion: number;
  labels: Sensitivity[];
  ref: string;
  projected: MemoryProjected;
};

export type MemoryContext = {
  items: MemoryContextItem[];
  /** Selected items the destination's labels kept out. */
  withheld: number;
  /** The same items as persisted on the turn, for later coverage display. */
  sent: AssistantMemorySent[];
};

export const projectMemory = (
  memory: {
    kind: 'preference' | 'goal' | 'fact';
    title: string;
    content: string;
    observedOn: string | null;
  },
  ref: string,
): MemoryProjected => ({
  ref,
  kind: memory.kind,
  title: memory.title,
  content: memory.content,
  observedOn: memory.observedOn,
});

/**
 * Resolves explicit memory selections to projections, labels and manifest
 * entries. Identity, deletion, disabled state and version problems block the ask before
 * any hold; a label the destination may not receive withholds that item instead.
 */
export async function memoryContext(
  tx: QueryExecutor,
  owner: string,
  select: MemorySelected[],
  allowed: Sensitivity[],
): Promise<MemoryContext> {
  if (!select.length) return { items: [], withheld: 0, sent: [] };
  const settings = await readMemorySettings(tx, owner);
  if (!settings.enabled)
    throw new ApiError(
      409,
      'MEMORY_DISABLED',
      'Memory is disabled in settings.',
    );
  const items: MemoryContextItem[] = [];
  let withheld = 0;
  for (const ref of select) {
    if (ref.expectedSettingsVersion !== settings.version)
      throw new ApiError(409, 'VERSION_CONFLICT', 'Reload memory settings.');
    const [row] = await tx.query(
      `SELECT id,version,kind,title,content,to_char(observed_on,'YYYY-MM-DD') AS "observedOn",enabled,sensitivity,labels,(deleted_at IS NOT NULL) AS "forgotten"
       FROM memories WHERE owner_id=$1 AND id=$2`,
      [owner, ref.id],
    );
    if (!row || row.forgotten)
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This memory item is no longer available.',
      );
    if (Number(row.version) !== ref.expectedVersion)
      throw new ApiError(409, 'VERSION_CONFLICT', 'Reload memory context.');
    if (!row.enabled)
      throw new ApiError(
        409,
        'MEMORY_DISABLED',
        'This memory item is disabled.',
      );
    const labels = [
      ...new Set<Sensitivity>([
        sensitivitySchema.parse(row.sensitivity),
        ...sensitivitySchema
          .array()
          .max(3)
          .parse(row.labels ?? []),
      ]),
    ];
    if (labels.some((label) => !allowed.includes(label))) {
      withheld += 1;
      continue;
    }
    const name = `m${items.length + 1}`;
    const projected = projectMemory(
      {
        kind: row.kind as MemoryProjected['kind'],
        title: String(row.title),
        content: String(row.content),
        observedOn: (row.observedOn as string | null) ?? null,
      },
      name,
    );
    items.push({
      id: String(row.id),
      version: Number(row.version),
      settingsVersion: settings.version,
      labels,
      ref: name,
      projected,
    });
  }
  return {
    items,
    withheld,
    sent: items.map((item) => ({
      id: item.id,
      ref: item.ref,
      kind: item.projected.kind,
      title: item.projected.title,
      content: item.projected.content,
      observedOn: item.projected.observedOn,
    })),
  };
}

/** Manifest entries for selected memory items, refs m1… as sent. */
export function memorySources(
  owner: string,
  requestId: string,
  items: MemoryContextItem[],
): LiveSource[] {
  return items.map((item): LiveSource => ({
    projection: 'memory-item-v1',
    kind: 'memory',
    id: item.id,
    version: item.version,
    ref: item.ref,
    labels: item.labels,
    memorySettings: { version: item.settingsVersion },
    digest: sourceDigest(
      owner,
      requestId,
      'memory-item-v1',
      item.id,
      item.projected,
    ),
  }));
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
