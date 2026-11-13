import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { CollectionError } from '../src/extract.js';
import { ensureDedicatedProfile } from '../src/profile.js';
import { openBrowserCollector } from '../src/runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'hub-outlook-profile-'));
  roots.push(path);
  return path;
}

it('marks a new dedicated profile and accepts the exact marker on reuse', async () => {
  const parent = await root();
  const path = join(parent, 'profile');
  await ensureDedicatedProfile(path);
  expect(
    await readFile(join(path, '.personal-hub-outlook-browser-profile'), 'utf8'),
  ).toBe('personal-hub outlook browser profile v1\n');
  await expect(ensureDedicatedProfile(path)).resolves.toBeUndefined();
});

it('refuses a nonempty unmarked browser directory and a forged marker', async () => {
  const parent = await root();
  const existing = join(parent, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'Preferences'), '{}');
  await expect(ensureDedicatedProfile(existing)).rejects.toThrow(
    'new/empty dedicated directory',
  );

  const forged = join(parent, 'forged');
  await mkdir(forged);
  await writeFile(
    join(forged, '.personal-hub-outlook-browser-profile'),
    'wrong',
  );
  await expect(ensureDedicatedProfile(forged)).rejects.toThrow(
    'marker is invalid',
  );
});

it('fails closed before launching a browser for a normal unmarked profile', async () => {
  const parent = await root();
  const existing = join(parent, 'normal-profile');
  await mkdir(existing);
  await writeFile(join(existing, 'Preferences'), '{}');
  await expect(
    openBrowserCollector({
      hubUrl: 'https://hub.example.invalid',
      hubToken: `hubob_${'A'.repeat(43)}`,
      profilePath: existing,
      browserChannel: 'chrome',
      outlookOrigin: 'https://outlook.office.com',
      signInWaitSeconds: 0,
    }),
  ).rejects.toMatchObject({
    code: 'browser-unavailable',
  } satisfies Partial<CollectionError>);
});

it('reads only bounded connector configuration', async () => {
  const parent = await root();
  const path = join(parent, 'connector.json');
  await writeFile(
    path,
    JSON.stringify({
      hubUrl: 'https://hub.example.invalid',
      hubToken: `hubob_${'B'.repeat(43)}`,
      profilePath: join(parent, 'profile'),
    }),
  );
  await expect(readConfig(path)).resolves.toMatchObject({
    browserChannel: 'chrome',
    outlookOrigin: 'https://outlook.office.com',
    signInWaitSeconds: 300,
  });
  await writeFile(
    path,
    JSON.stringify({
      hubUrl: 'http://hub.example.invalid',
      hubToken: 'hubcb_wrong_prefix_value',
      profilePath: 'relative',
      extra: true,
    }),
  );
  await expect(readConfig(path)).rejects.toThrow(
    'Invalid Outlook browser connector settings',
  );
});
