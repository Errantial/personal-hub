import {
  Temporal,
  canvasDeadlineIdentity,
  canvasItemInRange,
} from '@hub/contracts';
import type {
  AcademicWorkBrowseResponse,
  CanvasItem,
  Occurrence,
  Task,
  TrackedDeadline,
} from '@hub/contracts';
import { dueDay } from './deadlines';

/* Today's lists (docs/superpowers/specs/2026-10-14-ui-rework-design.md):
   what is overdue, what is due or scheduled today, and what is due in the
   next seven days. Tasks, imported deadlines and class work are deadlines;
   events and study time are reservations. Nothing here changes a deadline. */

export type TodayKind = 'deadline' | 'task' | 'work' | 'event' | 'study';
export type WorkItem = AcademicWorkBrowseResponse['work'][number];
/** Where a planner row leads; shared with the calendar's strip and blocks. */
export type PlannerTarget =
  | { type: 'task'; id: string }
  | { type: 'event'; id: string; date: string | null }
  | { type: 'external'; url: string | null };
export type TodayItem = {
  key: string;
  kind: TodayKind;
  title: string;
  allDay: boolean;
  /** ISO instant for timed items; null for all-day/date-only deadlines. */
  start: string | null;
  end: string | null;
  /** Explicit display zone for a task deadline; other items use the viewing zone. */
  timeZone: string | null;
  /** Tracked deadline editor target; kept separate from Calendar's shared target union. */
  deadlineId: string | null;
  /** A Canvas item the source cancelled or no longer lists. */
  cancelled: boolean;
  /** Local day the item is due or starts, in the viewing zone. */
  date: string;
  /** The class a piece of work belongs to. */
  context: string | null;
  highPriority: boolean;
  /** What the row's checkbox completes; null when the row has none. */
  action:
    | { type: 'task'; task: Task }
    | { type: 'deadline'; id: string; version: number }
    | null;
  target: PlannerTarget | { type: 'work'; courseId: string };
};

/** Next 7 days: deadlines due from tomorrow through this many days ahead. */
export const upcomingDayCount = 7;
/** Imported deadlines stay under Overdue for this many days after they are
 *  due. Canvas does not report submissions, so older ones would only pile up;
 *  they remain in Tasks › Imported deadlines. */
export const overdueDeadlineDays = 14;

export type TodayInput = {
  tasks: Task[];
  occurrences: Occurrence[];
  canvas: CanvasItem[];
  deadlines?: TrackedDeadline[];
  /** The imported-deadline read loaded in full. Every Canvas assignment or
   *  quiz is tracked, so one that is not listed was moved out of range by a
   *  Personal Hub due date and its raw entry must not stand in for it. */
  deadlinesComplete?: boolean;
  work?: WorkItem[];
  today: string;
  timeZone: string;
};

const addDays = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

const taskItem = (task: Task): TodayItem => ({
  key: task.id,
  kind: 'task',
  title: task.title,
  allDay: !task.dueAt,
  start: task.dueAt,
  end: null,
  timeZone: task.dueTimeZone,
  deadlineId: null,
  cancelled: false,
  date: task.dueDate!,
  context: null,
  highPriority: task.priority === 'high',
  action: { type: 'task', task },
  target: { type: 'task', id: task.id },
});

const deadlineItem = (item: TrackedDeadline, date: string): TodayItem => ({
  key: `deadline-${item.id}`,
  kind: 'deadline',
  title: item.title,
  allDay: item.due.kind !== 'timed',
  start: item.due.kind === 'timed' ? item.due.dueAt : null,
  end: null,
  timeZone: item.due.kind === 'timed' ? item.due.timeZone : null,
  deadlineId: item.id,
  cancelled: item.sourceAvailability !== 'available',
  date,
  context: null,
  highPriority: item.priority === 'high',
  action: { type: 'deadline', id: item.id, version: item.version },
  target: { type: 'external', url: null },
});

const workItem = (item: WorkItem): TodayItem => ({
  key: `work-${item.id}`,
  kind: 'work',
  title: item.title,
  allDay: true,
  start: null,
  end: null,
  timeZone: null,
  deadlineId: null,
  cancelled: false,
  date: item.dueDate!,
  context: item.kind === 'exam' ? `Exam · ${item.courseName}` : item.courseName,
  // Class work ranks 1-5; the upper two read like a task's High priority.
  highPriority: item.priority >= 4,
  action: null,
  target: { type: 'work', courseId: item.courseId },
});

const canvasItem = (item: CanvasItem, date: string): TodayItem => ({
  key: item.id,
  kind: 'deadline',
  title: item.providerData.title,
  allDay: item.providerData.allDay,
  start: item.providerData.allDay ? null : item.providerData.startsAt,
  end: item.providerData.allDay ? null : item.providerData.endsAt,
  timeZone: null,
  deadlineId: null,
  cancelled:
    item.availability !== undefined && item.availability !== 'available',
  date,
  context: null,
  highPriority: false,
  action: null,
  target: { type: 'external', url: item.providerData.sourceUrl },
});

