import { expect, it } from 'vitest';
import {
  formatBytes,
  resolveUpdateDecision,
  updateUnavailableText,
  versionCodeFromBuild,
} from '../src/lib/app-updates';

const latest = {
  versionName: '0.1.0+abc1234',
  versionCode: 300,
  channel: 'stable' as const,
  notes: 'Synthetic notes.',
  android: null,
  desktop: [],
};

it('offers an update only when the release version code is newer', () => {
  expect(
    resolveUpdateDecision({ state: 'update-available', latest }, 299),
  ).toBe('update-available');
  expect(
    resolveUpdateDecision({ state: 'update-available', latest }, 300),
  ).toBe('current');
  expect(
    resolveUpdateDecision({ state: 'update-available', latest }, 301),
  ).toBe('current');
});

it('never offers a downgrade when the server state disagrees with the codes', () => {
  expect(resolveUpdateDecision({ state: 'current', latest }, 299)).toBe(
    'update-available',
  );
  expect(
    resolveUpdateDecision(
      {
        state: 'update-available',
        latest: { ...latest, versionCode: 254 },
      },
      300,
    ),
  ).toBe('current');
});

it('treats an unavailable or empty response as unavailable', () => {
  expect(resolveUpdateDecision({ state: 'unavailable', latest: null }, 1)).toBe(
    'unavailable',
  );
  expect(resolveUpdateDecision({ state: 'current', latest: null }, 1)).toBe(
    'unavailable',
  );
});

it('uses the server state when no installed Android build is known', () => {
  expect(
    resolveUpdateDecision({ state: 'update-available', latest }, null),
  ).toBe('update-available');
  expect(resolveUpdateDecision({ state: 'current', latest }, null)).toBe(
    'current',
  );
});

it('reads a bounded build version code from the Android build', () => {
  expect(versionCodeFromBuild('300')).toBe(300);
  expect(versionCodeFromBuild('0')).toBe(0);
  expect(versionCodeFromBuild('')).toBeNull();
  expect(versionCodeFromBuild('abc')).toBeNull();
  expect(versionCodeFromBuild('-2')).toBeNull();
  expect(versionCodeFromBuild('1.5')).toBeNull();
  expect(versionCodeFromBuild('99999999999')).toBeNull();
});

it('formats bounded asset sizes for the release summary', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(4096)).toBe('4 KB');
  expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
});

it('explains every unavailable update check without claiming an install', () => {
  expect(updateUnavailableText('RELEASE_NOT_FOUND')).toContain(
    'No stable release',
  );
  expect(updateUnavailableText('MANIFEST_INVALID')).toContain(
    'Nothing was installed',
  );
  expect(updateUnavailableText('ANDROID_ASSET_MISSING')).toContain(
    'no Android build',
  );
  expect(updateUnavailableText('GITHUB_RATE_LIMITED')).toContain('limited');
  expect(updateUnavailableText('GITHUB_UNAVAILABLE')).toContain(
    'could not be reached',
  );
  expect(updateUnavailableText(null)).toContain('could not be reached');
});
