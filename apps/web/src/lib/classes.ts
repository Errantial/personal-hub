import type { CalendarRecord, Topic } from '@hub/contracts';

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
