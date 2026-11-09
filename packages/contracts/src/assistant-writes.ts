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
  returns: 'task' | 'event' | 'reminder' | 'capability';
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
      if (proposal.academicSource)
        return {
          method: 'POST',
          path: `/api/v1/academic-work/${proposal.academicSource.id}/planner-work`,
          body: {
            kind: 'task',
            task: proposal.task,
            operationId,
            expectedWorkVersion: proposal.academicSource.expectedWorkVersion,
            expectedCourseVersion:
              proposal.academicSource.expectedCourseVersion,
          },
          returns: 'task',
        };
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
    case 'reminder.create':
      return {
        method: 'POST',
        path: '/api/v1/reminders',
        body: {
          title: proposal.reminder.title,
          scheduledAt: proposal.reminder.scheduledAt,
          targetKind: 'task',
          targetId: proposal.target.id,
          operationId,
          clientId: operationId,
        },
        returns: 'reminder',
      };
    case 'reminder.update':
      return {
        method: 'PUT',
        path: `/api/v1/reminders/${proposal.target.id}`,
        body: {
          title: proposal.changes.title ?? proposal.target.title,
          scheduledAt:
            proposal.changes.scheduledAt ?? proposal.target.scheduledAt,
          operationId,
          expectedVersion: proposal.target.version,
        },
        returns: 'reminder',
      };
    case 'reminder.cancel':
      return {
        method: 'POST',
        path: `/api/v1/reminders/${proposal.target.id}/control`,
        body: {
          operationId,
          expectedVersion: proposal.target.version,
        },
        returns: 'reminder',
      };
    case 'capability':
      return {
        method: 'POST',
        path: '/internal/ai/capability',
        body: {
          capability: proposal.capability,
          arguments: proposal.arguments,
          operationId,
        },
        returns: 'capability',
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
    case 'reminder.create':
      return {
        method: 'POST',
        path: `/api/v1/reminders/${applied.id}/control`,
        body: {
          action: 'cancel',
          operationId,
          expectedVersion: applied.version,
        },
        returns: 'reminder',
      };
    case 'reminder.update':
      return {
        method: 'PUT',
        path: `/api/v1/reminders/${applied.id}`,
        body: {
          title: proposal.target.title,
          scheduledAt: proposal.target.scheduledAt,
          operationId,
          expectedVersion: applied.version,
        },
        returns: 'reminder',
      };
    case 'reminder.cancel':
      return {
        method: 'POST',
        path: '/api/v1/reminders',
        body: {
          title: proposal.target.title,
          scheduledAt: proposal.target.scheduledAt,
          targetKind: proposal.target.targetKind,
          targetId: proposal.target.targetId,
          occurrenceDate: proposal.target.occurrenceDate,
          operationId,
          clientId: operationId,
        },
        returns: 'reminder',
      };
    case 'capability':
      return {
        method: 'POST',
        path: '/internal/ai/capability/undo',
        body: { auditId: applied.id, operationId },
        returns: 'capability',
      };
  }
}
