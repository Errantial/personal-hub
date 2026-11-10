// Production-like browser check of the built app behind the shipped Caddy
// site block: the content security policy, compression, cache-first assets,
// offline shell and ordinary writes, on loopback with a synthetic owner and a
// temporary embedded database. It never reads .env, the owner's database or
// the live server. Run `npm run build` first.
//
//   npm run edge:check -- [path-to-caddy]
/* global document, location, window -- used inside page callbacks */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const located = spawnSync('sh', ['-c', 'command -v caddy'], {
  encoding: 'utf8',
}).stdout.trim();
const caddy =
  process.argv[2] ??
  (located ||
    (existsSync('/opt/personal-hub/caddy') ? '/opt/personal-hub/caddy' : ''));
if (!caddy || !existsSync(caddy)) {
  console.log('SKIP: no caddy binary found; pass its path to run this check.');
  process.exit(0);
}
const staticRoot = join(root, 'apps/web/dist');
const server = join(root, 'apps/api/dist/server.js');
if (!existsSync(join(staticRoot, 'index.html')) || !existsSync(server)) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const work = mkdtempSync(join(tmpdir(), 'hub-edge-'));
const children = [];
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
let browser;
let current = 'start';
// Name each step so a failure or hang says where it happened.
const step = (name) => {
  current = name;
  if (process.env.EDGE_CHECK_VERBOSE) console.error(`- ${name}`);
};
// No step should take minutes; fail loudly instead of hanging.
const watchdog = setTimeout(() => {
  console.error(`Edge check timed out during: ${current}`);
  void cleanup().finally(() => process.exit(1));
}, 300_000);
async function cleanup() {
  await browser?.close().catch(() => undefined);
  for (const child of children) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(work, { recursive: true, force: true });
}

