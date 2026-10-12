import type { Config } from '../config.js';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { readAIRequest } from './requests.js';
import {
  beginSyntheticAttempt,
  revalidateSyntheticAttempt,
  confirmSyntheticOpenRouterAttempt,
} from './synthetic-execution.js';
import { exerciseOpenRouterProtocol } from './openrouter-protocol.js';
import type { OpenRouterTestIO } from './openrouter-protocol.js';
import { recordSyntheticOpenRouterObservation } from './protocol-observations.js';

// Offline durable integration only: injected I/O, synthetic credentials, no
// production switch or HTTP route. A committed attempt is never transmitted twice.
export async function executeSyntheticOpenRouterRequest(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  expectedVersion: number,
  text: string,
  io: OpenRouterTestIO,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  if (config.NODE_ENV !== 'test')
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'Only offline test execution is supported.',
    );
  z.number()
    .int()
    .min(1)
    .max(30000)
    .parse(options.timeoutMs ?? 30000);
  const original = await readAIRequest(database, owner, requestId);
  const profile = config.AI_PROVIDER_PROFILES.find(
    (profile) => profile.alias === original.assessment.route.provider,
  );
  if (
    profile?.adapter !== 'openrouter' ||
    !profile.credential?.startsWith('synthetic-')
  )
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'A synthetic OpenRouter profile is required.',
    );
  if (options.signal?.aborted) return { request: original, result: null };
  const claim = await beginSyntheticAttempt(
    database,
    config,
    owner,
    requestId,
    expectedVersion,
    text,
  );
  if (!claim.claimed) return { request: claim.request, result: null };
  try {
    const verified = await revalidateSyntheticAttempt(
      database,
      config,
      owner,
      requestId,
      claim.attemptId,
      text,
    );
    const response = await exerciseOpenRouterProtocol(
      config,
      profile.alias,
      verified.payload,
      verified.manifest,
      io,
      options,
    );
    await recordSyntheticOpenRouterObservation(
      database,
      config,
      owner,
      requestId,
      response.status === 'uncertain'
        ? {
            synthetic: true,
            protocol: 'openrouter',
            state: 'uncertain',
            generationId: response.generationId,
            reason: response.reason,
          }
        : {
            synthetic: true,
            protocol: 'openrouter',
            state: 'reported',
            generationId: response.generationId,
            usage: response.usage,
            outputState: response.outputState,
          },
    );
    if (response.status === 'uncertain')
      return {
        request: await readAIRequest(database, owner, requestId, true),
        result: null,
      };
    const request = await confirmSyntheticOpenRouterAttempt(
      database,
      config,
      owner,
      requestId,
      {
        generationId: response.generationId,
        usage: response.usage,
        outputState: response.outputState,
        output: response.output,
      },
    );
    return {
      request,
      result: response.output
        ? {
            synthetic: true as const,
            retained: Boolean(request.saveAnswer),
            requestId,
            attemptId: claim.attemptId,
            labels: request.attempt!.admission.route.labels,
            contextManifest: verified.manifest,
            output: response.output,
          }
        : null,
    };
  } catch {
    // Accounting/storage failure leaves the full hold; never retry provider I/O.
    return {
      request: await readAIRequest(database, owner, requestId, true),
      result: null,
    };
  }
}
