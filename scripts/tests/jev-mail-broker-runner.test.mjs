import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runJevEvaluation } from '../run-jev-mail-broker-evaluation.mjs';
import { jevEndpoint } from '../../apps/api/src/ai/jev-policy.ts';
import {
  jevModel,
  jevRubric,
} from '../../apps/api/src/ai/jev-broker-protocol.ts';

async function setup({ lost = false, invalid = false } = {}) {
  await mkdir('.artifacts', { recursive: true });
  const directory = join(
    '.artifacts',
    `jev-broker-experiment-test-${randomUUID()}`,
  );
  const fetcher = vi.fn(async (url, init) => {
    expect(url).toBe(jevEndpoint);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers.authorization).toBe('Bearer synthetic-test-key');
    const entries = (await readFile(join(directory, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(entries.at(-1).kind).toBe('admitted');
    const request = JSON.parse(init.body);
    expect(request.model).toBe(jevModel);
    expect(init.body).not.toContain('"expected"');
    if (lost) throw new Error('synthetic lost response');
    const legend = {
      0: jevRubric[0],
      1: jevRubric[1],
      2: jevRubric[2],
      3: jevRubric[3],
    };
    if (invalid) legend['3'] = 'changed';
    return Response.json({
      model: jevModel,
      usage: { input_tokens: 100, output_tokens: 20 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          {
            type: 'score',
            score: 0,
            confidence: 1,
            probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 },
            legend,
          },
        ]),
      ),
    });
  });
  return {
    directory,
    fetcher,
    secret: 'synthetic-test-key',
    execute: true,
    maxMicros: 100000,
    now: () => Date.parse('2026-10-19T00:00:00Z'),
  };
}

it('journals each Jev admission before one direct send and refuses directory reuse', async () => {
  const args = await setup();
  const result = await runJevEvaluation(args);
  expect(result).toMatchObject({
    adapter: 'typesafe',
    valid: true,
    confirmedMicros: 300,
    heldMicros: 0,
    stopReason: 'complete',
  });
  expect(result.predictions).toHaveLength(60);
  expect(args.fetcher).toHaveBeenCalledTimes(60);
  const journal = await readFile(join(args.directory, 'journal.jsonl'), 'utf8');
  expect(journal).not.toContain(args.secret);
  await expect(runJevEvaluation(args)).rejects.toThrow();
  expect(args.fetcher).toHaveBeenCalledTimes(60);
});

it('blocks missing authorization, invalid caps and expired dated quote before network access', async () => {
  const args = await setup();
  for (const override of [
    { execute: false },
    { secret: '' },
    { maxMicros: 250001 },
    { maxMicros: -1 },
    { maxMicros: 1.5 },
    { now: () => Date.parse('2026-11-19T00:00:00Z') },
  ])
    await expect(runJevEvaluation({ ...args, ...override })).rejects.toThrow();
  expect(args.fetcher).not.toHaveBeenCalled();
});

it('stops before a second exchange when the explicit allowance cannot fit another reservation', async () => {
  const args = await setup();
  const result = await runJevEvaluation({ ...args, maxMicros: 1344 });
  expect(result).toMatchObject({
    valid: false,
    stopReason: 'cap',
    confirmedMicros: 5,
    heldMicros: 0,
  });
  expect(args.fetcher).toHaveBeenCalledTimes(1);
});

it('retains an uncertain admitted reservation and never retries or sends another case', async () => {
  const args = await setup({ lost: true });
  const result = await runJevEvaluation(args);
  expect(result).toMatchObject({
    valid: false,
    stopReason: 'uncertain',
    confirmedMicros: 0,
    heldMicros: 1344,
  });
  expect(args.fetcher).toHaveBeenCalledTimes(1);
  await expect(runJevEvaluation(args)).rejects.toThrow();
  expect(args.fetcher).toHaveBeenCalledTimes(1);
});

it('settles known invalid-output billing and stops before another request', async () => {
  const args = await setup({ invalid: true });
  const result = await runJevEvaluation(args);
  expect(result).toMatchObject({
    valid: false,
    stopReason: 'invalid-output',
    confirmedMicros: 5,
    heldMicros: 0,
  });
  expect(args.fetcher).toHaveBeenCalledTimes(1);
});
