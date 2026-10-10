import { useEffect, useState } from 'react';
import { canvasLmsRecordsSchema } from '@hub/contracts';
import type { CanvasLmsCourse, CanvasLmsAssignment } from '@hub/contracts';
import { getJson } from '../lib/api';
import { CanvasAssignment } from './CanvasAssignment';
import { Help } from './Help';
export function ClassCanvasAssignments({ courseId }: { courseId: string }) {
  const [data, setData] = useState<{
    courses: CanvasLmsCourse[];
    assignments: CanvasLmsAssignment[];
    lastImportedAt: string | null;
  } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void getJson(
      `/api/v1/connections/canvas/lms/records?${new URLSearchParams({ courseId })}`,
      canvasLmsRecordsSchema,
      abort.signal,
    ).then(
      (value) => {
        if (!abort.signal.aborted) {
          setData(value);
          setError('');
        }
      },
      () => {
        if (!abort.signal.aborted) setError('Canvas assignments unavailable.');
      },
    );
    return () => abort.abort();
  }, [courseId, revision]);
  return (
    <section aria-label="Class Canvas assignments">
      <h3>Canvas assignments</h3>
      <Help label="Canvas assignments">
        Link Canvas API courses in Connections. API snapshots are separate from
        calendar feeds; assignments do not update your topic progress or grades.
        Missing deadlines remain unknown. Cached records reflect the last loaded
        snapshot.
      </Help>
      <button
        className="text-button"
        onClick={() => setRevision((value) => value + 1)}
      >
        Reload assignments
      </button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="meta">
            Last API import:{' '}
            {data.lastImportedAt
              ? new Date(data.lastImportedAt).toLocaleString()
              : 'Never'}
          </p>
          {data.courses.map((course) => (
            <div key={course.id}>
              <h4>
                {course.providerData.name}
                {course.availability === 'missing'
                  ? ' · Not in latest API snapshot'
                  : ''}
              </h4>
              {data.assignments
                .filter((item) => item.canvasCourseId === course.id)
                .map((item) => (
                  <CanvasAssignment key={item.id} item={item} course={course} />
                ))}
            </div>
          ))}
          {!data.assignments.length && <p>No linked assignments.</p>}
        </>
      )}
    </section>
  );
}
