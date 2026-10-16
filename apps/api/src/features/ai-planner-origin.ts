import { createHash } from 'node:crypto';
import { sensitivitySchema } from '@hub/contracts';
import type {
  AssistantItem,
  AssistantProposal,
  AssistantStudySuggestion,
} from '@hub/contracts';
import { z } from 'zod';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { liveAllowedLabels } from '../ai/live-destination.js';
import { historySourcesEligible } from '../ai/live-history.js';
import {
  historyRefs,
  liveHistorySourceSchema,
  liveManifestSchema,
  maxHistorySources,
} from '../ai/live-manifest.js';
import type { LiveHistorySource } from '../ai/live-manifest.js';
import { readAssistantSettings } from '../ai/live-request.js';

export type Sensitivity = z.infer<typeof sensitivitySchema>;

export type OriginCapture = {
  requestId: string;
  labels: Sensitivity[];
  sources: LiveHistorySource[];
  useMail: boolean;
  destination: {
    model: string;
    upstream: string;
    revision: string;
    version: number;
  };
};

export const originCaptureSchema = z.strictObject({
  requestId: z.string().uuid(),
  labels: z.array(sensitivitySchema).min(1).max(3),
  sources: z.array(liveHistorySourceSchema).max(maxHistorySources),
  useMail: z.boolean().default(false),
  destination: z.strictObject({
    model: z.string(),
    upstream: z.string(),
    revision: z.string(),
    version: z.number().int().positive(),
  }),
});

export type VerifiedTurnOrigin = {
  capture: OriginCapture;
  digests: Record<string, string>;
};

/** Recursively sorts object keys so jsonb round-trips hash identically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export const proposalDigest = (
  owner: string,
  turnId: string,
  applyId: string,
  proposal: AssistantProposal | AssistantStudySuggestion,
) =>
  createHash('sha256')
    .update(JSON.stringify([owner, turnId, applyId, canonical(proposal)]))
    .digest('hex');

export async function captureTurnOrigin(
  tx: QueryExecutor,
  owner: string,
  turnId: string,
  requestId: string,
  proposals: AssistantProposal[],
  items: AssistantItem[],
  studySuggestions: AssistantStudySuggestion[] = [],
): Promise<void> {
  if (proposals.length !== items.length) return;
  const [exchange] = await tx.query(
    "SELECT manifest FROM ai_live_exchanges WHERE owner_id=$1 AND request_id=$2 AND guard_state='verified'",
    [owner, requestId],
  );
  if (!exchange) return;
  const manifest = liveManifestSchema.parse(
    typeof exchange.manifest === 'string'
      ? JSON.parse(exchange.manifest)
      : exchange.manifest,
  );
  const sources = historyRefs(manifest);
  if (sources.length > maxHistorySources) return;

  const proposalDigests: Record<string, string> = {};
  for (const suggestion of studySuggestions)
    proposalDigests[suggestion.id] = proposalDigest(
      owner,
      turnId,
      suggestion.id,
      suggestion,
    );
  for (const [index, proposal] of proposals.entries()) {
    const item = items[index]!;
    proposalDigests[item.applyId] = proposalDigest(
      owner,
      turnId,
      item.applyId,
      proposal,
    );
  }

  const labelSet = new Set<Sensitivity>([
    ...manifest.request.labels,
    ...manifest.sources.flatMap((s) => s.labels),
    ...manifest.history.sources.flatMap((s) => s.labels),
  ]);
  const labels = Array.from(labelSet).sort() as Sensitivity[];

  const capture: OriginCapture = {
    requestId,
    labels: labels.length ? labels : ['unlabeled'],
    sources,
    useMail: manifest.useMail,
    destination: {
      model: manifest.destination.model,
      upstream: manifest.destination.upstream,
      revision: manifest.destination.revision,
      version: manifest.destination.version,
    },
  };

  await tx.query(
    `INSERT INTO ai_turn_origins (owner_id, turn_id, request_id, capture, proposal_digests)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     ON CONFLICT (turn_id) DO UPDATE SET
       request_id = EXCLUDED.request_id,
       capture = EXCLUDED.capture,
       proposal_digests = EXCLUDED.proposal_digests`,
    [
      owner,
      turnId,
      requestId,
      JSON.stringify(capture),
      JSON.stringify(proposalDigests),
    ],
  );
}

const provenanceFailed = () =>
  new ApiError(
    409,
    'PROVENANCE_REQUIRED',
    'This suggestion cannot be applied because its origin could not be verified.',
  );

export async function verifyTurnOrigin(
  tx: QueryExecutor,
  owner: string,
  turnId: string,
): Promise<VerifiedTurnOrigin> {
  const [row] = await tx.query(
    'SELECT capture, proposal_digests FROM ai_turn_origins WHERE owner_id=$1 AND turn_id=$2',
    [owner, turnId],
  );
  if (!row) throw provenanceFailed();
  let parsedCapture;
  let parsedDigests;
  try {
    parsedCapture = originCaptureSchema.safeParse(
      typeof row.capture === 'string' ? JSON.parse(row.capture) : row.capture,
    );
    parsedDigests = z
      .record(z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/))
      .safeParse(
        typeof row.proposal_digests === 'string'
          ? JSON.parse(row.proposal_digests)
          : row.proposal_digests,
      );
  } catch {
    throw provenanceFailed();
  }
  if (!parsedCapture.success || !parsedDigests.success) {
    throw provenanceFailed();
  }
  const capture = parsedCapture.data;
  const settings = await readAssistantSettings(tx, owner);
  const allowed = liveAllowedLabels(settings);
  if (
    capture.labels.some((label) => !allowed.includes(label)) ||
    !(await historySourcesEligible(tx, owner, capture.sources, {
      allowed,
      useMail: capture.useMail,
    }))
  ) {
    throw new ApiError(
      409,
      'PROVENANCE_UNAVAILABLE',
      'A source for this suggestion changed or is no longer available.',
    );
  }
  return { capture, digests: parsedDigests.data };
}

export function verifyProposalOrigin(
  owner: string,
  turnId: string,
  proposal: AssistantProposal,
  item: AssistantItem,
  verified: VerifiedTurnOrigin,
): void {
  const expected = verified.digests[item.applyId];
  if (
    !expected ||
    expected !== proposalDigest(owner, turnId, item.applyId, proposal)
  ) {
    throw provenanceFailed();
  }
}

export async function retainPlannerOrigin(
  tx: QueryExecutor,
  owner: string,
  kind: 'task' | 'event',
  recordId: string,
  turnId: string,
  capture: OriginCapture,
): Promise<void> {
  await tx.query(
    `INSERT INTO ai_planner_origins (owner_id, kind, record_id, turn_id, capture)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (owner_id, kind, record_id, turn_id) DO UPDATE SET capture = EXCLUDED.capture`,
    [owner, kind, recordId, turnId, JSON.stringify(capture)],
  );

  const table = kind === 'task' ? 'tasks' : 'events';
  await tx.query(
    `UPDATE ${table}
     SET ai_origin = 'bound-derived',
         ai_labels = ARRAY(SELECT DISTINCT value FROM unnest(ai_labels || $3::text[]) value ORDER BY value)
     WHERE owner_id = $1 AND id = $2`,
    [owner, recordId, capture.labels],
  );
}
