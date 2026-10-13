import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { taskResponseSchema, tasksResponseSchema } from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import {
  useMutation,
  useOfflineStatus,
  useResource,
  useToday,
} from '../lib/hooks';
import type { OfflineStatus } from '../lib/hooks';
import { offlineStatus } from '../lib/offline';
import { taskFilterLabels, taskFilters } from '../lib/router';
import type { Route, TaskFilter } from '../lib/router';
import {
  countByFilter,
  groupTasks,
  matchesFilter,
  maxSelection,
} from '../lib/tasks';
import { useConfirm } from './ConfirmDialog';
import { DeletedItems } from './DeletedItems';
import { Help } from './Help';
import { Link } from './Link';
import { AcademicSource, PlannerSource } from './PlannerSource';
import { QuickCapture } from './QuickCapture';
import { ReadState } from './ReadState';
import { StatusChip } from './StatusChip';
import { TaskBatchBar } from './TaskBatch';
import { formatDate } from '../lib/format';
import './TasksView.css';

type TasksRoute = Extract<Route, { name: 'tasks' }>;
type Reload = () => Promise<{ data: { tasks: Task[] } } | undefined>;
type Notice = {
  text: string;
  undo?: { id: string; version: number; title: string };
};

const emptyMessages: Record<TaskFilter, string> = {
  open: 'No open tasks.',
  'due-soon': 'Nothing due in the next 7 days.',
  overdue: 'No overdue tasks.',
  'no-date': 'No open tasks without a date.',
  done: 'No completed tasks.',
};

