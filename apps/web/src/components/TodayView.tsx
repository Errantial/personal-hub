import { useEffect, useRef } from 'react';
import {
  Temporal,
  tasksResponseSchema,
  occurrencesResponseSchema,
  canvasItemsResponseSchema,
  notificationsSchema,
  remindersSchema,
} from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { getSnapshot } from '../lib/api';
import { useResource, useToday } from '../lib/hooks';
import { offlineChanged } from '../lib/offline';
import { CommandBar } from './CommandBar';
import { Help } from './Help';
import { Link } from './Link';
import { ReadState } from './ReadState';
import type { Route } from '../lib/router';
import { formatDate, formatInstant } from '../lib/format';
import { todayItems } from '../lib/today';
import type { TodayItem } from '../lib/today';
import './TodayView.css';

export function TodayView({ navigate }: { navigate: (route: Route) => void }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = useToday(timeZone);
  const to = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
  const upcomingEnd = Temporal.PlainDate.from(today)
    .add({ days: 7 })
    .toString();
  const query = new URLSearchParams({ from: today, to, timeZone });
  const tasks = useResource(
    (signal) => getSnapshot('/api/v1/tasks', tasksResponseSchema, signal),
    { failure: 'Tasks unavailable. Retry tasks.' },
  );
  const schedule = useResource(
    (signal) =>
      getSnapshot(
        `/api/v1/calendar/occurrences?${query}`,
        occurrencesResponseSchema,
        signal,
      ),
    { failure: 'Schedule unavailable. Retry schedule.' },
  );
  const canvas = useResource(
    (signal) =>
      getSnapshot(
        `/api/v1/connections/canvas/calendar?${query}`,
        canvasItemsResponseSchema,
        signal,
      ),
    { failure: 'Canvas deadlines unavailable. Retry Canvas.' },
  );
  const reminders = useResource(
    (signal) => getSnapshot('/api/v1/reminders', remindersSchema, signal),
    { failure: 'Reminder status unavailable. Retry reminder status.' },
  );
  const inbox = useResource(
    (signal) =>
      getSnapshot('/api/v1/notifications', notificationsSchema, signal),
    { failure: 'Unread reminders unavailable. Retry unread reminders.' },
  );
  const reloadTasks = tasks.reload;
  const reloadSchedule = schedule.reload;
  const reloadCanvas = canvas.reload;
  const previousDay = useRef(today);
  useEffect(() => {
    if (previousDay.current === today) return;
    previousDay.current = today;
    void reloadSchedule();
    void reloadCanvas();
  }, [today, reloadSchedule, reloadCanvas]);
  useEffect(() => {
    const refresh = () => {
      void reloadTasks();
    };
    window.addEventListener(offlineChanged, refresh);
    return () => window.removeEventListener(offlineChanged, refresh);
  }, [reloadTasks]);
  const openTasks = (tasks.data?.data.tasks ?? [])
    .filter((task) => !task.completed)
    .sort(
      (a, b) =>
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
        a.title.localeCompare(b.title),
    );
  const overdue = openTasks.filter(
    (task) => task.dueDate && task.dueDate < today,
  );
  const upcoming = openTasks.filter(
    (task) =>
      task.dueDate && task.dueDate > today && task.dueDate <= upcomingEnd,
  );
  const failed =
    reminders.data?.data.reminders.filter((item) => item.status === 'failed') ??
    [];
  const unread = (inbox.data?.data.notifications ?? [])
    .filter((item) => !item.readAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const items = todayItems({
    tasks: tasks.data?.data.tasks ?? [],
    occurrences: schedule.data?.data.occurrences ?? [],
    canvas: canvas.data?.data.items ?? [],
    today,
    timeZone,
  });
  const loaded = !!(tasks.data && schedule.data && canvas.data);
  const time = (instant: string) =>
    new Date(instant).toLocaleTimeString(undefined, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    });
  const when = (item: TodayItem) =>
    item.kind === 'task'
      ? 'Due today'
      : item.allDay || !item.start
        ? 'All day'
        : !item.end || item.end === item.start
          ? `Due ${time(item.start)}`
          : `${time(item.start)} – ${time(item.end)}`;
  const title = (item: TodayItem) => {
    const target = item.target;
    if (target.type === 'task')
      return (
        <Link route={{ name: 'tasks', id: target.id }} navigate={navigate}>
          {item.title}
        </Link>
      );
    if (target.type === 'event')
      return (
        <Link
          route={{ name: 'calendar', editor: { kind: 'event', id: target.id } }}
          navigate={navigate}
        >
          {item.title}
        </Link>
      );
    return target.url ? (
      <a href={target.url} target="_blank" rel="noreferrer">
        {item.title}
      </a>
    ) : (
      <span>{item.title}</span>
    );
  };
  const heading = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return (
    <div className="today-view">
      <CommandBar navigate={navigate} onTaskSaved={reloadTasks} />
      {(overdue.length > 0 || failed.length > 0) && (
        <section
          className="panel today-overdue"
          aria-labelledby="overdue-title"
        >
          <h2 id="overdue-title">Overdue</h2>
          {overdue.length > 0 && <TaskList tasks={overdue} />}
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
          <Link route={{ name: 'tasks' }} navigate={navigate}>
            Open Tasks
          </Link>
          {failed.length > 0 && (
            <Link route={{ name: 'inbox' }} navigate={navigate}>
              Open Inbox
            </Link>
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
            Deadlines, tasks due today, events and study time in your time zone
            ({timeZone}).
            {canvas.data?.data.lastImportedAt &&
              ` Canvas imported ${formatInstant(canvas.data.data.lastImportedAt)}.`}
          </Help>
        </div>
        <ReadState resource={tasks} label="tasks" />
        <ReadState resource={reminders} label="reminder status" />
        <ReadState resource={schedule} label="schedule" />
        <ReadState resource={canvas} label="Canvas" />
        {items.length > 0 && (
          <ul className="today-rows">
            {items.map((item) => (
              <li key={item.key} className="today-row">
                <span className="today-row__time">{when(item)}</span>
                <span className="today-row__title">
                  {title(item)}
                  {item.cancelled && (
                    <small className="today-row__note"> · Cancelled</small>
                  )}
                </span>
                <span className={`kind-tag kind-tag--${item.kind}`}>
                  {kindLabels[item.kind]}
                </span>
              </li>
            ))}
          </ul>
        )}
        {loaded && !items.length && <p>Nothing due or scheduled today.</p>}
        <Link route={{ name: 'calendar' }} navigate={navigate}>
          Open Calendar
        </Link>
      </section>
      <details
        className="panel today-more"
        aria-label={`Next 7 days · ${upcoming.length}`}
      >
        <summary>Next 7 days · {upcoming.length}</summary>
        <TaskList tasks={upcoming} />
        {tasks.data && !upcoming.length && (
          <p>No tasks due in the next 7 days.</p>
        )}
      </details>
      <details
        className="panel today-more"
        aria-label={`Unread reminders · ${unread.length}`}
      >
        <summary>Unread reminders · {unread.length}</summary>
        <ReadState resource={inbox} label="unread reminders" />
        <ul className="today-list">
          {unread.slice(0, 3).map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              <small>{formatInstant(item.createdAt)}</small>
            </li>
          ))}
        </ul>
        {inbox.data && !unread.length && <p>No unread reminders.</p>}
        <Link route={{ name: 'inbox' }} navigate={navigate}>
          View all reminders
        </Link>
      </details>
    </div>
  );
}

const kindLabels: Record<TodayItem['kind'], string> = {
  deadline: 'Deadline',
  task: 'Task',
  event: 'Event',
  study: 'Study',
};

function TaskList({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return null;
  return (
    <ul className="today-list">
      {tasks.map((task) => (
        <li key={task.id}>
          <strong>{task.title}</strong>
          <small>
            {task.dueDate ? `Due ${formatDate(task.dueDate)}` : 'No due date'}
            {task.priority === 'high' ? ' · High priority' : ''}
          </small>
        </li>
      ))}
    </ul>
  );
}
