import { Help } from './Help';
import { useRef, useState } from 'react';
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
import type { Reminder, HubNotification } from '@hub/contracts';
import { getJson } from '../lib/api';
import { useMutation, useResource } from '../lib/hooks';

export function ReminderWorkspace() {
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [revision, setRevision] = useState(0);
  const [permissionError, setPermissionError] = useState('');
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission,
  );
  const observed = useRef(new Set<string>());
  const initialized = useRef(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = useMutation();
  const control = useMutation();
  const read = useMutation();
  const resource = useResource(
    async (signal) => {
      const [jobs, inbox, steps, calendar] = await Promise.all([
        getJson('/api/v1/reminders', remindersSchema, signal),
        getJson('/api/v1/notifications', notificationsSchema, signal),
        getJson('/api/v1/tasks', tasksResponseSchema, signal),
        getJson('/api/v1/calendar', calendarListSchema, signal),
      ]);
      alertNew(inbox.notifications);
      return { jobs, inbox, tasks: steps.tasks, events: calendar.events };
    },
    {
      failure: 'Could not refresh reminders. Reload to try again.',
      refreshMs: 10000,
    },
  );
  const reminders = resource.data?.jobs.reminders ?? [];
  const worker = resource.data?.jobs.worker ?? {
    healthy: false,
    lastTick: null,
    errorCode: null,
  };
  const notifications = resource.data?.inbox.notifications ?? [];
  const tasks = resource.data?.tasks ?? [];
  const events = resource.data?.events ?? [];
  const busy = save.pending || control.pending || read.pending;
  const error =
    save.error ||
    control.error ||
    read.error ||
    permissionError ||
    resource.error;

  function alertNew(items: HubNotification[]) {
    for (const item of items) {
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
  async function reloadEditor() {
    const latest = await resource.reload();
    if (!latest) {
      resource.setError('Could not reload reminders.');
      return;
    }
    setEditing((old) => {
      const current = latest.jobs.reminders.find(
        (value) => value.id === old?.id,
      );
      return old && current ? { ...old, version: current.version } : old;
    });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let scheduledAt: string;
    try {
      scheduledAt = wallTimeToInstant(
        String(form.get('scheduledAt')),
        timeZone,
        String(form.get('offset')) as 'reject' | 'earlier' | 'later',
      );
    } catch (failure) {
      save.setError(
        failure instanceof Error ? failure.message : 'Could not save reminder.',
      );
      return;
    }
    const target = String(form.get('target'));
    const [targetKind, targetId] = target ? target.split(':') : [];
    const saved = await save.run(
      reminderResponseSchema,
      editing ? 'PUT' : 'POST',
      editing ? `/api/v1/reminders/${editing.id}` : '/api/v1/reminders',
      {
        title: String(form.get('title')),
        scheduledAt,
        targetKind: targetKind ?? null,
        targetId: targetId ?? null,
        occurrenceDate: form.get('occurrenceDate')
          ? String(form.get('occurrenceDate'))
          : null,
        ...(editing ? { expectedVersion: editing.version } : {}),
      },
      'Could not save reminder.',
    );
    if (!saved) return;
    setEditing(null);
    setRevision((value) => value + 1);
    await resource.reload();
  }
  async function change(item: Reminder, action: string) {
    const changed = await control.run(
      reminderResponseSchema,
      'POST',
      `/api/v1/reminders/${item.id}/control`,
      { action, expectedVersion: item.version },
      'Could not change reminder.',
    );
    if (changed) await resource.reload();
  }
  async function markRead(item: HubNotification) {
    const done = await read.run(
      notificationResponseSchema,
      'POST',
      `/api/v1/notifications/${item.id}/read`,
      {},
      'Could not mark the reminder as read.',
    );
    if (done) await resource.reload();
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
              void reloadEditor();
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
                  setPermissionError(
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
                      void markRead(item);
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
                        void change(item, 'pause');
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
                        void change(item, 'resume');
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
                        void change(item, 'retry');
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
                        void change(item, 'cancel');
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
