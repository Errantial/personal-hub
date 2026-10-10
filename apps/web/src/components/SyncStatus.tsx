import { useEffect, useState } from 'react';
import { synchronize } from '../lib/api';
import { offlineChanged, offlineStatus, discardTask } from '../lib/offline';
import { Help } from './Help';

export function SyncStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const [status, setStatus] = useState<
    Awaited<ReturnType<typeof offlineStatus>>
  >({
    pending: 0,
    queued: [],
    locked: false,
    lastSaved: null,
    conflicts: [],
    unavailable: false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function sync() {
    setBusy(true);
    setError('');
    try {
      await synchronize();
    } catch {
      setError('Sync unavailable.');
    } finally {
      setBusy(false);
    }
  }
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
  }, []);
  return (
    <section className="sync-status panel" aria-label="Task sync">
      <div className="form-actions">
        <span role="status">
          {online
            ? status.unavailable
              ? 'Server unavailable'
              : 'Online'
            : 'Offline'}{' '}
          · {status.pending} pending changes
        </span>
        <button
          className="text-button"
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
      {(!online || status.unavailable) && status.lastSaved && (
        <small>
          Tasks cached {new Date(status.lastSaved).toLocaleString()}
        </small>
      )}
      {error && <p role="alert">{error}</p>}
      {status.conflicts.map((item) => (
        <div className="form-error" role="alert" key={item.id}>
          <strong>Task conflict: {item.title}</strong>
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
            <p>
              {item.error === 'VERSION_CONFLICT'
                ? 'Server record changed.'
                : item.error === 'NOT_FOUND'
                  ? 'Server record deleted.'
                  : 'Request rejected.'}
            </p>
          </details>
          <button
            className="text-button"
            onClick={() => {
              if (window.confirm('Discard all queued changes for this task?'))
                void discardTask(item.id).then(
                  () => sync(),
                  () => setError('Could not discard changes.'),
                );
            }}
          >
            Discard local changes
          </button>
        </div>
      ))}
    </section>
  );
}
