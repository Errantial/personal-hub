import { Temporal, canvasItemInRange } from '@hub/contracts';
import type { CanvasItem, Occurrence, Task } from '@hub/contracts';
import { occursOn } from './calendar';
import type { TodayItem } from './today';

/* Week/Day time-grid layout (docs/superpowers/specs/2026-10-14-ui-rework-design.md).
   Positions are minutes elapsed since local midnight in the viewing zone, so a
   daylight-saving day is 23 or 25 hours tall and nothing falls outside it. */

export type GridSource = 'event' | 'study' | 'canvas' | 'task';

export type Block = {
  key: string;
  source: GridSource;
  title: string;
  /** Minutes from local midnight in the viewing zone, clipped to [0, dayLength]. */
  top: number;
  height: number;
  /** Column within its overlap group, and the group's column count. */
  column: number;
  columns: number;
  occurrence: Occurrence;
};

export type StripItem = {
  key: string;
  source: GridSource;
  title: string;
  /** ISO instant of a timed Canvas deadline; null for all-day items. */
  time: string | null;
  target: TodayItem['target'];
};

/** Overlap is judged on at least this many minutes, so very short events
 *  still get their own readable column. */
const minimumSpan = 15;

const midnight = (day: string, timeZone: string) =>
  Temporal.PlainDate.from(day).toZonedDateTime(timeZone);

/** Minutes in a local day: 1380, 1440 or 1500. */
export function dayLength(day: string, timeZone: string) {
  const start = midnight(day, timeZone);
  return (
    (start.add({ days: 1 }).epochMilliseconds - start.epochMilliseconds) / 60000
  );
}

const sourceOf = (item: Occurrence): GridSource =>
  item.courseId ? 'study' : 'event';

/** Timed occurrences on `day` as positioned blocks; overlapping blocks share
 *  the width in equal columns. */
export function layoutDay(
  items: Occurrence[],
  day: string,
  timeZone: string,
): Block[] {
  const start = midnight(day, timeZone).epochMilliseconds;
  const length = dayLength(day, timeZone);
  const minutes = (instant: string) => (Date.parse(instant) - start) / 60000;
  const placed = items
    .filter((item) => !item.allDay && occursOn(item, day, timeZone))
    .map((item) => {
      const top = Math.max(0, minutes(item.startsAt));
      const bottom = Math.min(length, minutes(item.endsAt));
      return {
        key: item.occurrenceId,
        source: sourceOf(item),
        title: item.title,
        top,
        height: Math.max(0, bottom - top),
        column: 0,
        columns: 1,
        occurrence: item,
      };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  // Groups of transitively overlapping blocks; within one, each block takes
  // the first column that is free at its start.
  let group: Block[] = [];
  let groupEnd = -Infinity;
  let columnEnds: number[] = [];
  const close = () => {
    for (const block of group) block.columns = columnEnds.length;
  };
  for (const block of placed) {
    const end = block.top + Math.max(block.height, minimumSpan);
    if (block.top >= groupEnd) {
      close();
      group = [];
      columnEnds = [];
    }
    const free = columnEnds.findIndex((columnEnd) => columnEnd <= block.top);
    block.column = free === -1 ? columnEnds.length : free;
    columnEnds[block.column] = end;
    group.push(block);
    groupEnd = Math.max(groupEnd, end);
  }
  close();
  return placed;
}

/** The strip above the grid: all-day events, Canvas deadlines (all-day or
 *  timed, which are single moments) and open tasks due that day. */
export function allDayStrip(
  day: string,
  input: {
    occurrences: Occurrence[];
    canvas: CanvasItem[];
    tasks: Task[];
    timeZone: string;
  },
): StripItem[] {
  const next = Temporal.PlainDate.from(day).add({ days: 1 }).toString();
  const byTitle = (a: { title: string }, b: { title: string }) =>
    a.title.localeCompare(b.title);
  return [
    ...input.occurrences
      .filter((item) => item.allDay && occursOn(item, day, input.timeZone))
      .sort(byTitle)
      .map((item): StripItem => ({
        key: item.occurrenceId,
        source: sourceOf(item),
        title: item.title,
        time: null,
        target: {
          type: 'event',
          id: item.id,
          date: item.recurrence ? item.originalDate : null,
        },
      })),
    ...input.canvas
      .filter((item) => canvasItemInRange(item, day, next, input.timeZone))
      .map((item): StripItem => ({
        key: item.id,
        source: 'canvas',
        title: item.providerData.title,
        time: item.providerData.allDay ? null : item.providerData.startsAt,
        target: { type: 'external', url: item.providerData.sourceUrl },
      }))
      .sort(
        (a, b) =>
          Number(a.time !== null) - Number(b.time !== null) ||
          (a.time ?? '').localeCompare(b.time ?? '') ||
          byTitle(a, b),
      ),
    ...input.tasks
      .filter((task) => !task.completed && task.dueDate === day)
      .sort(byTitle)
      .map((task): StripItem => ({
        key: task.id,
        source: 'task',
        title: task.title,
        time: null,
        target: { type: 'task', id: task.id },
      })),
  ];
}
