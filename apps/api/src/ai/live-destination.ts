import type { LiveDestinationStatus, sensitivitySchema } from '@hub/contracts';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { readAssistantSettings } from './live-request.js';
import { destinationRevision, hostsFor } from './openrouter-live.js';

// The owner's approved live destination (docs/ai-assistant.md): one
// OpenRouter model pinned to one server-declared upstream. Nothing is
// pre-approved, and a stale approval blocks; there is never a fallback.

export type LiveDestination = {
  model: string;
  upstream: string;
  revision: string;
  version: number;
};

/** Labels the approved destination may receive. Restricted never. */
export const liveAllowedLabels = (settings: {
  allowPersonalMail: boolean;
}): z.infer<typeof sensitivitySchema>[] =>
  settings.allowPersonalMail ? ['unlabeled', 'personal'] : ['unlabeled'];

export async function readLiveDestination(
  tx: QueryExecutor,
  config: Config,
  owner: string,
  previewModel?: string,
): Promise<{
  status: LiveDestinationStatus;
  destination: LiveDestination | null;
}> {
  const settings = await readAssistantSettings(tx, owner);
  const model = previewModel ?? settings.model;
  const [row] = await tx.query(
    'SELECT model,upstream,revision,version,revoked FROM ai_live_destinations WHERE owner_id=$1',
    [owner],
  );
  const hosts = hostsFor(model) ?? [];
  const approved =
    row && !row.revoked
      ? { model: row.model as string, upstream: row.upstream as string }
      : null;
  const reason: LiveDestinationStatus['reason'] = !config.AI_SECRET_OPENROUTER
    ? 'key-missing'
    : !hostsFor(model)
      ? 'model-unsupported'
      : !row || row.revoked
        ? 'approval-required'
        : row.model !== model ||
            !hosts.includes(row.upstream as string) ||
            row.revision !==
              destinationRevision(row.model as string, row.upstream as string)
          ? 'approval-stale'
          : null;
  return {
    status: {
      status: reason ? 'blocked' : 'ready',
      reason,
      approved,
      model,
      hosts,
      personalMail: settings.allowPersonalMail,
      version: (row?.version as number | undefined) ?? 0,
    },
    destination:
      row && !reason
        ? {
            model: row.model as string,
            upstream: row.upstream as string,
            revision: row.revision as string,
            version: row.version as number,
          }
        : null,
  };
}

/** The ready destination, or the visible reason nothing can be sent. */
export async function resolveLiveDestination(
  tx: QueryExecutor,
  config: Config,
  owner: string,
): Promise<LiveDestination> {
  const { status, destination } = await readLiveDestination(tx, config, owner);
  if (destination) return destination;
  switch (status.reason) {
    case 'key-missing':
      throw new ApiError(
        409,
        'ASSISTANT_NOT_CONFIGURED',
        'The server has no OpenRouter key.',
      );
    case 'model-unsupported':
      throw new ApiError(
        409,
        'ASSISTANT_MODEL_UNSUPPORTED',
        'Use a model from a supported provider.',
      );
    case 'approval-required':
      throw new ApiError(
        409,
        'ASSISTANT_ROUTE_UNSET',
        'Approve a destination in Settings › AI › Assistant.',
      );
    default:
      throw new ApiError(
        409,
        'ASSISTANT_ROUTE_UNAVAILABLE',
        'The approved destination changed. Approve it again in Settings › AI › Assistant.',
      );
  }
}

/**
 * Approves one declared model and upstream, saving the model as the
 * Assistant setting in the same transaction so receipts report it.
 */
export async function approveLiveDestination(
  tx: QueryExecutor,
  owner: string,
  input: { model: string; upstream: string; expectedVersion: number },
) {
  if (!hostsFor(input.model)?.includes(input.upstream))
    throw new ApiError(
      400,
      'DESTINATION_UNDECLARED',
      'This host is not available for that model.',
    );
  const revision = destinationRevision(input.model, input.upstream);
  const written =
    input.expectedVersion === 0
      ? await tx.query(
          'INSERT INTO ai_live_destinations(owner_id,model,upstream,revision,version) VALUES($1,$2,$3,$4,1) ON CONFLICT(owner_id) DO NOTHING RETURNING version',
          [owner, input.model, input.upstream, revision],
        )
      : await tx.query(
          'UPDATE ai_live_destinations SET model=$2,upstream=$3,revision=$4,revoked=false,version=version+1,approved_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$5 RETURNING version',
          [owner, input.model, input.upstream, revision, input.expectedVersion],
        );
  if (!written.length) throw versionConflict();
  const current = await readAssistantSettings(tx, owner);
  if (current.model !== input.model)
    await tx.query(
      `INSERT INTO ai_assistant_settings(owner_id,model,version) VALUES($1,$2,2)
     ON CONFLICT(owner_id) DO UPDATE SET model=$2,version=ai_assistant_settings.version+1,updated_at=CURRENT_TIMESTAMP
     WHERE ai_assistant_settings.model<>$2`,
      [owner, input.model],
    );
}

/** Revokes the approval; every live request blocks until a new one. */
export async function revokeLiveDestination(
  tx: QueryExecutor,
  owner: string,
  expectedVersion: number,
) {
  const [row] = await tx.query(
    'SELECT version FROM ai_live_destinations WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  if (!row) {
    if (expectedVersion !== 0) throw versionConflict();
    return;
  }
  if (row.version !== expectedVersion) throw versionConflict();
  await tx.query(
    'UPDATE ai_live_destinations SET revoked=true,version=version+1 WHERE owner_id=$1',
    [owner],
  );
}

const versionConflict = () =>
  new ApiError(
    409,
    'VERSION_CONFLICT',
    'The destination changed on another device. Reload and try again.',
  );
