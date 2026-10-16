import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  agentsResponseSchema,
  emailConnectorsResponseSchema,
  mailBrokerGrantResponseSchema,
  mailBrokerGrantsResponseSchema,
  mailBrokerReadinessSchema,
} from '@hub/contracts';
import type { EmailConnector, MailBrokerGrant } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import { Help } from './Help';
import { ReadState } from './ReadState';
import { BrokerDestinationApproval } from './BrokerDestinationApproval';

/** Why the broker cannot run yet. Server codes stay internal; this is the copy. */
const blockers: Record<string, string> = {
  PROVIDER_UNAVAILABLE: 'The broker profile is not configured on the server.',
  PINNED_MODEL_REQUIRED:
    'The broker profile needs a pinned model before it can judge mail.',
  RETENTION_REQUIRED:
    'The broker profile needs OpenRouter and upstream retention terms before approval.',
  CONSENT_REQUIRED: 'Approve the broker destination below.',
  QUOTE_REQUIRED:
    'The broker profile needs verified pricing that covers the whole envelope.',
  DOWNSTREAM_BLOCKED:
    'The Assistant destination is not approved, so selected mail could not be sent.',
  ROUTE_BLOCKED:
    'No approved route allows this mail to the broker. Check Permissions.',
  BUDGET_UNSET: 'Set a spending limit before using the broker.',
  BUDGET_EXHAUSTED: 'This month’s limit is used up.',
};
const blockerText = (code: string) =>
  blockers[code] ??
  'The broker cannot run until the operator fixes the server configuration.';

const day = (value: string | null) => (value ? value.slice(0, 10) : '');
/** Owner-facing day bounds cover the whole day, not one instant inside it. */
const startOfDay = (value: string) => `${value}T00:00:00.000Z`;
const endOfDay = (value: string) => `${value}T23:59:59.999Z`;
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Settings › AI › Mail access (J4). Brokered mail needs an explicit, versioned
 * grant per owner or agent; an existing Use mail choice never creates one.
 */
export function MailBrokerSettings() {
  const readiness = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/mail-broker/readiness',
        mailBrokerReadinessSchema,
        signal,
      ),
    { failure: 'Broker status unavailable. Retry.' },
  );
  const grants = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/mail-broker/grants',
        mailBrokerGrantsResponseSchema,
        signal,
      ),
    { failure: 'Mail access unavailable. Retry.' },
  );
  const connectors = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/email/connectors',
        emailConnectorsResponseSchema,
        signal,
      ),
    { failure: 'Mail connectors unavailable. Retry.' },
  );
  const agents = useResource(
    (signal) => getSnapshot('/api/v1/agents', agentsResponseSchema, signal),
    { failure: 'Agents unavailable. Retry.' },
  );
  const state = readiness.data?.data;
  const saved = grants.data?.data.grants ?? [];
  const sources = connectors.data?.data.connectors ?? [];
  const agentsHere = agents.data?.data.agents ?? [];
  const blocked =
    state && state.status !== 'ready' ? state.blockers : undefined;
  const reload = () => {
    void grants.reload();
    void readiness.reload();
  };
  return (
    <section
      className="panel preference-panel"
      aria-label="Brokered mail access"
    >
      <h2>Mail access</h2>
      <Help label="Mail access">
        With Use mail, the Assistant model does not search or read mail itself.
        A broker judges imported mail and returns only the messages it finds
        relevant, then the Assistant receives those bodies once. Only the
        connectors and window allowed here are inspected, and Restricted mail is
        never sent. Without a grant a mail ask stops with an explanation; it
        never falls back to another destination. Use mail alone does not approve
        this.
      </Help>
      <ReadState resource={readiness} label="broker status" />
      {state?.destination && (
        <p className="meta">
          Broker: {state.destination.model} · OpenRouter ·{' '}
          {state.destination.upstream}
        </p>
      )}
      <Help label="Broker endpoint checks">
        Broker approval is separate from the Assistant destination. The server
        checks the pinned endpoint's zero retention, structured outputs and
        published price before each batch. Configured status does not prove
        availability or mail quality.
      </Help>
      {state &&
        (state.status === 'ready' ? (
          <p role="status">
            Broker configured ·{' '}
            {state.downstream === 'ready'
              ? 'destination ready'
              : 'destination blocked'}
          </p>
        ) : (
          <div role="status">
            <p>Mail asks are blocked:</p>
            <ul>
              {[...new Set(state.blockers)].map((code) => (
                <li key={code}>{blockerText(code)}</li>
              ))}
            </ul>
          </div>
        ))}
      <ReadState resource={grants} label="mail access" />
      {state?.destination && <BrokerDestinationApproval onSaved={reload} />}
      <BrokerGrantForm
        target="owner"
        heading="Assistant asks"
        grant={saved.find((item) => item.agentId === null)}
        connectors={sources}
        blocked={blocked}
        onSaved={reload}
      />
      <ReadState resource={agents} label="agents" />
      {!agents.loading && !agents.error && !agentsHere.length && (
        <p className="meta">No scheduled agents.</p>
      )}
      {agentsHere.map((agent) => (
        <BrokerGrantForm
          key={agent.id}
          target={agent.id}
          heading={agent.title}
          grant={saved.find((item) => item.agentId === agent.id)}
          connectors={sources}
          blocked={blocked}
          onSaved={reload}
        />
      ))}
    </section>
  );
}

