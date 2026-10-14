import { useState } from 'react';
import type { ReactNode } from 'react';
import { shiftDate, viewRange } from '../lib/calendar';
import type { GridSource } from '../lib/calendar-grid';
import { calendarViews } from '../lib/router';
import type { CalendarView, Route } from '../lib/router';
import { Link } from './Link';
import { MiniMonth } from './MiniMonth';
import './CalendarShell.css';

type CalendarRoute = Extract<Route, { name: 'calendar' }>;

/** Which sources the calendar shows; remembered on this device. */
export type SourceVisibility = Record<GridSource, boolean>;
const sourcesKey = 'hub:calendar-sources';
const allSources: SourceVisibility = {
  event: true,
  study: true,
  canvas: true,
  task: true,
};
export const sourceLabels: Record<GridSource, string> = {
  event: 'Events',
  study: 'Study blocks',
  canvas: 'Canvas deadlines',
  task: 'Task due dates',
};

export function useSourceVisibility() {
  const [sources, setSources] = useState<SourceVisibility>(() => {
    try {
      return {
        ...allSources,
        ...(JSON.parse(
          localStorage.getItem(sourcesKey) ?? '{}',
        ) as Partial<SourceVisibility>),
      };
    } catch {
      return allSources;
    }
  });
  const change = (next: SourceVisibility) => {
    setSources(next);
    try {
      localStorage.setItem(sourcesKey, JSON.stringify(next));
    } catch {
      /* Still applies without storage. */
    }
  };
  return [sources, change] as const;
}

const viewLabels: Record<CalendarView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
};
const stepLabels: Record<CalendarView, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  agenda: '7 days',
};

// Plain dates are formatted at UTC noon so they never shift a day.
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const rangeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const dayTitle = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthTitle = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Oct 19 – 25, 2026", "Wednesday, Oct 14, 2026" or "October 2026". */
export function rangeTitle(date: string, view: CalendarView) {
  if (view === 'day') return dayTitle.format(at(date));
  if (view === 'month') return monthTitle.format(at(date));
  const { days } = viewRange(date, view);
  return rangeFormat.formatRange(at(days[0]!), at(days[days.length - 1]!));
}

/**
 * Proton-style calendar frame: a sidebar (New event, mini month, date, Show
 * toggles, viewing zone) and a top bar (Today, previous/next, range title,
 * view switch) around the current view. Below 1024 px the sidebar's tools
 * sit behind a Calendars button.
 */
export function CalendarShell({
  route,
  view,
  date,
  today,
  navigate,
  zone,
  sources,
  onSources,
  children,
}: {
  route: CalendarRoute;
  /** The view shown, which may be the default for this screen width. */
  view: CalendarView;
  date: string;
  today: string;
  navigate: (route: Route) => void;
  zone: ReactNode;
  sources: SourceVisibility;
  onSources: (next: SourceVisibility) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const editing = !!route.editor;
  const base: CalendarRoute = {
    name: 'calendar',
    ...(route.date ? { date: route.date } : {}),
    ...(route.view ? { view: route.view } : {}),
    // Moving through dates keeps an open editor, so a draft survives browsing.
    ...(route.editor ? { editor: route.editor } : {}),
  };
  const go = (next: string) => navigate({ ...base, date: next });
  return (
    <div
      className={`calendar-shell${editing ? ' calendar-shell--editing' : ''}`}
    >
      <aside className="calendar-sidebar" aria-label="Calendar tools">
        <div className="calendar-sidebar__actions">
          <Link
            className="calendar-add"
            route={{ ...base, editor: { kind: 'new' } }}
            navigate={navigate}
          >
            New event
          </Link>
          <button
            type="button"
            className="secondary-button calendar-sidebar__toggle"
            aria-expanded={open}
            aria-controls="calendar-sidebar-panel"
            onClick={() => setOpen(!open)}
          >
            Calendars
          </button>
        </div>
        <div
          id="calendar-sidebar-panel"
          className={`calendar-sidebar__panel${open ? ' is-open' : ''}`}
        >
          <MiniMonth date={date} today={today} onPick={go} />
          <label className="calendar-date">
            Date
            <input
              type="date"
              value={date}
              onChange={(event) => {
                if (event.target.value) go(event.target.value);
              }}
            />
          </label>
          <fieldset className="calendar-sources">
            <legend>Show</legend>
            {(Object.keys(sourceLabels) as GridSource[]).map((source) => (
              <label key={source} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={sources[source]}
                  onChange={(event) =>
                    onSources({ ...sources, [source]: event.target.checked })
                  }
                />
                <span
                  className={`calendar-swatch calendar-swatch--${source}`}
                  aria-hidden="true"
                />
                {sourceLabels[source]}
              </label>
            ))}
          </fieldset>
          {zone}
        </div>
      </aside>
      <div className="calendar-main">
        <div className="calendar-topbar">
          <Link
            className="calendar-step"
            route={{ ...base, date: today }}
            navigate={navigate}
          >
            Today
          </Link>
          <div className="calendar-topbar__steps">
            <Link
              className="calendar-step calendar-step--icon"
              label={`Previous ${stepLabels[view]}`}
              route={{ ...base, date: shiftDate(date, view, -1) }}
              navigate={navigate}
            >
              ‹
            </Link>
            <Link
              className="calendar-step calendar-step--icon"
              label={`Next ${stepLabels[view]}`}
              route={{ ...base, date: shiftDate(date, view, 1) }}
              navigate={navigate}
            >
              ›
            </Link>
          </div>
          <h2 id="calendar-range-title" className="calendar-topbar__title">
            {rangeTitle(date, view)}
          </h2>
          <nav aria-label="Calendar views">
            <ul className="calendar-views">
              {calendarViews.map((value) => (
                <li key={value}>
                  <Link
                    route={{ ...base, view: value }}
                    navigate={navigate}
                    current={value === view}
                  >
                    {viewLabels[value]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        {children}
      </div>
    </div>
  );
}
