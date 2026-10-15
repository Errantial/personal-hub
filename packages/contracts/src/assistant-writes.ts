import type { AssistantProposal } from './assistant.js';
import type { Task } from './core.js';
import type { CalendarRecord } from './features.js';

// Apply/Undo planner writes for Assistant proposals, shared by the browser
// and the agent worker (D57) so both send identical versioned requests.

export const taskFields = (task: Task) => ({
  title: task.title,
  notes: task.notes,
  dueDate: task.dueDate,
  priority: task.priority,
  completed: task.completed,
});
export const eventFields = (event: CalendarRecord) => ({
  title: event.title,
  notes: event.notes,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  timeZone: event.timeZone,
  sensitivity: event.sensitivity,
  allDay: event.allDay,
  startDate: event.startDate,
  endDate: event.endDate,
  recurrence: event.recurrence,
  courseId: event.courseId,
  topicId: event.topicId,
  studyStatus: event.studyStatus,
});

export type PlannedRequest = {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
  /** Which record the response holds. */
  returns: 'task' | 'event';
};

/**
 * The ordinary planner write for a proposal. Updates carry the version the
 * model saw, so a change made since then is a conflict, not an overwrite.
 */
export function applyRequest(
  proposal: AssistantProposal,
  operationId: string,
): PlannedRequest {
  switch (proposal.kind) {
    case 'task.create':
      return {
        method: 'POST',
        path: '/api/v1/tasks',
        body: { ...proposal.task, operationId },
        returns: 'task',
      };
    case 'task.update':
      return {
        method: 'PUT',
        path: `/api/v1/tasks/${proposal.target.id}`,
        body: {
          ...taskFields(proposal.target),
          ...proposal.changes,
          operationId,
          expectedVersion: proposal.target.version,
        },
        returns: 'task',
      };
    case 'event.create':
      return {
        method: 'POST',
        path: '/api/v1/calendar',
        body: { ...proposal.event, notes: '', operationId },
        returns: 'event',
      };
    case 'event.update':
      return {
        method: 'PUT',
        path: `/api/v1/calendar/${proposal.target.id}`,
        body: {
          ...eventFields(proposal.target),
          ...proposal.changes,
          operationId,
          expectedVersion: proposal.target.version,
        },
        returns: 'event',
      };
  }
}

/** Reverses an applied proposal: delete what was added, restore the rest. */
export function undoRequest(
  proposal: AssistantProposal,
  applied: { id: string; version: number },
  operationId: string,
): PlannedRequest {
  switch (proposal.kind) {
    case 'task.create':
      return {
        method: 'DELETE',
        path: `/api/v1/tasks/${applied.id}`,
        body: { operationId, expectedVersion: applied.version },
        returns: 'task',
      };
    case 'event.create':
      return {
        method: 'DELETE',
        path: `/api/v1/calendar/${applied.id}`,
        body: { operationId, expectedVersion: applied.version },
        returns: 'event',
      };
    case 'task.update':
      return {
        method: 'PUT',
        path: `/api/v1/tasks/${applied.id}`,
        body: {
          ...taskFields(proposal.target),
          operationId,
          expectedVersion: applied.version,
        },
        returns: 'task',
      };
    case 'event.update':
      return {
        method: 'PUT',
        path: `/api/v1/calendar/${applied.id}`,
        body: {
          ...eventFields(proposal.target),
          operationId,
          expectedVersion: applied.version,
        },
        returns: 'event',
      };
  }
}