try {
  const [sitePort, apiPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${sitePort}`;
  children.push(
    spawn(process.execPath, [server], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        API_HOST: '127.0.0.1',
        API_PORT: String(apiPort),
        WEB_ORIGINS: base,
        PGLITE_DATA_DIR: join(work, 'database'),
        DATABASE_URL: '',
        TRUST_PROXY: 'loopback',
        LOG_LEVEL: 'error',
        AGENT_WORKER: 'off',
        AI_PROVIDER_PROFILES: '[]',
        AI_SECRET_OPENROUTER: '',
        CANVAS_CALENDAR_FEED_URL: '',
        CANVAS_API_TOKEN: '',
      },
    }),
  );
  writeFileSync(
    join(work, 'Caddyfile'),
    `{\n\tadmin off\n\tauto_https off\n\tstorage file_system ${join(work, 'storage')}\n}\nimport ${join(root, 'deploy/oracle-linux/Caddyfile')}\n`,
  );
  children.push(
    spawn(
      caddy,
      ['run', '--config', join(work, 'Caddyfile'), '--adapter', 'caddyfile'],
      {
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH,
          HUB_DOMAIN: base,
          HUB_STATIC_ROOT: staticRoot,
          HUB_API_UPSTREAM: `127.0.0.1:${apiPort}`,
          XDG_CONFIG_HOME: join(work, 'xdg'),
          XDG_DATA_HOME: join(work, 'xdg'),
        },
      },
    ),
  );
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    ready = await fetch(`${base}/api/ready`)
      .then((reply) => reply.ok)
      .catch(() => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('The API did not become ready behind Caddy.');

  browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base });
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  const violations = [];
  const errors = [];
  await page.exposeFunction('reportViolation', (text) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void window.reportViolation(
        `${event.violatedDirective} blocked ${event.blockedURI || 'inline'} on ${location.pathname}`,
      );
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(`${new URL(page.url()).pathname}: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));

  // How the service worker answered each built asset (Chromium reports it).
  const sources = new Map();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', ({ response }) => {
    const path = new URL(response.url).pathname;
    if (path.startsWith('/assets/'))
      sources.set(path, response.serviceWorkerResponseSource ?? 'none');
  });

  // Enroll through the form, then save a task: scripts, styles, the session
  // cookie and a same-origin write all work under the policy.
  step('enroll');
  await page.goto('/');
  await page.getByLabel('Email').fill('edge@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('synthetic-edge-password');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor();
  const bar = page.getByRole('region', { name: 'Add or ask' });
  await bar.getByRole('textbox', { name: 'Add a task' }).fill('Edge check');
  await bar.getByRole('button', { name: 'Add', exact: true }).click();
  await bar.getByText('Task saved.').waitFor();

  step('headers and compression');
  const headers = (await page.request.get('/')).headers();
  check(
    headers['content-security-policy']?.startsWith("default-src 'none'"),
    'The app shell has no content security policy.',
  );
  const entry = await page
    .locator('script[type="module"][src^="/assets/"]')
    .getAttribute('src');
  const script = await fetch(`${base}${entry}`, {
    headers: { 'Accept-Encoding': 'zstd, gzip' },
  });
  check(
    ['zstd', 'gzip'].includes(script.headers.get('content-encoding') ?? ''),
    'The entry script is not compressed.',
  );
  check(
    script.headers.get('cache-control') ===
      'public, max-age=31536000, immutable',
    'The entry script is not cached as immutable.',
  );
  check(
    (await fetch(`${base}/assets/missing-00000000.js`)).status === 404,
    'A missing asset did not answer 404.',
  );

  // Once the worker controls the page, a reload takes every asset from its cache.
  step('service worker');
  await page.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve, reject) =>
        setTimeout(
          () => reject(new Error('The service worker never became ready.')),
          20_000,
        ),
      ),
    ]),
  );
  await page.reload();
  await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor();
  check(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    'The service worker does not control the page.',
  );
  sources.clear();
  await page.reload();
  await page.getByRole('heading', { level: 1, name: 'Today' }).waitFor();
  await page.waitForLoadState('networkidle');
  check(sources.size > 0, 'No built asset was requested after the reload.');
  for (const [path, source] of sources)
    check(
      source === 'cache-storage',
      `${path} came from "${source}", not the worker cache.`,
    );

  for (const route of [
    'today',
    'assistant',
    'calendar',
    'calendar?view=month',
    'calendar?view=agenda',
    'calendar/new',
    'tasks',
    'classes',
    'classes/new',
    'classes/plan',
    'inbox',
    'inbox/reminders',
    'inbox/reminders/new',
    'inbox/mail',
    'inbox/drafts',
    'settings/account',
    'settings/appearance',
    'settings/study',
    'settings/connections',
    'settings/connections/canvas',
    'settings/ai',
    'settings/memory',
  ]) {
    step(`view /${route}`);
    await page.goto(`/${route}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.waitForLoadState('networkidle');
  }

  // Appearance writes custom properties and the e-ink theme through the DOM.
  step('e-ink theme');
  await page.goto('/settings/appearance');
  await page.getByLabel('Use e-ink mode').check();
  check(
    (await page.evaluate(() => document.documentElement.dataset.theme)) ===
      'eink',
    'The e-ink theme was not applied.',
  );
  await page.getByLabel('Use e-ink mode').uncheck();

  // The planner export is a blob download started from the page.
  step('export download');
  await page.goto('/settings/account');
  const download = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('button', { name: /^Download/ }).click();
  check(
    /\.json$/.test((await download).suggestedFilename()),
    'The planner export did not download.',
  );

  // Offline, a view that was never opened still starts from the worker cache.
  step('offline shell');
  await context.setOffline(true);
  await page.goto('/calendar?view=day');
  await page.getByRole('heading', { level: 1, name: 'Calendar' }).waitFor();
  await context.setOffline(false);

  check(
    violations.length === 0,
    `Policy violations:\n  ${[...new Set(violations)].join('\n  ')}`,
  );
  // Offline reads log failed requests by design; anything else is a defect.
  const unexpected = errors.filter(
    (text) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(text),
  );
  check(
    unexpected.length === 0,
    `Console errors:\n  ${[...new Set(unexpected)].join('\n  ')}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(`${current}: ${message}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  'Edge browser check passed: no policy violations across the views, compressed immutable assets served from the worker cache, 404 for a missing asset, working writes, export download and offline shell.',
);
