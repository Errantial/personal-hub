// Offline only: build production requests, or decode externally obtained completions.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  brokerModel,
  brokerRubricRevision,
  brokerEnvelopeLimit,
  brokerOutputTokens,
  buildBrokerEnvelope,
  decodeBroker,
} from '../apps/api/src/ai/broker-protocol.ts';

const corpusUrl = new URL(
  '../tests/fixtures/mail-broker-evaluation.json',
  import.meta.url,
);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const quote = {
  inputTokenLimit: 32000,
  outputTokenLimit: brokerOutputTokens,
  maximumChargeMicros: 4020,
};

export async function prepareEvaluation() {
  const raw = await readFile(corpusUrl, 'utf8');
  const corpus = JSON.parse(raw);
  const cases = corpus.cases.map((item) => {
    const candidates = item.candidates.map((candidate, i) => {
      if (candidate.key !== `m${i + 1}`)
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
    const envelope = buildBrokerEnvelope(brokerModel, item.intent, candidates);
    if (Buffer.byteLength(envelope) > brokerEnvelopeLimit)
      throw new Error('Fixture exceeds production envelope bound.');
    return {
      caseId: item.id,
      requestSha256: hash(envelope),
      envelope,
      candidates,
    };
  });
  return {
    corpus: corpus.version,
    corpusSha256: hash(raw),
    model: brokerModel,
    rubric: brokerRubricRevision,
    quote,
    cases,
  };
}

export function decodeEvaluation(prepared, responses) {
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
    const result = decodeBroker(
      response.completion,
      brokerModel,
      item.candidates,
      quote,
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
          .filter((d) => d.selected)
          .map((d) => d.id),
      });
  }
  return {
    corpus: prepared.corpus,
    corpusSha256: prepared.corpusSha256,
    model: prepared.model,
    rubric: prepared.rubric,
    valid: predictions.length === prepared.cases.length,
    confirmedMicros,
    uncertainCases,
    outcomes,
    predictions,
  };
}

async function main() {
  const [mode, input, output] = process.argv.slice(2);
  const prepared = await prepareEvaluation();
  if (mode === 'prepare' && input && !output) {
    // No expected labels or internal candidate records in the handoff artifact.
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
    const result = decodeEvaluation(
      prepared,
      JSON.parse(await readFile(input, 'utf8')),
    );
    await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
    if (!result.valid) process.exitCode = 1;
  } else
    throw new Error(
      'Usage: node --import tsx scripts/prepare-mail-broker-evaluation.mjs prepare <new-requests.json> | decode <responses.json> <new-result.json>',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Evaluation failed: check arguments, completion bindings and unused output path. No network requests were made.',
    );
    process.exitCode = 1;
  });
