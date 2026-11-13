import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

const repository = JSON.parse(
  readFileSync(
    new URL(
      '../packages/contracts/src/app-update-repository.json',
      import.meta.url,
    ),
    'utf8',
  ),
).repository;

export const maximumArtifactBytes = 250 * 1024 * 1024;
export const maximumNotesCharacters = 4000;
export const manifestAssetName = 'release-manifest.json';
export const releaseRepository = repository;
export const productionCertificateSha256 =
  'F9:F1:69:37:1A:E0:E7:FA:D1:3B:0A:99:B3:10:BE:54:FC:28:94:01:00:C8:91:1F:BC:51:8D:C3:10:92:53:E7';

export function safeOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export function androidBuildArguments(origin) {
  if (!safeOrigin(origin))
    throw new Error('Use --origin https://your-server for the release build.');
  return ['run', 'android:build', '--', '--release', '--origin', origin];
}

export function androidBuildCommand(origin, platform = process.platform) {
  const args = androidBuildArguments(origin);
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/c', 'npm', ...args] }
    : { command: 'npm', args };
}

export function normalizeCertificateSha256(value) {
  const normalized = value.replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized))
    throw new Error('Use a SHA-256 certificate fingerprint.');
  return normalized;
}

export function assertReplacementAdvances(existing, next) {
  if (!Number.isInteger(existing) || existing <= 0)
    throw new Error('The existing release versionCode is invalid.');
  if (!Number.isInteger(next) || next <= 0)
    throw new Error('The replacement versionCode is invalid.');
  if (next <= existing)
    throw new Error(
      `Replacement versionCode ${next} must be greater than existing ${existing}; publish a forward fix instead.`,
    );
}

export function replacementReleaseSteps({
  tag,
  repo,
  assets,
  title,
  notesPath,
  flags,
}) {
  return [
    ['release', 'edit', tag, '--repo', repo, '--draft=true'],
    ['release', 'upload', tag, ...assets, '--repo', repo, '--clobber'],
    [
      'release',
      'edit',
      tag,
      '--repo',
      repo,
      '--title',
      title,
      '--notes-file',
      notesPath,
      '--draft=false',
      ...flags,
    ],
  ];
}

export function parseExistingReleaseManifest(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !parsed ||
    !Number.isInteger(parsed.versionCode) ||
    parsed.versionCode <= 0
  )
    throw new Error('The existing release manifest has no valid versionCode.');
  return parsed;
}

const manifestIdentity = (manifest) =>
  JSON.stringify({
    formatVersion: manifest.formatVersion,
    channel: manifest.channel,
    versionName: manifest.versionName,
    versionCode: manifest.versionCode,
    notes: manifest.notes,
    android: manifest.android,
    desktop: manifest.desktop,
  });

export function assertReplacementAllowed(existing, next) {
  if (!existing || !Number.isInteger(existing.versionCode))
    throw new Error('The existing release manifest is invalid.');
  if (!next || !Number.isInteger(next.versionCode))
    throw new Error('The replacement manifest is invalid.');
  if (next.versionCode > existing.versionCode) return;
  if (
    next.versionCode === existing.versionCode &&
    manifestIdentity(existing) === manifestIdentity(next)
  )
    return;
  throw new Error(
    `Replacement versionCode ${next.versionCode} must be greater than existing ${existing.versionCode}, or exactly match the staged manifest for a retry; publish a forward fix instead.`,
  );
}

/** Reads `aapt dump badging` package identity. */
export function parseAaptBadging(value) {
  const match =
    /package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/.exec(
      value,
    );
  if (!match) throw new Error('The APK package identity could not be read.');
  return {
    packageName: match[1],
    versionCode: Number(match[2]),
    versionName: match[3],
  };
}

export function safeAssetName(value) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value) && !value.includes('..')
  );
}

export function safePlatform(value) {
  return /^[a-z][a-z0-9-]{1,31}$/.test(value);
}

