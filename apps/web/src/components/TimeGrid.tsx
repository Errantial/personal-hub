import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Temporal } from '@hub/contracts';
import type { CanvasItem, Occurrence, Task } from '@hub/contracts';
import { timeLabel } from '../lib/calendar';
import { allDayStrip, dayLength, layoutDay } from '../lib/calendar-grid';
import type { StripItem } from '../lib/calendar-grid';
import type { Route } from '../lib/router';
import type { SourceVisibility } from './CalendarShell';
import { Link } from './Link';
import './TimeGrid.css';

type CalendarRoute = Extract<Route, { name: 'calendar' }>;

const at = (day: string) => new Date(`${day}T12:00:00Z`);
const weekday = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  timeZone: 'UTC',
});
const fullDay = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const hourFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  timeZone: 'UTC',
});
const shortTime = (timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });

/** Where the grid opens: 07:00, or earlier if something starts before. */
const openingMinute = 7 * 60;

/** The route for an occurrence's editor, keeping the visible window. */
export const editorRoute = (
  base: CalendarRoute,
  item: Occurrence,
): CalendarRoute => ({
  ...base,
  editor: item.recurrence
    ? { kind: 'occurrence', id: item.id, date: item.originalDate }
    : { kind: 'event', id: item.id },
});

/** A strip or month chip: event and task chips open their editors, Canvas
 *  chips open the source. */
