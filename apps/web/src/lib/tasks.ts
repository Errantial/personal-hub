import { Temporal } from '@hub/contracts';
import type { Task } from '@hub/contracts';
import type { TaskFilter } from './router';

/* Pure task filtering and grouping for the Tasks screen. Dates are
   date-only local deadlines; none of this changes a task's own deadline. */

export type TaskGroupId = 'overdue' | 'today' | 'week' | 'later' | 'none';
export const groupLabels: Record<TaskGroupId, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'Next 7 days',
  later: 'Later',
  none: 'No date',
};

/** Open tasks due from today through the following seven days. */
export const dueSoonDays = 7;

const isOpen = (task: Task) => !task.completed;
const weekEnd = (today: string) =>
  Temporal.PlainDate.from(today).add({ days: dueSoonDays }).toString();

export function groupOf(task: Task, today: string): TaskGroupId {
  if (!task.dueDate) return 'none';
  if (task.dueDate < today) return 'overdue';
  if (task.dueDate === today) return 'today';
  return task.dueDate <= weekEnd(today) ? 'week' : 'later';
}

const matchers: Record<TaskFilter, (task: Task, today: string) => boolean> = {
  open: isOpen,
  'due-soon': (task, today) => {
    const group = groupOf(task, today);
    return isOpen(task) && (group === 'today' || group === 'week');
  },
  overdue: (task, today) => isOpen(task) && groupOf(task, today) === 'overdue',
  'no-date': (task) => isOpen(task) && !task.dueDate,
  done: (task) => task.completed,
};

export const matchesFilter = (task: Task, filter: TaskFilter, today: string) =>
  matchers[filter](task, today);

export function countByFilter(
  tasks: readonly Task[],
  today: string,
): Record<TaskFilter, number> {
  const counts = { open: 0, 'due-soon': 0, overdue: 0, 'no-date': 0, done: 0 };
  for (const task of tasks)
    for (const filter of Object.keys(counts) as TaskFilter[])
      if (matchers[filter](task, today)) counts[filter]++;
  return counts;
}

const byDeadline = (a: Task, b: Task) =>
  (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
  a.title.localeCompare(b.title) ||
  a.id.localeCompare(b.id);

/** Done tasks list most recently changed first; the rest by deadline. */
export function sortTasks(tasks: readonly Task[], filter: TaskFilter) {
  return [...tasks].sort(
    filter === 'done'
      ? (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byDeadline(a, b)
      : byDeadline,
  );
}

/** Deadline groups in display order. Completed tasks stay in one flat group. */
export function groupTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
  today: string,
): { id: TaskGroupId | 'done'; label: string; tasks: Task[] }[] {
  const sorted = sortTasks(tasks, filter);
  if (filter === 'done')
    return sorted.length ? [{ id: 'done', label: 'Done', tasks: sorted }] : [];
  const order: TaskGroupId[] = ['overdue', 'today', 'week', 'later', 'none'];
  return order
    .map((id) => ({
      id,
      label: groupLabels[id],
      tasks: sorted.filter((task) => groupOf(task, today) === id),
    }))
    .filter((group) => group.tasks.length > 0);
}

/* Selected changes (POST /api/v1/tasks/batch). A selection maps task IDs to
   the versions seen when they were selected, in selection order, so a change
   made elsewhere afterwards makes the whole batch conflict instead of being
   overwritten. */

export const maxSelection = 100;
export type TaskSelection = ReadonlyMap<string, number>;
export type BatchChange =
  | { kind: 'complete' }
  | { kind: 'reopen' }
  | { kind: 'priority'; priority: Task['priority'] }
  | { kind: 'due'; dueDate: string }
  | { kind: 'clear-due' }
  | { kind: 'delete' };

/** Request body without operationId, which the mutation hook adds. */
export function batchBody(selection: TaskSelection, change: BatchChange) {
  const items = [...selection].map(([id, expectedVersion]) => ({
    id,
    expectedVersion,
  }));
  const changes =
    change.kind === 'complete'
      ? { completed: true }
      : change.kind === 'reopen'
        ? { completed: false }
        : change.kind === 'priority'
          ? { priority: change.priority }
          : change.kind === 'due'
            ? { dueDate: change.dueDate }
            : { dueDate: null };
  return {
    items,
    action:
      change.kind === 'delete'
        ? { kind: 'delete' }
        : { kind: 'update', changes },
  };
}

/** A deliberate refresh after a conflict: keeps selected tasks that are still
 *  listed and selectable, at their latest versions. */
export function refreshSelection(
  selection: TaskSelection,
  tasks: readonly Task[],
  selectable: (task: Task) => boolean,
): Map<string, number> {
  const latest = new Map(tasks.map((task) => [task.id, task]));
  const next = new Map<string, number>();
  for (const id of selection.keys()) {
    const task = latest.get(id);
    if (task && selectable(task)) next.set(id, task.version);
  }
  return next;
}
