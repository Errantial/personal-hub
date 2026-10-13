import { useEffect, useRef, useState } from 'react';
import {
  aiBudgetLiveSettingsSchema,
  aiBudgetPolicySchema,
} from '@hub/contracts';
import type { AIBudgetLiveSettings as BudgetSettings } from '@hub/contracts';
import { requestJson } from '../lib/api';
import { parseUsdMicros, formatUsdMicros } from '../lib/ai-budget';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
type Draft = { version: number; monthly: string; request: string };
export function AIBudgetSettings() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [usage, setUsage] = useState<BudgetSettings['usage'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef<{ key: string; id: string } | null>(null);
  const base = '/api/v1/ai/budget';
  async function load(signal?: AbortSignal) {
    const settings = await requestJson(
      base,
      aiBudgetLiveSettingsSchema,
      signal ? { signal } : {},
    );
    if (!signal?.aborted) {
      setUsage(settings.usage);
      setDraft((previous) =>
        previous
          ? { ...previous, version: settings.version }
          : {
              version: settings.version,
              monthly: formatUsdMicros(settings.policy.monthlyLimitMicros),
              request: formatUsdMicros(settings.policy.perRequestLimitMicros),
            },
      );
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('Spending limits unavailable.');
    });
    return () => abort.abort();
  }, []);
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Spending limits could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel preference-panel" aria-label="AI spending limits">
      <h2>Spending limits</h2>
      <StatusChip>Used by the Assistant</StatusChip>
      <Help label="AI spending limits">
        Amounts are USD, with up to six decimal places. Set both limits; the
        request limit cannot exceed the monthly limit. Leave both empty for
        unconfigured limits; the Assistant then refuses to send. Zero blocks
        paid requests. Monthly accounting uses UTC calendar months. Before each
        Assistant request, its worst-case cost from OpenRouter's published price
        is held; the reported cost replaces the hold. Recorded spending/holds
        come from the internal accounting ledger, not a provider billing sync.
        Uncertain charges remain included in held funds and cannot be released
        by this form. Reload preserves your draft and adopts the current
        version. Costs belong to the admission month, not the provider's billing
        month. Earlier-month unresolved holds remain tracked separately.
      </Help>
      {error && <p role="alert">{error}</p>}
      {usage && (
        <details>
          <summary>Recorded budget · {usage.month} UTC</summary>
          <dl>
            <dt>Spent (USD)</dt>
            <dd>{formatUsdMicros(usage.spentMicros)}</dd>
            <dt>Held (USD)</dt>
            <dd>{formatUsdMicros(usage.heldMicros)}</dd>
            <dt>Uncertain, included in held (USD)</dt>
            <dd>{formatUsdMicros(usage.uncertainMicros)}</dd>
            {usage.outstandingHeldMicros !== usage.heldMicros && (
              <>
                <dt>Unresolved holds, all months (USD)</dt>
                <dd>{formatUsdMicros(usage.outstandingHeldMicros)}</dd>
                <dt>Uncertain, all months (USD)</dt>
                <dd>{formatUsdMicros(usage.outstandingUncertainMicros)}</dd>
              </>
            )}
          </dl>
        </details>
      )}
      {usage && usage.overruns > 0 && (
        <p role="alert">
          Recorded charges exceeded {usage.overruns} reservation(s). AI dispatch
          remains disabled.
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {busy && <p role="status">Updating spending limits…</p>}
      <button
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            await load();
          })
        }
      >
        Reload spending limits
      </button>
      {draft && (
        <form
          className="editor-form"
          aria-label="AI spending limits form"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const policy = aiBudgetPolicySchema.safeParse({
                monthlyLimitMicros: parseUsdMicros(draft.monthly),
                perRequestLimitMicros: parseUsdMicros(draft.request),
              });
              if (!policy.success)
                throw new Error(
                  'Set both limits and keep the request limit within the monthly limit.',
                );
              const body = {
                expectedVersion: draft.version,
                policy: policy.data,
              };
              const key = JSON.stringify(body);
              if (pending.current?.key !== key)
                pending.current = { key, id: crypto.randomUUID() };
              const settings = await requestJson(
                base,
                aiBudgetLiveSettingsSchema,
                {
                  method: 'PUT',
                  body: { ...body, operationId: pending.current.id },
                },
              );
              pending.current = null;
              setUsage(settings.usage);
              setDraft({
                version: settings.version,
                monthly: formatUsdMicros(settings.policy.monthlyLimitMicros),
                request: formatUsdMicros(settings.policy.perRequestLimitMicros),
              });
              setStatus('Spending limits saved.');
              window.dispatchEvent(new Event('hub-ai-settings-changed'));
            });
          }}
        >
          <label>
            Monthly limit (USD)
            <input
              inputMode="decimal"
              maxLength={14}
              value={draft.monthly}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, monthly: event.target.value })
              }
            />
          </label>
          <label>
            Request limit (USD)
            <input
              inputMode="decimal"
              maxLength={14}
              value={draft.request}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, request: event.target.value })
              }
            />
          </label>
          <button disabled={busy} aria-busy={busy}>
            Save spending limits
          </button>
        </form>
      )}
    </section>
  );
}
