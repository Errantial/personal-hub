import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  metadataProbeEnvironment,
  probeSubscriptionRuntime,
  runNativeMetadataCommand,
} from '../src/ai/subscription-runtime-probe.js';
import type { MetadataProbeCommand } from '../src/ai/subscription-runtime-probe.js';
import { subscriptionProbeSpecs } from '../src/ai/subscription-runtime-controls.js';
import type { SubscriptionRuntime } from '../src/ai/subscription-runtime-controls.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const executable = (adapter: SubscriptionRuntime) =>
  resolve('.artifacts', adapter === 'claude-code' ? 'claude.exe' : 'codex.exe');
const cwd = resolve('.artifacts', 'fake-runtime-probe');
const help = (adapter: SubscriptionRuntime) =>
  subscriptionProbeSpecs[adapter].flags
    .map((flag) => `  ${flag} <value>  Synthetic option`)
    .join('\n') +
  '\n' +
  subscriptionProbeSpecs[adapter].commands
    .map((name) => `  ${name}  Synthetic command`)
    .join('\n');
const identity = (adapter: SubscriptionRuntime) =>
  adapter === 'claude-code'
    ? '2.1.296 (Claude Code)\r\n'
    : 'codex-cli 0.162.0\n';
const probe = (
  io: Parameters<typeof probeSubscriptionRuntime>[4],
  adapter: SubscriptionRuntime = 'claude-code',
  timeoutMs = 5000,
) =>
  probeSubscriptionRuntime(
    adapter,
    executable(adapter),
    cwd,
    {
      OPENAI_API_KEY: 'private-provider-key',
      NODE_OPTIONS: 'private-injected-options',
      PATH: 'private-path',
    },
    io,
    timeoutMs,
  );
const command = (
  extra: Partial<MetadataProbeCommand> = {},
): MetadataProbeCommand => ({
  adapter: 'claude-code',
  executable: executable('claude-code'),
  argv: ['--version'],
  cwd,
  env: metadataProbeEnvironment({}),
  shell: false,
  windowsHide: true,
  timeoutMs: 1000,
  maxOutputBytes: 262144,
  signal: new AbortController().signal,
  ...extra,
});
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  return child;
}
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  network = vi.fn(() => {
    throw Error('Network forbidden');
  });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('filters credentials, home/config, proxies, PATH and runtime injection from child environments', () => {
  const root = resolve('.artifacts', 'synthetic-system-root');
  const result = metadataProbeEnvironment({
    SystemRoot: root,
    WINDIR: root,
    HOME: 'private-home',
    CODEX_HOME: 'private-config',
    ANTHROPIC_API_KEY: 'private-key',
    OPENAI_API_KEY: 'private-key',
    PATH: 'private-path',
    HTTP_PROXY: 'private-proxy',
    NODE_OPTIONS: 'private-options',
    LD_PRELOAD: 'private-library',
    NO_COLOR: 'private-override',
  });
  expect(result).toEqual({
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'C',
    SystemRoot: root,
    WINDIR: root,
  });
  expect(() => metadataProbeEnvironment({ SystemRoot: 'private-key' })).toThrow(
    'Invalid runtime probe environment.',
  );
});

it('inspects only version/help for both runtimes and never interprets advertising as verified isolation', async () => {
  for (const adapter of ['claude-code', 'codex-subscription'] as const) {
    const io = vi.fn(async (request: MetadataProbeCommand) => {
      expect(request.env).toEqual({ NO_COLOR: '1', TERM: 'dumb', LANG: 'C' });
      expect(request.shell).toBe(false);
      expect(request.windowsHide).toBe(true);
      expect(request).not.toHaveProperty('stdin');
      return {
        exitCode: 0,
        stdout:
          request.argv[0] === '--version' ? identity(adapter) : help(adapter),
        stderr: '',
      };
    });
    const result = await probe(io, adapter);
    expect(result).toMatchObject({
      status: 'controls-advertised',
      dispatchEnabled: false,
      isolation: 'unverified',
      account: 'not_checked',
      billing: 'unverified',
      missingControls: [],
    });
    expect(io).toHaveBeenCalledTimes(2);
    expect(io.mock.calls.map(([request]) => request.argv)).toEqual([
      ['--version'],
      subscriptionProbeSpecs[adapter].helpArgs,
    ]);
    expect(JSON.stringify(result)).not.toContain('private-');
  }
});

it('requires option/command declarations instead of prose mentions and exposes only controlled missing names', async () => {
  const result = await probe(async (request) => ({
    exitCode: 0,
    stdout:
      request.argv[0] === '--version'
        ? identity('claude-code')
        : 'Private diagnostic text. Use --restricted --tools --safe-mode to fix it.',
    stderr: 'private-secret',
  }));
  expect(result.status).toBe('missing-controls');
  expect(result.missingControls).toContain('--restricted');
  expect(JSON.stringify(result)).not.toContain('Private diagnostic');
  expect(JSON.stringify(result)).not.toContain('private-secret');
});

