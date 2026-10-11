import { useCallback, useEffect, useState } from 'react';
import { synchronize } from '../lib/api';
import { offlineChanged, offlineStatus, discardTask } from '../lib/offline';
import { Banner } from './Banner';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';

type Status = Awaited<ReturnType<typeof offlineStatus>>;

/** Task outbox state and the sync loop. Call once, in the app shell. */
export function useTaskSync() {
  const [online, setOnline] = useState(navigator.onLine);
  const [status, setStatus] = useState<Status>({
    pending: 0,
    queued: [],
    locked: false,
    lastSaved: null,
    conflicts: [],
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
  const queue = status.conflicts.length
    ? `Conflict · ${status.conflicts.length}`
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

/** Task sync details, in the page flow so they never cover content. */
export function SyncDetails({ state }: { state: TaskSync }) {
  const { online, status, error, busy, sync, summary } = state;
  return (
    <section
      id={detailsId}
      className="sync__details"
      aria-label="Task sync"
      hidden={!state.detailsOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        state.setDetailsOpen(false);
        document.getElementById(`${detailsId}-toggle`)?.focus();
      }}
    >
      <p>{summary}</p>
      {(!online || status.unavailable) && status.lastSaved && (
        <p>Tasks cached {new Date(status.lastSaved).toLocaleString()}</p>
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
        <Help label="Offline tasks">
          Tasks can be created, edited, completed and deleted offline. Other
          screens show previously loaded data; their edits require a connection.
          Only previously visited calendar ranges are cached. Local data is
          stored on this device until sign-out. Offline access ends when the
          last verified session expires. Reconnect to check revocation and sync.
          Local storage can be cleared or evicted. Sync pending changes before
          clearing browser or app data.
        </Help>
      </div>
    </section>
  );
}

/** Persistent banner listing task conflicts with their retained local drafts. */
export function SyncConflicts({ state }: { state: TaskSync }) {
  const [dialog, confirm] = useConfirm();
  const [error, setError] = useState('');
  const { status, sync } = state;
  if (!status.conflicts.length && !error) return dialog;
  return (
    <Banner
      tone="danger"
      label="Task conflicts"
      title="Some queued task changes could not be saved"
    >
      {error && <p role="alert">{error}</p>}
      {status.conflicts.map((item) => (
        <div className="conflict" key={item.id}>
          <strong>Task conflict: {item.title}</strong>
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
            <dl>
              <dt>Due date</dt>
              <dd>{item.task.dueDate ?? 'None'}</dd>
              <dt>Priority</dt>
              <dd>{item.task.priority}</dd>
              <dt>Status</dt>
              <dd>
                {item.task.deletedAt
                  ? 'Deleted'
                  : item.task.completed
                    ? 'Completed'
                    : 'Open'}
              </dd>
              <dt>Content label</dt>
              <dd>{item.task.sensitivity}</dd>
            </dl>
          </details>
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
                void discardTask(item.id).then(
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
