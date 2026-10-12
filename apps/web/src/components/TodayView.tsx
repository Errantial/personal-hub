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
import { CanvasEntry } from './CanvasEntry';
import { Link } from './Link';
import { QuickCapture } from './QuickCapture';
import { ReadState } from './ReadState';
import type { Route } from '../lib/router';
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
  const due = openTasks.filter((task) => task.dueDate === today);
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
  const agenda = [
    ...(schedule.data?.data.occurrences ?? []).map((item) => ({
      key: item.occurrenceId,
      allDay: item.allDay,
      start: item.startsAt ?? '',
      node: (
        <article className="today-item">
          <strong>{item.title}</strong>
          <small>
            {item.allDay
              ? 'All day'
              : `${new Date(item.startsAt!).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' })} – ${new Date(item.endsAt!).toLocaleTimeString(undefined, { timeZone, hour: 'numeric', minute: '2-digit' })}`}
          </small>
          <small>
            {item.courseId ? `Study time · ${item.studyStatus}` : 'Event'}
          </small>
        </article>
      ),
    })),
    ...(canvas.data?.data.items ?? []).map((item) => ({
      key: item.id,
      allDay: item.providerData.allDay,
      start: item.providerData.startsAt ?? '',
      node: <CanvasEntry item={item} timeZone={timeZone} />,
    })),
  ].sort(
    (a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      a.start.localeCompare(b.start) ||
      a.key.localeCompare(b.key),
  );
  return (
    <div className="today-view">
      <QuickCapture onSaved={reloadTasks} />
      <section className="panel" aria-labelledby="attention-title">
        <h2 id="attention-title">Needs attention</h2>
        <ReadState resource={tasks} label="tasks" />
        <ReadState resource={reminders} label="reminder status" />
        {overdue.length > 0 && (
          <>
            <h3>Overdue tasks</h3>
            <TaskList tasks={overdue} />
          </>
        )}
        {failed.length > 0 && (
          <>
            <h3>Failed reminders</h3>
            <ul className="today-list">
              {failed.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong>
                  <small>Delivery failed</small>
                </li>
              ))}
            </ul>
          </>
        )}
        {tasks.data && reminders.data && !overdue.length && !failed.length && (
          <p>No overdue tasks or failed reminders.</p>
        )}
        <Link route={{ name: 'tasks' }} navigate={navigate}>
          Open Tasks
        </Link>
        <Link route={{ name: 'inbox' }} navigate={navigate}>
          Open Inbox
        </Link>
      </section>
      <section className="panel" aria-labelledby="schedule-title">
        <h2 id="schedule-title">Today's schedule</h2>
        <p className="meta">{timeZone}</p>
        <ReadState resource={schedule} label="schedule" />
        <ReadState resource={canvas} label="Canvas" />
        {canvas.data?.data.lastImportedAt && (
          <p className="meta">
            Canvas imported{' '}
            {new Date(canvas.data.data.lastImportedAt).toLocaleString()}
          </p>
        )}
        {!!agenda.length && (
          <ul className="today-list">
            {agenda.map((item) => (
              <li key={item.key}>{item.node}</li>
            ))}
          </ul>
        )}
        {schedule.data && canvas.data && !agenda.length && (
          <p>Nothing scheduled today.</p>
        )}
        <Link route={{ name: 'calendar' }} navigate={navigate}>
          Open Calendar
        </Link>
      </section>
      <section className="panel" aria-labelledby="due-title">
        <h2 id="due-title">Due today</h2>
        <ReadState resource={tasks} label="tasks" />
        <TaskList tasks={due} />
        {tasks.data && !due.length && <p>No tasks due today.</p>}
        <h3>Upcoming 7 days</h3>
        <TaskList tasks={upcoming} />
        {tasks.data && !upcoming.length && (
          <p>No tasks due in the next 7 days.</p>
        )}
      </section>
      <section className="panel" aria-labelledby="unread-title">
        <h2 id="unread-title">
          Unread reminders{inbox.data ? ` (${unread.length})` : ''}
        </h2>
        <ReadState resource={inbox} label="unread reminders" />
        <ul className="today-list">
          {unread.slice(0, 3).map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </li>
          ))}
        </ul>
        {inbox.data && !unread.length && <p>No unread reminders.</p>}
        <Link route={{ name: 'inbox' }} navigate={navigate}>
          View all reminders
        </Link>
      </section>
    </div>
  );
}

function TaskList({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return null;
  return (
    <ul className="today-list">
      {tasks.map((task) => (
        <li key={task.id}>
          <strong>{task.title}</strong>
          <small>
            Due {task.dueDate}
            {task.priority === 'high' ? ' · High priority' : ''}
          </small>
        </li>
      ))}
    </ul>
  );
}
