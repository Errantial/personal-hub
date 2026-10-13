// Date-only values (task due dates) are calendar days, not instants:
// format in UTC so the day never shifts with the device timezone.
const dateOnly = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Fri, Oct 9, 2026" for a YYYY-MM-DD value. */
export const formatDate = (date: string) => dateOnly.format(new Date(date));

/**
 * Short, readable date and time for a stored instant, in the device's
 * timezone: "Oct 12, 6:52 PM", with the year only when it is not the current
 * one. Replaces the long numeric `toLocaleString()` output (10/12/2026,
 * 6:52:38 PM), which buried the part people scan for.
 */
export function formatInstant(
  value: string | number | Date,
  now: Date = new Date(),
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}
