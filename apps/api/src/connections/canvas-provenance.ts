import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import type { CanvasSourceRef } from '@hub/contracts';
import { strongest, version } from '../features/common.js';

// Retain the captured facts and expose current metadata without rewriting planner fields.
export function plannerSourceColumns(table: 'tasks' | 'events') {
  return `COALESCE((SELECT ${table}.canvas_source_snapshot || jsonb_build_object(
    'currentVersion',i.version,'currentTitle',i.provider_data->>'title',
    'currentAvailability',i.availability,'currentInputKind',i.input_kind,'currentAttachmentDerived',x.attachment_derived,'currentLabels',to_jsonb(x.labels),
    'currentTiming',jsonb_build_object('allDay',i.provider_data->'allDay','startDate',i.provider_data->'startDate','endDate',i.provider_data->'endDate','startsAt',i.provider_data->'startsAt','endsAt',i.provider_data->'endsAt'),
    'currentSensitivity',x.sensitivity)
    FROM canvas_items i JOIN canvas_sources s ON s.owner_id=i.owner_id
    JOIN canvas_item_context x ON x.id=i.id AND x.owner_id=i.owner_id
    LEFT JOIN courses c ON c.id=i.course_id AND c.owner_id=i.owner_id
    WHERE i.id=${table}.canvas_source_id AND i.owner_id=${table}.owner_id),
    (SELECT ${table}.canvas_assignment_snapshot || jsonb_build_object(
      'currentVersion',a.version,'currentCourseVersion',lc.version,'currentTitle',a.provider_data->>'title',
      'currentAvailability',CASE WHEN lc.availability='missing' THEN 'missing' ELSE a.availability END,
      'currentInputKind','assignment-api','currentAttachmentDerived',x.attachment_derived,'currentLabels',to_jsonb(x.labels),
      'currentTiming',jsonb_build_object('allDay',FALSE,'startDate',NULL,'endDate',NULL,'startsAt',a.provider_data->'dueAt','endsAt',a.provider_data->'dueAt'),
      'currentSensitivity',x.sensitivity)
    FROM canvas_lms_assignments a JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id
    JOIN canvas_lms_sources s ON s.owner_id=a.owner_id
    JOIN canvas_assignment_context x ON x.id=a.id AND x.owner_id=a.owner_id
    LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=lc.owner_id
    WHERE a.id=${table}.canvas_assignment_id AND a.owner_id=${table}.owner_id)) AS "canvasSource"`;
}
export async function captureCanvasSource(
  tx: QueryExecutor,
  owner: string,
  ref?: CanvasSourceRef,
) {
  if (!ref) return null;
  if ('kind' in ref) return captureAssignment(tx, owner, ref);
  // Same lock order as imports: source, then entry; labels and snapshot stay consistent.
  const [source] = await tx.query(
    'SELECT sensitivity FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  await tx.query(
    'SELECT owner_id FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  const [item] = await tx.query(
    'SELECT * FROM canvas_items WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [owner, ref.itemId],
  );
  if (!source || !item)
    throw new ApiError(404, 'NOT_FOUND', 'Canvas entry not available.');
  if (item.version !== ref.expectedVersion)
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'Canvas entry changed. Reload its version before creating.',
    );
  if (item.availability !== 'available')
    throw new ApiError(
      409,
      'SOURCE_UNAVAILABLE',
      'Only available Canvas entries can create planner items.',
    );
  const [course] = item.course_id
    ? await tx.query(
        'SELECT sensitivity FROM courses WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [item.course_id, owner],
      )
    : [];
  const data = item.provider_data as {
    title: string;
    sourceUrl: string | null;
    allDay: boolean;
    startDate: string | null;
    endDate: string | null;
    startsAt: string | null;
    endsAt: string | null;
  };
  const levels = ['unlabeled', 'personal', 'restricted'];
  const [context] = await tx.query(
    'SELECT sensitivity,attachment_derived,labels FROM canvas_item_context WHERE owner_id=$1 AND id=$2',
    [owner, ref.itemId],
  );
  return {
    itemId: ref.itemId,
    version: item.version,
    title: data.title,
    sourceUrl: data.sourceUrl,
    timing: {
      allDay: data.allDay,
      startDate: data.startDate,
      endDate: data.endDate,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
    },
    inputKind: item.input_kind,
    attachmentDerived:
      context?.attachment_derived ?? item.input_kind === 'calendar-file',
    labels: context?.labels,
    sensitivity:
      levels[
        Math.max(
          0,
          ...[
            source.sensitivity,
            item.sensitivity,
            course?.sensitivity,
            context?.sensitivity,
          ].map((value) => levels.indexOf(String(value))),
        )
      ],
  };
}

async function captureAssignment(
  tx: QueryExecutor,
  owner: string,
  ref: Extract<CanvasSourceRef, { kind: 'assignment-api' }>,
) {
  // Cross-adapter writes always lock the feed source before the API source.
  await tx.query(
    'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  const [source] = await tx.query(
    'SELECT sensitivity FROM canvas_lms_sources WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  const [item] = await tx.query(
    'SELECT * FROM canvas_lms_assignments WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [owner, ref.itemId],
  );
  if (!source || !item)
    throw new ApiError(404, 'NOT_FOUND', 'Canvas assignment not available.');
  const [course] = await tx.query(
    'SELECT * FROM canvas_lms_courses WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [owner, item.canvas_course_id],
  );
  if (!course)
    throw new ApiError(404, 'NOT_FOUND', 'Canvas course not available.');
  version(item, ref.expectedVersion);
  version(course, ref.expectedCourseVersion);
  if (item.availability !== 'available' || course.availability !== 'available')
    throw new ApiError(
      409,
      'SOURCE_UNAVAILABLE',
      'Canvas assignment is missing.',
    );
  const [local] = course.course_id
    ? await tx.query(
        'SELECT sensitivity FROM courses WHERE owner_id=$1 AND id=$2 FOR UPDATE',
        [owner, course.course_id],
      )
    : [];
  const data = item.provider_data as { title: string; dueAt: string | null };
  const [context] = await tx.query(
    'SELECT sensitivity,attachment_derived,labels FROM canvas_assignment_context WHERE owner_id=$1 AND id=$2',
    [owner, ref.itemId],
  );
  return {
    itemId: ref.itemId,
    version: item.version,
    courseVersion: course.version,
    title: data.title,
    sourceUrl: `https://canvas.colorado.edu/courses/${course.provider_id}/assignments/${item.provider_id}`,
    timing: {
      allDay: false,
      startDate: null,
      endDate: null,
      startsAt: data.dueAt,
      endsAt: data.dueAt,
    },
    inputKind: 'assignment-api',
    attachmentDerived: context?.attachment_derived ?? false,
    labels: context?.labels,
    sensitivity: strongest(
      String(source.sensitivity),
      String(course.sensitivity),
      String(item.sensitivity),
      String(local?.sensitivity ?? 'unlabeled'),
      String(context?.sensitivity ?? 'unlabeled'),
    ),
  };
}
