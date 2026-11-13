import { randomUUID } from 'node:crypto';
import { CollectionError } from './extract.js';
import type { Hub } from './hub.js';
import type { BrowserCollector } from './runtime.js';

export async function syncBrowser(
  hub: Hub,
  browser: BrowserCollector,
  now = () => new Date().toISOString(),
) {
  const attemptId = await beginSync(hub);
  return syncBrowserAttempt(hub, browser, attemptId, now);
}

export async function beginSync(hub: Hub) {
  const state = await hub.state();
  const attemptId = randomUUID();
  await hub.begin(attemptId, state.sourceVersion);
  return attemptId;
}

export async function syncBrowserAttempt(
  hub: Hub,
  browser: BrowserCollector,
  attemptId: string,
  now = () => new Date().toISOString(),
) {
  let partialReason:
    'traversal-failed' | 'traversal-limit' | 'outlook-unavailable' | undefined;
  try {
    const discovery = await browser.discover();
    await hub.discovery(attemptId, discovery.status, now(), discovery.folders);
    if (discovery.status === 'partial') partialReason = 'traversal-failed';
    const selected = (await hub.state()).folders;
    let complete = 0;
    for (const folder of selected) {
      const observation = await browser.collectFolder(folder);
      await hub.folder(
        attemptId,
        folder.id,
        observation.status,
        now(),
        observation.messages,
      );
      if (observation.status === 'complete') complete++;
      else partialReason ??= 'traversal-failed';
    }
    const allComplete =
      discovery.status === 'complete' &&
      selected.length > 0 &&
      complete === selected.length;
    await hub.finish(
      attemptId,
      allComplete ? 'complete' : 'partial',
      allComplete ? undefined : partialReason,
    );
    return {
      outcome: allComplete ? ('complete' as const) : ('partial' as const),
      folders: selected.length,
      complete,
    };
  } catch (error) {
    const code =
      error instanceof CollectionError ? error.code : 'traversal-failed';
    await hub.finish(attemptId, 'failed', code).catch(() => undefined);
    throw error;
  }
}

export async function syncWithBrowserFactory(
  hub: Hub,
  open: () => Promise<BrowserCollector>,
  now = () => new Date().toISOString(),
) {
  const attemptId = await beginSync(hub);
  let browser: BrowserCollector | null = null;
  try {
    browser = await open();
    return await syncBrowserAttempt(hub, browser, attemptId, now);
  } catch (error) {
    if (!browser) {
      const code =
        error instanceof CollectionError ? error.code : 'browser-unavailable';
      await hub.finish(attemptId, 'failed', code).catch(() => undefined);
    }
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
