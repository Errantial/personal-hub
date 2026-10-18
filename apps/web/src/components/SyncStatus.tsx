import { useCallback, useEffect, useState } from 'react';
import { synchronize } from '../lib/api';
import { offlineChanged, offlineStatus, discardOffline } from '../lib/offline';
import { Banner } from './Banner';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { Link } from './Link';
import type { Route } from '../lib/router';
import { formatInstant } from '../lib/format';

type Status = Awaited<ReturnType<typeof offlineStatus>>;

/** Task outbox state and the sync loop. Call once, in the app shell. */
export function useTaskSync() {
  const [online, setOnline] = useState(navigator.onLine);
  const [status, setStatus] = useState<Status>({
    pending: 0,
    queued: [],
    queuedItems: [],
    locked: false,
    lastSaved: null,
    conflicts: [],
    itemConflicts: [],
    unavailable: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const sync = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await synchronize();
    } catch {
      setError('Sync unavailable.');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const refresh = () => {
      void offlineStatus().then(setStatus, () =>
        setError('Offline storage unavailable.'),
      );
    };
    const network = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void sync();
    };
    refresh();
    void sync();
    const timer = setInterval(() => {
      if (navigator.onLine) void sync();
    }, 30000);
    window.addEventListener(offlineChanged, refresh);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    return () => {
      clearInterval(timer);
      window.removeEventListener(offlineChanged, refresh);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
    };
  }, [sync]);
  const connectivity = !online
    ? 'Offline'
    : status.unavailable
      ? 'Server unavailable'
      : 'Online';
  const queue = status.itemConflicts.length
    ? `Conflict · ${status.itemConflicts.length}`
    : status.locked
      ? `Locked · ${status.pending} queued`
      : status.pending
        ? `${status.pending} queued`
        : 'All saved';
  return {
    online,
    status,
    error,
    busy,
    sync,
    summary: `${connectivity} · ${queue}`,
    detailsOpen,
    setDetailsOpen,
  };
}
export type TaskSync = ReturnType<typeof useTaskSync>;

const detailsId = 'task-sync-details';

/** Compact header status; the toggle expands SyncDetails below the header. */
export function SyncIndicator({ state }: { state: TaskSync }) {
  return (
    <div className="sync">
      <span role="status" className="sync__summary">
        {state.summary}
      </span>
      <button
        id={`${detailsId}-toggle`}
        type="button"
        className="sync__toggle"
        aria-expanded={state.detailsOpen}
        aria-controls={detailsId}
        onClick={() => state.setDetailsOpen(!state.detailsOpen)}
      >
        Sync
      </button>
    </div>
  );
}

/** Offline sync details, in the page flow so they never cover content. */
export function SyncDetails({ state }: { state: TaskSync }) {
  const { online, status, error, busy, sync, summary } = state;
  return (
    <section
      id={detailsId}
      className="sync__details"
      aria-label="Offline sync"
      hidden={!state.detailsOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        state.setDetailsOpen(false);
        document.getElementById(`${detailsId}-toggle`)?.focus();
      }}
    >
      <p>{summary}</p>
      {(!online || status.unavailable) && status.lastSaved && (
        <p>Local data cached {formatInstant(status.lastSaved)}</p>
      )}
      {status.locked && <p>Sign in again to sync queued changes.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !online}
          onClick={() => {
            void sync();
          }}
        >
          Sync now
        </button>
        <Help label="Offline changes">
          Tasks and whole calendar events can be created, edited and deleted
          offline. Reminders can be added or rescheduled. Classes and topics can
          be added or deleted, and unlabeled topics can change notes, progress
          or confidence. Existing class edits, label changes, class-linked study
          events, reminder controls, snooze and single-occurrence calendar edits
          still require a connection. Only previously visited data and calendar
          ranges are cached. Local data is stored on this device until sign-out.
          Offline access ends when the last verified session expires. Reconnect
          to check revocation and sync.
        </Help>
      </div>
    </section>
  );
}

const conflictLabel = {
  task: 'Task',
  calendar: 'Calendar',
  reminder: 'Reminder',
  course: 'Class',
  topic: 'Topic',
} as const;

/** Persistent banner listing queued conflicts with their retained local drafts. */
export function SyncConflicts({
  state,
  navigate,
}: {
  state: TaskSync;
  navigate: (route: Route) => void;
}) {
  const [dialog, confirm] = useConfirm();
  const [error, setError] = useState('');
  const { status, sync } = state;
  if (!status.itemConflicts.length && !error) return dialog;
  return (
    <Banner
      tone="danger"
      label="Sync conflicts"
      title="Some queued changes could not be saved"
    >
      {error && <p role="alert">{error}</p>}
      {status.itemConflicts.map((item) => (
        <div className="conflict" key={`${item.kind}:${item.id}`}>
          <strong>
            {conflictLabel[item.kind]} conflict: {item.title}
          </strong>
          <p>
            {item.error === 'VERSION_CONFLICT'
              ? 'Server record changed.'
              : item.error === 'NOT_FOUND'
                ? 'Server record deleted.'
                : 'Request rejected.'}
          </p>
          <details>
            <summary>Local draft</summary>
            <p>{item.notes || 'No notes'}</p>
            {item.kind === 'task' && 'dueDate' in item.record && (
              <dl>
                <dt>Due date</dt>
                <dd>{item.record.dueDate ?? 'None'}</dd>
                <dt>Priority</dt>
                <dd>{item.record.priority}</dd>
                <dt>Status</dt>
                <dd>
                  {item.record.deletedAt
                    ? 'Deleted'
                    : item.record.completed
                      ? 'Completed'
                      : 'Open'}
                </dd>
                <dt>Content label</dt>
                <dd>{item.record.sensitivity}</dd>
              </dl>
            )}
          </details>
          {item.kind === 'task' && (
            <Link route={{ name: 'tasks', id: item.id }} navigate={navigate}>
              Open task
            </Link>
          )}{' '}
          {item.kind === 'calendar' && (
            <Link
              route={{
                name: 'calendar',
                editor: { kind: 'event', id: item.id },
              }}
              navigate={navigate}
            >
              Open event
            </Link>
          )}{' '}
          {item.kind === 'reminder' && (
            <Link
              route={{ name: 'inbox', section: 'reminders', reminder: item.id }}
              navigate={navigate}
            >
              Open reminder
            </Link>
          )}{' '}
          {item.kind === 'course' && (
            <Link
              route={{ name: 'classes', id: item.id, section: 'details' }}
              navigate={navigate}
            >
              Open class
            </Link>
          )}{' '}
          {item.kind === 'topic' &&
            'courseId' in item.record &&
            typeof item.record.courseId === 'string' && (
              <Link
                route={{ name: 'classes', id: item.record.courseId }}
                navigate={navigate}
              >
                Open class
              </Link>
            )}{' '}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void confirm({
                title: `Discard queued changes to “${item.title}”?`,
                message:
                  'The server version will be used. Your local draft cannot be recovered.',
                confirmLabel: 'Discard changes',
              }).then((confirmed) => {
                if (!confirmed) return;
                setError('');
                void discardOffline(item.kind, item.id).then(
                  () => sync(),
                  () => setError('Could not discard changes.'),
                );
              });
            }}
          >
            Discard local changes
          </button>
        </div>
      ))}
      {dialog}
    </Banner>
  );
}
