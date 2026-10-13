import { useEffect, useRef, useState } from 'react';
import {
  aiRoutingSettingsSchema,
  aiRoutingPreviewResponseSchema,
  tasksResponseSchema,
  aiRoutingPolicySchema,
} from '@hub/contracts';
import type { Task } from '@hub/contracts';
import type { z } from 'zod';
import { requestJson } from '../lib/api';
import { AIContextPicker } from './AIContextPicker';
import type { Context } from './AIContextPicker';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
const labels = ['unlabeled', 'personal', 'restricted'] as const;
type Settings = z.infer<typeof aiRoutingSettingsSchema>;
type Draft = {
  version: number;
  routes: Record<
    (typeof labels)[number],
    { allowed: string; preferred: string }
  >;
};
type Preview = z.infer<typeof aiRoutingPreviewResponseSchema>;
const base = '/api/v1/ai/routing';
const split = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
function draftFrom(value: Settings): Draft {
  return {
    version: value.version,
    routes: Object.fromEntries(
      labels.map((label) => [
        label,
        {
          allowed: value.policy[label].allowed.join(', '),
          preferred: value.policy[label].preferred ?? '',
        },
      ]),
    ) as Draft['routes'],
  };
}
export function AIRoutingSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [context, setContext] = useState<Context>({
    text: '',
    label: 'unlabeled',
    taskId: '',
  });
  const [available, setAvailable] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  async function load(signal?: AbortSignal) {
    const [settings, records] = await Promise.all([
      requestJson(base, aiRoutingSettingsSchema, signal ? { signal } : {}),
      requestJson(
        '/api/v1/tasks',
        tasksResponseSchema,
        signal ? { signal } : {},
      ),
    ]);
    if (!signal?.aborted) {
      setSaved(settings);
      setTasks(records.tasks);
      setDraft((previous) => previous ?? draftFrom(settings));
    }
    return settings;
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('Routing permissions unavailable.');
    });
    return () => abort.abort();
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Routing request failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  const rawPolicy = draft
    ? Object.fromEntries(
        labels.map((label) => [
          label,
          {
            allowed: split(draft.routes[label].allowed),
            preferred: draft.routes[label].preferred || null,
          },
        ]),
      )
    : null;
  const policy = aiRoutingPolicySchema.safeParse(rawPolicy);
  const dirty =
    !policy.success ||
    JSON.stringify(policy.data) !== JSON.stringify(saved?.policy);
  const profiles = saved
    ? [...new Set(labels.flatMap((label) => saved.policy[label].allowed))]
    : [];
  return (
    <section
      className="panel preference-panel"
      aria-label="AI routing permissions"
    >
      <h2>Permissions</h2>
      <StatusChip>Preview only · Not used by the Assistant</StatusChip>
      <Help label="AI permissions">
        Provider aliases name destinations you may connect later; they are not
        credentials, endpoints or model names. Use lowercase names, numbers,
        underscores or hyphens. List permitted aliases for each owner-applied
        label, including sensitive aliases under Unlabeled when mixed context
        should be permitted. Preview uses saved rules and server-resolved source
        labels/provenance. Uploaded-file-derived content is blocked. An
        unavailable chosen provider never falls back to another destination.
        Simulation sends no requests to providers and stores no preview text.
        Email sending still requires explicit approval.
      </Help>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <button
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            const settings = await load();
            setDraft((previous) =>
              previous
                ? { ...previous, version: settings.version }
                : draftFrom(settings),
            );
            setPreview(null);
          })
        }
      >
        Reload permissions
      </button>
      {draft && (
        <form
          className="editor-form"
          aria-label="Routing permissions"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              if (!policy.success)
                throw new Error(
                  'Use valid unique provider aliases and an allowed preferred provider.',
                );
              const body = {
                expectedVersion: draft.version,
                policy: policy.data,
              };
              const key = JSON.stringify(body);
              if (pending.current?.key !== key)
                pending.current = { key, id: crypto.randomUUID() };
              const result = await requestJson(base, aiRoutingSettingsSchema, {
                method: 'PUT',
                body: { ...body, operationId: pending.current.id },
              });
              pending.current = null;
              window.dispatchEvent(new Event('hub-ai-settings-changed'));
              setSaved(result);
              setDraft(draftFrom(result));
              setPreview(null);
              setStatus('Permissions saved.');
            });
          }}
        >
          {labels.map((label) => (
            <fieldset key={label}>
              <legend>
                {label === 'unlabeled'
                  ? 'Unlabeled'
                  : label === 'personal'
                    ? 'Personal'
                    : 'Restricted'}
              </legend>
              <label>
                Allowed providers
                <input
                  aria-label={`${label} allowed providers`}
                  value={draft.routes[label].allowed}
                  disabled={busy}
                  maxLength={400}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      routes: {
                        ...draft.routes,
                        [label]: {
                          ...draft.routes[label],
                          allowed: event.target.value,
                        },
                      },
                    });
                    setPreview(null);
                  }}
                  placeholder="Comma-separated aliases"
                />
              </label>
              <label>
                Preferred provider
                <select
                  aria-label={`${label} preferred provider`}
                  disabled={busy}
                  value={draft.routes[label].preferred}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      routes: {
                        ...draft.routes,
                        [label]: {
                          ...draft.routes[label],
                          preferred: event.target.value,
                        },
                      },
                    });
                    setPreview(null);
                  }}
                >
                  <option value="">First permitted provider</option>
                  {[
                    ...new Set([
                      ...split(draft.routes[label].allowed),
                      ...(draft.routes[label].preferred
                        ? [draft.routes[label].preferred]
                        : []),
                    ]),
                  ].map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ))}
          <button disabled={busy}>Save permissions</button>
        </form>
      )}
      <h3>Routing preview</h3>
      {dirty && saved && <p>Save permissions before preview.</p>}
      <form
        className="editor-form"
        aria-label="Routing preview"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            if (!saved) throw new Error('Load permissions first.');
            setPreview(null);
            const task = tasks.find((row) => row.id === context.taskId);
            if (context.taskId && !task)
              throw new Error('Reload the selected task.');
            setPreview(
              await requestJson(
                `${base}/preview`,
                aiRoutingPreviewResponseSchema,
                {
                  method: 'POST',
                  body: {
                    expectedPolicyVersion: saved.version,
                    text: context.text,
                    sensitivity: context.label,
                    sources: task
                      ? [
                          {
                            kind: 'task',
                            id: task.id,
                            expectedVersion: task.version,
                          },
                        ]
                      : [],
                    simulatedAvailableProviders: available.filter((id) =>
                      profiles.includes(id),
                    ),
                  },
                },
              ),
            );
          });
        }}
      >
        <AIContextPicker
          value={context}
          tasks={tasks}
          disabled={busy}
          names={{
            text: 'Preview text',
            label: 'Request label',
            task: 'Task context',
          }}
          onChange={(value) => {
            setContext(value);
            setPreview(null);
          }}
        />
        <fieldset>
          <legend>Simulated availability</legend>
          {profiles.map((provider) => (
            <label className="checkbox-label" key={provider}>
              <input
                type="checkbox"
                aria-label={`Simulate ${provider} available`}
                disabled={busy}
                checked={available.includes(provider)}
                onChange={(event) => {
                  setAvailable((previous) =>
                    event.target.checked
                      ? [...previous, provider]
                      : previous.filter((value) => value !== provider),
                  );
                  setPreview(null);
                }}
              />
              {provider}
            </label>
          ))}
          {!profiles.length && <p>No permitted providers.</p>}
        </fieldset>
        <button disabled={busy || dirty || !saved}>Preview route</button>
      </form>
      {preview && (
        <div role="status">
          <p>
            {preview.status === 'selected'
              ? `Selected ${preview.provider} · Simulation`
              : `Blocked · ${preview.reason === 'ATTACHMENT_DERIVED' ? 'File-derived context' : preview.reason === 'PROVIDER_UNAVAILABLE' ? 'Approved provider unavailable' : 'No provider permitted for all context'}`}
          </p>
          <p>Labels: {preview.labels.join(', ')}</p>
        </div>
      )}
      {preview?.status === 'blocked' && (
        <details>
          <summary>Details</summary>
          <p>
            Code: <code>{preview.reason}</code>
          </p>
        </details>
      )}
    </section>
  );
}
