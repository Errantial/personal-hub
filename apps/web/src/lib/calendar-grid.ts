import {
  Temporal,
  canvasDeadlineIdentity,
  canvasItemInRange,
} from '@hub/contracts';
import type {
  CanvasItem,
  Occurrence,
  Task,
  TrackedDeadline,
} from '@hub/contracts';
import { occursOn } from './calendar';
import type { TodayItem } from './today';

/* Week/Day time-grid layout (docs/superpowers/specs/2026-10-14-ui-rework-design.md).
   Positions are minutes elapsed since local midnight in the viewing zone, so a
   daylight-saving day is 23 or 25 hours tall and nothing falls outside it. */

export type GridSource = 'event' | 'study' | 'canvas' | 'task';

type CalendarTarget = TodayItem['target'] | { type: 'deadline'; id: string };

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
  /** ISO instant when a compact chip represents a timed item; otherwise null. */
  time: string | null;
  target: CalendarTarget;
};

/** A semantic deadline point before it is positioned in the hour grid.
 *  Canvas is the first adapter; tracked deadlines can supply the same shape. */
export type DeadlinePoint = {
  key: string;
  source: GridSource;
  title: string;
  startsAt: string;
  target: CalendarTarget;
};

export type DeadlineMarker = DeadlinePoint & {
  /** Exact due minute from local midnight in the viewing zone. */
  top: number;
  /** Column within the shared event/deadline overlap group. */
  column: number;
  columns: number;
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

/** Raw Canvas timed entries adapted to the semantic deadline-point seam. */
export function canvasDeadlinePoints(items: CanvasItem[]): DeadlinePoint[] {
  return items.flatMap((item) => {
    const data = item.providerData;
    if (data.allDay || !data.startsAt) return [];
    return [
      {
        key: item.id,
        source: 'canvas' as const,
        title: data.title,
        startsAt: data.startsAt,
        target: { type: 'external' as const, url: data.sourceUrl },
      },
    ];
  });
}

/** Tracked timed deadlines adapted to the semantic deadline-point seam. */
export function trackedDeadlinePoints(
  items: TrackedDeadline[],
): DeadlinePoint[] {
  return items.flatMap((deadline) => {
    if (deadline.completedAt || deadline.due.kind !== 'timed') return [];
    return [
      {
        key: `tracked:${deadline.id}`,
        source: 'canvas' as const,
        title: deadline.title,
        startsAt: deadline.due.dueAt,
        target: { type: 'deadline' as const, id: deadline.id },
      },
    ];
  });
}

/** Prefer one tracked assignment/quiz deadline over its exact raw Canvas item.
 * Unsupported/noncanonical Canvas entries remain visible as raw source facts. */
export function rawCanvasWithoutTracked(
  canvas: CanvasItem[],
  deadlines: TrackedDeadline[],
) {
  const tracked = new Set(deadlines.map((deadline) => deadline.canonicalKey));
  return canvas.filter((item) => {
    const identity = canvasDeadlineIdentity(item.providerData.sourceUrl);
    return !identity || !tracked.has(identity.canonicalKey);
  });
}

/** Open owner tasks with a specific due instant adapted to deadline points. */
export function taskDeadlinePoints(items: Task[]): DeadlinePoint[] {
  return items.flatMap((task) => {
    if (task.completed || !task.dueAt) return [];
    return [
      {
        key: `task:${task.id}`,
        source: 'task' as const,
        title: task.title,
        startsAt: task.dueAt,
        target: { type: 'task' as const, id: task.id },
      },
    ];
  });
}

/** Deadline points whose instant falls on one local viewing day. */
export function deadlinePointsOnDay(
  items: DeadlinePoint[],
  day: string,
  timeZone: string,
) {
  const start = midnight(day, timeZone).epochMilliseconds;
  const end = midnight(
    Temporal.PlainDate.from(day).add({ days: 1 }).toString(),
    timeZone,
  ).epochMilliseconds;
  return items.filter((item) => {
    const instant = Date.parse(item.startsAt);
    return instant >= start && instant < end;
  });
}

type LaneItem = {
  top: number;
  span: number;
  key: string;
  column: number;
  columns: number;
};

function assignOverlapColumns(items: LaneItem[]) {
  const placed = [...items].sort(
    (a, b) => a.top - b.top || a.key.localeCompare(b.key),
  );
  let group: LaneItem[] = [];
  let groupEnd = -Infinity;
  let columnEnds: number[] = [];
  const close = () => {
    for (const item of group) item.columns = columnEnds.length;
  };
  for (const item of placed) {
    const end = item.top + item.span;
    if (item.top >= groupEnd) {
      close();
      group = [];
      columnEnds = [];
    }
    const free = columnEnds.findIndex((columnEnd) => columnEnd <= item.top);
    item.column = free === -1 ? columnEnds.length : free;
    columnEnds[item.column] = end;
    group.push(item);
    groupEnd = Math.max(groupEnd, end);
  }
  close();
}

/** Timed occurrences and semantic deadline points for one local day. They share
 *  overlap columns, while deadlines remain points rather than fake events. */
export function layoutDayWithDeadlines(
  items: Occurrence[],
  deadlines: DeadlinePoint[],
  day: string,
  timeZone: string,
) {
  const start = midnight(day, timeZone).epochMilliseconds;
  const length = dayLength(day, timeZone);
  const minutes = (instant: string) => (Date.parse(instant) - start) / 60000;
  const blocks = items
    .filter((item) => !item.allDay && occursOn(item, day, timeZone))
    .map((item): Block => {
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
  const markers = deadlinePointsOnDay(deadlines, day, timeZone)
    .map((item): DeadlineMarker => ({
      ...item,
      top: minutes(item.startsAt),
      column: 0,
      columns: 1,
    }))
    .sort((a, b) => a.top - b.top || a.title.localeCompare(b.title));

  const lanes = [
    ...blocks.map((block) => ({
      key: `block:${block.key}`,
      item: block,
      top: block.top,
      span: Math.max(block.height, minimumSpan),
      column: 0,
      columns: 1,
    })),
    ...markers.map((marker) => ({
      key: `deadline:${marker.key}`,
      item: marker,
      top: marker.top,
      span: minimumSpan,
      column: 0,
      columns: 1,
    })),
  ];
  assignOverlapColumns(lanes);
  for (const lane of lanes) {
    lane.item.column = lane.column;
    lane.item.columns = lane.columns;
  }
  return { blocks, deadlines: markers };
}

/** Timed occurrences on `day` as positioned blocks; overlapping blocks share
 *  the width in equal columns. */
export function layoutDay(
  items: Occurrence[],
  day: string,
  timeZone: string,
): Block[] {
  return layoutDayWithDeadlines(items, [], day, timeZone).blocks;
}

/** The strip above the grid: all-day events, date-only Canvas deadlines and
 *  open tasks due that day. Timed deadlines belong in the hour grid. */
export function allDayStrip(
  day: string,
  input: {
    occurrences: Occurrence[];
    canvas: CanvasItem[];
    tasks: Task[];
    deadlines?: TrackedDeadline[];
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
      .filter(
        (item) =>
          item.providerData.allDay &&
          canvasItemInRange(item, day, next, input.timeZone),
      )
      .map((item): StripItem => ({
        key: item.id,
        source: 'canvas',
        title: item.providerData.title,
        time: null,
        target: { type: 'external', url: item.providerData.sourceUrl },
      }))
      .sort(byTitle),
    ...(input.deadlines ?? [])
      .filter(
        (deadline) =>
          !deadline.completedAt &&
          deadline.due.kind === 'date' &&
          deadline.due.dueDate === day,
      )
      .sort(byTitle)
      .map((deadline): StripItem => ({
        key: `tracked:${deadline.id}`,
        source: 'canvas',
        title: deadline.title,
        time: null,
        target: { type: 'deadline', id: deadline.id },
      })),
    ...input.tasks
      .filter((task) => !task.completed && !task.dueAt && task.dueDate === day)
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
