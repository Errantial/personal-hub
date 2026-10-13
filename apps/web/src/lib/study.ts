import { Temporal } from '@hub/contracts';
import type { StudyPreferences, StudyPreview, StudySlot } from '@hub/contracts';

/* Study planning helpers. Availability windows use ISO weekdays (1 = Monday)
   and minutes from local midnight; an end of 1440 means the next midnight. */

export const weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export type Window = StudyPreferences['windows'][number];

/** "09:30" for 570 minutes; 1440 is shown as "00:00" (next midnight). */
export function timeOfMinutes(minutes: number) {
  const value = minutes % 1440;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

/** Minutes from midnight for "HH:MM", or null when empty or malformed. */
export function minutesOfTime(time: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

export type WindowDraft = { day: number; start: string; end: string };

/**
 * Converts editable rows to windows. An end of 00:00 means midnight at the
 * end of the day. Returns the windows, or the first problem to show.
 */
export function windowsOf(
  rows: readonly WindowDraft[],
): { windows: Window[] } | { error: string; index: number } {
  const windows: Window[] = [];
  for (const [index, row] of rows.entries()) {
    const startMinute = minutesOfTime(row.start);
    const end = minutesOfTime(row.end);
    if (startMinute === null || end === null)
      return { error: 'Enter a start and end time', index };
    const endMinute = end === 0 ? 1440 : end;
    if (endMinute <= startMinute)
      return { error: 'End after the start time', index };
    windows.push({ day: row.day, startMinute, endMinute });
  }
  const sorted = windows
    .map((window, index) => ({ window, index }))
    .sort(
      (a, b) =>
        a.window.day - b.window.day ||
        a.window.startMinute - b.window.startMinute,
    );
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!.window;
    const current = sorted[i]!;
    if (
      current.window.day === previous.day &&
      current.window.startMinute < previous.endMinute
    )
      return {
        error: 'Overlaps another window that day',
        index: current.index,
      };
  }
  return { windows };
}

export const windowDrafts = (windows: readonly Window[]): WindowDraft[] =>
  [...windows]
    .sort((a, b) => a.day - b.day || a.startMinute - b.startMinute)
    .map((window) => ({
      day: window.day,
      start: timeOfMinutes(window.startMinute),
      end: timeOfMinutes(window.endMinute),
    }));

/** Total weekly availability in minutes. */
export const weeklyMinutes = (windows: readonly Window[]) =>
  windows.reduce(
    (sum, window) => sum + window.endMinute - window.startMinute,
    0,
  );

/* Study plans: previews, drafts and approval. */

type Preview = StudyPreview;
type Priority = Preview['priorities'][number];

export const warningText: Record<Preview['warnings'][number], string> = {
  NO_AVAILABILITY:
    'No study availability. Add weekly windows in Settings › Study.',
  NO_GOALS:
    'No class has a weekly goal yet. Set one in a class’s Study blocks.',
  INSUFFICIENT_TIME: 'Not enough available time to meet every goal.',
  DST_WINDOW_SKIPPED:
    'Some times were skipped because of a daylight saving change.',
  EXTERNAL_CALENDARS_NOT_CHECKED:
    'Only your planner calendar was checked, not external calendars.',
  ACADEMIC_DEADLINES_MISSING: 'Some open work has no deadline.',
  ACADEMIC_ESTIMATES_MISSING: 'Some open work has no time estimate.',
  ACADEMIC_WORK_PROVENANCE_INCOMPLETE:
    'Blocks ranked by academic work cannot be shared with AI.',
};

export const reasonText: Record<Priority['reasons'][number], string> = {
  OWNER_PRIORITY: 'your priority',
  TARGET_DATE: 'target date within 14 days',
  LOW_CONFIDENCE: 'low confidence',
  UNKNOWN_CONFIDENCE: 'confidence not assessed',
  INCOMPLETE_PROGRESS: 'topic not finished',
  NO_TOPICS: 'no topics',
  ACADEMIC_WORK_OVERDUE: 'overdue work',
  ACADEMIC_WORK_DUE_SOON: 'work due within 14 days',
  WORK_IMPORTANCE: 'work priority',
  ESTIMATED_WORKLOAD: 'estimated workload',
};

/** The exclusive end date of a range starting at `from`. */
export const rangeEnd = (from: string, days: number) =>
  Temporal.PlainDate.from(from).add({ days }).toString();

/** Slots grouped by local date in the plan's timezone, in time order. */
export function slotsByDay(slots: readonly StudySlot[], timeZone: string) {
  const days = new Map<string, StudySlot[]>();
  for (const slot of [...slots].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  )) {
    const day = Temporal.Instant.from(slot.startsAt)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .toString();
    days.set(day, [...(days.get(day) ?? []), slot]);
  }
  return [...days].map(([day, items]) => ({ day, slots: items }));
}

/** "14:00–14:30" in the plan's timezone. */
export function slotTime(slot: StudySlot, timeZone: string) {
  const time = (instant: string) =>
    Temporal.Instant.from(instant)
      .toZonedDateTimeISO(timeZone)
      .toPlainTime()
      .toString({ smallestUnit: 'minute' });
  return `${time(slot.startsAt)}–${time(slot.endsAt)}`;
}

export const slotMinutes = (slots: readonly StudySlot[]) =>
  slots.reduce(
    (sum, slot) =>
      sum + (+new Date(slot.endsAt) - +new Date(slot.startsAt)) / 60000,
    0,
  );

/** A stable key for a slot within one plan. */
export const slotKey = (slot: StudySlot) => `${slot.courseId}:${slot.startsAt}`;
