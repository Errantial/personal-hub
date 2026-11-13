import { z } from 'zod';

/** The release feed publishes bounded metadata only. */
export const releaseChannelSchema = z.enum(['stable', 'beta']);

const releaseAssetUrl = z
  .string()
  .url()
  .refine((value) => {
    if (!value.startsWith('https://')) return false;
    const authority = value.slice('https://'.length).split('/')[0] ?? '';
    return (
      authority.length > 0 &&
      !authority.includes('@') &&
      !value.includes('?') &&
      !value.includes('#')
    );
  }, 'Use an HTTPS release asset URL without credentials, query or fragment.');

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const releaseAssetSchema = z.strictObject({
  url: releaseAssetUrl,
  sha256,
  size: z
    .number()
    .int()
    .positive()
    .max(250 * 1024 * 1024),
});

export const desktopPlatformSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9-]{1,31}$/);

export const desktopReleaseAssetSchema = releaseAssetSchema.extend({
  platform: desktopPlatformSchema,
});

const uniqueDesktopPlatforms = (
  value: { desktop: { platform: string }[] },
  context: z.RefinementCtx,
) => {
  const platforms = new Set<string>();
  value.desktop.forEach((asset, index) => {
    if (platforms.has(asset.platform))
      context.addIssue({
        code: 'custom',
        path: ['desktop', index, 'platform'],
        message: 'Desktop platforms must be unique.',
      });
    platforms.add(asset.platform);
  });
};

/**
 * `release-manifest.json` is the preferred asset in a GitHub release. The
 * server cross-checks it against the release's actual asset list before use.
 */
export const releaseManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    channel: releaseChannelSchema,
    versionName: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/),
    versionCode: z.number().int().positive().max(2_100_000_000),
    notes: z.string().max(4000),
    android: releaseAssetSchema.nullable(),
    desktop: z.array(desktopReleaseAssetSchema).max(8),
  })
  .superRefine(uniqueDesktopPlatforms);

export const appUpdatePlatformSchema = z.literal('android');

export const appUpdateQuerySchema = z.strictObject({
  platform: appUpdatePlatformSchema,
  versionCode: z.coerce.number().int().min(0).max(2_100_000_000),
});

export const appUpdateUnavailableReasonSchema = z.enum([
  'RELEASE_NOT_FOUND',
  'MANIFEST_MISSING',
  'MANIFEST_INVALID',
  'ANDROID_ASSET_MISSING',
  'GITHUB_RATE_LIMITED',
  'GITHUB_UNAVAILABLE',
]);

export const appUpdateLatestSchema = z
  .strictObject({
    versionName: z.string().min(1).max(80),
    versionCode: z.number().int().positive().max(2_100_000_000),
    channel: releaseChannelSchema,
    notes: z.string().max(4000),
    android: releaseAssetSchema.nullable(),
    desktop: z.array(desktopReleaseAssetSchema).max(8),
  })
  .superRefine(uniqueDesktopPlatforms);

export const appUpdateResponseSchema = z
  .strictObject({
    platform: appUpdatePlatformSchema,
    installedVersionCode: z.number().int().min(0).max(2_100_000_000),
    state: z.enum(['update-available', 'current', 'unavailable']),
    checkedAt: z.string().datetime(),
    latest: appUpdateLatestSchema.nullable(),
    reason: appUpdateUnavailableReasonSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.state === 'unavailable') {
      if (!value.reason)
        context.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'An unavailable check needs a reason.',
        });
      if (value.latest)
        context.addIssue({
          code: 'custom',
          path: ['latest'],
          message: 'An unavailable check has no release.',
        });
      return;
    }
    if (!value.latest)
      context.addIssue({
        code: 'custom',
        path: ['latest'],
        message: 'A completed check needs release metadata.',
      });
    if (value.reason)
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A completed check has no failure reason.',
      });
  });

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type DesktopReleaseAsset = z.infer<typeof desktopReleaseAssetSchema>;
export type AppUpdateLatest = z.infer<typeof appUpdateLatestSchema>;
export type AppUpdateResponse = z.infer<typeof appUpdateResponseSchema>;
export type AppUpdateUnavailableReason = z.infer<
  typeof appUpdateUnavailableReasonSchema
>;
