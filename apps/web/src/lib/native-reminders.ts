import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Capacitor } from '@capacitor/core';
import { remindersSchema } from '@hub/contracts';
import type { Reminder } from '@hub/contracts';
import { getSnapshot } from './api';
import { nativePlatform } from './transport';

/** Android channel for reminder alarms. Importance 4 makes it a heads-up alert. */
export const reminderChannel = 'reminders';
const marker = 'reminder';

/**
 * Android notification ids are 32-bit integers. FNV-1a maps a reminder UUID to
 * a stable positive id, so a rescheduled reminder replaces its own alarm.
 */
export function notificationId(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

export type ReminderAlarm = {
  id: number;
  reminderId: string;
  title: string;
  at: string;
};

const alarmStatuses = new Set<Reminder['status']>(['queued', 'failed']);

/** The alarms this device should hold: unfinished reminders still ahead. */
export function planAlarms(reminders: Reminder[], now: Date) {
  const used = new Set<number>();
  const alarms: ReminderAlarm[] = [];
  let duplicates = 0;
  for (const reminder of reminders) {
    if (!alarmStatuses.has(reminder.status)) continue;
    if (Date.parse(reminder.scheduledAt) <= now.getTime()) continue;
    const id = notificationId(reminder.id);
    if (used.has(id)) {
      duplicates += 1;
      continue;
    }
    used.add(id);
    alarms.push({
      id,
      reminderId: reminder.id,
      title: reminder.title,
      at: reminder.scheduledAt,
    });
  }
  return { alarms, duplicates };
}

export type PendingAlarm = {
  id: number;
  extra?: { hub?: unknown; at?: unknown; title?: unknown } | null;
};

/**
 * What changed since the last reconcile. Alarms we did not schedule are left
 * alone, and a changed time or title cancels before it is scheduled again.
 */
export function diffAlarms(alarms: ReminderAlarm[], pending: PendingAlarm[]) {
  const ours = pending.filter((item) => item.extra?.hub === marker);
  const current = new Map(ours.map((item) => [item.id, item]));
  const wanted = new Set(alarms.map((alarm) => alarm.id));
  const changed = alarms.filter((alarm) => {
    const item = current.get(alarm.id);
    return (
      !item || item.extra?.at !== alarm.at || item.extra?.title !== alarm.title
    );
  });
  const replace = new Set(changed.map((alarm) => alarm.id));
  return {
    schedule: changed,
    cancel: ours
      .filter((item) => !wanted.has(item.id) || replace.has(item.id))
      .map((item) => item.id),
  };
}

export type NativeAlarmPermission =
  'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' | 'unsupported';

export type NativeAlarmState = {
  /** The plugin only runs inside the Android shell. */
  available: boolean;
  checked: boolean;
  busy: boolean;
  permission: NativeAlarmPermission;
  exact: 'granted' | 'denied' | 'unsupported';
  scheduled: number;
  duplicates: number;
  /** The last schedule fell back to an inexact alarm. */
  approximate: boolean;
  /** A status the inbox must show; the inbox stays the durable record. */
  problem: '' | 'permission' | 'error' | 'unsupported';
};

const initial: NativeAlarmState = {
  available: nativePlatform(),
  checked: false,
  busy: false,
  permission: 'unsupported',
  exact: 'unsupported',
  scheduled: 0,
  duplicates: 0,
  approximate: false,
  problem: '',
};

let state = initial;
const listeners = new Set<() => void>();
const publish = (patch: Partial<NativeAlarmState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};

let module: Promise<typeof import('@capacitor/local-notifications')> | null =
  null;
const plugin = () => (module ??= import('@capacitor/local-notifications'));

let channelReady = false;
async function ensureChannel() {
  if (channelReady) return;
  const { LocalNotifications } = await plugin();
  await LocalNotifications.createChannel({
    id: reminderChannel,
    name: 'Reminders',
    description: 'Personal Hub reminder alarms',
    importance: 4,
  }).catch(() => undefined);
  channelReady = true;
}

const permissionOf = (value: string): NativeAlarmPermission =>
  value === 'granted' || value === 'denied' || value === 'prompt'
    ? value
    : value === 'prompt-with-rationale'
      ? 'prompt-with-rationale'
      : 'unsupported';

async function readPermission() {
  const { LocalNotifications } = await plugin();
  const status = await LocalNotifications.checkPermissions().catch(() => null);
  const permission = status
    ? permissionOf(status.display)
    : ('unsupported' as const);
  let exact: NativeAlarmState['exact'] = 'unsupported';
  if (permission !== 'unsupported' && Capacitor.getPlatform() === 'android') {
    const setting =
      await LocalNotifications.checkExactNotificationSetting().catch(
        () => null,
      );
    exact = setting
      ? setting.exact_alarm === 'granted'
        ? 'granted'
        : 'denied'
      : 'unsupported';
  }
  publish({ available: true, checked: true, permission, exact });
  return permission;
}

async function runReconcile(reminders?: Reminder[]) {
  if (!nativePlatform()) return;
  publish({ busy: true });
  try {
    const permission = await readPermission();
    if (permission !== 'granted') {
      publish({
        busy: false,
        scheduled: 0,
        duplicates: 0,
        problem: permission === 'denied' ? 'permission' : '',
      });
      return;
    }
    await ensureChannel();
    const { LocalNotifications } = await plugin();
    const list =
      reminders ??
      (
        await getSnapshot(
          '/api/v1/reminders',
          remindersSchema,
          new AbortController().signal,
        )
      ).data.reminders;
    const pending = (await LocalNotifications.getPending()).notifications;
    const plan = planAlarms(list, new Date());
    const changes = diffAlarms(
      plan.alarms,
      pending.map((item) => ({ id: item.id, extra: item.extra })),
    );
    if (changes.cancel.length)
      await LocalNotifications.cancel({
        notifications: changes.cancel.map((id) => ({ id })),
      });
    let warning = '';
    if (changes.schedule.length) {
      const result = await LocalNotifications.schedule({
        notifications: changes.schedule.map((alarm) => ({
          id: alarm.id,
          title: 'Personal Hub reminder',
          body: alarm.title,
          channelId: reminderChannel,
          smallIcon: 'hub_notification',
          schedule: { at: new Date(alarm.at), allowWhileIdle: true },
          extra: {
            hub: marker,
            reminderId: alarm.reminderId,
            at: alarm.at,
            title: alarm.title,
          },
        })),
      });
      warning = result.warning?.code ?? '';
    }
    publish({
      busy: false,
      scheduled: plan.alarms.length,
      duplicates: plan.duplicates,
      approximate: !!warning,
      problem: '',
    });
  } catch {
    // Error text may include reminder content; only a fixed state leaves here.
    publish({ busy: false, problem: 'error' });
  }
}

let queue: Promise<void> = Promise.resolve();

export const nativeAlarms = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /**
   * Align the device's scheduled alarms with the reminder list. Reconciles are
   * serialized; the latest call wins the pending queue. Callers that already
   * hold the list pass it, so the inbox does not fetch it twice.
   */
  reconcile(reminders?: Reminder[]) {
    if (!nativePlatform()) return Promise.resolve();
    const next = queue.then(
      () => runReconcile(reminders),
      () => runReconcile(reminders),
    );
    queue = next.catch(() => undefined);
    return next;
  },
  /** Re-read permission and exact-alarm settings without changing alarms. */
  async refresh() {
    if (!nativePlatform()) return;
    publish({ busy: true });
    try {
      const permission = await readPermission();
      publish({
        busy: false,
        problem: permission === 'denied' ? 'permission' : '',
      });
    } catch {
      publish({ busy: false, problem: 'error', checked: true });
    }
  },
  /** Ask for notification permission, then schedule what is missing. */
  async enable() {
    if (!nativePlatform()) return;
    try {
      const { LocalNotifications } = await plugin();
      const status = await LocalNotifications.requestPermissions();
      publish({
        checked: true,
        permission: permissionOf(status.display),
      });
      if (status.display === 'granted') await runReconcile();
    } catch {
      publish({ problem: 'error' });
    }
  },
  /** Opens the Android exact-alarm setting for this app, then re-checks. */
  async allowExact() {
    if (!nativePlatform()) return;
    try {
      const { LocalNotifications } = await plugin();
      const setting = await LocalNotifications.changeExactNotificationSetting();
      publish({
        exact: setting.exact_alarm === 'granted' ? 'granted' : 'denied',
      });
      await runReconcile();
    } catch {
      publish({ problem: 'error' });
    }
  },
  /** Sign-out and session lock remove private titles from the tray. */
  async clear() {
    if (!nativePlatform()) return;
    try {
      const { LocalNotifications } = await plugin();
      const pending = (await LocalNotifications.getPending()).notifications;
      const ids = pending
        .filter((item) => item.extra?.hub === marker)
        .map((item) => item.id);
      if (ids.length)
        await LocalNotifications.cancel({
          notifications: ids.map((id) => ({ id })),
        });
    } catch {
      /* Alarms are device state; sign-out still completes. */
    }
    publish({ scheduled: 0, duplicates: 0 });
  },
};

