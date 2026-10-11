import { lazy } from 'react';

/* Views outside Today load on demand. preloadViews fetches them once the
   workspace is ready, so the service worker has them for offline use even
   before the owner opens each view. */
const loaders = {
  calendar: () => import('../components/CalendarWorkspace'),
  classes: () => import('../components/AcademicWorkspace'),
  inbox: () => import('../components/ReminderWorkspace'),
  settings: () => import('./SettingsView'),
};

export const CalendarWorkspace = lazy(() =>
  loaders.calendar().then((module) => ({ default: module.CalendarWorkspace })),
);
export const AcademicWorkspace = lazy(() =>
  loaders.classes().then((module) => ({ default: module.AcademicWorkspace })),
);
export const ReminderWorkspace = lazy(() =>
  loaders.inbox().then((module) => ({ default: module.ReminderWorkspace })),
);
export const SettingsView = lazy(() =>
  loaders.settings().then((module) => ({ default: module.SettingsView })),
);

export function preloadViews() {
  const run = () => {
    for (const load of Object.values(loaders))
      void load().catch(() => undefined);
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run);
  else setTimeout(run, 1000);
}
