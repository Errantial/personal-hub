import { z } from 'zod';
import { aiTextOutputSchema } from '@hub/contracts';
import type {
  AIContextManifest,
  AITextOutput,
  AITextResultMetadata,
} from '@hub/contracts';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import {
  beginSyntheticAttempt,
  confirmSyntheticAttempt,
  syntheticUsageSchema,
  revalidateSyntheticAttempt,
} from './synthetic-execution.js';
import { readAIRequest } from './requests.js';

export interface SyntheticTextAdapter {
  kind: 'synthetic-text';
  execute(input: {
    attemptId: string;
    payload: string;
    maxOutputTokens: number;
    contextManifest: AIContextManifest;
    signal: AbortSignal;
  }): Promise<unknown>;
}
const responseSchema = z.strictObject({
  usage: syntheticUsageSchema,
  output: z.unknown(),
});

// Results exist only in this immediate internal test return. Durable records
// contain counts/status, never model text. A retry cannot resend to recover it.
export async function executeSyntheticTextRequest(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  expectedVersion: number,
  text: string,
  adapter: SyntheticTextAdapter,
  timeoutMs = 30000,
) {
  if (config.NODE_ENV !== 'test' || adapter.kind !== 'synthetic-text')
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'Only synthetic test execution is supported.',
    );
  z.number().int().min(1).max(30000).parse(timeoutMs);
  const claim = await beginSyntheticAttempt(
    database,
    config,
    owner,
    requestId,
    expectedVersion,
    text,
  );
  if (!claim.claimed) return { request: claim.request, result: null };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified = await revalidateSyntheticAttempt(
      database,
      config,
      owner,
      requestId,
      claim.attemptId,
      text,
    );
    // The callback is outside transactions and is never retried.
    const response = responseSchema.parse(
      await Promise.race([
        Promise.resolve().then(() =>
          adapter.execute({
            attemptId: claim.attemptId,
            payload: verified.payload,
            maxOutputTokens: claim.maxOutputTokens,
            contextManifest: structuredClone(claim.contextManifest),
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Synthetic response timeout'));
          }, timeoutMs);
        }),
      ]),
    );
    let output: AITextOutput | null = null;
    const parsed = aiTextOutputSchema.safeParse(response.output);
    if (
      response.usage.outcome === 'completed' &&
      parsed.success &&
      Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') <=
        claim.maxOutputTokens &&
      response.usage.outputTokens ===
        Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') &&
      parsed.data.suggestions.every(({ source }) =>
        claim.contextManifest.sources.some(
          (admitted) =>
            admitted.kind === source.kind &&
            admitted.id === source.id.toLowerCase() &&
            admitted.version === source.version,
        ),
      )
    )
      output = parsed.data;
    const metadata: AITextResultMetadata = {
      synthetic: true,
      retained: Boolean(output && claim.request.saveAnswer),
      status: output ? 'validated' : 'invalid',
      answerCharacters: output?.answer.length ?? null,
      suggestionCount: output?.suggestions.length ?? null,
    };
    const request = await confirmSyntheticAttempt(
      database,
      config,
      owner,
      requestId,
      response.usage,
      metadata,
      output && claim.request.saveAnswer ? output : undefined,
    );
    return {
      request,
      result: output
        ? {
            synthetic: true as const,
            retained: Boolean(claim.request.saveAnswer),
            requestId,
            attemptId: claim.attemptId,
            labels: request.attempt!.admission.route.labels,
            contextManifest: claim.contextManifest,
            output,
          }
        : null,
    };
  } catch {
    // Malformed usage, transport failure or atomic accounting failure preserves
    // the full uncertain hold. Private callback errors/results are not logged.
    return {
      request: await readAIRequest(database, owner, requestId, true),
      result: null,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