export function releaseAssetUrl(repo, tag, name) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('Use an owner/repository release target.');
  if (!safeTag(tag)) throw new Error('Use a safe release tag.');
  if (!safeAssetName(name))
    throw new Error(`The release asset name is not safe: ${name}`);
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

export function safeTag(value) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value) && !value.includes('..')
  );
}

export async function artifactDetails(path, name = basename(path)) {
  if (!safeAssetName(name))
    throw new Error(`The release asset name is not safe: ${name}`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
  if (info.size <= 0) throw new Error(`The release asset is empty: ${path}`);
  if (info.size > maximumArtifactBytes)
    throw new Error(
      `The release asset exceeds 250 MiB: ${name} (${info.size} bytes)`,
    );
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { name, sha256: digest.digest('hex'), size: info.size };
}

export function boundedNotes(notes) {
  const value = notes.trim();
  if (!value) throw new Error('Release notes are empty.');
  if (value.length > maximumNotesCharacters)
    throw new Error(
      `Release notes exceed ${maximumNotesCharacters} characters. Shorten them before publishing.`,
    );
  return value;
}

/**
 * Builds the same bounded object the server validates from
 * release-manifest.json. Digests and sizes must already be measured.
 */
export function buildReleaseManifest({
  repo,
  tag,
  channel,
  versionName,
  versionCode,
  notes,
  android,
  desktop = [],
}) {
  if (channel !== 'stable' && channel !== 'beta')
    throw new Error('Use the stable or beta release channel.');
  if (
    versionName.length === 0 ||
    versionName.length > 80 ||
    !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(versionName)
  )
    throw new Error('The version name is not safe.');
  if (
    !Number.isInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode > 2_100_000_000
  )
    throw new Error('The version code must be a positive integer.');
  if (!android) throw new Error('An Android asset is required.');
  if (!safeAssetName(android.name))
    throw new Error('The Android asset name is not safe.');
  if (!android.name.endsWith('.apk'))
    throw new Error('The Android asset must be an APK.');
  if (android.name !== `personal-hub-${versionName}.apk`)
    throw new Error(
      `The Android asset must be named personal-hub-${versionName}.apk.`,
    );
  if (!/^[a-f0-9]{64}$/.test(android.sha256))
    throw new Error('The Android asset digest is not a SHA-256.');
  if (
    !Number.isInteger(android.size) ||
    android.size <= 0 ||
    android.size > maximumArtifactBytes
  )
    throw new Error('The Android asset size is invalid.');
  if (desktop.length > 8)
    throw new Error('At most eight desktop artifacts are supported.');
  const platforms = new Set();
  const desktopRecords = desktop.map((asset) => {
    if (!safePlatform(asset.platform))
      throw new Error(`The desktop platform is not safe: ${asset.platform}`);
    if (platforms.has(asset.platform))
      throw new Error(`Duplicate desktop platform: ${asset.platform}`);
    platforms.add(asset.platform);
    if (!safeAssetName(asset.name))
      throw new Error(`The desktop asset name is not safe: ${asset.name}`);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new Error(`The desktop digest is not a SHA-256: ${asset.name}`);
    if (
      !Number.isInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > maximumArtifactBytes
    )
      throw new Error(`The desktop asset size is invalid: ${asset.name}`);
    return {
      platform: asset.platform,
      url: releaseAssetUrl(repo, tag, asset.name),
      sha256: asset.sha256,
      size: asset.size,
    };
  });
  return {
    formatVersion: 1,
    channel,
    versionName,
    versionCode,
    notes: boundedNotes(notes),
    android: {
      url: releaseAssetUrl(repo, tag, android.name),
      sha256: android.sha256,
      size: android.size,
    },
    desktop: desktopRecords,
  };
}

/** `--desktop windows=path/to/app.msi` */
export function parseDesktopArgument(value) {
  const separator = value.indexOf('=');
  if (separator <= 0) throw new Error('Use --desktop <platform>=<path>.');
  const platform = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (!safePlatform(platform))
    throw new Error(`The desktop platform is not safe: ${platform}`);
  if (!path) throw new Error('The desktop artifact path is empty.');
  return { platform, path };
}
