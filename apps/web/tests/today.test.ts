import { expect, it } from 'vitest';
import type { CanvasItem, Occurrence, Task } from '@hub/contracts';
import { todayItems } from '../src/lib/today';

const today = '2026-10-14';
const timeZone = 'America/Denver';

const task = (title: string, extra: Partial<Task> = {}) =>
  ({
    id: `task-${title}`,
    title,
    notes: '',
    dueDate: today,
    priority: 'normal',
    completed: false,
    ...extra,
  }) as Task;
const occurrence = (title: string, extra: Partial<Occurrence> = {}) =>
  ({
    id: `event-${title}`,
    occurrenceId: `occ-${title}`,
    originalDate: today,
    title,
    allDay: false,
    startsAt: '2026-10-14T15:00:00.000Z',
    endsAt: '2026-10-14T16:00:00.000Z',
    startDate: null,
    endDate: null,
    courseId: null,
    ...extra,
  }) as Occurrence;
const canvas = (title: string, data: Partial<CanvasItem['providerData']>) =>
  ({
    id: `canvas-${title}`,
    providerData: {
      title,
      description: '',
      startsAt: null,
      endsAt: null,
      startDate: today,
      endDate: '2026-10-15',
      allDay: true,
      sourceUrl: null,
      ...data,
    },
  }) as CanvasItem;

it('todayItems orders all-day deadlines and due tasks, then all-day events, then timed by start', () => {
  const items = todayItems({
    today,
    timeZone,
    tasks: [task('Waiver')],
    canvas: [canvas('Essay due', {})],
    occurrences: [
      occurrence('Study: Bio', {
        courseId: '00000000-0000-4000-8000-000000000009',
        startsAt: '2026-10-14T19:00:00.000Z',
        endsAt: '2026-10-14T21:00:00.000Z',
      }),
      occurrence('Calculus'),
      occurrence('Holiday', {
        allDay: true,
        startDate: today,
        endDate: '2026-10-15',
      }),
    ],
  });
  expect(items.map((item) => item.kind)).toEqual([
    'deadline',
    'task',
    'event',
    'event',
    'study',
  ]);
  expect(items.map((item) => item.title)).toEqual([
    'Essay due',
    'Waiver',
    'Holiday',
    'Calculus',
    'Study: Bio',
  ]);
});

it('todayItems excludes completed tasks and tasks due on other days', () => {
  const items = todayItems({
    today,
    timeZone,
    tasks: [
      task('Done', { completed: true }),
      task('Tomorrow', { dueDate: '2026-10-15' }),
      task('Undated', { dueDate: null }),
    ],
    canvas: [],
    occurrences: [],
  });
  expect(items).toEqual([]);
});

it('todayItems marks occurrences with courseId as study and links them to the editor', () => {
  const [item] = todayItems({
    today,
    timeZone,
    tasks: [],
    canvas: [],
    occurrences: [
      occurrence('Study', { courseId: '00000000-0000-4000-8000-000000000009' }),
    ],
  });
  expect(item).toMatchObject({
    kind: 'study',
    target: { type: 'event', id: 'event-Study', date: today },
  });
});

it('todayItems keeps a timed Canvas deadline in time order as a deadline', () => {
  const items = todayItems({
    today,
    timeZone,
    tasks: [],
    canvas: [
      canvas('Quiz', {
        allDay: false,
        startsAt: '2026-10-14T23:59:00.000Z',
        endsAt: '2026-10-14T23:59:00.000Z',
        startDate: null,
        endDate: null,
      }),
    ],
    occurrences: [occurrence('Calculus')],
  });
  expect(items.map((item) => [item.kind, item.title])).toEqual([
    ['event', 'Calculus'],
    ['deadline', 'Quiz'],
  ]);
});
