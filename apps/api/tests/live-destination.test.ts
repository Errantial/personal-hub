import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLiveDestination } from '../src/ai/live-destination.js';
import {
  approveLiveDestination,
  model,
  origin,
  startHarness,
} from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// One-click live destination approval (docs/ai-assistant.md). Synthetic
// configuration only; nothing reaches the network.

let harness: Harness;
afterEach(async () => {
  await harness.app.close();
});

const status = async () =>
  (await harness.call('GET', '/api/v1/assistant/destination')).json()
    .destination;
const resolve = () =>
  resolveLiveDestination(harness.database, harness.config, harness.owner);

describe('live destination', () => {
  it('blocks until the owner approves a declared host', async () => {
    harness = await startHarness({ destination: false });
    expect(await status()).toEqual({
      status: 'blocked',
      reason: 'approval-required',
      approved: null,
      model,
      hosts: ['anthropic', 'google-vertex', 'amazon-bedrock'],
      personalMail: false,
      version: 0,
    });
    await expect(resolve()).rejects.toMatchObject({
      code: 'ASSISTANT_ROUTE_UNSET',
    });
    await approveLiveDestination(harness.call);
    expect(await status()).toMatchObject({
      status: 'ready',
      reason: null,
      approved: { model, upstream: 'google-vertex' },
      version: 1,
    });
    expect(await resolve()).toMatchObject({
      model,
      upstream: 'google-vertex',
      version: 1,
    });
  });

  it('rejects hosts the server does not declare for the model', async () => {
    harness = await startHarness({ destination: false });
    const response = await harness.call(
      'PUT',
      '/api/v1/assistant/destination',
      {
        model,
        upstream: 'azure',
        expectedVersion: 0,
      },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('DESTINATION_UNDECLARED');
    expect(
      await harness.database.query('SELECT * FROM ai_live_destinations'),
    ).toEqual([]);
  });

  it('makes the approval stale when the model changes, with no fallback', async () => {
    harness = await startHarness();
    const settings = (
      await harness.call('GET', '/api/v1/assistant/settings')
    ).json().settings;
    await harness.call('PUT', '/api/v1/assistant/settings', {
      model: 'anthropic/claude-sonnet-5.5',
      expectedVersion: settings.version,
    });
    expect(await status()).toMatchObject({
      status: 'blocked',
      reason: 'approval-stale',
    });
    await expect(resolve()).rejects.toMatchObject({
      code: 'ASSISTANT_ROUTE_UNAVAILABLE',
    });
    await approveLiveDestination(harness.call, {
      model: 'anthropic/claude-sonnet-5.5',
    });
    expect((await status()).status).toBe('ready');
  });

  it('makes the approval stale when the live terms change', async () => {
    harness = await startHarness();
    await harness.database.query(
      'UPDATE ai_live_destinations SET revision=$1',
      ['c'.repeat(64)],
    );
    expect((await status()).reason).toBe('approval-stale');
  });

  it('blocks after revocation', async () => {
    harness = await startHarness();
    const revoked = await harness.call(
      'DELETE',
      '/api/v1/assistant/destination',
      { expectedVersion: 1 },
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().destination.reason).toBe('approval-required');
    expect(revoked.json().destination.version).toBe(2);
    await approveLiveDestination(harness.call);
    expect((await status()).version).toBe(3);
    const stale = await harness.call('PUT', '/api/v1/assistant/destination', {
      model,
      upstream: 'anthropic',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('previews a draft model without changing settings or approval', async () => {
    harness = await startHarness();
    const preview = await harness.call(
      'GET',
      '/api/v1/assistant/destination?model=openai%2Fgpt-5',
    );
    expect(preview.json().destination).toMatchObject({
      model: 'openai/gpt-5',
      hosts: ['openai', 'azure'],
      reason: 'approval-stale',
      version: 1,
    });
    expect((await status()).model).toBe(model);
    expect((await resolve()).model).toBe(model);
  });

  it('saves the approved model and checks the version', async () => {
    harness = await startHarness();
    const approved = await harness.call(
      'PUT',
      '/api/v1/assistant/destination',
      { model: 'openai/gpt-5', upstream: 'azure', expectedVersion: 1 },
    );
    expect(approved.json().destination).toMatchObject({
      status: 'ready',
      model: 'openai/gpt-5',
      approved: { model: 'openai/gpt-5', upstream: 'azure' },
      version: 2,
    });
    expect(
      (await harness.call('GET', '/api/v1/assistant/settings')).json().settings
        .model,
    ).toBe('openai/gpt-5');
    const stale = await harness.call('PUT', '/api/v1/assistant/destination', {
      model,
      upstream: 'anthropic',
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  });

  it('reports the Personal mail switch', async () => {
    harness = await startHarness();
    const settings = (
      await harness.call('GET', '/api/v1/assistant/settings')
    ).json().settings;
    await harness.call('PUT', '/api/v1/assistant/settings', {
      model: settings.model,
      expectedVersion: settings.version,
      allowPersonalMail: true,
    });
    expect((await status()).personalMail).toBe(true);
  });

  it('reports a missing server key', async () => {
    harness = await startHarness({ key: null, destination: false });
    expect((await status()).reason).toBe('key-missing');
    await expect(resolve()).rejects.toMatchObject({
      code: 'ASSISTANT_NOT_CONFIGURED',
    });
  });

  it('requires a session and never returns private values', async () => {
    harness = await startHarness();
    for (const [method, url] of [
      ['GET', '/api/v1/assistant/destination'],
      ['PUT', '/api/v1/assistant/destination'],
      ['DELETE', '/api/v1/assistant/destination'],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        headers: { origin },
        ...(method === 'GET'
          ? {}
          : {
              payload: {
                ...(method === 'PUT' ? { model, upstream: 'anthropic' } : {}),
                expectedVersion: 1,
                operationId: randomUUID(),
              },
            }),
      });
      expect(response.statusCode).toBe(401);
    }
    const body = (await harness.call('GET', '/api/v1/assistant/destination'))
      .body;
    expect(body).not.toMatch(/revision|integrity|AI_SECRET|sk-or/);
  });
});
