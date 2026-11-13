import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { releaseManifestSchema } from '@hub/contracts';
import { parseArguments } from '../release-github.mjs';

const script = fileURLToPath(new URL('../release-github.mjs', import.meta.url));
const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function gitRepository() {
  const directory = await temporaryDirectory('hub-release-cli-');
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'synthetic-release', version: '0.1.0' }),
  );
  await writeFile(join(directory, '.gitignore'), '.artifacts/\n');
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'release@example.test'], {
    cwd: directory,
  });
  execFileSync('git', ['config', 'user.name', 'Release Test'], {
    cwd: directory,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: directory,
  });
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: directory });
  const short = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
  return { directory, short };
}

async function fakeTools(bin) {
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$GH_MARKER"\nexit 0\n',
  );
  await chmod(join(bin, 'gh'), 0o755);
  await writeFile(
    join(bin, 'npm'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$NPM_MARKER"',
      'short=$(git rev-parse --short=7 HEAD)',
      'mkdir -p .artifacts/android',
      'printf "synthetic built apk\\n" > ".artifacts/android/personal-hub-0.1.0+$short.apk"',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'npm'), 0o755);
  return bin;
}

it('requires an origin for --build and an explicit --replace for updates', () => {
  expect(() => parseArguments(['--build'])).toThrow('--origin');
  expect(() => parseArguments(['--origin', 'https://hub.ecg.name'])).toThrow(
    'only with --build',
  );
  expect(() =>
    parseArguments(['--build', '--origin', 'http://hub.ecg.name']),
  ).toThrow('--origin');
  expect(() => parseArguments(['--repo', 'someone/fork'])).toThrow(
    'Unknown option',
  );
  expect(() => parseArguments(['--replace'])).toThrow('only with --publish');
  expect(
    parseArguments([
      '--build',
      '--origin',
      'https://hub.ecg.name',
      '--publish',
      '--replace',
    ]),
  ).toMatchObject({
    build: true,
    origin: 'https://hub.ecg.name',
    publish: true,
    replace: true,
  });
});

it.runIf(process.platform !== 'win32')(
  'dry-run --build passes the origin, stages notes/desktop assets and never calls gh',
  async () => {
    const { directory, short } = await gitRepository();
    const bin = await temporaryDirectory('hub-release-bin-');
    await fakeTools(bin);
    const output = await temporaryDirectory('hub-release-out-');
    const npmMarker = join(bin, 'npm-args.txt');
    const ghMarker = join(bin, 'gh-called.txt');
    await mkdir(join(directory, '.artifacts'));
    await writeFile(
      join(directory, '.artifacts', 'notes.txt'),
      'Synthetic CLI notes.\n',
    );
    await writeFile(
      join(directory, '.artifacts', 'desktop.bin'),
      'synthetic desktop bytes\n',
    );

    const result = spawnSync(
      process.execPath,
      [
        script,
        '--build',
        '--origin',
        'https://hub.ecg.name',
        '--notes-file',
        '.artifacts/notes.txt',
        '--desktop',
        'windows=.artifacts/desktop.bin',
        '--output-dir',
        output,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          NPM_MARKER: npmMarker,
          GH_MARKER: ghMarker,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(npmMarker, 'utf8')).toBe(
      [
        'run',
        'android:build',
        '--',
        '--release',
        '--origin',
        'https://hub.ecg.name',
        '',
      ].join('\n'),
    );
    expect(existsSync(ghMarker)).toBe(false);

    const manifest = releaseManifestSchema.parse(
      JSON.parse(await readFile(join(output, 'release-manifest.json'), 'utf8')),
    );
    expect(manifest).toMatchObject({
      versionName: `0.1.0+${short}`,
      versionCode: 1,
      notes: 'Synthetic CLI notes.',
      desktop: [{ platform: 'windows' }],
    });
    expect(manifest.android?.url).toContain(
      `android-0.1.0-1/personal-hub-0.1.0+${short}.apk`,
    );
    expect(existsSync(join(output, `personal-hub-0.1.0+${short}.apk`))).toBe(
      true,
    );
    expect(
      existsSync(join(output, `personal-hub-0.1.0+${short}.apk.sha256`)),
    ).toBe(true);
    expect(existsSync(join(output, 'desktop.bin'))).toBe(true);
  },
  60000,
);
