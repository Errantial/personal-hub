import type { AssistantProposal, CalendarRecord, Task } from '@hub/contracts';
import { formatDate } from './format';

/** Plain-language summary of one proposed change. */
export function describeProposal(
  proposal: AssistantProposal,
  timeZone: string,
): string {
  const time = (instant: string) =>
    new Date(instant).toLocaleString(undefined, {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const clock = (instant: string) =>
    new Date(instant).toLocaleTimeString(undefined, {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    });
  const span = (start: string, end: string) => `${time(start)} – ${clock(end)}`;
  switch (proposal.kind) {
    case 'task.create': {
      const { task } = proposal;
      return [
        `Add task “${task.title}”`,
        task.dueDate ? `due ${formatDate(task.dueDate)}` : 'no due date',
        ...(task.priority === 'normal' ? [] : [`${task.priority} priority`]),
      ].join(' · ');
    }
    case 'task.update': {
      const { target, changes } = proposal;
      const parts = [
        ...(changes.title !== undefined
          ? [`rename to “${changes.title}”`]
          : []),
        ...(changes.dueDate !== undefined
          ? [
              changes.dueDate
                ? `due ${target.dueDate ? `${formatDate(target.dueDate)} → ` : ''}${formatDate(changes.dueDate)}`
                : 'remove due date',
            ]
          : []),
        ...(changes.priority ? [`${changes.priority} priority`] : []),
        ...(changes.completed !== undefined
          ? [changes.completed ? 'mark done' : 'mark not done']
          : []),
      ];
      return `Change task “${target.title}”: ${parts.join(', ')}`;
    }
    case 'event.create': {
      const { event } = proposal;
      return `Add event “${event.title}” · ${
        event.allDay
          ? allDayRange(event.startDate!, event.endDate!)
          : span(event.startsAt, event.endsAt)
      }`;
    }
    case 'event.update': {
      const { target, changes } = proposal;
      const parts = [
        ...(changes.title !== undefined
          ? [`rename to “${changes.title}”`]
          : []),
        ...(changes.startsAt || changes.endsAt
          ? [
              `${span(target.startsAt, target.endsAt)} → ${span(
                changes.startsAt ?? target.startsAt,
                changes.endsAt ?? target.endsAt,
              )}`,
            ]
          : []),
      ];
      return `Change event “${target.title}”: ${parts.join(', ')}`;
    }
  }
}
/** End dates are exclusive; show the last day. */
function allDayRange(start: string, end: string) {
  const last = new Date(Date.parse(end) - 86400000).toISOString().slice(0, 10);
  return last === start
    ? `${formatDate(start)}, all day`
    : `${formatDate(start)} – ${formatDate(last)}, all day`;
}

const taskFields = (task: Task) => ({
  title: task.title,
  notes: task.notes,
  dueDate: task.dueDate,
  priority: task.priority,
  completed: task.completed,
});
const eventFields = (event: CalendarRecord) => ({
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

/** "$0.0004" for small amounts; microdollars in. */
export const formatCost = (micros: number) =>
  `$${(micros / 1e6).toFixed(micros < 10000 ? 4 : 2)}`;
