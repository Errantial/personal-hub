import { useState } from 'react';
import type { FormEvent } from 'react';
import { calendarBatchResponseSchema } from '@hub/contracts';
import type { CalendarRecord } from '@hub/contracts';
import { calendarBatchBody, studyStatusAllowed } from '../lib/calendar';
import type { CalendarChange } from '../lib/calendar';
import { useMutation, useOnline } from '../lib/hooks';
import type { Selection } from '../lib/selection';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { SelectionBar, countOf } from './SelectionBar';

type ChangeKind = 'completed' | 'planned' | 'cancelled' | 'delete';
const changeLabels: Record<ChangeKind, string> = {
  completed: 'Mark study done',
  planned: 'Mark study planned',
  cancelled: 'Cancel study',
  delete: 'Delete',
};
const plural = (count: number) => countOf(count, 'event');

/**
 * Applies one change to explicitly selected calendar records in a single
 * atomic, online-only request (see docs/calendar-management.md). Deletion
 * removes whole records, including every occurrence of a repeating series.
 */
export function CalendarBatchBar({
  selection,
  visible,
  latest,
  onSelect,
  onApplied,
}: {
  selection: Selection;
  /** Records with an occurrence in the shown range, in display order. */
  visible: readonly CalendarRecord[];
  /** Reloads calendar records and returns the latest versions. */
  latest: () => Promise<readonly CalendarRecord[] | undefined>;
  onSelect: (selection: Map<string, number>) => void;
  onApplied: (message: string, deleted: readonly string[]) => Promise<void>;
}) {
  const [kind, setKind] = useState<ChangeKind>('completed');
  const batch = useMutation();
  const online = useOnline();
  const [dialog, confirm] = useConfirm();
  const count = selection.size;
  const byId = new Map(visible.map((record) => [record.id, record]));
  const chosen = [...selection.keys()].flatMap((id) => byId.get(id) ?? []);
  const series = chosen.filter((record) => record.recurrence).length;
  const notStudy = chosen.filter(
    (record) => !studyStatusAllowed(record),
  ).length;
  const blocked = kind !== 'delete' && notStudy > 0;

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!count || !online || blocked) return;
    if (
      kind === 'delete' &&
      !(await confirm({
        title: `Delete ${plural(count)}?`,
        message: `${
          series
            ? `Includes ${series} repeating series: every occurrence is deleted. `
            : ''
        }Restore them one at a time from Recently deleted. No invitations or cancellation emails are sent.`,
        confirmLabel: `Delete ${plural(count)}`,
      }))
    )
      return;
    const change: CalendarChange =
      kind === 'delete'
        ? { kind: 'delete' }
        : { kind: 'study-status', status: kind };
    const result = await batch.run(
      calendarBatchResponseSchema,
      'POST',
      '/api/v1/calendar/batch',
      calendarBatchBody(selection, change),
      'Could not apply the change. Nothing was changed; try again.',
    );
    if (!result) return;
    await onApplied(
      kind === 'delete'
        ? `Deleted ${plural(result.events.length)}. Restore from Recently deleted.`
        : `${changeLabels[kind]}: ${plural(result.events.length)} updated.`,
      kind === 'delete' ? result.events.map((record) => record.id) : [],
    );
  }

  return (
    <SelectionBar
      label="Selected events"
      noun="event"
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
              batch.reset();
            }}
          >
            {(Object.keys(changeLabels) as ChangeKind[]).map((value) => (
              <option key={value} value={value}>
                {changeLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <Help label="Selected changes">
          Study status applies to one-time timed study blocks; change a
          repeating block one occurrence at a time in its editor. Delete removes
          whole events, including every occurrence of a repeating series.
        </Help>
        <button
          className={kind === 'delete' ? 'danger-button' : 'primary-button'}
          disabled={!count || !online || blocked || batch.pending}
        >
          {batch.pending ? 'Applying…' : `Apply to ${plural(count)}`}
        </button>
      </form>
      {blocked && (
        <p className="form-error">
          {countOf(notStudy, 'selected event')} {notStudy === 1 ? 'is' : 'are'}{' '}
          not a one-time timed study block.
        </p>
      )}
      {kind === 'delete' && series > 0 && (
        <p className="calendar-warning">
          {series} repeating series selected: every occurrence is deleted.
        </p>
      )}
      {dialog}
    </SelectionBar>
  );
}
