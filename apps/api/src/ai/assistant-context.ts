import type { Course, Topic } from '@hub/contracts';
import type { z } from 'zod';
import type { sensitivitySchema } from '@hub/contracts';
import { courseSchema, reminderSchema, topicSchema } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { reminderColumns } from '../features/reminders.js';
import { topicColumns } from '../features/common.js';
import {
  livePlannerContext,
  projectCourse,
  projectEvent,
  projectReminder,
  projectTask,
  projectTopic,
} from './live-projections.js';
import type { PlannerContext } from './live-projections.js';
import { topicLabelState } from './topic-labels.js';

/** Conservative serialized-size budget for the server-assembled context. */
export const maxContextChars = 24000;

export type AssistantContext = PlannerContext & {
  /** Items dropped from the base planner window by this budget. */
  trimmed: number;
};

/** Current owner state for one Assistant/agent exchange, cheapest first. */
export async function assistantContext(
  tx: QueryExecutor,
  owner: string,
  timeZone: string,
  allowed: z.infer<typeof sensitivitySchema>[] = ['unlabeled'],
): Promise<AssistantContext> {
  const base = await livePlannerContext(tx, owner, { limit: 150 });
  const taskIds = new Set(base.tasks.map((task) => task.id));
  const reminders = (
    await tx.query(
      `SELECT ${reminderColumns} FROM reminders WHERE owner_id=$1 AND target_kind='task'
       AND status IN ('queued','paused','failed') ORDER BY scheduled_at,id LIMIT 80`,
      [owner],
    )
  )
    .map((row) => reminderSchema.parse(row))
    .filter(
      (reminder) =>
        reminder.targetId !== null && taskIds.has(reminder.targetId),
    );
  const courses = (
    await tx.query(
      `SELECT id,name,term,instructor,notes,sensitivity,version,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
         NULL::text AS "deletedAt"
       FROM courses WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY name,id LIMIT 60`,
      [owner],
    )
  )
    .map((row) => courseSchema.parse(row))
    .filter((course) => allowed.includes(course.sensitivity)) as Course[];
  const courseIds = new Set(courses.map((course) => course.id));
  const courseSensitivity = new Map(
    courses.map((course) => [course.id, course.sensitivity]),
  );
  const topics = (
    await tx.query(
      `SELECT ${topicColumns} FROM topics
       WHERE owner_id=$1 AND deleted_at IS NULL
         AND academic_labels IS NOT NULL
         AND sensitivity=ANY($2::text[])
         AND EXISTS (
           SELECT 1 FROM courses c
           WHERE c.id=topics.course_id AND c.owner_id=topics.owner_id
             AND c.deleted_at IS NULL AND c.sensitivity=ANY($2::text[])
         )
         AND NOT EXISTS (
           SELECT 1 FROM unnest(academic_labels) AS history(label)
           WHERE history.label<>ALL($2::text[])
         )
       ORDER BY name,id LIMIT 120`,
      [owner, allowed],
    )
  )
    .map((row) => topicSchema.parse(row))
    .filter((topic) => {
      if (!courseIds.has(topic.courseId)) return false;
      const labels = topicLabelState(
        topic,
        courseSensitivity.get(topic.courseId) ?? 'unlabeled',
      );
      return (
        labels.complete &&
        labels.labels.every((label) => allowed.includes(label))
      );
    }) as Topic[];
  return fitContext(
    {
      ...base,
      reminders,
      courses,
      topics,
      trimmed: base.trimmed ?? 0,
    },
    timeZone,
  );
}

const size = (value: unknown) => JSON.stringify(value).length;

/** Drops lowest-priority items until the projected payload fits the budget. */
function fitContext(context: AssistantContext, timeZone: string) {
  const tasks = context.tasks.slice(0, 60);
  const events = context.events.slice(0, 60);
  const taskIds = new Set(tasks.map((task) => task.id));
  const reminders = (context.reminders ?? [])
    .filter(
      (reminder) =>
        reminder.targetId !== null && taskIds.has(reminder.targetId),
    )
    .slice(0, 40);
  const courses = (context.courses ?? []).slice(0, 30);
  const courseIds = () => new Set(courses.map((course) => course.id));
  const topics = (context.topics ?? [])
    .filter((topic) => courseIds().has(topic.courseId))
    .slice(0, 60);
  let trimmed =
    (context.trimmed ?? 0) +
    (context.tasks.length - tasks.length) +
    (context.events.length - events.length) +
    ((context.reminders ?? []).length - reminders.length) +
    ((context.courses ?? []).length - courses.length) +
    ((context.topics ?? []).length - topics.length);
  const estimate = (
    t: typeof tasks,
    e: typeof events,
    r: typeof reminders,
    c: typeof courses,
    p: typeof topics,
  ) =>
    size({
      tasks: t.map((task, index) => projectTask(task, `t${index + 1}`)),
      events: e.map((event, index) =>
        projectEvent(event, `e${index + 1}`, timeZone),
      ),
      reminders: r.map((reminder, index) =>
        projectReminder(reminder, `r${index + 1}`, timeZone),
      ),
      courses: c.map((course, index) => projectCourse(course, `c${index + 1}`)),
      topics: p.map((topic, index) =>
        projectTopic(
          topic,
          `p${index + 1}`,
          c.find((course) => course.id === topic.courseId)
            ? `c${c.findIndex((course) => course.id === topic.courseId) + 1}`
            : null,
        ),
      ),
    });
  let current = estimate(tasks, events, reminders, courses, topics);
  while (current > maxContextChars) {
    const activeCourseIds = courseIds();
    const orphans = topics.filter(
      (topic) => !activeCourseIds.has(topic.courseId),
    );
    if (orphans.length) {
      for (let index = topics.length - 1; index >= 0; index--)
        if (!activeCourseIds.has(topics[index]!.courseId)) {
          topics.splice(index, 1);
          trimmed += 1;
        }
    } else if (topics.length > 5) {
      topics.pop();
      trimmed += 1;
    } else if (courses.length > 5) {
      courses.pop();
      trimmed += 1;
    } else if (reminders.length > 5) {
      reminders.pop();
      trimmed += 1;
    } else if (events.length > 5) {
      events.pop();
      trimmed += 1;
    } else if (tasks.length > 5) {
      tasks.pop();
      trimmed += 1;
    } else break;
    current = estimate(tasks, events, reminders, courses, topics);
  }
  // A course removed on the final budget iteration must not leave its topics
  // behind with a missing course ref.
  const finalCourseIds = courseIds();
  for (let index = topics.length - 1; index >= 0; index--)
    if (!finalCourseIds.has(topics[index]!.courseId)) {
      topics.splice(index, 1);
      trimmed += 1;
    }
  return { ...context, tasks, events, reminders, courses, topics, trimmed };
}
