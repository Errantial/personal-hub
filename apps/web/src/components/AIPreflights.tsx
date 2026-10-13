import { useEffect, useRef, useState } from 'react';
import {
  aiProviderRegistrySchema,
  aiRoutingSettingsSchema,
  aiPreflightSchema,
  aiPreflightsResponseSchema,
  tasksResponseSchema,
  aiBudgetLiveSettingsSchema,
} from '@hub/contracts';
import type { AIProviderRegistry, AIPreflight, Task } from '@hub/contracts';
import { requestJson } from '../lib/api';
import { AIContextPicker } from './AIContextPicker';
import type { Context } from './AIContextPicker';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
import { formatInstant } from '../lib/format';
const base = '/api/v1/ai/preflights';
const reasons: Record<AIPreflight['reason'], string> = {
  ATTACHMENT_DERIVED: 'File-derived context',
  NO_APPROVED_PROVIDER: 'No provider permitted for all context',
  PROVIDER_UNAVAILABLE: 'Approved provider not configured',
  INPUT_LIMIT: 'Input exceeds provider limit',
  DISPATCH_DISABLED: 'AI dispatch disabled',
  BUDGET_UNSET: 'Spending limits not configured',
  BUDGET_ZERO_LIMIT: 'Spending limit is zero',
  MONTHLY_BUDGET_EXCEEDED: 'Monthly spending limit exhausted',
};
export function AIPreflights() {
  const [registry, setRegistry] = useState<AIProviderRegistry | null>(null);
  const [policyVersion, setPolicyVersion] = useState<number | null>(null);
  const [budgetVersion, setBudgetVersion] = useState<number | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [context, setContext] = useState<Context>({
    text: '',
    label: 'unlabeled',
    taskId: '',
  });
  const [history, setHistory] = useState<AIPreflight[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AIPreflight | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const pendingHide = useRef<{ key: string; id: string } | null>(null);
  const settingsEpoch = useRef(0);
  const loadEpoch = useRef(0);
  async function load(signal?: AbortSignal) {
    const generation = ++loadEpoch.current;
    const settingsGeneration = settingsEpoch.current;
    const options = signal ? { signal } : {};
    const [profiles, settings, records, page, budget] = await Promise.all([
      requestJson('/api/v1/ai/providers', aiProviderRegistrySchema, options),
      requestJson('/api/v1/ai/routing', aiRoutingSettingsSchema, options),
      requestJson('/api/v1/tasks', tasksResponseSchema, options),
      requestJson(base, aiPreflightsResponseSchema, options),
      requestJson('/api/v1/ai/budget', aiBudgetLiveSettingsSchema, options),
    ]);
    if (signal?.aborted || generation !== loadEpoch.current) return;
    setRegistry(profiles);
    setPolicyVersion(settings.version);
    setBudgetVersion(budget.version);
    setNeedsReload(settingsGeneration !== settingsEpoch.current);
    setTasks(records.tasks);
    setHistory(page.preflights);
    setNextBefore(page.nextBefore);
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('Request checks unavailable.');
    });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const changedSettings = () => {
      settingsEpoch.current++;
      setNeedsReload(true);
      setResult(null);
    };
    window.addEventListener('hub-ai-settings-changed', changedSettings);
    return () =>
      window.removeEventListener('hub-ai-settings-changed', changedSettings);
  }, []);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Request check failed.',
      );
    } finally {
      setBusy(false);
    }
  }
  function changed() {
    setResult(null);
  }
  return (
    <section className="panel preference-panel" aria-label="AI request checks">
      <h2>Request checks</h2>
      <StatusChip>AI requests are off · Provider health unchecked</StatusChip>
      <Help label="Request checks">
        This check uses saved routing permissions and current source versions,
        independently of preview simulation. It never calls a provider or queues
        execution. Prompt/source text is discarded; routing metadata is
        retained. Hide removes a check from this list while retaining its export
        tombstone. Limits count the serialized text envelope, not model tokens
        or cost. Reload retains your input and adopts current policy, task and
        provider versions.
      </Help>
      {error && <p role="alert">{error}</p>}
      {needsReload && (
        <p role="status">Reload checks after settings changes.</p>
      )}
      <button
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            await load();
            changed();
          })
        }
      >
        Reload checks
      </button>
      <form
        className="editor-form"
        aria-label="AI request check"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            if (!registry || !policyVersion || !budgetVersion || needsReload)
              throw new Error('Reload profiles and permissions.');
            const task = tasks.find((item) => item.id === context.taskId);
            if (context.taskId && !task)
              throw new Error('Reload the selected task.');
            const body = {
              expectedPolicyVersion: policyVersion,
              expectedRegistryRevision: registry.revision,
              expectedBudgetVersion: budgetVersion,
              text: context.text,
              sensitivity: context.label,
              sources: task
                ? [{ kind: 'task', id: task.id, expectedVersion: task.version }]
                : [],
            };
            const key = JSON.stringify(body);
            if (pending.current?.key !== key)
              pending.current = { key, id: crypto.randomUUID() };
            const receipt = await requestJson(base, aiPreflightSchema, {
              method: 'POST',
              body: { ...body, operationId: pending.current.id },
            });
            pending.current = null;
            setResult(receipt);
            if (!receipt.deletedAt)
              setHistory((previous) => [
                receipt,
                ...previous.filter((item) => item.id !== receipt.id),
              ]);
          });
        }}
      >
        <AIContextPicker
          value={context}
          tasks={tasks}
          disabled={busy}
          names={{
            text: 'Check text',
            label: 'Check label',
            task: 'Check task',
          }}
          onChange={(value) => {
            setContext(value);
            changed();
          }}
        />
        <button
          disabled={
            busy || !registry || !policyVersion || !budgetVersion || needsReload
          }
          aria-busy={busy}
        >
          Run check
        </button>
      </form>
      {busy && <p role="status">Updating checks…</p>}
      {result && (
        <>
          <p role="status">Blocked · {reasons[result.reason]}</p>
          <details>
            <summary>Details</summary>
            <p>
              Code: <code>{result.reason}</code>
            </p>
          </details>
        </>
      )}
      <h3>Check history</h3>
      {registry && !history.length && <p>No checks yet.</p>}
      {history.map((receipt) => (
        <article key={receipt.id} aria-label={`Check ${receipt.id}`}>
          <details>
            <summary>
              {reasons[receipt.reason]} · {formatInstant(receipt.createdAt)}
            </summary>
            <dl>
              <dt>Provider</dt>
              <dd>{receipt.route.provider ?? 'None'}</dd>
              <dt>Model</dt>
              <dd>{receipt.model ?? 'None'}</dd>
              <dt>Labels</dt>
              <dd>{receipt.route.labels.join(', ')}</dd>
              <dt>Policy version</dt>
              <dd>{receipt.policyVersion}</dd>
              <dt>Request characters</dt>
              <dd>{receipt.requestCharacters}</dd>
              <dt>Context</dt>
              <dd>
                {receipt.contextAssembled
                  ? `${receipt.contextCharacters} characters`
                  : 'Not assembled'}
              </dd>
            </dl>
            {receipt.sources.map((source) => (
              <p key={`${source.kind}:${source.id}`}>
                {source.kind} · {source.id} · v{source.version} ·{' '}
                {source.labels.join(', ')}
              </p>
            ))}
          </details>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const key = `${receipt.id}:${receipt.version}`;
                if (pendingHide.current?.key !== key)
                  pendingHide.current = { key, id: crypto.randomUUID() };
                await requestJson(`${base}/${receipt.id}`, aiPreflightSchema, {
                  method: 'DELETE',
                  body: {
                    expectedVersion: receipt.version,
                    operationId: pendingHide.current.id,
                  },
                });
                pendingHide.current = null;
                setHistory((previous) =>
                  previous.filter((item) => item.id !== receipt.id),
                );
                setResult((previous) =>
                  previous?.id === receipt.id ? null : previous,
                );
              })
            }
          >
            Hide check
          </button>
        </article>
      ))}
      {nextBefore && (
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const page = await requestJson(
                `${base}?before=${nextBefore}`,
                aiPreflightsResponseSchema,
              );
              setHistory((previous) => [
                ...previous,
                ...page.preflights.filter(
                  (item) => !previous.some((old) => old.id === item.id),
                ),
              ]);
              setNextBefore(page.nextBefore);
            })
          }
        >
          Load older checks
        </button>
      )}
    </section>
  );
}
