#!/usr/bin/env node
// Offline only: no environment loading, server startup, database or provider I/O.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const roots = [
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/api/dist',
  'apps/api/migrations',
  'apps/web/package.json',
  'apps/email-connector/package.json',
  'apps/web/dist',
  'packages/contracts/package.json',
  'packages/contracts/dist',
];
const required = [
  'apps/api/dist/server.js',
  'apps/api/dist/app.js',
  'apps/web/dist/index.html',
  'apps/web/dist/sw.js',
  'packages/contracts/dist/index.js',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => {
  throw new Error(message);
};
async function inventory(directory) {
  const files = {};
  for (const name of await readdir(directory)) {
    if (/^(\.env(?:\..*)?|\.data|credentials|cookies)$/i.test(name))
      fail('Private files are forbidden in release artifacts.');
  }
  async function visit(path) {
    if (/(^|\/)(\.env(?:\..*)?|credentials|cookies|\.data)(\/|$)/i.test(path))
      fail('Private files are forbidden in release artifacts.');
    const absolute = resolve(directory, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) fail('Release artifact symlinks are forbidden.');
    if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort())
        await visit(`${path}/${child}`);
    } else if (stat.isFile()) {
      files[path] = hash(await readFile(absolute));
    } else fail('Unsupported artifact file type.');
  }
  for (const root of roots) await visit(root);
  for (const path of required)
    if (!files[path]) fail('Required build artifact missing.');
  if (
    !Object.keys(files).some((path) =>
      /^apps\/api\/migrations\/\d+_.+\.sql$/.test(path),
    )
  )
    fail('Migration artifacts missing.');
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
const digest = (manifest) =>
  hash(
    JSON.stringify({
      version: manifest.version,
      commit: manifest.commit,
      tree: manifest.tree,
      files: manifest.files,
    }),
  );
async function verified(directory) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, 'release-manifest.json'), 'utf8'),
  );
  if (
    manifest.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !/^[a-f0-9]{40}$/.test(manifest.tree) ||
    digest(manifest) !== manifest.digest
  )
    fail('Invalid release manifest.');
  if (
    JSON.stringify(await inventory(directory)) !==
    JSON.stringify(manifest.files)
  )
    fail('Release artifact hash mismatch.');
  return manifest;
}
function migrations(manifest) {
  return Object.fromEntries(
    Object.entries(manifest.files)
      .filter(([path]) => /^apps\/api\/migrations\/\d+_.+\.sql$/.test(path))
      .map(([path, checksum]) => [path.split('/').at(-1), checksum]),
  );
}
async function appliedManifest(path) {
  const rows = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(rows) || rows.length === 0)
    fail('Applied migration manifest must be nonempty.');
  const result = {};
  for (const row of rows) {
    if (
      !/^\d+_.+\.sql$/.test(row.name) ||
      !/^[a-f0-9]{64}$/.test(row.checksum) ||
      result[row.name]
    )
      fail('Invalid applied migration manifest.');
    result[row.name] = row.checksum;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function preserves(applied, available) {
  for (const [name, checksum] of Object.entries(applied)) {
    if (available[name] !== checksum)
      fail('Missing or changed applied migration.');
  }
  const latest = Object.keys(applied).sort().at(-1);
  for (const name of Object.keys(available)) {
    if (!applied[name] && name <= latest)
      fail('Migration insertion is not append-only.');
  }
}
async function main() {
  const [command, directory, ...args] = process.argv.slice(2);
  if (!directory)
    fail(
      'Usage: release-check.mjs seal|verify|migrations|rollback RELEASE [arguments]',
    );
  if (command === 'seal') {
    const [commit, tree] = args;
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree))
      fail('Full tested commit and tree hashes are required.');
    const manifest = {
      version: 1,
      commit,
      tree,
      files: await inventory(directory),
    };
    await writeFile(
      resolve(directory, 'release-manifest.json'),
      `${JSON.stringify({ ...manifest, digest: digest(manifest) }, null, 2)}\n`,
      { flag: 'wx' },
    );
    console.log('Release manifest created.');
    return;
  }
  const manifest = await verified(directory);
  if (command === 'verify') {
    if (args[0] !== manifest.commit || args[1] !== manifest.tree)
      fail('Release differs from expected tested commit/tree.');
  } else if (command === 'migrations') {
    preserves(await appliedManifest(args[0]), migrations(manifest));
  } else if (command === 'rollback') {
    const [previousDirectory, appliedPath, receiptPath] = args;
    const previous = await verified(previousDirectory);
    const applied = await appliedManifest(appliedPath);
    // Neither direction may rewrite old migration bytes. The old binary need not
    // contain new SQL, so compatibility beyond that requires a reviewed receipt.
    preserves(migrations(previous), migrations(manifest));
    preserves(applied, migrations(manifest));
    if (JSON.stringify(applied) !== JSON.stringify(migrations(manifest)))
      fail('Post-upgrade migration manifest is incomplete.');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (
      receipt.version !== 1 ||
      receipt.currentDigest !== manifest.digest ||
      receipt.previousDigest !== previous.digest ||
      receipt.appliedDigest !== hash(JSON.stringify(applied)) ||
      receipt.schemaCompatible !== true ||
      receipt.isolatedRestorePassed !== true ||
      typeof receipt.review !== 'string' ||
      !receipt.review.trim()
    )
      fail(
        'Rollback requires an exact reviewed schema-compatibility and restore receipt.',
      );
  } else fail('Unknown release check command.');
  console.log('Release check passed.');
}
main().catch(() => {
  // Do not print parsed inputs, environment values, file contents or stack traces.
  console.error(
    'Release check failed. Inspect artifact, migration or compatibility receipt locally.',
  );
  process.exitCode = 1;
});
