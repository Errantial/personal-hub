import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  assistantRequestResponseSchema,
  assistantSettingsResponseSchema,
  calendarResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import type { AssistantProposal, AssistantRequest } from '@hub/contracts';
import { RequestError, getJson, liveRequestJson } from '../lib/api';
import {
  applyRequest,
  describeProposal,
  formatCost,
  undoRequest,
} from '../lib/assistant';
import type { PlannedRequest } from '../lib/assistant';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import type { Route } from '../lib/router';
import { Help } from './Help';
import { Link } from './Link';
import './AssistantBox.css';

type Item = {
  proposal: AssistantProposal;
  selected: boolean;
  /** Stable per write, so a retry after a lost response is not doubled. */
  applyId: string;
  undoId: string;
  state: 'proposed' | 'applied' | 'failed' | 'undone';
  applied?: { id: string; version: number } | undefined;
  error?: string | undefined;
};

const reasons: Record<NonNullable<AssistantRequest['reason']>, string> = {
  invalid: 'The answer could not be read, so there is nothing to apply.',
  'provider-error': 'The model reported an error.',
  blocked: 'The answer was refused, cut off or not plain text.',
  unauthorized: 'OpenRouter rejected the server’s key.',
  'payment-required': 'The OpenRouter account has no credit left.',
  unavailable:
    'This model has no endpoint that meets the privacy rules. Choose another model in Settings › AI.',
  'rate-limited': 'OpenRouter is limiting requests. Try again in a minute.',
  rejected: 'OpenRouter rejected the request.',
  timeout: 'No answer arrived in time.',
  transport: 'The connection to OpenRouter failed.',
  response: 'OpenRouter sent an unreadable response.',
  billing: 'OpenRouter did not report the cost.',
};

/** One live planner write (never queued offline); returns the record. */
async function send(request: PlannedRequest) {
  const options = { method: request.method, body: request.body };
  return request.returns === 'task'
    ? (await liveRequestJson(request.path, taskResponseSchema, options)).task
    : (await liveRequestJson(request.path, calendarResponseSchema, options))
        .event;
}
const failure = (error: unknown) =>
  error instanceof RequestError
    ? error.code === 'VERSION_CONFLICT' || error.code === 'NOT_FOUND'
      ? 'Changed or removed since the assistant read it. Ask again.'
      : error.message
    : 'Could not reach the server. Try again.';

/**
 * Today › Assistant: a natural-language request becomes proposed task and
 * event changes. Nothing changes until the owner applies them; applied
 * changes use the ordinary versioned writes and can be undone. Online only.
 */
