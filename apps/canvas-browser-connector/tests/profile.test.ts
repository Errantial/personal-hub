import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureDedicatedProfile } from '../src/profile.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'hub-canvas-profile-'));
  roots.push(path);
  return path;
}

it('marks a new dedicated profile and accepts the exact marker on reuse', async () => {
  const parent = await root();
  const path = join(parent, 'profile');
  await ensureDedicatedProfile(path);
  expect(
    await readFile(join(path, '.personal-hub-canvas-browser-profile'), 'utf8'),
  ).toBe('personal-hub canvas browser profile v1\n');
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
    join(forged, '.personal-hub-canvas-browser-profile'),
    'wrong',
  );
  await expect(ensureDedicatedProfile(forged)).rejects.toThrow(
    'marker is invalid',
  );
});
