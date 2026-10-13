import { lazy } from 'react';

/* Views load on demand. preloadViews fetches them once the
   workspace is ready, so the service worker has them for offline use even
   before the owner opens each view. */
const loaders = {
  today: () => import('../components/TodayView'),
  tasks: () => import('../components/TasksView'),
  calendar: () => import('../components/CalendarView'),
  classes: () => import('../components/ClassesView'),
  inbox: () => import('../components/InboxView'),
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
export const ClassesView = lazy(() =>
  loaders.classes().then((module) => ({ default: module.ClassesView })),
);
export const InboxView = lazy(() =>
  loaders.inbox().then((module) => ({ default: module.InboxView })),
);
export const SettingsView = lazy(() =>
  loaders.settings().then((module) => ({ default: module.SettingsView })),
);

/** Loads every view module (and its imports); resolves when all settle. */
export const loadViews = () =>
  Promise.allSettled(Object.values(loaders).map((load) => load()));

export function preloadViews() {
  const run = () => void loadViews();
  if ('requestIdleCallback' in window) window.requestIdleCallback(run);
  else setTimeout(run, 1000);
}
