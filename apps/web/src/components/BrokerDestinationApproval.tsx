import { useEffect, useState } from 'react';
import {
  aiProviderRegistrySchema,
  aiProviderReadinessResponseSchema,
  aiProviderConsentSchema,
  mailBrokerSettingsResponseSchema,
} from '@hub/contracts';
import type { MailBrokerAlias } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import { Help } from './Help';
import { ReadState } from './ReadState';

const classifierName = (alias: MailBrokerAlias) =>
  alias === 'mail-broker' ? 'OpenRouter / Gemini' : 'Jev / TypeSafe';

/** Separate classifier selection and provider consent; neither changes mail grants. */
export function BrokerDestinationApproval({
  onSaved,
}: {
  onSaved: () => void;
}) {
  const online = useOnline();
  const registry = useResource(
    (signal) =>
      getSnapshot('/api/v1/ai/providers', aiProviderRegistrySchema, signal),
    { failure: 'Broker profile unavailable. Reload.' },
  );
  const consents = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/ai/provider-readiness',
        aiProviderReadinessResponseSchema,
        signal,
      ),
    { failure: 'Broker approval unavailable. Reload.' },
  );
  const settings = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/mail-broker/settings',
        mailBrokerSettingsResponseSchema,
        signal,
      ),
    { failure: 'Mail classifier unavailable. Reload.' },
  );
  const selectionSave = useMutation();
  const approvalSave = useMutation();
  const savedSettings = settings.data?.data.settings;
  const selectedAlias = savedSettings?.selectedAlias ?? 'mail-broker';
  const [draftAlias, setDraftAlias] = useState<MailBrokerAlias>(selectedAlias);

  useEffect(() => {
    if (savedSettings) setDraftAlias(savedSettings.selectedAlias);
  }, [savedSettings?.version, savedSettings?.selectedAlias]);

  const profiles = registry.data?.data.profiles ?? [];
  const profile = profiles.find((item) => item.alias === selectedAlias);
  const current = consents.data?.data.profiles.find(
    (item) => item.alias === selectedAlias,
  );
  const selectedDraftProfile = profiles.find(
    (item) => item.alias === draftAlias,
  );
  const settingsFresh =
    online &&
    !settings.loading &&
    !registry.loading &&
    !settings.error &&
    !registry.error &&
    settings.data?.cachedAt === null &&
    registry.data?.cachedAt === null;
  const approvalFresh =
    settingsFresh &&
    draftAlias === selectedAlias &&
    !consents.loading &&
    !consents.error &&
    consents.data?.cachedAt === null &&
    registry.data?.data.revision === consents.data?.data.registryRevision;
  const approved = !!current?.consentCurrent;

  async function reload() {
    selectionSave.reset();
    approvalSave.reset();
    await Promise.all([
      registry.reload(),
      consents.reload(),
      settings.reload(),
    ]);
  }

  async function saveClassifier() {
    if (
      !settingsFresh ||
      !savedSettings ||
      !selectedDraftProfile ||
      draftAlias === selectedAlias ||
      selectionSave.pending
    )
      return;
    const result = await selectionSave.run(
      mailBrokerSettingsResponseSchema,
      'PUT',
      '/api/v1/mail-broker/settings',
      {
        expectedVersion: savedSettings.version,
        selectedAlias: draftAlias,
      },
      'Could not save the mail classifier. Reload and try again.',
    );
    if (result) {
      setDraftAlias(result.settings.selectedAlias);
      await reload();
      onSaved();
    }
  }

  async function setApproval(value: boolean) {
    if (!approvalFresh || !profile || !current || approvalSave.pending) return;
    const result = await approvalSave.run(
      aiProviderConsentSchema,
      'PUT',
      `/api/v1/ai/provider-consents/${selectedAlias}`,
      {
        approved: value,
        expectedVersion: current.consent.version,
        expectedRegistryRevision: registry.data!.data.revision,
      },
      'Could not save broker approval. Reload and try again.',
    );
    if (result) {
      await reload();
      onSaved();
    }
  }

  return (
    <section aria-label="Broker destination approval">
      <h3>Mail classifier</h3>
      <ReadState
        resource={settings}
        label="mail classifier"
        showReload={false}
      />
      <label>
        Classifier
        <select
          aria-label="Mail classifier"
          value={draftAlias}
          disabled={!settingsFresh || selectionSave.pending}
          onChange={(event) =>
            setDraftAlias(event.target.value as MailBrokerAlias)
          }
        >
          <option
            value="mail-broker"
            disabled={!profiles.some((p) => p.alias === 'mail-broker')}
          >
            OpenRouter / Gemini (default)
          </option>
          <option
            value="jev-mail"
            disabled={!profiles.some((p) => p.alias === 'jev-mail')}
          >
            Jev / TypeSafe
          </option>
        </select>
      </label>
      <p role="status">
        Selected: {classifierName(selectedAlias)} · version{' '}
        {savedSettings?.version ?? 1}
      </p>
      <Help label="Mail classifier">
        This chooses which approved classifier handles future brokered-mail
        retrievals. Saving it does not approve a provider, change mail grants or
        change the receiving Assistant. There is no fallback between
        classifiers. Unfinished searches become stale after a switch; completed
        history keeps the classifier that originally judged it.
      </Help>
      <div className="actions">
        <button
          type="button"
          disabled={
            !settingsFresh ||
            selectionSave.pending ||
            !savedSettings ||
            !selectedDraftProfile ||
            draftAlias === selectedAlias
          }
          onClick={() => void saveClassifier()}
        >
          Save classifier
        </button>
      </div>
      {selectionSave.error && <p role="alert">{selectionSave.error}</p>}
      {selectionSave.conflict && (
        <p role="alert">Mail classifier changed. Reload before saving.</p>
      )}

      <h3>Broker destination</h3>
      <ReadState
        resource={registry}
        label="broker profile"
        showReload={false}
      />
      <ReadState
        resource={consents}
        label="broker approval"
        showReload={false}
      />
      {!registry.loading && !registry.error && !profile && (
        <p role="alert">
          The selected classifier is not configured. Choose an available
          classifier above.
        </p>
      )}
      {profile && current && (
        <>
          <p role="status">
            {approved
              ? 'Broker approved'
              : current.consent.approved
                ? 'Broker approval stale'
                : 'Broker approval required'}
          </p>
          <dl>
            <dt>Model</dt>
            <dd>{profile.model}</dd>
            <dt>Route</dt>
            <dd>
              {profile.adapter === 'openrouter'
                ? `OpenRouter · ${profile.upstreamProvider}`
                : 'TypeSafe · direct'}
            </dd>
            <dt>Retention terms</dt>
            <dd>{profile.retentionDisclosure?.summary ?? 'Not configured'}</dd>
            <dt>Input / output per million tokens</dt>
            <dd>
              {profile.pricing
                ? `$${profile.pricing.inputMicrosPerMillionTokens / 1e6} / $${profile.pricing.outputMicrosPerMillionTokens / 1e6}`
                : 'Not configured'}
            </dd>
          </dl>
          <Help label="Broker approval">
            This approves the displayed classifier to judge eligible imported
            mail. The receiving Assistant needs its own approval. Source grants,
            labels and spending limits still apply. Changed server profiles
            require approval again.
          </Help>
          <div className="actions">
            <button
              type="button"
              disabled={
                !approvalFresh ||
                approvalSave.pending ||
                approved ||
                profile.configuration !== 'configured' ||
                !profile.retentionDisclosure ||
                !current.quote
              }
              onClick={() => void setApproval(true)}
            >
              Approve broker
            </button>
            <button
              type="button"
              disabled={
                !approvalFresh ||
                approvalSave.pending ||
                !current.consent.approved
              }
              onClick={() => void setApproval(false)}
            >
              Revoke broker
            </button>
          </div>
        </>
      )}
      {!online && (
        <p role="status">Offline · broker approval cannot be changed.</p>
      )}
      {approvalSave.error && <p role="alert">{approvalSave.error}</p>}
      {(approvalSave.conflict || approvalSave.code === 'REGISTRY_CONFLICT') && (
        <p role="alert">Broker approval changed. Reload before saving.</p>
      )}
      <button
        type="button"
        disabled={
          !online ||
          selectionSave.pending ||
          approvalSave.pending ||
          registry.loading ||
          consents.loading ||
          settings.loading
        }
        onClick={() => void reload()}
      >
        Reload broker approval
      </button>
    </section>
  );
}
