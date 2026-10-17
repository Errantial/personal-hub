import { useEffect, useRef, useState } from 'react';
import {
  outlookAccessGateSchema,
  type OutlookAccessGate,
} from '@hub/contracts';
import { requestJson } from '../lib/api';
import { Help } from './Help';
import { StatusChip } from './StatusChip';

const base = '/api/v1/connections/outlook/access';
const statusLabel: Record<OutlookAccessGate['status'], string> = {
  unknown: 'Access not established',
  'ready-for-adapter': 'Ready for delegated adapter work',
  'admin-action-required': 'Admin action required',
  'scope-review-required': 'Mailbox scope review required',
  blocked: 'Access blocked',
};

function nextAction(state: OutlookAccessGate) {
  if (state.status === 'ready-for-adapter')
    return 'The access gate is satisfied. The next implementation may add delegated Microsoft Graph Mail.Read OAuth and read-only ingestion; it must still avoid send, write and calendar scopes.';
  if (state.status === 'admin-action-required')
    return 'Ask school IT for the recorded app-registration or delegated-consent action. Do not replace this with tenant-wide application mail permissions.';
  if (state.status === 'scope-review-required')
    return 'Confirm whether shared-mailbox access is actually required before choosing any additional delegated scope.';
  if (state.status === 'blocked')
    return 'Record the school capability that is blocked and stop. Browser feasibility is a separate proposal, not an automatic fallback.';
  return 'Verify the mailbox backend, school-managed tenant, mailbox scope, app-registration availability and delegated consent policy before implementing OAuth.';
}

export function OutlookAccessGate() {
  const [state, setState] = useState<OutlookAccessGate | null>(null);
  const [draft, setDraft] = useState<OutlookAccessGate | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);

  async function load(signal?: AbortSignal, preserveDraft = false) {
    const value = await requestJson(
      base,
      outlookAccessGateSchema,
      signal ? { signal } : {},
    );
    if (!signal?.aborted) {
      setState(value);
      if (!preserveDraft) setDraft(value);
    }
    return value;
  }

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(() => {
      if (!abort.signal.aborted) setError('Outlook access gate unavailable.');
    });
    return () => abort.abort();
  }, []);

  async function save() {
    if (!state || !draft) return;
    setBusy(true);
    setError('');
    setStatus('');
    const body = {
      expectedVersion: state.version,
      backend: draft.backend,
      tenant: draft.tenant,
      mailboxScope: draft.mailboxScope,
      appRegistration: draft.appRegistration,
      consent: draft.consent,
    };
    const key = JSON.stringify(body);
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    try {
      const saved = await requestJson(base, outlookAccessGateSchema, {
        method: 'PUT',
        body: { ...body, operationId: pending.current.id },
      });
      pending.current = null;
      setState(saved);
      setDraft(saved);
      setStatus('Outlook access findings saved.');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Outlook access save failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!state || !draft)
    return <p role="status">Loading Outlook access gate…</p>;
  const changed =
    draft.backend !== state.backend ||
    draft.tenant !== state.tenant ||
    draft.mailboxScope !== state.mailboxScope ||
    draft.appRegistration !== state.appRegistration ||
    draft.consent !== state.consent;
  return (
    <section
      className="panel canvas-connection"
      aria-label="Outlook access gate"
    >
      <h3>Outlook access gate</h3>
      <StatusChip>{statusLabel[state.status]}</StatusChip>
      <Help label="Outlook access gate">
        This records feasibility findings only. It does not sign in to
        Microsoft, request consent, store OAuth tokens or read mail. The planned
        adapter uses delegated Microsoft Graph access only after this gate is
        satisfied. It must not request send, write or calendar permissions.
      </Help>
      <p>{nextAction(state)}</p>
      {state.checkedAt && (
        <p>Last checked {new Date(state.checkedAt).toLocaleString()}.</p>
      )}
      <form
        className="editor-form"
        aria-label="Outlook access findings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Mailbox backend
          <select
            value={draft.backend}
            onChange={(event) =>
              setDraft({
                ...draft,
                backend: event.target.value as OutlookAccessGate['backend'],
              })
            }
          >
            <option value="unknown">Not verified</option>
            <option value="exchange-online">
              Exchange Online / Microsoft 365
            </option>
            <option value="other">Not Exchange Online</option>
          </select>
        </label>
        <label>
          Microsoft tenant
          <select
            value={draft.tenant}
            onChange={(event) =>
              setDraft({
                ...draft,
                tenant: event.target.value as OutlookAccessGate['tenant'],
              })
            }
          >
            <option value="unknown">Not verified</option>
            <option value="school-managed">School-managed Entra tenant</option>
            <option value="other">Another tenant or account type</option>
          </select>
        </label>
        <label>
          Required mailbox scope
          <select
            value={draft.mailboxScope}
            onChange={(event) =>
              setDraft({
                ...draft,
                mailboxScope: event.target
                  .value as OutlookAccessGate['mailboxScope'],
              })
            }
          >
            <option value="unknown">Not verified</option>
            <option value="primary-only">Primary mailbox only</option>
            <option value="shared-required">
              Shared mailbox access is required
            </option>
          </select>
        </label>
        <label>
          App registration
          <select
            value={draft.appRegistration}
            onChange={(event) =>
              setDraft({
                ...draft,
                appRegistration: event.target
                  .value as OutlookAccessGate['appRegistration'],
              })
            }
          >
            <option value="unknown">Not verified</option>
            <option value="owner-can-register">
              Owner can register the app
            </option>
            <option value="admin-must-register">
              School admin must register it
            </option>
            <option value="registration-blocked">
              App registration is blocked
            </option>
          </select>
        </label>
        <label>
          Delegated Mail.Read consent
          <select
            value={draft.consent}
            onChange={(event) =>
              setDraft({
                ...draft,
                consent: event.target.value as OutlookAccessGate['consent'],
              })
            }
          >
            <option value="unknown">Not verified</option>
            <option value="user-can-consent">User consent is allowed</option>
            <option value="admin-consent-required">
              Admin consent is required
            </option>
            <option value="consent-blocked">
              Delegated consent is blocked
            </option>
          </select>
        </label>
        <div className="item-actions">
          <button disabled={busy || !changed}>Save findings</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(state);
              setError('');
            }}
          >
            Discard changes
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void load(undefined, true).catch(() =>
                setError('Outlook access gate unavailable.'),
              )
            }
          >
            Reload current version
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <p>
        `Mail.ReadBasic` is insufficient for message bodies. The planned body
        projection requires delegated `Mail.Read`; attachments stay excluded.
      </p>
    </section>
  );
}
