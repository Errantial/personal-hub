import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Temporal,
  calendarListSchema,
  calendarResponseSchema,
  canvasItemInRange,
  canvasItemsResponseSchema,
  coursesSchema,
  occurrencesResponseSchema,
  plannerSensitivity,
  topicsSchema,
  zone as zoneSchema,
} from '@hub/contracts';
import type { CalendarRecord, Occurrence } from '@hub/contracts';
import { getJson, getSnapshot } from '../lib/api';
import {
  dayOccurrences,
  shiftDate,
  timeLabel,
  viewRange,
} from '../lib/calendar';
import type { StudyDraft } from '../lib/calendar';
import { useMutation, useResource, useToday } from '../lib/hooks';
import { calendarViews } from '../lib/router';
import type { CalendarView as View, Route } from '../lib/router';
import { CalendarEditor } from './CalendarEditor';
import { CanvasEntry } from './CanvasEntry';
import { useChoice } from './ConfirmDialog';
import { DeletedItems } from './DeletedItems';
import { Help } from './Help';
import { Link } from './Link';
import { PlannerSource } from './PlannerSource';
import { ReadState } from './ReadState';
import { StatusChip } from './StatusChip';
import { TimeZoneInput } from './TimeZoneInput';
import './CalendarView.css';

type CalendarRoute = Extract<Route, { name: 'calendar' }>;
type Notice = {
  text: string;
  undo?: { id: string; version: number; title: string };
};

const viewLabels: Record<View, string> = {
  agenda: 'Agenda',
  week: 'Week',
  day: 'Day',
};
const stepLabels: Record<View, string> = {
  agenda: '7 days',
  week: 'week',
  day: 'day',
};

// Dates are plain calendar days; format in UTC so they never shift.
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const rangeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const formatDay = (day: string) =>
  dayFormat.format(new Date(`${day}T12:00:00Z`));
const formatRange = (from: string, last: string) =>
  `${rangeFormat.format(new Date(`${from}T12:00:00Z`))}${
    from === last
      ? ''
      : ` – ${rangeFormat.format(new Date(`${last}T12:00:00Z`))}`
  }`;

