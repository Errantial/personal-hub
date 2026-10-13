import { useCallback, useEffect, useState } from 'react';

/* URL routing over the History API. Pure parse/format functions are unit
   tested; useRoute keeps React state in sync with the address bar. */

export const views = [
  'today',
  'calendar',
  'tasks',
  'classes',
  'inbox',
  'settings',
] as const;
export type View = (typeof views)[number];
export const settingsSections = [
  'account',
  'appearance',
  'study',
  'connections',
  'ai',
  'memory',
] as const;
export type SettingsSection = (typeof settingsSections)[number];
export const canvasTabs = ['feed', 'api', 'matching'] as const;
export type CanvasTab = (typeof canvasTabs)[number];
export const canvasTabLabels: Record<CanvasTab, string> = {
  feed: 'Calendar feed',
  api: 'Canvas API',
  matching: 'Matching',
};
export const taskFilters = [
  'open',
  'due-soon',
  'overdue',
  'no-date',
  'done',
] as const;
export type TaskFilter = (typeof taskFilters)[number];
export const taskFilterLabels: Record<TaskFilter, string> = {
  open: 'Open',
  'due-soon': 'Due soon',
  overdue: 'Overdue',
  'no-date': 'No date',
  done: 'Done',
};
export const calendarViews = ['agenda', 'week', 'day'] as const;
export type CalendarView = (typeof calendarViews)[number];
/** What the calendar editor is open on: a new event, a whole event/series,
 *  or one occurrence of a repeating event (by its original date). */
export type CalendarEditorRoute =
  | { kind: 'new' }
  | { kind: 'event'; id: string }
  | { kind: 'occurrence'; id: string; date: string };
export const classSections = [
  'topics',
  'work',
  'study',
  'canvas',
  'details',
] as const;
export type ClassSection = (typeof classSections)[number];
export const classSectionLabels: Record<ClassSection, string> = {
  topics: 'Topics',
  work: 'Work',
  study: 'Study blocks',
  canvas: 'Canvas',
  details: 'Details',
};
export type Route =
  | {
      name: Exclude<
        View,
        'calendar' | 'settings' | 'tasks' | 'classes' | 'inbox'
      >;
    }
  | {
      name: 'inbox';
      /** Notifications are the default; reminders have their own address. */
      section?: 'reminders';
      /** A reminder's editor: `'new'` or a reminder id. */
      reminder?: string;
    }
  | {
      name: 'classes';
      /** A class, `'new'` for the add-class form or `'plan'` for the study plan. */
      id?: string;
      section?: ClassSection;
    }
  | { name: 'tasks'; id?: string; filter?: TaskFilter }
  | {
      name: 'calendar';
      date?: string;
      view?: CalendarView;
      editor?: CalendarEditorRoute;
    }
  | {
      name: 'settings';
      section: SettingsSection;
      /** A provider's detail page under Connections. */
      connection?: 'canvas';
      tab?: CanvasTab;
    };

export const viewLabels: Record<View, string> = {
  today: 'Today',
  calendar: 'Calendar',
  tasks: 'Tasks',
  classes: 'Classes',
  inbox: 'Inbox',
  settings: 'Settings',
};
export const sectionLabels: Record<SettingsSection, string> = {
  account: 'Account',
  appearance: 'Appearance',
  study: 'Study',
  connections: 'Connections',
  ai: 'AI',
  memory: 'Memory',
};

