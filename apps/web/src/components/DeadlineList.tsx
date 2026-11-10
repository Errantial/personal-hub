import { useRef, useState } from 'react';
import { trackedDeadlineResponseSchema } from '@hub/contracts';
import type { TrackedDeadline } from '@hub/contracts';
import { dueLabel } from '../lib/deadlines';
import { formatInstant } from '../lib/format';
import { useMutation, useOnline } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Help } from './Help';
import { Link } from './Link';
import { StatusChip } from './StatusChip';

type TasksRoute = Extract<Route, { name: 'tasks' }>;

export type DeadlineListResource = {
  data: { deadlines: TrackedDeadline[]; nextAfter: string | null } | undefined;
  error: string;
  loading: boolean;
  reload: () => Promise<unknown>;
};

export function DeadlineList({
  resource,
  cachedAt,
  route,
  navigate,
}: {
  resource: DeadlineListResource;
  /** When the list is a saved copy shown without a connection. */
  cachedAt: string | null;
  route: TasksRoute;
  navigate: (route: Route) => void;
}) {
  const [show, setShow] = useState<'open' | 'completed'>('open');
  const all = resource.data?.deadlines ?? [];
  const items = all.filter((deadline) =>
    show === 'open' ? !deadline.completedAt : !!deadline.completedAt,
  );
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section
      className="deadline-list"
      aria-labelledby="imported-deadlines-title"
    >
      <div className="deadline-list__head">
        <h3 id="imported-deadlines-title" ref={heading} tabIndex={-1}>
          Imported deadlines
        </h3>
        <Help label="Imported deadlines">
          These Canvas deadlines are tracked automatically. Completion, title,
          due-date, priority, notes and label edits stay in Personal Hub. They
          do not submit, reopen or change work in Canvas.
        </Help>
      </div>
      <div
        className="deadline-list__filters"
        role="group"
        aria-label="Imported deadline filters"
      >
        <button
          type="button"
          className="secondary-button"
          aria-pressed={show === 'open'}
          onClick={() => setShow('open')}
        >
          Open
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-pressed={show === 'completed'}
          onClick={() => setShow('completed')}
        >
          Completed
        </button>
      </div>
      {resource.loading && !resource.data && <p role="status">Loading…</p>}
      {resource.error && <p role="alert">{resource.error}</p>}
      {cachedAt && (
        <p className="meta">
          Cached imported deadlines: {formatInstant(cachedAt)}
        </p>
      )}
      <button
        type="button"
        className="text-button"
        disabled={resource.loading}
        onClick={() => {
          void resource.reload();
        }}
      >
        {resource.error ? 'Retry' : 'Reload'} imported deadlines
      </button>
      {resource.data && !items.length && (
        <p>
          {show === 'open'
            ? 'No open imported deadlines.'
            : 'No completed imported deadlines.'}
        </p>
      )}
      {items.length > 0 && (
        <ul className="deadline-rows">
          {items.map((deadline) => (
            <DeadlineRow
              key={deadline.id}
              deadline={deadline}
              current={route.deadline === deadline.id}
              listRoute={{
                name: 'tasks',
                ...(route.filter ? { filter: route.filter } : {}),
              }}
              navigate={navigate}
              onChanged={async () => {
                await resource.reload();
                heading.current?.focus();
              }}
            />
          ))}
        </ul>
      )}
      {resource.data?.nextAfter && (
        <p className="meta">
          Showing the first 200 imported deadlines. Reload after older items are
          completed or removed from the current view.
        </p>
      )}
    </section>
  );
}

function DeadlineRow({
  deadline,
  current,
  listRoute,
  navigate,
  onChanged,
}: {
  deadline: TrackedDeadline;
  current: boolean;
  listRoute: TasksRoute;
  navigate: (route: Route) => void;
  onChanged: () => Promise<void>;
}) {
  const online = useOnline();
  const toggle = useMutation();
  const completed = !!deadline.completedAt;
  const action = completed ? 'reopen' : 'complete';
  async function changeCompletion() {
    if (!online) return;
    const result = await toggle.run(
      trackedDeadlineResponseSchema,
      'POST',
      `/api/v1/deadlines/${deadline.id}/${action}`,
      { expectedVersion: deadline.version },
      'Could not update this imported deadline. Reload it and try again.',
    );
    if (result) await onChanged();
  }
  return (
    <li
      className={`deadline-row ${completed ? 'deadline-row--done' : ''}`}
      aria-current={current ? 'true' : undefined}
    >
      <input
        type="checkbox"
        checked={completed}
        disabled={!online || toggle.pending}
        aria-label={`${completed ? 'Reopen' : 'Complete'} ${deadline.title} in Personal Hub`}
        onChange={() => {
          void changeCompletion();
        }}
      />
      <div className="deadline-row__body">
        <Link
          className="deadline-row__title"
          route={{ ...listRoute, deadline: deadline.id }}
          navigate={navigate}
        >
          {deadline.title}
        </Link>
        <div className="deadline-row__meta">
          <span>{dueLabel(deadline.due)}</span>
          {deadline.priority === 'high' && (
            <StatusChip tone="attention">High priority</StatusChip>
          )}
          {deadline.sourceConflict && (
            <StatusChip tone="danger">Canvas sources differ</StatusChip>
          )}
          {deadline.sourceAvailability !== 'available' && (
            <StatusChip tone="attention">
              Canvas {deadline.sourceAvailability}
            </StatusChip>
          )}
          {deadline.effectiveSensitivity !== 'unlabeled' && (
            <StatusChip>
              {deadline.effectiveSensitivity === 'personal'
                ? 'Personal'
                : 'Restricted'}
            </StatusChip>
          )}
        </div>
        {!online && <small>Connect to change imported deadlines.</small>}
        {toggle.error && (
          <p role="alert" className="form-error deadline-row__error">
            {toggle.error}
          </p>
        )}
      </div>
    </li>
  );
}
