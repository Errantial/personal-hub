import { expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@hub/contracts';
import { getJson } from '../src/lib/api';

it('rejects an incompatible successful response instead of treating the API as healthy', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'unknown' }), { status: 200 }),
      ),
  );
  await expect(getJson('/api/health', healthResponseSchema)).rejects.toThrow(
    'incompatible response',
  );
});

it('does not expose server error bodies to the user', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('synthetic-private-error', { status: 500 }),
      ),
  );
  await expect(getJson('/api/health', healthResponseSchema)).rejects.toThrow(
    'The server could not complete this request.',
  );
});

it('explains a rate-limited request instead of reporting a generic failure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'server text is not shown' },
        }),
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    ),
  );
  await expect(getJson('/api/health', healthResponseSchema)).rejects.toThrow(
    'Too many requests from this connection. Wait a few minutes and try again.',
  );
});
