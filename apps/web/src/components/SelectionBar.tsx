import { useState } from 'react';
import type { ReactNode } from 'react';
import type { useMutation } from '../lib/hooks';
import { useOnline } from '../lib/hooks';
import { maxSelection, refreshSelection } from '../lib/selection';
import type { Selection } from '../lib/selection';

type Versioned = { id: string; version: number };

/** "1 task", "3 tasks". */
export const countOf = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Shared frame for selected changes: selection count, Select shown / Clear,
 * the offline notice, and the failure state. Batches are atomic and
 * online-only; a change elsewhere fails the whole batch, and the owner must
 * deliberately review the latest versions before applying again.
 * `children` holds the change controls and Apply button.
 */
export function SelectionBar<T extends Versioned>({
  label,
  noun,
  selection,
  visible,
  selectable,
  latest,
  onSelect,
  batch,
  children,
}: {
  label: string;
  noun: string;
  selection: Selection;
  /** Records shown in the current view, in display order. */
  visible: readonly T[];
  selectable: (record: T) => boolean;
  /** Reloads the records and returns the latest versions. */
  latest: () => Promise<readonly T[] | undefined>;
  onSelect: (selection: Map<string, number>) => void;
  batch: ReturnType<typeof useMutation>;
  children: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const online = useOnline();
  const count = selection.size;
  const candidates = visible.filter(selectable).slice(0, maxSelection);
  const allSelected =
    candidates.length > 0 && candidates.every((item) => selection.has(item.id));
  const stale = batch.code === 'VERSION_CONFLICT' || batch.code === 'NOT_FOUND';

  async function reviewLatest() {
    setRefreshing(true);
    const records = await latest();
    setRefreshing(false);
    if (!records) return;
    batch.reset();
    onSelect(refreshSelection(selection, records, selectable));
  }

  return (
    <section className="batch-bar" aria-label={label}>
      <div className="batch-bar__row">
        <p role="status">
          {count ? `${countOf(count, noun)} selected` : 'None selected'}
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={batch.pending || !candidates.length}
          onClick={() =>
            onSelect(
              allSelected
                ? new Map()
                : new Map(candidates.map((item) => [item.id, item.version])),
            )
          }
        >
          {allSelected
            ? 'Clear selection'
            : `Select shown (${candidates.length})`}
        </button>
      </div>
      {/* Changes wait until a review has loaded the latest versions. */}
      <fieldset className="batch-bar__fields" disabled={refreshing}>
        {children}
      </fieldset>
      {!online && (
        <p className="form-error">Selected changes need a connection.</p>
      )}
      {batch.error && (
        <div role="alert" className="form-error">
          <p>
            {stale
              ? `A selected ${noun} changed or was deleted elsewhere. Nothing was changed.`
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
    </section>
  );
}
