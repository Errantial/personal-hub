import {
  aiProviderRegistrySchema,
  aiProviderReadinessResponseSchema,
  aiProviderConsentSchema,
} from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import { useMutation, useOnline, useResource } from '../lib/hooks';
import { Help } from './Help';
import { ReadState } from './ReadState';

/** Separate consent for mail selection; never reuses the receiving model's approval. */
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
  const save = useMutation();
  const profile = registry.data?.data.profiles.find(
    (p) => p.alias === 'mail-broker',
  );
  const current = consents.data?.data.profiles.find(
    (p) => p.alias === 'mail-broker',
  );
  const fresh =
    online &&
    !registry.loading &&
    !consents.loading &&
    !registry.error &&
    !consents.error &&
    registry.data?.cachedAt === null &&
    consents.data?.cachedAt === null &&
    registry.data.data.revision === consents.data.data.registryRevision;
  const approved = !!current?.consentCurrent;
  async function reload() {
    save.reset();
    await Promise.all([registry.reload(), consents.reload()]);
  }
  async function setApproval(value: boolean) {
    if (!fresh || !profile || !current || save.pending) return;
    const result = await save.run(
      aiProviderConsentSchema,
      'PUT',
      '/api/v1/ai/provider-consents/mail-broker',
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
            <dd>OpenRouter · {profile.upstreamProvider}</dd>
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
            This approves the displayed destination to judge eligible imported
            mail. The receiving Assistant needs its own approval. Source grants,
            labels, spending limits and endpoint checks still apply. Changed
            server profiles require approval again.
          </Help>
          <div className="actions">
            <button
              type="button"
              disabled={
                !fresh ||
                save.pending ||
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
              disabled={!fresh || save.pending || !current.consent.approved}
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
      {save.error && <p role="alert">{save.error}</p>}
      {(save.conflict || save.code === 'REGISTRY_CONFLICT') && (
        <p role="alert">Broker approval changed. Reload before saving.</p>
      )}
      <button
        type="button"
        disabled={
          !online || save.pending || registry.loading || consents.loading
        }
        onClick={() => void reload()}
      >
        Reload broker approval
      </button>
    </section>
  );
}
