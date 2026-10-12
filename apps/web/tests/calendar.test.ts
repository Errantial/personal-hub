import { expect, it } from 'vitest';
import type { CalendarRecord, Occurrence } from '@hub/contracts';
import {
  DraftError,
  checkLocalTime,
  dayOccurrences,
  occursOn,
  resetsSeries,
  shiftDate,
  timeLabel,
  toDraft,
  toInput,
  viewRange,
} from '../src/lib/calendar';

const defaults = { date: '2027-03-08', timeZone: 'America/New_York' };

const record = (extra: Partial<CalendarRecord> = {}): CalendarRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Event',
  notes: '',
  startsAt: '2027-03-08T15:00:00.000Z',
  endsAt: '2027-03-08T16:00:00.000Z',
  timeZone: 'America/New_York',
  sensitivity: 'unlabeled',
  allDay: false,
  startDate: null,
  endDate: null,
  recurrence: null,
  courseId: null,
  topicId: null,
  studyStatus: 'planned',
  version: 1,
  createdAt: '2027-03-01T00:00:00.000Z',
  updatedAt: '2027-03-01T00:00:00.000Z',
  deletedAt: null,
  academicLabels: [],
  canvasSource: null,
  academicSource: null,
  ...extra,
});
const occurrence = (extra: Partial<Occurrence> = {}): Occurrence => ({
  ...record(),
  originalDate: '2027-03-08',
  occurrenceId: 'o1',
  overridden: false,
  ...extra,
});

it('windows: agenda starts at the date, week at Monday, day is one date', () => {
  // 2027-03-10 is a Wednesday.
  expect(viewRange('2027-03-10', 'agenda')).toMatchObject({
    from: '2027-03-10',
    to: '2027-03-17',
  });
  const week = viewRange('2027-03-10', 'week');
  expect(week).toMatchObject({ from: '2027-03-08', to: '2027-03-15' });
  expect(week.days).toHaveLength(7);
  expect(viewRange('2027-03-10', 'day').days).toEqual(['2027-03-10']);
  expect(shiftDate('2027-03-10', 'agenda', 1)).toBe('2027-03-17');
  expect(shiftDate('2027-03-10', 'week', -1)).toBe('2027-03-03');
  expect(shiftDate('2027-03-10', 'day', 1)).toBe('2027-03-11');
});

it('places events on days in the viewing timezone', () => {
  // 23:30 New York on Mar 8 is already Mar 9 in UTC.
  const late = occurrence({
    startsAt: '2027-03-09T04:30:00.000Z',
    endsAt: '2027-03-09T04:55:00.000Z',
  });
  expect(occursOn(late, '2027-03-08', 'America/New_York')).toBe(true);
  expect(occursOn(late, '2027-03-09', 'America/New_York')).toBe(false);
  expect(occursOn(late, '2027-03-09', 'UTC')).toBe(true);
  // A timed event that crosses midnight is on both days.
  const overnight = occurrence({
    startsAt: '2027-03-09T03:00:00.000Z',
    endsAt: '2027-03-09T07:00:00.000Z',
  });
  expect(occursOn(overnight, '2027-03-08', 'America/New_York')).toBe(true);
  expect(occursOn(overnight, '2027-03-09', 'America/New_York')).toBe(true);
  // An event ending exactly at midnight is not on the next day.
  const ends = occurrence({
    startsAt: '2027-03-09T03:00:00.000Z',
    endsAt: '2027-03-09T05:00:00.000Z',
  });
  expect(occursOn(ends, '2027-03-09', 'America/New_York')).toBe(false);
});

it('all-day events cover their dates with an exclusive end', () => {
  const trip = occurrence({
    allDay: true,
    startDate: '2027-03-08',
    endDate: '2027-03-10',
  });
  expect(occursOn(trip, '2027-03-07', 'UTC')).toBe(false);
  expect(occursOn(trip, '2027-03-08', 'Asia/Tokyo')).toBe(true);
  expect(occursOn(trip, '2027-03-09', 'Asia/Tokyo')).toBe(true);
  expect(occursOn(trip, '2027-03-10', 'Asia/Tokyo')).toBe(false);
});

it('orders a day all-day first, then by start time', () => {
  const items = [
    occurrence({
      title: 'Late',
      startsAt: '2027-03-08T20:00:00.000Z',
      endsAt: '2027-03-08T21:00:00.000Z',
    }),
    occurrence({ title: 'Early' }),
    occurrence({
      title: 'Holiday',
      allDay: true,
      startDate: '2027-03-08',
      endDate: '2027-03-09',
    }),
  ];
  expect(
    dayOccurrences(items, '2027-03-08', 'America/New_York').map(
      (item) => item.title,
    ),
  ).toEqual(['Holiday', 'Early', 'Late']);
  expect(timeLabel(items[2]!, 'UTC')).toBe('All day');
  expect(timeLabel(items[1]!, 'UTC')).toMatch(/–/);
});

it('detects missing and repeated local times', () => {
  const zone = 'America/New_York';
  expect(checkLocalTime('2027-03-14T02:30', zone)).toBe('gap');
  expect(checkLocalTime('2027-03-14T03:30', zone)).toBe('ok');
  expect(checkLocalTime('2027-11-07T01:30', zone)).toBe('fold');
  expect(checkLocalTime('2027-11-07T00:30', zone)).toBe('ok');
  expect(checkLocalTime('2027-03-14T02:30', 'UTC')).toBe('ok');
  expect(checkLocalTime('2027-03-14T02:30', 'Not/AZone')).toBe('invalid');
  expect(checkLocalTime('', zone)).toBe('invalid');
});

