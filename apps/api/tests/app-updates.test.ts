import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUpdateResponseSchema, releaseManifestSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import {
  appUpdateRepository,
  createAppUpdateService,
  isGithubReleaseAssetUrl,
} from '../src/features/app-updates.js';
import type { GithubFetch } from '../src/features/app-updates.js';

const origin = 'http://127.0.0.1:5173';
const tag = 'android-0.1.0-300';
const versionName = '0.1.0+abc1234';
const assetName = `personal-hub-${versionName}.apk`;
const assetUrl = `https://github.com/${appUpdateRepository}/releases/download/${tag}/${assetName}`;
const manifestUrl = `https://github.com/${appUpdateRepository}/releases/download/${tag}/release-manifest.json`;
const digest = 'a'.repeat(64);
const size = 4096;

const manifest = {
  formatVersion: 1,
  channel: 'stable',
  versionName,
  versionCode: 300,
  notes: 'Synthetic notes.\nOnly synthetic text.',
  android: { url: assetUrl, sha256: digest, size },
  desktop: [],
};

const release = {
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'release-manifest.json',
      browser_download_url: manifestUrl,
      size: 512,
    },
    { name: assetName, browser_download_url: assetUrl, size },
  ],
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function fakeGithub(
  options: {
    release?: unknown;
    manifest?: unknown;
    releaseText?: string;
    manifestText?: string;
    releaseHeaders?: Record<string, string>;
    manifestHeaders?: Record<string, string>;
    releaseStatus?: number;
    manifestStatus?: number;
    reject?: boolean;
  } = {},
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: GithubFetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    if (options.reject) throw new TypeError('Synthetic network failure');
    if (
      url ===
      `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
    ) {
      if (options.releaseText !== undefined)
        return new Response(options.releaseText, {
          status: options.releaseStatus ?? 200,
          ...(options.releaseHeaders
            ? { headers: options.releaseHeaders }
            : {}),
        });
      return json(options.release ?? release, options.releaseStatus ?? 200);
    }
    if (url === manifestUrl) {
      if (options.manifestText !== undefined)
        return new Response(options.manifestText, {
          status: options.manifestStatus ?? 200,
          ...(options.manifestHeaders
            ? { headers: options.manifestHeaders }
            : {}),
        });
      return json(options.manifest ?? manifest, options.manifestStatus ?? 200);
    }
    throw new Error(`Unexpected network URL: ${url}`);
  };
  return { fetcher, calls };
}

async function createEnrolledApp(fetcher: GithubFetch) {
  const app = await buildApp(
    { logger: false },
    {
      config: readConfig({
        NODE_ENV: 'test',
        PGLITE_DATA_DIR: 'memory://',
        GITHUB_TOKEN: 'synthetic-github-token',
      }),
      githubFetch: fetcher,
    },
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'updates@example.test',
      password: 'synthetic-updates-password',
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    app,
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
  };
}

describe('release asset URL validation', () => {
  it('accepts only this repository HTTPS download path', () => {
    expect(isGithubReleaseAssetUrl(assetUrl)).toBe(true);
    expect(isGithubReleaseAssetUrl(manifestUrl)).toBe(true);
    expect(
      isGithubReleaseAssetUrl(
        assetUrl.replace('https://github.com', 'http://github.com'),
      ),
    ).toBe(false);
    expect(
      isGithubReleaseAssetUrl(
        assetUrl.replace(appUpdateRepository, 'someone/else'),
      ),
    ).toBe(false);
    expect(isGithubReleaseAssetUrl(`${assetUrl}?download=1`)).toBe(false);
    expect(isGithubReleaseAssetUrl('https://example.test/update.apk')).toBe(
      false,
    );
  });
});

describe('release manifest contract', () => {
  it('parses the bounded stable manifest', () => {
    expect(releaseManifestSchema.parse(manifest).desktop).toEqual([]);
  });

  it('rejects malformed digests, oversized notes and invalid asset URLs', () => {
    expect(() =>
      releaseManifestSchema.parse({
        ...manifest,
        android: { ...manifest.android, sha256: 'not-a-digest' },
      }),
    ).toThrow();
    expect(() =>
      releaseManifestSchema.parse({ ...manifest, notes: 'x'.repeat(4001) }),
    ).toThrow();
    expect(() =>
      releaseManifestSchema.parse({
        ...manifest,
        android: { ...manifest.android, url: 'http://example.test/app.apk' },
      }),
    ).toThrow();
  });
});

describe('app update service', () => {
  it('maps a newer versionCode to an available update and keeps notes bounded', async () => {
    const { fetcher } = fakeGithub();
    const service = createAppUpdateService({ fetcher });
    const result = await service.check(254);
    expect(appUpdateResponseSchema.parse(result)).toMatchObject({
      platform: 'android',
      installedVersionCode: 254,
      state: 'update-available',
      latest: {
        versionCode: 300,
        versionName,
        channel: 'stable',
        notes: manifest.notes,
        desktop: [],
      },
      reason: null,
    });
  });

  it('never offers a downgrade or a same-code build', async () => {
    const { fetcher } = fakeGithub();
    const service = createAppUpdateService({ fetcher });
    expect((await service.check(300)).state).toBe('current');
    expect((await service.check(301)).state).toBe('current');
  });

  it('caches a successful GitHub read briefly and refreshes after the TTL', async () => {
    const { fetcher, calls } = fakeGithub();
    let now = 1_000;
    const service = createAppUpdateService({
      fetcher,
      now: () => now,
      successCacheMs: 1000,
      failureCacheMs: 100,
    });
    await service.check(1);
    await service.check(1);
    expect(calls).toHaveLength(2);
    now += 1001;
    await service.check(1);
    expect(calls).toHaveLength(4);
  });

  it('caches failures for a shorter bounded interval', async () => {
    const { fetcher, calls } = fakeGithub({ reject: true });
    let now = 1_000;
    const service = createAppUpdateService({
      fetcher,
      now: () => now,
      successCacheMs: 1000,
      failureCacheMs: 100,
    });
    expect((await service.check(1)).reason).toBe('GITHUB_UNAVAILABLE');
    expect((await service.check(1)).reason).toBe('GITHUB_UNAVAILABLE');
    expect(calls).toHaveLength(1);
    now += 101;
    await service.check(1);
    expect(calls).toHaveLength(2);
  });

  it('does not forward the GitHub token across redirects', async () => {
    const redirectUrl =
      'https://github.com/Errantial/personal-hub/releases/download/tag/redirected.json';
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher: GithubFetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      if (
        url ===
        `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
      )
        return new Response(null, {
          status: 302,
          headers: { location: redirectUrl },
        });
      if (url === redirectUrl) return json(release);
      if (url === manifestUrl) return json(manifest);
      throw new Error(`Unexpected network URL: ${url}`);
    };
    await createAppUpdateService({
      fetcher,
      token: 'synthetic-github-token',
    }).check(1);
    expect(calls[0]?.headers.Authorization).toBe(
      'Bearer synthetic-github-token',
    );
    expect(calls[1]?.headers.Authorization).toBeUndefined();
    expect(calls[2]?.headers.Authorization).toBeUndefined();
  });

  it('degrades on a redirect without Location and on redirect exhaustion', async () => {
    const missingLocation: GithubFetch = async (input) => {
      const url = String(input);
      if (
        url ===
        `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
      )
        return new Response(null, { status: 302 });
      throw new Error(`Unexpected network URL: ${url}`);
    };
    expect(
      (await createAppUpdateService({ fetcher: missingLocation }).check(1))
        .reason,
    ).toBe('GITHUB_UNAVAILABLE');

    const looped =
      'https://objects.githubusercontent.com/synthetic/manifest-loop';
    let manifestCalls = 0;
    const looping: GithubFetch = async (input) => {
      const url = String(input);
      if (
        url ===
        `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
      )
        return json(release);
      if (url === manifestUrl || url === looped) {
        manifestCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: looped },
        });
      }
      throw new Error(`Unexpected network URL: ${url}`);
    };
    expect(
      (await createAppUpdateService({ fetcher: looping }).check(1)).reason,
    ).toBe('GITHUB_UNAVAILABLE');
    expect(manifestCalls).toBeGreaterThan(1);
  });

  it('follows only bounded GitHub asset redirects', async () => {
    const redirected =
      'https://objects.githubusercontent.com/synthetic/manifest';
    const fetcher: GithubFetch = async (input) => {
      const url = String(input);
      if (
        url ===
        `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
      )
        return json(release);
      if (url === manifestUrl)
        return new Response(null, {
          status: 302,
          headers: { location: redirected },
        });
      if (url === redirected) return json(manifest);
      throw new Error(`Unexpected network URL: ${url}`);
    };
    expect((await createAppUpdateService({ fetcher }).check(1)).state).toBe(
      'update-available',
    );

    const foreign: GithubFetch = async (input) => {
      const url = String(input);
      if (
        url ===
        `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
      )
        return json(release);
      if (url === manifestUrl)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.test/manifest.json' },
        });
      throw new Error(`Unexpected network URL: ${url}`);
    };
    expect(
      (await createAppUpdateService({ fetcher: foreign }).check(1)).reason,
    ).toBe('GITHUB_UNAVAILABLE');
  });

  it('shares one cold GitHub read across concurrent checks', async () => {
    let releaseCalls = 0;
    let manifestCalls = 0;
    let releaseGateResolve!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseGateResolve = resolve;
    });
    const fetcher: GithubFetch = async (input) => {
      const url = String(input);
      if (
        url ===
        `https://api.github.com/repos/${appUpdateRepository}/releases/latest`
      ) {
        releaseCalls += 1;
        await releaseGate;
        return json(release);
      }
      if (url === manifestUrl) {
        manifestCalls += 1;
        return json(manifest);
      }
      throw new Error(`Unexpected network URL: ${url}`);
    };
    const service = createAppUpdateService({ fetcher, now: () => 1_000 });
    const first = service.check(1);
    const second = service.check(1);
    await Promise.resolve();
    expect(releaseCalls).toBe(1);
    releaseGateResolve();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(releaseCalls).toBe(1);
    expect(manifestCalls).toBe(1);
  });

  it('rejects declared and streamed manifest bodies above the hard cap', async () => {
    const declared = createAppUpdateService({
      fetcher: fakeGithub({
        manifestText: JSON.stringify(manifest),
        manifestHeaders: { 'content-length': String(64 * 1024 + 1) },
      }).fetcher,
    });
    expect((await declared.check(1)).reason).toBe('MANIFEST_INVALID');

    const streamed = createAppUpdateService({
      fetcher: fakeGithub({
        manifestText: 'x'.repeat(64 * 1024 + 1),
        manifestHeaders: { 'content-length': '1' },
      }).fetcher,
    });
    expect((await streamed.check(1)).reason).toBe('MANIFEST_INVALID');
  });

  it('accepts a cross-checked desktop asset and rejects a mismatched one', async () => {
    const desktopName = 'personal-hub-windows-setup.exe';
    const desktopUrl = `https://github.com/${appUpdateRepository}/releases/download/${tag}/${desktopName}`;
    const desktopSize = 2048;
    const releaseWithDesktop = {
      ...release,
      assets: [
        ...release.assets,
        {
          name: desktopName,
          browser_download_url: desktopUrl,
          size: desktopSize,
        },
      ],
    };
    const manifestWithDesktop = {
      ...manifest,
      desktop: [
        {
          platform: 'windows',
          url: desktopUrl,
          sha256: digest,
          size: desktopSize,
        },
      ],
    };
    const valid = createAppUpdateService({
      fetcher: fakeGithub({
        release: releaseWithDesktop,
        manifest: manifestWithDesktop,
      }).fetcher,
    });
    const result = await valid.check(1);
    expect(result.state).toBe('update-available');
    expect(result.latest?.desktop).toEqual([
      expect.objectContaining({ platform: 'windows', size: desktopSize }),
    ]);

    const invalid = createAppUpdateService({
      fetcher: fakeGithub({
        release: releaseWithDesktop,
        manifest: {
          ...manifestWithDesktop,
          desktop: [
            {
              ...manifestWithDesktop.desktop[0]!,
              size: desktopSize + 1,
            },
          ],
        },
      }).fetcher,
    });
    expect((await invalid.check(1)).reason).toBe('MANIFEST_INVALID');
  });

  it.each([
    [
      'a missing manifest asset response',
      { manifestStatus: 404 },
      'MANIFEST_MISSING',
    ],
    ['a manifest server error', { manifestStatus: 500 }, 'GITHUB_UNAVAILABLE'],
    [
      'malformed release JSON',
      { releaseText: 'synthetic-not-json' },
      'GITHUB_UNAVAILABLE',
    ],
    [
      'a draft release',
      { release: { ...release, draft: true } },
      'RELEASE_NOT_FOUND',
    ],
    [
      'duplicate manifest assets',
      {
        release: {
          ...release,
          assets: [release.assets[0], release.assets[0], release.assets[1]],
        },
      },
      'MANIFEST_MISSING',
    ],
  ])('handles %s', async (_, options, reason) => {
    const service = createAppUpdateService({
      fetcher: fakeGithub(options as Parameters<typeof fakeGithub>[0]).fetcher,
    });
    expect((await service.check(1)).reason).toBe(reason);
  });

  it.each([
    [
      'a missing manifest asset',
      { release: { ...release, assets: release.assets.slice(1) } },
      'MANIFEST_MISSING',
    ],
    [
      'an invalid manifest',
      { manifest: { ...manifest, versionCode: 0 } },
      'MANIFEST_INVALID',
    ],
    [
      'an asset URL outside the repository',
      {
        manifest: {
          ...manifest,
          android: { ...manifest.android, url: 'https://example.test/app.apk' },
        },
      },
      'MANIFEST_INVALID',
    ],
    [
      'an asset size mismatch',
      {
        manifest: {
          ...manifest,
          android: { ...manifest.android, size: size + 1 },
        },
      },
      'MANIFEST_INVALID',
    ],
    [
      'a digest that is not a SHA-256',
      {
        manifest: {
          ...manifest,
          android: { ...manifest.android, sha256: 'not-a-digest' },
        },
      },
      'MANIFEST_INVALID',
    ],
    [
      'an APK asset name that does not match the version',
      (() => {
        const otherName = 'personal-hub-0.1.0+other.apk';
        const otherUrl = `https://github.com/${appUpdateRepository}/releases/download/${tag}/${otherName}`;
        return {
          release: {
            ...release,
            assets: [
              release.assets[0],
              {
                name: otherName,
                browser_download_url: otherUrl,
                size,
              },
            ],
          },
          manifest: {
            ...manifest,
            android: { ...manifest.android, url: otherUrl },
          },
        };
      })(),
      'MANIFEST_INVALID',
    ],
    [
      'oversized release notes',
      { manifest: { ...manifest, notes: 'x'.repeat(4001) } },
      'MANIFEST_INVALID',
    ],
    [
      'a beta channel manifest',
      { manifest: { ...manifest, channel: 'beta' } },
      'MANIFEST_INVALID',
    ],
    [
      'a release with no stable build',
      { release: { ...release, prerelease: true } },
      'RELEASE_NOT_FOUND',
    ],
    ['a GitHub rate limit', { releaseStatus: 403 }, 'GITHUB_RATE_LIMITED'],
    ['a missing release', { releaseStatus: 404 }, 'RELEASE_NOT_FOUND'],
  ])('degrades clearly for %s', async (_, options, reason) => {
    const { fetcher } = fakeGithub(options as Parameters<typeof fakeGithub>[0]);
    const service = createAppUpdateService({ fetcher });
    const result = await service.check(1);
    expect(result.state).toBe('unavailable');
    expect(result.latest).toBeNull();
    expect(result.reason).toBe(reason);
  });

  it('sends GITHUB_TOKEN only to the API request, never to the asset download', async () => {
    const { fetcher, calls } = fakeGithub();
    const service = createAppUpdateService({
      fetcher,
      token: 'synthetic-github-token',
    });
    const result = await service.check(1);
    expect(calls[0]?.headers.Authorization).toBe(
      'Bearer synthetic-github-token',
    );
    expect(calls[1]?.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('synthetic-github-token');
  });
});

describe('app update endpoint', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let cookie = '';
  beforeAll(async () => {
    ({ app, cookie } = await createEnrolledApp(fakeGithub().fetcher));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('requires the owner session', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/api/v1/app/update?platform=android&versionCode=254',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the owner-scoped update state with no-store caching', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: '/api/v1/app/update?platform=android&versionCode=254',
      headers: { origin, cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const data = appUpdateResponseSchema.parse(response.json());
    expect(data.state).toBe('update-available');
    expect(data.latest?.android).toMatchObject({
      url: assetUrl,
      sha256: digest,
      size,
    });
  });

  it('rejects unsupported platforms and invalid version codes', async () => {
    for (const url of [
      '/api/v1/app/update?platform=ios&versionCode=1',
      '/api/v1/app/update?platform=android',
      '/api/v1/app/update?platform=android&versionCode=-1',
      `/api/v1/app/update?platform=android&versionCode=1&extra=${randomUUID()}`,
    ]) {
      const response = await app!.inject({
        method: 'GET',
        url,
        headers: { origin, cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_INPUT');
    }
  });
});