it('rejects relative/remote/shim paths and invalid deadlines before invoking I/O', async () => {
  const io = vi.fn(async () => ({
    exitCode: 0,
    stdout: identity('claude-code'),
    stderr: '',
  }));
  for (const path of [
    'claude.exe',
    '\\\\remote\\share\\claude.exe',
    resolve('.artifacts', 'claude.cmd'),
    resolve('.artifacts', 'powershell.exe'),
  ])
    await expect(
      probeSubscriptionRuntime('claude-code', path, cwd, {}, io),
    ).rejects.toThrow('Invalid runtime probe configuration.');
  await expect(probe(io, 'claude-code', 5001)).rejects.toThrow();
  expect(io).not.toHaveBeenCalled();
});

it('redacts identity/exit/transport failures and does not retry failed inspection', async () => {
  for (const packet of [
    { exitCode: 0, stdout: 'private-secret', stderr: '' },
    { exitCode: 1, stdout: identity('claude-code'), stderr: 'private-secret' },
  ]) {
    const io = vi.fn(async () => packet);
    const result = await probe(io);
    expect(result.status).toBe('probe-failed');
    expect(result.version).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(io).toHaveBeenCalledTimes(1);
  }
  const failed = await probe(async () => {
    throw Error('private-provider-key');
  });
  expect(failed).toMatchObject({ status: 'probe-failed', reason: 'transport' });
  expect(JSON.stringify(failed)).not.toContain('private-provider-key');
});

it('bounds injected I/O and discards late responses without another command', async () => {
  let finish:
    | ((value: { exitCode: number; stdout: string; stderr: string }) => void)
    | undefined;
  let signal: AbortSignal | undefined;
  const io = vi.fn(async (request: MetadataProbeCommand) => {
    signal = request.signal;
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve) => {
        finish = resolve;
      },
    );
  });
  const result = await probe(io, 'claude-code', 10);
  expect(result).toMatchObject({ status: 'probe-failed', reason: 'timeout' });
  expect(signal!.aborted).toBe(true);
  finish!({ exitCode: 0, stdout: identity('claude-code'), stderr: '' });
  await Promise.resolve();
  expect(io).toHaveBeenCalledTimes(1);
  const oversized = await probe(async () => ({
    exitCode: 0,
    stdout: 'x'.repeat(262145),
    stderr: '',
  }));
  expect(oversized).toMatchObject({
    status: 'probe-failed',
    reason: 'output-limit',
  });
});

it('spawns native metadata with no stdin, no shell, hidden windows and filtered environment', async () => {
  const child = fakeChild(),
    request = command();
  const result = runNativeMetadataCommand(request);
  expect(spawn).toHaveBeenCalledWith(request.executable, ['--version'], {
    cwd,
    env: request.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.write(Buffer.from(identity('claude-code')));
  child.emit('close', 0);
  expect(await result).toMatchObject({
    exitCode: 0,
    stdout: identity('claude-code'),
  });
  expect(child.kill).not.toHaveBeenCalled();
});

it('kills oversized native output once and rejects malformed UTF-8', async () => {
  const child = fakeChild();
  const result = runNativeMetadataCommand(command({ maxOutputBytes: 3 }));
  const rejected = expect(result).rejects.toMatchObject({
    reason: 'output-limit',
  });
  child.stderr.write(Buffer.from('private-secret'));
  await rejected;
  expect(child.kill).toHaveBeenCalledTimes(1);
  const invalid = fakeChild();
  const malformed = runNativeMetadataCommand(command());
  const failed = expect(malformed).rejects.toMatchObject({
    reason: 'transport',
  });
  invalid.stdout.write(Buffer.from([0xff]));
  invalid.emit('close', 0);
  await failed;
});

it('bounds stalled native processes and aborts even when kill fails or no close event arrives', async () => {
  const child = fakeChild();
  child.kill.mockImplementation(() => {
    throw Error('private-kill-error');
  });
  await expect(
    runNativeMetadataCommand(command({ timeoutMs: 10 })),
  ).rejects.toMatchObject({ reason: 'timeout' });
  expect(child.kill).toHaveBeenCalledTimes(1);
  const aborted = fakeChild(),
    controller = new AbortController();
  const result = runNativeMetadataCommand(
    command({ signal: controller.signal }),
  );
  const failed = expect(result).rejects.toMatchObject({ reason: 'transport' });
  controller.abort();
  await failed;
  expect(aborted.kill).toHaveBeenCalledTimes(1);
});

it('rejects auth/inference/extra arguments, injected environment and unsafe native launch settings', async () => {
  for (const extra of [
    { argv: ['auth', 'status'] },
    { argv: ['--print', 'private-prompt'] },
    { argv: ['--version', '--model', 'private'] },
    {
      env: {
        ...metadataProbeEnvironment({}),
        ANTHROPIC_API_KEY: 'private-key',
      },
    },
    { env: { ...metadataProbeEnvironment({}), LANG: 'private-key' } },
    { maxOutputBytes: 262145 },
    { timeoutMs: 5001 },
    { executable: resolve('.artifacts', 'node.exe') },
  ])
    await expect(runNativeMetadataCommand(command(extra))).rejects.toThrow(
      'Invalid runtime probe command.',
    );
  expect(spawn).not.toHaveBeenCalled();
});
