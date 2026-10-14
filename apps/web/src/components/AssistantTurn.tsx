import { useState } from 'react';
import {
  assistantTurnResponseSchema,
  calendarResponseSchema,
  taskResponseSchema,
} from '@hub/contracts';
import type {
  AssistantItem,
  AssistantRequest,
  AssistantTurn,
} from '@hub/contracts';
import { RequestError, liveRequestJson } from '../lib/api';
import {
  applyRequest,
  describeProposal,
  formatCost,
  undoRequest,
} from '../lib/assistant';
import type { PlannedRequest } from '../lib/assistant';
import { formatInstant } from '../lib/format';
import { useOnline } from '../lib/hooks';

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
 * One ask and its answer: reply, cost and proposed changes. Apply and Undo
 * use the ordinary versioned writes with the turn's stored write IDs, and
 * their results are saved so every device shows them.
 */
export function AssistantTurnView({
  turn,
  onTurn,
  onApplied,
  onStale,
}: {
  turn: AssistantTurn;
  /** The turn after its applied state was saved. */
  onTurn: (turn: AssistantTurn) => void;
  /** Reloads planner lists after changes. */
  onApplied: () => void;
  /** Another device changed this turn; reload it. */
  onStale: () => void;
}) {
  const online = useOnline();
  const request = turn.request;
  const [selected, setSelected] = useState<boolean[]>(() =>
    turn.items.map(() => true),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /** Saves item states; a newer version elsewhere asks for a reload. */
  async function save(items: AssistantItem[]) {
    try {
      const { turn: saved } = await liveRequestJson(
        `/api/v1/assistant/turns/${turn.id}/items`,
        assistantTurnResponseSchema,
        { method: 'PUT', body: { expectedVersion: turn.version, items } },
      );
      onTurn(saved);
    } catch (error) {
      if (error instanceof RequestError && error.code === 'VERSION_CONFLICT')
        onStale();
      else
        setNotice(
          'The changes were made, but this device could not record them. Reload before undoing.',
        );
    }
  }

  async function apply() {
    setBusy(true);
    const next = [...turn.items];
    for (const [index, item] of next.entries()) {
      if (!selected[index] || item.state !== 'proposed') continue;
      try {
        const record = await send(
          applyRequest(request.proposals[index]!, item.applyId),
        );
        next[index] = {
          ...item,
          state: 'applied',
          applied: { id: record.id, version: record.version },
          error: null,
        };
      } catch (error) {
        next[index] = { ...item, state: 'failed', error: failure(error) };
      }
    }
    const count = next.filter((item) => item.state === 'applied').length;
    setNotice(count ? `Applied ${count} change${count === 1 ? '' : 's'}.` : '');
    await save(next);
    setBusy(false);
    if (count) onApplied();
  }

  async function undo() {
    setBusy(true);
    const next = [...turn.items];
    // Newest first, so later changes to the same item are reversed first.
    for (const [index, item] of [...next.entries()].reverse()) {
      if (item.state !== 'applied' || !item.applied) continue;
      try {
        await send(
          undoRequest(request.proposals[index]!, item.applied, item.undoId),
        );
        next[index] = { ...item, state: 'undone', error: null };
      } catch (error) {
        next[index] = { ...item, error: failure(error) };
      }
    }
    const left = next.filter((item) => item.state === 'applied').length;
    setNotice(left ? 'Some changes could not be undone.' : 'Changes undone.');
    await save(next);
    setBusy(false);
    onApplied();
  }

  const proposed = turn.items.filter((item) => item.state === 'proposed');
  const chosen = turn.items.filter(
    (item, index) => item.state === 'proposed' && selected[index],
  ).length;
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
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="assistant-turn">
      <article aria-label="You" className="bubble bubble--me">
        {turn.ask}
      </article>
      <article aria-label="Assistant" className="bubble bubble--ai">
        {request.reason && (
          <p role="alert" className="form-error">
            {reasons[request.reason]}
            {request.status === 'uncertain' &&
              ` The cost is unknown: up to ${formatCost(request.heldMicros)} stays held against this month’s limit. Nothing is resent.`}
          </p>
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
            <legend>Proposed changes</legend>
            <ul>
              {turn.items.map((item, index) => (
                <li key={item.applyId}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={item.state === 'proposed' && !!selected[index]}
                      disabled={item.state !== 'proposed'}
                      onChange={(event) =>
                        setSelected(
                          selected.map((value, at) =>
                            at === index ? event.target.checked : value,
                          ),
                        )
                      }
                    />
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
              {proposed.length > 0 && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={!chosen || !online}
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
                  disabled={!online}
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
                    {item.read ? 'Body sent' : 'Subject and sender only'}
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
