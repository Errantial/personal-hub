import { useCallback, useEffect, useState } from 'react';
import {
  academicWorkListSchema,
  academicWorkResponseSchema,
  calendarResponseSchema,
  deletedPlannerResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { useMutation } from '../lib/hooks';
import { Help } from './Help';
import { formatInstant } from '../lib/format';
import './DeletedItems.css';

const limit = 20;

type Kind = 'task' | 'calendar' | 'work';
type Item = {
  id: string;
  title: string;
  version: number;
  deletedAt?: string | null;
};

/* Wording and endpoints that differ between deletable record kinds. */
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
  work: {
    noun: 'work item',
    nouns: 'work items',
    path: 'academic-work',
    help: 'Restoring work keeps its notes, score and labels. Reminders cancelled by the deletion stay cancelled. Restoring needs a connection.',
    note: ' Reminders cancelled by the deletion stay cancelled.',
  },
} as const;

/** Deleted records, newest first, restorable while online. Opening the section
 *  loads the first page; deleted records are never cached for offline use. */
export function DeletedItems({
  kind,
  courseId,
  refreshKey,
  onRestored,
}: {
  kind: Kind;
  /** Required for work: deleted work is listed per class. */
  courseId?: string;
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
          courseId={courseId}
          refreshKey={refreshKey}
          onRestored={onRestored}
        />
      )}
    </details>
  );
}

function DeletedList({
  kind,
  courseId,
  refreshKey,
  onRestored,
}: {
  kind: Kind;
  courseId: string | undefined;
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
        const query = new URLSearchParams({ limit: String(limit) });
        if (before) query.set('before', before);
        let page: { records: Item[]; nextBefore: string | null };
        if (kind === 'work') {
          query.set('courseId', courseId ?? '');
          query.set('deleted', 'true');
          const result = await requestJson(
            `/api/v1/academic-work?${query}`,
            academicWorkListSchema,
          );
          page = { records: result.work, nextBefore: result.nextBefore };
        } else {
          query.set('kind', kind);
          const result = await requestJson(
            `/api/v1/planner/deleted?${query}`,
            deletedPlannerResponseSchema,
          );
          page = {
            records: kind === 'task' ? result.tasks : result.events,
            nextBefore: result.nextBefore,
          };
        }
        const { records } = page;
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
    [kind, courseId, words.nouns],
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
        : kind === 'work'
          ? (
              await restore.run(
                academicWorkResponseSchema,
                'POST',
                path,
                body,
                failure,
              )
            )?.work.title
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
                  <small> · Deleted {formatInstant(item.deletedAt)}</small>
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
