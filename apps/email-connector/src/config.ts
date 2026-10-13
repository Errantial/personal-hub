import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Private settings, kept outside the repository (default
 * %APPDATA%\personal-hub\email-connector.json, or HUB_CONNECTOR_CONFIG).
 * Holds the Bridge password and the hub connector token: never commit,
 * print or log it.
 */
const configSchema = z.strictObject({
  /** Hub origin, e.g. https://hub.ecg.name. Not needed for `check`. */
  hubUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' ||
        ['127.0.0.1', 'localhost'].includes(url.hostname)
      );
    }, 'Use HTTPS (or a loopback address for development).')
    .optional(),
  /** Connector token from Settings › Connections › Email. */
  hubToken: z
    .string()
    .regex(/^hubc_[A-Za-z0-9_-]{20,200}$/)
    .optional(),
  bridge: z.strictObject({
    // Bridge must stay on this machine: only loopback addresses are accepted.
    host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(1143),
    /** Bridge › IMAP connection mode: SSL (implicit TLS) or STARTTLS. */
    security: z.enum(['ssl', 'starttls']).default('ssl'),
    user: z.string().min(1).max(320),
    password: z.string().min(1).max(4096),
  }),
});
export type ConnectorConfig = z.infer<typeof configSchema>;

export const defaultConfigPath = () =>
  process.env.HUB_CONNECTOR_CONFIG ??
  join(
    process.env.APPDATA ?? join(homedir(), '.config'),
    'personal-hub',
    'email-connector.json',
  );

export async function readConnectorConfig(
  path = defaultConfigPath(),
): Promise<ConnectorConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No connector settings at ${path}.`);
  }
  const parsed = configSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    // Name the fields only; values may be secrets.
    throw new Error(
      `Invalid connector settings: ${[
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
      ].join(', ')}`,
    );
  return parsed.data;
}
