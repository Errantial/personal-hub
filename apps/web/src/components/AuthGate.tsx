import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { sessionResponseSchema } from '@hub/contracts';
import type { SessionResponse, User } from '@hub/contracts';
import { z } from 'zod';
import { getJson, requestJson } from '../lib/api';

export function AuthGate({
  children,
}: {
  children: (user: User, signOut: () => Promise<void>) => ReactNode;
}) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void getJson(
      '/api/v1/auth/session',
      sessionResponseSchema,
      controller.signal,
    ).then(setSession, () => {
      if (!controller.signal.aborted)
        setError('The hub server is unavailable.');
    });
    return () => controller.abort();
  }, [attempt]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const body = {
        email: String(form.get('email')),
        password: String(form.get('password')),
        ...(session?.setupRequired && form.get('setupToken')
          ? { setupToken: String(form.get('setupToken')) }
          : {}),
      };
      setSession(
        await requestJson(
          `/api/v1/auth/${session?.setupRequired ? 'setup' : 'login'}`,
          sessionResponseSchema,
          { method: 'POST', body },
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await requestJson(
        '/api/v1/auth/logout',
        z.object({ ok: z.literal(true) }),
        { method: 'POST', body: {} },
      );
      setSession({ user: null, setupRequired: false });
    } catch {
      setError('Sign-out failed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  if (session?.user)
    return (
      <>
        {error && (
          <p role="alert" className="auth-notice">
            {error}
          </p>
        )}
        {children(session.user, signOut)}
      </>
    );
  return (
    <main className="auth-page">
      <section className="panel auth-panel">
        <span className="small-label">PERSONAL HUB</span>
        <h1>
          {session?.setupRequired ? 'Create your workspace.' : 'Welcome back.'}
        </h1>
        <p>
          {session?.setupRequired
            ? 'Choose the owner login for this hub. Your tasks and schedule will be saved on its server.'
            : 'Sign in to your personal workspace.'}
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {!session ? (
          <button
            className="secondary-button"
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Retry connection
          </button>
        ) : (
          <form
            className="editor-form"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={
                  session.setupRequired ? 'new-password' : 'current-password'
                }
                required
                minLength={session.setupRequired ? 12 : 1}
                maxLength={256}
              />
            </label>
            {session.setupRequired && (
              <>
                <p className="muted-note">
                  Use at least 12 characters. Keep your password in a password
                  manager; recovery is not available yet.
                </p>
                <label>
                  Setup token (for a deployed server)
                  <input
                    name="setupToken"
                    type="password"
                    autoComplete="off"
                    maxLength={256}
                  />
                </label>
              </>
            )}
            <button className="primary-button" disabled={busy}>
              {busy
                ? 'Working…'
                : session.setupRequired
                  ? 'Create workspace'
                  : 'Sign in'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
