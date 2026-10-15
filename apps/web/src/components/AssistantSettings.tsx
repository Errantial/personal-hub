import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  assistantModelSchema,
  assistantSettingsResponseSchema,
  liveDestinationResponseSchema,
} from '@hub/contracts';
import type { LiveDestinationStatus } from '@hub/contracts';
import { getJson } from '../lib/api';
import { destinationReason } from '../lib/assistant';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import { Help } from './Help';

export function AssistantSettings() {
  const settings = useResource(
    (signal) =>
      getJson(
        '/api/v1/assistant/settings',
        assistantSettingsResponseSchema,
        signal,
      ),
    { failure: 'Assistant settings unavailable. Retry.' },
  );
  const current = settings.data?.settings;
  return (
    <section
      className="panel preference-panel"
      aria-labelledby="assistant-settings-title"
    >
      <h2 id="assistant-settings-title">Assistant</h2>
      {settings.error && (
        <p role="alert" className="form-error">
          {settings.error}
        </p>
      )}
      {current && (
        <AssistantDestination
          key={current.model}
          model={current.model}
          onSaved={() => void settings.reload()}
        />
      )}
      {current && (
        <PersonalMailSwitch
          key={`mail-${current.version}`}
          model={current.model}
          version={current.version}
          allowed={current.allowPersonalMail}
          onSaved={() => void settings.reload()}
        />
      )}
    </section>
  );
}

function AssistantDestination({
  model,
  onSaved,
}: {
  model: string;
  onSaved: () => void;
}) {
  const online = useOnline();
  const [value, setValue] = useState(model);
  const [upstream, setUpstream] = useState('');
  const [problem, setProblem] = useState('');
  const valid = assistantModelSchema.safeParse(value.trim()).success;
  const destination = useResource(
    (signal) =>
      getJson(
        `/api/v1/assistant/destination${valid ? `?model=${encodeURIComponent(value.trim())}` : ''}`,
        liveDestinationResponseSchema,
        signal,
      ),
    {
      failure: 'Destination status unavailable. Retry.',
      key: valid ? value.trim() : '',
    },
  );
  const current = destination.data?.destination;
  const fresh =
    current?.model === value.trim() &&
    !destination.loading &&
    !destination.error;
  useEffect(() => {
    if (current)
      setUpstream(
        current.approved?.model === current.model &&
          current.hosts.includes(current.approved.upstream)
          ? current.approved.upstream
          : (current.hosts[0] ?? ''),
      );
  }, [current]);
  const save = useMutation();
  const unchanged =
    !!current &&
    current.reason !== 'approval-stale' &&
    current.approved?.model === value.trim() &&
    current.approved.upstream === upstream;
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) {
      setProblem(
        'Use an OpenRouter model ID such as anthropic/claude-haiku-5.5',
      );
      return;
    }
    if (!online || !fresh || !current || !upstream || unchanged) return;
    const result = await save.run(
      liveDestinationResponseSchema,
      'PUT',
      '/api/v1/assistant/destination',
      { model: value.trim(), upstream, expectedVersion: current.version },
      'Could not approve the destination. Try again.',
    );
    if (result) {
      onSaved();
      void destination.reload();
    }
  }
  async function revoke() {
    if (!current?.version || !online) return;
    const result = await save.run(
      liveDestinationResponseSchema,
      'DELETE',
      '/api/v1/assistant/destination',
      { expectedVersion: current.version },
      'Could not revoke the destination. Try again.',
    );
    if (result) {
      onSaved();
      void destination.reload();
    }
  }
  return (
    <form
      className="editor-form"
      aria-label="Assistant destination"
      noValidate
      onSubmit={(event) => void approve(event)}
    >
      <h3>Destination</h3>
      {fresh && current && <DestinationState destination={current} />}
      <Help label="Destination">
        Requests go only to this host through OpenRouter, with zero data
        retention. If it is unavailable, nothing is sent; there is no fallback.
      </Help>
      {!online && (
        <p role="status">Offline. Destination status may be out of date.</p>
      )}
      <label>
        Model
        <input
          value={value}
          maxLength={100}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={!!problem}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem('');
          }}
        />
      </label>
      <fieldset disabled={!online || save.pending || !fresh}>
        <legend>Host</legend>
        {fresh &&
          current?.hosts.map((host) => (
            <label className="checkbox-label" key={host}>
              <input
                type="radio"
                name="assistant-host"
                value={host}
                checked={upstream === host}
                onChange={() => setUpstream(host)}
              />
              {host}
            </label>
          ))}
        {fresh && !current?.hosts.length && (
          <p>No supported host for this model</p>
        )}
        {!fresh && (
          <p className="meta">
            {destination.loading
              ? 'Checking hosts…'
              : 'Enter a supported model.'}
          </p>
        )}
      </fieldset>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {(destination.error || save.error) && (
        <div role="alert" className="form-error">
          <p>{save.error || destination.error}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={!online || destination.loading}
            onClick={() => {
              save.reset();
              void destination.reload();
              onSaved();
            }}
          >
            Reload destination
          </button>
        </div>
      )}
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={
            !online ||
            save.pending ||
            unchanged ||
            (valid && (!fresh || !upstream))
          }
        >
          {save.pending ? 'Saving…' : 'Approve'}
        </button>
        {!!current?.approved && (
          <button
            type="button"
            className="secondary-button"
            disabled={!online || save.pending || !fresh}
            onClick={() => void revoke()}
          >
            Revoke
          </button>
        )}
      </div>
    </form>
  );
}
function DestinationState({
  destination,
}: {
  destination: LiveDestinationStatus;
}) {
  return destination.status === 'ready' ? (
    <p role="status">
      Ready: {destination.approved?.model} via OpenRouter →{' '}
      {destination.approved?.upstream}
    </p>
  ) : (
    <p role="status">Blocked: {destinationReason[destination.reason!]}</p>
  );
}

/** Owner permission to send Personal-labeled mail to OpenRouter. */
function PersonalMailSwitch({
  model,
  version,
  allowed,
  onSaved,
}: {
  model: string;
  version: number;
  allowed: boolean;
  onSaved: () => void;
}) {
  const save = useMutation();
  const online = useOnline();
  return (
    <div className="memory-switch">
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={allowed}
          disabled={save.pending || !online}
          onChange={(event) => {
            void save
              .run(
                assistantSettingsResponseSchema,
                'PUT',
                '/api/v1/assistant/settings',
                {
                  model,
                  expectedVersion: version,
                  allowPersonalMail: event.target.checked,
                },
                'Could not change the mail permission. Try again.',
              )
              .then((result) => {
                if (result) onSaved();
              });
          }}
        />
        Allow Personal mail
      </label>
      <Help label="Personal mail">
        Mail labeled Personal may be sent to the approved destination when this
        is on. Assistant asks also need Use mail. Restricted mail is never sent.
        Off by default.
      </Help>
      {save.error && (
        <div role="alert" className="form-error">
          <p>{save.error}</p>
          {save.conflict && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                save.reset();
                onSaved();
              }}
            >
              Reload settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}
