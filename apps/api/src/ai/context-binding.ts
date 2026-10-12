import { createHash } from 'node:crypto';
import type { AIContextManifest } from '@hub/contracts';

// Private integrity binding; never serialize this digest to HTTP/export/logs.
export function boundAIContextHash(
  owner: string,
  requestId: string,
  payload: string,
  manifest: AIContextManifest,
) {
  return createHash('sha256')
    .update(JSON.stringify([owner, requestId, payload, manifest]))
    .digest('hex');
}
