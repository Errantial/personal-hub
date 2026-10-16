import { useState } from 'react';
import { memoryPageSchema } from '@hub/contracts';
import type { MemoryPage } from '@hub/contracts';
import { liveRequestJson } from '../lib/api';
import { Help } from './Help';

type MemorySummary = MemoryPage['memories'][number];
export type MemorySelection = {
  id: string;
  version: number;
  settingsVersion: number;
  title: string;
  kind: MemorySummary['kind'];
};

export function AssistantMemoryPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: MemorySelection[];
  onChange: (items: MemorySelection[]) => void;
  disabled: boolean;
}) {
  const [page, setPage] = useState<MemoryPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(next = false) {
    setBusy(true);
    setError('');
    const query = new URLSearchParams({ state: 'active', limit: '50' });
    const cursor = next ? page?.nextAfter : null;
    if (cursor) {
      query.set('after', cursor.id);
      query.set('expectedCursorVersion', String(cursor.version));
    }
    try {
      setPage(
        await liveRequestJson(`/api/v1/memory?${query}`, memoryPageSchema),
      );
    } catch {
      setError(
        'Memory items could not be loaded. Reload the list to try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="assistant__memory">
      <summary>Memory context ({selected.length}/10)</summary>
      <Help label="Memory context">
        Select personal memory items for this ask only. Allowlisted title, kind,
        content and observation date may be sent. Labels can withhold selected
        items. Changed or forgotten items or disabled memory block the ask;
        remove and select the item again after reloading. Earlier eligible
        answers may still be sent as conversation history.
      </Help>
      <fieldset disabled={disabled || busy}>
        <legend className="visually-hidden">Memory context</legend>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load()}
        >
          Reload memory items
        </button>
        {page && !page.settings.enabled && (
          <p role="alert" className="form-error">
            Memory is disabled in settings. Enabling memory in Settings &gt;
            Memory is required to include memory items.
          </p>
        )}
        {!!selected.length && (
          <ul aria-label="Selected memory items">
            {selected.map((item) => (
              <li key={item.id}>
                {item.title} ({item.kind}){' '}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    onChange(selected.filter((value) => value.id !== item.id))
                  }
                >
                  Remove {item.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        {page && (
          <p className="meta">
            {page.counts.active} active memory items. Showing{' '}
            {page.memories.length} on this page.
          </p>
        )}
        {page?.memories.map((item) => (
          <label className="checkbox-label" key={item.id}>
            <input
              type="checkbox"
              checked={selected.some((value) => value.id === item.id)}
              disabled={
                selected.length >= 10 &&
                !selected.some((value) => value.id === item.id)
              }
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [
                        ...selected,
                        {
                          id: item.id,
                          version: item.version,
                          settingsVersion: page.settings.version,
                          title: item.title ?? 'Untitled memory',
                          kind: item.kind,
                        },
                      ]
                    : selected.filter((value) => value.id !== item.id),
                )
              }
            />
            {item.title} ({item.kind})
            {item.observedOn ? ` - Observed ${item.observedOn}` : ''}
          </label>
        ))}
        {page?.nextAfter && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void load(true)}
          >
            Next memory page
          </button>
        )}
      </fieldset>
      {busy && <p role="status">Loading memory items...</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </details>
  );
}
