import { useEffect, useState } from 'react';
import { canvasPlannerWorkSchema } from '@hub/contracts';
import type { z } from 'zod';
import { getJson } from '../lib/api';
import { Help } from './Help';
type Work = z.infer<typeof canvasPlannerWorkSchema>;
export function CanvasPlannerWork({
  kind,
  itemId,
}: {
  kind: 'calendar' | 'assignment-api';
  itemId: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Work | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener('hub-planner-changed', changed);
    return () => window.removeEventListener('hub-planner-changed', changed);
  }, []);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void getJson(
      `/api/v1/connections/canvas/planner-work?${new URLSearchParams({ kind, itemId })}`,
      canvasPlannerWorkSchema,
      abort.signal,
    ).then(
      (value) => {
        if (!abort.signal.aborted) {
          setData(value);
          setError('');
        }
      },
      () => {
        if (!abort.signal.aborted) setError('Linked planner work unavailable.');
      },
    );
    return () => abort.abort();
  }, [open, kind, itemId, revision]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Planner work</summary>
      <Help label="Planner work">
        Active tasks and study blocks created from this source or explicitly
        reconciled sources. Completed tasks remain visible; deleted records are
        excluded. Completion describes your planner work, not Canvas submission
        or mastery. Creating more work remains a deliberate action. Cached lists
        reflect the last loaded snapshot; edit in Today or Calendar.
      </Help>
      <button
        className="text-button"
        type="button"
        onClick={() => setRevision((value) => value + 1)}
      >
        Reload planner work
      </button>
      {error && <p role="alert">{error}</p>}
      {data ? (
        <>
          <p>
            {data.tasks.length} tasks · {data.studies.length} study blocks
          </p>
          {data.tasks.map((task) => (
            <p key={task.id}>
              {task.title} · {task.completed ? 'Completed' : 'Open'}
              {task.dueDate ? ` · Due ${task.dueDate}` : ''}
            </p>
          ))}
          {data.studies.map((study) => (
            <p key={study.id}>
              {study.title} · {study.studyStatus} ·{' '}
              {new Date(study.startsAt).toLocaleString()}
            </p>
          ))}
        </>
      ) : (
        !error && <p role="status">Loading planner work…</p>
      )}
    </details>
  );
}
