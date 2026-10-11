import { expect, it } from 'vitest';
import { parseRoute, routePath, routeTitle } from '../src/lib/router';

it('maps every primary view to a stable path and back', () => {
  for (const name of [
    'today',
    'calendar',
    'tasks',
    'classes',
    'inbox',
  ] as const) {
    const path = routePath({ name });
    expect(path).toBe(`/${name}`);
    expect(parseRoute(path, '')).toEqual({ name });
  }
});

it('addresses each settings section and defaults to Account', () => {
  for (const section of [
    'account',
    'appearance',
    'connections',
    'ai',
  ] as const) {
    expect(routePath({ name: 'settings', section })).toBe(
      `/settings/${section}`,
    );
    expect(parseRoute(`/settings/${section}`, '')).toEqual({
      name: 'settings',
      section,
    });
  }
  expect(parseRoute('/settings', '')).toEqual({
    name: 'settings',
    section: 'account',
  });
  expect(parseRoute('/settings/unknown', '')).toEqual({
    name: 'settings',
    section: 'account',
  });
});

it('redirects addresses from before the navigation change', () => {
  expect(parseRoute('/preferences', '')).toEqual({
    name: 'settings',
    section: 'account',
  });
  expect(parseRoute('/connections', '')).toEqual({
    name: 'settings',
    section: 'connections',
  });
  expect(parseRoute('/reminders', '')).toEqual({ name: 'inbox' });
});

it('treats the root, unknown paths and trailing slashes predictably', () => {
  expect(parseRoute('/', '')).toEqual({ name: 'today' });
  expect(parseRoute('/index.html', '')).toEqual({ name: 'today' });
  expect(parseRoute('/nope', '')).toEqual({ name: 'today' });
  expect(parseRoute('/calendar/', '')).toEqual({ name: 'calendar' });
  expect(parseRoute('/CALENDAR', '')).toEqual({ name: 'today' });
});

it('keeps only valid calendar date and view parameters', () => {
  expect(parseRoute('/calendar', '?date=2026-10-10&view=day')).toEqual({
    name: 'calendar',
    date: '2026-10-10',
    view: 'day',
  });
  expect(parseRoute('/calendar', '?date=2026-13-40&view=month')).toEqual({
    name: 'calendar',
  });
  expect(
    routePath({ name: 'calendar', date: '2026-10-10', view: 'week' }),
  ).toBe('/calendar?date=2026-10-10&view=week');
  expect(parseRoute('/today', '?date=2026-10-10')).toEqual({ name: 'today' });
});

it('provides a document title per route', () => {
  expect(routeTitle({ name: 'inbox' })).toBe('Inbox · Personal Hub');
  expect(routeTitle({ name: 'settings', section: 'ai' })).toBe(
    'AI · Settings · Personal Hub',
  );
});
