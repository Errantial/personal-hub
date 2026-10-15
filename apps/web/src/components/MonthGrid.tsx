import type { CanvasItem, Occurrence, Task } from '@hub/contracts';
import { Temporal } from '@hub/contracts';
import { dayOccurrences, viewRange } from '../lib/calendar';
import { allDayStrip } from '../lib/calendar-grid';
import type { StripItem } from '../lib/calendar-grid';
import type { Route } from '../lib/router';
import type { SourceVisibility } from './CalendarShell';
import { Link } from './Link';
import { Chip } from './TimeGrid';
import './MonthGrid.css';

type CalendarRoute = Extract<Route, { name: 'calendar' }>;

/** Chips shown per day before "+N more". */
const chipLimit = 3;

const at = (day: string) => new Date(`${day}T12:00:00Z`);
const weekdayShort = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  timeZone: 'UTC',
});
const weekdayLong = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  timeZone: 'UTC',
});
const fullDay = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

/**
 * Month view: six weeks of days, each with up to three chips (the all-day
 * strip first, then timed events by start) and "+N more", which opens Day.
 */
export function MonthGrid({
  date,
  today,
  timeZone,
  occurrences,
  canvas,
  tasks,
  sources,
  base,
  navigate,
}: {
  date: string;
  today: string;
  timeZone: string;
  occurrences: Occurrence[];
  canvas: CanvasItem[];
  tasks: Task[];
  sources: SourceVisibility;
  base: CalendarRoute;
  navigate: (route: Route) => void;
}) {
  const month = Temporal.PlainDate.from(date).month;
  const { days } = viewRange(date, 'month');
  const weeks = Array.from({ length: 6 }, (_, week) =>
    days.slice(week * 7, week * 7 + 7),
  );
  const chipsFor = (day: string): StripItem[] =>
    [
      ...allDayStrip(day, { occurrences, canvas, tasks, timeZone }),
      ...dayOccurrences(occurrences, day, timeZone)
        .filter((item) => !item.allDay)
        .map((item): StripItem => ({
          key: item.occurrenceId,
          source: item.courseId ? 'study' : 'event',
          title: item.title,
          time: item.startsAt,
          target: {
            type: 'event',
            id: item.id,
            date: item.recurrence ? item.originalDate : null,
          },
        })),
    ].filter((item) => sources[item.source]);
  return (
    <table className="month-grid">
      <thead>
        <tr>
          {weeks[0]!.map((day) => (
            <th key={day} scope="col">
              <abbr title={weekdayLong.format(at(day))}>
                {weekdayShort.format(at(day))}
              </abbr>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0]}>
            {week.map((day) => {
              const chips = chipsFor(day);
              const more = chips.length - chipLimit;
              const dayRoute: CalendarRoute = {
                name: 'calendar',
                view: 'day',
                date: day,
              };
              return (
                <td
                  key={day}
                  aria-current={day === today ? 'date' : undefined}
                  className={
                    Temporal.PlainDate.from(day).month === month
                      ? ''
                      : 'month-grid__other'
                  }
                >
                  <Link
                    className="month-grid__date"
                    route={dayRoute}
                    navigate={navigate}
                    label={fullDay.format(at(day))}
                  >
                    {Number(day.slice(8))}
                  </Link>
                  <ul className="month-grid__chips">
                    {chips.slice(0, chipLimit).map((item) => (
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
                  {more > 0 && (
                    <Link
                      className="month-grid__more"
                      route={dayRoute}
                      navigate={navigate}
                      label={`${more} more on ${fullDay.format(at(day))}`}
                    >
                      +{more} more
                    </Link>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
