import { useEffect, useRef } from 'react';
import type { Ref } from 'react';
import {
  taskResponseSchema,
  trackedDeadlineResponseSchema,
} from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { useMutation } from '../lib/hooks';
import type { OfflineStatus } from '../lib/hooks';
import type { Route } from '../lib/router';
import { completionBody } from '../lib/tasks';
import type { TodayItem } from '../lib/today';
import { Link } from './Link';
import { StatusChip } from './StatusChip';

/** What reverses a completion made from a Today row. */
export type Completion =
  | { type: 'task'; task: Task }
  | { type: 'deadline'; id: string; version: number };

const kindLabels: Record<TodayItem['kind'], string> = {
  deadline: 'Deadline',
  task: 'Task',
  work: 'Class work',
  event: 'Event',
  study: 'Study',
};

/**
 * One Today row: an optional completion checkbox, the linked title, then a
 * meta line with the time, class and tags. Tasks complete through the task
 * transport (queued offline); imported deadlines complete online, in
 * Personal Hub only.
 */
export function TodayRow({
  item,
  meta,
  status,
  online,
  navigate,
  onCompleted,
  onConflict,
}: {
  item: TodayItem;
  meta: string;
  status: OfflineStatus | null;
  online: boolean;
  navigate: (route: Route) => void;
  onCompleted: (undo: Completion) => Promise<void>;
  onConflict: () => Promise<unknown>;
}) {
  const toggle = useMutation();
  const action = item.action;
  const taskId = action?.type === 'task' ? action.task.id : null;
  const queued = !!taskId && !!status?.queued.includes(taskId);
  const conflict =
    !!taskId && !!status?.conflicts.some((value) => value.id === taskId);
  // A stale row cannot be completed; load the current one, once per conflict.
  const stale = toggle.conflict;
  const reloadStale = useRef(onConflict);
  reloadStale.current = onConflict;
  useEffect(() => {
    if (stale) void reloadStale.current();
  }, [stale]);
  async function complete() {
    if (action?.type === 'task') {
      const result = await toggle.run(
        taskResponseSchema,
        'PUT',
        `/api/v1/tasks/${action.task.id}`,
        completionBody(action.task, true),
        'Could not update the task. It is unchanged.',
      );
      if (result) await onCompleted({ type: 'task', task: result.task });
    } else if (action?.type === 'deadline') {
      const result = await toggle.run(
        trackedDeadlineResponseSchema,
        'POST',
        `/api/v1/deadlines/${action.id}/complete`,
        { expectedVersion: action.version },
        'Could not update this imported deadline. Reload it and try again.',
      );
      if (result)
        await onCompleted({
          type: 'deadline',
          id: action.id,
          version: result.deadline.version,
        });
    }
  }
  const target = item.target;
  const title = item.deadlineId ? (
    <Link
      route={{ name: 'tasks', deadline: item.deadlineId }}
      navigate={navigate}
    >
      {item.title}
    </Link>
  ) : target.type === 'task' ? (
    <Link route={{ name: 'tasks', id: target.id }} navigate={navigate}>
      {item.title}
    </Link>
  ) : target.type === 'event' ? (
    <Link
      route={{ name: 'calendar', editor: { kind: 'event', id: target.id } }}
      navigate={navigate}
    >
      {item.title}
    </Link>
  ) : target.type === 'work' ? (
    <Link
      route={{ name: 'classes', id: target.courseId, section: 'work' }}
      navigate={navigate}
    >
      {item.title}
    </Link>
  ) : target.url ? (
    <a href={target.url} target="_blank" rel="noreferrer">
      {item.title}
    </a>
  ) : (
    <span>{item.title}</span>
  );
  return (
    <li className="today-row" data-today-row={item.key}>
      {action && (
        <input
          type="checkbox"
          className="today-row__check"
          aria-label={
            action.type === 'task'
              ? `Complete ${item.title}`
              : `Complete ${item.title} in Personal Hub`
          }
          checked={toggle.pending}
          disabled={toggle.pending || (action.type === 'deadline' && !online)}
          onChange={() => {
            void complete();
          }}
        />
      )}
      <span className="today-row__main">
        <span className="today-row__title">{title}</span>
        <span className="today-row__meta">
          {meta && <span className="today-row__time">{meta}</span>}
          <span className="today-row__tags">
            {item.context && (
              <span className="today-row__note">{item.context}</span>
            )}
            {item.cancelled && (
              <span className="today-row__note">Cancelled</span>
            )}
            {conflict ? (
              <StatusChip tone="danger">Conflict</StatusChip>
            ) : queued ? (
              <StatusChip tone="attention">
                {status?.locked ? 'Locked' : 'Queued'}
              </StatusChip>
            ) : null}
            <span
              className={`kind-tag kind-tag--${item.kind === 'work' ? 'deadline' : item.kind}`}
            >
              {kindLabels[item.kind]}
            </span>
          </span>
        </span>
      </span>
      {toggle.error && (
        <p role="alert" className="form-error today-row__error">
          {stale
            ? 'This item changed elsewhere. The list was reloaded; try again.'
            : toggle.error}
        </p>
      )}
    </li>
  );
}

/** The row a completion leaves in place until the next one: its Undo. */
export function CompletedRow({
  title,
  pending,
  error,
  undoRef,
  onUndo,
}: {
  title: string;
  pending: boolean;
  error: string;
  undoRef: Ref<HTMLButtonElement>;
  onUndo: () => void;
}) {
  return (
    <li className="today-row today-row--done">
      <span className="today-row__done-text">Completed “{title}”.</span>
      <button
        ref={undoRef}
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={onUndo}
      >
        Undo
      </button>
      {error && (
        <p role="alert" className="form-error today-row__error">
          {error}
        </p>
      )}
    </li>
  );
}
