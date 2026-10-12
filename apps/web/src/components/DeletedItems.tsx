import { useCallback, useEffect, useState } from 'react';
import {
  calendarResponseSchema,
  deletedPlannerResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { useMutation } from '../lib/hooks';
import { Help } from './Help';
import './DeletedItems.css';

const limit = 20;

type Kind = 'task' | 'calendar';
type Item = {
  id: string;
  title: string;
  version: number;
  deletedAt?: string | null;
};

/* Wording and endpoints that differ between the two deletable record kinds. */
const kinds = {
  task: {
    noun: 'task',
    nouns: 'tasks',
    path: 'tasks',
    help: 'Restoring a task keeps its notes, labels and sources. Reminders that were cancelled when it was deleted are not restarted. Restoring needs a connection.',
    note: ' Reminders cancelled by the deletion stay cancelled.',
  },
  calendar: {
    noun: 'event',
    nouns: 'events',
    path: 'calendar',
    help: 'Restoring an event brings back its whole series, notes, labels and sources. Restoring needs a connection.',
    note: '',
  },
} as const;

/** Deleted records, newest first, restorable while online. Opening the section
 *  loads the first page; deleted records are never cached for offline use. */
export function DeletedItems({
  kind,
  refreshKey,
  onRestored,
}: {
  kind: Kind;
  refreshKey: number;
  onRestored: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="panel deleted-items"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Recently deleted</summary>
      {open && (
        <DeletedList
          kind={kind}
          refreshKey={refreshKey}
          onRestored={onRestored}
        />
      )}
    </details>
  );
}

function DeletedList({
  kind,
  refreshKey,
  onRestored,
}: {
  kind: Kind;
  refreshKey: number;
  onRestored: () => Promise<unknown>;
}) {
  const words = kinds[kind];
  const [items, setItems] = useState<Item[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const restore = useMutation();

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams({ kind, limit: String(limit) });
        if (before) query.set('before', before);
        const page = await requestJson(
          `/api/v1/planner/deleted?${query}`,
          deletedPlannerResponseSchema,
        );
        const records: Item[] = kind === 'task' ? page.tasks : page.events;
        setItems((previous) =>
          before ? [...(previous ?? []), ...records] : records,
        );
        setNext(page.nextBefore);
      } catch {
        setError(
          `Deleted ${words.nouns} need a connection. Try again when online.`,
        );
      } finally {
        setLoading(false);
      }
    },
    [kind, words.nouns],
  );
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function restoreItem(item: Item) {
    setMessage('');
    const body = { expectedVersion: item.version };
    const failure = 'Could not restore. Check the connection and try again.';
    const path = `/api/v1/${words.path}/${item.id}/restore`;
    const title =
      kind === 'task'
        ? (await restore.run(taskResponseSchema, 'POST', path, body, failure))
            ?.task.title
        : (
            await restore.run(
              calendarResponseSchema,
              'POST',
              path,
              body,
              failure,
            )
          )?.event.title;
    if (title === undefined) return;
    setMessage(`Restored “${title}”.${words.note}`);
    await Promise.all([load(), onRestored()]);
  }

  return (
    <div>
      <Help label="Recently deleted">{words.help}</Help>
      {error && <p role="alert">{error}</p>}
      {restore.error && <p role="alert">{restore.error}</p>}
      <p role="status">{message}</p>
      {loading && !items && <p role="status">Loading…</p>}
      {items && items.length === 0 && <p>No deleted {words.nouns}.</p>}
      {!!items?.length && (
        <ul className="deleted-items__list">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                {item.title}
                {item.deletedAt && (
                  <small>
                    {' '}
                    · Deleted {new Date(item.deletedAt).toLocaleString()}
                  </small>
                )}
              </span>
              <button
                type="button"
                className="secondary-button"
                aria-label={`Restore ${item.title}`}
                disabled={restore.pending}
                onClick={() => {
                  void restoreItem(item);
                }}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => {
            void load(next);
          }}
        >
          Load more
        </button>
      )}
    </div>
  );
}
