import { useEffect, useState } from 'react';
import { canvasItemsResponseSchema } from '@hub/contracts';
import type { CanvasItem } from '@hub/contracts';
import { getJson } from '../lib/api';
import { CanvasEntry } from './CanvasEntry';
import { Help } from './Help';
import { formatInstant } from '../lib/format';

export function ClassCanvasEntries({ courseId }: { courseId: string }) {
  const [items, setItems] = useState<CanvasItem[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [lastImported, setLastImported] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void getJson(
      `/api/v1/connections/canvas/items?${new URLSearchParams({ courseId })}`,
      canvasItemsResponseSchema,
      abort.signal,
    ).then(
      (result) => {
        if (!abort.signal.aborted) {
          setItems(result.items);
          setLastImported(result.lastImportedAt);
          setError('');
        }
      },
      () => {
        if (!abort.signal.aborted)
          setError('Could not load linked Canvas entries.');
      },
    );
    return () => abort.abort();
  }, [courseId, revision]);
  return (
    <section aria-label="Class Canvas entries">
      <h3>Canvas entries</h3>
      <Help label="Class Canvas entries">
        Link entries to a class in Connections. Feed data is read-only and does
        not change topic progress or grades. Missing/cancelled entries remain
        visible. Cached entries reflect the last loaded snapshot and import
        time.
      </Help>
      {error && <p role="alert">{error}</p>}
      <button
        className="text-button"
        onClick={() => setRevision((value) => value + 1)}
      >
        Reload class Canvas entries
      </button>
      <p className="meta">
        Last import: {lastImported ? formatInstant(lastImported) : 'Never'}
      </p>
      {items.map((item) => (
        <CanvasEntry
          key={item.id}
          item={item}
          timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          showDate
        />
      ))}
      {!items.length && !error && <p>No linked entries.</p>}
    </section>
  );
}
