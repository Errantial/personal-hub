import { useState } from 'react';
import type { FormEvent } from 'react';
import { taskBatchResponseSchema } from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { useMutation, useOnline } from '../lib/hooks';
import { batchBody, maxSelection, refreshSelection } from '../lib/tasks';
import type { BatchChange, TaskSelection } from '../lib/tasks';
import { useConfirm } from './ConfirmDialog';

type ChangeKind = BatchChange['kind'];
const changeLabels: Record<ChangeKind, string> = {
  complete: 'Mark done',
  reopen: 'Mark not done',
  priority: 'Set priority',
  due: 'Set due date',
  'clear-due': 'Clear due date',
  delete: 'Delete',
};
const plural = (count: number) => `${count} task${count === 1 ? '' : 's'}`;

/**
 * Applies one change to explicitly selected tasks in a single atomic,
 * online-only request (see docs/task-management.md). Nothing is applied if
 * any selected task changed elsewhere; the selection is kept for review.
 */
export function TaskBatchBar({
  selection,
  visible,
  latest,
  selectable,
  onSelect,
  onApplied,
}: {
  selection: TaskSelection;
  /** Tasks shown in the current filter, in display order. */
  visible: readonly Task[];
  /** Reloads the task list and returns the latest tasks. */
  latest: () => Promise<readonly Task[] | undefined>;
  selectable: (task: Task) => boolean;
  onSelect: (selection: Map<string, number>) => void;
  onApplied: (message: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<ChangeKind>('complete');
  const [priority, setPriority] = useState<Task['priority']>('high');
  const [dueDate, setDueDate] = useState('');
  const [dateError, setDateError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const batch = useMutation();
  const online = useOnline();
  const [dialog, confirm] = useConfirm();
  const count = selection.size;
  const candidates = visible.filter(selectable).slice(0, maxSelection);
  const allSelected =
    candidates.length > 0 && candidates.every((task) => selection.has(task.id));
  const stale = batch.code === 'VERSION_CONFLICT' || batch.code === 'NOT_FOUND';

  function change(): BatchChange {
    if (kind === 'priority') return { kind, priority };
    if (kind === 'due') return { kind, dueDate };
    return { kind } as BatchChange;
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!count || !online) return;
    if (kind === 'due' && !dueDate) {
      setDateError('Choose a date');
      return;
    }
    if (
      kind === 'delete' &&
      !(await confirm({
        title: `Delete ${plural(count)}?`,
        message:
          'Restore them one at a time from Recently deleted. Reminders cancelled by the deletion stay cancelled.',
        confirmLabel: `Delete ${plural(count)}`,
      }))
    )
      return;
    const result = await batch.run(
      taskBatchResponseSchema,
      'POST',
      '/api/v1/tasks/batch',
      batchBody(selection, change()),
      'Could not apply the change. Nothing was changed; try again.',
    );
    if (!result) return;
    await onApplied(
      kind === 'delete'
        ? `Deleted ${plural(result.tasks.length)}. Restore from Recently deleted.`
        : `${changeLabels[kind]}: ${plural(result.tasks.length)} updated.`,
    );
  }

  /** Deliberate review after a conflict: adopt the latest versions. */
  async function reviewLatest() {
    setRefreshing(true);
    const tasks = await latest();
    setRefreshing(false);
    if (!tasks) return;
    batch.reset();
    onSelect(refreshSelection(selection, tasks, selectable));
  }

  return (
    <section className="task-batch" aria-label="Selected tasks">
      <div className="task-batch__row">
        <p role="status">
          {count ? `${plural(count)} selected` : 'None selected'}
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={batch.pending || !candidates.length}
          onClick={() =>
            onSelect(
              allSelected
                ? new Map()
                : new Map(candidates.map((task) => [task.id, task.version])),
            )
          }
        >
          {allSelected
            ? 'Clear selection'
            : `Select shown (${candidates.length})`}
        </button>
      </div>
      <form
        className="task-batch__row"
        noValidate
        onSubmit={(event) => {
          void apply(event);
        }}
      >
        <label>
          Change
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as ChangeKind);
              setDateError('');
            }}
          >
            {(Object.keys(changeLabels) as ChangeKind[]).map((value) => (
              <option key={value} value={value}>
                {changeLabels[value]}
              </option>
            ))}
          </select>
        </label>
        {kind === 'priority' && (
          <label>
            Priority
            <select
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as Task['priority'])
              }
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </label>
        )}
        {kind === 'due' && (
          <label>
            Due date
            <input
              type="date"
              value={dueDate}
              aria-invalid={!!dateError}
              aria-describedby={dateError ? 'task-batch-date-error' : undefined}
              onChange={(event) => {
                setDueDate(event.target.value);
                setDateError('');
              }}
            />
          </label>
        )}
        <button
          className={kind === 'delete' ? 'danger-button' : 'primary-button'}
          disabled={!count || !online || batch.pending || refreshing}
        >
          {batch.pending ? 'Applying…' : `Apply to ${plural(count)}`}
        </button>
      </form>
      {dateError && (
        <p id="task-batch-date-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {dateError}
        </p>
      )}
      {!online && (
        <p className="form-error">Selected changes need a connection.</p>
      )}
      {batch.error && (
        <div role="alert" className="form-error">
          <p>
            {stale
              ? 'A selected task changed or was deleted elsewhere. Nothing was changed.'
              : batch.error}
          </p>
          {stale && (
            <button
              type="button"
              className="secondary-button"
              disabled={refreshing}
              onClick={() => {
                void reviewLatest();
              }}
            >
              {refreshing ? 'Loading…' : 'Review latest versions'}
            </button>
          )}
        </div>
      )}
      {dialog}
    </section>
  );
}
