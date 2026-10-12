import type { QueryExecutor } from '../db/database.js';

export function academicSourceColumns(table: 'tasks' | 'events') {
  const column = table === 'tasks' ? 'task_id' : 'event_id';
  return `(SELECT jsonb_build_object('linkId',s.id,'workId',s.work_id,'courseId',w.course_id,
    'capturedWorkVersion',(s.snapshot->>'version')::int,'capturedCourseVersion',(s.snapshot->>'courseVersion')::int,
    'currentWorkVersion',w.version,'currentCourseVersion',c.version,'currentStatus',w.status,
    'sourceDeleted',w.deleted_at IS NOT NULL,'courseArchived',c.deleted_at IS NOT NULL,
    'labels',s.labels,'provenance','owner-entered-planning-fields')
    FROM academic_planner_sources s JOIN academic_work w ON w.id=s.work_id AND w.owner_id=s.owner_id
    JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
    WHERE s.${column}=${table}.id AND s.owner_id=${table}.owner_id) AS "academicSource"`;
}
export async function academicPlannerLabels(
  tx: QueryExecutor,
  owner: string,
  kind: 'task' | 'event',
  id: string,
) {
  const [source] = await tx.query<{ labels: string[] }>(
    `SELECT labels FROM academic_planner_sources WHERE owner_id=$1 AND ${kind === 'task' ? 'task_id' : 'event_id'}=$2`,
    [owner, id],
  );
  return source?.labels ?? [];
}
// Calendar mutations already advance the item version. Capture new ancestors
// without another increment or certifying source text.
export async function extendAcademicEventLabels(
  tx: QueryExecutor,
  owner: string,
  eventId: string,
  labels: readonly string[],
) {
  const applied = [
    ...new Set(
      labels.filter((value) => ['personal', 'restricted'].includes(value)),
    ),
  ];
  if (applied.length)
    await tx.query(
      `UPDATE academic_planner_sources SET labels=ARRAY(SELECT DISTINCT value FROM unnest(labels || $3::text[]) AS inherited(value) ORDER BY value)
       WHERE owner_id=$1 AND event_id=$2`,
      [owner, eventId, applied],
    );
}
export async function extendAcademicTopicLabels(
  tx: QueryExecutor,
  owner: string,
  topicId: string,
  labels: readonly string[],
) {
  const applied = [
    ...new Set(
      labels.filter((value) => ['personal', 'restricted'].includes(value)),
    ),
  ];
  if (applied.length)
    await tx.query(
      `UPDATE academic_planner_sources s SET labels=ARRAY(SELECT DISTINCT value FROM unnest(s.labels || $3::text[]) AS inherited(value) ORDER BY value)
       WHERE s.owner_id=$1 AND EXISTS(SELECT 1 FROM events e WHERE e.id=s.event_id AND e.owner_id=s.owner_id
       AND (e.topic_id=$2 OR EXISTS(SELECT 1 FROM event_exceptions x WHERE x.event_id=e.id AND x.replacement->>'topicId'=$2::text)))`,
      [owner, topicId, applied],
    );
}
// All callers hold the owner schedule lock before ancestors, sources and items.
export async function propagateAcademicPlannerLabels(
  tx: QueryExecutor,
  owner: string,
  source: { workId: string } | { courseId: string },
  labels: readonly string[],
  updateEvents = true,
) {
  for (const label of new Set(
    labels.filter((value) => ['personal', 'restricted'].includes(value)),
  )) {
    const links = await tx.query<{
      task_id: string | null;
      event_id: string | null;
    }>(
      `UPDATE academic_planner_sources s SET labels=ARRAY(SELECT DISTINCT value FROM unnest(s.labels || ARRAY[$3]::text[]) AS inherited(value) ORDER BY value)
       WHERE s.owner_id=$1 AND NOT($3=ANY(s.labels)) AND (EXISTS(SELECT 1 FROM academic_work w WHERE w.id=s.work_id AND w.owner_id=s.owner_id AND ${'workId' in source ? 'w.id' : 'w.course_id'}=$2)
       ${'courseId' in source ? "OR EXISTS(SELECT 1 FROM events e WHERE e.id=s.event_id AND e.owner_id=s.owner_id AND (e.course_id=$2 OR EXISTS(SELECT 1 FROM event_exceptions x WHERE x.event_id=e.id AND x.replacement->>'courseId'=$2::text)))" : ''})
       RETURNING task_id,event_id`,
      [owner, 'workId' in source ? source.workId : source.courseId, label],
    );
    for (const table of updateEvents
      ? (['tasks', 'events'] as const)
      : (['tasks'] as const)) {
      const ids = links.flatMap((link) => {
        const id = table === 'tasks' ? link.task_id : link.event_id;
        return id ? [id] : [];
      });
      if (ids.length)
        await tx.query(
          `UPDATE ${table} SET sensitivity=CASE WHEN sensitivity='restricted' OR $3='restricted' THEN 'restricted' ELSE 'personal' END,
           version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=ANY($2::uuid[])`,
          [owner, ids, label],
        );
    }
  }
}
