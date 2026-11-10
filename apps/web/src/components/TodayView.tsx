import { useEffect, useRef, useState } from 'react';
import {
  Temporal,
  academicWorkBrowseResponseSchema,
  tasksResponseSchema,
  taskResponseSchema,
  occurrencesResponseSchema,
  canvasItemsResponseSchema,
  notificationsSchema,
  remindersSchema,
  trackedDeadlineListSchema,
  trackedDeadlineResponseSchema,
} from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import {
  useMutation,
  useOfflineStatus,
  useOnline,
  useResource,
  useToday,
} from '../lib/hooks';
import { offlineChanged } from '../lib/offline';
import { CommandBar } from './CommandBar';
import { Help } from './Help';
import { Link } from './Link';
import { ReadState } from './ReadState';
import { CompletedRow, TodayRow } from './TodayRow';
import type { Completion } from './TodayRow';
import type { Route } from '../lib/router';
import { formatDate, formatInstant } from '../lib/format';
import { completionBody } from '../lib/tasks';
import { deviceTimeZone } from '../lib/time-zone';
import { overdueDeadlineDays, todayLists } from '../lib/today';
import type { TodayItem } from '../lib/today';
import './TodayView.css';

/** A completion that can still be reversed from the row it replaced. */
type Done = {
  list: string;
  index: number;
  item: TodayItem;
  undo: Completion;
};
type Entry = { item: TodayItem; done: boolean };
type Source = {
  label: string;
  resource: {
    loading: boolean;
    error: string;
    data: { cachedAt: string | null } | undefined;
    reload: () => Promise<unknown>;
  };
};

