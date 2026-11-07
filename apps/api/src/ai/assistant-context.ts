import type { Course } from '@hub/contracts';
import type { z } from 'zod';
import type { sensitivitySchema } from '@hub/contracts';
import { courseSchema, reminderSchema } from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { reminderColumns } from '../features/reminders.js';
import {
  livePlannerContext,
  projectCourse,
  projectEvent,
  projectReminder,
  projectTask,
} from './live-projections.js';
import type { PlannerContext } from './live-projections.js';

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
  return fitContext(
    {
      ...base,
      reminders,
      courses,
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
  let trimmed =
    (context.trimmed ?? 0) +
    (context.tasks.length - tasks.length) +
    (context.events.length - events.length) +
    ((context.reminders ?? []).length - reminders.length) +
    ((context.courses ?? []).length - courses.length);
  const estimate = (
    t: typeof tasks,
    e: typeof events,
    r: typeof reminders,
    c: typeof courses,
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
    });
  let current = estimate(tasks, events, reminders, courses);
  while (current > maxContextChars) {
    if (courses.length > 5) {
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
    current = estimate(tasks, events, reminders, courses);
  }
  return { ...context, tasks, events, reminders, courses, trimmed };
}
