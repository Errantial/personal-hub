import { createHash } from 'node:crypto';
import {
  Temporal,
  calendarRecordSchema,
  expandEvent,
  studyPreferencesSchema,
  studyGoalSchema,
  studyPreviewSchema,
  studyPlanSchema,
} from '@hub/contracts';
import type {
  StudySlot,
  StudyPreferences,
  StudyPreview,
  StudyPlan,
  StudyWorkloadSnapshot,
} from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { eventColumns, stamp } from './common.js';
import { readExceptions } from './calendar.js';
type Course = {
  id: string;
  version: number;
  name: string;
  sensitivity: string;
};
type Topic = {
  id: string;
  version: number;
  courseId: string;
  name: string;
  confidence: string;
  progress: number;
  sensitivity: string;
  academicLabels: string[] | null;
};
type OpenWork = StudyWorkloadSnapshot;
export const defaultStudyPreferences = {
  timeZone: 'UTC',
  sessionMinutes: 25,
  breakMinutes: 5,
  dailyMaximumMinutes: 120,
  windows: [],
  version: 1,
  updatedAt: null,
};
export async function readStudyPreferences(
  tx: QueryExecutor,
  owner: string,
): Promise<StudyPreferences> {
  const [row] = await tx.query(
    `SELECT settings,version,${stamp('updated_at', 'updatedAt')} FROM study_preferences WHERE owner_id=$1`,
    [owner],
  );
  return studyPreferencesSchema.parse(
    row
      ? {
          ...(row.settings as object),
          version: row.version,
          updatedAt: row.updatedAt,
        }
      : defaultStudyPreferences,
  );
}
export async function readStudyGoals(
  tx: QueryExecutor,
  owner: string,
  includeArchived = false,
) {
  const courses = await tx.query<Course>(
    `SELECT id,version,name,sensitivity FROM courses WHERE owner_id=$1 ${includeArchived ? '' : 'AND deleted_at IS NULL'} ORDER BY id LIMIT 501`,
    [owner],
  );
  if (courses.length > 500)
    throw new ApiError(
      413,
      'STUDY_TOO_LARGE',
      'Study planning supports at most 500 classes.',
    );
  const rows = await tx.query(
    `SELECT course_id AS "courseId",minutes_per_week AS "minutesPerWeek",priority,to_char(target_date,'YYYY-MM-DD') AS "targetDate",version,${stamp('updated_at', 'updatedAt')} FROM study_goals WHERE owner_id=$1 ORDER BY course_id`,
    [owner],
  );
  return {
    courses,
    goals: courses.map((c) =>
      studyGoalSchema.parse(
        rows.find((r) => r.courseId === c.id) ?? {
          courseId: c.id,
          minutesPerWeek: 0,
          priority: 3,
          targetDate: null,
          version: 1,
          updatedAt: null,
        },
      ),
    ),
  };
}
const millis = (instant: string) => +new Date(instant);
const studyConflict = (
  a: StudySlot,
  b: { startsAt: string; endsAt: string; study?: boolean },
  breakMinutes: number,
) =>
  overlap(a, b) ||
  (b.study === true &&
    millis(a.startsAt) < millis(b.endsAt) + breakMinutes * 60000 &&
    millis(a.endsAt) > millis(b.startsAt) - breakMinutes * 60000);
export const overlap = (
  a: StudySlot,
  b: { startsAt: string; endsAt: string },
) =>
  millis(a.startsAt) < millis(b.endsAt) &&
  millis(a.endsAt) > millis(b.startsAt);
