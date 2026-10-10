import { expect, it } from 'vitest';
import { nativeApiUrl } from '../src/lib/transport';

it('keeps native requests on the selected HTTPS API and permits query paths', () => {
  expect(
    nativeApiUrl(
      'https://hub.example.test',
      '/api/v1/calendar/occurrences?start=2026-10-10&end=2026-10-11',
      false,
    ),
  ).toBe(
    'https://hub.example.test/api/v1/calendar/occurrences?start=2026-10-10&end=2026-10-11',
  );
});

it('rejects insecure servers, credentials, redirects and traversal outside /api', () => {
  for (const origin of [
    'http://hub.example.test',
    'https://user:pass@hub.example.test',
    'https://hub.example.test/base',
    'https://hub.example.test?token=secret',
  ])
    expect(() => nativeApiUrl(origin, '/api/health', false)).toThrow();
  for (const path of [
    '//attacker.test/api/health',
    'https://attacker.test/api/health',
    '/api/../private',
    '/api/%2e%2e/private',
  ])
    expect(() =>
      nativeApiUrl('https://hub.example.test', path, false),
    ).toThrow();
  expect(() =>
    nativeApiUrl('http://127.0.0.1:3011', '/api/health', false),
  ).toThrow();
  expect(nativeApiUrl('http://127.0.0.1:3011', '/api/health', true)).toBe(
    'http://127.0.0.1:3011/api/health',
  );
  expect(() =>
    nativeApiUrl('http://10.0.2.2:3011', '/api/health', true),
  ).toThrow();
});
