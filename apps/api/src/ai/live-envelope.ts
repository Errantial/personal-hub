import { boundLiveHash } from './context-binding.js';

// Sealed live envelopes (docs/live-context-admission-design.md). A request
// body is serialized exactly once; admission binds those bytes and the
// manifest under a private integrity hash, and transport sends the same
// bytes. Nothing may rebuild or edit a body after sealing.

export type SealedEnvelope<Manifest = unknown> = Readonly<{
  requestId: string;
  owner: string;
  bytes: string;
  model: string;
  maxTokens: number;
  manifest: Manifest;
  /** Private: never serialize to HTTP, export, logs or notifications. */
  integrityHash: string;
}>;

export function sealEnvelope<Manifest>(
  owner: string,
  requestId: string,
  body: { model: string; max_tokens: number },
  manifest: Manifest,
): SealedEnvelope<Manifest> {
  const bytes = JSON.stringify(body);
  // Freeze a structural copy so later edits to the caller's objects cannot
  // reach the bound manifest.
  const bound = deepFreeze(structuredClone(manifest));
  return Object.freeze({
    requestId,
    owner,
    bytes,
    model: body.model,
    maxTokens: body.max_tokens,
    manifest: bound,
    integrityHash: boundLiveHash(owner, requestId, bytes, bound),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
