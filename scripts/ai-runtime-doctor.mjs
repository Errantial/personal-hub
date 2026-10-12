import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSubscriptionRuntime } from '../apps/api/src/ai/subscription-runtime-probe.ts';

const usage =
  'npm run ai:runtime-doctor -- [--claude <absolute executable>] [--codex <absolute executable>]';
let directory;
let cleanupRoot;
let report;
const within = (root, target) => {
  const scoped = relative(root, target);
  return scoped !== '' && !scoped.startsWith('..') && !isAbsolute(scoped);
};
const cleanupDirectory = async (root, directory) => {
  const current = await realpath(directory);
  if (current !== directory || !within(root, current)) throw Error();
  await rm(directory, { recursive: true, force: true });
};
try {
  const requested = [];
  const seen = new Set();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index],
      path = argv[index + 1];
    if (
      !['--claude', '--codex'].includes(flag) ||
      seen.has(flag) ||
      !path ||
      !isAbsolute(path) ||
      /^(?:\\\\|\/\/)/.test(path) ||
      /[\0\r\n]/.test(path)
    )
      throw Error();
    const adapter = flag === '--claude' ? 'claude-code' : 'codex-subscription';
    const expected =
      flag === '--claude' ? ['claude', 'claude.exe'] : ['codex', 'codex.exe'];
    if (!expected.includes(basename(path).toLowerCase())) throw Error();
    const canonical = await realpath(path);
    if (/^(?:\\\\|\/\/)/.test(canonical) || !(await stat(canonical)).isFile())
      throw Error();
    seen.add(flag);
    requested.push({ adapter, path });
  }
  if (!requested.length) throw Error();
  const workspace = await realpath(
    fileURLToPath(new URL('../', import.meta.url)),
  );
  const artifacts = resolve(workspace, '.artifacts');
  await mkdir(artifacts, { recursive: true });
  const artifactRoot = await realpath(artifacts);
  if (!within(workspace, artifactRoot)) throw Error();
  const root = resolve(artifactRoot, 'runtime-probe');
  await mkdir(root, { recursive: true });
  cleanupRoot = await realpath(root);
  if (!within(workspace, cleanupRoot)) throw Error();
  const candidate = await realpath(await mkdtemp(resolve(cleanupRoot, 'run-')));
  if (!within(cleanupRoot, candidate)) throw Error();
  directory = candidate;
  const runtimes = [];
  for (const runtime of requested)
    runtimes.push(
      await probeSubscriptionRuntime(
        runtime.adapter,
        runtime.path,
        directory,
        process.env,
      ),
    );
  report = {
    inspection: 'local-version-help-only',
    dispatchEnabled: false,
    runtimes,
  };
  if (runtimes.some((runtime) => runtime.status !== 'controls-advertised'))
    process.exitCode = 1;
} catch {
  report = {
    dispatchEnabled: false,
    error: 'Runtime metadata inspection failed.',
    usage,
  };
  process.exitCode = 1;
} finally {
  if (directory) {
    try {
      await cleanupDirectory(cleanupRoot, directory);
    } catch {
      report = {
        dispatchEnabled: false,
        error: 'Runtime probe cleanup failed.',
      };
      process.exitCode = 1;
    }
  }
}
console.log(JSON.stringify(report, null, 2));
