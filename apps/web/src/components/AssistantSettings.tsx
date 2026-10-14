import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  assistantModelSchema,
  assistantSettingsResponseSchema,
  defaultAssistantModel,
} from '@hub/contracts';
import { getJson } from '../lib/api';
import { useMutation, useResource } from '../lib/hooks';
import { Help } from './Help';
import { StatusChip } from './StatusChip';

/** Settings › AI › Assistant: the OpenRouter model used on Today. */
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
      <h2 id="assistant-settings-title">
        Assistant{' '}
        {current && (
          <StatusChip tone={current.configured ? 'neutral' : 'attention'}>
            {current.configured ? 'On' : 'Not set up'}
          </StatusChip>
        )}
      </h2>
      <Help label="Assistant">
        The Ask box on Today sends your request, with the titles and times of
        unlabeled open tasks and one-time events, to OpenRouter. Requests are
        pinned to the model maker’s own servers, with no fallback, no data
        retention and no training. Each request must fit your per-request
        spending limit before it is sent. The server’s OpenRouter key is set in
        its environment, never here.
      </Help>
      {settings.error && (
        <p role="alert" className="form-error">
          {settings.error}
        </p>
      )}
      {current && (
        <ModelForm
          key={current.version}
          model={current.model}
          version={current.version}
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
  return (
    <div className="memory-switch">
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={allowed}
          disabled={save.pending}
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
        Allow Personal mail for category suggestions
      </label>
      <Help label="Personal mail">
        Mail labeled Personal is sent to OpenRouter only when this is on and
        only for messages you select in Inbox › Mail. Restricted mail is never
        sent. Off by default.
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

function ModelForm({
  model,
  version,
  onSaved,
}: {
  model: string;
  version: number;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(model);
  const [problem, setProblem] = useState('');
  const save = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!assistantModelSchema.safeParse(trimmed).success) {
      setProblem(
        'Use an OpenRouter model ID such as anthropic/claude-haiku-5.5',
      );
      return;
    }
    const result = await save.run(
      assistantSettingsResponseSchema,
      'PUT',
      '/api/v1/assistant/settings',
      { model: trimmed, expectedVersion: version },
      'Could not save the model. Try again.',
    );
    if (result) onSaved();
  }
  return (
    <form
      className="editor-form"
      aria-label="Assistant model"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <label>
        Model
        <input
          value={value}
          maxLength={100}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={!!problem}
          aria-describedby={problem ? 'assistant-model-error' : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem('');
          }}
        />
      </label>
      <p className="meta">Default: {defaultAssistantModel}</p>
      {problem && (
        <p id="assistant-model-error" className="form-error">
          <span className="visually-hidden">Error: </span>
          {problem}
        </p>
      )}
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
      <div className="form-actions">
        <button
          className="primary-button"
          disabled={save.pending || value.trim() === model}
        >
          {save.pending ? 'Saving…' : 'Save model'}
        </button>
      </div>
    </form>
  );
}
