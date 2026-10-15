import { createHash } from 'node:crypto';

/** Stable per-run attempt identity, shared by dispatch and metadata accounting. */
export function attemptOperation(runId: string, attempt: number) {
  const hex = createHash('sha256')
    .update(`${runId}:attempt:${attempt}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
