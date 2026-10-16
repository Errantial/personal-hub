import { z } from 'zod';
export const aiProviderAdapterSchema = z.enum([
  'anthropic',
  'openai',
  'openai-compatible',
  'claude-code',
  'codex-subscription',
  'openrouter',
  'prem-confidential',
  'typesafe',
]);
export const aiProviderAccessModeSchema = z.enum([
  'api-key',
  'owner-subscription',
  'confidential-api',
]);