export function rangeInstants(from: string, to: string, timeZone: string) {
  return {
    startsAt: Temporal.PlainDate.from(from)
      .toZonedDateTime(timeZone)
      .toInstant()
      .toString(),
    endsAt: Temporal.PlainDate.from(to)
      .toZonedDateTime(timeZone)
      .toInstant()
      .toString(),
  };
}
export async function studyContext(
  tx: QueryExecutor,
  owner: string,
  from: string,
  to: string,
) {
  const preferences = await readStudyPreferences(tx, owner);
  const { courses, goals } = await readStudyGoals(tx, owner);
  const topics = await tx.query<Topic>(
    'SELECT id,version,course_id AS "courseId",name,confidence,progress,sensitivity,academic_labels AS "academicLabels" FROM topics WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 2001',
    [owner],
  );
  // Only enabled, active classes participate. Do not load notes, titles or scores.
  const academicWork = await tx.query<OpenWork>(
    `SELECT w.id,w.version,w.course_id AS "courseId",c.version AS "courseVersion",c.sensitivity AS "courseSensitivity",to_char(w.due_date,'YYYY-MM-DD') AS "dueDate",w.estimated_minutes AS "estimatedMinutes",w.priority,w.status,w.sensitivity,w.academic_labels AS "academicLabels",'owner-entered-planning-fields' AS provenance
     FROM academic_work w JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
     JOIN study_goals g ON g.course_id=w.course_id AND g.owner_id=w.owner_id
     WHERE w.owner_id=$1 AND w.deleted_at IS NULL AND c.deleted_at IS NULL
       AND g.minutes_per_week>0 AND w.status IN ('planned','in_progress')
     ORDER BY w.id LIMIT 5001`,
    [owner],
  );
  const rows = await tx.query(
    `SELECT ${eventColumns} FROM events WHERE owner_id=$1 ORDER BY id LIMIT 5001`,
    [owner],
  );
  if (topics.length > 2000 || rows.length > 5000 || academicWork.length > 5000)
    throw new ApiError(
      413,
      'STUDY_TOO_LARGE',
      'Study planning history exceeds its supported size.',
    );
  const events = rows.map((r) => calendarRecordSchema.parse(r));
  const exceptions = [];
  const occurrences = [];
  for (const event of events) {
    const values = await readExceptions(tx, event.id);
    exceptions.push({ eventId: event.id, values });
    occurrences.push(
      ...expandEvent(event, from, to, preferences.timeZone, values),
    );
  }
  const bounds = rangeInstants(from, to, preferences.timeZone);
  const busy = occurrences
    .filter(
      (e) => !e.deletedAt && (!e.courseId || e.studyStatus !== 'cancelled'),
    )
    .map((e) =>
      e.allDay
        ? {
            ...rangeInstants(e.startDate!, e.endDate!, preferences.timeZone),
            study: Boolean(e.courseId),
          }
        : {
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            study: Boolean(e.courseId),
          },
    );
  const contextRevision = createHash('sha256')
    .update(
      JSON.stringify({
        from,
        to,
        preferences,
        courses,
        goals,
        topics,
        academicWork,
        events,
        exceptions,
      }),
    )
    .digest('hex');
  return {
    preferences,
    courses,
    goals,
    topics,
    academicWork,
    events,
    occurrences,
    busy,
    bounds,
    contextRevision,
  };
}
type Context = Awaited<ReturnType<typeof studyContext>>;
export function studyMinutes(
  context: Context,
  courseId: string,
  status: string,
  deleted = false,
) {
  return context.occurrences
    .filter(
      (e) =>
        e.courseId === courseId &&
        !e.allDay &&
        (deleted
          ? Boolean(e.deletedAt)
          : !e.deletedAt && e.studyStatus === status),
    )
    .reduce(
      (sum, e) =>
        sum +
        Math.max(
          0,
          Math.min(millis(e.endsAt), millis(context.bounds.endsAt)) -
            Math.max(millis(e.startsAt), millis(context.bounds.startsAt)),
        ) /
          60000,
      0,
    );
}
export function priorities(context: Context, from: string, to: string) {
  const days = Temporal.PlainDate.from(from).until(
    Temporal.PlainDate.from(to),
  ).days;
  return context.goals
    .filter((g) => g.minutesPerWeek > 0)
    .map((goal) => {
      const course = context.courses.find((c) => c.id === goal.courseId)!;
      const candidates = context.topics
        .filter((t) => t.courseId === course.id)
        .sort(
          (a, b) => topicScore(b) - topicScore(a) || a.id.localeCompare(b.id),
        );
      const topic = candidates[0];
      const distance = goal.targetDate
        ? Temporal.PlainDate.from(from).until(
            Temporal.PlainDate.from(goal.targetDate),
          ).days
        : null;
      const urgent = distance !== null && distance <= 14;
      const reasons: StudyPreview['priorities'][number]['reasons'] = [
        'OWNER_PRIORITY',
      ];
      const work = context.academicWork.filter((w) => w.courseId === course.id);
      const horizon = Temporal.PlainDate.from(from)
        .add({ days: 14 })
        .toString();
      const dates = work.flatMap((w) => (w.dueDate ? [w.dueDate] : [])).sort();
      const academicWork = {
        openCount: work.length,
        overdueCount: dates.filter((d) => d < from).length,
        dueSoonCount: dates.filter((d) => d >= from && d <= horizon).length,
        earliestDueDate: dates[0] ?? null,
        estimatedOpenMinutes: work.reduce(
          (sum, w) => sum + (w.estimatedMinutes ?? 0),
          0,
        ),
        missingDeadlineCount: work.filter((w) => w.dueDate === null).length,
        missingEstimateCount: work.filter((w) => w.estimatedMinutes === null)
          .length,
        highestPriority: work.length
          ? Math.max(...work.map((w) => w.priority))
          : null,
      };
      if (academicWork.overdueCount) reasons.push('ACADEMIC_WORK_OVERDUE');
      if (academicWork.dueSoonCount) reasons.push('ACADEMIC_WORK_DUE_SOON');
      if (work.length) reasons.push('WORK_IMPORTANCE');
      if (academicWork.estimatedOpenMinutes > 0)
        reasons.push('ESTIMATED_WORKLOAD');
      if (urgent) reasons.push('TARGET_DATE');
      if (!topic) reasons.push('NO_TOPICS');
      else {
        if (topic.confidence === 'low') reasons.push('LOW_CONFIDENCE');
        if (topic.confidence === 'unknown') reasons.push('UNKNOWN_CONFIDENCE');
        if (topic.progress < 100) reasons.push('INCOMPLETE_PROGRESS');
      }
      const targetMinutes = Math.ceil((goal.minutesPerWeek * days) / 7);
      const used =
        studyMinutes(context, course.id, 'planned') +
        studyMinutes(context, course.id, 'completed');
      return {
        courseId: course.id,
        courseName: course.name,
        topicId: topic?.id ?? null,
        topicName: topic?.name ?? null,
        score:
          goal.priority * 100 +
          (urgent ? 150 : 0) +
          (topic ? topicScore(topic) : 0) +
          (academicWork.overdueCount
            ? 300
            : academicWork.dueSoonCount
              ? 200
              : 0) +
          (academicWork.highestPriority ?? 0) * 10 +
          Math.min(60, Math.floor(academicWork.estimatedOpenMinutes / 25)),
        reasons,
        targetMinutes,
        remainingMinutes: Math.max(0, Math.ceil(targetMinutes - used)),
        academicWork,
      };
    })
    .sort((a, b) => b.score - a.score || a.courseId.localeCompare(b.courseId));
}
function topicScore(topic: Topic) {
  return (
    (topic.confidence === 'low'
      ? 60
      : topic.confidence === 'unknown'
        ? 40
        : topic.confidence === 'medium'
          ? 20
          : 0) +
    (100 - topic.progress)
  );
}
function wallTime(date: Temporal.PlainDate, minute: number, timeZone: string) {
  return date
    .add({ days: minute === 1440 ? 1 : 0 })
    .toPlainDateTime({
      hour: Math.floor((minute % 1440) / 60),
      minute: minute % 60,
    })
    .toZonedDateTime(timeZone, { disambiguation: 'reject' })
    .toInstant();
}
function existingDailyMinutes(context: Context, date: string) {
  const bounds = rangeInstants(
    date,
    Temporal.PlainDate.from(date).add({ days: 1 }).toString(),
    context.preferences.timeZone,
  );
  return context.occurrences
    .filter(
      (e) =>
        e.courseId &&
        !e.deletedAt &&
        !e.allDay &&
        e.studyStatus !== 'cancelled',
    )
    .reduce(
      (sum, e) =>
        sum +
        Math.max(
          0,
          Math.min(millis(e.endsAt), millis(bounds.endsAt)) -
            Math.max(millis(e.startsAt), millis(bounds.startsAt)),
        ) /
          60000,
      0,
    );
}
export function buildStudyPreview(
  context: Context,
  from: string,
  to: string,
): StudyPreview {
  const ranked = priorities(context, from, to);
  const remaining = new Map(
    ranked.map((r) => [r.courseId, r.remainingMinutes]),
  );
  const slots: StudySlot[] = [];
  const warnings: StudyPreview['warnings'] = ['EXTERNAL_CALENDARS_NOT_CHECKED'];
  const prefs = context.preferences;
  if (!prefs.windows.length) warnings.push('NO_AVAILABILITY');
  if (!ranked.length) warnings.push('NO_GOALS');
  if (context.academicWork.length)
    warnings.push('ACADEMIC_WORK_PROVENANCE_INCOMPLETE');
  if (ranked.some((r) => r.academicWork.missingDeadlineCount > 0))
    warnings.push('ACADEMIC_DEADLINES_MISSING');
  if (ranked.some((r) => r.academicWork.missingEstimateCount > 0))
    warnings.push('ACADEMIC_ESTIMATES_MISSING');
  for (
    let date = Temporal.PlainDate.from(from);
    date.toString() < to;
    date = date.add({ days: 1 })
  ) {
    let daily = existingDailyMinutes(context, date.toString());
    const windows = prefs.windows
      .filter((w) => w.day === date.dayOfWeek)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (const window of windows)
      for (
        let minute = window.startMinute;
        minute + prefs.sessionMinutes <= window.endMinute;
        minute += 5
      ) {
        if (
          slots.length >= 200 ||
          daily + prefs.sessionMinutes > prefs.dailyMaximumMinutes
        )
          break;
        const chosen = ranked.find(
          (r) => (remaining.get(r.courseId) ?? 0) >= prefs.sessionMinutes,
        );
        if (!chosen) break;
        let start, end;
        try {
          start = wallTime(date, minute, prefs.timeZone);
          end = wallTime(date, minute + prefs.sessionMinutes, prefs.timeZone);
        } catch {
          if (!warnings.includes('DST_WINDOW_SKIPPED'))
            warnings.push('DST_WINDOW_SKIPPED');
          continue;
        }
        if (
          end.epochMilliseconds - start.epochMilliseconds !==
          prefs.sessionMinutes * 60000
        ) {
          if (!warnings.includes('DST_WINDOW_SKIPPED'))
            warnings.push('DST_WINDOW_SKIPPED');
          continue;
        }
        const slot = {
          courseId: chosen.courseId,
          topicId: chosen.topicId,
          startsAt: start.toString({ smallestUnit: 'millisecond' }),
          endsAt: end.toString({ smallestUnit: 'millisecond' }),
        };
        if (
          context.busy.some((b) =>
            studyConflict(slot, b, prefs.breakMinutes),
          ) ||
          slots.some((b) =>
            studyConflict(slot, { ...b, study: true }, prefs.breakMinutes),
          )
        )
          continue;
        slots.push(slot);
        daily += prefs.sessionMinutes;
        remaining.set(
          chosen.courseId,
          remaining.get(chosen.courseId)! - prefs.sessionMinutes,
        );
        minute += prefs.sessionMinutes + prefs.breakMinutes - 5;
      }
  }
  if ([...remaining.values()].some((v) => v > 0))
    warnings.push('INSUFFICIENT_TIME');
  return studyPreviewSchema.parse({
    from,
    to,
    timeZone: prefs.timeZone,
    preferencesVersion: prefs.version,
    contextRevision: context.contextRevision,
    priorities: ranked,
    slots,
    warnings,
  });
}
export function validateStudySlots(
  context: Context,
  preview: StudyPreview,
  slots: StudySlot[],
) {
  const daily = new Map<string, number>();
  const accepted: StudySlot[] = [];
  for (const slot of slots) {
    if (
      !context.courses.some((c) => c.id === slot.courseId) ||
      (slot.topicId &&
        !context.topics.some(
          (t) => t.id === slot.topicId && t.courseId === slot.courseId,
        ))
    )
      throw new ApiError(
        409,
        'STUDY_SOURCE_UNAVAILABLE',
        'Reload the class and topic.',
      );
    const start = Temporal.Instant.from(slot.startsAt).toZonedDateTimeISO(
      context.preferences.timeZone,
    );
    const date = start.toPlainDate().toString();
    const duration = (millis(slot.endsAt) - millis(slot.startsAt)) / 60000;
    if (
      date < preview.from ||
      date >= preview.to ||
      millis(slot.endsAt) > millis(context.bounds.endsAt)
    )
      throw new ApiError(
        409,
        'STUDY_RANGE',
        'Keep blocks within the plan range.',
      );
    const fits = context.preferences.windows.some((w) => {
      if (w.day !== start.dayOfWeek) return false;
      // Inputs are explicit instants. Compare their local clock positions without
      // resolving an availability boundary that may itself fall in a DST gap.
      const end = Temporal.Instant.from(slot.endsAt).toZonedDateTimeISO(
        context.preferences.timeZone,
      );
      const clock = (value: typeof start) =>
        value.hour * 60 +
        value.minute +
        value.second / 60 +
        value.millisecond / 60000;
      const endMinute = end.toPlainDate().equals(start.toPlainDate())
        ? clock(end)
        : end.toPlainDate().equals(start.toPlainDate().add({ days: 1 })) &&
            clock(end) === 0
          ? 1440
          : Infinity;
      return clock(start) >= w.startMinute && endMinute <= w.endMinute;
    });
    if (!fits)
      throw new ApiError(
        409,
        'STUDY_AVAILABILITY',
        'The block falls outside study availability.',
      );
    if (
      context.busy.some((b) =>
        studyConflict(slot, b, context.preferences.breakMinutes),
      ) ||
      accepted.some((b) =>
        studyConflict(
          slot,
          { ...b, study: true },
          context.preferences.breakMinutes,
        ),
      )
    )
      throw new ApiError(
        409,
        'STUDY_CONFLICT',
        'The study block conflicts with Calendar.',
      );
    const used =
      (daily.get(date) ?? existingDailyMinutes(context, date)) + duration;
    if (used > context.preferences.dailyMaximumMinutes)
      throw new ApiError(
        409,
        'STUDY_DAILY_LIMIT',
        'The plan exceeds the daily study limit.',
      );
    daily.set(date, used);
    accepted.push(slot);
  }
}
export const studyPlanColumns = `(SELECT json_build_object('turnId',o.turn_id,'suggestionId',o.suggestion_id) FROM study_plan_ai_origins o WHERE o.owner_id=study_plans.owner_id AND o.plan_id=study_plans.id) AS assistant,id,version,status,preview,event_links AS "eventLinks",preserved_event_ids AS "preservedEventIds",${stamp('created_at', 'createdAt')},${stamp('updated_at', 'updatedAt')},${stamp('deleted_at', 'deletedAt')}`;
export async function readStudyPlan(
  tx: QueryExecutor,
  owner: string,
  id: string,
  includeHidden = false,
): Promise<StudyPlan> {
  const [row] = await tx.query(
    `SELECT ${studyPlanColumns} FROM study_plans WHERE owner_id=$1 AND id=$2 ${includeHidden ? '' : 'AND deleted_at IS NULL'}`,
    [owner, id],
  );
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Study plan not available.');
  return studyPlanSchema.parse(row);
}
export async function exportStudy(tx: QueryExecutor, owner: string) {
  return {
    studyPreferences: await readStudyPreferences(tx, owner),
    studyGoals: (
      await tx.query(
        `SELECT course_id AS "courseId",minutes_per_week AS "minutesPerWeek",priority,to_char(target_date,'YYYY-MM-DD') AS "targetDate",version,${stamp('updated_at', 'updatedAt')} FROM study_goals WHERE owner_id=$1 ORDER BY course_id LIMIT 10001`,
        [owner],
      )
    ).map((row) => studyGoalSchema.parse(row)),
    studyPlans: (
      await tx.query(
        `SELECT ${studyPlanColumns} FROM study_plans WHERE owner_id=$1 ORDER BY id LIMIT 10001`,
        [owner],
      )
    ).map((r) => studyPlanSchema.parse(r)),
  };
}
