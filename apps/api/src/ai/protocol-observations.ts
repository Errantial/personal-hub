import { aiProtocolObservationSchema } from '@hub/contracts';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { lockBudget } from './budget.js';
import { readAIRequest } from './requests.js';

// Internal offline evidence only. No output text, credentials, settlement or I/O.
export async function recordSyntheticOpenRouterObservation(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  candidate: z.infer<typeof aiProtocolObservationSchema>,
) {
  if (config.NODE_ENV !== 'test')
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'Only offline protocol observations are supported.',
    );
  const observation = aiProtocolObservationSchema.parse(candidate);
  // Reject missing/foreign ownership before the budget lock can initialize a
  // policy row. The transaction still locks budget, request, then attempt.
  await readAIRequest(database, owner, requestId, true);
  return database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const [request] = await tx.query(
      'SELECT id FROM ai_requests WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, requestId],
    );
    if (!request)
      throw new ApiError(404, 'NOT_FOUND', 'AI request not available.');
    const [attempt] = await tx.query(
      'SELECT id FROM ai_attempts WHERE owner_id=$1 AND request_id=$2 FOR UPDATE',
      [owner, requestId],
    );
    if (!attempt)
      throw new ApiError(404, 'NOT_FOUND', 'AI attempt not available.');
    const snapshot = await readAIRequest(tx, owner, requestId, true);
    if (
      snapshot.attempt!.admission.readiness.consent.profileSnapshot?.adapter !==
      'openrouter'
    )
      throw new ApiError(
        409,
        'ATTEMPT_RESULT_CONFLICT',
        'Protocol does not match the admitted provider.',
      );
    if (snapshot.attempt!.protocolObservation !== null) {
      if (
        JSON.stringify(snapshot.attempt!.protocolObservation) !==
        JSON.stringify(observation)
      )
        throw new ApiError(
          409,
          'ATTEMPT_RESULT_CONFLICT',
          'This attempt already has a different protocol observation.',
        );
      return snapshot;
    }
    if (snapshot.attempt!.status !== 'uncertain')
      throw new ApiError(
        409,
        'AI_REQUEST_STATE',
        'This attempt cannot record a protocol observation.',
      );
    await tx.query(
      'UPDATE ai_attempts SET protocol_observation=$3::jsonb,version=version+1 WHERE owner_id=$1 AND request_id=$2',
      [owner, requestId, JSON.stringify(observation)],
    );
    return readAIRequest(tx, owner, requestId, true);
  });
}