it('a draft converts to the API input and back', () => {
  const draft = toDraft(null, defaults);
  expect(draft).toMatchObject({
    startsAt: '2027-03-08T10:00',
    endsAt: '2027-03-08T11:00',
    frequency: 'none',
  });
  const input = toInput({ ...draft, title: 'Plan' });
  expect(input).toMatchObject({
    title: 'Plan',
    startsAt: '2027-03-08T15:00:00.000Z',
    endsAt: '2027-03-08T16:00:00.000Z',
    allDay: false,
    startDate: null,
    recurrence: null,
    courseId: null,
  });
  expect(toDraft(record({ title: 'Plan' }), defaults)).toMatchObject({
    title: 'Plan',
    startsAt: '2027-03-08T10:00',
  });
});

it('all-day drafts store an exclusive end date', () => {
  const draft = {
    ...toDraft(null, defaults),
    title: 'Trip',
    allDay: true,
    lastDate: '2027-03-10',
  };
  expect(toInput(draft)).toMatchObject({
    allDay: true,
    startDate: '2027-03-08',
    endDate: '2027-03-11',
    startsAt: '2027-03-08T00:00:00.000Z',
    endsAt: '2027-03-11T00:00:00.000Z',
  });
  const back = toDraft(
    record({ allDay: true, startDate: '2027-03-08', endDate: '2027-03-11' }),
    defaults,
  );
  expect(back.lastDate).toBe('2027-03-10');
  expect(() => toInput({ ...draft, lastDate: '2027-03-07' })).toThrow(
    DraftError,
  );
});

it('rejects a missing local time and requires a choice for a repeated one', () => {
  const base = { ...toDraft(null, defaults), title: 'DST' };
  const gap = {
    ...base,
    startsAt: '2027-03-14T02:30',
    endsAt: '2027-03-14T04:00',
  };
  expect(() => toInput(gap)).toThrow(/does not exist/);
  const fold = {
    ...base,
    startsAt: '2027-11-07T01:30',
    endsAt: '2027-11-07T03:00',
  };
  expect(() => toInput(fold)).toThrow(/happens twice/);
  try {
    toInput(fold);
  } catch (error) {
    expect((error as DraftError).field).toBe('startsAt');
  }
  expect(toInput({ ...fold, startOffset: 'earlier' }).startsAt).toBe(
    '2027-11-07T05:30:00.000Z',
  );
  expect(toInput({ ...fold, startOffset: 'later' }).startsAt).toBe(
    '2027-11-07T06:30:00.000Z',
  );
});

it('keeps the stored offset of a repeated time when editing', () => {
  const later = record({
    startsAt: '2027-11-07T06:30:00.000Z',
    endsAt: '2027-11-07T08:00:00.000Z',
  });
  const draft = toDraft(later, defaults);
  expect(draft).toMatchObject({
    startsAt: '2027-11-07T01:30',
    startOffset: 'later',
  });
  expect(toInput(draft).startsAt).toBe(later.startsAt);
});

it('validates the title, end, timezone and repeat fields', () => {
  const base = { ...toDraft(null, defaults), title: 'Valid' };
  const field = (draft: typeof base) => {
    try {
      toInput(draft);
    } catch (error) {
      return (error as DraftError).field;
    }
    return null;
  };
  expect(field({ ...base, title: '  ' })).toBe('title');
  expect(field({ ...base, endsAt: base.startsAt })).toBe('endsAt');
  expect(field({ ...base, timeZone: 'Nowhere' })).toBe('timeZone');
  expect(field({ ...base, frequency: 'daily', interval: '0' })).toBe(
    'interval',
  );
  expect(field({ ...base, frequency: 'daily', count: '1.5' })).toBe('count');
  expect(
    toInput({ ...base, frequency: 'weekly', interval: '2', count: '3' })
      .recurrence,
  ).toEqual({ frequency: 'weekly', interval: 2, count: 3, until: null });
});

it('study fields only apply with a class', () => {
  const base = { ...toDraft(null, defaults), title: 'Study' };
  expect(
    toInput({ ...base, topicId: 'topic', studyStatus: 'completed' }),
  ).toMatchObject({ courseId: null, topicId: null, studyStatus: 'planned' });
  expect(
    toInput({
      ...base,
      courseId: 'class',
      topicId: 't',
      studyStatus: 'completed',
    }),
  ).toMatchObject({
    courseId: 'class',
    topicId: 't',
    studyStatus: 'completed',
  });
});

it('resets the series only when its start, timezone or rule changes', () => {
  const series = record({
    recurrence: { frequency: 'daily', interval: 1, count: 3, until: null },
  });
  const same = toInput(toDraft(series, defaults));
  expect(resetsSeries(series, same)).toBe(false);
  expect(resetsSeries(series, { ...same, title: 'Renamed', notes: 'n' })).toBe(
    false,
  );
  expect(
    resetsSeries(series, { ...same, endsAt: '2027-03-08T17:00:00.000Z' }),
  ).toBe(false);
  expect(
    resetsSeries(series, { ...same, startsAt: '2027-03-08T16:00:00.000Z' }),
  ).toBe(true);
  expect(resetsSeries(series, { ...same, timeZone: 'UTC' })).toBe(true);
  expect(resetsSeries(series, { ...same, recurrence: null })).toBe(true);
  expect(
    resetsSeries(series, {
      ...same,
      recurrence: { frequency: 'daily', interval: 2, count: 3, until: null },
    }),
  ).toBe(true);
});
