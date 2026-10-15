import {
  Temporal,
  instantToWall,
  wallTimeToInstant,
  zone as zoneSchema,
} from '@hub/contracts';
import type { CalendarInput, CalendarRecord, Occurrence } from '@hub/contracts';
import type { CalendarView } from './router';
import { selectionItems } from './selection';
import type { Selection } from './selection';

/* Pure calendar helpers: visible window, day membership, and conversion
   between the editor's text fields and the API's calendar input. */

const windowDays: Record<CalendarView, number> = {
  agenda: 7,
  week: 7,
  day: 1,
  month: 42,
};

const mondayOf = (date: Temporal.PlainDate) =>
  date.subtract({ days: date.dayOfWeek - 1 });

/** Dates shown for a view: Agenda starts at the chosen date, Week at its
 *  Monday, Day is the date itself, and Month is six weeks from the Monday on
 *  or before the 1st. `to` is exclusive. */
export function viewRange(date: string, view: CalendarView) {
  const chosen = Temporal.PlainDate.from(date);
  const first =
    view === 'week'
      ? mondayOf(chosen)
      : view === 'month'
        ? mondayOf(chosen.with({ day: 1 }))
        : chosen;
  const days = Array.from({ length: windowDays[view] }, (_, index) =>
    first.add({ days: index }).toString(),
  );
  return {
    from: days[0]!,
    to: first.add({ days: windowDays[view] }).toString(),
    days,
  };
}

/** The date one window before (-1) or after (1) `date`; Month moves by
 *  calendar month, clamping the day to the month's length. */
export const shiftDate = (
  date: string,
  view: CalendarView,
  direction: 1 | -1,
) =>
  Temporal.PlainDate.from(date)
    .add(
      view === 'month'
        ? { months: direction }
        : { days: direction * windowDays[view] },
    )
    .toString();

/** Whether an occurrence overlaps a calendar day in the viewing timezone.
 *  All-day events use their own dates (end is exclusive); timed events use
 *  the instants, so one that crosses midnight appears on both days. */
export function occursOn(item: Occurrence, day: string, timeZone: string) {
  if (item.allDay) return item.startDate! <= day && item.endDate! > day;
  const start = Temporal.PlainDate.from(day).toZonedDateTime(timeZone);
  const end = start.add({ days: 1 });
  return (
    Temporal.Instant.compare(
      Temporal.Instant.from(item.startsAt),
      end.toInstant(),
    ) < 0 &&
    Temporal.Instant.compare(
      Temporal.Instant.from(item.endsAt),
      start.toInstant(),
    ) > 0
  );
}

/** One day's occurrences: all-day first, then by start time, then title. */
export function dayOccurrences(
  items: Occurrence[],
  day: string,
  timeZone: string,
) {
  return items
    .filter((item) => occursOn(item, day, timeZone))
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        a.startsAt.localeCompare(b.startsAt) ||
        a.title.localeCompare(b.title),
    );
}

const timeFormat = (timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });

/** "All day", or "9:00 AM – 10:00 AM" in the viewing timezone. */
export function timeLabel(item: Occurrence, timeZone: string) {
  if (item.allDay) return 'All day';
  const format = timeFormat(timeZone);
  return `${format.format(new Date(item.startsAt))} – ${format.format(new Date(item.endsAt))}`;
}

/* ---------- Editor draft ---------- */

export type Offset = 'earlier' | 'later' | '';
export type Frequency = 'none' | 'daily' | 'weekly' | 'monthly';

/** Every editor field as text, so typing never fails to parse. */
export type CalendarDraft = {
  title: string;
  notes: string;
  allDay: boolean;
  timeZone: string;
  startDate: string;
  /** Inclusive last day; the API stores the exclusive end. */
  lastDate: string;
  startsAt: string;
  endsAt: string;
  startOffset: Offset;
  endOffset: Offset;
  frequency: Frequency;
  interval: string;
  count: string;
  until: string;
  courseId: string;
  topicId: string;
  studyStatus: CalendarInput['studyStatus'];
  sensitivity: CalendarInput['sensitivity'];
};

/** Class study time handed over from Classes ("Schedule study"). */
export type StudyDraft = {
  courseId: string;
  topicId: string | null;
  title: string;
};

export type DraftDefaults = {
  date: string;
  timeZone: string;
  study?: StudyDraft | null;
  /** Local start (`YYYY-MM-DDTHH:MM`) chosen from a grid slot; one hour long. */
  start?: string;
};

/** Which offset the stored instant uses, when its wall time occurs twice;
 *  otherwise no choice is stored, so a newly repeated time must be chosen. */
