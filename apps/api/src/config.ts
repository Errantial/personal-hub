import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
});

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .url()
        .refine((value) =>
          ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
        )
        .optional(),
    ),
    PGLITE_DATA_DIR: z
      .string()
      .min(1)
      .default(
        fileURLToPath(new URL('../../../.data/planner/', import.meta.url)),
      ),
    WEB_ORIGINS: z
      .string()
      .default('http://127.0.0.1:5173,http://127.0.0.1:4173')
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(z.array(originSchema).min(1)),
    SETUP_TOKEN: z.string().min(32).optional(),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === 'production') {
      if (!config.DATABASE_URL)
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'PostgreSQL is required in production.',
        });
      if (config.WEB_ORIGINS.some((origin) => !origin.startsWith('https://')))
        context.addIssue({
          code: 'custom',
          path: ['WEB_ORIGINS'],
          message: 'HTTPS origins are required in production.',
        });
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(config.API_HOST)) {
      context.addIssue({
        code: 'custom',
        path: ['API_HOST'],
        message: 'Development setup must remain on loopback.',
      });
    }
  });

export function readConfig(environment: Record<string, string | undefined>) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}

export type Config = ReturnType<typeof readConfig>;
