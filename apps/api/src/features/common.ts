import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { plannerSourceColumns } from '../connections/canvas-provenance.js';
import { academicSourceColumns } from './academic-provenance.js';
export const stamp = (column: string, alias: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${alias}"`;
export const metadataColumns = `id, version, ${stamp('created_at', 'createdAt')}, ${stamp('updated_at', 'updatedAt')}, ${stamp('deleted_at', 'deletedAt')}`;
export const eventColumns = `${academicSourceColumns('events')}, ${plannerSourceColumns('events')}, ${metadataColumns}, title, notes, ${stamp('starts_at', 'startsAt')}, ${stamp('ends_at', 'endsAt')}, time_zone AS "timeZone", sensitivity, academic_labels AS "academicLabels", all_day AS "allDay", to_char(start_date,'YYYY-MM-DD') AS "startDate", to_char(end_date,'YYYY-MM-DD') AS "endDate", recurrence, course_id AS "courseId", topic_id AS "topicId", study_status AS "studyStatus"`;
export const rank = (value: string) =>
  ['unlabeled', 'personal', 'restricted'].indexOf(value);
export const strongest = (...values: string[]) =>
  (['unlabeled', 'personal', 'restricted'] as const)[
    Math.max(0, ...values.map(rank))
  ]!;
export async function active(
  tx: QueryExecutor,
  table: 'events' | 'tasks' | 'courses' | 'topics' | 'reminders',
  owner: string,
  id: string,
) {
  const [row] = await tx.query(
    `SELECT * FROM ${table} WHERE owner_id = $1 AND id = $2${table === 'reminders' ? '' : ' AND deleted_at IS NULL'} FOR UPDATE`,
    [owner, id],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'This item is no longer available.');
  return row;
}
export function version(row: Record<string, unknown>, expected?: number) {
  if (!expected || row.version !== expected)
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'Reload before editing this item.',
    );
}
export async function academicLabels(
  tx: QueryExecutor,
  owner: string,
  courseId: string | null,
  topicId: string | null,
) {
  const course = courseId ? await active(tx, 'courses', owner, courseId) : null;
  const topic = topicId ? await active(tx, 'topics', owner, topicId) : null;
  if (topic && topic.course_id !== courseId)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      'The topic must belong to the selected course.',
    );
  const history = Array.isArray(topic?.academic_labels)
    ? topic.academic_labels
    : [];
  return {
    labels: (['personal', 'restricted'] as const).filter((label) =>
      [course?.sensitivity, topic?.sensitivity, ...history].includes(label),
    ),
    complete: topic?.academic_labels !== null,
  };
}
export function mergeAcademicLabels(
  previous: unknown,
  labels: readonly string[] | null,
) {
  if (previous === null || labels === null) return null;
  if (
    previous !== undefined &&
    (!Array.isArray(previous) ||
      previous.some(
        (value) => !['personal', 'restricted'].includes(String(value)),
      ))
  )
    throw new ApiError(
      409,
      'PROVENANCE_UNAVAILABLE',
      'Academic label history is unavailable.',
    );
  return (['personal', 'restricted'] as const).filter(
    (label) =>
      labels.includes(label) ||
      (Array.isArray(previous) && previous.includes(label)),
  );
}
