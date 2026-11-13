import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

export const outlookOrigins = [
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://outlook.cloud.microsoft',
  'https://outlook.live.com',
] as const;

const configSchema = z.strictObject({
  hubUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' ||
        ['127.0.0.1', 'localhost'].includes(url.hostname)
      );
    }, 'Use HTTPS (or a loopback address for development).'),
  hubToken: z.string().regex(/^hubob_[A-Za-z0-9_-]{20,200}$/),
  /** Dedicated persistent browser profile selected by the owner. */
  profilePath: z
    .string()
    .min(1)
    .max(4096)
    .refine(isAbsolute, 'Use an absolute profilePath.'),
  browserChannel: z.enum(['chrome', 'msedge']).default('chrome'),
  /** Exact Outlook Web origin shown by the school's normal sign-in. */
  outlookOrigin: z.enum(outlookOrigins).default('https://outlook.office.com'),
  /** Bounded time for the owner to complete interactive sign-in or MFA. */
  signInWaitSeconds: z.number().int().min(0).max(900).default(300),
});

export type OutlookBrowserConnectorConfig = z.infer<typeof configSchema>;

export const defaultConfigPath = () =>
  process.env.HUB_OUTLOOK_BROWSER_CONFIG ??
  join(
    process.env.APPDATA ?? join(homedir(), '.config'),
    'personal-hub',
    'outlook-browser-connector.json',
  );

export async function readConfig(
  path = defaultConfigPath(),
): Promise<OutlookBrowserConnectorConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No Outlook browser connector settings at ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('Invalid Outlook browser connector settings: JSON.');
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `Invalid Outlook browser connector settings: ${[
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
      ].join(', ')}`,
    );
  return parsed.data;
}
