import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  memoryMutationResponseSchema,
  memoryPageSchema,
  memoryResponseSchema,
  memorySettingsSchema,
} from '@hub/contracts';
import type { Memory } from '@hub/contracts';
import type { z } from 'zod';
import { RequestError, getJson } from '../lib/api';
import { formatDate } from '../lib/format';
import { useMutation } from '../lib/hooks';
import { ChangedElsewhere, LabelSelect } from './ClassForms';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { StatusChip } from './StatusChip';

type Page = z.infer<typeof memoryPageSchema>;
type State = 'active' | 'disabled' | 'forgotten' | 'all';
type Kind = Memory['kind'];
type Filters = { state: State; kind: Kind | ''; q: string };

const stateLabels: Record<State, string> = {
  active: 'Active',
  disabled: 'Disabled',
  forgotten: 'Forgotten',
  all: 'All',
};
const kindLabels: Record<Kind, string> = {
  preference: 'Preference',
  goal: 'Goal',
  fact: 'Fact',
};
const labelText = { personal: 'Personal', restricted: 'Restricted' } as const;

/**
 * Settings › Memory: owner-entered preferences, goals and facts. Storage
 * only; nothing here is sent to AI. Online only.
 */
export function MemorySettings() {
  const [filters, setFilters] = useState<Filters>({
    state: 'active',
    kind: '',
    q: '',
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);

  const load = useCallback(
    async (after?: Page['nextAfter']) => {
      const current = ++generation.current;
      setLoading(true);
      setError('');
      const query = new URLSearchParams({ state: filters.state, limit: '25' });
      if (filters.kind) query.set('kind', filters.kind);
      if (filters.q) query.set('q', filters.q);
      if (after) {
        query.set('after', after.id);
        query.set('expectedCursorVersion', String(after.version));
      }
      try {
        const result = await getJson(
          `/api/v1/memory?${query}`,
          memoryPageSchema,
        );
        if (current !== generation.current) return;
        setPage((previous) =>
          after && previous
            ? {
                ...result,
                memories: [...previous.memories, ...result.memories],
              }
            : result,
        );
      } catch (caught) {
        if (current !== generation.current) return;
        setError(
          after &&
            caught instanceof RequestError &&
            ['VERSION_CONFLICT', 'NOT_FOUND'].includes(caught.code)
            ? 'The list changed. Reload to see the latest.'
            : 'Memory needs a connection. Reload to try again.',
        );
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const counts = page?.counts;
  const saved = (text: string) => {
    setNotice(text);
    setEditing(null);
    void load();
  };

  return (
    <section
      className="panel preference-panel memory-settings"
      aria-labelledby="memory-title"
    >
      <h2 id="memory-title">Memory</h2>
      <Help label="Memory">
        Preferences, goals and facts you write down yourself. Nothing here is
        sent to AI, and a goal here does not change study goals. Labels limit
        which AI providers could use a memory later.
      </Help>
      {page && (
        <MemorySwitch
          key={page.settings.version}
          settings={page.settings}
          onSaved={() => void load()}
        />
      )}
      <form
        className="memory-filters"
        aria-label="Memory filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...filters, q: search.trim() });
        }}
      >
        <label>
          Show
          <select
            value={filters.state}
            onChange={(event) =>
              setFilters({ ...filters, state: event.target.value as State })
            }
          >
            {(Object.keys(stateLabels) as State[]).map((state) => (
              <option key={state} value={state}>
                {stateLabels[state]}
                {counts && state !== 'all' ? ` (${counts[state]})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select
            value={filters.kind}
            onChange={(event) =>
              setFilters({ ...filters, kind: event.target.value as Kind | '' })
            }
          >
            <option value="">All types</option>
            {(Object.keys(kindLabels) as Kind[]).map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            maxLength={100}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button className="secondary-button">Search</button>
      </form>
      <p role="status">{notice}</p>
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              void load();
            }}
          >
            Reload memory
          </button>
        </div>
      )}
      {loading && !page && <p role="status">Loading…</p>}
      {page && !page.memories.length && (
        <p>{filters.q ? 'No memories match.' : 'No memories here.'}</p>
      )}
      <ul className="memory-list">
        {(page?.memories ?? []).map((item) => (
          <li key={item.id}>
            <div className="memory-list__body">
              <strong>{item.title ?? 'Forgotten memory'}</strong>
              <div className="memory-list__meta">
                <span>{kindLabels[item.kind]}</span>
                {item.observedOn && (
                  <span>Noted {formatDate(item.observedOn)}</span>
                )}
                {item.deletedAt ? (
                  <StatusChip>Forgotten</StatusChip>
                ) : (
                  !item.enabled && <StatusChip>Disabled</StatusChip>
                )}
                {item.sensitivity !== 'unlabeled' && (
                  <StatusChip>{labelText[item.sensitivity]}</StatusChip>
                )}
              </div>
            </div>
            {!item.deletedAt && (
              <button
                type="button"
                className="secondary-button"
                aria-label={`Edit ${item.title}`}
                onClick={() => {
                  setNotice('');
                  setEditing(item.id);
                }}
              >
                Edit
              </button>
            )}
          </li>
        ))}
      </ul>
      {page?.nextAfter && (
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => {
            void load(page.nextAfter);
          }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
      {editing === null ? (
        <button
          type="button"
          className="primary-button memory-add"
          onClick={() => {
            setNotice('');
            setEditing('new');
          }}
        >
          Add memory
        </button>
      ) : (
        <MemoryEditor
          key={editing}
          id={editing === 'new' ? null : editing}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** The global storage switch; it never sends memory to AI. */
function MemorySwitch({
  settings,
  onSaved,
}: {
  settings: Page['settings'];
  onSaved: () => void;
}) {
  const save = useMutation();
  return (
    <div className="memory-switch">
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={save.pending}
          onChange={(event) => {
            void save
              .run(
                memorySettingsSchema,
                'PUT',
                '/api/v1/memory/settings',
                {
                  enabled: event.target.checked,
                  expectedVersion: settings.version,
                },
                'Could not change memory. Try again.',
              )
              .then((result) => {
                if (result) onSaved();
              });
          }}
        />
        Use memory
      </label>
      <Help label="Use memory">
        Off by default. Turning it on does not start AI use; memories are not
        used by AI yet. Turning it off keeps your memories.
      </Help>
      {save.error && (
        <div role="alert" className="form-error">
          <p>{save.error}</p>
          {save.conflict && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                save.reset();
                onSaved();
              }}
            >
              Reload memory
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Draft = {
  kind: Kind;
  title: string;
  content: string;
  observedOn: string;
  enabled: boolean;
  sensitivity: Memory['sensitivity'];
};
const emptyDraft: Draft = {
  kind: 'preference',
  title: '',
  content: '',
  observedOn: '',
  enabled: true,
  sensitivity: 'unlabeled',
};
const toDraft = (memory: Memory): Draft => ({
  kind: memory.kind,
  title: memory.title ?? '',
  content: memory.content ?? '',
  observedOn: memory.observedOn ?? '',
  enabled: memory.enabled,
  sensitivity: memory.sensitivity,
});

/** Adds a memory, or edits and forgets one (loaded in full for editing). */
function MemoryEditor({
  id,
  onSaved,
  onCancel,
}: {
  id: string | null;
  onSaved: (notice: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(id ? null : emptyDraft);
  const [base, setBase] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [fieldError, setFieldError] = useState<{
    field: 'title' | 'content';
    message: string;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  const save = useMutation();
  const forget = useMutation();
  const [dialog, confirm] = useConfirm();

  const fetchLatest = useCallback(async () => {
    if (!id) return undefined;
    try {
      return (await getJson(`/api/v1/memory/${id}`, memoryResponseSchema))
        .memory;
    } catch {
      setLoadError('This memory needs a connection to edit. Try again.');
      return undefined;
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    void fetchLatest().then((memory) => {
      if (!active || !memory) return;
      setDraft(toDraft(memory));
      setBase(memory.version);
    });
    return () => {
      active = false;
    };
  }, [fetchLatest]);

  if (loadError)
    return (
      <p role="alert" className="form-error">
        {loadError}
      </p>
    );
  if (!draft) return <p role="status">Loading…</p>;

  const update = (changes: Partial<Draft>) => {
    setDraft({ ...draft, ...changes });
    setFieldError(null);
    setMessage('');
  };

  async function loadLatest() {
    setLoading(true);
    const fresh = await fetchLatest();
    setLoading(false);
    if (!fresh) return;
    setBase(fresh.version);
    save.reset();
    setMessage('Latest version loaded. Your edits are kept.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || save.conflict) return;
    if (!draft.title.trim()) {
      setFieldError({ field: 'title', message: 'Enter a title' });
      title.current?.focus();
      return;
    }
    if (!draft.content.trim())
      return setFieldError({ field: 'content', message: 'Enter the memory' });
    const fields = {
      kind: draft.kind,
      title: draft.title,
      content: draft.content,
      observedOn: draft.observedOn || null,
      enabled: draft.enabled,
      sensitivity: draft.sensitivity,
    };
    const result = await save.run(
      memoryMutationResponseSchema,
      id ? 'PUT' : 'POST',
      id ? `/api/v1/memory/${id}` : '/api/v1/memory',
      id ? { ...fields, expectedVersion: base } : fields,
    );
    if (result) onSaved(id ? 'Memory saved.' : 'Memory added.');
  }

  async function forgetMemory() {
    if (!id) return;
    const confirmed = await confirm({
      title: 'Forget this memory?',
      message:
        'Its title, text and date are cleared from the app and future exports, and it cannot be restored. Earlier backups and exports you downloaded still contain it.',
      confirmLabel: 'Forget memory',
    });
    if (!confirmed) return;
    const result = await forget.run(
      memoryMutationResponseSchema,
      'DELETE',
      `/api/v1/memory/${id}`,
      { expectedVersion: base },
      'Could not forget. The memory is unchanged.',
    );
    if (result) onSaved('Memory forgotten.');
  }

  return (
    <form
      className="editor-form"
      noValidate
      aria-label={id ? 'Edit memory' : 'Add memory'}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3>{id ? 'Edit memory' : 'Add memory'}</h3>
      {save.conflict && (
        <ChangedElsewhere
          loading={loading}
          onLoad={() => {
            void loadLatest();
          }}
        />
      )}
      <div className="form-row">
        <label>
          Type
          <select
            value={draft.kind}
            onChange={(event) => update({ kind: event.target.value as Kind })}
          >
            {(Object.keys(kindLabels) as Kind[]).map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Noted on (optional)
          <input
            type="date"
            value={draft.observedOn}
            onChange={(event) => update({ observedOn: event.target.value })}
          />
        </label>
      </div>
      <label>
        Title
        <input
          ref={title}
          value={draft.title}
          maxLength={160}
          aria-invalid={fieldError?.field === 'title'}
          aria-describedby={
            fieldError?.field === 'title' ? 'memory-error' : undefined
          }
          onChange={(event) => update({ title: event.target.value })}
        />
      </label>
      <label>
        Memory
        <textarea
          rows={4}
          value={draft.content}
          maxLength={4000}
          aria-invalid={fieldError?.field === 'content'}
          aria-describedby={
            fieldError?.field === 'content' ? 'memory-error' : undefined
          }
          onChange={(event) => update({ content: event.target.value })}
        />
      </label>
      {fieldError && (
        <p id="memory-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {fieldError.message}
        </p>
      )}
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        Enabled
      </label>
      <LabelSelect
        label="Memory content label"
        value={draft.sensitivity}
        onChange={(sensitivity) => update({ sensitivity })}
      />
      {(save.error && !save.conflict) || forget.error ? (
        <p role="alert" className="form-error">
          {forget.error || save.error}
        </p>
      ) : null}
      <p role="status">{message}</p>
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || save.conflict}
        >
          {save.pending ? 'Saving…' : id ? 'Save memory' : 'Add memory'}
        </button>
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        {id && (
          <button
            type="button"
            className="danger-button"
            disabled={forget.pending || save.pending}
            onClick={() => {
              void forgetMemory();
            }}
          >
            Forget memory
          </button>
        )}
      </div>
      {dialog}
    </form>
  );
}