/** The local day a raw Canvas entry falls on; an entry already under way
 *  counts as today. Null when it has no usable date. */
function canvasDay(item: CanvasItem, today: string, timeZone: string) {
  if (canvasItemInRange(item, today, addDays(today, 1), timeZone)) return today;
  const data = item.providerData;
  if (data.allDay) return data.startDate;
  return data.startsAt
    ? Temporal.Instant.from(data.startsAt)
        .toZonedDateTimeISO(timeZone)
        .toPlainDate()
        .toString()
    : null;
}

/** Every open deadline with a date: tasks, imported deadlines (preferred over
 *  their raw Canvas entry, also once completed), other Canvas entries and
 *  class work in active classes. */
function dueItems(input: TodayInput): TodayItem[] {
  const deadlines = input.deadlines ?? [];
  const trackedKeys = new Set(deadlines.map((item) => item.canonicalKey));
  const items: TodayItem[] = [];
  for (const item of deadlines) {
    const date = dueDay(item.due, input.timeZone);
    if (!item.completedAt && date) items.push(deadlineItem(item, date));
  }
  for (const item of input.canvas) {
    const identity = canvasDeadlineIdentity(item.providerData.sourceUrl);
    if (
      identity &&
      (input.deadlinesComplete || trackedKeys.has(identity.canonicalKey))
    )
      continue;
    const date = canvasDay(item, input.today, input.timeZone);
    if (date) items.push(canvasItem(item, date));
  }
  for (const task of input.tasks)
    if (!task.completed && task.dueDate) items.push(taskItem(task));
  for (const item of input.work ?? [])
    if (
      (item.status === 'planned' || item.status === 'in_progress') &&
      item.dueDate &&
      !item.courseArchived &&
      !item.deletedAt
    )
      items.push(workItem(item));
  return items;
}

/** 0: all-day deadlines, due tasks and class work; 1: all-day events; 2: timed. */
const group = (item: TodayItem) =>
  !item.allDay ? 2 : item.kind === 'event' || item.kind === 'study' ? 1 : 0;

const inDay = (a: TodayItem, b: TodayItem) =>
  group(a) - group(b) ||
  (a.start ?? '').localeCompare(b.start ?? '') ||
  a.title.localeCompare(b.title) ||
  a.key.localeCompare(b.key);

const occurrenceItem = (item: Occurrence, today: string): TodayItem => ({
  key: item.occurrenceId,
  kind: item.courseId ? 'study' : 'event',
  title: item.title,
  allDay: item.allDay,
  start: item.allDay ? null : item.startsAt,
  end: item.allDay ? null : item.endsAt,
  timeZone: null,
  deadlineId: null,
  cancelled: false,
  date: today,
  context: null,
  highPriority: false,
  action: null,
  target: { type: 'event', id: item.id, date: item.originalDate },
});

function todayOf(due: TodayItem[], input: TodayInput) {
  return [
    ...due.filter((item) => item.date === input.today),
    ...input.occurrences.map((item) => occurrenceItem(item, input.today)),
  ].sort(inDay);
}

function overdueOf(due: TodayItem[], input: TodayInput) {
  const oldestDeadline = addDays(input.today, -overdueDeadlineDays);
  return due
    .filter(
      (item) =>
        item.date < input.today &&
        (item.kind === 'task' ||
          item.kind === 'work' ||
          (item.deadlineId !== null && item.date >= oldestDeadline)),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || inDay(a, b));
}

function upcomingOf(due: TodayItem[], input: TodayInput) {
  const last = addDays(input.today, upcomingDayCount);
  const days = new Map<string, TodayItem[]>();
  for (const item of due) {
    if (item.date <= input.today || item.date > last) continue;
    const list = days.get(item.date) ?? [];
    list.push(item);
    days.set(item.date, list);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({ date, items: items.sort(inDay) }));
}

/** Today's open tasks, deadlines, class work and occurrences, in reading order. */
export const todayItems = (input: TodayInput): TodayItem[] =>
  todayOf(dueItems(input), input);

/** Open deadlines from before today, most recently due first. Raw Canvas
 *  entries have no completion state and are never listed as overdue; imported
 *  deadlines leave this list after `overdueDeadlineDays`. */
export const overdueItems = (input: TodayInput): TodayItem[] =>
  overdueOf(dueItems(input), input);

/** Deadlines due after today through the next seven days, one group per day
 *  that has any. */
export const upcomingDays = (
  input: TodayInput,
): { date: string; items: TodayItem[] }[] => upcomingOf(dueItems(input), input);

/** The three Today lists from one pass over the loaded records. */
export function todayLists(input: TodayInput) {
  const due = dueItems(input);
  return {
    overdue: overdueOf(due, input),
    today: todayOf(due, input),
    days: upcomingOf(due, input),
  };
}
