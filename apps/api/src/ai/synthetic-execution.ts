import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiPricePolicySchema,
  aiTextResultMetadataSchema,
  aiRequestWriteSchema,
  aiProtocolMetadataSchema,
  aiTextOutputSchema,
} from '@hub/contracts';
import type { AITextResultMetadata } from '@hub/contracts';
import type { AITextOutput } from '@hub/contracts';
import {
  saveConfirmedSyntheticAnswer,
  readAISavedAnswer,
} from './saved-answers.js';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { version } from '../features/common.js';
import { assessAIInput } from '../features/ai-preflight.js';
import { publicAIRegistry } from './profiles.js';
import { reserveAIBudgetInTransaction, lockBudget } from './budget.js';
import { boundTextHash, readAIRequest } from './requests.js';
import { boundAIContextHash } from './context-binding.js';
import { readAIBudget } from '../features/ai-budget.js';

export const syntheticUsageSchema = z.strictObject({
  outcome: z.enum(['completed', 'failed']),
  inputTokens: z.number().int().min(0).max(2000000),
  outputTokens: z.number().int().min(0).max(2000000),
});
type SyntheticUsage = z.infer<typeof syntheticUsageSchema>;
export interface SyntheticAdapter {
  kind: 'synthetic';
  execute(input: {
    attemptId: string;
    payload: string;
    maxOutputTokens: number;
  }): Promise<SyntheticUsage>;
}
function testOnly(config: Config) {
  if (config.NODE_ENV !== 'test')
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'Provider execution is disabled.',
    );
}
const charge = (tokens: number, rate: number) =>
  Number((BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n);
// Internal harness only. No HTTP endpoint, production worker, live adapter or
// configuration switch can call this path. Test adapters receive no credentials.
export async function beginSyntheticAttempt(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  expectedVersion: number,
  text: string,
) {
  testOnly(config);
  z.string().uuid().parse(requestId);
  z.string().min(1).max(12000).parse(text);
  const registry = publicAIRegistry(config.AI_PROVIDER_PROFILES);
  return database.transaction(async (tx) => {
    // Consistent DB snapshot, budget-first lock order, and no external effects.
    // Serialization failures roll back; callers may retry admission, never transmission.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await lockBudget(tx, owner);
    const [row] = await tx.query(
      'SELECT * FROM ai_requests WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
      [owner, requestId],
    );
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'AI request not available.');
    const [existing] = await tx.query(
      'SELECT id FROM ai_attempts WHERE owner_id=$1 AND request_id=$2',
      [owner, requestId],
    );
    if (existing)
      return {
        claimed: false as const,
        request: await readAIRequest(tx, owner, requestId),
      };
    version(row, expectedVersion);
    if (row.status !== 'blocked')
      throw new ApiError(
        409,
        'AI_REQUEST_STATE',
        'Request cannot start an attempt.',
      );
    if (boundTextHash(owner, requestId, text) !== row.text_hash)
      throw new ApiError(
        409,
        'REQUEST_TEXT_CONFLICT',
        'Supply the original request text.',
      );
    const input = aiRequestWriteSchema.parse({
      ...(row.input_manifest as object),
      text,
      operationId: randomUUID(),
    });
    const { metadata, assembled } = await assessAIInput(
      tx,
      owner,
      input,
      registry,
    );
    const original = await readAIRequest(tx, owner, requestId);
    if (!row.context_hash || !original.assessment.contextManifest)
      throw new ApiError(
        409,
        'CONTEXT_BINDING_REQUIRED',
        'Create a new request with verified context.',
      );
    if (
      assembled &&
      boundAIContextHash(
        owner,
        requestId,
        assembled.payload,
        assembled.manifest,
      ) !== row.context_hash
    )
      throw new ApiError(
        409,
        'CONTEXT_CONFLICT',
        'Context changed. Create a new request.',
      );
    if (
      metadata.route.status !== 'selected' ||
      metadata.route.provider !== original.assessment.route.provider ||
      !assembled
    )
      throw new ApiError(
        409,
        'AI_REQUEST_BLOCKED',
        'Recheck request routing and context.',
      );
    const readiness = metadata.executionReadiness;
    if (
      !readiness ||
      readiness.blockers.some(
        (value) =>
          ![
            'DISPATCH_DISABLED',
            'PROVIDER_VERIFICATION_REQUIRED',
            'TOKEN_BOUND_UNVERIFIED',
          ].includes(value),
      ) ||
      !readiness.quote
    )
      throw new ApiError(
        409,
        'AI_REQUEST_BLOCKED',
        'Resolve request execution blockers.',
      );
    const profile = registry.profiles.find(
      (value) => value.alias === metadata.route.provider,
    )!;
    const price = profile.pricing!;
    // Synthetic byte-token model only. This is not a tokenizer for any real provider.
    if (Buffer.byteLength(assembled.payload, 'utf8') > price.inputTokenLimit)
      throw new ApiError(
        409,
        'TOKEN_LIMIT',
        'The synthetic payload exceeds its token allowance.',
      );
    if (readiness.quote.maximumChargeMicros === 0)
      throw new ApiError(
        409,
        'ZERO_PRICE_UNSUPPORTED',
        'Zero-charge execution is not implemented.',
      );
    const reservation = await reserveAIBudgetInTransaction(tx, owner, {
      requestId,
      expectedPolicyVersion: input.expectedBudgetVersion,
      provider: profile.alias,
      model: profile.model,
      maximumChargeMicros: readiness.quote.maximumChargeMicros,
    });
    if (reservation.status !== 'reserved')
      throw new ApiError(
        409,
        'BUDGET_STATE',
        'Request reservation cannot be claimed.',
      );
    await tx.query(
      "UPDATE ai_budget_reservations SET status='uncertain',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [owner, reservation.id],
    );
    const attemptId = randomUUID();
    await tx.query(
      "INSERT INTO ai_attempts(id,owner_id,request_id,reservation_id,adapter,price_snapshot,admission_metadata) VALUES($1,$2,$3,$4,'synthetic',$5::jsonb,$6::jsonb)",
      [
        attemptId,
        owner,
        requestId,
        reservation.id,
        JSON.stringify(price),
        JSON.stringify({
          policyVersion: input.expectedPolicyVersion,
          budgetVersion: input.expectedBudgetVersion,
          registryRevision: registry.revision,
          route: metadata.route,
          model: profile.model,
          sources: metadata.sources,
          readiness,
          contextManifest: assembled.manifest,
        }),
      ],
    );
    await tx.query(
      "UPDATE ai_requests SET status='uncertain',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [owner, requestId],
    );
    return {
      claimed: true as const,
      attemptId,
      payload: assembled.payload,
      maxOutputTokens: profile.maxOutputTokens,
      contextManifest: assembled.manifest,
      request: await readAIRequest(tx, owner, requestId),
    };
  });
}

