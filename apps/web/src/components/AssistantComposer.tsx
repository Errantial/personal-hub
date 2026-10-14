import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { assistantRequestResponseSchema } from '@hub/contracts';
import type { AssistantTurn } from '@hub/contracts';
import { useMutation, useOnline } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Link } from './Link';

/**
 * The ask field. Enter asks and Shift+Enter adds a line (not during IME
 * composition). Each ask joins `conversationId`, which may be a new ID.
 */
export function AssistantComposer({
  conversationId,
  configured,
  placeholder,
  navigate,
  onAnswered,
}: {
  conversationId: string;
  configured: boolean;
  placeholder: string;
  navigate: (route: Route) => void;
  onAnswered: (turn: AssistantTurn) => void;
}) {
  const online = useOnline();
  const ask = useMutation();
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const ready = online && !ask.pending && configured;

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
        <button className="primary-button" disabled={!ready}>
          {ask.pending ? 'Asking…' : 'Ask'}
        </button>
      </form>
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
