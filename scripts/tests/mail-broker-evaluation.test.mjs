import { expect, it, vi } from 'vitest';
import {
  prepareEvaluation,
  decodeEvaluation,
} from '../prepare-mail-broker-evaluation.mjs';

function responses(prepared) {
  return prepared.cases.map((item) => ({
    caseId: item.caseId,
    requestSha256: item.requestSha256,
    completion: JSON.stringify({
      id: 'gen-synthetic-evaluation',
      model: prepared.model,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cost: 0.000005,
      },
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify(
              Object.fromEntries(
                item.candidates.map((candidate) => [
                  candidate.id,
                  'irrelevant',
                ]),
              ),
            ),
          },
        },
      ],
    }),
  }));
}

it('prepares all synthetic cases without labels or network access using production routing', async () => {
  const network = vi.fn(() => {
    throw new Error('Network forbidden');
  });
  vi.stubGlobal('fetch', network);
  const prepared = await prepareEvaluation();
  expect(prepared.cases).toHaveLength(60);
  for (const item of prepared.cases) {
    const request = JSON.parse(item.envelope);
    const input = JSON.parse(request.messages[1].content);
    expect(Object.keys(input).sort()).toEqual(['candidates', 'request']);
    expect(item.envelope).not.toContain('"expected"');
    expect(request.model).toBe(prepared.model);
    expect(request.provider.allow_fallbacks).toBe(false);
    expect(request.provider.zdr).toBe(true);
    expect(Buffer.byteLength(item.envelope)).toBeLessThanOrEqual(20480);
  }
  expect(network).not.toHaveBeenCalled();
});

it('decodes complete predictions and retains confirmed billing even on invalid output', async () => {
  const prepared = await prepareEvaluation();
  const saved = responses(prepared);
  const decoded = decodeEvaluation(prepared, saved);
  expect(decoded.valid).toBe(true);
  expect(decoded.predictions).toHaveLength(60);
  expect(decoded.confirmedMicros).toBe(300);
  const malformed = JSON.parse(saved[0].completion);
  malformed.choices[0].message.content = '{"foreign":"directly_relevant"}';
  saved[0].completion = JSON.stringify(malformed);
  const invalid = decodeEvaluation(prepared, saved);
  expect(invalid.valid).toBe(false);
  expect(invalid.predictions).toHaveLength(59);
  expect(invalid.confirmedMicros).toBe(300);
});

it('rejects missing, duplicate, mismatched and oversized responses; exposes uncertainty', async () => {
  const prepared = await prepareEvaluation();
  const saved = responses(prepared);
  expect(() => decodeEvaluation(prepared, saved.slice(1))).toThrow();
  expect(() =>
    decodeEvaluation(prepared, [saved[0], ...saved.slice(0, -1)]),
  ).toThrow();
  expect(() =>
    decodeEvaluation(prepared, [
      { ...saved[0], requestSha256: 'wrong' },
      ...saved.slice(1),
    ]),
  ).toThrow();
  expect(() =>
    decodeEvaluation(prepared, [
      { ...saved[0], completion: 'x'.repeat(131073) },
      ...saved.slice(1),
    ]),
  ).toThrow();
  saved[0].completion = '{}';
  const decoded = decodeEvaluation(prepared, saved);
  expect(decoded.valid).toBe(false);
  expect(decoded.uncertainCases).toBe(1);
  expect(decoded.confirmedMicros).toBe(295);
});
