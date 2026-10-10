import { useEffect, useRef, useState } from 'react';
import {
  accountResponseSchema,
  plannerExportSchema,
  sessionResponseSchema,
  sessionRevokeResponseSchema,
} from '@hub/contracts';
import type { AccountResponse } from '@hub/contracts';
import { requestJson } from '../lib/api';
import { pendingCount } from '../lib/offline';
import { Help } from './Help';

export function AccountSettings() {
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const operations = useRef(new Map<string, string>());
  async function reload() {
    const result = await requestJson(
      '/api/v1/auth/account',
      accountResponseSchema,
    );
    setAccount(result);
  }
  useEffect(() => {
    let active = true;
    void requestJson('/api/v1/auth/account', accountResponseSchema).then(
      (value) => {
        if (active) setAccount(value);
      },
      () => {
        if (active) setError('Connect to load account settings.');
      },
    );
    return () => {
      active = false;
    };
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel preference-panel">
        <h2>Account</h2>
        <Help label="Password">
          Changing your password signs out other sessions. Account changes
          require a connection. If a password change loses its response, try
          signing in with the new password.
        </Help>
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void perform(reload)}
        >
          Refresh account
        </button>
        <form
          className="account-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const fields = new FormData(form);
            if (fields.get('newPassword') !== fields.get('confirmPassword')) {
              setError('Passwords do not match.');
              return;
            }
            if (!account) return;
            void perform(async () => {
              await requestJson(
                '/api/v1/auth/password',
                sessionResponseSchema,
                {
                  method: 'POST',
                  body: {
                    currentPassword: fields.get('currentPassword'),
                    newPassword: fields.get('newPassword'),
                    expectedVersion: account.version,
                  },
                },
              );
              form.reset();
              await reload();
              setStatus('Password changed.');
            });
          }}
        >
          <label>
            Current password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
            />
          </label>
          <label>
            New password
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
            />
          </label>
          <label>
            Confirm password
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={256}
            />
          </label>
          <button className="primary-button" disabled={busy || !account}>
            Change password
          </button>
        </form>
      </section>
      <section className="panel preference-panel">
        <h2>Sessions</h2>
        <Help label="Sessions">
          These are active sign-ins, identified by their creation and expiration
          times. Revoking a session blocks its next server request; cached
          offline data on that device remains subject to its local expiry.
        </Help>
        {account?.sessions.map((session) => (
          <div className="account-session" key={session.id}>
            <span>
              {session.current ? 'Current session' : 'Other session'}
              <small>
                Created {new Date(session.createdAt).toLocaleString()}
                <br />
                Expires {new Date(session.expiresAt).toLocaleString()}
              </small>
            </span>
            {!session.current && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const key = `${session.id}:${session.version}`;
                    const operationId =
                      operations.current.get(key) ?? crypto.randomUUID();
                    operations.current.set(key, operationId);
                    await requestJson(
                      `/api/v1/auth/sessions/${session.id}/revoke`,
                      sessionRevokeResponseSchema,
                      {
                        method: 'POST',
                        body: { operationId, expectedVersion: session.version },
                      },
                    );
                    operations.current.delete(key);
                    await reload();
                    setStatus('Session revoked.');
                  })
                }
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </section>
      <section className="panel preference-panel">
        <h2>Planner export</h2>
        <Help label="Planner export">
          Downloads server records, including deleted records, labels,
          recurrence exceptions and inbox history. Sync queued tasks first. This
          is a portable JSON export, not a database backup; importing it is not
          yet supported. Store the downloaded file privately.
        </Help>
        <button
          className="secondary-button"
          disabled={busy || !account}
          onClick={() =>
            void perform(async () => {
              if (await pendingCount())
                throw new Error(
                  'Sync or discard pending tasks before exporting.',
                );
              const data = await requestJson(
                '/api/v1/planner/export',
                plannerExportSchema,
              );
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], {
                  type: 'application/json',
                }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `personal-hub-${data.exportedAt.slice(0, 10)}.json`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setStatus('Export downloaded.');
            })
          }
        >
          Download JSON
        </button>
      </section>
    </>
  );
}
