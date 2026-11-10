import { expect, it } from 'vitest';
import {
  isCachedWindow,
  pastWindowDays,
  staleWindows,
} from '../src/lib/cache-windows';

const now = new Date('2026-11-10T18:00:00.000Z');
const occurrences = (from: string, to: string) =>
  `/api/v1/calendar/occurrences?from=${from}&to=${to}&timeZone=America%2FDenver`;
const canvas = (from: string, to: string) =>
  `/api/v1/connections/canvas/calendar?from=${from}&to=${to}&timeZone=America%2FDenver`;
const deadlines = (from: string, to: string) =>
  `/api/v1/deadlines?status=all&from=${from}&to=${to}&limit=200`;

it('only dated windows can make other cache entries obsolete', () => {
  expect(isCachedWindow(occurrences('2026-11-10', '2026-11-11'))).toBe(true);
  expect(isCachedWindow(canvas('2026-11-10', '2026-11-18'))).toBe(true);
  expect(isCachedWindow(deadlines('2026-10-26', '2026-11-19'))).toBe(true);
  for (const path of [
    '/api/v1/tasks',
    '/api/v1/calendar',
    '/api/v1/deadlines?status=all&limit=200',
    '/api/v1/academic-work/browse?status=open&deadline=dated&limit=200',
  ])
    expect(isCachedWindow(path)).toBe(false);
});

it('drops calendar and Canvas windows that ended more than the retention ago', () => {
  expect(pastWindowDays).toBe(35);
  const saved = occurrences('2026-11-10', '2026-11-11');
  const kept = [
    saved,
    // Ended exactly at the cutoff (2026-10-06) or later, and future ranges.
    occurrences('2026-10-05', '2026-10-06'),
    canvas('2026-10-01', '2026-10-09'),
    occurrences('2027-01-04', '2027-01-11'),
    // Undated lists and other reads are never touched.
    '/api/v1/tasks',
    '/api/v1/calendar',
    '/api/v1/deadlines?status=all&limit=200',
    '/api/v1/planner/deleted?kind=task',
    // A malformed range is left alone rather than guessed at.
    '/api/v1/calendar/occurrences?from=2020-01-01&to=soon&timeZone=UTC',
  ];
  const stale = [
    occurrences('2026-10-04', '2026-10-05'),
    occurrences('2020-01-01', '2020-01-08'),
    canvas('2026-09-01', '2026-09-09'),
  ];
  expect(staleWindows([...kept, ...stale], saved, now).sort()).toEqual(
    [...stale].sort(),
  );
});

it('keeps only the newest imported-deadline window', () => {
  const saved = deadlines('2026-10-26', '2026-11-19');
  const earlier = deadlines('2026-10-25', '2026-11-18');
  const paths = [
    saved,
    earlier,
    '/api/v1/deadlines?status=all&limit=200',
    '/api/v1/deadlines?status=all&limit=200&after=00000000-0000-4000-8000-000000000001',
    occurrences('2026-11-10', '2026-11-11'),
  ];
  expect(staleWindows(paths, saved, now)).toEqual([earlier]);
  // Saving a calendar window never removes the deadline window.
  expect(
    staleWindows(paths, occurrences('2026-11-10', '2026-11-11'), now),
  ).toEqual([]);
});
