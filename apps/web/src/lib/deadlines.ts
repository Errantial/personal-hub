import {
  Temporal,
  canvasDeadlineIdentity,
  instantToWall,
} from '@hub/contracts';
import type {
  TrackedDeadline,
  TrackedDeadlineDue,
  TrackedDeadlineDueOverride,
} from '@hub/contracts';
import { checkLocalTime } from './calendar';
import { deviceTimeZone, emptyTaskDue, taskDuePayload } from './task-deadline';
import type { TaskDueDraft } from './task-deadline';
import { formatDate } from './format';

export type DeadlineDueDraft = {
  mode: 'provider' | 'personal';
  value: TaskDueDraft;
};

function foldChoice(
  dueAt: string,
  timeZone: string,
): TaskDueDraft['dueOffset'] {
  const local = instantToWall(dueAt, timeZone);
  if (checkLocalTime(local, timeZone) !== 'fold') return '';
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(timeZone, {
    disambiguation: 'earlier',
  });
  return earlier.toInstant().equals(Temporal.Instant.from(dueAt))
    ? 'earlier'
    : 'later';
}

const draftForDue = (due: TrackedDeadlineDue): TaskDueDraft => {
  if (due.kind === 'unknown') return emptyTaskDue();
  if (due.kind === 'date')
    return {
      ...emptyTaskDue(),
      dueDate: due.dueDate,
    };
  const timeZone = due.timeZone ?? deviceTimeZone();
  const wall = instantToWall(due.dueAt, timeZone);
  return {
    dueDate: wall.slice(0, 10),
    dueTime: wall.slice(11, 16),
    dueTimeZone: timeZone,
    dueOffset: foldChoice(due.dueAt, timeZone),
  };
};

export const deadlineProviderDueDraft = (
  deadline: Pick<TrackedDeadline, 'providerDue'>,
): DeadlineDueDraft => ({
  mode: 'provider',
  value: draftForDue(deadline.providerDue),
});

export const deadlinePersonalDueDraft = (
  due: TrackedDeadlineDue,
): DeadlineDueDraft => ({
  mode: 'personal',
  value: draftForDue(due),
});

/** Editor state that preserves whether the owner follows Canvas or overrides it. */
export function deadlineDueDraft(deadline: TrackedDeadline): DeadlineDueDraft {
  return deadline.dueOverride.kind === 'provider'
    ? deadlineProviderDueDraft(deadline)
    : deadlinePersonalDueDraft(deadline.dueOverride);
}

/** Convert the owner-facing due editor back into the strict tracked-deadline union. */
export function deadlineDueOverride(
  draft: DeadlineDueDraft,
): TrackedDeadlineDueOverride {
  if (draft.mode === 'provider') return { kind: 'provider' };
  const due = taskDuePayload(draft.value);
  if (!due.dueDate) return { kind: 'unknown' };
  if (!due.dueAt || !due.dueTimeZone)
    return { kind: 'date', dueDate: due.dueDate };
  return {
    kind: 'timed',
    dueAt: due.dueAt,
    timeZone: due.dueTimeZone,
  };
}

export function dueLabel(
  due: TrackedDeadlineDue,
  fallbackTimeZone = deviceTimeZone(),
) {
  if (due.kind === 'unknown') return 'No deadline';
  if (due.kind === 'date') return formatDate(due.dueDate);
  const timeZone = due.timeZone ?? fallbackTimeZone;
  return new Date(due.dueAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
}

export function dueFallsOn(
  due: TrackedDeadlineDue,
  day: string,
  timeZone: string,
) {
  if (due.kind === 'unknown') return false;
  if (due.kind === 'date') return due.dueDate === day;
  return (
    Temporal.Instant.from(due.dueAt)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .toString() === day
  );
}

/** Only exact canonical Canvas assignment/quiz URLs are offered externally. */
export function safeCanvasHref(value: string | null | undefined) {
  return canvasDeadlineIdentity(value)?.canonicalUrl ?? null;
}
