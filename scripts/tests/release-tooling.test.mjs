import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { releaseManifestSchema } from '@hub/contracts';
import {
  androidBuildArguments,
  artifactDetails,
  boundedNotes,
  buildReleaseManifest,
  maximumNotesCharacters,
  normalizeCertificateSha256,
  parseAaptBadging,
  parseDesktopArgument,
  releaseAssetUrl,
  safeOrigin,
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

it('constructs the release build with the required server origin', () => {
  expect(androidBuildArguments('https://hub.ecg.name')).toEqual([
    'run',
    'android:build',
    '--',
    '--release',
    '--origin',
    'https://hub.ecg.name',
  ]);
  expect(() => androidBuildArguments('http://hub.ecg.name')).toThrow(
    '--origin',
  );
  expect(() => androidBuildArguments('https://hub.ecg.name/')).toThrow(
    '--origin',
  );
  expect(safeOrigin('https://hub.ecg.name')).toBe(true);
  expect(safeOrigin('https://user:pass@hub.ecg.name')).toBe(false);
  expect(safeOrigin('https://hub.ecg.name/path')).toBe(false);
});

it('reads the APK package identity from aapt badging output', () => {
  expect(
    parseAaptBadging(
      "package: name='dev.personalhub.app' versionCode='317' versionName='0.1.0+d939f6b' compileSdkVersion='36'",
    ),
  ).toEqual({
    packageName: 'dev.personalhub.app',
    versionCode: 317,
    versionName: '0.1.0+d939f6b',
  });
  expect(() => parseAaptBadging('not badging')).toThrow(
    'package identity could not be read',
  );
});

it('normalizes certificate fingerprints and requires the exact APK name', () => {
  expect(
    normalizeCertificateSha256(
      'F9:F1:69:37:1A:E0:E7:FA:D1:3B:0A:99:B3:10:BE:54:FC:28:94:01:00:C8:91:1F:BC:51:8D:C3:10:92:53:E7',
    ),
  ).toBe('f9f169371ae0e7fad13b0a99b310be54fc28940100c8911fbc518dc3109253e7');
  expect(() => normalizeCertificateSha256('not-a-fingerprint')).toThrow(
    'SHA-256',
  );
  expect(() =>
    buildReleaseManifest({
      repo: 'Errantial/personal-hub',
      tag: 'android-0.1.0-300',
      channel: 'stable',
      versionName: '0.1.0+abc1234',
      versionCode: 300,
      notes: 'Synthetic release notes.',
      android: {
        name: 'renamed.apk',
        sha256: 'a'.repeat(64),
        size: 10,
      },
    }),
  ).toThrow('personal-hub-0.1.0+abc1234.apk');
});

it('rejects duplicate or malformed desktop platforms in the contract', () => {
  const asset = {
    url: 'https://github.com/Errantial/personal-hub/releases/download/tag/app.exe',
    sha256: 'a'.repeat(64),
    size: 10,
  };
  const base = {
    formatVersion: 1,
    channel: 'stable',
    versionName: '0.1.0+abc1234',
    versionCode: 300,
    notes: 'Synthetic release notes.',
    android: null,
    desktop: [],
  };
  expect(() =>
    releaseManifestSchema.parse({
      ...base,
      desktop: [{ ...asset, platform: 'Windows' }],
    }),
  ).toThrow();
  expect(() =>
    releaseManifestSchema.parse({
      ...base,
      desktop: [
        { ...asset, platform: 'windows' },
        { ...asset, platform: 'windows' },
      ],
    }),
  ).toThrow();
  expect(() =>
    releaseManifestSchema.parse({
      ...base,
      desktop: [{ ...asset, platform: 'windows' }],
    }),
  ).not.toThrow();
});
