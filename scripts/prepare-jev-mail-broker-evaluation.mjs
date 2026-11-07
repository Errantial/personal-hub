// Offline only: build production Jev requests, or decode recorded completions.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  buildJevEnvelope,
  decodeJev,
  jevBoundsRevision,
  jevEnvelopeLimit,
  jevModel,
  jevRubricRevision,
  jevThresholdRevision,
} from '../apps/api/src/ai/jev-broker-protocol.ts';

const corpusUrl = new URL(
  '../tests/fixtures/mail-broker-evaluation.json',
  import.meta.url,
);
const hash = (text) => createHash('sha256').update(text).digest('hex');
export const jevEvaluationQuote = {
  inputTokenLimit: 32000,
  outputTokenLimit: 1000,
  maximumChargeMicros: 1344,
  inputMicrosPerMillionTokens: 42000,
  outputMicrosPerMillionTokens: 0,
  authoritativeUsageBilling: true,
};

export async function prepareJevEvaluation() {
  const raw = await readFile(corpusUrl, 'utf8');
  const corpus = JSON.parse(raw);
  const cases = corpus.cases.map((item) => {
    const candidates = item.candidates.map((candidate, index) => {
      if (candidate.key !== `m${index + 1}`)
        throw new Error('Noncanonical fixture keys.');
      return {
        id: candidate.key,
        version: 1,
        connectorId: 'synthetic',
        connectorVersion: 1,
        labels: ['unlabeled'],
        digest: 'synthetic',
        subject: candidate.subject,
        from: candidate.from,
        receivedAt: candidate.receivedAt,
        body: candidate.excerpt,
        truncated: candidate.clipped,
      };
    });
    const envelope = buildJevEnvelope(jevModel, item.intent, candidates);
    if (Buffer.byteLength(envelope) > jevEnvelopeLimit)
      throw new Error('Fixture exceeds production Jev envelope bound.');
    return {
      caseId: item.id,
      requestSha256: hash(envelope),
      envelope,
      candidates,
    };
  });
  return {
    adapter: 'typesafe',
    corpus: corpus.version,
    corpusSha256: hash(raw),
    model: jevModel,
    rubric: jevRubricRevision,
    bounds: jevBoundsRevision,
    threshold: jevThresholdRevision,
    quote: jevEvaluationQuote,
    cases,
  };
}

export function decodeJevEvaluation(prepared, responses) {
  if (!Array.isArray(responses) || responses.length !== prepared.cases.length)
    throw new Error('Supply exactly one completion per case.');
  const remaining = new Map(prepared.cases.map((item) => [item.caseId, item]));
  const predictions = [];
  const outcomes = [];
  let confirmedMicros = 0;
  let uncertainCases = 0;
  for (const response of responses) {
    const item = remaining.get(response.caseId);
    if (
      !item ||
      response.requestSha256 !== item.requestSha256 ||
      typeof response.completion !== 'string' ||
      Buffer.byteLength(response.completion) > 128 * 1024
    )
      throw new Error(
        'Duplicate, foreign, mismatched or oversized completion.',
      );
    remaining.delete(item.caseId);
    const result = decodeJev(
      response.completion,
      prepared.model,
      item.candidates,
      prepared.quote,
    );
    if (result.status === 'confirmed')
      confirmedMicros += result.usage.actualMicros;
    else uncertainCases++;
    outcomes.push({
      caseId: item.caseId,
      status: result.status,
      reason: result.reason,
    });
    if (result.status === 'confirmed' && result.reason === null)
      predictions.push({
        caseId: item.caseId,
        selectedKeys: result.decisions
          .filter((decision) => decision.selected)
          .map((decision) => decision.id),
      });
  }
  return {
    adapter: prepared.adapter,
    corpus: prepared.corpus,
    corpusSha256: prepared.corpusSha256,
    model: prepared.model,
    rubric: prepared.rubric,
    bounds: prepared.bounds,
    threshold: prepared.threshold,
    requests: prepared.cases.map(({ caseId, requestSha256 }) => ({
      caseId,
      requestSha256,
    })),
    valid: predictions.length === prepared.cases.length,
    confirmedMicros,
    uncertainCases,
    outcomes,
    predictions,
  };
}

async function main() {
  const [mode, input, output] = process.argv.slice(2);
  const prepared = await prepareJevEvaluation();
  if (mode === 'prepare' && input && !output) {
    const { cases, ...metadata } = prepared;
    await writeFile(
      input,
      JSON.stringify(
        {
          ...metadata,
          cases: cases.map(({ caseId, requestSha256, envelope }) => ({
            caseId,
            requestSha256,
            envelope,
          })),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  } else if (mode === 'decode' && input && output) {
    const result = decodeJevEvaluation(
      prepared,
      JSON.parse(await readFile(input, 'utf8')),
    );
    await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
    if (!result.valid) process.exitCode = 1;
  } else
    throw new Error(
      'Usage: node --import tsx scripts/prepare-jev-mail-broker-evaluation.mjs prepare <new-requests.json> | decode <responses.json> <new-result.json>',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Jev evaluation failed: check arguments, response bindings and unused output path. No network requests were made.',
    );
    process.exitCode = 1;
  });
