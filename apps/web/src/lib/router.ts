import { useCallback, useEffect, useState } from 'react';

/* URL routing over the History API. Pure parse/format functions are unit
   tested; useRoute keeps React state in sync with the address bar. */

export const views = [
  'today',
  'calendar',
  'classes',
  'reminders',
  'connections',
  'preferences',
] as const;
export type View = (typeof views)[number];
export type Route =
  | { name: Exclude<View, 'calendar'> }
  | { name: 'calendar'; date?: string; view?: 'day' | 'week' };

export const viewLabels: Record<View, string> = {
  today: 'Today',
  calendar: 'Calendar',
  classes: 'Classes',
  reminders: 'Reminders',
  connections: 'Connections',
  preferences: 'Preferences',
};

function isDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseRoute(pathname: string, search: string): Route {
  const segment = pathname.replace(/^\/+|\/+$/g, '');
  const name = (views as readonly string[]).includes(segment)
    ? (segment as View)
    : 'today';
  if (name !== 'calendar') return { name };
  const query = new URLSearchParams(search);
  const date = query.get('date');
  const view = query.get('view');
  return {
    name,
    ...(isDate(date) ? { date } : {}),
    ...(view === 'day' || view === 'week' ? { view } : {}),
  };
}

export function routePath(route: Route): string {
  if (route.name !== 'calendar') return `/${route.name}`;
  const query = new URLSearchParams();
  if (route.date) query.set('date', route.date);
  if (route.view) query.set('view', route.view);
  const search = query.toString();
  return `/calendar${search ? `?${search}` : ''}`;
}

export const routeTitle = (route: Route) =>
  `${viewLabels[route.name]} · Personal Hub`;

const current = () =>
  parseRoute(window.location.pathname, window.location.search);

/** Current route plus a navigate function; browser/Android Back restores views. */
export function useRoute() {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const sync = () => setRoute(current());
    window.addEventListener('popstate', sync);
    // A Back/Forward between first render and this effect fires popstate
    // before the listener exists; re-read the address bar to catch it.
    sync();
    // Canonicalize the root or unknown paths without adding history entries.
    const canonical = routePath(current());
    if (window.location.pathname + window.location.search !== canonical)
      window.history.replaceState(null, '', canonical);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => {
    document.title = routeTitle(route);
  }, [route]);
  const navigate = useCallback((next: Route, replace = false) => {
    const path = routePath(next);
    if (window.location.pathname + window.location.search !== path)
      window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setRoute(next);
  }, []);
  return [route, navigate] as const;
}