export function Chip({
  item,
  base,
  timeZone,
  navigate,
}: {
  item: StripItem;
  base: CalendarRoute;
  timeZone: string;
  navigate: (route: Route) => void;
}) {
  const className = `calendar-chip calendar-chip--${item.source}`;
  const text: ReactNode = (
    <>
      <span className="calendar-chip__type">{chipTypes[item.source]}</span>
      {item.time && (
        <span className="calendar-chip__time">
          {shortTime(timeZone).format(new Date(item.time))}{' '}
        </span>
      )}
      {item.title}
    </>
  );
  const target = item.target;
  if (target.type === 'task')
    return (
      <Link
        className={className}
        route={{ name: 'tasks', id: target.id }}
        navigate={navigate}
      >
        {text}
      </Link>
    );
  if (target.type === 'event')
    return (
      <Link
        className={className}
        route={{
          ...base,
          editor: target.date
            ? { kind: 'occurrence', id: target.id, date: target.date }
            : { kind: 'event', id: target.id },
        }}
        navigate={navigate}
      >
        {text}
      </Link>
    );
  return target.url ? (
    <a className={className} href={target.url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className={className}>{text}</span>
  );
}
/** Type names, visible only in e-ink mode where color is not used. */
const chipTypes: Record<StripItem['source'], string> = {
  event: 'Event: ',
  study: 'Study: ',
  canvas: 'Deadline: ',
  task: 'Task: ',
};

/**
 * Week and Day views: an all-day strip, then hour rows with timed events as
 * blocks sized by duration. An empty hour starts a new event at that time.
 * Positions use elapsed minutes in the viewing zone (see calendar-grid).
 */
export function TimeGrid({
  days,
  today,
  timeZone,
  occurrences,
  canvas,
  tasks,
  sources,
  base,
  navigate,
}: {
  days: string[];
  today: string;
  timeZone: string;
  occurrences: Occurrence[];
  canvas: CanvasItem[];
  tasks: Task[];
  sources: SourceVisibility;
  base: CalendarRoute;
  navigate: (route: Route) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const columns = days.map((day) => ({
    day,
    length: dayLength(day, timeZone),
    blocks: layoutDay(occurrences, day, timeZone).filter(
      (block) => sources[block.source],
    ),
    strip: allDayStrip(day, { occurrences, canvas, tasks, timeZone }).filter(
      (item) => sources[item.source],
    ),
  }));
  const longest = Math.max(...columns.map((column) => column.length));
  const hours = Array.from({ length: Math.ceil(longest / 60) }, (_, i) => i);
  const now = useNow();
  const nowMinute =
    (now -
      Temporal.PlainDate.from(today).toZonedDateTime(timeZone)
        .epochMilliseconds) /
    60000;

  // Open at 07:00 or the first block of the window, whichever is earlier.
  const first = Math.min(
    openingMinute,
    ...columns.flatMap((column) => column.blocks.map((block) => block.top)),
  );
  useLayoutEffect(() => {
    if (!scroller.current || !body.current) return;
    scroller.current.scrollTop = (first / longest) * body.current.offsetHeight;
    // Only when the window changes, not on every data reload.
  }, [days[0], days.length, timeZone]);

  return (
    <div
      className="time-grid"
      style={{ '--days': days.length } as CSSProperties}
    >
      <div className="time-grid__head">
        <span className="time-grid__corner" />
        {columns.map(({ day }) => (
          <Link
            key={day}
            className="time-grid__date"
            route={{ name: 'calendar', view: 'day', date: day }}
            navigate={navigate}
            label={fullDay.format(at(day))}
          >
            <span className="time-grid__weekday">
              {weekday.format(at(day))}
            </span>{' '}
            <span
              className={`time-grid__daynum${day === today ? ' time-grid__daynum--today' : ''}`}
            >
              {Number(day.slice(8))}
            </span>
          </Link>
        ))}
      </div>
      <div className="time-grid__strip">
        <span className="time-grid__corner time-grid__allday">All day</span>
        {columns.map(({ day, strip }) => (
          <ul
            key={day}
            className="time-grid__chips"
            aria-label={`All day, ${fullDay.format(at(day))}`}
          >
            {strip.map((item) => (
              <li key={item.key}>
                <Chip
                  item={item}
                  base={base}
                  timeZone={timeZone}
                  navigate={navigate}
                />
              </li>
            ))}
          </ul>
        ))}
      </div>
      <div
        className="time-grid__scroll"
        ref={scroller}
        // Scrollable by keyboard; blocks and New event stay reachable by Tab.
        tabIndex={0}
        role="group"
        aria-label="Hours"
      >
        <div
          className="time-grid__body"
          ref={body}
          style={{ '--minutes': longest } as CSSProperties}
        >
          <div className="time-grid__gutter" aria-hidden="true">
            {hours.map((hour) => (
              <span
                key={hour}
                className="time-grid__hour"
                style={{ top: `calc(${hour} * var(--hour))` }}
              >
                {hour > 0 &&
                  hourFormat.format(new Date(Date.UTC(2000, 0, 1, hour)))}
              </span>
            ))}
          </div>
          {columns.map(({ day, length, blocks }) => {
            const midnight =
              Temporal.PlainDate.from(day).toZonedDateTime(timeZone);
            return (
              <div
                key={day}
                className="time-grid__day"
                style={{ '--length': length } as CSSProperties}
              >
                {Array.from({ length: Math.ceil(length / 60) }, (_, hour) => {
                  const slot = midnight.add({ hours: hour }).toPlainDateTime();
                  const start = slot.toString({ smallestUnit: 'minute' });
                  return (
                    <button
                      key={hour}
                      type="button"
                      tabIndex={-1}
                      className="time-grid__slot"
                      style={{ top: `calc(${hour} * var(--hour))` }}
                      aria-label={`New event ${weekday.format(at(day))} ${hourFormat.format(new Date(Date.UTC(2000, 0, 1, slot.hour)))}`}
                      onClick={() =>
                        navigate({ ...base, editor: { kind: 'new', start } })
                      }
                    />
                  );
                })}
                {blocks.map((block) => (
                  <Link
                    key={block.key}
                    className={`time-grid__block calendar-chip--${block.source}${
                      block.occurrence.studyStatus === 'cancelled'
                        ? ' time-grid__block--cancelled'
                        : ''
                    }`}
                    style={{
                      top: `calc(${block.top} * var(--hour) / 60)`,
                      height: `calc(${block.height} * var(--hour) / 60)`,
                      left: `calc(${block.column} * 100% / ${block.columns})`,
                      width: `calc(100% / ${block.columns})`,
                    }}
                    label={`${block.title}, ${timeLabel(block.occurrence, timeZone)}`}
                    route={editorRoute(base, block.occurrence)}
                    navigate={navigate}
                  >
                    <span className="calendar-chip__type">
                      {chipTypes[block.source]}
                    </span>
                    <span className="time-grid__title">{block.title}</span>
                    <span className="time-grid__time">
                      {timeLabel(block.occurrence, timeZone)}
                    </span>
                  </Link>
                ))}
                {day === today && nowMinute >= 0 && nowMinute <= length && (
                  <span
                    className="time-grid__now"
                    aria-hidden="true"
                    style={{ top: `calc(${nowMinute} * var(--hour) / 60)` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The current time, refreshed every minute for the now line. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
