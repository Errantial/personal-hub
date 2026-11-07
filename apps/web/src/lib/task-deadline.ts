import { Temporal, instantToWall, wallTimeToInstant } from '@hub/contracts';
import type { Task } from '@hub/contracts';
import { checkLocalTime } from './calendar';

export type TaskDueDraft = {
  dueDate: string;
  dueTime: string;
  dueTimeZone: string;
  dueOffset: '' | 'earlier' | 'later';
};

export const deviceTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const emptyTaskDue = (): TaskDueDraft => ({
  dueDate: '',
  dueTime: '',
  dueTimeZone: deviceTimeZone(),
  dueOffset: '',
});

function storedFoldChoice(task: Task): TaskDueDraft['dueOffset'] {
  if (!task.dueAt || !task.dueTimeZone) return '';
  const local = instantToWall(task.dueAt, task.dueTimeZone);
  if (checkLocalTime(local, task.dueTimeZone) !== 'fold') return '';
  const plain = Temporal.PlainDateTime.from(local);
  const earlier = plain.toZonedDateTime(task.dueTimeZone, {
    disambiguation: 'earlier',
  });
  return earlier.toInstant().equals(Temporal.Instant.from(task.dueAt))
    ? 'earlier'
    : 'later';
}

export function taskDueDraft(task: Task): TaskDueDraft {
  if (!task.dueAt || !task.dueTimeZone)
    return {
      dueDate: task.dueDate ?? '',
      dueTime: '',
      dueTimeZone: deviceTimeZone(),
      dueOffset: '',
    };
  const wall = instantToWall(task.dueAt, task.dueTimeZone);
  return {
    dueDate: task.dueDate ?? '',
    dueTime: wall.slice(11, 16),
    dueTimeZone: task.dueTimeZone,
    dueOffset: storedFoldChoice(task),
  };
}

export function taskDuePayload(draft: TaskDueDraft) {
  if (!draft.dueDate)
    return { dueDate: null, dueAt: null, dueTimeZone: null } as const;
  if (!draft.dueTime)
    return {
      dueDate: draft.dueDate,
      dueAt: null,
      dueTimeZone: null,
    } as const;
  const local = `${draft.dueDate}T${draft.dueTime}`;
  const check = checkLocalTime(local, draft.dueTimeZone);
  if (check === 'gap')
    throw new Error('This due time does not exist in the selected timezone.');
  if (check === 'invalid') throw new Error('Choose a valid timezone.');
  if (check === 'fold' && !draft.dueOffset)
    throw new Error('This due time happens twice. Choose earlier or later.');
  return {
    dueDate: draft.dueDate,
    dueAt: wallTimeToInstant(
      local,
      draft.dueTimeZone,
      check === 'fold' ? (draft.dueOffset as 'earlier' | 'later') : 'reject',
    ),
    dueTimeZone: draft.dueTimeZone,
  };
}

export function formatTaskDueTime(task: Task) {
  if (!task.dueAt || !task.dueTimeZone) return null;
  return new Date(task.dueAt).toLocaleTimeString(undefined, {
    timeZone: task.dueTimeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function projectTaskDeadline(
  current: Pick<Task, 'dueDate' | 'dueAt' | 'dueTimeZone'>,
  change: {
    dueDate?: string | null | undefined;
    dueAt?: string | null | undefined;
    dueTimeZone?: string | null | undefined;
  },
) {
  const dueDate =
    change.dueDate === undefined ? current.dueDate : change.dueDate;
  if (change.dueAt !== undefined || change.dueTimeZone !== undefined)
    return {
      dueDate,
      dueAt: change.dueAt ?? null,
      dueTimeZone: change.dueTimeZone ?? null,
    };
  if (change.dueDate !== undefined && change.dueDate !== current.dueDate)
    return { dueDate, dueAt: null, dueTimeZone: null };
  return {
    dueDate,
    dueAt: current.dueAt,
    dueTimeZone: current.dueTimeZone,
  };
}
