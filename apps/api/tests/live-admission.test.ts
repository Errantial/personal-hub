import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { boundLiveHash } from '../src/ai/context-binding.js';
import { sealEnvelope } from '../src/ai/live-envelope.js';
import {
  destinationRevision,
  decodeCompletion,
  exchange,
  hasPrivateHost,
  pinnedRouting,
  zdrUrl,
} from '../src/ai/openrouter-live.js';
import type { OpenRouterFetch } from '../src/ai/openrouter-live.js';
import { completion, model } from './helpers/openrouter.js';

// Live context admission (docs/live-context-admission-design.md). Every
// exchange is injected; nothing reaches the network.

const owner = randomUUID();
const zdrList = (tags: [string, string][]) =>
  new Response(
    JSON.stringify({
      data: tags.map(([modelId, tag]) => ({
        model_id: modelId,
        tag,
        supported_parameters: ['structured_outputs'],
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('sealed envelopes', () => {
  it('sends the sealed bytes exactly', async () => {
    const body = {
      model,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Synthetic ask' }],
    };
    const sealed = sealEnvelope(owner, randomUUID(), body, { sources: [] });
    body.messages[0]!.content = 'Mutated after sealing';
    let sent: unknown;
    const fetcher: OpenRouterFetch = async (_url, init) => {
      sent = init.body;
      return completion({ reply: 'ok', actions: [] });
    };
    await exchange(fetcher, 'synthetic-key', sealed);
    expect(sent).toBe(sealed.bytes);
    expect(sealed.bytes).toContain('Synthetic ask');
    expect(sealed.bytes).not.toContain('Mutated');
  });

  it('freezes the envelope and binds bytes and manifest in the hash', () => {
    const requestId = randomUUID();
    const manifest = { sources: [{ id: 'a' }, { id: 'b' }] };
    const sealed = sealEnvelope(
      owner,
      requestId,
      { model, max_tokens: 100 },
      manifest,
    );
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.manifest)).toBe(true);
    manifest.sources.pop();
    expect(sealed.manifest).toEqual({ sources: [{ id: 'a' }, { id: 'b' }] });
    expect(boundLiveHash(owner, requestId, sealed.bytes, sealed.manifest)).toBe(
      sealed.integrityHash,
    );
    expect(
      boundLiveHash(owner, requestId, sealed.bytes + ' ', sealed.manifest),
    ).not.toBe(sealed.integrityHash);
    expect(
      boundLiveHash(owner, requestId, sealed.bytes, {
        sources: [{ id: 'b' }, { id: 'a' }],
      }),
    ).not.toBe(sealed.integrityHash);
  });
});

describe('pinned destinations', () => {
  it('rejects a different response model even when its name has the approved prefix', async () => {
    const raw = await completion('Synthetic reply').text();
    expect(decodeCompletion(raw, model, 100)).toMatchObject({
      outputState: 'validated',
    });
    expect(
      decodeCompletion(
        raw.replace(`"model":"${model}"`, `"model":"${model}-other"`),
        model,
        100,
      ),
    ).toMatchObject({
      status: 'confirmed',
      content: null,
      outputState: 'blocked',
    });
  });
  it('pins one upstream without fallback', () => {
    expect(pinnedRouting('google-vertex')).toEqual({
      only: ['google-vertex'],
      order: ['google-vertex'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      zdr: true,
    });
  });

  it('checks the pinned upstream against the ZDR list', async () => {
    const fetcher: OpenRouterFetch = async (url) => {
      expect(url).toBe(zdrUrl);
      return zdrList([
        [model, 'google-vertex/global'],
        [model, 'azure/x'],
      ]);
    };
    expect(await hasPrivateHost(fetcher, model, 'google-vertex')).toBe(true);
    expect(await hasPrivateHost(fetcher, model, 'anthropic')).toBe(false);
    // Azure is not a declared host for Anthropic models.
    expect(await hasPrivateHost(fetcher, model, 'azure')).toBe(false);
  });

  it('binds model, upstream and terms in the destination revision', () => {
    const base = destinationRevision(model, 'google-vertex');
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(destinationRevision(model, 'anthropic')).not.toBe(base);
    expect(destinationRevision('anthropic/other', 'google-vertex')).not.toBe(
      base,
    );
  });
});
