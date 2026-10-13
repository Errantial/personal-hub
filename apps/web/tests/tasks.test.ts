import { expect, it } from 'vitest';
import type { Task } from '@hub/contracts';
import {
  batchBody,
  countByFilter,
  groupTasks,
  matchesFilter,
} from '../src/lib/tasks';
import { refreshSelection } from '../src/lib/selection';

const today = '2026-10-12';
let counter = 0;
const task = (title: string, extra: Partial<Task> = {}): Task => ({
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  title,
  notes: '',
  dueDate: null,
  priority: 'normal',
  completed: false,
  sensitivity: 'unlabeled',
  version: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  deletedAt: null,
  canvasSource: null,
  academicSource: null,
  mailSource: null,
  ...extra,
});

const tasks = [
  task('Late', { dueDate: '2026-10-11' }),
  task('Now', { dueDate: today }),
  task('Edge', { dueDate: '2026-10-19' }),
  task('Beyond', { dueDate: '2026-10-20' }),
  task('Someday'),
  task('Finished', { dueDate: '2026-10-01', completed: true }),
];

it('filters by deadline without treating completed tasks as open', () => {
  const titles = (filter: Parameters<typeof matchesFilter>[1]) =>
    tasks
      .filter((item) => matchesFilter(item, filter, today))
      .map((i) => i.title);
  expect(titles('open')).toEqual(['Late', 'Now', 'Edge', 'Beyond', 'Someday']);
  expect(titles('overdue')).toEqual(['Late']);
  // Due soon covers today through seven days later, inclusive.
  expect(titles('due-soon')).toEqual(['Now', 'Edge']);
  expect(titles('no-date')).toEqual(['Someday']);
  expect(titles('done')).toEqual(['Finished']);
});

it('counts every filter over the whole list', () => {
  expect(countByFilter(tasks, today)).toEqual({
    open: 5,
    'due-soon': 2,
    overdue: 1,
    'no-date': 1,
    done: 1,
  });
});

it('groups open tasks by deadline in display order and omits empty groups', () => {
  expect(
    groupTasks(
      tasks.filter((i) => !i.completed),
      'open',
      today,
    ).map((group) => [group.label, group.tasks.map((item) => item.title)]),
  ).toEqual([
    ['Overdue', ['Late']],
    ['Today', ['Now']],
    ['Next 7 days', ['Edge']],
    ['Later', ['Beyond']],
    ['No date', ['Someday']],
  ]);
  expect(groupTasks([], 'overdue', today)).toEqual([]);
});

it('lists done tasks together, newest change first', () => {
  const groups = groupTasks(
    [
      task('Old', { completed: true, updatedAt: '2026-10-02T00:00:00.000Z' }),
      task('New', { completed: true, updatedAt: '2026-10-09T00:00:00.000Z' }),
    ],
    'done',
    today,
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]?.tasks.map((item) => item.title)).toEqual(['New', 'Old']);
});

it('builds selected-change requests with the versions seen at selection', () => {
  const selection = new Map([
    ['b', 3],
    ['a', 1],
  ]);
  const items = [
    { id: 'b', expectedVersion: 3 },
    { id: 'a', expectedVersion: 1 },
  ];
  expect(batchBody(selection, { kind: 'complete' })).toEqual({
    items,
    action: { kind: 'update', changes: { completed: true } },
  });
  expect(batchBody(selection, { kind: 'reopen' }).action).toEqual({
    kind: 'update',
    changes: { completed: false },
  });
  expect(
    batchBody(selection, { kind: 'priority', priority: 'low' }).action,
  ).toEqual({ kind: 'update', changes: { priority: 'low' } });
  expect(
    batchBody(selection, { kind: 'due', dueDate: '2026-11-01' }).action,
  ).toEqual({ kind: 'update', changes: { dueDate: '2026-11-01' } });
  // Clearing sends an explicit null; omitted fields stay unchanged.
  expect(batchBody(selection, { kind: 'clear-due' }).action).toEqual({
    kind: 'update',
    changes: { dueDate: null },
  });
  expect(batchBody(selection, { kind: 'delete' })).toEqual({
    items,
    action: { kind: 'delete' },
  });
});

it('refreshes a selection to latest versions and drops unavailable tasks', () => {
  const [kept, gone, blocked] = [task('Kept'), task('Gone'), task('Queued')];
  const selection = new Map([
    [kept.id, 1],
    [gone.id, 1],
    [blocked.id, 1],
  ]);
  const refreshed = refreshSelection(
    selection,
    [{ ...kept, version: 4 }, blocked],
    (item) => item.id !== blocked.id,
  );
  expect([...refreshed]).toEqual([[kept.id, 4]]);
});