// Recheck the committed claim immediately before the callback. An admission
// snapshot is not permission to transmit after source/consent/settings changes.
export async function revalidateSyntheticAttempt(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  attemptId: string,
  text: string,
) {
  testOnly(config);
  const registry = publicAIRegistry(config.AI_PROVIDER_PROFILES);
  return database.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [row] = await tx.query(
      'SELECT input_manifest,text_hash,context_hash FROM ai_requests WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL',
      [owner, requestId],
    );
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'AI request not available.');
    const request = await readAIRequest(tx, owner, requestId);
    const attempt = request.attempt;
    if (
      request.status !== 'uncertain' ||
      !attempt ||
      attempt.id !== attemptId ||
      attempt.status !== 'uncertain'
    )
      throw new ApiError(
        409,
        'AI_REQUEST_STATE',
        'The attempt cannot transmit.',
      );
    if (boundTextHash(owner, requestId, text) !== row.text_hash)
      throw new ApiError(
        409,
        'REQUEST_TEXT_CONFLICT',
        'Supply the original request text.',
      );
    const input = aiRequestWriteSchema.parse({
      ...(row.input_manifest as object),
      text,
      operationId: randomUUID(),
    });
    const { metadata, assembled } = await assessAIInput(
      tx,
      owner,
      input,
      registry,
    );
    const readiness = metadata.executionReadiness;
    if (
      !assembled ||
      !row.context_hash ||
      boundAIContextHash(
        owner,
        requestId,
        assembled.payload,
        assembled.manifest,
      ) !== row.context_hash
    )
      throw new ApiError(
        409,
        'CONTEXT_CONFLICT',
        'Context changed before transmission.',
      );
    if (
      metadata.route.status !== 'selected' ||
      metadata.route.provider !== attempt.admission.route.provider ||
      metadata.model !== attempt.admission.model ||
      !readiness ||
      !readiness.quote ||
      readiness.consent.version !==
        attempt.admission.readiness.consent.version ||
      readiness.blockers.some(
        (blocker) =>
          ![
            'DISPATCH_DISABLED',
            'PROVIDER_VERIFICATION_REQUIRED',
            'TOKEN_BOUND_UNVERIFIED',
            'MONTHLY_BUDGET_EXCEEDED',
          ].includes(blocker),
      )
    )
      throw new ApiError(
        409,
        'AI_REQUEST_BLOCKED',
        'Execution settings changed before transmission.',
      );
    const budget = await readAIBudget(tx, owner);
    const [reservation] = await tx.query(
      "SELECT status,reserved_micros::text,to_char(month,'YYYY-MM') AS month FROM ai_budget_reservations WHERE owner_id=$1 AND id=$2",
      [owner, attempt.reservationId],
    );
    // The existing hold is counted once, rather than quoting a second request.
    if (
      !reservation ||
      reservation.status !== 'uncertain' ||
      reservation.month !== budget.usage.month ||
      Number(reservation.reserved_micros) !==
        readiness.quote.maximumChargeMicros ||
      budget.policy.monthlyLimitMicros === null ||
      BigInt(budget.usage.spentMicros) + BigInt(budget.usage.heldMicros) >
        BigInt(budget.policy.monthlyLimitMicros)
    )
      throw new ApiError(
        409,
        'BUDGET_STATE',
        'The admitted budget cannot transmit.',
      );
    return assembled;
  });
}

