import { useRef, useState } from 'react';
import {
  notificationHistorySchema,
  notificationResponseSchema,
  notificationsReadResponseSchema,
  notificationsSchema,
  reminderResponseSchema,
  remindersSchema,
} from '@hub/contracts';
import type { HubNotification, Reminder } from '@hub/contracts';
import { getJson, getSnapshot } from '../lib/api';
import { useMutation, useResource } from '../lib/hooks';
import {
  permissionLabels,
  sortNotifications,
  splitReminders,
  workerSummary,
} from '../lib/reminders';
import type { PermissionState } from '../lib/reminders';
import type { Route } from '../lib/router';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { Link } from './Link';
import { ReadState } from './ReadState';
import { ReminderEditor } from './ReminderEditor';
import { StatusChip } from './StatusChip';
import './InboxView.css';

type InboxRoute = Extract<Route, { name: 'inbox' }>;
type Navigate = (route: Route) => void;

const statusText: Record<Reminder['status'], string> = {
  queued: 'Scheduled',
  running: 'Delivering',
  paused: 'Paused',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const targetText = {
  task: 'Linked task',
  event: 'Linked event',
  'academic-work': 'Linked academic work',
} as const;

const when = (value: string) => new Date(value).toLocaleString();

export function InboxView({
  route,
  navigate,
  onChanged,
}: {
  route: InboxRoute;
  navigate: Navigate;
  /** Tells the shell the unread count may have changed. */
  onChanged: () => void;
}) {
  const [permission, setPermission] = useState<PermissionState>(
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission,
  );
  const [permissionError, setPermissionError] = useState('');
  const observed = useRef(new Set<string>());
  const initialized = useRef(false);
  const [dialog, confirm] = useConfirm();
  const control = useMutation();
  const read = useMutation();
  const reminders = useResource(
    (signal) => getSnapshot('/api/v1/reminders', remindersSchema, signal),
    {
      failure: 'Could not refresh reminders. Retry reminders.',
      refreshMs: 10000,
    },
  );
  const notifications = useResource(
    async (signal) => {
      const result = await getSnapshot(
        '/api/v1/notifications',
        notificationsSchema,
        signal,
      );
      alertNew(result.data.notifications);
      return result;
    },
    {
      failure: 'Could not refresh notifications. Retry notifications.',
      refreshMs: 10000,
    },
  );
  const jobs = reminders.data?.data.reminders ?? [];
  const worker = reminders.data?.data.worker ?? {
    healthy: false,
    lastTick: null,
    errorCode: null,
  };
  const items = sortNotifications(notifications.data?.data.notifications ?? []);
  const unread = items.filter((item) => !item.readAt);
  const busy = control.pending || read.pending;
  const summary = workerSummary(worker);
  const reminderRoute: InboxRoute = { name: 'inbox', section: 'reminders' };
  const editing = route.reminder;

  /** A browser alert for each notification that arrives while Inbox is open. */
  function alertNew(list: HubNotification[]) {
    for (const item of list) {
      if (
        initialized.current &&
        !observed.current.has(item.id) &&
        !item.readAt &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          new Notification('Personal Hub reminder', {
            body: 'A reminder is ready in your hub.',
            tag: item.id,
          });
        } catch {
          /* The inbox stays the durable delivery channel. */
        }
      }
      observed.current.add(item.id);
    }
    initialized.current = true;
    onChanged();
  }

  async function reloadReminders() {
    return (await reminders.reload())?.data.reminders;
  }

  async function markRead(item: HubNotification) {
    const done = await read.run(
      notificationResponseSchema,
      'POST',
      `/api/v1/notifications/${item.id}/read`,
      {},
      'Could not mark the notification as read.',
    );
    if (done) await notifications.reload();
  }

  async function markLoadedRead() {
    const done = await read.run(
      notificationsReadResponseSchema,
      'POST',
      '/api/v1/notifications/read',
      { notificationIds: unread.slice(0, 200).map((item) => item.id) },
      'Could not mark the loaded notifications as read.',
    );
    if (done) await notifications.reload();
  }

  async function change(item: Reminder, action: string) {
    if (action === 'cancel') {
      const confirmed = await confirm({
        title: `Cancel reminder “${item.title}”?`,
        message:
          'It will not be delivered. A cancelled reminder cannot be resumed.',
        confirmLabel: 'Cancel reminder',
      });
      if (!confirmed) return;
    }
    const changed = await control.run(
      reminderResponseSchema,
      'POST',
      `/api/v1/reminders/${item.id}/control`,
      { action, expectedVersion: item.version },
      'Could not change the reminder.',
    );
    if (changed) await reminders.reload();
  }

  function leaveEditor() {
    navigate(reminderRoute);
  }
  function afterEdit() {
    void notifications.reload();
    leaveEditor();
  }

  const error = control.error || read.error || permissionError;
  const { active, earlier } = splitReminders(jobs);
  const snoozed = new Set(jobs.map((item) => item.snoozedFromId));
  const editTarget = jobs.find((item) => item.id === editing);

  return (
    <section
      className={`inbox-view ${editing ? 'inbox-view--editing' : ''}`}
      aria-label="Inbox"
    >
      <div className="panel inbox-status">
        <p role="status" className={summary.ok ? undefined : 'form-error'}>
          {summary.text}
        </p>
        <p>
          Browser alerts:{' '}
          <StatusChip>{permissionLabels[permission]}</StatusChip>{' '}
          <Help label="Browser alerts">
            Reminders are saved here while the page is closed. Browser alerts
            appear only while Inbox is open and permission is allowed.
            Closed-page push and Android notifications are not available.
            {permission === 'denied' &&
              ' Change this site’s notification setting in your browser; the inbox still works.'}
          </Help>
        </p>
        {permission === 'default' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void Notification.requestPermission().then(
                (value) => setPermission(value),
                () =>
                  setPermissionError(
                    'Browser notification permission could not be requested.',
                  ),
              );
            }}
          >
            Enable browser alerts
          </button>
        )}
        <ReadState resource={reminders} label="reminders" />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="inbox-layout">
        <div className="inbox-main">
          <nav aria-label="Inbox sections">
            <ul className="inbox-sections">
              <li>
                <Link
                  route={{ name: 'inbox' }}
                  navigate={navigate}
                  current={!route.section}
                >
                  Notifications
                  {unread.length ? ` (${unread.length} unread)` : ''}
                </Link>
              </li>
              <li>
                <Link
                  route={reminderRoute}
                  navigate={navigate}
                  current={route.section === 'reminders'}
                >
                  Reminders
                </Link>
              </li>
            </ul>
          </nav>
          {!route.section && (
            <NotificationsSection
              items={items}
              unread={unread.length}
              busy={busy}
              snoozed={snoozed}
              resource={notifications}
              navigate={navigate}
              onRead={(item) => {
                void markRead(item);
              }}
              onReadLoaded={() => {
                void markLoadedRead();
              }}
            />
          )}
          {route.section === 'reminders' && (
            <section aria-label="Reminders">
              <h2>Reminders</h2>
              <Link
                className="inbox-add"
                route={{ ...reminderRoute, reminder: 'new' }}
                navigate={navigate}
                current={editing === 'new'}
              >
                Add reminder
              </Link>
              {reminders.data && !active.length && (
                <p>No scheduled reminders.</p>
              )}
              <ul className="inbox-list">
                {active.map((item) => (
                  <ReminderRow
                    key={item.id}
                    item={item}
                    busy={busy}
                    navigate={navigate}
                    onChange={(action) => {
                      void change(item, action);
                    }}
                  />
                ))}
              </ul>
              {earlier.length > 0 && (
                <details>
                  <summary>Earlier reminders ({earlier.length})</summary>
                  <ul className="inbox-list">
                    {earlier.map((item) => (
                      <ReminderRow
                        key={item.id}
                        item={item}
                        busy={busy}
                        navigate={navigate}
                        onChange={() => undefined}
                      />
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
        </div>
        {route.section === 'reminders' && editing && (
          <section
            className="panel inbox-editor"
            aria-labelledby="reminder-editor-title"
          >
            <Link
              className="inbox-back"
              route={reminderRoute}
              navigate={navigate}
            >
              Back to reminders
            </Link>
            <h2 id="reminder-editor-title">
              {editing === 'new'
                ? 'Add reminder'
                : editTarget?.status === 'delivered'
                  ? 'Snooze reminder'
                  : 'Reschedule reminder'}
            </h2>
            {editing === 'new' ? (
              <ReminderEditor
                key="new"
                reload={reloadReminders}
                onDone={afterEdit}
              />
            ) : editTarget ? (
              <ReminderEditor
                key={editTarget.id}
                reminder={editTarget}
                reload={reloadReminders}
                onDone={afterEdit}
              />
            ) : reminders.data ? (
              <p>This reminder is not available. It may have been removed.</p>
            ) : (
              <p role="status">Loading…</p>
            )}
          </section>
        )}
      </div>
      {dialog}
    </section>
  );
}

function ReminderRow({
  item,
  busy,
  navigate,
  onChange,
}: {
  item: Reminder;
  busy: boolean;
  navigate: Navigate;
  onChange: (action: string) => void;
}) {
  const button = (
    action: string,
    text: string,
    label = `${text} ${item.title}`,
  ) => (
    <button
      type="button"
      className={action === 'cancel' ? 'danger-button' : 'secondary-button'}
      disabled={busy}
      aria-label={label}
      onClick={() => onChange(action)}
    >
      {text}
    </button>
  );
  return (
    <li>
      <div className="inbox-list__body">
        <strong>{item.title}</strong>
        <span>{when(item.scheduledAt)}</span>
        <span className="inbox-list__meta">
          <StatusChip tone={item.status === 'failed' ? 'danger' : 'neutral'}>
            {statusText[item.status]}
          </StatusChip>
          {item.targetKind && <span>{targetText[item.targetKind]}</span>}
          {item.snoozedFromId && <span>Snoozed</span>}
          {item.attempts > 0 && <span>Attempts: {item.attempts}</span>}
        </span>
        {item.lastError && (
          <p className="form-error">Last failure: {item.lastError}</p>
        )}
      </div>
      <div className="inbox-list__actions">
        {['queued', 'paused', 'failed'].includes(item.status) && (
          <Link
            route={{ name: 'inbox', section: 'reminders', reminder: item.id }}
            navigate={navigate}
          >
            Reschedule<span className="visually-hidden"> {item.title}</span>
          </Link>
        )}
        {['queued', 'running'].includes(item.status) &&
          button('pause', 'Pause')}
        {item.status === 'paused' && button('resume', 'Resume')}
        {item.status === 'failed' && button('retry', 'Retry')}
        {['queued', 'running', 'paused', 'failed'].includes(item.status) &&
          button('cancel', 'Cancel', `Cancel reminder ${item.title}`)}
      </div>
    </li>
  );
}

function NotificationsSection({
  items,
  unread,
  busy,
  snoozed,
  resource,
  navigate,
  onRead,
  onReadLoaded,
}: {
  items: HubNotification[];
  unread: number;
  busy: boolean;
  snoozed: Set<string | null>;
  resource: Parameters<typeof ReadState>[0]['resource'];
  navigate: Navigate;
  onRead: (item: HubNotification) => void;
  onReadLoaded: () => void;
}) {
  const [older, setOlder] = useState<HubNotification[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [olderError, setOlderError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The main list holds the latest 200; older history is fetched on request.
  const full = items.length >= 200;
  const oldest = items[items.length - 1];

  async function loadOlder() {
    const before = cursor === undefined ? oldest?.id : cursor;
    if (!before) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const page = await getJson(
        `/api/v1/notifications/history?limit=50&before=${before}`,
        notificationHistorySchema,
      );
      setOlder((current) => [...current, ...page.notifications]);
      setCursor(page.nextBefore);
    } catch {
      setOlderError('Could not load older notifications. Try again online.');
    } finally {
      setLoadingOlder(false);
    }
  }

  const row = (item: HubNotification, history = false) => (
    <li key={item.id}>
      <div className="inbox-list__body">
        <strong>{item.title}</strong>
        <span>{when(item.createdAt)}</span>
        <span className="inbox-list__meta">
          <StatusChip>{item.readAt ? 'Read' : 'Unread'}</StatusChip>
          {snoozed.has(item.reminderId) && <span>Snoozed</span>}
        </span>
      </div>
      <div className="inbox-list__actions">
        {!item.readAt && !history && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            aria-label={`Mark read: ${item.title}`}
            onClick={() => onRead(item)}
          >
            Mark read
          </button>
        )}
        {!snoozed.has(item.reminderId) && (
          <Link
            route={{
              name: 'inbox',
              section: 'reminders',
              reminder: item.reminderId,
            }}
            navigate={navigate}
          >
            Snooze<span className="visually-hidden"> {item.title}</span>
          </Link>
        )}
      </div>
    </li>
  );
  return (
    <section aria-label="Notifications">
      <h2>Notifications</h2>
      <Help label="Notifications">
        Delivered reminders stay here; unread ones come first. The list shows
        the latest 200. Older notifications load read-only.
      </Help>
      <ReadState resource={resource} label="notifications" />
      {unread > 0 && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onReadLoaded}
        >
          Mark loaded read
        </button>
      )}
      {resource.data && !items.length && <p>No notifications.</p>}
      <ul className="inbox-list">{items.map((item) => row(item))}</ul>
      {older.length > 0 && (
        <>
          <h3>Older</h3>
          <ul className="inbox-list">{older.map((item) => row(item, true))}</ul>
        </>
      )}
      {olderError && (
        <p role="alert" className="form-error">
          {olderError}
        </p>
      )}
      {full && cursor !== null && (
        <button
          type="button"
          className="secondary-button"
          disabled={loadingOlder}
          onClick={() => {
            void loadOlder();
          }}
        >
          {loadingOlder ? 'Loading…' : 'Load older notifications'}
        </button>
      )}
    </section>
  );
}
