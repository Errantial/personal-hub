import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sealEnvelope } from '../src/ai/live-envelope.js';
import { admitLive, findReplay } from '../src/ai/live-request.js';
import {
  admitPlanner as admit,
  createTask,
  exchangeState as state,
  transmit as send,
} from './helpers/live.js';
import { model, startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// Admission binding and the final transmission guard
// (docs/live-context-admission-design.md). Exchanges are injected.

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

describe('admission binding', () => {
  it.each([undefined, { only: ['anthropic'], allow_fallbacks: true }])(
    'rejects an integrity-bound envelope without the approved pinned route (%j)',
    async (provider) => {
      harness = await startHarness();
      const { sealed: template } = await admit(harness);
      const requestId = randomUUID();
      const body = {
        model,
        max_tokens: 100,
        ...(provider ? { provider } : {}),
      };
      const sealed = sealEnvelope(harness.owner, requestId, body, {
        ...template.manifest,
        requestId,
        bytes: Buffer.byteLength(JSON.stringify(body)),
      });
      await admitLive(harness.database, harness.owner, {
        id: requestId,
        kind: 'planner',
        operationId: randomUUID(),
        hash: 'synthetic-route',
        model,
        maximumMicros: 1000,
        withheld: 0,
        sealed,
      });
      expect(await send(harness, sealed)).toMatchObject({
        status: 'withheld',
        reason: 'context-changed',
      });
      expect(harness.chatCalls()).toBe(0);
      expect(await state(harness, requestId)).toMatchObject({
        hold: 'released',
        actual: 0,
        guard: 'blocked',
      });
    },
  );

  it('does not resurrect an old admitted approval after revoke and reapprove', async () => {
    harness = await startHarness();
    const { sealed } = await admit(harness);
    await harness.call('DELETE', '/api/v1/assistant/destination', {
      expectedVersion: 1,
    });
    await harness.call('PUT', '/api/v1/assistant/destination', {
      model,
      upstream: 'google-vertex',
      expectedVersion: 2,
    });
    expect(await send(harness, sealed)).toMatchObject({
      reason: 'route-blocked',
    });
    expect(harness.chatCalls()).toBe(0);
  });

  it('admits the binding atomically with the hold', async () => {
    harness = await startHarness();
    const { sealed } = await admit(harness);
    const requestId = randomUUID();
    // An invalid binding fails its CHECK; the hold and request roll back.
    const broken = {
      ...sealEnvelope(
        harness.owner,
        requestId,
        { model, max_tokens: 100 },
        sealed.manifest,
      ),
      integrityHash: 'not-a-digest',
    };
    await expect(
      admitLive(harness.database, harness.owner, {
        id: requestId,
        kind: 'planner',
        operationId: randomUUID(),
        hash: 'h',
        model,
        maximumMicros: 1000,
        withheld: 0,
        sealed: broken,
      }),
    ).rejects.toThrow();
    expect(
      await harness.database.query(
        'SELECT 1 FROM ai_assistant_requests WHERE id=$1 UNION ALL SELECT 1 FROM ai_budget_reservations WHERE request_id=$1',
        [requestId],
      ),
    ).toEqual([]);
  });

  it('never stores prompt text in the manifest', async () => {
    harness = await startHarness();
    await createTask(harness, 'Synthetic private title');
    const { sealed } = await admit(harness);
    const [row] = await harness.database.query(
      'SELECT manifest::text AS manifest FROM ai_live_exchanges WHERE request_id=$1',
      [sealed.requestId],
    );
    expect(row!.manifest).not.toContain('Synthetic private title');
  });
});

describe('final transmission guard', () => {
  it('sends a verified exchange once and marks it verified', async () => {
    harness = await startHarness();
    await createTask(harness, 'Synthetic task');
    const { sealed } = await admit(harness);
    expect((await send(harness, sealed)).status).toBe('confirmed');
    expect(harness.chatCalls()).toBe(1);
    expect((await state(harness, sealed.requestId))!.guard).toBe('verified');
  });

  it('withholds a post-hash mutation and releases the hold', async () => {
    harness = await startHarness();
    const { sealed } = await admit(harness, (s) => ({
      ...s,
      bytes: s.bytes.replace('}', ' }'),
    }));
    expect(await send(harness, sealed)).toEqual({
      status: 'withheld',
      reason: 'context-changed',
    });
    expect(harness.chatCalls()).toBe(0);
    expect(await state(harness, sealed.requestId)).toEqual({
      status: 'failed',
      reason: 'context-changed',
      hold: 'released',
      actual: 0,
      guard: 'blocked',
    });
  });

  it('withholds a source byte change without a version change', async () => {
    harness = await startHarness();
    const task = await createTask(harness, 'Synthetic task');
    const { sealed } = await admit(harness);
    await harness.database.query(
      "UPDATE tasks SET title='Changed' WHERE id=$1",
      [task.id],
    );
    expect(await send(harness, sealed)).toMatchObject({
      status: 'withheld',
      reason: 'context-changed',
    });
    expect(harness.chatCalls()).toBe(0);
  });

  it.each([
    [
      'a relabel',
      "UPDATE tasks SET sensitivity='personal',version=version+1 WHERE id=$1",
    ],
    [
      'a deletion',
      'UPDATE tasks SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1',
    ],
  ])('withholds after %s', async (_name, change) => {
    harness = await startHarness();
    const task = await createTask(harness, 'Synthetic task');
    const { sealed } = await admit(harness);
    await harness.database.query(change, [task.id]);
    expect(await send(harness, sealed)).toMatchObject({
      reason: 'context-changed',
    });
    expect(harness.chatCalls()).toBe(0);
  });

  it('withholds after settings or destination changes', async () => {
    harness = await startHarness();
    const settingsChange = await admit(harness);
    const settings = (
      await harness.call('GET', '/api/v1/assistant/settings')
    ).json().settings;
    await harness.call('PUT', '/api/v1/assistant/settings', {
      model: settings.model,
      expectedVersion: settings.version,
      useMail: true,
    });
    expect(await send(harness, settingsChange.sealed)).toMatchObject({
      reason: 'context-changed',
    });
    const reapproved = await admit(harness);
    await harness.call('PUT', '/api/v1/assistant/destination', {
      model,
      upstream: 'google-vertex',
      expectedVersion: 1,
    });
    expect(await send(harness, reapproved.sealed)).toMatchObject({
      reason: 'route-blocked',
    });
    const revoked = await admit(harness);
    await harness.call('DELETE', '/api/v1/assistant/destination', {
      expectedVersion: 2,
    });
    expect(await send(harness, revoked.sealed)).toMatchObject({
      reason: 'route-blocked',
    });
    expect(harness.chatCalls()).toBe(0);
  });

  it('withholds when the owner is no longer authorized', async () => {
    harness = await startHarness();
    const { sealed } = await admit(harness);
    expect(
      await send(harness, sealed, { authority: async () => false }),
    ).toMatchObject({ reason: 'context-changed' });
    expect(harness.chatCalls()).toBe(0);
  });

  it('keeps a thrown transport uncertain', async () => {
    harness = await startHarness();
    harness.state.chat = () => {
      throw new Error('connection reset');
    };
    const { sealed } = await admit(harness);
    expect(await send(harness, sealed)).toMatchObject({
      status: 'uncertain',
      reason: 'transport',
    });
    expect(await state(harness, sealed.requestId)).toMatchObject({
      status: 'uncertain',
      hold: 'uncertain',
      guard: 'verified',
    });
  });

  it('keeps uncertainty across a restart and never resends', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hub-live-'));
    try {
      harness = await startHarness({ dataDir });
      harness.state.chat = () => {
        throw new Error('connection reset');
      };
      const { sealed, operationId } = await admit(harness);
      await send(harness, sealed);
      await harness.app.close();
      harness = await startHarness({ dataDir });
      expect(
        await findReplay(
          harness.database,
          harness.owner,
          'planner',
          operationId,
          'synthetic-hash',
        ),
      ).toMatchObject({ status: 'uncertain' });
      // The verified exchange can never pass the guard again.
      expect(await send(harness, sealed)).toMatchObject({
        status: 'withheld',
      });
      expect(harness.chatCalls()).toBe(0);
      expect((await state(harness, sealed.requestId))!.hold).toBe('uncertain');
    } finally {
      await harness?.app.close();
      harness = undefined;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