// Only confirmed synthetic usage may replace an uncertain hold. A timeout,
// malformed result, process restart or accounting failure keeps the full hold.
export async function confirmSyntheticAttempt(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  candidate: SyntheticUsage,
  candidateResult?: AITextResultMetadata,
  candidateAnswer?: AITextOutput,
) {
  return confirmTestAttempt(
    database,
    config,
    owner,
    requestId,
    candidate,
    candidateResult,
    candidateAnswer,
  );
}

// Reported native tokens/cost are used only by the offline OpenRouter harness.
// This does not establish live prices, a verified provider invoice or permission
// to transmit. Existing synthetic byte-token settlement remains unchanged.
export async function confirmSyntheticOpenRouterAttempt(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  candidate: {
    generationId: string;
    usage: { inputTokens: number; outputTokens: number; actualMicros: number };
    outputState: 'validated' | 'invalid' | 'provider-error' | 'blocked';
    output: AITextOutput | null;
  },
) {
  testOnly(config);
  const parsed = z
    .strictObject({
      generationId: aiProtocolMetadataSchema.shape.generationId,
      usage: z.strictObject({
        inputTokens: syntheticUsageSchema.shape.inputTokens,
        outputTokens: syntheticUsageSchema.shape.outputTokens,
        actualMicros: z.number().int().min(0).max(1000000000000),
      }),
      outputState: aiProtocolMetadataSchema.shape.outputState,
      output: aiTextOutputSchema.nullable(),
    })
    .parse(candidate);
  if ((parsed.outputState === 'validated') !== (parsed.output !== null))
    throw new ApiError(
      409,
      'ATTEMPT_RESULT_CONFLICT',
      'Protocol output is inconsistent.',
    );
  const request = await readAIRequest(database, owner, requestId, true);
  const admitted = request.attempt?.admission;
  if (
    parsed.output &&
    (!admitted?.contextManifest ||
      parsed.usage.outputTokens >
        (admitted.readiness.quote?.outputTokenLimit ?? 0) ||
      parsed.usage.inputTokens >
        (admitted.readiness.quote?.inputTokenLimit ?? 0) ||
      !parsed.output.suggestions.every(({ source }) =>
        admitted.contextManifest!.sources.some(
          (ref) =>
            ref.kind === source.kind &&
            ref.id === source.id.toLowerCase() &&
            ref.version === source.version,
        ),
      ))
  )
    throw new ApiError(
      409,
      'ATTEMPT_RESULT_CONFLICT',
      'Protocol output does not match admitted context.',
    );
  const retained = Boolean(parsed.output && request.saveAnswer);
  return confirmTestAttempt(
    database,
    config,
    owner,
    requestId,
    {
      outcome: parsed.outputState === 'provider-error' ? 'failed' : 'completed',
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
    },
    {
      synthetic: true,
      retained,
      status: parsed.output ? 'validated' : 'invalid',
      answerCharacters: parsed.output?.answer.length ?? null,
      suggestionCount: parsed.output?.suggestions.length ?? null,
    },
    retained ? parsed.output! : undefined,
    {
      actualMicros: parsed.usage.actualMicros,
      metadata: aiProtocolMetadataSchema.parse({
        synthetic: true,
        protocol: 'openrouter',
        generationId: parsed.generationId,
        outputState: parsed.outputState,
      }),
    },
  );
}

