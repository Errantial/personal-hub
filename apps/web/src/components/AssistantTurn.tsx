import { useState } from 'react';
import {
  assistantTurnResponseSchema,
  assistantConversationResponseSchema,
} from '@hub/contracts';
import type { AssistantRequest, AssistantTurn } from '@hub/contracts';
import { RequestError, liveRequestJson } from '../lib/api';
import {
  applicableItemIndexes,
  describeProposal,
  formatCost,
} from '../lib/assistant';
import { runLine } from '../lib/agents';
import { formatInstant } from '../lib/format';
import { useOnline } from '../lib/hooks';
import { Help } from './Help';

export const reasons: Record<
  NonNullable<AssistantRequest['reason']>,
  string
> = {
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
  'context-changed': 'A source changed before sending. Nothing was sent.',
  'route-blocked': 'The approved destination changed. Nothing was sent.',
};

const failure = (error: unknown) =>
  error instanceof RequestError
    ? error.code === 'VERSION_CONFLICT' || error.code === 'NOT_FOUND'
      ? 'Changed or removed since the assistant read it. Ask again.'
      : error.message
    : 'Could not reach the server. Try again.';

/**
 * One ask and its answer: reply, cost and proposed changes. Apply and Undo
 * use server-owned versioned operations. Exact retry identities survive a lost
 * response while this view remains open; the server saves effects and receipts.
 */
