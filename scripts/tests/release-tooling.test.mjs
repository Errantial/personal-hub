import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { releaseManifestSchema } from '@hub/contracts';
import {
  artifactDetails,
  boundedNotes,
  buildReleaseManifest,
  maximumNotesCharacters,
  parseDesktopArgument,
  releaseAssetUrl,
} from '../release-tooling.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryFile(name, content) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-release-'));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

const digestOf = (content) =>
  createHash('sha256').update(content).digest('hex');

it('computes a bounded SHA-256 and size for a release artifact', async () => {
  const content = Buffer.from('synthetic apk bytes');
  const path = await temporaryFile('personal-hub-0.1.0+abc1234.apk', content);
  await expect(
    artifactDetails(path, 'personal-hub-0.1.0+abc1234.apk'),
  ).resolves.toEqual({
    name: 'personal-hub-0.1.0+abc1234.apk',
    sha256: digestOf(content),
    size: content.length,
  });
});

it('rejects unsafe or oversized artifact names before upload', async () => {
  const path = await temporaryFile('release.apk', 'synthetic');
  await expect(artifactDetails(path, '../release.apk')).rejects.toThrow(
    'not safe',
  );
  await expect(artifactDetails(path, 'release.apk\n')).rejects.toThrow(
    'not safe',
  );
});

it('keeps release notes non-empty and bounded', () => {
  expect(boundedNotes('  Synthetic notes.  ')).toBe('Synthetic notes.');
  expect(() => boundedNotes('   ')).toThrow('empty');
  expect(() => boundedNotes('x'.repeat(maximumNotesCharacters + 1))).toThrow(
    'exceed',
  );
  expect(boundedNotes('x'.repeat(maximumNotesCharacters))).toHaveLength(
    maximumNotesCharacters,
  );
});

it('builds a manifest the server contract accepts', async () => {
  const apk = Buffer.from('synthetic apk');
  const desktop = Buffer.from('synthetic desktop');
  const manifest = buildReleaseManifest({
    repo: 'Errantial/personal-hub',
    tag: 'android-0.1.0-300',
    channel: 'stable',
    versionName: '0.1.0+abc1234',
    versionCode: 300,
    notes: 'Synthetic release notes.',
    android: {
      name: 'personal-hub-0.1.0+abc1234.apk',
      sha256: digestOf(apk),
      size: apk.length,
    },
    desktop: [
      {
        platform: 'windows',
        name: 'personal-hub-0.1.0-windows-setup.exe',
        sha256: digestOf(desktop),
        size: desktop.length,
      },
    ],
  });
  expect(releaseManifestSchema.parse(manifest)).toEqual(manifest);
  expect(manifest.android.url).toBe(
    'https://github.com/Errantial/personal-hub/releases/download/android-0.1.0-300/personal-hub-0.1.0+abc1234.apk',
  );
  expect(manifest.desktop[0]).toMatchObject({
    platform: 'windows',
    url: 'https://github.com/Errantial/personal-hub/releases/download/android-0.1.0-300/personal-hub-0.1.0-windows-setup.exe',
  });
});

it('rejects unsafe manifest values and duplicate desktop platforms', () => {
  const android = {
    name: 'personal-hub-0.1.0+abc1234.apk',
    sha256: 'a'.repeat(64),
    size: 10,
  };
  const base = {
    repo: 'Errantial/personal-hub',
    tag: 'android-0.1.0-300',
    channel: 'stable',
    versionName: '0.1.0+abc1234',
    versionCode: 300,
    notes: 'Synthetic release notes.',
    android,
  };
  expect(() => buildReleaseManifest({ ...base, tag: '../android' })).toThrow(
    'tag',
  );
  expect(() =>
    buildReleaseManifest({
      ...base,
      android: { ...android, sha256: 'not-a-digest' },
    }),
  ).toThrow('digest');
  expect(() => buildReleaseManifest({ ...base, versionCode: 0 })).toThrow(
    'version code',
  );
  expect(() =>
    buildReleaseManifest({
      ...base,
      desktop: [
        {
          platform: 'windows',
          name: 'app.exe',
          sha256: 'a'.repeat(64),
          size: 1,
        },
        {
          platform: 'windows',
          name: 'other.exe',
          sha256: 'b'.repeat(64),
          size: 1,
        },
      ],
    }),
  ).toThrow('Duplicate desktop platform');
});

it('parses desktop arguments and builds safe asset URLs', () => {
  expect(parseDesktopArgument('windows=build/personal-hub.exe')).toEqual({
    platform: 'windows',
    path: 'build/personal-hub.exe',
  });
  expect(() => parseDesktopArgument('windows')).toThrow('<platform>=<path>');
  expect(() => parseDesktopArgument('../=app.exe')).toThrow('not safe');
  expect(releaseAssetUrl('Errantial/personal-hub', 'tag', 'app.apk')).toBe(
    'https://github.com/Errantial/personal-hub/releases/download/tag/app.apk',
  );
  expect(() =>
    releaseAssetUrl('Errantial/personal-hub', '../tag', 'app.apk'),
  ).toThrow('tag');
});
