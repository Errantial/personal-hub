import type { AcademicWork, CalendarRecord, Topic } from '@hub/contracts';
import { selectionItems } from './selection';
import type { Selection } from './selection';

/** A topic with no progress and unknown confidence has not been assessed. */
export const isAssessed = (topic: Pick<Topic, 'progress' | 'confidence'>) =>
  topic.progress > 0 || topic.confidence !== 'unknown';

export function assessmentLabel(topic: Pick<Topic, 'progress' | 'confidence'>) {
  return isAssessed(topic)
    ? `${topic.progress}% complete · confidence: ${topic.confidence}`
    : 'Not assessed';
}

/** Average self-reported progress over assessed topics, or null when none. */
export function averageProgress(
  topics: Pick<Topic, 'progress' | 'confidence'>[],
) {
  const assessed = topics.filter(isAssessed);
  return assessed.length
    ? Math.round(
        assessed.reduce((sum, topic) => sum + topic.progress, 0) /
          assessed.length,
      )
    : null;
}

/** Study blocks of one class, upcoming first (soonest first), then earlier
 *  ones (most recent first). Recurring blocks sort by their first start. */
export function splitStudyBlocks(
  events: CalendarRecord[],
  courseId: string,
  now: Date,
) {
  const blocks = events.filter(
    (event) => event.courseId === courseId && !event.deletedAt,
  );
  const ends = (event: CalendarRecord) =>
    event.recurrence ? Infinity : new Date(event.endsAt).getTime();
  const starts = (event: CalendarRecord) => new Date(event.startsAt).getTime();
  return {
    upcoming: blocks
      .filter((event) => ends(event) >= now.getTime())
      .sort((a, b) => starts(a) - starts(b)),
    earlier: blocks
      .filter((event) => ends(event) < now.getTime())
      .sort((a, b) => starts(b) - starts(a)),
  };
}

/* Academic work: owner-entered assignments, exams and projects. */

export const workStatusLabels: Record<AcademicWork['status'], string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  submitted: 'Submitted',
  cancelled: 'Cancelled',
};
export const workKindLabels: Record<AcademicWork['kind'], string> = {
  assignment: 'Assignment',
  exam: 'Exam',
  project: 'Project',
  other: 'Other',
};
/** Priority 1-5; the study planner ranks higher numbers first. */
export const priorityLabel = (priority: number) =>
  priority === 5
    ? '5 (highest)'
    : priority === 1
      ? '1 (lowest)'
      : `${priority}`;

/** "45 min", "2 h", "2 h 30 min". Null is unknown; zero is known. */
export function minutesLabel(minutes: number | null) {
  if (minutes === null) return 'No estimate';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "18 / 20 (90%)" for a recorded score. */
export function scoreLabel(grade: NonNullable<AcademicWork['grade']>) {
  const percent = Math.round((grade.earned / grade.possible) * 1000) / 10;
  return `${grade.earned} / ${grade.possible} (${percent}%)`;
}

export type WorkChange =
  | { kind: 'status'; status: AcademicWork['status'] }
  | { kind: 'priority'; priority: number }
  | { kind: 'due'; dueDate: string | null }
  | { kind: 'estimate'; estimatedMinutes: number | null }
  | { kind: 'delete' };

/** Request body without operationId, which the mutation hook adds. Every
 *  selection carries the version of the class it was listed with. */
export function workBatchBody(
  selection: Selection,
  courseVersion: number,
  change: WorkChange,
) {
  const items = selectionItems(selection).map((item) => ({
    ...item,
    expectedCourseVersion: courseVersion,
  }));
  const changes =
    change.kind === 'status'
      ? { status: change.status }
      : change.kind === 'priority'
        ? { priority: change.priority }
        : change.kind === 'due'
          ? { dueDate: change.dueDate }
          : change.kind === 'estimate'
            ? { estimatedMinutes: change.estimatedMinutes }
            : null;
  return {
    items,
    action: changes ? { kind: 'update', changes } : { kind: 'delete' },
  };
}
