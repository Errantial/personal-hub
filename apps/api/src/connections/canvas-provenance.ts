import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';

// Retain the captured facts and expose current metadata without rewriting planner fields.
export function plannerSourceColumns(table: 'tasks' | 'events') {
  return `(SELECT ${table}.canvas_source_snapshot || jsonb_build_object(
    'currentVersion',i.version,'currentTitle',i.provider_data->>'title',
    'currentAvailability',i.availability,'currentInputKind',i.input_kind,
    'currentTiming',jsonb_build_object('allDay',i.provider_data->'allDay','startDate',i.provider_data->'startDate','endDate',i.provider_data->'endDate','startsAt',i.provider_data->'startsAt','endsAt',i.provider_data->'endsAt'),
    'currentSensitivity',CASE WHEN 'restricted' IN (s.sensitivity,i.sensitivity,c.sensitivity) THEN 'restricted'
      WHEN 'personal' IN (s.sensitivity,i.sensitivity,c.sensitivity) THEN 'personal' ELSE 'unlabeled' END)
    FROM canvas_items i JOIN canvas_sources s ON s.owner_id=i.owner_id
    LEFT JOIN courses c ON c.id=i.course_id AND c.owner_id=i.owner_id
    WHERE i.id=${table}.canvas_source_id AND i.owner_id=${table}.owner_id) AS "canvasSource"`;
}
export async function captureCanvasSource(
  tx: QueryExecutor,
  owner: string,
  ref?: { itemId: string; expectedVersion: number },
) {
  if (!ref) return null;
  // Same lock order as imports: source, then entry; labels and snapshot stay consistent.
  const [source] = await tx.query(
    'SELECT sensitivity FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
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
    sensitivity:
      levels[
        Math.max(
          0,
          ...[source.sensitivity, item.sensitivity, course?.sensitivity].map(
            (value) => levels.indexOf(String(value)),
          ),
        )
      ],
  };
}