// Accounting-only recovery from immutable synthetic reports. It has no provider
// I/O, prompt/text parameter, caller-supplied cost or answer reconstruction path.
export async function recoverSyntheticOpenRouterAccounting(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  expectedAttemptVersion: number,
) {
  testOnly(config);
  z.string().uuid().parse(requestId);
  z.number().int().positive().parse(expectedAttemptVersion);
  const request = await readAIRequest(database, owner, requestId, true);
  const observation = request.attempt?.protocolObservation;
  if (!observation || observation.state !== 'reported')
    throw new ApiError(
      409,
      'PROTOCOL_USAGE_UNAVAILABLE',
      'A complete reported usage observation is required.',
    );
  return confirmTestAttempt(
    database,
    config,
    owner,
    requestId,
    {
      outcome:
        observation.outputState === 'provider-error' ? 'failed' : 'completed',
      inputTokens: observation.usage.inputTokens,
      outputTokens: observation.usage.outputTokens,
    },
    {
      synthetic: true,
      retained: false,
      status:
        observation.outputState === 'validated' ? 'unavailable' : 'invalid',
      answerCharacters: null,
      suggestionCount: null,
    },
    undefined,
    {
      actualMicros: observation.usage.actualMicros,
      metadata: {
        synthetic: true,
        protocol: 'openrouter',
        generationId: observation.generationId,
        outputState: observation.outputState,
      },
      recoveryVersion: expectedAttemptVersion,
    },
  );
}

