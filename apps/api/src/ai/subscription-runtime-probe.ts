import { spawn } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { subscriptionProbeSpecs } from './subscription-runtime-controls.js';
import type { SubscriptionRuntime } from './subscription-runtime-controls.js';

export interface MetadataProbeCommand {
  adapter: SubscriptionRuntime;
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  shell: false;
  windowsHide: true;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}
export type MetadataProbeIO = (
  command: MetadataProbeCommand,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
class ProbeError extends Error {
  constructor(readonly reason: 'timeout' | 'output-limit' | 'transport') {
    super('Runtime metadata probe failed.');
  }
}
function localAbsolute(value: string) {
  return (
    value.length <= 1024 &&
    isAbsolute(value) &&
    !/[\0\r\n]/.test(value) &&
    !/^(?:\\\\|\/\/)/.test(value)
  );
}
export function metadataProbeEnvironment(
  parent: Record<string, string | undefined>,
) {
  const result: Record<string, string> = {
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'C',
  };
  for (const key of ['SystemRoot', 'WINDIR']) {
    const value = parent[key];
    if (value !== undefined) {
      if (!localAbsolute(value))
        throw new Error('Invalid runtime probe environment.');
      result[key] = value;
    }
  }
  return result;
}

// Only version/help are runnable. No prompt, stdin, shell, auth/account command,
// inherited credentials, caller-supplied extra flags or retry is accepted.
export const runNativeMetadataCommand: MetadataProbeIO = async (command) => {
  const spec = subscriptionProbeSpecs[command.adapter];
  const expected =
    command.adapter === 'claude-code'
      ? ['claude', 'claude.exe']
      : ['codex', 'codex.exe'];
  if (
    !spec ||
    !localAbsolute(command.executable) ||
    !expected.includes(basename(command.executable).toLowerCase()) ||
    !localAbsolute(command.cwd) ||
    command.shell !== false ||
    command.windowsHide !== true ||
    !Number.isInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > 5000 ||
    !Number.isInteger(command.maxOutputBytes) ||
    command.maxOutputBytes < 1 ||
    command.maxOutputBytes > 262144 ||
    ![JSON.stringify(['--version']), JSON.stringify(spec.helpArgs)].includes(
      JSON.stringify(command.argv),
    ) ||
    Object.keys(command.env).some(
      (key) =>
        !['NO_COLOR', 'TERM', 'LANG', 'SystemRoot', 'WINDIR'].includes(key),
    ) ||
    command.env.NO_COLOR !== '1' ||
    command.env.TERM !== 'dumb' ||
    command.env.LANG !== 'C' ||
    ['SystemRoot', 'WINDIR'].some(
      (key) =>
        command.env[key] !== undefined && !localAbsolute(command.env[key]!),
    )
  )
    throw new Error('Invalid runtime probe command.');
  if (command.signal.aborted) throw new ProbeError('transport');
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.argv], {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let done = false,
      total = 0;
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const finish = (error?: ProbeError, exitCode: number | null = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      command.signal.removeEventListener('abort', aborted);
      if (error) {
        reject(error);
        return;
      }
      try {
        const decode = new TextDecoder('utf-8', { fatal: true });
        resolve({
          exitCode,
          stdout: decode.decode(Buffer.concat(stdout)),
          stderr: decode.decode(Buffer.concat(stderr)),
        });
      } catch {
        reject(new ProbeError('transport'));
      }
    };
    const stop = (reason: 'timeout' | 'output-limit' | 'transport') => {
      if (done) return;
      finish(new ProbeError(reason));
      try {
        child.kill('SIGKILL');
      } catch {
        /* The redacted outcome is already fixed. */
      }
    };
    const aborted = () => stop('transport');
    command.signal.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => stop('timeout'), command.timeoutMs);
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream?.on('data', (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > command.maxOutputBytes) {
          stop('output-limit');
          return;
        }
        chunks.push(chunk);
      });
    }
    child.on('error', () => stop('transport'));
    child.once('close', (code) => finish(undefined, code));
    if (command.signal.aborted) aborted();
  });
};

export async function probeSubscriptionRuntime(
  adapter: SubscriptionRuntime,
  executable: string,
  cwd: string,
  parentEnvironment: Record<string, string | undefined>,
  io: MetadataProbeIO = runNativeMetadataCommand,
  timeoutMs = 5000,
) {
  const spec = subscriptionProbeSpecs[adapter];
  const filename = basename(executable).toLowerCase();
  const expected =
    adapter === 'claude-code'
      ? ['claude', 'claude.exe']
      : ['codex', 'codex.exe'];
  if (
    !spec ||
    !localAbsolute(executable) ||
    !localAbsolute(cwd) ||
    !expected.includes(filename) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    throw new Error('Invalid runtime probe configuration.');
  const env = metadataProbeEnvironment(parentEnvironment);
  let version: string | null = null;
  const base = {
    adapter,
    dispatchEnabled: false as const,
    isolation: 'unverified' as const,
    account: 'not_checked' as const,
    billing: 'unverified' as const,
  };
  const execute = async (argv: readonly string[]) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        io({
          adapter,
          executable,
          argv: [...argv],
          cwd,
          env: { ...env },
          shell: false,
          windowsHide: true,
          timeoutMs,
          maxOutputBytes: 262144,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ProbeError('timeout'));
          }, timeoutMs);
        }),
      ]);
      if (controller.signal.aborted) throw new ProbeError('timeout');
      if (
        Buffer.byteLength(response.stdout, 'utf8') +
          Buffer.byteLength(response.stderr, 'utf8') >
        262144
      )
        throw new ProbeError('output-limit');
      return response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    const identity = await execute(['--version']);
    const pattern =
      adapter === 'claude-code'
        ? /^(\d{1,4}\.\d{1,4}\.\d{1,6}) \(Claude Code\)$/
        : /^codex-cli (\d{1,4}\.\d{1,4}\.\d{1,6})$/;
    version = identity.stdout.trim().match(pattern)?.[1] ?? null;
    if (identity.exitCode !== 0 || version === null)
      return {
        ...base,
        status: 'probe-failed' as const,
        version: null,
        reason: 'identity' as const,
        missingControls: [],
      };
    const help = await execute(spec.helpArgs);
    if (help.exitCode !== 0)
      return {
        ...base,
        status: 'probe-failed' as const,
        version,
        reason: 'exit' as const,
        missingControls: [],
      };
    const advertised = new Set(
      [
        ...help.stdout.matchAll(
          /^\s{2,8}(?:-[A-Za-z],\s+)?(--[A-Za-z][A-Za-z0-9-]*)(?=[\s,]|$)/gm,
        ),
      ].map((match) => match[1]!),
    );
    const commands = new Set(
      [...help.stdout.matchAll(/^\s{2,8}([a-z][a-z-]*)\s/gm)].map(
        (match) => match[1]!,
      ),
    );
    const missingControls = [
      ...spec.flags.filter((flag) => !advertised.has(flag)),
      ...spec.commands.filter((name) => !commands.has(name)),
    ];
    return {
      ...base,
      status: missingControls.length
        ? ('missing-controls' as const)
        : ('controls-advertised' as const),
      version,
      reason: null,
      missingControls,
    };
  } catch (error) {
    return {
      ...base,
      status: 'probe-failed' as const,
      version,
      reason:
        error instanceof ProbeError ? error.reason : ('transport' as const),
      missingControls: [],
    };
  }
}