/** Addresses used before the confirmed navigation (D46) keep working. */
const aliases: Record<string, Route> = {
  preferences: { name: 'settings', section: 'account' },
  connections: { name: 'settings', section: 'connections' },
  reminders: { name: 'inbox' },
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

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const isClassSection = (value: string | null): value is ClassSection =>
  (classSections as readonly (string | null)[]).includes(value);
const isCanvasTab = (value: string | null): value is CanvasTab =>
  (canvasTabs as readonly (string | null)[]).includes(value);
const isTaskFilter = (value: string | null): value is TaskFilter =>
  (taskFilters as readonly (string | null)[]).includes(value);

export function parseRoute(pathname: string, search: string): Route {
  const [segment = '', detail = '', extra = '', occurrence = ''] = pathname
    .replace(/^\/+|\/+$/g, '')
    .split('/');
  const alias = aliases[segment];
  if (alias) return alias;
  const name = (views as readonly string[]).includes(segment)
    ? (segment as View)
    : 'today';
  const query = new URLSearchParams(search);
  if (name === 'settings') {
    const section = (settingsSections as readonly string[]).includes(detail)
      ? (detail as SettingsSection)
      : 'account';
    const tab = query.get('tab');
    if (section === 'connections' && extra === 'canvas')
      return {
        name,
        section,
        connection: 'canvas',
        ...(isCanvasTab(tab) && tab !== 'feed' ? { tab } : {}),
      };
    return { name, section };
  }
  if (name === 'tasks') {
    const filter = query.get('filter');
    return {
      name,
      ...(isUuid(detail) ? { id: detail } : {}),
      ...(isTaskFilter(filter) ? { filter } : {}),
    };
  }
  if (name === 'classes') {
    const section = query.get('section');
    return {
      name,
      ...(detail === 'new' || detail === 'plan' || isUuid(detail)
        ? { id: detail }
        : {}),
      ...(isClassSection(section) && section !== 'topics' ? { section } : {}),
    };
  }
  if (name === 'inbox' && detail === 'reminders')
    return {
      name,
      section: 'reminders',
      ...(extra === 'new' || isUuid(extra) ? { reminder: extra } : {}),
    };
  if (name !== 'calendar') return { name };
  const date = query.get('date');
  const view = query.get('view');
  const editor: CalendarEditorRoute | null =
    detail === 'new'
      ? { kind: 'new' }
      : isUuid(detail)
        ? extra === 'occurrence' && isDate(occurrence)
          ? { kind: 'occurrence', id: detail, date: occurrence }
          : { kind: 'event', id: detail }
        : null;
  return {
    name,
    ...(isDate(date) ? { date } : {}),
    ...((calendarViews as readonly (string | null)[]).includes(view)
      ? { view: view as CalendarView }
      : {}),
    ...(editor ? { editor } : {}),
  };
}

export function routePath(route: Route): string {
  if (route.name === 'settings')
    return `/settings/${route.section}${
      route.connection
        ? `/${route.connection}${
            route.tab && route.tab !== 'feed' ? `?tab=${route.tab}` : ''
          }`
        : ''
    }`;
  if (route.name === 'tasks')
    return `/tasks${route.id ? `/${route.id}` : ''}${
      route.filter && route.filter !== 'open' ? `?filter=${route.filter}` : ''
    }`;
  if (route.name === 'classes')
    return `/classes${route.id ? `/${route.id}` : ''}${
      route.section && route.section !== 'topics'
        ? `?section=${route.section}`
        : ''
    }`;
  if (route.name === 'inbox')
    return route.section
      ? `/inbox/reminders${route.reminder ? `/${route.reminder}` : ''}`
      : '/inbox';
  if (route.name !== 'calendar') return `/${route.name}`;
  const query = new URLSearchParams();
  if (route.date) query.set('date', route.date);
  if (route.view && route.view !== 'agenda') query.set('view', route.view);
  const search = query.toString();
  const editor = route.editor;
  const detail = !editor
    ? ''
    : editor.kind === 'new'
      ? '/new'
      : editor.kind === 'event'
        ? `/${editor.id}`
        : `/${editor.id}/occurrence/${editor.date}`;
  return `/calendar${detail}${search ? `?${search}` : ''}`;
}

export const routeTitle = (route: Route) =>
  route.name === 'settings'
    ? `${sectionLabels[route.section]} · Settings · Personal Hub`
    : `${viewLabels[route.name]} · Personal Hub`;

const current = () =>
  parseRoute(window.location.pathname, window.location.search);

/** Current route plus a navigate function; browser/Android Back restores views. */
export function useRoute() {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    // Keep the same object when nothing changed, so effects keyed on the
    // route (focus, title) do not re-run.
    const sync = () =>
      setRoute((previous) => {
        const next = current();
        return routePath(next) === routePath(previous) ? previous : next;
      });
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
    setRoute((previous) => (routePath(previous) === path ? previous : next));
  }, []);
  return [route, navigate] as const;
}