async function confirmTestAttempt(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  candidate: SyntheticUsage,
  candidateResult?: AITextResultMetadata,
  candidateAnswer?: AITextOutput,
  protocol?: {
    actualMicros: number;
    metadata: z.infer<typeof aiProtocolMetadataSchema>;
    recoveryVersion?: number;
  },
) {
  testOnly(config);
  const usage = syntheticUsageSchema.parse(candidate);
  const resultMetadata =
    candidateResult === undefined
      ? undefined
      : aiTextResultMetadataSchema.parse(candidateResult);
  return database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    const [request] = await tx.query(
      'SELECT id,preflight_id FROM ai_requests WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, requestId],
    );
    if (!request)
      throw new ApiError(404, 'NOT_FOUND', 'AI request not available.');
    const [attempt] = await tx.query(
      'SELECT * FROM ai_attempts WHERE owner_id=$1 AND request_id=$2 FOR UPDATE',
      [owner, requestId],
    );
    if (!attempt)
      throw new ApiError(404, 'NOT_FOUND', 'AI attempt not available.');
    const snapshot = await readAIRequest(tx, owner, requestId, true);
    const price = aiPricePolicySchema.parse(attempt.price_snapshot);
    if (
      protocol &&
      snapshot.attempt?.admission.readiness.consent.profileSnapshot?.adapter !==
        'openrouter'
    )
      throw new ApiError(
        409,
        'ATTEMPT_RESULT_CONFLICT',
        'Protocol does not match the admitted provider.',
      );
    // Settlement uses the admitted immutable price, even after settings change.
    if (
      price.revision !==
      snapshot.attempt?.admission.readiness.quote?.priceRevision
    )
      throw new ApiError(
        409,
        'PRICING_UNSET',
        'Confirmed attempt pricing is unavailable.',
      );
    const actualMicros =
      protocol?.actualMicros ??
      charge(usage.inputTokens, price.inputMicrosPerMillionTokens) +
        charge(usage.outputTokens, price.outputMicrosPerMillionTokens);
    const observation = snapshot.attempt!.protocolObservation;
    if (
      observation &&
      (!protocol ||
        (observation.generationId !== null &&
          observation.generationId !== protocol.metadata.generationId) ||
        (observation.state === 'reported' &&
          (observation.usage.inputTokens !== usage.inputTokens ||
            observation.usage.outputTokens !== usage.outputTokens ||
            observation.usage.actualMicros !== actualMicros ||
            observation.outputState !== protocol.metadata.outputState)))
    )
      throw new ApiError(
        409,
        'ATTEMPT_RESULT_CONFLICT',
        'Confirmed usage conflicts with the recorded protocol observation.',
      );
    if (attempt.status !== 'uncertain') {
      const storedResult = aiTextResultMetadataSchema.safeParse(
        attempt.result_metadata,
      );
      if (
        attempt.status !== usage.outcome ||
        attempt.input_tokens !== usage.inputTokens ||
        attempt.output_tokens !== usage.outputTokens ||
        Number(attempt.actual_micros) !== actualMicros ||
        JSON.stringify(snapshot.attempt!.protocolMetadata) !==
          JSON.stringify(protocol?.metadata ?? null) ||
        (protocol?.recoveryVersion === undefined &&
          resultMetadata !== undefined &&
          (!storedResult.success ||
            JSON.stringify(storedResult.data) !==
              JSON.stringify(resultMetadata)))
      )
        throw new ApiError(
          409,
          'ATTEMPT_RESULT_CONFLICT',
          'This attempt already has a different confirmed result.',
        );
      if (candidateAnswer !== undefined) {
        const saved = await readAISavedAnswer(tx, owner, requestId);
        if (
          saved.output !== null &&
          JSON.stringify(saved.output) !== JSON.stringify(candidateAnswer)
        )
          throw new ApiError(
            409,
            'ATTEMPT_RESULT_CONFLICT',
            'This attempt already has a different saved answer.',
          );
      }
      return snapshot;
    }
    if (protocol?.recoveryVersion !== undefined) {
      version(attempt, protocol.recoveryVersion);
      if (!observation || observation.state !== 'reported')
        throw new ApiError(
          409,
          'PROTOCOL_USAGE_UNAVAILABLE',
          'The reported usage observation is unavailable.',
        );
    }
    const [reservation] = await tx.query(
      'SELECT status FROM ai_budget_reservations WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [owner, attempt.reservation_id],
    );
    if (reservation?.status !== 'uncertain')
      throw new ApiError(
        409,
        'BUDGET_STATE',
        'Attempt accounting requires review.',
      );
    await tx.query(
      "UPDATE ai_budget_reservations SET status='settled',actual_micros=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2",
      [owner, attempt.reservation_id, actualMicros],
    );
    await tx.query(
      'UPDATE ai_attempts SET status=$3,input_tokens=$4,output_tokens=$5,actual_micros=$6,result_metadata=$7::jsonb,protocol_metadata=$8::jsonb,finished_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND request_id=$2',
      [
        owner,
        requestId,
        usage.outcome,
        usage.inputTokens,
        usage.outputTokens,
        actualMicros,
        resultMetadata === undefined ? null : JSON.stringify(resultMetadata),
        protocol === undefined ? null : JSON.stringify(protocol.metadata),
      ],
    );
    await tx.query(
      'UPDATE ai_requests SET status=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
      [owner, requestId, usage.outcome],
    );
    const completed = await readAIRequest(tx, owner, requestId, true);
    if (candidateAnswer !== undefined)
      await saveConfirmedSyntheticAnswer(tx, owner, completed, candidateAnswer);
    return completed;
  });
}
export async function executeSyntheticRequest(
  database: Database,
  config: Config,
  owner: string,
  requestId: string,
  expectedVersion: number,
  text: string,
  adapter: SyntheticAdapter,
) {
  testOnly(config);
  if (adapter.kind !== 'synthetic')
    throw new ApiError(
      409,
      'DISPATCH_DISABLED',
      'Only synthetic adapters are supported.',
    );
  const claim = await beginSyntheticAttempt(
    database,
    config,
    owner,
    requestId,
    expectedVersion,
    text,
  );
  if (!claim.claimed) return claim.request;
  // No transaction or retry loop surrounds the one external callback.
  try {
    const verified = await revalidateSyntheticAttempt(
      database,
      config,
      owner,
      requestId,
      claim.attemptId,
      text,
    );
    const usage = await adapter.execute({
      attemptId: claim.attemptId,
      payload: verified.payload,
      maxOutputTokens: claim.maxOutputTokens,
    });
    return await confirmSyntheticAttempt(
      database,
      config,
      owner,
      requestId,
      usage,
    );
  } catch {
    return readAIRequest(database, owner, requestId, true);
  }
}