function offsetOf(instant: string, timeZone: string): Offset {
  const wall = instantToWall(instant, timeZone);
  if (checkLocalTime(wall, timeZone) !== 'fold') return '';
  const earlier = Temporal.PlainDateTime.from(wall).toZonedDateTime(timeZone, {
    disambiguation: 'earlier',
  });
  return earlier.epochMilliseconds === Date.parse(instant)
    ? 'earlier'
    : 'later';
}

/** The two instants a repeated local time can mean, labelled by UTC offset. */
export function foldChoices(local: string, timeZone: string) {
  const plain = Temporal.PlainDateTime.from(local);
  const at = (disambiguation: 'earlier' | 'later') =>
    plain.toZonedDateTime(timeZone, { disambiguation }).offset;
  return { earlier: at('earlier'), later: at('later') };
}

/** A draft for a new event, or from an existing event/occurrence. */
export function toDraft(
  event: CalendarRecord | null,
  defaults: DraftDefaults,
): CalendarDraft {
  if (!event) {
    const start = defaults.start
      ? Temporal.PlainDateTime.from(defaults.start)
      : Temporal.PlainDate.from(defaults.date).toPlainDateTime({ hour: 10 });
    const wall = (time: Temporal.PlainDateTime) =>
      time.toString({ smallestUnit: 'minute' });
    const day = start.toPlainDate().toString();
    return {
      title: defaults.study?.title ?? '',
      notes: '',
      allDay: false,
      timeZone: defaults.timeZone,
      startDate: day,
      lastDate: day,
      startsAt: wall(start),
      endsAt: wall(start.add({ hours: 1 })),
      startOffset: '',
      endOffset: '',
      frequency: 'none',
      interval: '1',
      count: '',
      until: '',
      courseId: defaults.study?.courseId ?? '',
      topicId: defaults.study?.topicId ?? '',
      studyStatus: 'planned',
      sensitivity: 'unlabeled',
    };
  }
  const startDate = event.startDate ?? defaults.date;
  return {
    title: event.title,
    notes: event.notes,
    allDay: event.allDay,
    timeZone: event.timeZone,
    startDate,
    lastDate: event.endDate
      ? Temporal.PlainDate.from(event.endDate).subtract({ days: 1 }).toString()
      : startDate,
    startsAt: instantToWall(event.startsAt, event.timeZone),
    endsAt: instantToWall(event.endsAt, event.timeZone),
    startOffset: offsetOf(event.startsAt, event.timeZone),
    endOffset: offsetOf(event.endsAt, event.timeZone),
    frequency: event.recurrence?.frequency ?? 'none',
    interval: String(event.recurrence?.interval ?? 1),
    count: event.recurrence?.count ? String(event.recurrence.count) : '',
    until: event.recurrence?.until ?? '',
    courseId: event.courseId ?? '',
    topicId: event.topicId ?? '',
    studyStatus: event.studyStatus,
    sensitivity: event.sensitivity,
  };
}

/** Whether a local time is fine, occurs twice (clocks go back) or never
 *  occurs (clocks skip forward) in a timezone. */
export type LocalTimeCheck = 'ok' | 'fold' | 'gap' | 'invalid';

export function checkLocalTime(
  local: string,
  timeZone: string,
): LocalTimeCheck {
  if (!zoneSchema.safeParse(timeZone).success) return 'invalid';
  let plain: Temporal.PlainDateTime;
  try {
    plain = Temporal.PlainDateTime.from(local);
  } catch {
    return 'invalid';
  }
  const earlier = plain.toZonedDateTime(timeZone, {
    disambiguation: 'earlier',
  });
  const later = plain.toZonedDateTime(timeZone, { disambiguation: 'later' });
  if (
    !earlier.toPlainDateTime().equals(plain) ||
    !later.toPlainDateTime().equals(plain)
  )
    return 'gap';
  return earlier.equals(later) ? 'ok' : 'fold';
}

export const localTimeMessages = {
  gap: 'This time does not exist in the event timezone (clocks skip forward). Choose another time.',
  fold: 'This time happens twice in the event timezone (clocks go back). Choose which one.',
} as const;

export type DraftField =
  | 'title'
  | 'timeZone'
  | 'startDate'
  | 'lastDate'
  | 'startsAt'
  | 'endsAt'
  | 'interval'
  | 'count'
  | 'until';
export class DraftError extends Error {
  constructor(
    readonly field: DraftField,
    message: string,
  ) {
    super(message);
  }
}

const wholeNumber = (text: string, min: number, max: number) =>
  /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max;

