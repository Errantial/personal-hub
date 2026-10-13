import { useState } from 'react';
import type { FormEvent } from 'react';
import { academicWorkBatchResponseSchema } from '@hub/contracts';
import type { AcademicWork } from '@hub/contracts';
import { priorityLabel, workBatchBody, workStatusLabels } from '../lib/classes';
import type { WorkChange } from '../lib/classes';
import { useMutation, useOnline } from '../lib/hooks';
import type { Selection } from '../lib/selection';
import { useConfirm } from './ConfirmDialog';
import { SelectionBar, countOf } from './SelectionBar';

type ChangeKind =
  | 'status'
  | 'priority'
  | 'due'
  | 'clear-due'
  | 'estimate'
  | 'clear-estimate'
  | 'delete';
const changeLabels: Record<ChangeKind, string> = {
  status: 'Set status',
  priority: 'Set priority',
  due: 'Set deadline',
  'clear-due': 'Clear deadline',
  estimate: 'Set estimate',
  'clear-estimate': 'Clear estimate',
  delete: 'Delete',
};
const plural = (count: number) => countOf(count, 'work item');

/**
 * Applies one change to explicitly selected academic work in a single
 * atomic, online-only request (see docs/academic-management.md). Titles,
 * notes, labels and scores are never batch-changed; reopening or cancelling
 * scored work is refused for the whole selection.
 */
export function WorkBatchBar({
  selection,
  visible,
  courseVersion,
  latest,
  onSelect,
  onApplied,
}: {
  selection: Selection;
  /** Work shown in the current filter, in display order. */
  visible: readonly AcademicWork[];
  /** Class version the list was read with. */
  courseVersion: number;
  /** Reloads the list and returns the latest work. */
  latest: () => Promise<readonly AcademicWork[] | undefined>;
  onSelect: (selection: Map<string, number>) => void;
  onApplied: (message: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<ChangeKind>('status');
  const [status, setStatus] = useState<AcademicWork['status']>('submitted');
  const [priority, setPriority] = useState(3);
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  const [inputError, setInputError] = useState('');
  const batch = useMutation();
  const online = useOnline();
  const [dialog, confirm] = useConfirm();
  const count = selection.size;

  /** The requested change, or an error message for missing input. */
  function change(): WorkChange | string {
    switch (kind) {
      case 'status':
        return { kind, status };
      case 'priority':
        return { kind, priority };
      case 'due':
        return dueDate ? { kind, dueDate } : 'Choose a date';
      case 'clear-due':
        return { kind: 'due', dueDate: null };
      case 'estimate': {
        const minutes = Number(estimate);
        return estimate.trim() &&
          Number.isInteger(minutes) &&
          minutes >= 0 &&
          minutes <= 60000
          ? { kind, estimatedMinutes: minutes }
          : 'Enter whole minutes from 0 to 60000';
      }
      case 'clear-estimate':
        return { kind: 'estimate', estimatedMinutes: null };
      case 'delete':
        return { kind };
    }
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!count || !online) return;
    const requested = change();
    if (typeof requested === 'string') {
      setInputError(requested);
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
      academicWorkBatchResponseSchema,
      'POST',
      '/api/v1/academic-work/batch',
      workBatchBody(selection, courseVersion, requested),
      'Could not apply the change. Nothing was changed; try again.',
    );
    if (!result) return;
    await onApplied(
      kind === 'delete'
        ? `Deleted ${plural(result.work.length)}. Restore from Recently deleted.`
        : `${changeLabels[kind]}: ${plural(result.work.length)} updated.`,
    );
  }

  return (
    <SelectionBar
      label="Selected work"
      noun="work item"
      selection={selection}
      visible={visible}
      selectable={() => true}
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
              setInputError('');
            }}
          >
            {(Object.keys(changeLabels) as ChangeKind[]).map((value) => (
              <option key={value} value={value}>
                {changeLabels[value]}
              </option>
            ))}
          </select>
        </label>
        {kind === 'status' && (
          <label>
            Status
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as AcademicWork['status'])
              }
            >
              {Object.entries(workStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'priority' && (
          <label>
            Priority
            <select
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value))}
            >
              {[5, 4, 3, 2, 1].map((value) => (
                <option key={value} value={value}>
                  {priorityLabel(value)}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'due' && (
          <label>
            Deadline
            <input
              type="date"
              value={dueDate}
              aria-invalid={!!inputError}
              aria-describedby={inputError ? 'work-batch-error' : undefined}
              onChange={(event) => {
                setDueDate(event.target.value);
                setInputError('');
              }}
            />
          </label>
        )}
        {kind === 'estimate' && (
          <label>
            Estimate (minutes)
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={60000}
              value={estimate}
              aria-invalid={!!inputError}
              aria-describedby={inputError ? 'work-batch-error' : undefined}
              onChange={(event) => {
                setEstimate(event.target.value);
                setInputError('');
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
      {inputError && (
        <p id="work-batch-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {inputError}
        </p>
      )}
      {dialog}
    </SelectionBar>
  );
}
