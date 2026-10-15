import { useEffect, useRef, useState } from 'react';
import { aiActionSettingsSchema } from '@hub/contracts';
import type { AIActionSettings as Settings } from '@hub/contracts';
import { RequestError, liveRequestJson } from '../lib/api';
import { useOnline } from '../lib/hooks';
import { Help } from './Help';

const modes = [
  ['automatic', 'Automatic'],
  ['approval-required', 'Ask first'],
  ['blocked', 'Off'],
] as const;

export function AIActionSettings() {
  const online = useOnline();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function load(signal?: AbortSignal) {
    const settings = await liveRequestJson(
      '/api/v1/ai/actions',
      aiActionSettingsSchema,
      signal ? { signal } : {},
    );
    if (!signal?.aborted) {
      setDraft(settings);
      setError('');
      setStatus('');
      pending.current = null;
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted)
        setError('Action settings could not be loaded.');
    });
    return () => abort.abort();
  }, []);
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setStatus('');
    const body = { expectedVersion: draft.version, policy: draft.policy };
    const key = JSON.stringify(body);
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    try {
      const saved = await liveRequestJson(
        '/api/v1/ai/actions',
        aiActionSettingsSchema,
        {
          method: 'PUT',
          body: { ...body, operationId: pending.current.id },
        },
      );
      setDraft(saved);
      pending.current = null;
      setStatus('Action settings saved.');
    } catch (cause) {
      setError(
        cause instanceof RequestError && cause.code === 'VERSION_CONFLICT'
          ? 'Reload action settings.'
          : 'Action settings could not be saved. Your choices are still here.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel preference-panel" aria-label="AI actions">
      <h2>Actions</h2>
      <Help label="Agent actions">
        These settings govern agent runs. Assistant answers always ask first.
        Automatic changes apply to hub tasks and calendar records.
      </Help>
      {!online && <p role="status">Offline. Reconnect to save.</p>}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <button
        type="button"
        disabled={busy || !online}
        onClick={() => {
          setBusy(true);
          void load()
            .catch(() => setError('Action settings could not be loaded.'))
            .finally(() => setBusy(false));
        }}
      >
        Reload action settings
      </button>
      {draft && (
        <form
          className="editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {(['tasks', 'calendar'] as const).map((group) => (
            <fieldset key={group} disabled={busy}>
              <legend>{group === 'tasks' ? 'Tasks' : 'Calendar'}</legend>
              {modes.map(([value, label]) => (
                <label key={value} className="checkbox-label">
                  <input
                    type="radio"
                    name={`action-${group}`}
                    checked={draft.policy[group] === value}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        policy: { ...draft.policy, [group]: value },
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ))}
          <p>Email: always asks first</p>
          <button type="submit" disabled={busy || !online}>
            {busy ? 'Saving…' : 'Save action settings'}
          </button>
        </form>
      )}
    </section>
  );
}
