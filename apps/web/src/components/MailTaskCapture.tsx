import { useState } from 'react';
import type { FormEvent } from 'react';
import { mailTaskResultSchema } from '@hub/contracts';
import type { MailMessage } from '@hub/contracts';
import { useMutation, useOnline } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Help } from './Help';
import { Link } from './Link';
import { MailTaskSuggestions } from './MailTaskSuggestions';

export function MailTaskCapture({
  message,
  locked,
  onPending,
  navigate,
}: {
  message: MailMessage;
  locked: boolean;
  onPending: (value: boolean) => void;
  navigate: (route: Route) => void;
}) {
  const [expectedVersion, setExpectedVersion] = useState(message.version);
  const [title, setTitle] = useState('');
  const [quote, setQuote] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const save = useMutation();
  const online = useOnline();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (save.pending || locked || !online) return;
    onPending(true);
    try {
      const result = await save.run(
        mailTaskResultSchema,
        'POST',
        `/api/v1/email/messages/${message.id}/tasks`,
        {
          expectedVersion,
          title,
          quote,
          dueDate: dueDate || null,
          deadlineConfirmed: confirmed,
        },
      );
      if (result) setCreated(result.taskId);
    } finally {
      onPending(false);
    }
  }
  const disabled = locked || save.pending || !online;
  return (
    <details>
      <summary>Create task from mail</summary>
      <Help label="Create task from mail">
        Copy exact supporting text from the imported body. The task retains this
        quote, a link to the message and its privacy labels. Enter a date only
        after checking it; no date is inferred. Suggest tasks with AI sends this
        message to OpenRouter (within your AI limits and labels) and only fills
        this form. Creation needs a connection. Mail-derived tasks are currently
        withheld from AI.
      </Help>
      {created ? (
        <p role="status">
          Task created.{' '}
          <Link
            navigate={navigate}
            route={{ name: 'tasks', filter: 'open', id: created }}
          >
            Open task
          </Link>
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <MailTaskSuggestions
            message={message}
            disabled={disabled}
            onUse={(suggestion) => {
              // A suggestion fills the draft; the deadline stays unconfirmed.
              setTitle(suggestion.title);
              setQuote(suggestion.quote);
              setDueDate(suggestion.dueDate ?? '');
              setConfirmed(false);
              save.reset();
            }}
          />
          {message.version !== expectedVersion && (
            <p role="alert">
              The message changed. Review the supporting quote before
              continuing.{' '}
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setExpectedVersion(message.version);
                  setConfirmed(false);
                  save.reset();
                }}
              >
                Use reviewed message version
              </button>
            </p>
          )}
          <label>
            Task title
            <input
              required
              maxLength={200}
              value={title}
              disabled={disabled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Supporting quote
            <textarea
              required
              maxLength={2000}
              value={quote}
              disabled={disabled}
              onChange={(event) => setQuote(event.target.value)}
            />
          </label>
          <label>
            Deadline
            <input
              type="date"
              value={dueDate}
              disabled={disabled}
              onChange={(event) => {
                setDueDate(event.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          {dueDate && (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={disabled}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I checked and confirm this deadline
            </label>
          )}
          {!online && (
            <p role="status">
              A connection is needed to create this task. Your draft is kept.
            </p>
          )}
          {save.error && (
            <p role="alert" className="form-error">
              {save.code === 'PROVENANCE_UNAVAILABLE'
                ? 'This import has no verified body origin. Use a newly imported message.'
                : save.code === 'MAIL_QUOTE_MISMATCH'
                  ? 'Use exact supporting text from the latest message body.'
                  : save.error}{' '}
              Your draft is kept.
            </p>
          )}
          <button
            className="primary-button"
            disabled={
              disabled ||
              message.version !== expectedVersion ||
              !title.trim() ||
              !quote.trim() ||
              !message.body.includes(quote) ||
              Boolean(dueDate && !confirmed)
            }
          >
            {save.pending ? 'Creating…' : 'Create task'}
          </button>
          {quote && !message.body.includes(quote) && (
            <p role="alert">Use exact text from the message body.</p>
          )}
        </form>
      )}
    </details>
  );
}
