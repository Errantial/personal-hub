import { lazy } from 'react';

/* Views load on demand. preloadViews fetches them once the
   workspace is ready, so the service worker has them for offline use even
   before the owner opens each view. */
const loaders = {
  today: () => import('../components/TodayView'),
  tasks: () => import('../components/TasksView'),
  calendar: () => import('../components/CalendarView'),
  classes: () => import('../components/AcademicWorkspace'),
  inbox: () => import('../components/ReminderWorkspace'),
  settings: () => import('./SettingsView'),
};

export const TodayView = lazy(() =>
  loaders.today().then((module) => ({ default: module.TodayView })),
);

export const TasksView = lazy(() =>
  loaders.tasks().then((module) => ({ default: module.TasksView })),
);

export const CalendarView = lazy(() =>
  loaders.calendar().then((module) => ({ default: module.CalendarView })),
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
