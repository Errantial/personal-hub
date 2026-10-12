import { aiSavedAnswerSchema, aiTextOutputSchema } from '@hub/contracts';
import type { AIRequest, AITextOutput } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { stamp } from '../features/common.js';

const columns = `request_id AS "requestId",attempt_id AS "attemptId",version,synthetic,labels,context_manifest AS "contextManifest",output,${stamp('created_at', 'createdAt')},${stamp('deleted_at', 'deletedAt')}`;
export async function readAISavedAnswer(
  tx: QueryExecutor,
  owner: string,
  requestId: string,
) {
  const [row] = await tx.query(
    `SELECT ${columns} FROM ai_saved_answers WHERE owner_id=$1 AND request_id=$2`,
    [owner, requestId],
  );
  if (!row)
    throw new ApiError(404, 'NOT_FOUND', 'Saved answer is unavailable.');
  return aiSavedAnswerSchema.parse(row);
}
export async function exportAISavedAnswers(tx: QueryExecutor, owner: string) {
  return (
    await tx.query(
      `SELECT ${columns} FROM ai_saved_answers WHERE owner_id=$1 ORDER BY request_id LIMIT 10001`,
      [owner],
    )
  ).map((row) => aiSavedAnswerSchema.parse(row));
}
export async function saveConfirmedSyntheticAnswer(
  tx: QueryExecutor,
  owner: string,
  request: AIRequest,
  candidate: AITextOutput,
) {
  const output = aiTextOutputSchema.parse(candidate),
    attempt = request.attempt;
  if (
    !request.saveAnswer ||
    !attempt ||
    !attempt.admission.contextManifest ||
    request.status !== 'completed' ||
    attempt.resultMetadata?.status !== 'validated' ||
    !attempt.resultMetadata.retained
  )
    throw new ApiError(
      409,
      'ANSWER_CONSENT_REQUIRED',
      'This request cannot retain an answer.',
    );
  if (
    !output.suggestions.every(({ source }) =>
      attempt.admission.contextManifest!.sources.some(
        (ref) =>
          ref.kind === source.kind &&
          ref.id === source.id.toLowerCase() &&
          ref.version === source.version,
      ),
    )
  )
    throw new ApiError(
      409,
      'ANSWER_CONTEXT_CONFLICT',
      'Answer sources do not match admitted context.',
    );
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (
    (attempt.protocolMetadata === null &&
      (bytes !== attempt.outputTokens ||
        bytes > (attempt.admission.readiness.quote?.outputTokenLimit ?? 0))) ||
    (attempt.protocolMetadata !== null &&
      (attempt.protocolMetadata.outputState !== 'validated' ||
        (attempt.outputTokens ?? Infinity) >
          (attempt.admission.readiness.quote?.outputTokenLimit ?? 0))) ||
    output.answer.length !== attempt.resultMetadata.answerCharacters ||
    output.suggestions.length !== attempt.resultMetadata.suggestionCount
  )
    throw new ApiError(
      409,
      'ATTEMPT_RESULT_CONFLICT',
      'Saved answer does not match the confirmed result.',
    );
  await tx.query(
    'INSERT INTO ai_saved_answers(owner_id,request_id,attempt_id,labels,context_manifest,output) VALUES($1,$2,$3,$4::text[],$5::jsonb,$6::jsonb)',
    [
      owner,
      request.id,
      attempt.id,
      attempt.admission.route.labels,
      JSON.stringify(attempt.admission.contextManifest),
      JSON.stringify(output),
    ],
  );
}
