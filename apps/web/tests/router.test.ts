import { expect, it } from 'vitest';
import { parseRoute, routePath, routeTitle } from '../src/lib/router';

it('maps every view to a stable path and back', () => {
  for (const name of [
    'today',
    'calendar',
    'classes',
    'reminders',
    'connections',
    'preferences',
  ] as const) {
    const path = routePath({ name });
    expect(path).toBe(`/${name}`);
    expect(parseRoute(path, '')).toEqual({ name });
  }
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
  expect(routeTitle({ name: 'reminders' })).toBe('Reminders · Personal Hub');
});
