import { randomUUID } from 'node:crypto';
import {
  Temporal,
  canvasAssignmentUrl,
  canvasDeadlineIdentity,
  trackedDeadlineSchema,
  type CanvasDeadlineIdentity,
  type TrackedDeadline,
  type TrackedDeadlineDue,
  type TrackedDeadlineDueOverride,
} from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp, strongest } from '../features/common.js';

type SourceBinding =
  | {
      kind: 'feed';
      sourceId: string;
      sourceVersion: number;
      sourceKind: 'calendar-feed' | 'calendar-file';
    }
  | {
      kind: 'assignment';
      sourceId: string;
      sourceVersion: number;
      sourceKind: 'assignment-api';
    }
  | {
      kind: 'browser';
      sourceId: string;
      sourceVersion: number;
      sourceKind: 'browser';
    };

type DeadlineRoot = Record<string, unknown> & {
  id: string;
  providerKind: 'canvas';
  canonicalKey: string;
  version: number;
  completedAt: string | null;
  priority: 'low' | 'normal' | 'high';
  notes: string;
  titleOverride: string | null;
  dueOverrideKind: 'provider' | 'timed' | 'date' | 'unknown';
  dueAtOverride: string | null;
  dueDateOverride: string | null;
  dueTimeZone: string | null;
  sensitivity: 'unlabeled' | 'personal' | 'restricted';
  sourceLabels: string[];
  createdAt: string;
  updatedAt: string;
};

type ProjectedSource = {
  sourceId: string;
  kind: 'calendar-feed' | 'calendar-file' | 'assignment-api' | 'browser';
  primary: boolean;
  identityMatches: boolean;
  capturedVersion: number;
  currentVersion: number;
  title: string;
  due: TrackedDeadlineDue;
  availability: 'available' | 'cancelled' | 'missing';
  sourceUrl: string | null;
  sensitivity: 'unlabeled' | 'personal' | 'restricted';
  labels: ('unlabeled' | 'personal' | 'restricted')[];
};

export const trackedDeadlineColumns = `id,provider_kind AS "providerKind",canonical_key AS "canonicalKey",version,${stamp('completed_at', 'completedAt')},priority,notes,title_override AS "titleOverride",due_override_kind AS "dueOverrideKind",${stamp('due_at_override', 'dueAtOverride')},to_char(due_date_override,'YYYY-MM-DD') AS "dueDateOverride",due_time_zone AS "dueTimeZone",sensitivity,source_labels AS "sourceLabels",${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')}`;

const normalizeLabels = (
  ...values: unknown[]
): ('unlabeled' | 'personal' | 'restricted')[] => {
  const flat = values.flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  const retained = (['personal', 'restricted'] as const).filter((label) =>
    flat.includes(label),
  );
  return retained.length ? retained : ['unlabeled'];
};

const sourceColumn = (binding: SourceBinding) =>
  binding.kind === 'feed'
    ? 'canvas_item_id'
    : binding.kind === 'assignment'
      ? 'canvas_assignment_id'
      : 'canvas_browser_item_id';

