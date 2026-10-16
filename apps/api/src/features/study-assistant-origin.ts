import { z } from 'zod';
import { assistantStudySuggestionSchema } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { academicContext } from '../ai/live-projections.js';
import { liveAllowedLabels } from '../ai/live-destination.js';
import { readAssistantSettings } from '../ai/live-request.js';
import {
  proposalDigest,
  verifyTurnOrigin,
  originCaptureSchema,
} from './ai-planner-origin.js';

export type StudyAssistantRef = { turnId: string; suggestionId: string };
const unavailable = () =>
  new ApiError(
    409,
    'STUDY_ORIGIN_CHANGED',
    'This study suggestion changed or is no longer available. Review a new answer.',
  );
const json = (value: unknown) =>
  typeof value === 'string' ? JSON.parse(value) : value;

export async function verifyStudySuggestion(
  tx: QueryExecutor,
  owner: string,
  ref: StudyAssistantRef,
  range: { from: string; to: string },
) {
  const [row] = await tx.query(
    `SELECT t.study_suggestions,t.proposal_access,t.trigger FROM ai_conversation_turns t
     JOIN ai_conversations c ON c.id=t.conversation_id AND c.owner_id=t.owner_id
     WHERE t.owner_id=$1 AND t.id=$2 AND c.deleted_at IS NULL`,
    [owner, ref.turnId],
  );
  if (!row || row.trigger !== 'owner' || row.proposal_access !== 'applicable')
    throw unavailable();
  const suggestion = z
    .array(assistantStudySuggestionSchema)
    .parse(json(row.study_suggestions))
    .find((s) => s.id === ref.suggestionId);
  if (
    !suggestion ||
    suggestion.from !== range.from ||
    suggestion.to !== range.to
  )
    throw unavailable();
  const origin = await verifyTurnOrigin(tx, owner, ref.turnId);
  const digest = proposalDigest(owner, ref.turnId, suggestion.id, suggestion);
  if (
    origin.digests[suggestion.id] !== digest ||
    origin.capture.useMail ||
    origin.capture.sources.some(
      (s) => s.kind === 'mail-message' || s.kind === 'mail-broker',
    )
  )
    throw unavailable();
  const [destination] = await tx.query(
    'SELECT model,upstream,revision,version,revoked FROM ai_live_destinations WHERE owner_id=$1',
    [owner],
  );
  const settings = await readAssistantSettings(tx, owner);
  if (
    !destination ||
    destination.revoked ||
    destination.model !== settings.model ||
    destination.model !== origin.capture.destination.model ||
    destination.upstream !== origin.capture.destination.upstream ||
    destination.revision !== origin.capture.destination.revision ||
    destination.version !== origin.capture.destination.version
  )
    throw unavailable();
  const current = await academicContext(
    tx,
    owner,
    suggestion.sources,
    liveAllowedLabels(settings),
  );
  if (
    current.items.length !== suggestion.sources.length ||
    current.items.some(
      (s) =>
        !['planned', 'in_progress'].includes(s.projected.status) ||
        !origin.capture.sources.some(
          (source) => source.kind === 'academic-work' && source.id === s.id,
        ),
    )
  )
    throw unavailable();
  return { suggestion, digest, capture: origin.capture };
}

export async function studyPlanOrigin(
  tx: QueryExecutor,
  owner: string,
  planId: string,
  range: { from: string; to: string },
) {
  const [row] = await tx.query(
    'SELECT turn_id,suggestion_id,digest,capture FROM study_plan_ai_origins WHERE owner_id=$1 AND plan_id=$2',
    [owner, planId],
  );
  if (!row) return null;
  const current = await verifyStudySuggestion(
    tx,
    owner,
    { turnId: String(row.turn_id), suggestionId: String(row.suggestion_id) },
    range,
  );
  const saved = originCaptureSchema.parse(json(row.capture));
  if (
    row.digest !== current.digest ||
    JSON.stringify(saved) !== JSON.stringify(current.capture)
  )
    throw unavailable();
  return current;
}
