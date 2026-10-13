/* Explicit selections for batch changes. A selection maps record IDs to the
   versions seen when they were selected, in selection order, so a change
   made elsewhere afterwards makes the whole batch conflict instead of being
   overwritten. */

export const maxSelection = 100;
export type Selection = ReadonlyMap<string, number>;
type Versioned = { id: string; version: number };

/** Request items for a batch endpoint. */
export const selectionItems = (selection: Selection) =>
  [...selection].map(([id, expectedVersion]) => ({ id, expectedVersion }));

/** A deliberate refresh after a conflict: keeps selected records that are
 *  still listed and selectable, at their latest versions. */
export function refreshSelection<T extends Versioned>(
  selection: Selection,
  records: readonly T[],
  selectable: (record: T) => boolean,
): Map<string, number> {
  const latest = new Map(records.map((record) => [record.id, record]));
  const next = new Map<string, number>();
  for (const id of selection.keys()) {
    const record = latest.get(id);
    if (record && selectable(record)) next.set(id, record.version);
  }
  return next;
}
