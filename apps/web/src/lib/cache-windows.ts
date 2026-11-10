/* Dated reads are cached per window: a day on Today, a week or month in
   Calendar. Without a limit the offline store gains an entry for every day
   and every visited range. These rules keep only windows a view can still
   ask for; they never touch undated lists or queued changes. */

/** A past calendar window stays readable offline this long after it ends. */
export const pastWindowDays = 35;

const calendarWindow =
  /^\/api\/v1\/(?:calendar\/occurrences|connections\/canvas\/calendar)\?/;
const deadlineList = /^\/api\/v1\/deadlines\?/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

const range = (path: string) => {
  const query = new URL(path, 'http://local').searchParams;
  const from = query.get('from');
  const to = query.get('to');
  return from && to && dateOnly.test(from) && dateOnly.test(to)
    ? { from, to }
    : null;
};
/** Today's imported-deadline read: a deadline list limited to a date range. */
const deadlineWindow = (path: string) =>
  deadlineList.test(path) && range(path) !== null;

/** Whether saving this path can make other cached windows obsolete. */
export const isCachedWindow = (path: string) =>
  calendarWindow.test(path) || deadlineWindow(path);

/**
 * Cached paths to drop after `saved` was stored at `now`: calendar and Canvas
 * windows that ended more than `pastWindowDays` ago, and every earlier
 * imported-deadline window once a newer one is saved (each day asks for a
 * different range, so an older one is never read again).
 */
export function staleWindows(
  paths: readonly string[],
  saved: string,
  now: Date,
): string[] {
  const cutoff = new Date(now.getTime() - pastWindowDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const supersedes = deadlineWindow(saved);
  return paths.filter((path) => {
    if (path === saved) return false;
    if (calendarWindow.test(path)) {
      const window = range(path);
      return window !== null && window.to < cutoff;
    }
    return supersedes && deadlineWindow(path);
  });
}
