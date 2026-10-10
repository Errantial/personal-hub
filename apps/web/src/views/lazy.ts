import { lazy } from 'react';

/* Views outside Today load on demand. preloadViews fetches them once the
   workspace is ready, so the service worker has them for offline use even
   before the owner opens each view. */
const loaders = {
  calendar: () => import('../components/CalendarWorkspace'),
  classes: () => import('../components/AcademicWorkspace'),
  reminders: () => import('../components/ReminderWorkspace'),
  connections: () => import('./ConnectionsView'),
  preferences: () => import('./PreferencesView'),
};

export const CalendarWorkspace = lazy(() =>
  loaders.calendar().then((module) => ({ default: module.CalendarWorkspace })),
);
export const AcademicWorkspace = lazy(() =>
  loaders.classes().then((module) => ({ default: module.AcademicWorkspace })),
);
export const ReminderWorkspace = lazy(() =>
  loaders.reminders().then((module) => ({ default: module.ReminderWorkspace })),
);
export const ConnectionsView = lazy(() =>
  loaders.connections().then((module) => ({ default: module.ConnectionsView })),
);
export const PreferencesView = lazy(() =>
  loaders.preferences().then((module) => ({ default: module.PreferencesView })),
);

export function preloadViews() {
  const run = () => {
    for (const load of Object.values(loaders))
      void load().catch(() => undefined);
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run);
  else setTimeout(run, 1000);
}
