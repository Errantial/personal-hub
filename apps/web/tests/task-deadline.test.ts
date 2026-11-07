import { expect, it } from 'vitest';
import {
  projectTaskDeadline,
  taskDueDraft,
  taskDuePayload,
} from '../src/lib/task-deadline';
import { createTaskSchema, taskSchema } from '@hub/contracts';
import type { Task } from '@hub/contracts';

const current = {
  dueDate: '2027-11-07',
  dueAt: '2027-11-07T06:30:00.000Z',
  dueTimeZone: 'America/New_York',
};

it('projects stale-client task timing updates without losing an unchanged deadline', () => {
  expect(projectTaskDeadline(current, {})).toEqual(current);
  expect(projectTaskDeadline(current, { dueDate: current.dueDate })).toEqual(
    current,
  );
  expect(projectTaskDeadline(current, { dueDate: '2027-11-08' })).toEqual({
    dueDate: '2027-11-08',
    dueAt: null,
    dueTimeZone: null,
  });
  expect(
    projectTaskDeadline(current, { dueAt: null, dueTimeZone: null }),
  ).toEqual({
    dueDate: current.dueDate,
    dueAt: null,
    dueTimeZone: null,
  });
});

it('rejects DST gaps and requires an explicit side of a fold', () => {
  expect(() =>
    taskDuePayload({
      dueDate: '2027-03-14',
      dueTime: '02:30',
      dueTimeZone: 'America/New_York',
      dueOffset: '',
    }),
  ).toThrow(/does not exist/);
  const fold = {
    dueDate: '2027-11-07',
    dueTime: '01:30',
    dueTimeZone: 'America/New_York',
    dueOffset: '' as const,
  };
  expect(() => taskDuePayload(fold)).toThrow(/happens twice/);
  expect(taskDuePayload({ ...fold, dueOffset: 'earlier' }).dueAt).toBe(
    '2027-11-07T05:30:00.000Z',
  );
  expect(taskDuePayload({ ...fold, dueOffset: 'later' }).dueAt).toBe(
    '2027-11-07T06:30:00.000Z',
  );
});

it('round-trips the stored side of a repeated due time', () => {
  const task = {
    ...current,
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Fold task',
    notes: '',
    priority: 'normal',
    completed: false,
    sensitivity: 'unlabeled',
    version: 1,
    createdAt: '2027-11-01T00:00:00.000Z',
    updatedAt: '2027-11-01T00:00:00.000Z',
    deletedAt: null,
    canvasSource: null,
    academicSource: null,
    mailSource: null,
  } satisfies Task;
  expect(taskDueDraft(task)).toMatchObject({
    dueDate: '2027-11-07',
    dueTime: '01:30',
    dueTimeZone: 'America/New_York',
    dueOffset: 'later',
  });
});

it('keeps base task schemas composable for date-only AI and academic projections', () => {
  const projection = taskSchema.pick({ title: true, dueDate: true });
  expect(
    projection.parse({ title: 'Date only', dueDate: '2027-11-07' }),
  ).toEqual({
    title: 'Date only',
    dueDate: '2027-11-07',
  });
  const academic = createTaskSchema.omit({
    operationId: true,
    canvasSourceRef: true,
    clientId: true,
    dueAt: true,
    dueTimeZone: true,
  });
  expect(academic.parse({ title: 'Academic date only' })).toMatchObject({
    title: 'Academic date only',
    dueDate: null,
  });
});