/** Subscribes the inbox to the device-alarm state and its actions. */
export function useNativeAlarms() {
  return useSyncExternalStore(
    nativeAlarms.subscribe,
    nativeAlarms.getState,
    nativeAlarms.getState,
  );
}

/**
 * App-shell reconciliation. Runs at launch, when the shell resumes, and after
 * a server round-trip that may have changed reminders elsewhere.
 */
export function useNativeAlarmSync(successes: number, onOpen?: () => void) {
  useEffect(() => {
    void nativeAlarms.reconcile();
    const resume = () => {
      if (document.visibilityState === 'visible') void nativeAlarms.reconcile();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, []);
  const seen = useRef(successes);
  useEffect(() => {
    if (successes === seen.current) return;
    seen.current = successes;
    void nativeAlarms.reconcile();
  }, [successes]);
  // A notification tap opens the app; the reminder list is the useful target.
  useEffect(() => {
    if (!nativePlatform()) return;
    let remove: (() => void) | undefined;
    let cancelled = false;
    void import('@capacitor/local-notifications').then(
      async ({ LocalNotifications }) => {
        const handle = await LocalNotifications.addListener(
          'localNotificationActionPerformed',
          () => onOpen?.(),
        );
        if (cancelled) void handle.remove();
        else remove = () => void handle.remove();
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      remove?.();
    };
  }, [onOpen]);
}
