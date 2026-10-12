import { aiProviderRegistrySchema } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Help } from './Help';
import { ReadState } from './ReadState';

/** Server-configured provider profiles, read only. */
export function AIProviders() {
  const registry = useResource(
    (signal) =>
      getSnapshot('/api/v1/ai/providers', aiProviderRegistrySchema, signal),
    { failure: 'Providers unavailable. Retry providers.' },
  );
  const profiles = registry.data?.data.profiles;
  return (
    <section className="panel preference-panel" aria-label="AI providers">
      <h2>Providers</h2>
      <Help label="Providers">
        Profiles come from server configuration and cannot be edited here.
        Configured means an enabled profile has a credential; it does not prove
        provider access, model support or availability.
      </Help>
      <ReadState resource={registry} label="providers" />
      {profiles && !profiles.length && <p>No server profiles.</p>}
      {profiles?.map((profile) => (
        <details key={profile.alias}>
          <summary>
            {profile.alias} · {profile.configuration.replaceAll('_', ' ')}
          </summary>
          <dl>
            <dt>Model</dt>
            <dd>{profile.model}</dd>
            <dt>Adapter</dt>
            <dd>{profile.adapter}</dd>
            <dt>Input character limit</dt>
            <dd>{profile.maxInputCharacters}</dd>
            <dt>Output token limit</dt>
            <dd>{profile.maxOutputTokens}</dd>
          </dl>
        </details>
      ))}
    </section>
  );
}
