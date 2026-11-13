import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

export const maximumArtifactBytes = 250 * 1024 * 1024;
export const maximumNotesCharacters = 4000;
export const manifestAssetName = 'release-manifest.json';

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