function BrokerGrantForm({
  target,
  heading,
  grant,
  connectors,
  blocked,
  onSaved,
}: {
  target: string;
  heading: string;
  grant: MailBrokerGrant | undefined;
  connectors: EmailConnector[];
  blocked: string[] | undefined;
  onSaved: () => void;
}) {
  const online = useOnline();
  const save = useMutation();
  const [enabled, setEnabled] = useState(!!grant?.enabled);
  const [chosen, setChosen] = useState<string[]>(
    grant?.scope.connectorIds ?? [],
  );
  const [after, setAfter] = useState(day(grant?.scope.receivedAfter ?? null));
  const [before, setBefore] = useState(
    day(grant?.scope.receivedBefore ?? null),
  );
  const version = grant?.version ?? 0;
  const applySaved = () => {
    setEnabled(!!grant?.enabled);
    setChosen(grant?.scope.connectorIds ?? []);
    setAfter(day(grant?.scope.receivedAfter ?? null));
    setBefore(day(grant?.scope.receivedBefore ?? null));
  };
  // A save elsewhere is authoritative; the form follows it instead of guessing.
  useEffect(() => {
    applySaved();
  }, [grant?.id, grant?.version]);
  const live = connectors.filter((item) => !item.revokedAt);
  const unusable = chosen.filter((id) => !live.some((item) => item.id === id));
  const inverted = !!after && !!before && startOfDay(after) >= endOfDay(before);
  const emptyScope = !enabled && chosen.length === 0;
  const invalid = inverted || emptyScope;
  const unchanged =
    !!grant &&
    grant.enabled === enabled &&
    JSON.stringify(grant.scope.connectorIds) === JSON.stringify(chosen) &&
    day(grant.scope.receivedAfter) === after &&
    day(grant.scope.receivedBefore) === before;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || invalid) return;
    const result = await save.run(
      mailBrokerGrantResponseSchema,
      'PUT',
      `/api/v1/mail-broker/grants/${target}`,
      {
        operationId: crypto.randomUUID(),
        expectedVersion: version,
        enabled,
        scope: {
          connectorIds: chosen,
          receivedAfter: after ? startOfDay(after) : null,
          receivedBefore: before ? endOfDay(before) : null,
        },
      },
      'Could not save mail access. Your choices are still here.',
    );
    if (result) onSaved();
  }
  const summary = grant?.enabled
    ? `On · ${plural(chosen.length, 'source')}${
        after || before
          ? ` · ${after || 'earliest'} to ${before || 'latest'}`
          : ''
      }`
    : 'Off';
  return (
    <form
      className="editor-form"
      aria-label={`Mail access for ${heading}`}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <h3>{heading}</h3>
      <p role="status">
        {summary}
        {grant?.enabled && unusable.length
          ? ` · ${plural(unusable.length, 'chosen source')} revoked or missing`
          : ''}
      </p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          disabled={save.pending || !online}
          onChange={(event) => {
            setEnabled(event.target.checked);
          }}
        />
        Allow brokered mail
      </label>
      <fieldset disabled={save.pending || !online}>
        <legend>Mail sources</legend>
        {connectors.length === 0 && (
          <p className="meta">Add a mail connector under Connections first.</p>
        )}
        {connectors.map((item) => (
          <label className="checkbox-label" key={item.id}>
            <input
              type="checkbox"
              checked={chosen.includes(item.id)}
              disabled={!!item.revokedAt}
              onChange={(event) => {
                setChosen((previous) =>
                  event.target.checked
                    ? [...previous, item.id]
                    : previous.filter((id) => id !== item.id),
                );
              }}
            />
            {item.name}
            {item.revokedAt ? ' (revoked)' : ''}
          </label>
        ))}
      </fieldset>
      <label>
        From
        <input
          type="date"
          value={after}
          max={before || undefined}
          disabled={save.pending || !online}
          onChange={(event) => {
            setAfter(event.target.value);
          }}
        />
      </label>
      <label>
        To
        <input
          type="date"
          value={before}
          min={after || undefined}
          disabled={save.pending || !online}
          onChange={(event) => {
            setBefore(event.target.value);
          }}
        />
      </label>
      <Help label="Window">
        Optional. Only imported mail received inside this window is inspected.
        Mail that arrives later is not added to an answer that already finished.
        Leave both empty to allow everything already imported.
      </Help>
      {inverted && (
        <p role="alert" className="form-error">
          The window ends before it starts.
        </p>
      )}
      {emptyScope && (
        <p role="alert" className="form-error">
          Choose at least one mail source, or turn access off.
        </p>
      )}
      {!!blocked?.length && (
        <p className="meta">
          Saved scopes are kept, but mail asks stay blocked until the broker is
          configured above.
        </p>
      )}
      {(save.error || save.conflict) && (
        <div role="alert" className="form-error">
          <p>{save.error}</p>
          {save.conflict && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                save.reset();
                // A deliberate reload discards the draft and shows saved values.
                applySaved();
                onSaved();
              }}
            >
              Reload mail access
            </button>
          )}
        </div>
      )}
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={!online || save.pending || invalid || unchanged}
        >
          {save.pending ? 'Saving…' : 'Save mail access'}
        </button>
      </div>
    </form>
  );
}