/** Validates a draft and builds the API input. Throws DraftError naming the
 *  field to focus; the API still validates everything again. */
export function toInput(draft: CalendarDraft): CalendarInput {
  if (!draft.title.trim()) throw new DraftError('title', 'Enter a title');
  if (!zoneSchema.safeParse(draft.timeZone).success)
    throw new DraftError('timeZone', 'Enter a supported IANA timezone.');
  let startsAt: string;
  let endsAt: string;
  let startDate: string | null = null;
  let endDate: string | null = null;
  if (draft.allDay) {
    if (!draft.startDate)
      throw new DraftError('startDate', 'Enter the first day');
    if (!draft.lastDate) throw new DraftError('lastDate', 'Enter the last day');
    if (draft.lastDate < draft.startDate)
      throw new DraftError('lastDate', 'The last day is before the first day.');
    startDate = draft.startDate;
    endDate = Temporal.PlainDate.from(draft.lastDate)
      .add({ days: 1 })
      .toString();
    startsAt = `${startDate}T00:00:00.000Z`;
    endsAt = `${endDate}T00:00:00.000Z`;
  } else {
    const convert = (
      field: 'startsAt' | 'endsAt',
      offset: Offset,
      label: string,
    ) => {
      if (!draft[field]) throw new DraftError(field, `Enter the ${label}`);
      const check = checkLocalTime(draft[field], draft.timeZone);
      if (check === 'gap') throw new DraftError(field, localTimeMessages.gap);
      if (check === 'fold' && !offset)
        throw new DraftError(field, localTimeMessages.fold);
      return wallTimeToInstant(
        draft[field],
        draft.timeZone,
        offset || 'reject',
      );
    };
    startsAt = convert('startsAt', draft.startOffset, 'start time');
    endsAt = convert('endsAt', draft.endOffset, 'end time');
    if (endsAt <= startsAt)
      throw new DraftError('endsAt', 'The end must be after the start.');
  }
  let recurrence: CalendarInput['recurrence'] = null;
  if (draft.frequency !== 'none') {
    if (!wholeNumber(draft.interval, 1, 52))
      throw new DraftError('interval', 'Use a whole number from 1 to 52.');
    if (draft.count && !wholeNumber(draft.count, 1, 1000))
      throw new DraftError('count', 'Use a whole number from 1 to 1000.');
    recurrence = {
      frequency: draft.frequency,
      interval: Number(draft.interval),
      count: draft.count ? Number(draft.count) : null,
      until: draft.until || null,
    };
  }
  return {
    title: draft.title,
    notes: draft.notes,
    startsAt,
    endsAt,
    timeZone: draft.timeZone,
    sensitivity: draft.sensitivity,
    allDay: draft.allDay,
    startDate,
    endDate,
    recurrence,
    courseId: draft.courseId || null,
    topicId: draft.courseId && draft.topicId ? draft.topicId : null,
    studyStatus: draft.courseId ? draft.studyStatus : 'planned',
  };
}

/** The API input for a draft, or null while the draft is not valid yet. */
export function tryInput(draft: CalendarDraft) {
  try {
    return toInput(draft);
  } catch {
    return null;
  }
}

/** Whether saving would reset the series' occurrence edits and cancel their
 *  reminders: the server does this when the start, timezone, all-day flag or
 *  repeat rule changes. */
export function resetsSeries(series: CalendarRecord, next: CalendarInput) {
  const before = series.recurrence;
  const after = next.recurrence;
  return (
    Date.parse(series.startsAt) !== Date.parse(next.startsAt) ||
    series.timeZone !== next.timeZone ||
    series.allDay !== next.allDay ||
    (before === null) !== (after === null) ||
    (!!before &&
      !!after &&
      (before.frequency !== after.frequency ||
        before.interval !== after.interval ||
        before.count !== after.count ||
        before.until !== after.until))
  );
}

/* Selected changes (POST /api/v1/calendar/batch); see ./selection.
   Deletion removes whole records, so a selected recurring series loses every
   occurrence. Study status applies to one-time timed study blocks only. */

export type CalendarChange =
  | { kind: 'study-status'; status: 'planned' | 'completed' | 'cancelled' }
  | { kind: 'delete' };

/** Whether the server accepts a study-status change for this record. */
export const studyStatusAllowed = (record: CalendarRecord) =>
  !!record.courseId && !record.allDay && !record.recurrence;

/** Request body without operationId, which the mutation hook adds. */
export const calendarBatchBody = (
  selection: Selection,
  change: CalendarChange,
) => ({ items: selectionItems(selection), action: change });
