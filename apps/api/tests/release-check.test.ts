import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('deploy/oracle-linux/release-check.mjs');
const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const directories: string[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function check(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}
async function fixture(extraMigration = false) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-release-test-'));
  directories.push(directory);
  const files = [
    'package.json',
    'package-lock.json',
    'apps/api/package.json',
    'apps/api/dist/server.js',
    'apps/api/dist/app.js',
    'apps/api/migrations/001_base.sql',
    'apps/web/package.json',
    'apps/email-connector/package.json',
    'apps/web/dist/index.html',
    'apps/web/dist/sw.js',
    'packages/contracts/package.json',
    'packages/contracts/dist/index.js',
  ];
  if (extraMigration) files.push('apps/api/migrations/002_additive.sql');
  for (const path of files) {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(
      join(directory, path),
      path.endsWith('.sql') ? '-- synthetic\n' : '{}\n',
    );
  }
  expect(check('seal', directory, commit, tree).status).toBe(0);
  return directory;
}
async function applied(directory: string, all = false) {
  const path = join(directory, 'applied.json');
  await writeFile(
    path,
    JSON.stringify([
      { name: '001_base.sql', checksum: hash('-- synthetic\n') },
      ...(all
        ? [{ name: '002_additive.sql', checksum: hash('-- synthetic\n') }]
        : []),
    ]),
  );
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('offline staged release checks', () => {
  it('binds exact tested identity and detects edited, missing and added build files', async () => {
    const directory = await fixture();
    expect(check('verify', directory, commit, tree).status).toBe(0);
    expect(check('verify', directory, 'c'.repeat(40), tree).status).toBe(1);
    await writeFile(join(directory, 'apps/web/dist/unexpected.js'), 'changed');
    expect(check('verify', directory, commit, tree).status).toBe(1);
    await rm(join(directory, 'apps/web/dist/unexpected.js'));
    await writeFile(join(directory, 'apps/api/dist/app.js'), 'changed');
    expect(check('verify', directory, commit, tree).status).toBe(1);
    await rm(join(directory, 'apps/api/dist/app.js'));
    expect(check('verify', directory, commit, tree).status).toBe(1);
  });
  it('allows only unchanged existing migrations plus appended migrations', async () => {
    const directory = await fixture(true);
    const path = await applied(directory);
    expect(check('migrations', directory, path).status).toBe(0);
    await writeFile(
      path,
      JSON.stringify([{ name: '001_base.sql', checksum: 'f'.repeat(64) }]),
    );
    expect(check('migrations', directory, path).status).toBe(1);
    await writeFile(
      path,
      JSON.stringify([{ name: '003_missing.sql', checksum: 'f'.repeat(64) }]),
    );
    expect(check('migrations', directory, path).status).toBe(1);
  });
  it('rejects retroactively inserted migrations even when old checksums match', async () => {
    const directory = await fixture(true);
    const path = await applied(directory);
    await writeFile(
      path,
      JSON.stringify([
        { name: '002_additive.sql', checksum: hash('-- synthetic\n') },
      ]),
    );
    expect(check('migrations', directory, path).status).toBe(1);
  });
  it('requires an exact reviewed rollback receipt and complete post-upgrade manifest', async () => {
    const current = await fixture(true);
    const previous = await fixture();
    const path = await applied(current, true);
    const receipt = join(current, 'compatibility.json');
    expect(check('rollback', current, previous, path, receipt).status).toBe(1);
    const currentManifest = JSON.parse(
      await readFile(join(current, 'release-manifest.json'), 'utf8'),
    );
    const previousManifest = JSON.parse(
      await readFile(join(previous, 'release-manifest.json'), 'utf8'),
    );
    const migrations = {
      '001_base.sql': hash('-- synthetic\n'),
      '002_additive.sql': hash('-- synthetic\n'),
    };
    const evidence = {
      version: 1,
      currentDigest: currentManifest.digest,
      previousDigest: previousManifest.digest,
      appliedDigest: hash(JSON.stringify(migrations)),
      schemaCompatible: true,
      isolatedRestorePassed: true,
      review: 'Synthetic compatibility review',
    };
    await writeFile(receipt, JSON.stringify(evidence));
    expect(check('rollback', current, previous, path, receipt).status).toBe(0);
    await writeFile(
      receipt,
      JSON.stringify({ ...evidence, schemaCompatible: false }),
    );
    expect(check('rollback', current, previous, path, receipt).status).toBe(1);
    await writeFile(receipt, JSON.stringify(evidence));
    await applied(current);
    expect(check('rollback', current, previous, path, receipt).status).toBe(1);
  });
  it('does not leak malformed input contents in errors or overwrite an existing seal', async () => {
    const directory = await fixture();
    expect(check('seal', directory, commit, tree).status).toBe(1);
    const path = join(directory, 'applied.json');
    await writeFile(path, 'synthetic-private-value');
    const result = check('migrations', directory, path);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('synthetic-private-value');
  });
  it('rejects a private environment file instead of sealing or verifying it', async () => {
    const directory = await fixture();
    await writeFile(join(directory, '.env'), 'SYNTHETIC_SECRET=do-not-print');
    const result = check('verify', directory, commit, tree);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('do-not-print');
    await rm(join(directory, 'release-manifest.json'));
    expect(check('seal', directory, commit, tree).status).toBe(1);
  });
  it('rejects nested private data directories before sealing their contents', async () => {
    const directory = await fixture();
    await rm(join(directory, 'release-manifest.json'));
    await mkdir(join(directory, 'apps/api/dist/.data'));
    await writeFile(
      join(directory, 'apps/api/dist/.data/owner.json'),
      'synthetic-private-content',
    );
    const result = check('seal', directory, commit, tree);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('synthetic-private-content');
    await expect(
      readFile(join(directory, 'release-manifest.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
