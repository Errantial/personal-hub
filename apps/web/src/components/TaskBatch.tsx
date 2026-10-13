import { useState } from 'react';
import type { FormEvent } from 'react';
import { taskBatchResponseSchema } from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { useMutation, useOnline } from '../lib/hooks';
import type { Selection } from '../lib/selection';
import { batchBody } from '../lib/tasks';
import type { BatchChange } from '../lib/tasks';
import { useConfirm } from './ConfirmDialog';
import { SelectionBar, countOf } from './SelectionBar';

type ChangeKind = BatchChange['kind'];
const changeLabels: Record<ChangeKind, string> = {
  complete: 'Mark done',
  reopen: 'Mark not done',
  priority: 'Set priority',
  due: 'Set due date',
  'clear-due': 'Clear due date',
  delete: 'Delete',
};
const plural = (count: number) => countOf(count, 'task');

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
  selection: Selection;
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
  const batch = useMutation();
  const online = useOnline();
  const [dialog, confirm] = useConfirm();
  const count = selection.size;

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

  return (
    <SelectionBar
      label="Selected tasks"
      noun="task"
      selection={selection}
      visible={visible}
      selectable={selectable}
      latest={latest}
      onSelect={onSelect}
      batch={batch}
    >
      <form
        className="batch-bar__row"
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
          disabled={!count || !online || batch.pending}
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
      {dialog}
    </SelectionBar>
  );
}
