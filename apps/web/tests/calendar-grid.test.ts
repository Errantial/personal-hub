import { expect, it } from 'vitest';
import type { CanvasItem, Occurrence, Task } from '@hub/contracts';
import { allDayStrip, dayLength, layoutDay } from '../src/lib/calendar-grid';

const day = '2026-10-14';
const zone = 'America/Denver'; // UTC-6 in October

const event = (title: string, startsAt: string, endsAt: string, extra = {}) =>
  ({
    id: `event-${title}`,
    occurrenceId: `occ-${title}`,
    originalDate: day,
    title,
    allDay: false,
    startsAt,
    endsAt,
    startDate: null,
    endDate: null,
    courseId: null,
    ...extra,
  }) as Occurrence;

it('layoutDay places a 09:00–10:30 event at top 540, height 90', () => {
  const [block] = layoutDay(
    [event('Calculus', '2026-10-14T15:00:00Z', '2026-10-14T16:30:00Z')],
    day,
    zone,
  );
  expect(block).toMatchObject({
    title: 'Calculus',
    source: 'event',
    top: 540,
    height: 90,
    column: 0,
    columns: 1,
  });
});

it('layoutDay clips an event crossing midnight to the visible day', () => {
  const late = event('Late', '2026-10-15T05:00:00Z', '2026-10-15T07:00:00Z');
  expect(layoutDay([late], day, zone)[0]).toMatchObject({
    top: 1380,
    height: 60,
  });
  expect(layoutDay([late], '2026-10-15', zone)[0]).toMatchObject({
    top: 0,
    height: 60,
  });
});

it('layoutDay splits four overlapping events into four columns', () => {
  const blocks = layoutDay(
    ['A', 'B', 'C', 'D'].map((title, index) =>
      event(
        title,
        `2026-10-14T15:${String(index * 10).padStart(2, '0')}:00Z`,
        '2026-10-14T17:00:00Z',
      ),
    ),
    day,
    zone,
  );
  expect(blocks.map((block) => block.columns)).toEqual([4, 4, 4, 4]);
  expect(blocks.map((block) => block.column).sort()).toEqual([0, 1, 2, 3]);
});

it('layoutDay gives non-overlapping events one column', () => {
  const blocks = layoutDay(
    [
      event('First', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z'),
      event('Second', '2026-10-14T16:00:00Z', '2026-10-14T17:00:00Z'),
    ],
    day,
    zone,
  );
  expect(blocks.map((block) => [block.column, block.columns])).toEqual([
    [0, 1],
    [0, 1],
  ]);
});

it('layoutDay reuses a freed column inside an overlap group', () => {
  // A spans both B and C; B and C do not overlap, so they share column 1.
  const blocks = layoutDay(
    [
      event('A', '2026-10-14T15:00:00Z', '2026-10-14T18:00:00Z'),
      event('B', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z'),
      event('C', '2026-10-14T16:00:00Z', '2026-10-14T17:00:00Z'),
    ],
    day,
    zone,
  );
  const by = Object.fromEntries(blocks.map((block) => [block.title, block]));
  expect([by.A!.column, by.B!.column, by.C!.column]).toEqual([0, 1, 1]);
  expect(blocks.every((block) => block.columns === 2)).toBe(true);
});

it('dayLength is 1380 on the US spring-forward day and 1500 on fall-back', () => {
  expect(dayLength('2026-03-08', zone)).toBe(1380);
  expect(dayLength('2026-11-01', zone)).toBe(1500);
  expect(dayLength(day, zone)).toBe(1440);
});

it('layoutDay keeps blocks inside a 23-hour day', () => {
  const [block] = layoutDay(
    [event('Long', '2026-03-08T05:00:00Z', '2026-03-09T12:00:00Z')],
    '2026-03-08',
    zone,
  );
  expect(block).toMatchObject({ top: 0, height: 1380 });
});

it('layoutDay uses the viewing zone', () => {
  const [block] = layoutDay(
    [event('Calculus', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z')],
    day,
    'America/New_York',
  );
  expect(block!.top).toBe(660);
});

it('layoutDay leaves out all-day events and marks study blocks', () => {
  const blocks = layoutDay(
    [
      event('Holiday', '2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z', {
        allDay: true,
        startDate: day,
        endDate: '2026-10-15',
      }),
      event('Review', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z', {
        courseId: 'course-1',
      }),
    ],
    day,
    zone,
  );
  expect(blocks.map((block) => [block.title, block.source])).toEqual([
    ['Review', 'study'],
  ]);
});

it('allDayStrip includes all-day events, Canvas deadlines and open tasks due that day', () => {
  const canvas = (title: string, data: Partial<CanvasItem['providerData']>) =>
    ({
      id: `canvas-${title}`,
      providerData: {
        title,
        description: '',
        startsAt: null,
        endsAt: null,
        startDate: day,
        endDate: '2026-10-15',
        allDay: true,
        sourceUrl: 'https://canvas.example/1',
        ...data,
      },
    }) as CanvasItem;
  const task = (title: string, extra: Partial<Task>) =>
    ({ id: `task-${title}`, title, completed: false, ...extra }) as Task;
  const strip = allDayStrip(day, {
    timeZone: zone,
    occurrences: [
      event('Holiday', '2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z', {
        allDay: true,
        startDate: day,
        endDate: '2026-10-15',
      }),
      event('Calculus', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z'),
    ],
    canvas: [
      canvas('Essay', {}),
      canvas('Quiz', {
        allDay: false,
        startDate: null,
        endDate: null,
        startsAt: '2026-10-15T05:59:00Z',
        endsAt: '2026-10-15T05:59:00Z',
      }),
      canvas('Tomorrow', { startDate: '2026-10-15', endDate: '2026-10-16' }),
    ],
    tasks: [
      task('Laundry', { dueDate: day }),
      task('Done', { dueDate: day, completed: true }),
      task('Later', { dueDate: '2026-10-16' }),
    ],
  });
  expect(strip.map((item) => [item.title, item.source])).toEqual([
    ['Holiday', 'event'],
    ['Essay', 'canvas'],
    ['Quiz', 'canvas'],
    ['Laundry', 'task'],
  ]);
  expect(strip[1]!.target).toEqual({
    type: 'external',
    url: 'https://canvas.example/1',
  });
  expect(strip[2]!.time).toBe('2026-10-15T05:59:00Z');
  expect(strip[3]!.target).toEqual({ type: 'task', id: 'task-Laundry' });
});