export function AssistantTurnView({
  turn,
  onTurn,
  onApplied,
  onStale,
  onRetry,
  timeZone: zone,
}: {
  turn: AssistantTurn;
  /** The turn after its applied state was saved. */
  onTurn: (turn: AssistantTurn) => void;
  /** Reloads planner lists after changes. */
  onApplied: () => void;
  /** Another device changed this turn; reload it. */
  onStale: () => void;
  /** Agent runs (D57): queue Run now again after a failure. */
  onRetry?: (() => void) | undefined;
  /** The agent's zone for run times; defaults to the device's. */
  timeZone?: string | undefined;
}) {
  const online = useOnline();
  const request = turn.request;
  const [selected, setSelected] = useState<boolean[]>(() =>
    turn.items.map(() => true),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{
    action: 'apply' | 'undo';
    body: { expectedVersion: number; indexes: number[]; operationId: string };
  } | null>(null);
  const timeZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  async function perform(operation: NonNullable<typeof pending>) {
    setBusy(true);
    setNotice('');
    setPending(operation);
    try {
      const { turn: saved } = await liveRequestJson(
        `/api/v1/assistant/turns/${turn.id}/${operation.action}`,
        assistantTurnResponseSchema,
        { method: 'POST', body: operation.body },
      );
      onTurn(saved);
      setPending(null);
      const count = saved.items.filter(
        (item) => item.state === 'applied',
      ).length;
      setNotice(
        operation.action === 'apply'
          ? count
            ? `Applied ${count} change${count === 1 ? '' : 's'}.`
            : ''
          : count
            ? 'Some changes could not be undone.'
            : 'Changes undone.',
      );
      onApplied();
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status < 500 &&
        error.code !== 'RETRY_REQUIRED'
      ) {
        setPending(null);
        setNotice(failure(error));
        if (error.code === 'VERSION_CONFLICT' || error.code === 'NOT_FOUND')
          onStale();
      } else {
        // The server may have committed already. Retain the exact operation,
        // including its expected version, rather than inventing a second write.
        setNotice(
          'The result could not be confirmed. Retry to check the same operation.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (busy || pending || !online || turn.proposalAccess === 'read-only')
      return;
    setBusy(true);
    setNotice('');
    let fresh: AssistantTurn | undefined;
    try {
      // This is a live read, never an offline cached conversation. A page
      // retained across a deployment may still display an old Apply control.
      const conversation = await liveRequestJson(
        `/api/v1/assistant/conversations/${turn.conversationId}`,
        assistantConversationResponseSchema,
      );
      fresh = conversation.turns.find((item) => item.id === turn.id);
    } catch {
      setNotice(
        'Could not verify these suggestions. Nothing was changed. Reconnect and try again.',
      );
      setBusy(false);
      return;
    }
    if (
      !fresh ||
      fresh.version !== turn.version ||
      fresh.proposalAccess !== turn.proposalAccess ||
      fresh.items.length !== turn.items.length ||
      fresh.items.some(
        (item, index) =>
          item.applyId !== turn.items[index]?.applyId ||
          item.undoId !== turn.items[index]?.undoId,
      )
    ) {
      if (fresh) onTurn(fresh);
      else onStale();
      setNotice(
        'These suggestions changed. Review the updated answer before applying. Nothing was changed.',
      );
      setBusy(false);
      return;
    }
    if (!navigator.onLine) {
      setNotice('The assistant needs a connection. Nothing was changed.');
      setBusy(false);
      return;
    }
    await perform({
      action: 'apply',
      body: {
        expectedVersion: fresh.version,
        indexes: applicableItemIndexes(fresh, selected),
        operationId: crypto.randomUUID(),
      },
    });
  }

  async function undo() {
    if (busy || pending || !online) return;
    await perform({
      action: 'undo',
      body: {
        expectedVersion: turn.version,
        indexes: turn.items.flatMap((item, index) =>
          item.state === 'applied' ? [index] : [],
        ),
        operationId: crypto.randomUUID(),
      },
    });
  }

  const readOnly = turn.proposalAccess === 'read-only';
  const proposed = turn.items.filter((item) => item.state === 'proposed');
  const chosen = applicableItemIndexes(turn, selected).length;
  const applied = turn.items.some((item) => item.state === 'applied');
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? '' : 's'}`;
  const leftOut = request.withheld + turn.mailWithheld;
  // Model, cost and what was sent, in one muted line that opens the list.
  const summary = [
    request.model,
    request.costMicros !== null ? formatCost(request.costMicros) : '',
    turn.mail.length ? `${plural(turn.mail.length, 'message')} sent` : '',
    leftOut ? `${leftOut} left out` : '',
    request.dropped
      ? `${plural(request.dropped, 'suggestion')} could not be used`
      : '',
    turn.notAllowed ? `${turn.notAllowed} not allowed by settings` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="assistant-turn">
      {turn.trigger === 'agent' ? (
        <p className="turn-run meta">
          {runLine(turn.ask, request.createdAt, timeZone)}
        </p>
      ) : (
        <article aria-label="You" className="bubble bubble--me">
          {turn.ask}
        </article>
      )}
      <article aria-label="Assistant" className="bubble bubble--ai">
        {request.reason && (
          <p role="alert" className="form-error">
            {reasons[request.reason]}
            {request.status === 'uncertain' &&
              ` The cost is unknown: up to ${formatCost(request.heldMicros)} stays held against this month’s limit. Nothing is resent.`}
          </p>
        )}
        {request.status === 'failed' && request.reason && onRetry && (
          <button
            type="button"
            className="secondary-button"
            disabled={!online}
            onClick={onRetry}
          >
            Retry
          </button>
        )}
        {request.reply && <p className="assistant__reply">{request.reply}</p>}
        {turn.mailNote && (
          <p role="alert" className="form-error">
            {turn.mailNote}
          </p>
        )}
        {request.resultAvailable &&
          !turn.items.length &&
          !request.reason &&
          !request.reply && <p>No changes proposed.</p>}
        {turn.items.length > 0 && (
          <fieldset className="assistant__changes turn-changes" disabled={busy}>
            <legend>
              {readOnly ? 'From mail · read only' : 'Proposed changes'}
            </legend>
            {readOnly && (
              <Help label="Read-only suggestions">
                Suggestions based on mail can't be applied until their origin
                can be kept. Create the item yourself if you want it.
              </Help>
            )}
            <ul>
              {turn.items.map((item, index) => (
                <li key={item.applyId}>
                  <label className="checkbox-label">
                    {!readOnly && (
                      <input
                        type="checkbox"
                        checked={item.state === 'proposed' && !!selected[index]}
                        disabled={!!pending || item.state !== 'proposed'}
                        onChange={(event) =>
                          setSelected(
                            selected.map((value, at) =>
                              at === index ? event.target.checked : value,
                            ),
                          )
                        }
                      />
                    )}
                    {describeProposal(request.proposals[index]!, timeZone)}
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
              {pending && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!online}
                  onClick={() => {
                    void perform(pending);
                  }}
                >
                  {pending.action === 'apply' ? 'Retry Apply' : 'Retry Undo'}
                </button>
              )}
              {!readOnly && proposed.length > 0 && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!!pending || !chosen || !online}
                  onClick={() => {
                    void apply();
                  }}
                >
                  {busy
                    ? 'Applying…'
                    : `Apply ${chosen} change${chosen === 1 ? '' : 's'}`}
                </button>
              )}
              {applied && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!pending || !online}
                  onClick={() => {
                    void undo();
                  }}
                >
                  Undo
                </button>
              )}
            </div>
          </fieldset>
        )}
        <details className="turn-details">
          <summary>{summary}</summary>
          {turn.mail.length > 0 && (
            <ul>
              {turn.mail.map((item) => (
                <li key={item.id}>
                  <strong>{item.subject || '(no subject)'}</strong>
                  <span className="meta">
                    {item.from ?? 'Unknown sender'} ·{' '}
                    {formatInstant(item.receivedAt)} ·{' '}
                    {item.read
                      ? item.truncated
                        ? 'Body sent (cut)'
                        : 'Body sent'
                      : 'Subject and sender only'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {request.withheld > 0 && (
            <p className="meta">
              {plural(request.withheld, 'planner item')} left out by labels.
            </p>
          )}
          {turn.mailWithheld > 0 && (
            <p className="meta">
              {plural(turn.mailWithheld, 'message')} left out by labels.
            </p>
          )}
        </details>
        <p role="status">{notice}</p>
      </article>
    </div>
  );
}
