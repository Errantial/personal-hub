import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  assistantRequestResponseSchema,
  assistantSettingsResponseSchema,
} from '@hub/contracts';
import type { AssistantTurn } from '@hub/contracts';
import { getJson, liveRequestJson } from '../lib/api';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Link } from './Link';

export function useAssistantSettings() {
  return useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/settings',
        assistantSettingsResponseSchema,
        signal,
      ),
    { failure: 'Assistant status unavailable.' },
  );
}

/**
 * The ask field. Enter asks and Shift+Enter adds a line (not during IME
 * composition). Each ask joins `conversationId`, which may be a new ID.
 * "Use mail" (D56) is remembered in the assistant settings on every device.
 */
export function AssistantComposer({
  conversationId,
  settings,
  placeholder,
  navigate,
  onAnswered,
}: {
  conversationId: string;
  settings: ReturnType<typeof useAssistantSettings>;
  placeholder: string;
  navigate: (route: Route) => void;
  onAnswered: (turn: AssistantTurn) => void;
}) {
  const online = useOnline();
  const ask = useMutation();
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const saved = settings.data?.settings;
  const configured = !!saved?.configured;
  const [useMail, setUseMail] = useState(false);
  const [mailError, setMailError] = useState('');
  useEffect(() => setUseMail(!!saved?.useMail), [saved?.useMail]);
  const ready = online && !ask.pending && configured;

  /** Saves the box's state; a newer version elsewhere is reloaded. */
  async function rememberMail(value: boolean) {
    setUseMail(value);
    setMailError('');
    if (!saved) return;
    try {
      await liveRequestJson(
        '/api/v1/assistant/settings',
        assistantSettingsResponseSchema,
        {
          method: 'PUT',
          body: {
            model: saved.model,
            expectedVersion: saved.version,
            useMail: value,
          },
        },
      );
    } catch {
      setMailError('Could not remember this choice; it still applies now.');
    }
    void settings.reload();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) {
      field.current?.focus();
      return;
    }
    const result = await ask.run(
      assistantRequestResponseSchema,
      'POST',
      '/api/v1/assistant/requests',
      {
        text,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        conversationId,
        useMail,
      },
      'Could not send the request. Try again.',
    );
    if (!result) return;
    setText('');
    onAnswered(result.turn);
  }

  return (
    <>
      <form
        className="assistant__form"
        aria-label="Ask the assistant"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label>
          Ask
          <textarea
            ref={field}
            rows={2}
            maxLength={1000}
            value={text}
            placeholder={placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return;
              event.preventDefault();
              if (ready) event.currentTarget.form?.requestSubmit();
            }}
          />
        </label>
        <div className="assistant__actions">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={useMail}
              disabled={!saved}
              onChange={(event) => {
                void rememberMail(event.target.checked);
              }}
            />
            Use mail
          </label>
          <button className="primary-button" disabled={!ready}>
            {ask.pending ? 'Asking…' : 'Ask'}
          </button>
        </div>
      </form>
      {mailError && <p className="meta">{mailError}</p>}
      {!online && configured && (
        <p className="meta">The assistant needs a connection.</p>
      )}
      {ask.error && (
        <div role="alert" className="form-error">
          <p>{ask.error}</p>
          {['BUDGET_UNSET', 'MONTHLY_BUDGET_EXCEEDED'].includes(ask.code) && (
            <Link
              route={{ name: 'settings', section: 'ai' }}
              navigate={navigate}
            >
              Open AI settings
            </Link>
          )}
        </div>
      )}
    </>
  );
}
