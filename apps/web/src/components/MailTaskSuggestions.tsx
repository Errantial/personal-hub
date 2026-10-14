import { useState } from 'react';
import { mailTaskSuggestResponseSchema } from '@hub/contracts';
import type {
  MailMessage,
  MailTaskSuggestResponse,
  MailTaskSuggestion,
} from '@hub/contracts';
import { formatCost } from '../lib/assistant';
import { formatDate } from '../lib/format';
import { useMutation, useOnline } from '../lib/hooks';

const blockText = {
  restricted: 'This message is labeled Restricted and is never sent.',
  'personal-not-allowed':
    'This message is labeled Personal. Allow Personal mail in Settings › AI › Assistant first.',
  provenance:
    'This message was imported by an older connector. Re-import it to use AI.',
  changed: 'This message changed. Reload it first.',
} as const;

/**
 * Asks the model for tasks in one message. A suggestion only fills the
 * capture form; the owner still reviews it and confirms any deadline.
 */
export function MailTaskSuggestions({
  message,
  disabled,
  onUse,
}: {
  message: MailMessage;
  disabled: boolean;
  onUse: (suggestion: MailTaskSuggestion) => void;
}) {
  const online = useOnline();
  const ask = useMutation();
  const [result, setResult] = useState<MailTaskSuggestResponse | null>(null);
  const request = result?.request;
  return (
    <div className="mail-task-suggestions">
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || !online || ask.pending}
        onClick={() => {
          void ask
            .run(
              mailTaskSuggestResponseSchema,
              'POST',
              `/api/v1/email/messages/${message.id}/task-suggestions`,
              {
                expectedVersion: message.version,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
              'Could not get suggestions. Try again.',
            )
            .then((response) => {
              if (response) setResult(response);
            });
        }}
      >
        {ask.pending ? 'Asking…' : 'Suggest tasks with AI'}
      </button>
      {ask.error && (
        <p role="alert" className="form-error">
          {ask.error}
        </p>
      )}
      {result?.blocked && (
        <p role="alert" className="form-error">
          {blockText[result.blocked]}
        </p>
      )}
      {request && (
        <p className="meta">
          {request.model}
          {request.costMicros !== null &&
            ` · ${formatCost(request.costMicros)}`}
          {request.status === 'uncertain' &&
            ` · Outcome unknown: up to ${formatCost(request.heldMicros)} held; nothing is resent`}
          {request.reason &&
            request.status !== 'uncertain' &&
            ' · The answer could not be used'}
          {request.dropped > 0 &&
            ` · ${request.dropped} suggestion${request.dropped === 1 ? '' : 's'} without an exact quote left out`}
          {!request.resultAvailable &&
            !request.reason &&
            ' · Already answered; ask again to see suggestions'}
        </p>
      )}
      {request?.resultAvailable && !request.suggestions.length && (
        <p>No tasks found in this message.</p>
      )}
      {request && request.suggestions.length > 0 && (
        <ul
          className="mail-task-suggestions__list"
          aria-label="Suggested tasks"
        >
          {request.suggestions.map((suggestion, index) => (
            <li key={index}>
              <strong>{suggestion.title}</strong>
              <blockquote>{suggestion.quote}</blockquote>
              {suggestion.dueDate && (
                <span className="meta">
                  Suggested deadline {formatDate(suggestion.dueDate)} (check
                  before confirming)
                </span>
              )}
              {suggestion.notes && (
                <span className="meta">{suggestion.notes}</span>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                aria-label={`Use suggestion: ${suggestion.title}`}
                onClick={() => onUse(suggestion)}
              >
                Use
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
