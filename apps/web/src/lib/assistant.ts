import type { AssistantProposal } from '@hub/contracts';
// The planner writes for Apply/Undo live in contracts so the agent worker
// builds the same requests (D57).
export { applyRequest, undoRequest } from '@hub/contracts';
export type { PlannedRequest } from '@hub/contracts';
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

/** "$0.0004" for small amounts; microdollars in. */
export const formatCost = (micros: number) =>
  // Under a cent, show every microdollar so small charges never round down.
  micros < 10000
    ? `$${(micros / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
    : `$${(micros / 1e6).toFixed(2)}`;
