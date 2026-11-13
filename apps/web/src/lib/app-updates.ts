import type { AppUpdateResponse } from '@hub/contracts';

export type UpdateDecision = 'update-available' | 'current' | 'unavailable';

/**
 * The server already compares version codes, but the client repeats the
 * comparison: a stale or malformed response can never offer a downgrade.
 */
export function resolveUpdateDecision(
  response: Pick<AppUpdateResponse, 'state' | 'latest'>,
  installedVersionCode: number | null,
): UpdateDecision {
  if (response.state === 'unavailable' || !response.latest)
    return 'unavailable';
  // On the website the installed Android build is unknown. The server state
  // can be shown, but there is no install action to misuse.
  if (installedVersionCode === null) return response.state;
  return response.latest.versionCode > installedVersionCode
    ? 'update-available'
    : 'current';
}

export function versionCodeFromBuild(value: string | undefined) {
  if (!value || !/^\d{1,10}$/.test(value)) return null;
  const code = Number(value);
  return Number.isSafeInteger(code) && code >= 0 ? code : null;
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function updateUnavailableText(reason: string | null) {
  switch (reason) {
    case 'RELEASE_NOT_FOUND':
      return 'No stable release is published yet.';
    case 'MANIFEST_MISSING':
    case 'MANIFEST_INVALID':
      return 'The latest release has no usable update manifest. Nothing was installed.';
    case 'ANDROID_ASSET_MISSING':
      return 'The latest release has no Android build.';
    case 'GITHUB_RATE_LIMITED':
      return 'GitHub limited the update check. Try again later.';
    case 'GITHUB_UNAVAILABLE':
    default:
      return 'GitHub could not be reached. Try again later.';
  }
}