/** Overdue rows shown before the rest collapse behind a disclosure. */
const overdueShown = 5;

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function TodayView({ navigate }: { navigate: (route: Route) => void }) {
  const timeZone = deviceTimeZone();
  const today = useToday(timeZone);
  const day = (offset: number) =>
    Temporal.PlainDate.from(today).add({ days: offset }).toString();
  const schedulePath = `/api/v1/calendar/occurrences?${new URLSearchParams({
    from: today,
    to: day(1),
    timeZone,
  })}`;
  // Canvas entries cover today and the seven days after it.
  const canvasPath = `/api/v1/connections/canvas/calendar?${new URLSearchParams(
    { from: today, to: day(8), timeZone },
  )}`;
  // Completed deadlines are read too, so their raw Canvas entry stays hidden.
  // The server dates a timed deadline in its own zone: read one day wider on
  // each side and group by the viewing zone here.
  const deadlinesPath = `/api/v1/deadlines?${new URLSearchParams({
    status: 'all',
    from: day(-overdueDeadlineDays - 1),
    to: day(9),
    limit: '200',
  })}`;
  const tasks = useResource(
    (signal) => getSnapshot('/api/v1/tasks', tasksResponseSchema, signal),
    { failure: 'Tasks unavailable. Retry tasks.' },
  );
  const schedule = useResource(
    (signal) => getSnapshot(schedulePath, occurrencesResponseSchema, signal),
    { failure: 'Schedule unavailable. Retry schedule.' },
  );
  const canvas = useResource(
    (signal) => getSnapshot(canvasPath, canvasItemsResponseSchema, signal),
    { failure: 'Canvas deadlines unavailable. Retry Canvas.' },
  );
  const deadlines = useResource(
    (signal) => getSnapshot(deadlinesPath, trackedDeadlineListSchema, signal),
    { failure: 'Imported deadlines unavailable. Retry imported deadlines.' },
  );
  const work = useResource(
    (signal) =>
      getSnapshot(
        '/api/v1/academic-work/browse?status=open&deadline=dated&limit=200',
        academicWorkBrowseResponseSchema,
        signal,
      ),
    { failure: 'Class work unavailable. Retry class work.' },
  );
  const reminders = useResource(
    (signal) => getSnapshot('/api/v1/reminders', remindersSchema, signal),
    { failure: 'Reminder status unavailable. Retry reminder status.' },
  );
  const inbox = useResource(
    (signal) =>
      getSnapshot('/api/v1/notifications', notificationsSchema, signal),
    {
      failure: 'Unread notifications unavailable. Retry unread notifications.',
    },
  );
  const online = useOnline();
  const status = useOfflineStatus();
  const undo = useMutation();
  const [done, setDone] = useState<Done | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);

  const reloadTasks = tasks.reload;
  const reloadSchedule = schedule.reload;
  const reloadCanvas = canvas.reload;
  const reloadDeadlines = deadlines.reload;
  const reloadWork = work.reload;
  const previousDay = useRef(today);
  useEffect(() => {
    if (previousDay.current === today) return;
    previousDay.current = today;
    setDone(null);
    void reloadSchedule();
    void reloadCanvas();
    void reloadDeadlines();
  }, [today, reloadSchedule, reloadCanvas, reloadDeadlines]);
  useEffect(() => {
    const refresh = () => {
      void reloadTasks();
    };
    window.addEventListener(offlineChanged, refresh);
    return () => window.removeEventListener(offlineChanged, refresh);
  }, [reloadTasks]);
  // Class work follows the outbox count only (never connectivity), so two
  // reads cannot keep retriggering each other.
  const pending = status?.pending ?? null;
  const previousPending = useRef<number | null>(null);
  useEffect(() => {
    if (pending === null || previousPending.current === pending) return;
    const first = previousPending.current === null;
    previousPending.current = pending;
    if (!first) void reloadWork();
  }, [pending, reloadWork]);
  // After a completion the row becomes an Undo row; keep keyboard focus on it.
  useEffect(() => {
    if (done) undoButton.current?.focus({ preventScroll: true });
  }, [done]);
  // After Undo, return focus to the restored row once it is listed again.
  useEffect(() => {
    if (!focusKey) return;
    const row = [
      ...document.querySelectorAll<HTMLElement>('[data-today-row]'),
    ].find((element) => element.dataset.todayRow === focusKey);
    row?.querySelector<HTMLElement>('input, a')?.focus({ preventScroll: true });
    setFocusKey(null);
  }, [focusKey]);

  const {
    overdue,
    today: items,
    days,
  } = todayLists({
    tasks: tasks.data?.data.tasks ?? [],
    occurrences: schedule.data?.data.occurrences ?? [],
    canvas: canvas.data?.data.items ?? [],
    deadlines: deadlines.data?.data.deadlines ?? [],
    deadlinesComplete:
      !!deadlines.data && deadlines.data.data.nextAfter === null,
    work: work.data?.data.work ?? [],
    today,
    timeZone,
  });
  const upcomingCount = days.reduce(
    (sum, value) => sum + value.items.length,
    0,
  );
  const failed =
    reminders.data?.data.reminders.filter((item) => item.status === 'failed') ??
    [];
  const unread = (inbox.data?.data.notifications ?? [])
    .filter((item) => !item.readAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const loaded = !!(
    tasks.data &&
    schedule.data &&
    canvas.data &&
    deadlines.data &&
    work.data
  );
  const sources: Source[] = [
    { label: 'tasks', resource: tasks },
    { label: 'reminder status', resource: reminders },
    { label: 'schedule', resource: schedule },
    { label: 'Canvas', resource: canvas },
    { label: 'imported deadlines', resource: deadlines },
    { label: 'class work', resource: work },
  ];
  const refreshing = sources.some((source) => source.resource.loading);
  const offlineDeadlines =
    !online &&
    [...overdue, ...items, ...days.flatMap((value) => value.items)].some(
      (item) => item.action?.type === 'deadline',
    );

  /** A list's rows, with the last completion kept in place as an Undo row. */
  const entries = (list: string, values: TodayItem[]): Entry[] => {
    const rows = values.map((item) => ({ item, done: false }));
    if (done?.list === list)
      rows.splice(Math.min(done.index, rows.length), 0, {
        item: done.item,
        done: true,
      });
    return rows;
  };
  const overdueRows = entries('overdue', overdue);
  const todayRows = entries('today', items);
  const dayGroups = days.map((value) => ({
    date: value.date,
    rows: entries(`day-${value.date}`, value.items),
  }));
  // A day whose only item was just completed stays listed for its Undo row.
  if (
    done?.list.startsWith('day-') &&
    !dayGroups.some((group) => `day-${group.date}` === done.list)
  ) {
    dayGroups.push({
      date: done.list.slice(4),
      rows: entries(done.list, []),
    });
    dayGroups.sort((a, b) => a.date.localeCompare(b.date));
  }

  const time = (instant: string, zone = timeZone) =>
    new Date(instant).toLocaleTimeString(undefined, {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
    });
  const dueTime = (item: TodayItem) =>
    item.start ? time(item.start, item.timeZone ?? timeZone) : null;
  /** "Sun, Nov 8"; the full date once it is not this year's. */
  const shortDate = (date: string) =>
    date.slice(0, 4) === today.slice(0, 4)
      ? dayFormat.format(new Date(date))
      : formatDate(date);
  /** Today's time column: a due time, a range, or the kind of all-day item. */
  const when = (item: TodayItem) =>
    item.kind === 'event' || item.kind === 'study'
      ? item.allDay || !item.start
        ? 'All day'
        : !item.end || item.end === item.start
          ? time(item.start)
          : `${time(item.start)} – ${time(item.end)}`
      : item.start
        ? item.end && item.end !== item.start
          ? `${time(item.start)} – ${time(item.end)}`
          : `Due ${dueTime(item)}`
        : 'Due today';
  const overdueWhen = (item: TodayItem) =>
    [
      `Due ${shortDate(item.date)}${dueTime(item) ? `, ${dueTime(item)}` : ''}`,
      item.highPriority ? 'High priority' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const upcomingWhen = (item: TodayItem) =>
    [
      dueTime(item) ? `Due ${dueTime(item)}` : '',
      item.highPriority ? 'High priority' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const dayLabel = (date: string) =>
    `${date === day(1) ? 'Tomorrow · ' : ''}${shortDate(date)}`;

  async function completed(next: Done) {
    undo.reset();
    setDone(next);
    setAnnouncement(`Completed “${next.item.title}”. Undo is available.`);
    await (next.undo.type === 'task' ? reloadTasks() : reloadDeadlines());
  }
  async function undoCompletion(value: Done) {
    const result =
      value.undo.type === 'task'
        ? await undo.run(
            taskResponseSchema,
            'PUT',
            `/api/v1/tasks/${value.undo.task.id}`,
            completionBody(value.undo.task, false),
            'Could not undo. The task is still completed.',
          )
        : await undo.run(
            trackedDeadlineResponseSchema,
            'POST',
            `/api/v1/deadlines/${value.undo.id}/reopen`,
            { expectedVersion: value.undo.version },
            'Could not undo. The imported deadline is still completed.',
          );
    if (!result) return;
    setDone(null);
    setAnnouncement(`Reopened “${value.item.title}”.`);
    await (value.undo.type === 'task' ? reloadTasks() : reloadDeadlines());
    setFocusKey(value.item.key);
  }
  const rows = (
    list: string,
    values: Entry[],
    meta: (item: TodayItem) => string,
  ) =>
    values.map(({ item, done: finished }, index) =>
      finished ? (
        <CompletedRow
          key={`done-${item.key}`}
          title={item.title}
          pending={undo.pending}
          error={undo.error}
          undoRef={undoButton}
          onUndo={() => {
            void undoCompletion(done!);
          }}
        />
      ) : (
        <TodayRow
          key={item.key}
          item={item}
          meta={meta(item)}
          status={status}
          online={online}
          navigate={navigate}
          onCompleted={(value) =>
            completed({
              list,
              // Position among the real rows, without an earlier Undo row.
              index: values.slice(0, index).filter((entry) => !entry.done)
                .length,
              item,
              undo: value,
            })
          }
          onConflict={() =>
            item.action?.type === 'deadline' ? reloadDeadlines() : reloadTasks()
          }
        />
      ),
    );
  const heading = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const checkable = (values: Entry[]) =>
    values.some((entry) => entry.done || entry.item.action)
      ? ' today-rows--check'
      : '';
  return (
    <div className="today-view">
      <CommandBar navigate={navigate} onTaskSaved={reloadTasks} />
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      {offlineDeadlines && (
        <p className="meta today-offline-note">
          Connect to complete imported deadlines.
        </p>
      )}
      {(overdueRows.length > 0 || failed.length > 0) && (
        <section
          className="panel today-overdue"
          aria-labelledby="overdue-title"
        >
          <div className="today-heading">
            <h2 id="overdue-title">Overdue</h2>
            <Help label="Overdue">
              Open tasks and class work past their due date, and imported
              deadlines from the last {overdueDeadlineDays} days. Older imported
              deadlines stay in Tasks. Checking one off here completes it in
              Personal Hub only.
            </Help>
            <span className="today-heading__links">
              <Link route={{ name: 'tasks' }} navigate={navigate}>
                Open Tasks
              </Link>
              {failed.length > 0 && (
                <Link route={{ name: 'inbox' }} navigate={navigate}>
                  Open Inbox
                </Link>
              )}
            </span>
          </div>
          {overdueRows.length > 0 && (
            <ul
              className={`today-rows${checkable(overdueRows)}`}
              aria-labelledby="overdue-title"
            >
              {rows('overdue', overdueRows.slice(0, overdueShown), overdueWhen)}
            </ul>
          )}
          {overdueRows.length > overdueShown && (
            <details className="today-overdue__more">
              <summary>
                {overdueRows.length - overdueShown} more overdue
              </summary>
              <ul
                className={`today-rows${checkable(overdueRows)}`}
                aria-label="More overdue"
              >
                {rows('overdue', overdueRows, overdueWhen).slice(overdueShown)}
              </ul>
            </details>
          )}
          {failed.length > 0 && (
            <ul className="today-list">
              {failed.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <small>Delivery failed</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="panel" aria-labelledby="today-title">
        <div className="today-heading">
          <h2 id="today-title">
            Today<span className="visually-hidden"> · </span>
            <span className="today-heading__date" aria-hidden="true">
              {heading}
            </span>
          </h2>
          <Help label="Today">
            Deadlines, tasks and class work due today, with events and study
            time, in your time zone ({timeZone}).
            {canvas.data?.data.lastImportedAt &&
              ` Canvas imported ${formatInstant(canvas.data.data.lastImportedAt)}.`}
          </Help>
          <button
            type="button"
            className="text-button today-heading__refresh"
            disabled={refreshing}
            onClick={() => {
              for (const source of sources) void source.resource.reload();
              void inbox.reload();
            }}
          >
            Refresh
          </button>
        </div>
        <SourceStatus sources={sources} />
        {deadlines.data?.data.nextAfter && (
          <p className="meta">
            Showing the first 200 imported deadlines for this period. Open Tasks
            for the rest.
          </p>
        )}
        {work.data?.data.nextAfter && (
          <p className="meta">
            Showing the 200 earliest open class work items. Open Classes for the
            rest.
          </p>
        )}
        {todayRows.length > 0 && (
          <ul className={`today-rows today-rows--timed${checkable(todayRows)}`}>
            {rows('today', todayRows, when)}
          </ul>
        )}
        {loaded && !todayRows.length && <p>Nothing due or scheduled today.</p>}
        <Link route={{ name: 'calendar' }} navigate={navigate}>
          Open Calendar
        </Link>
      </section>
      <details
        className="panel today-more"
        aria-label={`Next 7 days · ${upcomingCount}`}
      >
        <summary>Next 7 days · {upcomingCount}</summary>
        {dayGroups.map((group) => (
          <div key={group.date} className="today-day">
            <p id={`today-day-${group.date}`} className="today-day__label">
              {dayLabel(group.date)}
            </p>
            <ul
              className={`today-rows${checkable(dayGroups.flatMap((value) => value.rows))}`}
              aria-labelledby={`today-day-${group.date}`}
            >
              {rows(`day-${group.date}`, group.rows, upcomingWhen)}
            </ul>
          </div>
        ))}
        {tasks.data && !dayGroups.length && (
          <p>Nothing due in the next 7 days.</p>
        )}
      </details>
      <details
        className="panel today-more"
        aria-label={`Unread notifications · ${unread.length}`}
      >
        <summary>Unread notifications · {unread.length}</summary>
        <ReadState resource={inbox} label="unread notifications" />
        <ul className="today-list">
          {unread.slice(0, 3).map((item) => (
            <li key={item.id}>
              {item.conversationId ? (
                <Link
                  route={{ name: 'assistant', id: item.conversationId }}
                  navigate={navigate}
                >
                  {item.title}
                </Link>
              ) : (
                <strong>{item.title}</strong>
              )}
              <small>{formatInstant(item.createdAt)}</small>
            </li>
          ))}
        </ul>
        {inbox.data && !unread.length && <p>No unread notifications.</p>}
        <Link route={{ name: 'inbox' }} navigate={navigate}>
          View all notifications
        </Link>
      </details>
    </div>
  );
}

/** One compact status block for every Today read: a single loading line, an
 *  alert and Retry per failed source, and one saved-time line for the sources
 *  shown from the offline cache (grouped when they were saved together). */
function SourceStatus({ sources }: { sources: Source[] }) {
  const cached = new Map<string, string[]>();
  for (const source of sources) {
    const savedAt = source.resource.data?.cachedAt;
    if (!savedAt) continue;
    const time = formatInstant(savedAt);
    cached.set(time, [...(cached.get(time) ?? []), source.label]);
  }
  return (
    <>
      {sources.some(
        (source) => source.resource.loading && !source.resource.data,
      ) && <p role="status">Loading…</p>}
      {sources
        .filter((source) => source.resource.error)
        .map((source) => (
          <div key={source.label} className="today-source-error">
            <p role="alert">{source.resource.error}</p>
            <button
              type="button"
              className="text-button"
              disabled={source.resource.loading}
              onClick={() => {
                void source.resource.reload();
              }}
            >
              Retry {source.label}
            </button>
          </div>
        ))}
      {cached.size > 0 && (
        <p className="meta today-cached">
          {[...cached].map(([time, labels]) => (
            <span key={time}>
              Cached {labels.join(', ')}: {time}
            </span>
          ))}
        </p>
      )}
    </>
  );
}
