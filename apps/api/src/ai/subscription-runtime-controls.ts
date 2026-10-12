// Advertised controls are preparation evidence, never proof of effective policy.
export const claudeSubscriptionControlArgv = [
  '--print',
  '--input-format',
  'text',
  '--output-format',
  'json',
  '--safe-mode',
  '--restricted',
  '--tools',
  '',
  '--disallowedTools',
  '*',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--no-chrome',
  '--permission-mode',
  'dontAsk',
  '--permission-prompts',
  'none',
  '--setting-sources',
  '',
] as const;

export const subscriptionProbeSpecs = {
  'claude-code': {
    helpArgs: ['--help'],
    flags: [
      '--model',
      '--system-prompt',
      ...claudeSubscriptionControlArgv.filter((value) =>
        value.startsWith('--'),
      ),
    ],
    commands: [],
  },
  'codex-subscription': {
    helpArgs: ['app-server', '--help'],
    flags: ['--strict-config', '--listen'],
    commands: ['generate-json-schema'],
  },
} as const;
export type SubscriptionRuntime = keyof typeof subscriptionProbeSpecs;
