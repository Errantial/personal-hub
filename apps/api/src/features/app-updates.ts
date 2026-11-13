import { z } from 'zod';
import {
  appUpdateQuerySchema,
  appUpdateRepository,
  appUpdateResponseSchema,
  releaseManifestSchema,
} from '@hub/contracts';
import type {
  AppUpdateLatest,
  AppUpdateResponse,
  AppUpdateUnavailableReason,
  ReleaseManifest,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { authService } from '../auth/routes.js';
import type { Config } from '../config.js';

export { appUpdateRepository };
/** Tests inject this; the default is the global fetch. */
export type GithubFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
const releaseEndpoint = `https://api.github.com/repos/${appUpdateRepository}/releases/latest`;
const manifestName = 'release-manifest.json';
const requestTimeoutMs = 8000;
const releaseJsonLimit = 512 * 1024;
const manifestLimit = 64 * 1024;
const successCacheMs = 5 * 60 * 1000;
const failureCacheMs = 60 * 1000;
const maximumRedirects = 5;
const redirectHosts = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const githubAssetSchema = z.object({
  name: z.string().min(1).max(255),
  browser_download_url: z.string().url(),
  size: z.number().int().nonnegative(),
});
const githubReleaseSchema = z.object({
  tag_name: z.string().min(1).max(128),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(githubAssetSchema).max(64),
});
type GithubRelease = z.infer<typeof githubReleaseSchema>;

type ReleaseResult =
  { manifest: ReleaseManifest } | { reason: AppUpdateUnavailableReason };

class UpdateUnavailable extends Error {
  constructor(public readonly reason: AppUpdateUnavailableReason) {
    super(reason);
  }
}

const decodedPath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
};

/** A release asset URL must stay on this repository's GitHub download path. */
export function isGithubReleaseAssetUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      decodedPath(url.pathname).startsWith(
        `/${appUpdateRepository}/releases/download/`,
      ) &&
      !decodedPath(url.pathname).includes('..')
    );
  } catch {
    return false;
  }
}

const safeAssetName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(name) && !name.includes('..');

function allowedInitialFetchUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.hostname === 'api.github.com' &&
        url.pathname === `/repos/${appUpdateRepository}/releases/latest`) ||
      (url.hostname === 'github.com' && isGithubReleaseAssetUrl(value))
    );
  } catch {
    return false;
  }
}

function allowedRedirectUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.port === '' &&
      redirectHosts.has(url.hostname) &&
      !decodedPath(url.pathname).includes('..')
    );
  } catch {
    return false;
  }
}

function sameReleaseAssetUrl(left: string, right: string) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.protocol === b.protocol &&
      a.host === b.host &&
      decodedPath(a.pathname) === decodedPath(b.pathname)
    );
  } catch {
    return false;
  }
}

function findReleaseAsset(release: GithubRelease, url: string, size: number) {
  const matches = release.assets.filter(
    (asset) =>
      asset.size === size &&
      safeAssetName(asset.name) &&
      sameReleaseAssetUrl(asset.browser_download_url, url) &&
      decodedPath(new URL(asset.browser_download_url).pathname).endsWith(
        `/${asset.name}`,
      ),
  );
  return matches.length === 1 ? matches[0]! : null;
}

