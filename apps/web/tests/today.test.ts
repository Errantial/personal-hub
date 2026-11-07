import { expect, it } from 'vitest';
import type {
  CanvasItem,
  Occurrence,
  Task,
  TrackedDeadline,
} from '@hub/contracts';
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
const deadline = (title: string, extra: Partial<TrackedDeadline> = {}) =>
  ({
    id: `deadline-${title}`,
    providerKind: 'canvas',
    canonicalKey: 'canvas:canvas.colorado.edu:/courses/1/assignments/2',
    version: 1,
    completedAt: null,
    priority: 'normal',
    notes: '',
    titleOverride: null,
    dueOverride: { kind: 'provider' },
    sensitivity: 'unlabeled',
    sourceLabels: ['unlabeled'],
    createdAt: '2026-10-14T12:00:00.000Z',
    updatedAt: '2026-10-14T12:00:00.000Z',
    title,
    due: { kind: 'date', dueDate: today },
    providerDue: { kind: 'date', dueDate: today },
    sourceUrl: 'https://canvas.colorado.edu/courses/1/assignments/2',
    sourceAvailability: 'available',
    sourceCoverage: ['calendar-feed'],
    sourceConflict: false,
    alternateTimedDue: null,
    labels: ['unlabeled'],
    effectiveSensitivity: 'unlabeled',
    sources: [],
    ...extra,
  }) as TrackedDeadline;

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

it('todayItems keeps date-only tasks in the deadline strip and timed tasks in time order', () => {
  const items = todayItems({
    today,
    timeZone,
    tasks: [
      task('Date only'),
      task('Timed', {
        dueAt: '2026-10-14T16:30:00.000Z',
        dueTimeZone: 'America/Denver',
      }),
    ],
    canvas: [],
    occurrences: [occurrence('Early event')],
  });
  expect(items.map((item) => [item.kind, item.title, item.allDay])).toEqual([
    ['task', 'Date only', true],
    ['event', 'Early event', false],
    ['task', 'Timed', false],
  ]);
  expect(items[2]).toMatchObject({
    start: '2026-10-14T16:30:00.000Z',
    timeZone: 'America/Denver',
  });
});

it('todayItems marks Canvas items that are no longer available as cancelled', () => {
  const item = canvas('Old quiz', {});
  const [result] = todayItems({
    today,
    timeZone,
    tasks: [],
    canvas: [{ ...item, availability: 'cancelled' } as CanvasItem],
    occurrences: [],
  });
  expect(result).toMatchObject({ kind: 'deadline', cancelled: true });
});

it('todayItems prefers a tracked deadline over its raw Canvas source and opens the local editor', () => {
  const raw = canvas('Raw Canvas title', {
    sourceUrl: 'https://canvas.colorado.edu/courses/1/assignments/2',
  });
  const tracked = deadline('Personal Hub title');
  const items = todayItems({
    today,
    timeZone,
    tasks: [],
    canvas: [raw],
    deadlines: [tracked],
    occurrences: [],
  });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    title: 'Personal Hub title',
    kind: 'deadline',
    deadlineId: tracked.id,
  });
});

it('todayItems excludes completed tracked deadlines and keeps raw Canvas fallback when untracked', () => {
  const raw = canvas('Untracked Canvas', {
    sourceUrl: 'https://canvas.colorado.edu/courses/1/assignments/9',
  });
  const items = todayItems({
    today,
    timeZone,
    tasks: [],
    canvas: [raw],
    deadlines: [
      deadline('Completed', { completedAt: '2026-10-14T10:00:00.000Z' }),
    ],
    occurrences: [],
  });
  expect(items.map((item) => item.title)).toEqual(['Untracked Canvas']);
});
