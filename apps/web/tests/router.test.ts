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
    'study',
    'connections',
    'ai',
    'memory',
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
  expect(parseRoute('/calendar', '?date=2026-13-40&view=year')).toEqual({
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

it('addresses a task and its list filter', () => {
  const id = '3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b';
  expect(routePath({ name: 'tasks', id })).toBe(`/tasks/${id}`);
  expect(parseRoute(`/tasks/${id}`, '')).toEqual({ name: 'tasks', id });
  expect(routePath({ name: 'tasks', filter: 'overdue' })).toBe(
    '/tasks?filter=overdue',
  );
  expect(parseRoute('/tasks', '?filter=no-date')).toEqual({
    name: 'tasks',
    filter: 'no-date',
  });
  // The default filter has no query; unknown filters and ids are ignored.
  expect(routePath({ name: 'tasks', filter: 'open' })).toBe('/tasks');
  expect(parseRoute('/tasks/not-an-id', '?filter=nope')).toEqual({
    name: 'tasks',
  });
});

it('addresses a class, its section and the add-class form', () => {
  const id = '3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b';
  expect(routePath({ name: 'classes', id })).toBe(`/classes/${id}`);
  expect(routePath({ name: 'classes', id, section: 'study' })).toBe(
    `/classes/${id}?section=study`,
  );
  expect(parseRoute(`/classes/${id}`, '?section=canvas')).toEqual({
    name: 'classes',
    id,
    section: 'canvas',
  });
  expect(parseRoute('/classes/plan', '')).toEqual({
    name: 'classes',
    id: 'plan',
  });
  expect(parseRoute('/classes/new', '')).toEqual({
    name: 'classes',
    id: 'new',
  });
  // The default section has no query; unknown ids and sections are ignored.
  expect(routePath({ name: 'classes', id, section: 'topics' })).toBe(
    `/classes/${id}`,
  );
  expect(parseRoute('/classes/nope', '?section=nope')).toEqual({
    name: 'classes',
  });
});

it('addresses imported mail inside the inbox', () => {
  const id = '00000000-0000-4000-8000-000000000004';
  expect(routePath({ name: 'inbox', section: 'mail', mail: id })).toBe(
    `/inbox/mail/${id}`,
  );
  expect(parseRoute('/inbox/mail', '')).toEqual({
    name: 'inbox',
    section: 'mail',
  });
  expect(parseRoute('/inbox/mail/nope', '')).toEqual({
    name: 'inbox',
    section: 'mail',
  });
});

it('addresses email drafts inside the inbox', () => {
  const id = '00000000-0000-4000-8000-000000000003';
  expect(routePath({ name: 'inbox', section: 'drafts' })).toBe('/inbox/drafts');
  expect(routePath({ name: 'inbox', section: 'drafts', draft: id })).toBe(
    `/inbox/drafts/${id}`,
  );
  expect(parseRoute('/inbox/drafts/new', '')).toEqual({
    name: 'inbox',
    section: 'drafts',
    draft: 'new',
  });
  expect(parseRoute('/inbox/drafts/nope', '')).toEqual({
    name: 'inbox',
    section: 'drafts',
  });
});

it('addresses reminders and their editor inside the inbox', () => {
  const id = '3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b';
  expect(routePath({ name: 'inbox' })).toBe('/inbox');
  expect(routePath({ name: 'inbox', section: 'reminders' })).toBe(
    '/inbox/reminders',
  );
  expect(
    routePath({ name: 'inbox', section: 'reminders', reminder: 'new' }),
  ).toBe('/inbox/reminders/new');
  expect(parseRoute(`/inbox/reminders/${id}`, '')).toEqual({
    name: 'inbox',
    section: 'reminders',
    reminder: id,
  });
  expect(parseRoute('/inbox/reminders/nope', '')).toEqual({
    name: 'inbox',
    section: 'reminders',
  });
  // The old address still opens the inbox.
  expect(parseRoute('/reminders', '')).toEqual({ name: 'inbox' });
});

it('addresses the Canvas connection and its tabs', () => {
  expect(routePath({ name: 'settings', section: 'connections' })).toBe(
    '/settings/connections',
  );
  expect(
    routePath({
      name: 'settings',
      section: 'connections',
      connection: 'canvas',
    }),
  ).toBe('/settings/connections/canvas');
  expect(
    routePath({
      name: 'settings',
      section: 'connections',
      connection: 'canvas',
      tab: 'matching',
    }),
  ).toBe('/settings/connections/canvas?tab=matching');
  expect(parseRoute('/settings/connections/canvas', '?tab=api')).toEqual({
    name: 'settings',
    section: 'connections',
    connection: 'canvas',
    tab: 'api',
  });
  // The default tab has no query; unknown providers and tabs are ignored.
  expect(parseRoute('/settings/connections/canvas', '?tab=nope')).toEqual({
    name: 'settings',
    section: 'connections',
    connection: 'canvas',
  });
  expect(parseRoute('/settings/connections/other', '')).toEqual({
    name: 'settings',
    section: 'connections',
  });
});

it('addresses the calendar editor and keeps the visible window', () => {
  const id = '3f2b8c1e-5a47-4d0e-9b3a-1c2d3e4f5a6b';
  const cases = [
    [{ kind: 'new' }, '/calendar/new'],
    [{ kind: 'event', id }, `/calendar/${id}`],
    [
      { kind: 'occurrence', id, date: '2027-03-08' },
      `/calendar/${id}/occurrence/2027-03-08`,
    ],
  ] as const;
  for (const [editor, path] of cases) {
    expect(routePath({ name: 'calendar', editor })).toBe(path);
    expect(parseRoute(path, '')).toEqual({ name: 'calendar', editor });
  }
  expect(
    routePath({
      name: 'calendar',
      date: '2027-03-08',
      view: 'week',
      editor: { kind: 'new' },
    }),
  ).toBe('/calendar/new?date=2027-03-08&view=week');
  // Week is the default when no view is written; a chosen view is explicit.
  expect(parseRoute('/calendar', '')).toEqual({ name: 'calendar' });
  expect(routePath({ name: 'calendar', view: 'agenda' })).toBe(
    '/calendar?view=agenda',
  );
  expect(parseRoute('/calendar', '?view=agenda')).toEqual({
    name: 'calendar',
    view: 'agenda',
  });
  // Unknown ids and malformed occurrence dates fall back to the list.
  expect(parseRoute('/calendar/not-an-id', '')).toEqual({ name: 'calendar' });
  expect(parseRoute(`/calendar/${id}/occurrence/2027-02-31`, '')).toEqual({
    name: 'calendar',
    editor: { kind: 'event', id },
  });
});

it('routes month view and a new event at a start time', () => {
  expect(parseRoute('/calendar', '?view=month&date=2026-10-14')).toEqual({
    name: 'calendar',
    date: '2026-10-14',
    view: 'month',
  });
  const editor = { kind: 'new', start: '2026-10-14T13:00' } as const;
  expect(routePath({ name: 'calendar', editor })).toBe(
    '/calendar/new?start=2026-10-14T13%3A00',
  );
  expect(parseRoute('/calendar/new', '?start=2026-10-14T13:00')).toEqual({
    name: 'calendar',
    editor,
  });
  expect(parseRoute('/calendar/new', '?start=tomorrow')).toEqual({
    name: 'calendar',
    editor: { kind: 'new' },
  });
});
