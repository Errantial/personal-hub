import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';

const root = process.cwd();
const connector = join(root, 'apps', 'outlook-browser-connector');
const compiledPath = join(connector, 'dist', 'dom.js');

function buildCompiledConnector() {
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(connector, 'tsconfig.build.json'),
    ],
    { cwd: root, stdio: 'pipe' },
  );
}

function chromiumExecutable() {
  const candidates = [chromium.executablePath()];
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache))
    for (const directory of readdirSync(cache)) {
      if (!directory.startsWith('chromium-') || directory.includes('headless'))
        continue;
      for (const relative of [
        'chrome-linux/chrome',
        'chrome-linux-arm64/chrome',
        'chrome-win/chrome.exe',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ])
        candidates.push(join(cache, directory, relative));
    }
  return candidates.find((path) => existsSync(path)) ?? null;
}

const executablePath = chromiumExecutable();
const browserAvailable = Boolean(executablePath);

it.skipIf(!browserAvailable)(
  'executes compiled serialized projections in real Chromium',
  async () => {
    buildCompiledConnector();
    const compiled = (await import(
      `${pathToFileURL(compiledPath).href}?v=${Date.now()}`
    )) as typeof import('../src/dom.js');
    expect(compiled.readMessageList.toString()).not.toContain('__name');

    const browser = await chromium.launch({
      headless: true,
      executablePath: executablePath!,
    });
    try {
      const page = await browser.newPage();
      const rows = Array.from({ length: 30 }, (_, index) => {
        const suffix = String(index + 1).padStart(4, '0');
        return `<div role="option" aria-posinset="${index + 1}">
          <a href="/mail/inbox/id/syntheticMessage${suffix}">
            <span data-testid="message-subject">Synthetic ${suffix}</span>
          </a>
          <span data-testid="message-sender">Synthetic Advisor</span>
        </div>`;
      }).join('');
      await page.setContent(`<!doctype html><html><body>
        <div style="height:5000px">
          <div data-testid="message-list">
            <div role="listbox" style="height:120px;overflow-y:auto">
              ${rows}
            </div>
          </div>
        </div>
      </body></html>`);
      const list = (await page.evaluate(
        `(${compiled.readMessageList.toString()})(document, ${JSON.stringify(compiled.domSelectors)})`,
      )) as { options: number; unresolved: number; scrollHeight: number };
      expect(list).toMatchObject({ options: 30, unresolved: 0 });
      expect(list.scrollHeight).toBeGreaterThan(120);
      expect(list.scrollHeight).toBeLessThan(5000);
      const scrolled = (await page.evaluate(
        `(${compiled.scrollMessageList.toString()})(document, ${JSON.stringify(compiled.domSelectors)}, 'next')`,
      )) as { scrollTop: number };
      expect(scrolled.scrollTop).toBeGreaterThan(0);
      expect(
        await page.evaluate(() => document.scrollingElement!.scrollTop),
      ).toBe(0);

      await page.setContent(`<!doctype html><html><body>
        <div data-testid="reading-pane" data-conversation-id="syntheticConversation0001">
          <h1 data-testid="message-subject">Synthetic subject</h1>
          <div data-testid="message-sender" data-email-address="advisor@example.test">Synthetic Advisor</div>
          <time datetime="2026-11-01T15:30:00Z"></time>
          <div data-testid="message-body" role="document">Synthetic body.</div>
        </div>
      </body></html>`);
      const pane = (await page.evaluate(
        `(${compiled.readReadingPane.toString()})(document.querySelector('[data-testid="reading-pane"]'), ${JSON.stringify(
          {
            expected: {
              providerId: 'syntheticMessage0001',
              folderProviderId: 'inbox',
              subject: 'Synthetic subject',
              sender: 'Synthetic Advisor',
              conversationId: 'syntheticConversation0001',
            },
            selectors: compiled.domSelectors,
          },
        )})`,
      )) as {
        status: string;
        detail?: {
          subject: string;
          sender: string;
          senderAddress: string;
          bodyText: string;
        };
      };
      expect(pane).toMatchObject({
        status: 'ok',
        detail: {
          subject: 'Synthetic subject',
          sender: 'Synthetic Advisor',
          senderAddress: 'advisor@example.test',
          bodyText: 'Synthetic body.',
        },
      });
    } finally {
      await browser.close();
    }
  },
  60000,
);