export function TasksView({
  route,
  navigate,
}: {
  route: TasksRoute;
  navigate: (route: Route) => void;
}) {
  const filter = route.filter ?? 'open';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = useToday(timeZone);
  const tasks = useResource(
    (signal) => getSnapshot('/api/v1/tasks', tasksResponseSchema, signal),
    { failure: 'Tasks unavailable. Retry tasks.' },
  );
  const status = useOfflineStatus();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deletedKey, setDeletedKey] = useState(0);
  const [dialog, confirm] = useConfirm();
  const remove = useMutation();
  const restore = useMutation();
  const heading = useRef<HTMLHeadingElement>(null);
  const [selecting, setSelecting] = useState(false);
  // A selection belongs to the filter it was made in, so hidden tasks are
  // never changed by a later filter's action.
  const [selection, setSelection] = useState<{
    filter: TaskFilter;
    items: Map<string, number>;
  }>({ filter, items: new Map() });
  const selected =
    selection.filter === filter ? selection.items : new Map<string, number>();

  // Reload when the outbox content changes (not on every status event), so a
  // conflict that stays queued cannot start a request loop.
  const reload: Reload = tasks.reload;
  const outbox = status
    ? JSON.stringify([
        status.pending,
        status.queued,
        status.conflicts.map((item) => [item.id, item.error]),
      ])
    : null;
  const previousOutbox = useRef<string | null>(null);
  useEffect(() => {
    if (outbox === null || previousOutbox.current === outbox) return;
    const first = previousOutbox.current === null;
    previousOutbox.current = outbox;
    if (!first) void reload();
  }, [outbox, reload]);

  const all = tasks.data?.data.tasks ?? [];
  const counts = countByFilter(all, today);
  const visible = all.filter((task) => matchesFilter(task, filter, today));
  const groups = groupTasks(visible, filter, today);
  // Tasks with queued or conflicting offline edits are changed through sync.
  const selectable = (task: Task) =>
    !status?.queued.includes(task.id) &&
    !status?.conflicts.some((item) => item.id === task.id);
  const select = (items: Map<string, number>) =>
    setSelection({ filter, items });
  function toggleSelected(task: Task) {
    const items = new Map(selected);
    if (items.has(task.id)) items.delete(task.id);
    else items.set(task.id, task.version);
    select(items);
  }
  async function batchApplied(text: string) {
    setNotice({ text });
    setSelecting(false);
    select(new Map());
    const fresh = await reload();
    if (route.id && !fresh?.data.tasks.some((task) => task.id === route.id))
      navigate(listRoute);
    setDeletedKey((value) => value + 1);
    heading.current?.focus();
  }
  const listRoute: TasksRoute = {
    name: 'tasks',
    ...(route.filter ? { filter: route.filter } : {}),
  };

  async function deleteTask(task: Task) {
    setNotice(null);
    if (!navigator.onLine) {
      const confirmed = await confirm({
        title: `Delete task “${task.title}”?`,
        message:
          'You are offline. The deletion is queued and cannot be undone until it syncs.',
        confirmLabel: 'Delete task',
      });
      if (!confirmed) return;
    }
    const result = await remove.run(
      taskResponseSchema,
      'DELETE',
      `/api/v1/tasks/${task.id}`,
      { expectedVersion: task.version },
      'Could not delete. The task is unchanged.',
    );
    if (!result) return;
    // Undo exists only for deletions the server has confirmed.
    const state = await offlineStatus().catch(() => null);
    setNotice(
      state?.queued.includes(task.id)
        ? { text: `Deletion of “${task.title}” queued for sync.` }
        : {
            text: `Deleted “${task.title}”.`,
            undo: {
              id: task.id,
              version: result.task.version,
              title: task.title,
            },
          },
    );
    if (route.id === task.id) navigate(listRoute);
    await reload();
    setDeletedKey((value) => value + 1);
  }

  async function undoDelete(undo: NonNullable<Notice['undo']>) {
    const result = await restore.run(
      taskResponseSchema,
      'POST',
      `/api/v1/tasks/${undo.id}/restore`,
      { expectedVersion: undo.version },
      'Could not undo. Check the connection and try again.',
    );
    if (!result) return;
    setNotice({
      text: `Restored “${undo.title}”. Reminders cancelled by the deletion stay cancelled.`,
    });
    await reload();
    setDeletedKey((value) => value + 1);
  }

  return (
    <section className="tasks-view" aria-label="Tasks">
      <QuickCapture onSaved={reload} />
      <div className="tasks-notice" role="status">
        {notice && <p>{notice.text}</p>}
        {notice?.undo && (
          <button
            type="button"
            className="secondary-button"
            disabled={restore.pending}
            onClick={() => {
              void undoDelete(notice.undo!);
            }}
          >
            Undo
          </button>
        )}
      </div>
      {(remove.error || restore.error) && (
        <p role="alert" className="form-error">
          {remove.error || restore.error}
        </p>
      )}
      <nav aria-label="Task filters">
        <ul className="tasks-filters">
          {taskFilters.map((value) => (
            <li key={value}>
              <Link
                route={{
                  name: 'tasks',
                  ...(value === 'open' ? {} : { filter: value }),
                }}
                navigate={navigate}
                current={value === filter}
              >
                {taskFilterLabels[value]}
                {tasks.data && (
                  <>
                    <span aria-hidden="true">{counts[value]}</span>
                    <span className="visually-hidden">
                      , {counts[value]} tasks
                    </span>
                  </>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div
        className={`tasks-layout ${route.id ? 'tasks-layout--editing' : ''}`}
      >
        <section
          className="panel tasks-list-pane"
          aria-labelledby="task-list-title"
        >
          <div className="tasks-list-pane__header">
            <h2 id="task-list-title" ref={heading} tabIndex={-1}>
              {taskFilterLabels[filter]}
              {tasks.data ? ` (${visible.length})` : ''}
            </h2>
            {visible.length > 0 && (
              <button
                type="button"
                className="secondary-button"
                aria-pressed={selecting}
                onClick={() => {
                  setSelecting(!selecting);
                  select(new Map());
                }}
              >
                Select
              </button>
            )}
          </div>
          {selecting && (
            <TaskBatchBar
              selection={selected}
              visible={groups.flatMap((group) => group.tasks)}
              latest={async () => (await reload())?.data.tasks}
              selectable={selectable}
              onSelect={select}
              onApplied={batchApplied}
            />
          )}
          <ReadState resource={tasks} label="tasks" />
          {tasks.data && !visible.length && <p>{emptyMessages[filter]}</p>}
          {groups.map((group) => (
            <section
              key={group.id}
              className="task-group"
              aria-labelledby={`task-group-${group.id}`}
            >
              <h3
                id={`task-group-${group.id}`}
                className={groups.length > 1 ? undefined : 'visually-hidden'}
              >
                {group.label}
              </h3>
              <ul className="task-list">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    status={status}
                    current={route.id === task.id}
                    listRoute={listRoute}
                    navigate={navigate}
                    onChanged={reload}
                    onRemoved={() => heading.current?.focus()}
                    selection={
                      selecting
                        ? {
                            selected: selected.has(task.id),
                            available:
                              selectable(task) &&
                              (selected.has(task.id) ||
                                selected.size < maxSelection),
                            toggle: () => toggleSelected(task),
                          }
                        : null
                    }
                  />
                ))}
              </ul>
            </section>
          ))}
        </section>
        {route.id && (
          <TaskEditor
            key={route.id}
            id={route.id}
            tasks={all}
            loaded={!!tasks.data}
            status={status}
            listRoute={listRoute}
            navigate={navigate}
            reload={reload}
            onDelete={deleteTask}
            deleting={remove.pending}
          />
        )}
      </div>
      <DeletedItems kind="task" refreshKey={deletedKey} onRestored={reload} />
      {dialog}
    </section>
  );
}

function TaskRow({
  task,
  status,
  current,
  listRoute,
  navigate,
  onChanged,
  onRemoved,
  selection,
}: {
  task: Task;
  status: OfflineStatus | null;
  current: boolean;
  listRoute: TasksRoute;
  navigate: (route: Route) => void;
  onChanged: () => Promise<unknown>;
  onRemoved: () => void;
  /** Present while choosing tasks for a selected change. */
  selection: {
    selected: boolean;
    available: boolean;
    toggle: () => void;
  } | null;
}) {
  const toggle = useMutation();
  const checkbox = useRef<HTMLInputElement>(null);
  const queued = status?.queued.includes(task.id) ?? false;
  const conflict = status?.conflicts.some((item) => item.id === task.id);
  async function complete() {
    const result = await toggle.run(
      taskResponseSchema,
      'PUT',
      `/api/v1/tasks/${task.id}`,
      {
        title: task.title,
        notes: task.notes,
        dueDate: task.dueDate,
        priority: task.priority,
        sensitivity: task.sensitivity,
        completed: !task.completed,
        expectedVersion: task.version,
      },
      'Could not update the task. It is unchanged.',
    );
    if (!result) return;
    await onChanged();
    // The row leaves this filter after completion; keep keyboard focus nearby.
    if (!checkbox.current?.isConnected) onRemoved();
  }
  return (
    <li
      className={`task-row ${task.completed ? 'task-row--done' : ''}`}
      aria-current={current ? 'true' : undefined}
    >
      {selection ? (
        <input
          type="checkbox"
          aria-label={`Select ${task.title}`}
          checked={selection.selected}
          disabled={!selection.available}
          onChange={selection.toggle}
        />
      ) : (
        <input
          ref={checkbox}
          type="checkbox"
          aria-label={`Complete ${task.title}`}
          checked={task.completed}
          disabled={toggle.pending}
          onChange={() => {
            void complete();
          }}
        />
      )}
      <div className="task-row__body">
        <Link
          className="task-row__title"
          route={{ ...listRoute, id: task.id }}
          navigate={navigate}
        >
          {task.title}
        </Link>
        <div className="task-row__meta">
          {task.dueDate && <span>Due {formatDate(task.dueDate)}</span>}
          {task.priority === 'high' && (
            <StatusChip tone="attention">High priority</StatusChip>
          )}
          {task.sensitivity !== 'unlabeled' && (
            <StatusChip>
              {task.sensitivity === 'personal' ? 'Personal' : 'Restricted'}
            </StatusChip>
          )}
          {task.canvasSource && <StatusChip>Canvas</StatusChip>}
          {task.academicSource && <StatusChip>Class work</StatusChip>}
          {conflict ? (
            <StatusChip tone="danger">Conflict</StatusChip>
          ) : queued ? (
            <StatusChip tone="attention">
              {status?.locked ? 'Locked' : 'Queued'}
            </StatusChip>
          ) : null}
        </div>
      </div>
      {toggle.error && (
        <p role="alert" className="form-error task-row__error">
          {toggle.error}
        </p>
      )}
    </li>
  );
}

type Draft = {
  title: string;
  notes: string;
  dueDate: string;
  priority: Task['priority'];
  sensitivity: Task['sensitivity'];
  completed: boolean;
};
const toDraft = (task: Task): Draft => ({
  title: task.title,
  notes: task.notes,
  dueDate: task.dueDate ?? '',
  priority: task.priority,
  sensitivity: task.sensitivity,
  completed: task.completed,
});
const fieldLabels: Record<keyof Draft, string> = {
  title: 'Title',
  notes: 'Notes',
  dueDate: 'Due date',
  priority: 'Priority',
  sensitivity: 'Content label',
  completed: 'Completed',
};
const display = (value: Draft[keyof Draft]) =>
  value === true ? 'Yes' : value === false ? 'No' : value || 'None';

function TaskEditor({
  id,
  tasks,
  loaded,
  status,
  listRoute,
  navigate,
  reload,
  onDelete,
  deleting,
}: {
  id: string;
  tasks: Task[];
  loaded: boolean;
  status: OfflineStatus | null;
  listRoute: TasksRoute;
  navigate: (route: Route) => void;
  reload: Reload;
  onDelete: (task: Task) => Promise<void>;
  deleting: boolean;
}) {
  const latest = tasks.find((task) => task.id === id);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The version the draft was made from. Only an explicit load or this
  // editor's own save moves it, so newer server data is never adopted silently.
  const [base, setBase] = useState(0);
  const [server, setServer] = useState<Task | null>(null);
  const [message, setMessage] = useState('');
  const [titleError, setTitleError] = useState('');
  const [loading, setLoading] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  const save = useMutation();
  if (latest && !draft) {
    setDraft(toDraft(latest));
    setBase(latest.version);
  }
  if (!draft)
    return (
      <section className="panel task-editor" aria-label="Task editor">
        <BackLink route={listRoute} navigate={navigate} always />
        {loaded ? (
          <p>This task is not available. It may have been deleted.</p>
        ) : (
          <p role="status">Loading…</p>
        )}
      </section>
    );
  const queuedConflict = status?.conflicts.some((item) => item.id === id);
  const deletedElsewhere = loaded && !latest;
  const changedElsewhere =
    !!latest && (latest.version !== base || save.conflict);
  const blocked = queuedConflict || deletedElsewhere || changedElsewhere;
  const current = toDraft(server ?? latest ?? ({} as Task));
  const differences = server
    ? (Object.keys(fieldLabels) as (keyof Draft)[]).filter(
        (field) => current[field] !== draft[field],
      )
    : [];
  const update = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft({ ...draft, [field]: value });
    setMessage('');
    if (field === 'title') setTitleError('');
  };

  async function loadLatest() {
    setLoading(true);
    const result = await reload();
    setLoading(false);
    const fresh = result?.data.tasks.find((task) => task.id === id);
    if (!fresh) return;
    setBase(fresh.version);
    setServer(fresh);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || blocked) return;
    if (!draft.title.trim()) {
      setTitleError('Enter a title');
      title.current?.focus();
      return;
    }
    const result = await save.run(
      taskResponseSchema,
      'PUT',
      `/api/v1/tasks/${id}`,
      {
        title: draft.title,
        notes: draft.notes,
        dueDate: draft.dueDate || null,
        priority: draft.priority,
        sensitivity: draft.sensitivity,
        completed: draft.completed,
        expectedVersion: base,
      },
    );
    if (!result) return;
    setServer(null);
    const state = await offlineStatus().catch(() => null);
    setMessage(
      state?.queued.includes(id) ? 'Changes queued for sync.' : 'Saved.',
    );
    // Our own save just completed, so the refreshed version is ours to adopt.
    const fresh = (await reload())?.data.tasks.find((task) => task.id === id);
    setBase(fresh?.version ?? result.task.version);
  }

  return (
    <section className="panel task-editor" aria-labelledby="task-editor-title">
      <BackLink route={listRoute} navigate={navigate} />
      <h2 id="task-editor-title">Edit task</h2>
      {queuedConflict && (
        <p role="alert" className="form-error">
          This task has a sync conflict. Resolve it in the conflict banner
          before editing.
        </p>
      )}
      {deletedElsewhere && (
        <p role="alert" className="form-error">
          This task was deleted elsewhere. Your edits are still here but cannot
          be saved.
        </p>
      )}
      {changedElsewhere && !queuedConflict && (
        <div role="alert" className="form-error">
          <p>Changed elsewhere. Your edits are still here.</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              void loadLatest();
            }}
          >
            {loading ? 'Loading…' : 'Load latest version'}
          </button>
        </div>
      )}
      {server && differences.length > 0 && (
        <details open>
          <summary>Differences from the latest version</summary>
          <dl className="task-compare">
            {differences.map((field) => (
              <div key={field}>
                <dt>{fieldLabels[field]}</dt>
                <dd>Latest: {display(current[field])}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <form
        className="editor-form"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Title
          <input
            ref={title}
            value={draft.title}
            maxLength={200}
            aria-invalid={!!titleError}
            aria-describedby={titleError ? 'task-title-error' : undefined}
            onChange={(event) => update('title', event.target.value)}
          />
        </label>
        {titleError && (
          <p id="task-title-error" className="form-error">
            <span className="visually-hidden">Error: </span>
            {titleError}
          </p>
        )}
        <label>
          Notes (optional)
          <textarea
            rows={4}
            maxLength={10000}
            value={draft.notes}
            onChange={(event) => update('notes', event.target.value)}
          />
        </label>
        <label>
          Due date (optional)
          <input
            type="date"
            value={draft.dueDate}
            onChange={(event) => update('dueDate', event.target.value)}
          />
        </label>
        <label>
          Priority
          <select
            value={draft.priority}
            onChange={(event) =>
              update('priority', event.target.value as Task['priority'])
            }
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          Content label
          <select
            value={draft.sensitivity}
            onChange={(event) =>
              update('sensitivity', event.target.value as Task['sensitivity'])
            }
          >
            <option value="unlabeled">Unlabeled</option>
            <option value="personal">Personal</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
        <Help label="Content label">
          Labels you apply limit which AI providers may use this task. Labels
          inherited from a class or source stay applied.
        </Help>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.completed}
            onChange={(event) => update('completed', event.target.checked)}
          />
          Completed
        </label>
        {save.error && !changedElsewhere && (
          <p role="alert" className="form-error">
            {save.error}
          </p>
        )}
        <p role="status">{message}</p>
        <div className="form-actions">
          <button className="primary-button" disabled={save.pending || blocked}>
            {save.pending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
      {latest && (
        <>
          <PlannerSource source={latest.canvasSource} />
          <AcademicSource source={latest.academicSource} />
          <div className="task-editor__danger">
            <button
              type="button"
              className="danger-button"
              disabled={deleting || save.pending}
              onClick={() => {
                void onDelete(latest);
              }}
            >
              Delete task
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Wide screens keep the list beside the editor, so the link only shows there
 *  when there is no list to return to (`always`). */
function BackLink({
  route,
  navigate,
  always = false,
}: {
  route: TasksRoute;
  navigate: (route: Route) => void;
  always?: boolean;
}) {
  return (
    <Link
      className={`task-editor__back ${always ? 'task-editor__back--always' : ''}`}
      route={route}
      navigate={navigate}
    >
      Back to tasks
    </Link>
  );
}
