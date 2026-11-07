import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  decodeJevEvaluation,
  prepareJevEvaluation,
} from '../prepare-jev-mail-broker-evaluation.mjs';
import {
  scorePredictions,
  validateEvaluationReceipt,
} from '../evaluate-mail-broker.mjs';
import {
  jevModel,
  jevRubric,
} from '../../apps/api/src/ai/jev-broker-protocol.ts';

function responses(prepared) {
  return prepared.cases.map((item) => ({
    caseId: item.caseId,
    requestSha256: item.requestSha256,
    completion: JSON.stringify({
      model: prepared.model,
      usage: { input_tokens: 100, output_tokens: 20 },
      answers: Object.fromEntries(
        item.candidates.map((candidate) => [
          candidate.id,
          {
            type: 'score',
            score: 0,
            confidence: 1,
            probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 },
            legend: {
              0: jevRubric[0],
              1: jevRubric[1],
              2: jevRubric[2],
              3: jevRubric[3],
            },
          },
        ]),
      ),
    }),
  }));
}

it('prepares all 60 production Jev Score envelopes without labels or network access', async () => {
  const network = vi.fn(() => {
    throw new Error('Network forbidden');
  });
  vi.stubGlobal('fetch', network);
  const prepared = await prepareJevEvaluation();
  expect(prepared).toMatchObject({
    adapter: 'typesafe',
    model: jevModel,
    quote: {
      inputTokenLimit: 32000,
      outputTokenLimit: 1000,
      inputMicrosPerMillionTokens: 42000,
      outputMicrosPerMillionTokens: 0,
    },
  });
  expect(prepared.cases).toHaveLength(60);
  for (const item of prepared.cases) {
    const request = JSON.parse(item.envelope);
    expect(request.model).toBe(jevModel);
    expect(request.state).toHaveProperty('request');
    expect(Object.keys(request.questions)).toHaveLength(item.candidates.length);
    expect(item.envelope).not.toContain('"expected"');
    expect(Buffer.byteLength(item.envelope)).toBeLessThanOrEqual(20480);
    expect(item.requestSha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('decodes complete Jev receipts with canonical request identity and retains known invalid-output billing', async () => {
  const prepared = await prepareJevEvaluation();
  const saved = responses(prepared);
  const decoded = decodeJevEvaluation(prepared, saved);
  expect(decoded.valid).toBe(true);
  expect(decoded.predictions).toHaveLength(60);
  expect(decoded.requests).toEqual(
    prepared.cases.map(({ caseId, requestSha256 }) => ({
      caseId,
      requestSha256,
    })),
  );
  expect(decoded.confirmedMicros).toBe(300);

  const malformed = JSON.parse(saved[0].completion);
  malformed.answers.m1.legend['3'] = 'changed';
  saved[0].completion = JSON.stringify(malformed);
  const invalid = decodeJevEvaluation(prepared, saved);
  expect(invalid.valid).toBe(false);
  expect(invalid.predictions).toHaveLength(59);
  expect(invalid.confirmedMicros).toBe(300);
});

it('scores only receipts bound to the current corpus, adapter revisions and exact request hashes', async () => {
  const prepared = await prepareJevEvaluation();
  const corpus = JSON.parse(
    await readFile(
      new URL(
        '../../tests/fixtures/mail-broker-evaluation.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const predictions = corpus.cases.map((item) => ({
    caseId: item.id,
    selectedKeys: Object.entries(item.expected)
      .filter(([, judgment]) => judgment === 'directly_relevant')
      .map(([key]) => key),
  }));
  const receipt = {
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
    valid: true,
    predictions,
  };
  expect(validateEvaluationReceipt(receipt)).toEqual(predictions);
  expect(scorePredictions(predictions)).toMatchObject({
    passed: true,
    precision: 1,
    recall: 1,
  });
  for (const changed of [
    { model: 'jev-1.13.0' },
    { threshold: 'different-threshold' },
    { corpusSha256: '0'.repeat(64) },
    {
      requests: [
        { ...receipt.requests[0], requestSha256: '0'.repeat(64) },
        ...receipt.requests.slice(1),
      ],
    },
  ])
    expect(() =>
      validateEvaluationReceipt({ ...receipt, ...changed }),
    ).toThrow();
});