export function AssistantBox({
  navigate,
  onApplied,
}: {
  navigate: (route: Route) => void;
  /** Reloads the planner lists after changes. */
  onApplied: () => void;
}) {
  const online = useOnline();
  const settings = useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/settings',
        assistantSettingsResponseSchema,
        signal,
      ),
    { failure: 'Assistant status unavailable.' },
  );
  const [text, setText] = useState('');
  const [request, setRequest] = useState<AssistantRequest | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const ask = useMutation();
  const field = useRef<HTMLTextAreaElement>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const configured = settings.data?.settings.configured;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) {
      field.current?.focus();
      return;
    }
    setNotice('');
    const result = await ask.run(
      assistantRequestResponseSchema,
      'POST',
      '/api/v1/assistant/requests',
      { text, timeZone },
      'Could not send the request. Try again.',
    );
    if (!result) return;
    setRequest(result.request);
    setItems(
      result.request.proposals.map((proposal) => ({
        proposal,
        selected: true,
        applyId: crypto.randomUUID(),
        undoId: crypto.randomUUID(),
        state: 'proposed',
      })),
    );
    if (result.request.resultAvailable) setText('');
  }

  async function apply() {
    setBusy(true);
    const next = [...items];
    for (const [index, item] of next.entries()) {
      if (!item.selected || item.state !== 'proposed') continue;
      try {
        const record = await send(applyRequest(item.proposal, item.applyId));
        next[index] = {
          ...item,
          state: 'applied',
          applied: { id: record.id, version: record.version },
          error: undefined,
        };
      } catch (error) {
        next[index] = { ...item, state: 'failed', error: failure(error) };
      }
      setItems([...next]);
    }
    const count = next.filter((item) => item.state === 'applied').length;
    setNotice(count ? `Applied ${count} change${count === 1 ? '' : 's'}.` : '');
    setBusy(false);
    if (count) onApplied();
  }

  async function undo() {
    setBusy(true);
    const next = [...items];
    // Newest first, so later changes to the same item are reversed first.
    for (const [index, item] of [...next.entries()].reverse()) {
      if (item.state !== 'applied' || !item.applied) continue;
      try {
        await send(undoRequest(item.proposal, item.applied, item.undoId));
        next[index] = { ...item, state: 'undone', error: undefined };
      } catch (error) {
        next[index] = { ...item, error: failure(error) };
      }
      setItems([...next]);
    }
    const left = next.filter((item) => item.state === 'applied').length;
    setNotice(left ? 'Some changes could not be undone.' : 'Changes undone.');
    setBusy(false);
    onApplied();
  }

  const proposed = items.filter((item) => item.state === 'proposed');
  const selected = proposed.filter((item) => item.selected).length;
  const applied = items.some((item) => item.state === 'applied');
  return (
    <section className="panel assistant" aria-labelledby="assistant-title">
      <h2 id="assistant-title">Assistant</h2>
      <Help label="Assistant">
        Describe tasks or events to add or change. The assistant proposes
        changes and nothing is saved until you apply them. It sees the titles
        and times of your open tasks and one-time events in the next 30 days,
        not notes, repeating events, source-linked items, unknown label history,
        or anything you labeled Personal or Restricted. Requests go to
        OpenRouter and count against your AI spending limits.
      </Help>
      {settings.error && (
        <p role="alert" className="form-error">
          {settings.error}
        </p>
      )}
      {configured === false ? (
        <p>
          Not set up: the server has no OpenRouter key. See the operating guide.
        </p>
      ) : (
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
              placeholder="Add a task to call the bank on Friday"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // Enter asks; Shift+Enter adds a line. Not while composing (IME).
                if (
                  event.key !== 'Enter' ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                )
                  return;
                event.preventDefault();
                if (online && !ask.pending && configured)
                  event.currentTarget.form?.requestSubmit();
              }}
            />
          </label>
          <button
            className="primary-button"
            disabled={!online || ask.pending || !configured}
          >
            {ask.pending ? 'Asking…' : 'Ask'}
          </button>
        </form>
      )}
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
      {request && (
        <div className="assistant__result">
          {request.reason && (
            <p role="alert" className="form-error">
              {reasons[request.reason]}
              {request.status === 'uncertain' &&
                ` The cost is unknown: up to ${formatCost(request.heldMicros)} stays held against this month’s limit. Nothing is resent.`}
            </p>
          )}
          {!request.resultAvailable && !request.reason && (
            <p>This request was already answered. Ask again to see changes.</p>
          )}
          {request.reply && <p className="assistant__reply">{request.reply}</p>}
          <p className="meta">
            {request.model}
            {request.costMicros !== null &&
              ` · ${formatCost(request.costMicros)}`}
            {request.withheld > 0 &&
              ` · ${request.withheld} item${request.withheld === 1 ? '' : 's'} left out`}
            {request.dropped > 0 &&
              ` · ${request.dropped} suggestion${request.dropped === 1 ? '' : 's'} could not be used`}
          </p>
          {request.resultAvailable && !items.length && !request.reason && (
            <p>No changes proposed.</p>
          )}
          {items.length > 0 && (
            <fieldset className="assistant__changes" disabled={busy}>
              <legend>Proposed changes</legend>
              <ul>
                {items.map((item, index) => (
                  <li key={item.applyId}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        disabled={item.state !== 'proposed'}
                        onChange={(event) =>
                          setItems(
                            items.map((other, at) =>
                              at === index
                                ? { ...other, selected: event.target.checked }
                                : other,
                            ),
                          )
                        }
                      />
                      {describeProposal(item.proposal, timeZone)}
                    </label>
                    {item.state !== 'proposed' && (
                      <span className="assistant__state">
                        {item.state === 'applied'
                          ? 'Applied'
                          : item.state === 'undone'
                            ? 'Undone'
                            : 'Not applied'}
                      </span>
                    )}
                    {item.error && <p className="form-error">{item.error}</p>}
                  </li>
                ))}
              </ul>
              <div className="form-actions">
                {proposed.length > 0 && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!selected || !online}
                    onClick={() => {
                      void apply();
                    }}
                  >
                    {busy
                      ? 'Applying…'
                      : `Apply ${selected} change${selected === 1 ? '' : 's'}`}
                  </button>
                )}
                {applied && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!online}
                    onClick={() => {
                      void undo();
                    }}
                  >
                    Undo
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setRequest(null);
                    setItems([]);
                    setNotice('');
                  }}
                >
                  {applied ? 'Done' : 'Discard'}
                </button>
              </div>
            </fieldset>
          )}
          <p role="status">{notice}</p>
        </div>
      )}
    </section>
  );
}
