import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  tasksResponseSchema,
  eventsResponseSchema,
  taskResponseSchema,
  eventResponseSchema,
} from '@hub/contracts';
import type { Task, CalendarEvent } from '@hub/contracts';
import { getJson, requestJson } from '../lib/api';

type Item = Task | CalendarEvent;
type Kind = 'tasks' | 'events';
function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function PlannerBoard() {
  return (
    <div className="planner-grid">
      <PlannerPanel kind="tasks" />
      <PlannerPanel kind="events" />
    </div>
  );
}
function PlannerPanel({ kind }: { kind: Kind }) {
  const [items, setItems] = useState<Item[]>([]);
  const [editing, setEditing] = useState<Item | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const pending = useRef<{ key: string; operationId: string } | null>(null);
  const base = `/api/v1/${kind}`;
  const isTask = kind === 'tasks';
  async function load(signal?: AbortSignal) {
    const data = isTask
      ? await getJson(base, tasksResponseSchema, signal)
      : await getJson(base, eventsResponseSchema, signal);
    const latest = 'tasks' in data ? data.tasks : data.events;
    setItems(latest);
    setLoaded(true);
    setEditing((previous) => {
      const current = latest.find((item) => item.id === previous?.id);
      return previous && current
        ? { ...previous, version: current.version }
        : previous;
    });
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        setError('Could not load your planner. Reload the list to try again.');
    });
    return () => controller.abort();
    // Each panel has a fixed kind for its lifetime.
  }, []);
  async function change(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ) {
    const key = JSON.stringify({ method, path, body });
    if (pending.current?.key !== key)
      pending.current = { key, operationId: crypto.randomUUID() };
    const input = { ...body, operationId: pending.current.operationId };
    if (isTask)
      await requestJson(path, taskResponseSchema, { method, body: input });
    else await requestJson(path, eventResponseSchema, { method, body: input });
    pending.current = null;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const common = {
        title: String(form.get('title')),
        notes: String(form.get('notes')),
        sensitivity: String(form.get('sensitivity')),
      };
      const body = isTask
        ? {
            ...common,
            dueDate: form.get('dueDate') || null,
            priority: form.get('priority'),
            completed:
              editing && 'completed' in editing ? editing.completed : false,
          }
        : {
            ...common,
            startsAt: new Date(String(form.get('startsAt'))).toISOString(),
            endsAt: new Date(String(form.get('endsAt'))).toISOString(),
            timeZone: String(form.get('timeZone')),
          };
      await change(
        editing ? 'PUT' : 'POST',
        editing ? `${base}/${editing.id}` : base,
        { ...body, ...(editing ? { expectedVersion: editing.version } : {}) },
      );
      setEditing(null);
      formRef.current?.reset();
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not save. Your form is still here.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function act(item: Item, remove = false) {
    setBusy(true);
    setError('');
    if (!remove && 'completed' in item)
      setItems((previous) =>
        previous.map((current) =>
          current.id === item.id
            ? { ...item, completed: !item.completed }
            : current,
        ),
      );
    try {
      const body = remove
        ? { expectedVersion: item.version }
        : 'completed' in item
          ? {
              title: item.title,
              notes: item.notes,
              dueDate: item.dueDate,
              priority: item.priority,
              sensitivity: item.sensitivity,
              completed: !item.completed,
              expectedVersion: item.version,
            }
          : {};
      await change(remove ? 'DELETE' : 'PUT', `${base}/${item.id}`, body);
      if (editing?.id === item.id) setEditing(null);
      await load();
    } catch (failure) {
      if (!remove && 'completed' in item)
        setItems((previous) =>
          previous.map((current) => (current.id === item.id ? item : current)),
        );
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not update. Reload to try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel planner-panel" aria-labelledby={`${kind}-title`}>
      <div className="panel-heading">
        <h2 id={`${kind}-title`}>
          {isTask ? 'Your next steps' : 'On your schedule'}
        </h2>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setError('');
            void load().catch(() => setError('Could not reload. Try again.'));
          }}
        >
          Reload list
        </button>
      </div>
      <p className="muted-note">
        {isTask
          ? 'Tasks saved to your hub.'
          : 'One-time events in your hub calendar.'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <p role="status">Loading…</p>
      ) : items.length === 0 ? (
        <p className="planner-empty">
          {isTask
            ? 'No tasks yet. Start with one next step.'
            : 'No events yet. Reserve some time below.'}
        </p>
      ) : (
        <ul className="planner-list">
          {items.map((item) => (
            <li key={item.id}>
              <div className="planner-item-content">
                {'completed' in item ? (
                  <label
                    className={`task-check ${item.completed ? 'completed' : ''}`}
                  >
                    <input
                      aria-label={`Complete ${item.title}`}
                      type="checkbox"
                      checked={item.completed}
                      disabled={busy}
                      onChange={() => {
                        void act(item);
                      }}
                    />
                    <strong>{item.title}</strong>
                  </label>
                ) : (
                  <strong>{item.title}</strong>
                )}
                <small>
                  {'dueDate' in item
                    ? `${item.dueDate ? `Due ${item.dueDate} · ` : ''}${item.priority} priority`
                    : `${new Date(item.startsAt).toLocaleString(undefined, { timeZone: item.timeZone })} – ${new Date(item.endsAt).toLocaleString(undefined, { timeZone: item.timeZone })} (${item.timeZone})`}
                </small>
                {item.notes && <p className="item-notes">{item.notes}</p>}
                {item.sensitivity !== 'unlabeled' && (
                  <span className="item-label">{item.sensitivity}</span>
                )}
              </div>
              <div className="item-actions">
                <button
                  className="text-button"
                  aria-label={`Edit ${item.title}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing(item);
                    setError('');
                  }}
                >
                  Edit
                </button>
                <button
                  className="text-button"
                  aria-label={`Delete ${item.title}`}
                  disabled={busy}
                  onClick={() => {
                    void act(item, true);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        ref={formRef}
        key={editing?.id ?? 'new'}
        className="editor-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <h3>
          {editing ? 'Edit' : 'Add'} {isTask ? 'task' : 'event'}
        </h3>
        <label>
          {isTask ? 'Task title' : 'Event title'}
          <input
            name="title"
            required
            maxLength={200}
            defaultValue={editing?.title ?? ''}
          />
        </label>
        <label>
          Notes
          <textarea
            name="notes"
            rows={2}
            maxLength={10000}
            defaultValue={editing?.notes ?? ''}
          />
        </label>
        {isTask ? (
          <div className="form-row">
            <label>
              Due date
              <input
                name="dueDate"
                type="date"
                defaultValue={
                  editing && 'dueDate' in editing ? (editing.dueDate ?? '') : ''
                }
              />
            </label>
            <label>
              Priority
              <select
                name="priority"
                defaultValue={
                  editing && 'priority' in editing ? editing.priority : 'normal'
                }
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
        ) : (
          <>
            <label>
              Starts
              <input
                name="startsAt"
                type="datetime-local"
                required
                defaultValue={
                  editing && 'startsAt' in editing
                    ? localDateTime(editing.startsAt)
                    : ''
                }
              />
            </label>
            <label>
              Ends
              <input
                name="endsAt"
                type="datetime-local"
                required
                defaultValue={
                  editing && 'endsAt' in editing
                    ? localDateTime(editing.endsAt)
                    : ''
                }
              />
            </label>
            <p className="muted-note">
              Enter times in this device's timezone (
              {Intl.DateTimeFormat().resolvedOptions().timeZone}).
            </p>
            <label>
              Display timezone
              <input
                name="timeZone"
                required
                maxLength={100}
                defaultValue={
                  editing && 'timeZone' in editing
                    ? editing.timeZone
                    : Intl.DateTimeFormat().resolvedOptions().timeZone
                }
              />
            </label>
          </>
        )}
        <label>
          Content label
          <select
            name="sensitivity"
            defaultValue={editing?.sensitivity ?? 'unlabeled'}
          >
            <option value="unlabeled">Unlabeled</option>
            <option value="personal">Personal</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
        <div className="form-actions">
          <button className="primary-button" disabled={busy || !loaded}>
            {busy
              ? 'Saving…'
              : editing
                ? 'Save changes'
                : isTask
                  ? 'Add task'
                  : 'Add event'}
          </button>
          {editing && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setEditing(null)}
              disabled={busy}
            >
              Cancel edit
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
