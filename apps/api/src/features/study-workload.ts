import {
  studyWorkloadSnapshotSchema,
  studyWorkloadCurrentSchema,
  studyWorkloadContextSchema,
  studyWorkloadSourceSchema,
  studyEventContextSchema,
  studyWorkloadResponseSchema,
} from '@hub/contracts';
import type { StudyWorkloadSnapshot } from '@hub/contracts';
import type { z } from 'zod';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp, version } from './common.js';
import { readStudyPlan } from './study-engine.js';
import type { studyWorkloadQuerySchema } from '@hub/contracts';

const contextColumns = `plan_id AS "planId",context_revision AS "contextRevision",source_count AS "sourceCount",${stamp('captured_at', 'capturedAt')}`;
export async function readWorkloadContext(
  tx: QueryExecutor,
  owner: string,
  planId: string,
) {
  const [row] = await tx.query(
    `SELECT ${contextColumns} FROM study_workload_contexts WHERE owner_id=$1 AND plan_id=$2`,
    [owner, planId],
  );
  return row ? studyWorkloadContextSchema.parse(row) : null;
}
export async function captureStudyWorkload(
  tx: QueryExecutor,
  owner: string,
  planId: string,
  revision: string,
  sources: StudyWorkloadSnapshot[],
) {
  const plan = await readStudyPlan(tx, owner, planId, true);
  if (plan.status !== 'draft' || plan.deletedAt)
    throw new ApiError(
      409,
      'STUDY_PLAN_STATE',
      'Only visible drafts can replace workload history.',
    );
  const [linked] = await tx.query(
    'SELECT event_id FROM study_event_contexts WHERE owner_id=$1 AND plan_id=$2 LIMIT 1',
    [owner, planId],
  );
  if (linked)
    throw new ApiError(
      409,
      'STUDY_PLAN_STATE',
      'Approved workload history cannot be replaced.',
    );
  const snapshots = sources.map((source) =>
    studyWorkloadSnapshotSchema.parse(source),
  );
  if (
    snapshots.length > 5000 ||
    new Set(snapshots.map((s) => s.id)).size !== snapshots.length
  )
    throw new ApiError(
      413,
      'STUDY_TOO_LARGE',
      'Study workload exceeds its supported size.',
    );
  await tx.query(
    `INSERT INTO study_workload_contexts(plan_id,owner_id,context_revision,source_count) VALUES($1,$2,$3,$4)
    ON CONFLICT(plan_id,owner_id) DO UPDATE SET context_revision=$3,source_count=$4,captured_at=CURRENT_TIMESTAMP`,
    [planId, owner, revision, snapshots.length],
  );
  await tx.query(
    'DELETE FROM study_workload_sources WHERE owner_id=$1 AND plan_id=$2',
    [owner, planId],
  );
  await tx.query(
    `INSERT INTO study_workload_sources(plan_id,owner_id,work_id,snapshot)
    SELECT $1::uuid,$2::uuid,(value->>'id')::uuid,value FROM jsonb_array_elements($3::jsonb)`,
    [planId, owner, JSON.stringify(snapshots)],
  );
}
export async function linkStudyEventContext(
  tx: QueryExecutor,
  owner: string,
  planId: string,
  eventId: string,
) {
  await tx.query(
    'INSERT INTO study_event_contexts(event_id,owner_id,plan_id) VALUES($1,$2,$3)',
    [eventId, owner, planId],
  );
}

