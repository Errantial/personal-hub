import { createHash } from 'node:crypto';
import { sensitivitySchema } from '@hub/contracts';
import { z } from 'zod';

// Server-only live exchange manifest (docs/live-context-admission-design.md).
// It records what one exchange disclosed: identities, versions, labels,
// projection names, refs, counts and private digests. It never holds prompt,
// mail or reply text, and it is never exported or returned over HTTP.

export const maxLiveSources = 350;
export const maxHistorySources = 1000;
export const maxHistoryTurns = 10;

const uuid = z.string().uuid();
const positive = z.number().int().positive();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const labels = z.array(sensitivitySchema).min(1).max(3);
const connector = z.strictObject({ id: uuid, version: positive });

export const liveProjectionSchema = z.enum([
  'planner-task-v1',
  'planner-event-v1',
  'mail-header-v1',
  'mail-body-v1',
  'mail-classify-v1',
  'mail-task-v1',
  'academic-work-v1',
  'mail-broker-v1',
]);
export type LiveProjection = z.infer<typeof liveProjectionSchema>;
const kind = z.enum([
  'task',
  'event',
  'mail-message',
  'academic-work',
  'mail-broker',
]);
const academicCourse = z.strictObject({ id: uuid, version: positive });

/** One projected source exactly as sent, bound by a private digest. */
export const liveSourceSchema = z.strictObject({
  projection: liveProjectionSchema,
  kind,
  id: uuid,
  version: positive,
  ref: z.string().max(10),
  labels,
  connector: connector.optional(),
  academicCourse: academicCourse.optional(),
  truncated: z.boolean().optional(),
  digest: sha256Hex,
  brokerDigest: sha256Hex.optional(),
});
export type LiveSource = z.infer<typeof liveSourceSchema>;

/**
 * A source a resent history turn depended on: identity and labels only.
 * Ordinary edits do not invalidate history; deletion, relabeling or a
 * connector change does.
 */
export const liveHistorySourceSchema = z.strictObject({
  kind,
  id: uuid,
  labels,
  connector: connector.optional(),
  academicCourse: academicCourse.optional(),
  brokerDigest: sha256Hex.optional(),
});
export type LiveHistorySource = z.infer<typeof liveHistorySourceSchema>;

export const liveManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    owner: uuid,
    requestId: uuid,
    kind: z.enum(['planner', 'planner-round', 'mail-classify', 'mail-tasks']),
    round: z.number().int().min(1).max(3),
    conversationId: uuid.nullable(),
    priorRequestIds: z.array(uuid).max(2),
    destination: z.strictObject({
      model: z.string(),
      upstream: z.string(),
      revision: sha256Hex,
      version: positive,
    }),
    settingsVersion: positive,
    /** Mail may be used by this ask (mail-dependent history needs it). */
    useMail: z.boolean(),
    request: z.strictObject({
      provenance: z.enum(['owner-entered', 'agent-goal', 'none']),
      labels,
      agent: z.strictObject({ id: uuid, goalDigest: sha256Hex }).optional(),
    }),
    timeZone: z.string().nullable(),
    history: z.strictObject({
      turns: z
        .array(z.strictObject({ id: uuid, digest: sha256Hex }))
        .max(maxHistoryTurns),
      sources: z.array(liveHistorySourceSchema).max(maxHistorySources),
      withheld: z.number().int().nonnegative(),
    }),
    sources: z.array(liveSourceSchema).max(maxLiveSources),
    bytes: positive,
  })
  .refine(
    (manifest) =>
      new Set(manifest.sources.map((s) => `${s.projection}:${s.id}`)).size ===
      manifest.sources.length,
    { message: 'Duplicate source.' },
  );
export type LiveManifest = z.infer<typeof liveManifestSchema>;

/** Private digest of one projected value; never serialized outside the row. */
export const sourceDigest = (
  owner: string,
  requestId: string,
  projection: string,
  id: string,
  projected: unknown,
) =>
  createHash('sha256')
    .update(JSON.stringify([owner, requestId, projection, id, projected]))
    .digest('hex');

/** The digest of a turn's retained ask and reply, bound when it is saved. */
export const turnDigest = (
  owner: string,
  turnId: string,
  ask: string,
  reply: string,
) =>
  createHash('sha256')
    .update(JSON.stringify([owner, turnId, ask, reply]))
    .digest('hex');

/**
 * Everything a reply from this exchange depended on, as stored on a bound
 * turn: its sources plus the sources of the history it was sent with.
 */
export function historyRefs(manifest: LiveManifest): LiveHistorySource[] {
  const refs = new Map<string, LiveHistorySource>();
  for (const source of [...manifest.history.sources, ...manifest.sources]) {
    const key = `${source.kind}:${source.id}`;
    const previous = refs.get(key);
    if (previous) {
      previous.labels = [...new Set([...previous.labels, ...source.labels])];
      continue;
    }
    refs.set(key, {
      kind: source.kind,
      id: source.id,
      labels: source.labels,
      ...(source.brokerDigest ? { brokerDigest: source.brokerDigest } : {}),
      ...(source.connector ? { connector: source.connector } : {}),
      ...(source.academicCourse
        ? { academicCourse: source.academicCourse }
        : {}),
    });
  }
  return [...refs.values()];
}
