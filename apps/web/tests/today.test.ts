import { expect, it } from 'vitest';
import type {
  CanvasItem,
  Occurrence,
  Task,
  TrackedDeadline,
} from '@hub/contracts';
import {
  overdueDeadlineDays,
  overdueItems,
  todayItems,
  todayLists,
  upcomingDays,
} from '../src/lib/today';
import type { WorkItem } from '../src/lib/today';

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

const work = (title: string, extra: Partial<WorkItem> = {}) =>
  ({
    id: `work-${title}`,
    courseId: '00000000-0000-4000-8000-000000000021',
    courseName: 'Chemistry',
    courseVersion: 1,
    courseArchived: false,
    title,
    kind: 'assignment',
    notes: '',
    dueDate: today,
    estimatedMinutes: null,
    priority: 3,
    status: 'planned',
    grade: null,
    deletedAt: null,
    ...extra,
  }) as WorkItem;
const empty = { today, timeZone, tasks: [], canvas: [], occurrences: [] };

it('todayItems lists open class work due today with its class and no checkbox', () => {
  const items = todayItems({
    ...empty,
    tasks: [task('Waiver')],
    occurrences: [occurrence('Calculus')],
    work: [
      work('Lab report'),
      work('Final', { kind: 'exam', priority: 5 }),
      work('Submitted', { status: 'submitted' }),
      work('Dropped', { status: 'cancelled' }),
      work('Archived class', { courseArchived: true }),
      work('Undated', { dueDate: null }),
      work('Tomorrow', { dueDate: '2026-10-15' }),
    ],
  });
  expect(items.map((item) => [item.kind, item.title])).toEqual([
    ['work', 'Final'],
    ['work', 'Lab report'],
    ['task', 'Waiver'],
    ['event', 'Calculus'],
  ]);
  expect(items[0]).toMatchObject({
    context: 'Exam · Chemistry',
    highPriority: true,
    action: null,
    target: { type: 'work', courseId: '00000000-0000-4000-8000-000000000021' },
  });
  expect(items[1]).toMatchObject({ context: 'Chemistry', highPriority: false });
});

it('todayItems gives tasks and tracked deadlines a completion action', () => {
  const due = task('Waiver', { priority: 'high' });
  const tracked = deadline('Essay', { version: 4, priority: 'high' });
  const items = todayItems({ ...empty, tasks: [due], deadlines: [tracked] });
  expect(items.map((item) => item.action)).toEqual([
    { type: 'deadline', id: tracked.id, version: 4 },
    { type: 'task', task: due },
  ]);
  expect(items.every((item) => item.highPriority)).toBe(true);
});

it('a completed tracked deadline keeps its raw Canvas entry hidden', () => {
  const raw = canvas('Raw Canvas title', {
    sourceUrl: 'https://canvas.colorado.edu/courses/1/assignments/2',
  });
  const input = {
    ...empty,
    canvas: [raw],
    deadlines: [
      deadline('Finished', { completedAt: '2026-10-14T10:00:00.000Z' }),
    ],
  };
  expect(todayItems(input)).toEqual([]);
  expect(upcomingDays(input)).toEqual([]);
  expect(overdueItems(input)).toEqual([]);
});

it('todayItems leaves later Canvas entries of a wider window to the week list', () => {
  const later = canvas('Exam review', {
    startDate: '2026-10-16',
    endDate: '2026-10-17',
  });
  const underWay = canvas('Reading days', {
    startDate: '2026-10-13',
    endDate: '2026-10-16',
  });
  const input = { ...empty, canvas: [later, underWay] };
  expect(todayItems(input).map((item) => item.title)).toEqual(['Reading days']);
  expect(upcomingDays(input)).toEqual([
    {
      date: '2026-10-16',
      items: [expect.objectContaining({ title: 'Exam review', action: null })],
    },
  ]);
});

