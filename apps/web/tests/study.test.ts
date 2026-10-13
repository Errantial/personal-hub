import { expect, it } from 'vitest';
import {
  minutesOfTime,
  rangeEnd,
  slotMinutes,
  slotTime,
  slotsByDay,
  timeOfMinutes,
  weeklyMinutes,
  windowDrafts,
  windowsOf,
} from '../src/lib/study';

it('converts between minutes and clock times', () => {
  expect(timeOfMinutes(0)).toBe('00:00');
  expect(timeOfMinutes(570)).toBe('09:30');
  expect(timeOfMinutes(1440)).toBe('00:00');
  expect(minutesOfTime('09:30')).toBe(570);
  expect(minutesOfTime('')).toBeNull();
  expect(minutesOfTime('24:00')).toBeNull();
});

it('treats an end of 00:00 as the next midnight', () => {
  expect(windowsOf([{ day: 2, start: '22:00', end: '00:00' }])).toEqual({
    windows: [{ day: 2, startMinute: 1320, endMinute: 1440 }],
  });
  expect(
    windowDrafts([{ day: 2, startMinute: 1320, endMinute: 1440 }]),
  ).toEqual([{ day: 2, start: '22:00', end: '00:00' }]);
});

it('reports the first invalid or overlapping window', () => {
  expect(windowsOf([{ day: 1, start: '10:00', end: '09:00' }])).toEqual({
    error: 'End after the start time',
    index: 0,
  });
  expect(windowsOf([{ day: 1, start: '', end: '09:00' }])).toMatchObject({
    index: 0,
  });
  expect(
    windowsOf([
      { day: 1, start: '09:00', end: '11:00' },
      { day: 2, start: '09:00', end: '11:00' },
      { day: 1, start: '10:00', end: '12:00' },
    ]),
  ).toEqual({ error: 'Overlaps another window that day', index: 2 });
  // Touching windows do not overlap.
  const touching = windowsOf([
    { day: 1, start: '09:00', end: '10:00' },
    { day: 1, start: '10:00', end: '11:00' },
  ]);
  expect('windows' in touching && weeklyMinutes(touching.windows)).toBe(120);
});

const slot = (startsAt: string, endsAt: string) => ({
  courseId: '00000000-0000-4000-8000-000000000001',
  topicId: null,
  startsAt,
  endsAt,
});

it('groups plan slots by local day in the plan timezone', () => {
  const late = slot('2028-03-07T04:30:00Z', '2028-03-07T05:00:00Z');
  const early = slot('2028-03-06T14:00:00Z', '2028-03-06T14:30:00Z');
  // 04:30 UTC on Mar 7 is still Mar 6 in New York.
  expect(slotsByDay([late, early], 'America/New_York')).toEqual([
    { day: '2028-03-06', slots: [early, late] },
  ]);
  expect(slotsByDay([late, early], 'UTC').map((group) => group.day)).toEqual([
    '2028-03-06',
    '2028-03-07',
  ]);
  expect(slotTime(early, 'UTC')).toBe('14:00–14:30');
  expect(slotMinutes([late, early])).toBe(60);
  expect(rangeEnd('2028-02-25', 7)).toBe('2028-03-03');
});