async function boundedText(response: Response, limit: number) {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      if (response.body) await response.body.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export type AppUpdateService = ReturnType<typeof createAppUpdateService>;

/**
 * Reads the latest stable GitHub release and its release-manifest.json. The
 * token, when present, is used only on the API request and never returned.
 * Successful and failed results are cached briefly so a page reload or several
 * devices do not multiply GitHub traffic.
 */
export function createAppUpdateService(options: {
  fetcher: GithubFetch;
  token?: string;
  now?: () => number;
  successCacheMs?: number;
  failureCacheMs?: number;
}) {
  const now = options.now ?? (() => Date.now());
  const successTtl = options.successCacheMs ?? successCacheMs;
  const failureTtl = options.failureCacheMs ?? failureCacheMs;
  let cached: { at: number; value: ReleaseResult } | null = null;
  let inflight: Promise<ReleaseResult> | null = null;

  const fetchWithTimeout = async (
    url: string,
    headers: Record<string, string>,
  ) => {
    if (!allowedInitialFetchUrl(url))
      throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
    // The signal stays attached while the response body is read, so a stalled
    // GitHub body cannot hold an update check open indefinitely.
    const signal = AbortSignal.timeout(requestTimeoutMs);
    let current = new URL(url);
    for (let redirects = 0; ; redirects += 1) {
      let response: Response;
      try {
        response = await options.fetcher(current.toString(), {
          headers,
          signal,
          redirect: 'manual',
        });
      } catch {
        throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
      }
      if (!redirectStatuses.has(response.status)) return response;
      if (redirects >= maximumRedirects) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
      }
      const location = response.headers.get('location');
      if (!location) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        if (response.body) await response.body.cancel().catch(() => undefined);
        throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
      }
      if (!allowedRedirectUrl(next.toString())) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
      }
      if (response.body) await response.body.cancel().catch(() => undefined);
      current = next;
    }
  };

  const readRelease = async (): Promise<ReleaseResult> => {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'personal-hub-update-check',
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetchWithTimeout(releaseEndpoint, headers);
    if (response.status === 404)
      throw new UpdateUnavailable('RELEASE_NOT_FOUND');
    if (response.status === 403 || response.status === 429)
      throw new UpdateUnavailable('GITHUB_RATE_LIMITED');
    if (!response.ok) throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
    const body = await boundedText(response, releaseJsonLimit);
    if (body === null) throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
    let release: GithubRelease;
    try {
      release = githubReleaseSchema.parse(JSON.parse(body));
    } catch {
      throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
    }
    if (release.draft || release.prerelease)
      throw new UpdateUnavailable('RELEASE_NOT_FOUND');
    const manifests = release.assets.filter(
      (asset) => asset.name === manifestName,
    );
    if (manifests.length !== 1) throw new UpdateUnavailable('MANIFEST_MISSING');
    const manifestAsset = manifests[0]!;
    if (
      !safeAssetName(manifestAsset.name) ||
      !isGithubReleaseAssetUrl(manifestAsset.browser_download_url)
    )
      throw new UpdateUnavailable('MANIFEST_INVALID');
    if (manifestAsset.size <= 0 || manifestAsset.size > manifestLimit)
      throw new UpdateUnavailable('MANIFEST_INVALID');
    const manifestResponse = await fetchWithTimeout(
      manifestAsset.browser_download_url,
      {
        Accept: 'application/octet-stream',
        'User-Agent': 'personal-hub-update-check',
      },
    );
    if (manifestResponse.status === 404)
      throw new UpdateUnavailable('MANIFEST_MISSING');
    if (!manifestResponse.ok) throw new UpdateUnavailable('GITHUB_UNAVAILABLE');
    const manifestBody = await boundedText(manifestResponse, manifestLimit);
    if (manifestBody === null) throw new UpdateUnavailable('MANIFEST_INVALID');
    let manifest: ReleaseManifest;
    try {
      manifest = releaseManifestSchema.parse(JSON.parse(manifestBody));
    } catch {
      throw new UpdateUnavailable('MANIFEST_INVALID');
    }
    if (manifest.channel !== 'stable')
      throw new UpdateUnavailable('MANIFEST_INVALID');
    if (!manifest.android) throw new UpdateUnavailable('ANDROID_ASSET_MISSING');
    const androidAsset = findReleaseAsset(
      release,
      manifest.android.url,
      manifest.android.size,
    );
    if (
      !androidAsset ||
      androidAsset.name !== `personal-hub-${manifest.versionName}.apk`
    )
      throw new UpdateUnavailable('MANIFEST_INVALID');
    for (const desktop of manifest.desktop)
      if (!findReleaseAsset(release, desktop.url, desktop.size))
        throw new UpdateUnavailable('MANIFEST_INVALID');
    return { manifest };
  };

  const latest = async (): Promise<ReleaseResult> => {
    const current = now();
    if (cached) {
      const ttl = 'reason' in cached.value ? failureTtl : successTtl;
      if (current - cached.at < ttl) return cached.value;
    }
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const value = await readRelease();
        cached = { at: current, value };
        return value;
      } catch (error) {
        const value: ReleaseResult = {
          reason:
            error instanceof UpdateUnavailable
              ? error.reason
              : 'GITHUB_UNAVAILABLE',
        };
        cached = { at: current, value };
        return value;
      } finally {
        inflight = null;
      }
    })();
    inflight = task;
    return task;
  };

  const check = async (
    installedVersionCode: number,
  ): Promise<AppUpdateResponse> => {
    const release = await latest();
    const checkedAt = new Date(now()).toISOString();
    if ('reason' in release)
      return appUpdateResponseSchema.parse({
        platform: 'android',
        installedVersionCode,
        state: 'unavailable',
        checkedAt,
        latest: null,
        reason: release.reason,
      });
    const latestRelease: AppUpdateLatest = {
      versionName: release.manifest.versionName,
      versionCode: release.manifest.versionCode,
      channel: release.manifest.channel,
      notes: release.manifest.notes,
      android: release.manifest.android,
      desktop: release.manifest.desktop,
    };
    return appUpdateResponseSchema.parse({
      platform: 'android',
      installedVersionCode,
      state:
        release.manifest.versionCode > installedVersionCode
          ? 'update-available'
          : 'current',
      checkedAt,
      latest: latestRelease,
      reason: null,
    });
  };

  return { check, latest };
}

export function registerAppUpdates(
  app: FastifyInstance,
  auth: ReturnType<typeof authService>,
  config: Config,
  fetcher: GithubFetch = fetch,
  now?: () => number,
) {
  const service = createAppUpdateService({
    fetcher,
    ...(config.GITHUB_TOKEN ? { token: config.GITHUB_TOKEN } : {}),
    ...(now ? { now } : {}),
  });
  app.get('/api/v1/app/update', async (request) => {
    await auth.requireUser(request);
    const query = appUpdateQuerySchema.parse(request.query);
    return service.check(query.versionCode);
  });
}