export async function inspectStudyWorkload(
  tx: QueryExecutor,
  owner: string,
  planId: string | null,
  query: z.infer<typeof studyWorkloadQuerySchema>,
  event: {
    id: string;
    version: number;
    deletedAt: string | null;
  } | null = null,
) {
  const plan = planId ? await readStudyPlan(tx, owner, planId, true) : null;
  if (query.expectedPlanVersion !== undefined) {
    if (!plan)
      throw new ApiError(
        409,
        'VERSION_CONFLICT',
        'This event has no linked study plan.',
      );
    version(plan, query.expectedPlanVersion);
  }
  const context = plan ? await readWorkloadContext(tx, owner, plan.id) : null;
  if (query.after) {
    const [cursor] = await tx.query(
      'SELECT work_id FROM study_workload_sources WHERE owner_id=$1 AND plan_id=$2 AND work_id=$3',
      [owner, planId, query.after],
    );
    if (!cursor)
      throw new ApiError(404, 'NOT_FOUND', 'Workload cursor not available.');
  }
  const rows = context
    ? await tx.query<{ snapshot: unknown; current: unknown }>(
        `SELECT s.snapshot,
    jsonb_build_object('id',w.id,'version',w.version,'courseId',w.course_id,'courseVersion',c.version,'courseSensitivity',c.sensitivity,
      'dueDate',to_char(w.due_date,'YYYY-MM-DD'),'estimatedMinutes',w.estimated_minutes,'priority',w.priority,'status',w.status,
      'sensitivity',w.sensitivity,'academicLabels',w.academic_labels,'provenance','owner-entered-planning-fields',
      'deletedAt',to_char(w.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'courseArchived',c.deleted_at IS NOT NULL) AS current
    FROM study_workload_sources s JOIN academic_work w ON w.id=s.work_id AND w.owner_id=s.owner_id
    JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
    WHERE s.owner_id=$1 AND s.plan_id=$2 ${query.after ? 'AND s.work_id>$4::uuid' : ''}
    ORDER BY s.work_id LIMIT $3`,
        query.after
          ? [owner, planId, query.limit + 1, query.after]
          : [owner, planId, query.limit + 1],
      )
    : [];
  const sources = rows.slice(0, query.limit).map((row) => {
    const snapshot = studyWorkloadSnapshotSchema.parse(row.snapshot);
    const current = studyWorkloadCurrentSchema.parse(row.current);
    return {
      snapshot,
      current,
      changed:
        snapshot.version !== current.version ||
        snapshot.courseVersion !== current.courseVersion,
    };
  });
  return studyWorkloadResponseSchema.parse({
    planId: plan?.id ?? null,
    planVersion: plan?.version ?? null,
    planStatus: plan?.status ?? null,
    planHidden: Boolean(plan?.deletedAt),
    eventId: event?.id ?? null,
    eventVersion: event?.version ?? null,
    eventDeletedAt: event?.deletedAt ?? null,
    history: !plan ? 'not-linked' : context ? 'captured' : 'unavailable',
    context,
    sources,
    nextAfter:
      rows.length > query.limit ? sources[query.limit - 1]!.snapshot.id : null,
  });
}

// Display-label propagation never certifies unknown AI history. Include tombstones
// and detached/cancelled blocks; source links are durable and cannot be removed.
export async function propagateWorkloadLabels(
  tx: QueryExecutor,
  owner: string,
  source: { workId: string } | { courseId: string },
  labels: readonly string[],
) {
  for (const label of new Set(
    labels.filter((value) => value !== 'unlabeled'),
  )) {
    if (!['personal', 'restricted'].includes(label))
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'Source labels are unavailable.',
      );
    await tx.query(
      `UPDATE events e SET sensitivity=CASE WHEN e.sensitivity='restricted' OR $3='restricted' THEN 'restricted' ELSE 'personal' END,
      academic_labels=CASE WHEN e.academic_labels IS NULL THEN NULL ELSE ARRAY(SELECT DISTINCT value FROM unnest(e.academic_labels || ARRAY[$3]::text[]) AS inherited(value) ORDER BY value) END,
      version=e.version+1,updated_at=CURRENT_TIMESTAMP
      WHERE e.owner_id=$1 AND EXISTS(SELECT 1 FROM study_event_contexts ec JOIN study_workload_sources s ON s.plan_id=ec.plan_id AND s.owner_id=ec.owner_id
        JOIN academic_work w ON w.id=s.work_id AND w.owner_id=s.owner_id
        WHERE ec.event_id=e.id AND ec.owner_id=e.owner_id AND ${'workId' in source ? 'w.id' : 'w.course_id'}=$2)
      AND (e.academic_labels IS NULL OR e.sensitivity='unlabeled' OR (e.sensitivity='personal' AND $3='restricted') OR (e.academic_labels IS NOT NULL AND NOT($3=ANY(e.academic_labels))))`,
      [owner, 'workId' in source ? source.workId : source.courseId, label],
    );
  }
}
export async function exportStudyWorkload(tx: QueryExecutor, owner: string) {
  return {
    studyWorkloadContexts: (
      await tx.query(
        `SELECT ${contextColumns} FROM study_workload_contexts WHERE owner_id=$1 ORDER BY plan_id LIMIT 10001`,
        [owner],
      )
    ).map((r) => studyWorkloadContextSchema.parse(r)),
    studyWorkloadSources: (
      await tx.query(
        'SELECT plan_id AS "planId",work_id AS "workId",snapshot FROM study_workload_sources WHERE owner_id=$1 ORDER BY plan_id,work_id LIMIT 10001',
        [owner],
      )
    ).map((r) => studyWorkloadSourceSchema.parse(r)),
    studyEventContexts: (
      await tx.query(
        'SELECT plan_id AS "planId",event_id AS "eventId" FROM study_event_contexts WHERE owner_id=$1 ORDER BY event_id LIMIT 10001',
        [owner],
      )
    ).map((r) => studyEventContextSchema.parse(r)),
  };
}