export function CalendarView({
  route,
  navigate,
  studyDraft,
  onStudyUsed,
}: {
  route: CalendarRoute;
  navigate: (route: Route) => void;
  studyDraft: StudyDraft | null;
  onStudyUsed: () => void;
}) {
  const [viewingZone, setViewingZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const today = useToday(viewingZone);
  const view = route.view ?? 'agenda';
  const date = route.date ?? today;
  const { from, to, days } = viewRange(date, view);
  const last = days[days.length - 1]!;
  const rangeKey = `${from}:${to}:${viewingZone}`;
  const query = new URLSearchParams({ from, to, timeZone: viewingZone });

  const events = useResource(
    (signal) => getSnapshot('/api/v1/calendar', calendarListSchema, signal),
    { failure: 'Calendar unavailable. Retry.' },
  );
  const occurrences = useResource(
    (signal) =>
      getSnapshot(
        `/api/v1/calendar/occurrences?${query}`,
        occurrencesResponseSchema,
        signal,
      ),
    { failure: 'Calendar unavailable. Retry.', key: rangeKey },
  );
  const canvas = useResource(
    (signal) =>
      getJson(
        `/api/v1/connections/canvas/calendar?${query}`,
        canvasItemsResponseSchema,
        signal,
      ),
    {
      failure: 'Canvas entries unavailable. Reload calendar to retry.',
      key: rangeKey,
    },
  );
  const courses = useResource(
    (signal) => getJson('/api/v1/courses', coursesSchema, signal),
    { failure: 'Classes unavailable.' },
  );
  const topics = useResource(
    (signal) => getJson('/api/v1/topics', topicsSchema, signal),
    { failure: 'Topics unavailable.' },
  );

  const [notice, setNotice] = useState<Notice | null>(null);
  const [deletedKey, setDeletedKey] = useState(0);
  const [dialog, choose] = useChoice<'occurrence' | 'series'>();
  const remove = useMutation();
  const restore = useMutation();

  // A study draft belongs to one visit to the new-event form.
  const editingNew = route.editor?.kind === 'new';
  useEffect(() => {
    if (studyDraft && !editingNew) onStudyUsed();
  }, [studyDraft, editingNew, onStudyUsed]);

  const listRoute: CalendarRoute = {
    name: 'calendar',
    ...(route.date ? { date: route.date } : {}),
    ...(route.view ? { view: route.view } : {}),
  };
  // Changing the window keeps an open editor, so a draft survives browsing.
  const keep = route.editor ? { editor: route.editor } : {};
  const reloadEvents = async () => (await events.reload())?.data.events;
  const reloadAll = async () => {
    await Promise.all([events.reload(), occurrences.reload(), canvas.reload()]);
  };

  async function deleteEvent(
    series: CalendarRecord,
    occurrenceDate: string | null,
  ) {
    setNotice(null);
    let scope: 'occurrence' | 'series' = 'series';
    if (occurrenceDate) {
      const choice = await choose({
        title: `Delete “${series.title}”?`,
        message:
          'Deleting only this occurrence cannot be undone. A deleted series can be restored from Recently deleted.',
        choices: [
          { value: 'occurrence', label: 'This occurrence', danger: true },
          { value: 'series', label: 'Entire series', danger: true },
        ],
      });
      if (!choice) return;
      scope = choice;
    }
    const result = await remove.run(
      calendarResponseSchema,
      'DELETE',
      scope === 'occurrence'
        ? `/api/v1/calendar/${series.id}/occurrences/${occurrenceDate}`
        : `/api/v1/calendar/${series.id}`,
      { expectedVersion: series.version },
      'Could not delete. The event is unchanged.',
    );
    if (!result) return;
    setNotice(
      scope === 'occurrence'
        ? { text: `Deleted ${occurrenceDate} of “${series.title}”.` }
        : {
            text: `Deleted “${series.title}”.`,
            undo: {
              id: series.id,
              version: result.event.version,
              title: series.title,
            },
          },
    );
    navigate(listRoute);
    await reloadAll();
    setDeletedKey((value) => value + 1);
  }

  async function undoDelete(undo: NonNullable<Notice['undo']>) {
    const result = await restore.run(
      calendarResponseSchema,
      'POST',
      `/api/v1/calendar/${undo.id}/restore`,
      { expectedVersion: undo.version },
      'Could not undo. Check the connection and try again.',
    );
    if (!result) return;
    setNotice({ text: `Restored “${undo.title}”.` });
    await reloadAll();
    setDeletedKey((value) => value + 1);
  }

  function saved(event: CalendarRecord, created: boolean) {
    void occurrences.reload();
    if (!created) return;
    // Show the new event: go to the day it starts on.
    const day =
      event.startDate ??
      Temporal.Instant.from(event.startsAt)
        .toZonedDateTimeISO(viewingZone)
        .toPlainDate()
        .toString();
    setNotice({ text: `Added “${event.title}”.` });
    navigate({
      name: 'calendar',
      date: day,
      ...(route.view ? { view: route.view } : {}),
    });
    void reloadAll();
  }

  const items = occurrences.data?.data.occurrences ?? [];
  const canvasItems = canvas.data?.items ?? [];
  const sections = days.map((day) => {
    const entries: Entry[] = [
      ...dayOccurrences(items, day, viewingZone).map((item) => ({
        id: item.occurrenceId,
        allDay: item.allDay,
        start: item.startsAt,
        node: (
          <EventRow
            item={item}
            zone={viewingZone}
            courseName={
              courses.data?.courses.find(
                (course) => course.id === item.courseId,
              )?.name
            }
            route={{
              ...listRoute,
              editor: item.recurrence
                ? { kind: 'occurrence', id: item.id, date: item.originalDate }
                : { kind: 'event', id: item.id },
            }}
            navigate={navigate}
          />
        ),
      })),
      ...canvasItems
        .filter((item) =>
          canvasItemInRange(
            item,
            day,
            Temporal.PlainDate.from(day).add({ days: 1 }).toString(),
            viewingZone,
          ),
        )
        .map((item) => ({
          id: `canvas-${item.id}`,
          allDay: !!item.providerData.allDay,
          start: item.providerData.startsAt ?? '',
          node: <CanvasEntry item={item} timeZone={viewingZone} />,
        })),
    ].sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start),
    );
    return { day, entries };
  });
  const shown =
    view === 'agenda' ? sections.filter((s) => s.entries.length) : sections;
  const ready = !!occurrences.data;
  const readState = {
    loading: events.loading || occurrences.loading,
    error: events.error || occurrences.error,
    data: occurrences.data,
    reload: reloadAll,
  };

  return (
    <section className="calendar-view" aria-label="Calendar">
      <nav aria-label="Calendar views">
        <ul className="calendar-views">
          {calendarViews.map((value) => (
            <li key={value}>
              <Link
                route={{
                  name: 'calendar',
                  ...(route.date ? { date: route.date } : {}),
                  ...(value === 'agenda' ? {} : { view: value }),
                  ...keep,
                }}
                navigate={navigate}
                current={value === view}
              >
                {viewLabels[value]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="calendar-controls">
        <Link
          className="calendar-step"
          route={{ ...listRoute, ...keep, date: shiftDate(date, view, -1) }}
          navigate={navigate}
        >
          Previous {stepLabels[view]}
        </Link>
        <Link
          className="calendar-step"
          route={{ ...listRoute, ...keep, date: today }}
          navigate={navigate}
        >
          Today
        </Link>
        <Link
          className="calendar-step"
          route={{ ...listRoute, ...keep, date: shiftDate(date, view, 1) }}
          navigate={navigate}
        >
          Next {stepLabels[view]}
        </Link>
        <label className="calendar-date">
          Date
          <input
            type="date"
            value={date}
            onChange={(event) => {
              if (event.target.value)
                navigate({ ...listRoute, ...keep, date: event.target.value });
            }}
          />
        </label>
        <Link
          className="calendar-add"
          route={{ ...listRoute, editor: { kind: 'new' } }}
          navigate={navigate}
        >
          Add event
        </Link>
      </div>
      <ViewingZone zone={viewingZone} onChange={setViewingZone} />
      <div className="calendar-notice" role="status">
        {notice && <p>{notice.text}</p>}
        {notice?.undo && (
          <button
            type="button"
            className="secondary-button"
            disabled={restore.pending}
            onClick={() => {
              void undoDelete(notice.undo!);
            }}
          >
            Undo
          </button>
        )}
      </div>
      {(remove.error || restore.error) && (
        <p role="alert" className="form-error">
          {remove.error || restore.error}
        </p>
      )}
      <div
        className={`calendar-layout ${route.editor ? 'calendar-layout--editing' : ''}`}
      >
        <section
          className="panel calendar-list-pane"
          aria-labelledby="calendar-list-title"
        >
          <h2 id="calendar-list-title">
            {viewLabels[view]} · {formatRange(from, last)}
          </h2>
          <Help label="Calendar">
            Times are shown in {viewingZone}. Task deadlines are separate from
            reserved calendar time. Canvas entries are read-only; deadlines are
            single moments, and cancelled or missing entries stay visible
            without reserving time.
          </Help>
          <ReadState resource={readState} label="calendar" />
          {canvas.error && (
            <p role="alert" className="form-error">
              {canvas.error}
            </p>
          )}
          {canvas.data?.lastImportedAt && (
            <p className="meta">
              Canvas last import:{' '}
              {new Date(canvas.data.lastImportedAt).toLocaleString()}
            </p>
          )}
          {ready && !shown.length && (
            <p>Nothing scheduled in the next 7 days.</p>
          )}
          {shown.map(({ day, entries }) => (
            <section
              key={day}
              className="calendar-day"
              data-date={day}
              aria-labelledby={`calendar-day-${day}`}
            >
              <h3 id={`calendar-day-${day}`}>
                {formatDay(day)}
                {day === today && <StatusChip>Today</StatusChip>}
              </h3>
              {entries.length ? (
                <ul className="calendar-entries">
                  {entries.map((entry) => (
                    <li key={entry.id}>{entry.node}</li>
                  ))}
                </ul>
              ) : (
                ready && <p className="meta">Nothing scheduled.</p>
              )}
            </section>
          ))}
        </section>
        {route.editor && (
          <CalendarEditor
            editor={route.editor}
            events={events.data?.data.events ?? []}
            loaded={!!events.data}
            courses={courses.data?.courses ?? []}
            topics={topics.data?.topics ?? []}
            date={date}
            viewingZone={viewingZone}
            study={studyDraft}
            listRoute={listRoute}
            navigate={navigate}
            reload={reloadEvents}
            onSaved={saved}
            onDelete={deleteEvent}
            deleting={remove.pending}
          />
        )}
      </div>
      <DeletedItems
        kind="calendar"
        refreshKey={deletedKey}
        onRestored={reloadAll}
      />
      {dialog}
    </section>
  );
}

type Entry = { id: string; allDay: boolean; start: string; node: ReactNode };

/** The timezone the agenda is shown in, kept behind a disclosure. */
function ViewingZone({
  zone,
  onChange,
}: {
  zone: string;
  onChange: (zone: string) => void;
}) {
  const [text, setText] = useState(zone);
  const [error, setError] = useState('');
  return (
    <details className="calendar-zone">
      <summary>Viewing timezone: {zone}</summary>
      <form
        className="calendar-zone__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!zoneSchema.safeParse(text).success) {
            setError('Enter a supported IANA timezone.');
            return;
          }
          setError('');
          onChange(text);
        }}
      >
        <label>
          Viewing timezone
          <TimeZoneInput
            value={text}
            aria-invalid={!!error || undefined}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button className="secondary-button">Apply timezone</button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}

function EventRow({
  item,
  zone,
  courseName,
  route,
  navigate,
}: {
  item: Occurrence;
  zone: string;
  courseName: string | undefined;
  route: Route;
  navigate: (route: Route) => void;
}) {
  const label = plannerSensitivity(item);
  const cancelled = item.studyStatus === 'cancelled';
  return (
    <article
      className={`calendar-row ${cancelled ? 'calendar-row--cancelled' : ''}`}
    >
      <Link className="calendar-row__title" route={route} navigate={navigate}>
        {item.title}
      </Link>
      <span className="calendar-row__time">{timeLabel(item, zone)}</span>
      <div className="calendar-row__meta">
        {item.courseId && (
          <StatusChip>
            Study · {courseName ?? 'Archived class'} · {item.studyStatus}
          </StatusChip>
        )}
        {item.recurrence && (
          <StatusChip>Repeats {item.recurrence.frequency}</StatusChip>
        )}
        {item.overridden && <StatusChip>Edited occurrence</StatusChip>}
        {label !== 'unlabeled' && (
          <StatusChip>
            {label === 'personal' ? 'Personal' : 'Restricted'}
          </StatusChip>
        )}
        {!item.allDay && item.timeZone !== zone && (
          <StatusChip>In {item.timeZone}</StatusChip>
        )}
      </div>
      <PlannerSource source={item.canvasSource} />
    </article>
  );
}
