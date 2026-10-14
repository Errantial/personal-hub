import type { CanvasItem, Occurrence, Task } from '@hub/contracts';

/* Today's single list (docs/superpowers/specs/2026-10-14-ui-rework-design.md):
   Canvas deadlines, tasks due today, events and study time in one order. */

export type TodayKind = 'deadline' | 'task' | 'event' | 'study';
export type TodayItem = {
  key: string;
  kind: TodayKind;
  title: string;
  allDay: boolean;
  /** ISO instant for timed items; null for all-day and due tasks. */
  start: string | null;
  end: string | null;
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
  today: string;
  timeZone: string;
}): TodayItem[] {
  const items: TodayItem[] = [
    ...input.canvas.map((item): TodayItem => ({
      key: item.id,
      kind: 'deadline',
      title: item.providerData.title,
      allDay: item.providerData.allDay,
      start: item.providerData.allDay ? null : item.providerData.startsAt,
      end: item.providerData.allDay ? null : item.providerData.endsAt,
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
        allDay: true,
        start: null,
        end: null,
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