it('overdueItems lists open tasks, class work and recent imported deadlines, newest first', () => {
  const recent = deadline('Recent quiz', {
    id: 'deadline-recent',
    canonicalKey: 'canvas:canvas.colorado.edu:/courses/1/quizzes/3',
    due: { kind: 'date', dueDate: '2026-10-12' },
  });
  const boundary = deadline('Boundary essay', {
    id: 'deadline-boundary',
    canonicalKey: 'canvas:canvas.colorado.edu:/courses/1/assignments/4',
    due: { kind: 'date', dueDate: '2026-09-30' },
  });
  const old = deadline('Old essay', {
    id: 'deadline-old',
    canonicalKey: 'canvas:canvas.colorado.edu:/courses/1/assignments/5',
    due: { kind: 'date', dueDate: '2026-09-29' },
  });
  expect(overdueDeadlineDays).toBe(14);
  const items = overdueItems({
    ...empty,
    tasks: [
      task('Old task', { dueDate: '2026-01-05' }),
      task('Yesterday', { dueDate: '2026-10-13' }),
      task('Finished', { dueDate: '2026-10-13', completed: true }),
      task('Due today'),
      task('Undated', { dueDate: null }),
    ],
    work: [
      work('Late lab', { dueDate: '2026-10-10' }),
      work('Late but submitted', {
        dueDate: '2026-10-10',
        status: 'submitted',
      }),
    ],
    deadlines: [
      recent,
      boundary,
      old,
      deadline('Done quiz', {
        id: 'deadline-done',
        canonicalKey: 'canvas:canvas.colorado.edu:/courses/1/quizzes/6',
        due: { kind: 'date', dueDate: '2026-10-12' },
        completedAt: '2026-10-12T10:00:00.000Z',
      }),
    ],
    canvas: [
      canvas('Raw past entry', {
        startDate: '2026-10-12',
        endDate: '2026-10-13',
      }),
    ],
  });
  expect(items.map((item) => [item.date, item.title])).toEqual([
    ['2026-10-13', 'Yesterday'],
    ['2026-10-12', 'Recent quiz'],
    ['2026-10-10', 'Late lab'],
    ['2026-09-30', 'Boundary essay'],
    ['2026-01-05', 'Old task'],
  ]);
});

it('upcomingDays groups the next seven days of deadlines by day', () => {
  const days = upcomingDays({
    ...empty,
    tasks: [
      task('Due today'),
      task('Tomorrow timed', {
        dueDate: '2026-10-15',
        dueAt: '2026-10-15T21:00:00.000Z',
        dueTimeZone: 'America/Denver',
      }),
      task('Tomorrow', { dueDate: '2026-10-15' }),
      task('Last day', { dueDate: '2026-10-21' }),
      task('Too far', { dueDate: '2026-10-22' }),
      task('Done', { dueDate: '2026-10-15', completed: true }),
    ],
    work: [work('Problem set', { dueDate: '2026-10-15' })],
    deadlines: [
      deadline('Tracked quiz', {
        due: {
          kind: 'timed',
          // 23:30 on Oct 16 in Denver, already Oct 17 in UTC.
          dueAt: '2026-10-17T05:30:00.000Z',
          timeZone: 'America/Denver',
        },
      }),
    ],
    occurrences: [
      occurrence('Lecture', {
        startsAt: '2026-10-15T15:00:00.000Z',
        endsAt: '2026-10-15T16:00:00.000Z',
      }),
    ],
  });
  expect(
    days.map((day) => [day.date, day.items.map((item) => item.title)]),
  ).toEqual([
    ['2026-10-15', ['Problem set', 'Tomorrow', 'Tomorrow timed']],
    ['2026-10-16', ['Tracked quiz']],
    ['2026-10-21', ['Last day']],
  ]);
});

it('a Canvas assignment outside the loaded deadline range is not listed as a raw entry', () => {
  // Its tracked deadline has a Personal Hub due date beyond the read range.
  const moved = canvas('Moved by the owner', {
    sourceUrl: 'https://canvas.colorado.edu/courses/1/assignments/77',
  });
  const event = canvas('Review session', { sourceUrl: null });
  const input = { ...empty, canvas: [moved, event] };
  expect(todayItems(input).map((item) => item.title)).toEqual([
    'Moved by the owner',
    'Review session',
  ]);
  expect(
    todayItems({ ...input, deadlinesComplete: true }).map((item) => item.title),
  ).toEqual(['Review session']);
});

it('todayLists returns the same three lists as the single builders', () => {
  const input = {
    ...empty,
    tasks: [
      task('Yesterday', { dueDate: '2026-10-13' }),
      task('Due today'),
      task('Tomorrow', { dueDate: '2026-10-15' }),
    ],
    work: [work('Lab report'), work('Late lab', { dueDate: '2026-10-10' })],
    deadlines: [deadline('Essay')],
    occurrences: [occurrence('Calculus')],
  };
  expect(todayLists(input)).toEqual({
    overdue: overdueItems(input),
    today: todayItems(input),
    days: upcomingDays(input),
  });
  expect(todayLists(input).overdue).toHaveLength(2);
  expect(todayLists(input).today).toHaveLength(4);
  expect(todayLists(input).days).toHaveLength(1);
});
