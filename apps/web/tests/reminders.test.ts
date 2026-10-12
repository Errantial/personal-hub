import { expect, it } from 'vitest';
import type { HubNotification, Reminder } from '@hub/contracts';
import {
  snoozeChoices,
  sortNotifications,
  splitReminders,
  workerSummary,
} from '../src/lib/reminders';

const reminder = (id: string, status: Reminder['status'], at: string) =>
  ({ id, status, scheduledAt: at }) as Reminder;
const note = (id: string, createdAt: string, readAt: string | null) =>
  ({ id, createdAt, readAt }) as HubNotification;

it('splits reminders into active (soonest first) and earlier (latest first)', () => {
  const { active, earlier } = splitReminders([
    reminder('late', 'queued', '2027-03-09T10:00:00.000Z'),
    reminder('done', 'delivered', '2027-03-01T10:00:00.000Z'),
    reminder('soon', 'failed', '2027-03-08T10:00:00.000Z'),
    reminder('old', 'cancelled', '2027-02-01T10:00:00.000Z'),
    reminder('paused', 'paused', '2027-03-10T10:00:00.000Z'),
  ]);
  expect(active.map((item) => item.id)).toEqual(['soon', 'late', 'paused']);
  expect(earlier.map((item) => item.id)).toEqual(['done', 'old']);
});

it('lists unread notifications first, newest first', () => {
  const sorted = sortNotifications([
    note('read-new', '2027-03-09T10:00:00.000Z', '2027-03-09T11:00:00.000Z'),
    note('unread-old', '2027-03-01T10:00:00.000Z', null),
    note('unread-new', '2027-03-08T10:00:00.000Z', null),
  ]);
  expect(sorted.map((item) => item.id)).toEqual([
    'unread-new',
    'unread-old',
    'read-new',
  ]);
});

it('describes worker health with the failure state kept visible', () => {
  expect(
    workerSummary({ healthy: true, lastTick: null, errorCode: null }),
  ).toEqual({ text: 'Reminder worker is running.', ok: true });
  expect(
    workerSummary({ healthy: false, lastTick: null, errorCode: 'X' }).text,
  ).toBe('Reminder worker reported a failure.');
  expect(
    workerSummary({ healthy: false, lastTick: null, errorCode: null }).text,
  ).toBe('Reminder worker has not checked in recently.');
});

it('offers snooze times in local wall-clock form', () => {
  const choices = snoozeChoices(new Date(2027, 2, 8, 14, 30));
  expect(choices).toEqual([
    { label: 'In 1 hour', value: '2027-03-08T15:30' },
    { label: 'Tomorrow 09:00', value: '2027-03-09T09:00' },
  ]);
});
