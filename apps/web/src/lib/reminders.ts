import type { HubNotification, Reminder } from '@hub/contracts';

/** Reminders that can still act (or need attention) versus finished ones. */
export function splitReminders(reminders: Reminder[]) {
  const sorted = [...reminders].sort(
    (a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt),
  );
  return {
    active: sorted.filter((item) =>
      ['queued', 'running', 'paused', 'failed'].includes(item.status),
    ),
    earlier: sorted
      .filter((item) => ['delivered', 'cancelled'].includes(item.status))
      .reverse(),
  };
}

/** Unread first, then newest first within each group. */
export function sortNotifications(items: HubNotification[]) {
  return [...items].sort(
    (a, b) =>
      Number(!!a.readAt) - Number(!!b.readAt) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export type Worker = {
  healthy: boolean;
  lastTick: string | null;
  errorCode: string | null;
};

/** One-line worker health: whether it runs, and when it last checked in. */
export function workerSummary(worker: Worker) {
  const seen = worker.lastTick
    ? ` Last seen ${new Date(worker.lastTick).toLocaleString()}.`
    : '';
  if (worker.healthy)
    return { text: `Reminder worker is running.${seen}`, ok: true };
  if (worker.errorCode)
    return { text: `Reminder worker reported a failure.${seen}`, ok: false };
  return {
    text: `Reminder worker has not checked in recently.${seen}`,
    ok: false,
  };
}

export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export const permissionLabels: Record<PermissionState, string> = {
  default: 'Not enabled',
  granted: 'Allowed',
  denied: 'Blocked by browser',
  unsupported: 'Not supported',
};

/** Snooze shortcuts: minutes from now, or tomorrow 09:00 (local wall time). */
export function snoozeChoices(now: Date) {
  const wall = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const inHour = new Date(now.getTime() + 60 * 60 * 1000);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: 'In 1 hour', value: wall(inHour) },
    { label: 'Tomorrow 09:00', value: wall(tomorrow) },
  ];
}
