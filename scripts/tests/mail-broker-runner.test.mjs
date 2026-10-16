import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runEvaluation } from '../run-mail-broker-evaluation.mjs';
import { brokerModel } from '../../apps/api/src/ai/broker-protocol.ts';
import {
  chatUrl,
  modelsUrl,
  zdrUrl,
} from '../../apps/api/src/ai/openrouter-live.ts';

async function setup({
  cost = 0.000005,
  lost = false,
  expensive = false,
} = {}) {
  await mkdir('.artifacts', { recursive: true });
  const directory = join(
    '.artifacts',
    `broker-experiment-test-${randomUUID()}`,
  );
  const fetcher = vi.fn(async (url, init) => {
    if (init.method === 'GET') {
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.redirect).toBe('error');
      const pricing = {
        prompt: expensive ? '1' : '0.0000001',
        completion: '0.0000004',
      };
      if (url === modelsUrl)
        return Response.json({
          data: [
            {
              id: brokerModel,
              architecture: {
                input_modalities: ['text'],
                output_modalities: ['text'],
              },
              pricing,
            },
          ],
        });
      expect(url).toBe(zdrUrl);
      return Response.json({
        data: [
          {
            model_id: brokerModel,
            tag: 'google-vertex/global',
            supported_parameters: [
              'structured_outputs',
              'response_format',
              'max_tokens',
            ],
            context_length: 1048576,
            max_completion_tokens: 65535,
            pricing,
          },
        ],
      });
    }
    expect(url).toBe(chatUrl);
    const entries = (await readFile(join(directory, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(entries.at(-1).kind).toBe('admitted');
    expect(init.headers.Authorization).toBe('Bearer synthetic-test-key');
    const request = JSON.parse(init.body);
    expect(request.provider.allow_fallbacks).toBe(false);
    expect(request.provider.zdr).toBe(true);
    expect(request.model).toBe(brokerModel);
    expect(init.body).not.toContain('"expected"');
    if (lost) throw new Error('fake lost response');
    return Response.json({
      id: 'gen-synthetic-test',
      model: brokerModel,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        cost,
      },
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify(
              Object.fromEntries(
                Object.keys(
                  request.response_format.json_schema.schema.properties,
                ).map((key) => [key, 'irrelevant']),
              ),
            ),
          },
        },
      ],
    });
  });
  return {
    directory,
    fetcher,
    secret: 'synthetic-test-key',
    execute: true,
    maxMicros: 10000,
    now: () => Date.parse('2026-10-16T00:00:00Z'),
  };
}
const posts = (fetcher) =>
  fetcher.mock.calls.filter(([, init]) => init.method === 'POST');

it('journals admissions before sending all 60 canonical synthetic cases and refuses reruns', async () => {
  const args = await setup();
  const result = await runEvaluation(args);
  expect(result).toMatchObject({
    valid: true,
    confirmedMicros: 300,
    heldMicros: 0,
    stopReason: 'complete',
  });
  expect(result.predictions).toHaveLength(60);
  expect(posts(args.fetcher)).toHaveLength(60);
  const journal = await readFile(join(args.directory, 'journal.jsonl'), 'utf8');
  expect(journal).not.toContain(args.secret);
  await expect(runEvaluation(args)).rejects.toThrow();
  expect(posts(args.fetcher)).toHaveLength(60);
});

it('blocks absent authorization, invalid caps and expired quotes before any network access', async () => {
  const args = await setup();
  for (const override of [
    { execute: false },
    { secret: '' },
    { maxMicros: 250001 },
    { maxMicros: -1 },
    { maxMicros: 1.5 },
    { now: () => Date.parse('2026-11-15T00:00:00Z') },
  ])
    await expect(runEvaluation({ ...args, ...override })).rejects.toThrow();
  expect(args.fetcher).not.toHaveBeenCalled();
});

it('stops before the next exchange when its reservation cannot fit', async () => {
  const args = await setup();
  const result = await runEvaluation({ ...args, maxMicros: 4020 });
  expect(result).toMatchObject({
    valid: false,
    stopReason: 'cap',
    confirmedMicros: 5,
    heldMicros: 0,
  });
  expect(posts(args.fetcher)).toHaveLength(1);
});

it('retains an uncertain admission and never sends another case or retries the journal', async () => {
  const args = await setup({ lost: true });
  const result = await runEvaluation(args);
  expect(result).toMatchObject({
    valid: false,
    stopReason: 'uncertain',
    confirmedMicros: 0,
    heldMicros: 4020,
  });
  expect(posts(args.fetcher)).toHaveLength(1);
  await expect(runEvaluation(args)).rejects.toThrow();
  expect(posts(args.fetcher)).toHaveLength(1);
});

it('blocks an endpoint with unacceptable prices without paid dispatch', async () => {
  const args = await setup({ expensive: true });
  expect(await runEvaluation(args)).toMatchObject({
    valid: false,
    stopReason: 'endpoint-blocked',
    confirmedMicros: 0,
    heldMicros: 0,
  });
  expect(posts(args.fetcher)).toHaveLength(0);
});

it('records the full actual overrun and stops before further sends', async () => {
  const args = await setup({ cost: 0.3 });
  expect(await runEvaluation(args)).toMatchObject({
    valid: false,
    stopReason: 'invalid-output',
    confirmedMicros: 300000,
    heldMicros: 0,
  });
  expect(posts(args.fetcher)).toHaveLength(1);
});
