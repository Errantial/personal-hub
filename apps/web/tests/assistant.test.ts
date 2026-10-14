import { expect, it } from 'vitest';
import {
  assistantProposalSchema,
  calendarRecordSchema,
  taskSchema,
} from '@hub/contracts';
import {
  applyRequest,
  describeProposal,
  formatCost,
  undoRequest,
} from '../src/lib/assistant';

const task = taskSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  version: 3,
  title: 'Lab report',
  notes: 'Section 2',
  dueDate: '2036-03-10',
  priority: 'normal',
  completed: false,
  sensitivity: 'unlabeled',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  deletedAt: null,
});
const event = calendarRecordSchema.parse({
  id: '00000000-0000-4000-8000-000000000002',
  version: 2,
  title: 'Advisor',
  notes: 'Bring transcript',
  startsAt: '2036-03-10T16:00:00.000Z',
  endsAt: '2036-03-10T16:30:00.000Z',
  timeZone: 'America/Denver',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  deletedAt: null,
});

it('applies updates over the version the model saw and keeps other fields', () => {
  const proposal = assistantProposalSchema.parse({
    kind: 'task.update',
    target: task,
    changes: { dueDate: '2036-03-12', completed: true },
  });
  expect(applyRequest(proposal, 'op')).toEqual({
    method: 'PUT',
    path: `/api/v1/tasks/${task.id}`,
    returns: 'task',
    body: {
      title: 'Lab report',
      notes: 'Section 2',
      dueDate: '2036-03-12',
      priority: 'normal',
      completed: true,
      operationId: 'op',
      expectedVersion: 3,
    },
  });
  // Undo restores the original fields over the applied version.
  expect(
    undoRequest(proposal, { id: task.id, version: 4 }, 'undo').body,
  ).toEqual({
    title: 'Lab report',
    notes: 'Section 2',
    dueDate: '2036-03-10',
    priority: 'normal',
    completed: false,
    operationId: 'undo',
    expectedVersion: 4,
  });
  expect(describeProposal(proposal, 'America/Denver')).toBe(
    'Change task “Lab report”: due Mon, Mar 10, 2036 → Wed, Mar 12, 2036, mark done',
  );
});

it('moves an event without dropping its notes, and deletes created items on undo', () => {
  const moved = assistantProposalSchema.parse({
    kind: 'event.update',
    target: event,
    changes: {
      startsAt: '2036-03-10T17:00:00.000Z',
      endsAt: '2036-03-10T17:30:00.000Z',
    },
  });
  expect(applyRequest(moved, 'op').body).toMatchObject({
    notes: 'Bring transcript',
    startsAt: '2036-03-10T17:00:00.000Z',
    expectedVersion: 2,
    recurrence: null,
  });
  const created = assistantProposalSchema.parse({
    kind: 'task.create',
    task: { title: 'Buy notebook', notes: '', dueDate: null, priority: 'high' },
  });
  expect(describeProposal(created, 'UTC')).toBe(
    'Add task “Buy notebook” · no due date · high priority',
  );
  expect(undoRequest(created, { id: task.id, version: 1 }, 'undo')).toEqual({
    method: 'DELETE',
    path: `/api/v1/tasks/${task.id}`,
    returns: 'task',
    body: { operationId: 'undo', expectedVersion: 1 },
  });
});

it('describes all-day events by their last day and formats small costs', () => {
  const proposal = assistantProposalSchema.parse({
    kind: 'event.create',
    event: {
      title: 'Conference',
      startsAt: '2036-04-02T00:00:00.000Z',
      endsAt: '2036-04-04T00:00:00.000Z',
      timeZone: 'UTC',
      allDay: true,
      startDate: '2036-04-02',
      endDate: '2036-04-04',
    },
  });
  expect(describeProposal(proposal, 'UTC')).toBe(
    'Add event “Conference” · Wed, Apr 2, 2036 – Thu, Apr 3, 2036, all day',
  );
  expect(formatCost(123)).toBe('$0.000123');
  expect(formatCost(150)).toBe('$0.00015');
  expect(formatCost(0)).toBe('$0');
  expect(formatCost(250000)).toBe('$0.25');
});
