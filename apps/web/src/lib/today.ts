import { canvasDeadlineIdentity } from '@hub/contracts';
import type {
  CanvasItem,
  Occurrence,
  Task,
  TrackedDeadline,
} from '@hub/contracts';
import { dueFallsOn } from './deadlines';

/* Today's single list (docs/superpowers/specs/2026-10-14-ui-rework-design.md):
   Canvas deadlines, tasks due today, events and study time in one order. */

export type TodayKind = 'deadline' | 'task' | 'event' | 'study';
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
  target:
    | { type: 'task'; id: string }
    | { type: 'event'; id: string; date: string | null }
    | { type: 'external'; url: string | null };
};

/** 0: all-day deadlines and due tasks; 1: all-day events; 2: timed. */
const group = (item: TodayItem) =>
  !item.allDay ? 2 : item.kind === 'deadline' || item.kind === 'task' ? 0 : 1;

/** Today's open tasks, occurrences and Canvas items, in reading order. */
export function todayItems(input: {
  tasks: Task[];
  occurrences: Occurrence[];
  canvas: CanvasItem[];
  deadlines?: TrackedDeadline[];
  today: string;
  timeZone: string;
}): TodayItem[] {
  const deadlines = input.deadlines ?? [];
  const trackedKeys = new Set(deadlines.map((item) => item.canonicalKey));
  const items: TodayItem[] = [
    ...deadlines
      .filter(
        (item) =>
          !item.completedAt &&
          dueFallsOn(item.due, input.today, input.timeZone),
      )
      .map((item): TodayItem => ({
        key: `deadline-${item.id}`,
        kind: 'deadline',
        title: item.title,
        allDay: item.due.kind !== 'timed',
        start: item.due.kind === 'timed' ? item.due.dueAt : null,
        end: null,
        timeZone: item.due.kind === 'timed' ? item.due.timeZone : null,
        deadlineId: item.id,
        cancelled: item.sourceAvailability !== 'available',
        target: { type: 'external', url: null },
      })),
    ...input.canvas
      .filter((item) => {
        const identity = canvasDeadlineIdentity(item.providerData.sourceUrl);
        return !identity || !trackedKeys.has(identity.canonicalKey);
      })
      .map((item): TodayItem => ({
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
        target: { type: 'external', url: item.providerData.sourceUrl },
      })),
    ...input.tasks
      .filter((task) => !task.completed && task.dueDate === input.today)
      .map((task): TodayItem => ({
        key: task.id,
        kind: 'task',
        title: task.title,
        allDay: !task.dueAt,
        start: task.dueAt,
        end: null,
        timeZone: task.dueTimeZone,
        deadlineId: null,
        cancelled: false,
        target: { type: 'task', id: task.id },
      })),
    ...input.occurrences.map((item): TodayItem => ({
      key: item.occurrenceId,
      kind: item.courseId ? 'study' : 'event',
      title: item.title,
      allDay: item.allDay,
      start: item.allDay ? null : item.startsAt,
      end: item.allDay ? null : item.endsAt,
      timeZone: null,
      deadlineId: null,
      cancelled: false,
      target: { type: 'event', id: item.id, date: item.originalDate },
    })),
  ];
  return items.sort(
    (a, b) =>
      group(a) - group(b) ||
      (a.start ?? '').localeCompare(b.start ?? '') ||
      a.title.localeCompare(b.title),
  );
}
