import { Help } from './Help';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  remindersSchema,
  notificationsSchema,
  reminderResponseSchema,
  notificationResponseSchema,
  tasksResponseSchema,
  calendarListSchema,
  wallTimeToInstant,
  instantToWall,
} from '@hub/contracts';
import type {
  Reminder,
  HubNotification,
  Task,
  CalendarRecord,
} from '@hub/contracts';
import { getJson, requestJson } from '../lib/api';

export function ReminderWorkspace() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notifications, setNotifications] = useState<HubNotification[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<CalendarRecord[]>([]);
  const [worker, setWorker] = useState({
    healthy: false,
    lastTick: null as string | null,
    errorCode: null as string | null,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [revision, setRevision] = useState(0);
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission,
  );
  const pending = useRef<{ key: string; id: string } | null>(null);
  const observed = useRef(new Set<string>());
  const initialized = useRef(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  async function load(signal?: AbortSignal, refreshEditor = false) {
    const [jobs, inbox, steps, calendar] = await Promise.all([
      getJson('/api/v1/reminders', remindersSchema, signal),
      getJson('/api/v1/notifications', notificationsSchema, signal),
      getJson('/api/v1/tasks', tasksResponseSchema, signal),
      getJson('/api/v1/calendar', calendarListSchema, signal),
    ]);
    setReminders(jobs.reminders);
    setWorker(jobs.worker);
    setNotifications(inbox.notifications);
    setTasks(steps.tasks);
    setEvents(calendar.events);
    if (refreshEditor)
      setEditing((old) => {
        const latest = jobs.reminders.find((value) => value.id === old?.id);
        return old && latest ? { ...old, version: latest.version } : old;
      });
    for (const item of inbox.notifications) {
      if (
        initialized.current &&
        !observed.current.has(item.id) &&
        !item.readAt &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          new Notification('Personal Hub reminder', {
            body: 'A reminder is ready in your hub.',
            tag: item.id,
          });
        } catch {
          /* Inbox remains the durable delivery channel. */
        }
      }
      observed.current.add(item.id);
    }
    initialized.current = true;
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void load(controller.signal).catch(() => {
        if (!controller.signal.aborted)
          setError('Could not refresh reminders. Reload to try again.');
      });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);
  async function change(
    path: string,
    body: Record<string, unknown>,
    method = 'POST',
  ) {
    const key = JSON.stringify({ path, body, method });
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    await requestJson(path, reminderResponseSchema, {
      method,
      body: { ...body, operationId: pending.current.id },
    });
    pending.current = null;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const target = String(form.get('target'));
      const [targetKind, targetId] = target ? target.split(':') : [];
      await change(
        editing ? `/api/v1/reminders/${editing.id}` : '/api/v1/reminders',
        {
          title: String(form.get('title')),
          scheduledAt: wallTimeToInstant(
            String(form.get('scheduledAt')),
            timeZone,
            String(form.get('offset')) as 'reject' | 'earlier' | 'later',
          ),
          targetKind: targetKind ?? null,
          targetId: targetId ?? null,
          occurrenceDate: form.get('occurrenceDate')
            ? String(form.get('occurrenceDate'))
            : null,
          ...(editing ? { expectedVersion: editing.version } : {}),
        },
        editing ? 'PUT' : 'POST',
      );
      setEditing(null);
      setRevision((value) => value + 1);
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not save reminder.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function control(item: Reminder, action: string) {
    setBusy(true);
    setError('');
    try {
      await change(`/api/v1/reminders/${item.id}/control`, {
        action,
        expectedVersion: item.version,
      });
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not change reminder.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function read(item: HubNotification) {
    setBusy(true);
    setError('');
    try {
      await requestJson(
        `/api/v1/notifications/${item.id}/read`,
        notificationResponseSchema,
        { method: 'POST', body: { operationId: crypto.randomUUID() } },
      );
      await load();
    } catch {
      setError('Could not mark the reminder as read.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Reminders workspace">
      <div className="panel planner-panel">
        <h2>Reminder delivery</h2>
        <p role="status">
          {worker.healthy
            ? 'Reminder worker is running.'
            : worker.errorCode
              ? 'Reminder worker reported a failure.'
              : 'Reminder worker has not checked in recently.'}
        </p>
        <Help label="Reminders">
          Server-side reminders are saved to this inbox while the page is
          closed. Browser alerts work while this view is open and permission is
          granted; closed-page push and Android native notifications are not
          implemented.
        </Help>
        <div className="form-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setError('');
              void load(undefined, true).catch(() =>
                setError('Could not reload reminders.'),
              );
            }}
          >
            Reload reminders
          </button>
          <button
            className="secondary-button"
            disabled={permission === 'unsupported'}
            onClick={() => {
              void Notification.requestPermission().then(
                (value) => setPermission(value),
                () =>
                  setError(
                    'Browser notification permission could not be requested.',
                  ),
              );
            }}
          >
            Enable browser alerts
          </button>
        </div>
        <p>
          Browser notification permission: {permission}.{' '}
          {permission === 'denied'
            ? 'Change this site’s notification setting in your browser; the inbox still works.'
            : ''}
        </p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="academic-grid">
        <section className="panel planner-panel" aria-label="Reminder inbox">
          <h2>Inbox</h2>
          {notifications.length === 0 && <p>No reminders</p>}
          <ul className="planner-list">
            {notifications.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <small>{new Date(item.createdAt).toLocaleString()}</small>
                  <p>{item.readAt ? 'Read' : 'Unread'}</p>
                </div>
                {!item.readAt && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      void read(item);
                    }}
                  >
                    Mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="panel planner-panel">
          <h2>Scheduled reminders</h2>
          <ul className="planner-list">
            {reminders.map((item) => (
              <li key={item.id}>
                <div className="planner-item-content">
                  <strong>{item.title}</strong>
                  <small>{new Date(item.scheduledAt).toLocaleString()}</small>
                  <p>
                    Status: {item.status} · attempts: {item.attempts}
                  </p>
                  {item.lastError && <p>Last failure: {item.lastError}</p>}
                </div>
                <div className="item-actions">
                  {['queued', 'paused', 'failed'].includes(item.status) && (
                    <button
                      className="text-button"
                      disabled={busy}
                      aria-label={`Reschedule ${item.title}`}
                      onClick={() => setEditing(item)}
                    >
                      Reschedule
                    </button>
                  )}
                  {['queued', 'running'].includes(item.status) && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        void control(item, 'pause');
                      }}
                    >
                      Pause
                    </button>
                  )}
                  {item.status === 'paused' && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        void control(item, 'resume');
                      }}
                    >
                      Resume
                    </button>
                  )}
                  {item.status === 'failed' && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        void control(item, 'retry');
                      }}
                    >
                      Retry
                    </button>
                  )}
                  {!['delivered', 'cancelled'].includes(item.status) && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        void control(item, 'cancel');
                      }}
                    >
                      Cancel reminder
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <form
            key={`${editing?.id ?? 'new'}:${revision}`}
            className="editor-form"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <h3>{editing ? 'Reschedule reminder' : 'Add reminder'}</h3>
            <label>
              Reminder title
              <input
                name="title"
                required
                maxLength={200}
                defaultValue={editing?.title ?? ''}
              />
            </label>
            <label>
              Remind at
              <input
                name="scheduledAt"
                type="datetime-local"
                required
                defaultValue={
                  editing ? instantToWall(editing.scheduledAt, timeZone) : ''
                }
              />
            </label>
            <Help label="Reminders">
              Time uses this device's timezone ({timeZone}). Past times deliver
              on the next worker tick.
            </Help>
            <label>
              Reminder repeated-time offset
              <select name="offset" defaultValue="reject">
                <option value="reject">Require a choice if ambiguous</option>
                <option value="earlier">Earlier offset</option>
                <option value="later">Later offset</option>
              </select>
            </label>
            <label>
              Linked item
              <select
                name="target"
                defaultValue={
                  editing?.targetKind
                    ? `${editing.targetKind}:${editing.targetId}`
                    : ''
                }
              >
                <option value="">Standalone reminder</option>
                {tasks
                  .filter((item) => !item.completed)
                  .map((item) => (
                    <option key={item.id} value={`task:${item.id}`}>
                      Task: {item.title}
                    </option>
                  ))}
                {events
                  .filter((item) => item.studyStatus === 'planned')
                  .map((item) => (
                    <option key={item.id} value={`event:${item.id}`}>
                      Event: {item.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Original occurrence date (only for an event)
              <input
                name="occurrenceDate"
                type="date"
                defaultValue={editing?.occurrenceDate ?? ''}
              />
            </label>
            <div className="form-actions">
              <button className="primary-button" disabled={busy}>
                {editing ? 'Save reminder changes' : 'Add reminder'}
              </button>
              {editing && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditing(null)}
                >
                  Cancel reschedule
                </button>
              )}
            </div>
          </form>
        </section>
      </div>
    </section>
  );
}