async function bindSource(
  tx: QueryExecutor,
  owner: string,
  binding: SourceBinding,
  identity: CanvasDeadlineIdentity | null,
  labels: readonly string[],
) {
  const column = sourceColumn(binding);
  const [existing] = await tx.query<{ deadlineId: string }>(
    `SELECT deadline_id AS "deadlineId" FROM tracked_deadline_sources WHERE owner_id=$1 AND ${column}=$2 FOR UPDATE`,
    [owner, binding.sourceId],
  );
  if (existing) {
    await tx.query(
      `UPDATE tracked_deadline_sources SET source_version=$3,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND ${column}=$2`,
      [owner, binding.sourceId, binding.sourceVersion],
    );
    await tx.query(
      'UPDATE tracked_deadlines SET source_labels=hub_sensitivity_labels(source_labels || $3::text[]) WHERE owner_id=$1 AND id=$2',
      [owner, existing.deadlineId, normalizeLabels(labels)],
    );
    return existing.deadlineId;
  }
  if (!identity) return null;

  const mergedLabels = normalizeLabels(labels);
  const [deadline] = await tx.query<{ id: string }>(
    `INSERT INTO tracked_deadlines(id,owner_id,provider_kind,canonical_key,source_labels)
     VALUES($1,$2,'canvas',$3,$4::text[])
     ON CONFLICT(owner_id,provider_kind,canonical_key) DO UPDATE
       SET source_labels=hub_sensitivity_labels(tracked_deadlines.source_labels || EXCLUDED.source_labels)
     RETURNING id`,
    [randomUUID(), owner, identity.canonicalKey, mergedLabels],
  );
  if (!deadline) throw new Error('Tracked deadline materialization failed.');
  await tx.query(
    'SELECT id FROM tracked_deadlines WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [owner, deadline.id],
  );
  const [primary] = await tx.query(
    'SELECT id FROM tracked_deadline_sources WHERE owner_id=$1 AND deadline_id=$2 AND is_primary FOR UPDATE',
    [owner, deadline.id],
  );
  const fields = {
    feed: 'canvas_item_id',
    assignment: 'canvas_assignment_id',
    browser: 'canvas_browser_item_id',
  } as const;
  await tx.query(
    `INSERT INTO tracked_deadline_sources(id,owner_id,deadline_id,${fields[binding.kind]},source_kind,is_primary,source_version)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      owner,
      deadline.id,
      binding.sourceId,
      binding.sourceKind,
      !primary,
      binding.sourceVersion,
    ],
  );
  return deadline.id;
}

export async function materializeCanvasDeadlineFromItem(
  tx: QueryExecutor,
  owner: string,
  itemId: string,
) {
  const [row] = await tx.query<{
    id: string;
    version: number;
    inputKind: 'calendar-feed' | 'calendar-file';
    providerData: { sourceUrl?: string | null };
    labels: string[];
  }>(
    `SELECT i.id,i.version,i.input_kind AS "inputKind",i.provider_data AS "providerData",x.labels
     FROM canvas_items i JOIN canvas_item_context x ON x.id=i.id AND x.owner_id=i.owner_id
     WHERE i.owner_id=$1 AND i.id=$2`,
    [owner, itemId],
  );
  if (!row) return null;
  return bindSource(
    tx,
    owner,
    {
      kind: 'feed',
      sourceId: row.id,
      sourceVersion: row.version,
      sourceKind: row.inputKind,
    },
    canvasDeadlineIdentity(row.providerData.sourceUrl),
    row.labels,
  );
}

export async function materializeCanvasDeadlineFromAssignment(
  tx: QueryExecutor,
  owner: string,
  assignmentId: string,
) {
  const [row] = await tx.query<{
    id: string;
    version: number;
    providerId: string;
    courseProviderId: string;
    labels: string[];
  }>(
    `SELECT a.id,a.version,a.provider_id AS "providerId",lc.provider_id AS "courseProviderId",x.labels
     FROM canvas_lms_assignments a
     JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id
     JOIN canvas_assignment_context x ON x.id=a.id AND x.owner_id=a.owner_id
     WHERE a.owner_id=$1 AND a.id=$2`,
    [owner, assignmentId],
  );
  if (!row) return null;
  const identity: CanvasDeadlineIdentity | null = (() => {
    try {
      return canvasDeadlineIdentity(
        canvasAssignmentUrl(row.courseProviderId, row.providerId),
      );
    } catch {
      return null;
    }
  })();
  return bindSource(
    tx,
    owner,
    {
      kind: 'assignment',
      sourceId: row.id,
      sourceVersion: row.version,
      sourceKind: 'assignment-api',
    },
    identity,
    row.labels,
  );
}

export async function materializeCanvasDeadlineFromBrowserItem(
  tx: QueryExecutor,
  owner: string,
  browserItemId: string,
) {
  const [row] = await tx.query<{
    id: string;
    version: number;
    canonicalUrl: string;
    sourceSensitivity: string;
    courseSensitivity: string;
    itemSensitivity: string;
    classSensitivity: string | null;
  }>(
    `SELECT bi.id,bi.version,bi.canonical_url AS "canonicalUrl",bs.sensitivity AS "sourceSensitivity",bc.sensitivity AS "courseSensitivity",bi.sensitivity AS "itemSensitivity",c.sensitivity AS "classSensitivity"
     FROM canvas_browser_items bi
     JOIN canvas_browser_courses bc ON bc.id=bi.browser_course_id AND bc.owner_id=bi.owner_id
     JOIN canvas_browser_sources bs ON bs.owner_id=bi.owner_id
     LEFT JOIN courses c ON c.id=bc.course_id AND c.owner_id=bc.owner_id
     WHERE bi.owner_id=$1 AND bi.id=$2`,
    [owner, browserItemId],
  );
  if (!row) return null;
  return bindSource(
    tx,
    owner,
    {
      kind: 'browser',
      sourceId: row.id,
      sourceVersion: row.version,
      sourceKind: 'browser',
    },
    canvasDeadlineIdentity(row.canonicalUrl),
    normalizeLabels(
      row.sourceSensitivity,
      row.courseSensitivity,
      row.itemSensitivity,
      row.classSensitivity,
    ),
  );
}

export async function refreshTrackedDeadlineLabelFloor(
  tx: QueryExecutor,
  owner: string,
) {
  await tx.query(
    `WITH current_labels AS (
       SELECT s.deadline_id,label
       FROM tracked_deadline_sources s
       JOIN canvas_item_context x ON x.owner_id=s.owner_id AND x.id=s.canvas_item_id
       CROSS JOIN LATERAL unnest(x.labels) AS labels(label)
       WHERE s.owner_id=$1 AND s.canvas_item_id IS NOT NULL
       UNION ALL
       SELECT s.deadline_id,label
       FROM tracked_deadline_sources s
       JOIN canvas_assignment_context x ON x.owner_id=s.owner_id AND x.id=s.canvas_assignment_id
       CROSS JOIN LATERAL unnest(x.labels) AS labels(label)
       WHERE s.owner_id=$1 AND s.canvas_assignment_id IS NOT NULL
       UNION ALL
       SELECT s.deadline_id,label
       FROM tracked_deadline_sources s
       JOIN canvas_browser_items bi ON bi.owner_id=s.owner_id AND bi.id=s.canvas_browser_item_id
       JOIN canvas_browser_courses bc ON bc.owner_id=bi.owner_id AND bc.id=bi.browser_course_id
       JOIN canvas_browser_sources bs ON bs.owner_id=bi.owner_id
       LEFT JOIN courses c ON c.owner_id=bc.owner_id AND c.id=bc.course_id
       CROSS JOIN LATERAL unnest(hub_sensitivity_labels(ARRAY[bs.sensitivity,bc.sensitivity,bi.sensitivity,c.sensitivity])) AS labels(label)
       WHERE s.owner_id=$1 AND s.canvas_browser_item_id IS NOT NULL
     ), merged AS (
       SELECT deadline_id,hub_sensitivity_labels(array_agg(label)) AS labels
       FROM current_labels GROUP BY deadline_id
     )
     UPDATE tracked_deadlines d
       SET source_labels=hub_sensitivity_labels(d.source_labels || merged.labels)
     FROM merged WHERE d.owner_id=$1 AND d.id=merged.deadline_id`,
    [owner],
  );
}

async function readSourceFacts(
  tx: QueryExecutor,
  owner: string,
  deadlineIds: string[],
) {
  if (!deadlineIds.length) return [] as Record<string, unknown>[];
  const feed = await tx.query(
    `SELECT s.deadline_id AS "deadlineId",s.canvas_item_id AS "sourceId",s.source_kind AS kind,s.is_primary AS primary,s.source_version AS "capturedVersion",i.version AS "currentVersion",i.provider_data->>'title' AS title,i.provider_data->>'startsAt' AS "dueAt",i.provider_data->>'startDate' AS "dueDate",i.provider_data->>'allDay' AS "allDay",i.provider_data->>'sourceUrl' AS "sourceUrl",i.availability,x.sensitivity,x.labels
     FROM tracked_deadline_sources s
     JOIN canvas_items i ON i.owner_id=s.owner_id AND i.id=s.canvas_item_id
     JOIN canvas_item_context x ON x.owner_id=i.owner_id AND x.id=i.id
     WHERE s.owner_id=$1 AND s.deadline_id=ANY($2::uuid[]) AND s.canvas_item_id IS NOT NULL`,
    [owner, deadlineIds],
  );
  const assignments = await tx.query(
    `SELECT s.deadline_id AS "deadlineId",s.canvas_assignment_id AS "sourceId",s.source_kind AS kind,s.is_primary AS primary,s.source_version AS "capturedVersion",a.version AS "currentVersion",a.provider_data->>'title' AS title,a.provider_data->>'dueAt' AS "dueAt",NULL::text AS "dueDate",'false'::text AS "allDay",lc.provider_id AS "courseProviderId",a.provider_id AS "providerId",lc.provider_data->>'timeZone' AS "timeZone",CASE WHEN a.availability='missing' OR lc.availability='missing' THEN 'missing' ELSE 'available' END AS availability,x.sensitivity,x.labels
     FROM tracked_deadline_sources s
     JOIN canvas_lms_assignments a ON a.owner_id=s.owner_id AND a.id=s.canvas_assignment_id
     JOIN canvas_lms_courses lc ON lc.owner_id=a.owner_id AND lc.id=a.canvas_course_id
     JOIN canvas_assignment_context x ON x.owner_id=a.owner_id AND x.id=a.id
     WHERE s.owner_id=$1 AND s.deadline_id=ANY($2::uuid[]) AND s.canvas_assignment_id IS NOT NULL`,
    [owner, deadlineIds],
  );
  const browser = await tx.query(
    `SELECT s.deadline_id AS "deadlineId",s.canvas_browser_item_id AS "sourceId",s.source_kind AS kind,s.is_primary AS primary,s.source_version AS "capturedVersion",bi.version AS "currentVersion",bi.title,${stamp('bi.due_at', 'dueAt')},NULL::text AS "dueDate",'false'::text AS "allDay",bi.canonical_url AS "sourceUrl",CASE WHEN bi.availability='missing' OR bc.availability='missing' THEN 'missing' ELSE 'available' END AS availability,bs.sensitivity AS "sourceSensitivity",bc.sensitivity AS "courseSensitivity",bi.sensitivity AS "itemSensitivity",c.sensitivity AS "classSensitivity"
     FROM tracked_deadline_sources s
     JOIN canvas_browser_items bi ON bi.owner_id=s.owner_id AND bi.id=s.canvas_browser_item_id
     JOIN canvas_browser_courses bc ON bc.owner_id=bi.owner_id AND bc.id=bi.browser_course_id
     JOIN canvas_browser_sources bs ON bs.owner_id=bi.owner_id
     LEFT JOIN courses c ON c.owner_id=bc.owner_id AND c.id=bc.course_id
     WHERE s.owner_id=$1 AND s.deadline_id=ANY($2::uuid[]) AND s.canvas_browser_item_id IS NOT NULL`,
    [owner, deadlineIds],
  );
  return [...feed, ...assignments, ...browser];
}

const sourceDue = (row: Record<string, unknown>): TrackedDeadlineDue => {
  if (row.allDay === 'true' && typeof row.dueDate === 'string')
    return { kind: 'date', dueDate: row.dueDate };
  if (typeof row.dueAt === 'string')
    return {
      kind: 'timed',
      dueAt: row.dueAt,
      timeZone: typeof row.timeZone === 'string' ? row.timeZone : null,
    };
  return { kind: 'unknown' };
};

function projectedSource(
  row: Record<string, unknown>,
  canonicalKey: string,
): ProjectedSource {
  let sourceUrl = typeof row.sourceUrl === 'string' ? row.sourceUrl : null;
  if (!sourceUrl && row.kind === 'assignment-api') {
    try {
      sourceUrl = canvasAssignmentUrl(
        String(row.courseProviderId),
        String(row.providerId),
      );
    } catch {
      sourceUrl = null;
    }
  }
  const identity = canvasDeadlineIdentity(sourceUrl);
  const identityMatches = identity?.canonicalKey === canonicalKey;
  const browserLabels = normalizeLabels(
    row.sourceSensitivity,
    row.courseSensitivity,
    row.itemSensitivity,
    row.classSensitivity,
  );
  const labels = normalizeLabels(row.labels ?? browserLabels);
  const sensitivity = strongest(
    String(row.sensitivity ?? 'unlabeled'),
    ...browserLabels,
  );
  return {
    sourceId: String(row.sourceId),
    kind: row.kind as ProjectedSource['kind'],
    primary: Boolean(row.primary),
    identityMatches,
    capturedVersion: Number(row.capturedVersion),
    currentVersion: Number(row.currentVersion),
    title: identityMatches
      ? String(row.title || 'Canvas deadline')
      : 'Canvas deadline',
    due: identityMatches ? sourceDue(row) : { kind: 'unknown' },
    availability: identityMatches
      ? (String(row.availability) as ProjectedSource['availability'])
      : 'missing',
    sourceUrl: identityMatches ? identity.canonicalUrl : null,
    sensitivity: sensitivity as ProjectedSource['sensitivity'],
    labels,
  };
}

const localDateForTimed = (
  due: Extract<TrackedDeadlineDue, { kind: 'timed' }>,
) =>
  Temporal.Instant.from(due.dueAt)
    .toZonedDateTimeISO(due.timeZone ?? 'America/Denver')
    .toPlainDate()
    .toString();

const duesCompatible = (
  left: TrackedDeadlineDue,
  right: TrackedDeadlineDue,
) => {
  if (left.kind === 'unknown' || right.kind === 'unknown') return true;
  if (left.kind === 'timed' && right.kind === 'timed')
    return left.dueAt === right.dueAt;
  if (left.kind === 'date' && right.kind === 'date')
    return left.dueDate === right.dueDate;
  if (left.kind === 'date' && right.kind === 'timed')
    return localDateForTimed(right) === left.dueDate;
  if (left.kind === 'timed' && right.kind === 'date')
    return localDateForTimed(left) === right.dueDate;
  return false;
};

const sourceConflict = (sources: ProjectedSource[]) => {
  const known = sources.filter(
    (source) => source.identityMatches && source.due.kind !== 'unknown',
  );
  for (let left = 0; left < known.length; left++)
    for (let right = left + 1; right < known.length; right++)
      if (!duesCompatible(known[left]!.due, known[right]!.due)) return true;
  return false;
};

const dueOverride = (root: DeadlineRoot): TrackedDeadlineDueOverride => {
  if (root.dueOverrideKind === 'provider') return { kind: 'provider' };
  if (root.dueOverrideKind === 'unknown') return { kind: 'unknown' };
  if (root.dueOverrideKind === 'date')
    return { kind: 'date', dueDate: root.dueDateOverride! };
  return {
    kind: 'timed',
    dueAt: root.dueAtOverride!,
    timeZone: root.dueTimeZone!,
  };
};

function projectRoot(root: DeadlineRoot, rows: Record<string, unknown>[]) {
  const sources = rows
    .map((row) => projectedSource(row, root.canonicalKey))
    .sort(
      (left, right) =>
        Number(right.primary) - Number(left.primary) ||
        left.kind.localeCompare(right.kind) ||
        left.sourceId.localeCompare(right.sourceId),
    );
  if (!sources.length)
    throw new Error('Tracked deadline has no retained source binding.');
  const primary = sources.find((source) => source.primary);
  if (!primary)
    throw new Error('Tracked deadline has no primary source binding.');
  const providerDue = primary.due;
  const override = dueOverride(root);
  const due: TrackedDeadlineDue =
    override.kind === 'provider' ? providerDue : override;
  const timedAlternates =
    providerDue.kind === 'date'
      ? sources.filter(
          (source) =>
            !source.primary &&
            source.identityMatches &&
            source.due.kind === 'timed' &&
            localDateForTimed(source.due) === providerDue.dueDate,
        )
      : [];
  const alternateInstants = [
    ...new Set(
      timedAlternates.map((source) =>
        source.due.kind === 'timed' ? source.due.dueAt : '',
      ),
    ),
  ].filter(Boolean);
  const alternateTimedDue =
    alternateInstants.length === 1
      ? (timedAlternates[0]!.due as Extract<
          TrackedDeadlineDue,
          { kind: 'timed' }
        >)
      : null;
  const labels = normalizeLabels(
    root.sourceLabels,
    root.sensitivity,
    ...sources.flatMap((source) => source.labels),
  );
  const effectiveSensitivity = strongest(
    root.sensitivity,
    ...labels,
    ...sources.map((source) => source.sensitivity),
  );
  return trackedDeadlineSchema.parse({
    ...root,
    dueOverride: override,
    title: root.titleOverride ?? primary.title,
    due,
    providerDue,
    sourceUrl: primary.sourceUrl,
    sourceAvailability: primary.availability,
    sourceCoverage: [...new Set(sources.map((source) => source.kind))],
    sourceConflict: sourceConflict(sources),
    alternateTimedDue,
    labels,
    effectiveSensitivity,
    sources,
  });
}

export async function readTrackedDeadlines(
  tx: QueryExecutor,
  owner: string,
  limit = 2000,
): Promise<TrackedDeadline[]> {
  const roots = await tx.query<DeadlineRoot>(
    `SELECT ${trackedDeadlineColumns} FROM tracked_deadlines WHERE owner_id=$1 ORDER BY canonical_key,id LIMIT $2`,
    [owner, limit + 1],
  );
  if (roots.length > limit)
    throw new ApiError(
      413,
      limit === 10000 ? 'EXPORT_TOO_LARGE' : 'DEADLINES_LIMIT',
      'Too many tracked deadlines.',
    );
  const facts = await readSourceFacts(
    tx,
    owner,
    roots.map((root) => root.id),
  );
  const byRoot = new Map<string, Record<string, unknown>[]>();
  for (const fact of facts) {
    const key = String(fact.deadlineId);
    const values = byRoot.get(key) ?? [];
    values.push(fact);
    byRoot.set(key, values);
  }
  return roots.map((root) => projectRoot(root, byRoot.get(root.id) ?? []));
}

export async function readTrackedDeadline(
  tx: QueryExecutor,
  owner: string,
  id: string,
): Promise<TrackedDeadline> {
  const [root] = await tx.query<DeadlineRoot>(
    `SELECT ${trackedDeadlineColumns} FROM tracked_deadlines WHERE owner_id=$1 AND id=$2`,
    [owner, id],
  );
  if (!root)
    throw new ApiError(404, 'NOT_FOUND', 'Tracked deadline not available.');
  const facts = await readSourceFacts(tx, owner, [id]);
  return projectRoot(root, facts);
}

export function trackedDeadlineLocalDate(deadline: TrackedDeadline) {
  if (deadline.due.kind === 'date') return deadline.due.dueDate;
  if (deadline.due.kind === 'unknown') return null;
  return localDateForTimed(deadline.due);
}
