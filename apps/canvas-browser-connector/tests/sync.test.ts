import { expect, it, vi } from 'vitest';
import type { Hub } from '../src/hub.js';
import type { BrowserCollector } from '../src/runtime.js';
import { CollectionError } from '../src/extract.js';
import { syncBrowser, syncWithBrowserFactory } from '../src/sync.js';

function hub(selected = true) {
  let reads = 0;
  return {
    state: vi.fn<Hub['state']>(async () => ({
      sourceVersion: 4,
      courses:
        reads++ === 0 || !selected
          ? []
          : [
              {
                id: '11111111-1111-4111-8111-111111111111',
                providerId: '10',
                canonicalUrl: 'https://canvas.colorado.edu/courses/10',
                version: 2,
              },
            ],
    })),
    begin: vi.fn<Hub['begin']>(async () => undefined),
    discovery: vi.fn<Hub['discovery']>(async () => undefined),
    course: vi.fn<Hub['course']>(async () => undefined),
    finish: vi.fn<Hub['finish']>(async () => undefined),
  };
}

const course = {
  providerId: '10',
  name: 'Synthetic course',
  canonicalUrl: 'https://canvas.colorado.edu/courses/10',
};
const item = {
  resourceKind: 'assignment' as const,
  providerId: '20',
  canonicalUrl: 'https://canvas.colorado.edu/courses/10/assignments/20',
  title: 'Synthetic assignment',
  dueAt: null,
};

function browser(overrides: Partial<BrowserCollector> = {}): BrowserCollector {
  return {
    discover: async () => ({ status: 'complete', courses: [course] }),
    collectCourse: async () => ({ status: 'complete', items: [item] }),
    close: async () => undefined,
    ...overrides,
  };
}

it('finishes complete only after discovery and every selected course complete', async () => {
  const target = hub();
  expect(
    await syncBrowser(target, browser(), () => '2026-10-16T19:00:00.000Z'),
  ).toEqual({ outcome: 'complete', courses: 1, complete: 1 });
  expect(target.discovery).toHaveBeenCalledWith(
    expect.any(String),
    'complete',
    '2026-10-16T19:00:00.000Z',
    [course],
  );
  expect(target.course).toHaveBeenCalledWith(
    expect.any(String),
    '11111111-1111-4111-8111-111111111111',
    'complete',
    '2026-10-16T19:00:00.000Z',
    [item],
  );
  expect(target.finish).toHaveBeenLastCalledWith(
    expect.any(String),
    'complete',
    undefined,
  );
});

it('reports partial rather than complete for uncertain traversal or no selected course', async () => {
  const target = hub();
  const result = await syncBrowser(
    target,
    browser({
      collectCourse: async () => ({ status: 'partial', items: [item] }),
    }),
  );
  expect(result.outcome).toBe('partial');
  expect(target.finish).toHaveBeenLastCalledWith(
    expect.any(String),
    'partial',
    'traversal-failed',
  );

  const noSelection = hub(false);
  expect((await syncBrowser(noSelection, browser())).outcome).toBe('partial');
});

it('turns session expiry into a bounded failed receipt without exposing browser text', async () => {
  const target = hub();
  await expect(
    syncBrowser(
      target,
      browser({
        discover: async () => {
          throw new CollectionError('sign-in-required');
        },
      }),
    ),
  ).rejects.toMatchObject({ code: 'sign-in-required' });
  expect(target.finish).toHaveBeenCalledWith(
    expect.any(String),
    'failed',
    'sign-in-required',
  );
});

it('records browser launch failure after attempt admission and before any DOM work', async () => {
  const target = hub();
  await expect(
    syncWithBrowserFactory(target, async () => {
      throw new CollectionError('browser-unavailable');
    }),
  ).rejects.toMatchObject({ code: 'browser-unavailable' });
  expect(target.begin).toHaveBeenCalledTimes(1);
  expect(target.finish).toHaveBeenCalledWith(
    expect.any(String),
    'failed',
    'browser-unavailable',
  );
});
