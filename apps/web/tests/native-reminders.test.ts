import { expect, it } from 'vitest';
import type { Reminder } from '@hub/contracts';
import {
  diffAlarms,
  notificationId,
  planAlarms,
  type ReminderAlarm,
} from '../src/lib/native-reminders';

const reminder = (id: string, status: Reminder['status'], at: string) =>
  ({ id, status, scheduledAt: at, title: `Title ${id}` }) as Reminder;

const now = new Date('2027-03-01T12:00:00.000Z');

it('maps reminder ids to stable positive 32-bit notification ids', () => {
  const id = notificationId('8f0b7c1e-2f77-4b52-9d9b-6a1e2b3c4d5e');
  expect(notificationId('8f0b7c1e-2f77-4b52-9d9b-6a1e2b3c4d5e')).toBe(id);
  expect(Number.isInteger(id)).toBe(true);
  expect(id).toBeGreaterThan(0);
  expect(id).toBeLessThan(2147483647);
  expect(notificationId('00000000-0000-4000-8000-000000000001')).not.toBe(
    notificationId('00000000-0000-4000-8000-000000000002'),
  );
});

it('plans alarms only for future queued or failed reminders', () => {
  const { alarms, duplicates } = planAlarms(
    [
      reminder('soon', 'queued', '2027-03-01T13:00:00.000Z'),
      reminder('retry', 'failed', '2027-03-01T14:00:00.000Z'),
      reminder('paused', 'paused', '2027-03-01T15:00:00.000Z'),
      reminder('done', 'delivered', '2027-03-01T16:00:00.000Z'),
      reminder('cancelled', 'cancelled', '2027-03-01T17:00:00.000Z'),
      reminder('past', 'queued', '2027-03-01T11:59:59.000Z'),
    ],
    now,
  );
  expect(alarms.map((alarm) => alarm.reminderId)).toEqual(['soon', 'retry']);
  expect(alarms[0]).toMatchObject({
    at: '2027-03-01T13:00:00.000Z',
    title: 'Title soon',
  });
  expect(duplicates).toBe(0);
});

it('schedules new alarms, replaces changed ones and cancels removed ones', () => {
  const keep = notificationId('keep');
  const move = notificationId('move');
  const gone = notificationId('gone');
  const ours = (id: number, at: string, title: string) => ({
    id,
    extra: { hub: 'reminder', at, title },
  });
  const alarms: ReminderAlarm[] = [
    {
      id: keep,
      reminderId: 'keep',
      title: 'Keep',
      at: '2027-03-01T13:00:00.000Z',
    },
    {
      id: move,
      reminderId: 'move',
      title: 'Moved',
      at: '2027-03-01T15:00:00.000Z',
    },
    {
      id: notificationId('new'),
      reminderId: 'new',
      title: 'New',
      at: '2027-03-01T16:00:00.000Z',
    },
  ];
  const changes = diffAlarms(alarms, [
    ours(keep, '2027-03-01T13:00:00.000Z', 'Keep'),
    ours(move, '2027-03-01T14:00:00.000Z', 'Moved'),
    ours(gone, '2027-03-01T17:00:00.000Z', 'Gone'),
  ]);
  expect(changes.schedule.map((alarm) => alarm.reminderId)).toEqual([
    'move',
    'new',
  ]);
  expect(new Set(changes.cancel)).toEqual(new Set([move, gone]));
});

it('leaves notifications that this app did not schedule alone', () => {
  const alarms = planAlarms(
    [reminder('mine', 'queued', '2027-03-01T13:00:00.000Z')],
    now,
  ).alarms;
  const changes = diffAlarms(alarms, [
    {
      id: alarms[0]!.id,
      extra: { hub: 'reminder', at: alarms[0]!.at, title: alarms[0]!.title },
    },
    { id: 4242, extra: { hub: 'other' } },
    { id: 4343 },
  ]);
  expect(changes.schedule).toEqual([]);
  expect(changes.cancel).toEqual([]);
});
