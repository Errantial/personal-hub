import {
  academicWorkBrowseResponseSchema,
  academicWorkResponseSchema,
  academicWorkSchema,
  academicWorkUpdateSchema,
  academicWorkWriteSchema,
  calendarListSchema,
  calendarRecordSchema,
  calendarResponseSchema,
  calendarWriteSchema,
  courseResponseSchema,
  courseSchema,
  coursesSchema,
  courseWriteSchema,
  createTaskSchema,
  updateTaskSchema,
  deleteItemSchema,
  expandEvent,
  occurrencesResponseSchema,
  rangeSchema,
  reminderResponseSchema,
  reminderSchema,
  remindersSchema,
  reminderSnoozeResponseSchema,
  reminderSnoozeSchema,
  reminderWriteSchema,
  restoreItemSchema,
  taskSchema,
  tasksResponseSchema,
  topicResponseSchema,
  topicSchema,
  topicsSchema,
  topicWriteSchema,
  sessionResponseSchema,
} from '@hub/contracts';
import { z } from 'zod';
import { nativePlatform } from './transport';
import type {
  AcademicWork,
  AcademicWorkBrowseResponse,
  CalendarInput,
  CalendarRecord,
  Course,
  Occurrence,
  Reminder,
  Task,
  Topic,
  SessionResponse,
} from '@hub/contracts';

type Job = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  task: Task;
  error: string | null;
};
const reminderControlSchema = deleteItemSchema.extend({
  action: z.enum(['pause', 'resume', 'retry', 'cancel']),
});
type ReminderList = z.infer<typeof remindersSchema>;
type PlannerKind =
  'course' | 'topic' | 'event' | 'occurrence' | 'work' | 'reminder';
type PlannerJob = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  kind: PlannerKind;
  entity: Course | Topic | CalendarRecord | AcademicWork | Reminder;
  related?: Reminder;
  /** Per-occurrence edits carry the series, its date and the replacement. */
  occurrenceDate?: string;
  replacement?: CalendarInput | null;
  response: unknown;
  error: string | null;
};
type LocalState = {
  session: SessionResponse | null;
  locked: boolean;
  cache: Record<string, { data: unknown; savedAt: string }>;
  tasks: Task[];
  jobs: Job[];
  plannerJobs: PlannerJob[];
};
const empty = (): LocalState => ({
  session: null,
  locked: true,
  cache: {},
  tasks: [],
  jobs: [],
  plannerJobs: [],
});
let currentOwner: string | null = null;
let epoch = 0;
export const ownerContext = () => epoch;
let connection: Promise<IDBDatabase> | undefined;
export const offlineChanged = 'hub-offline-changed';
const changed = () => window.dispatchEvent(new Event(offlineChanged));
let unavailable = false;
export function networkAvailability(available: boolean) {
  if (unavailable === !available) return;
  unavailable = !available;
  changed();
}
function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const scope = nativePlatform()
      ? `:${import.meta.env.VITE_HUB_API_ORIGIN}`
      : '';
    const request = indexedDB.open(`hub-offline${scope}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('local');
    request.onerror = () => {
      connection = undefined;
      reject(new Error('Local storage unavailable.'));
    };
    request.onblocked = () =>
      reject(new Error('Close other hub tabs to update local storage.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = undefined;
      };
      resolve(db);
    };
  });
  return connection;
}
async function state<T>(
  write: boolean,
  work: (value: LocalState) => T,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('local', write ? 'readwrite' : 'readonly');
    const store = tx.objectStore('local');
    const request = store.get('state');
    let result: T;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const value = (request.result as LocalState | undefined) ?? empty();
        value.plannerJobs ??= [];
        result = work(value);
        if (write) store.put(value, 'state');
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(failure ?? new Error('Local storage unavailable.'));
  });
}
function authorized(value: LocalState) {
  return (
    !value.locked &&
    currentOwner !== null &&
    value.session?.user?.id === currentOwner &&
    value.session.expiresAt !== null &&
    Date.parse(value.session.expiresAt) > Date.now()
  );
}
function projected(value: LocalState) {
  const tasks = new Map(value.tasks.map((task) => [task.id, task]));
  for (const job of value.jobs) tasks.set(job.task.id, job.task);
  return [...tasks.values()].filter((task) => !task.deletedAt);
}
const queuedPlanner = (value: LocalState) => value.plannerJobs ?? [];
const byName = <T extends { name: string; id: string }>(items: T[]) =>
  items.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
function projectedCourses(value: LocalState) {
  const cached = coursesSchema.safeParse(value.cache['/api/v1/courses']?.data);
  const courses = new Map<string, Course>(
    (cached.success ? cached.data.courses : []).map((course) => [
      course.id,
      course,
    ]),
  );
  for (const job of queuedPlanner(value)) {
    if (job.kind !== 'course') continue;
    const course = job.entity as Course;
    if (course.deletedAt) courses.delete(course.id);
    else courses.set(course.id, course);
  }
  return byName([...courses.values()]);
}
function projectedTopics(value: LocalState) {
  const cached = topicsSchema.safeParse(value.cache['/api/v1/topics']?.data);
  const topics = new Map<string, Topic>(
    (cached.success ? cached.data.topics : []).map((topic) => [
      topic.id,
      topic,
    ]),
  );
  for (const job of queuedPlanner(value)) {
    if (job.kind !== 'topic') continue;
    const topic = job.entity as Topic;
    if (topic.deletedAt) topics.delete(topic.id);
    else topics.set(topic.id, topic);
  }
  const deletedCourses = new Set(
    queuedPlanner(value)
      .filter(
        (job) => job.kind === 'course' && (job.entity as Course).deletedAt,
      )
      .map((job) => job.entity.id),
  );
  return byName(
    [...topics.values()].filter((topic) => !deletedCourses.has(topic.courseId)),
  );
}
type WorkWithCourse = AcademicWork & {
  courseName?: string;
  courseVersion?: number;
  courseArchived?: boolean;
};
const closedWork = (item: AcademicWork) =>
  item.status === 'submitted' || item.status === 'cancelled';
function workMatches(status: string, item: AcademicWork) {
  if (status === 'all') return true;
  if (status === 'open')
    return item.status === 'planned' || item.status === 'in_progress';
  return item.status === status;
}
function workOrder(left: AcademicWork, right: AcademicWork) {
  return (
    Number(closedWork(left)) - Number(closedWork(right)) ||
    (left.dueDate ?? '9999-12-31').localeCompare(
      right.dueDate ?? '9999-12-31',
    ) ||
    left.id.localeCompare(right.id)
  );
}
function projectedWork(value: LocalState) {
  const work = new Map<string, WorkWithCourse>();
  for (const [path, cached] of Object.entries(value.cache)) {
    if (!path.startsWith('/api/v1/academic-work/browse?')) continue;
    const parsed = academicWorkBrowseResponseSchema.safeParse(cached.data);
    if (!parsed.success) continue;
    for (const item of parsed.data.work) work.set(item.id, item);
  }
  for (const job of queuedPlanner(value)) {
    if (job.kind !== 'work') continue;
    const item = job.entity as AcademicWork;
    if (item.deletedAt) work.delete(item.id);
    else work.set(item.id, item);
  }
  return [...work.values()];
}
function workSummary(
  items: AcademicWork[],
): AcademicWorkBrowseResponse['summary'] {
  const open = items.filter(
    (item) => item.status === 'planned' || item.status === 'in_progress',
  );
  return {
    totalCount: items.length,
    openCount: open.length,
    plannedCount: items.filter((item) => item.status === 'planned').length,
    inProgressCount: items.filter((item) => item.status === 'in_progress')
      .length,
    submittedCount: items.filter((item) => item.status === 'submitted').length,
    cancelledCount: items.filter((item) => item.status === 'cancelled').length,
    missingDeadlineCount: open.filter((item) => !item.dueDate).length,
    missingEstimateCount: open.filter((item) => item.estimatedMinutes === null)
      .length,
    estimatedOpenMinutes: open.reduce(
      (sum, item) => sum + (item.estimatedMinutes ?? 0),
      0,
    ),
  };
}
function enrichWork(
  value: LocalState,
  item: WorkWithCourse,
): AcademicWorkBrowseResponse['work'][number] {
  const course = projectedCourses(value).find(
    (entry) => entry.id === item.courseId,
  );
  return {
    ...item,
    courseName: course?.name ?? item.courseName ?? 'Class',
    courseVersion: course?.version ?? item.courseVersion ?? 1,
    courseArchived: course ? false : (item.courseArchived ?? false),
  };
}
function projectedWorkBrowse(value: LocalState, path: string) {
  const cached = academicWorkBrowseResponseSchema.safeParse(
    value.cache[path]?.data,
  );
  if (!cached.success) return undefined;
  const query = new URL(path, 'http://local').searchParams;
  const courseId = query.get('courseId');
  const status = query.get('status') ?? 'all';
  const work = projectedWork(value)
    .filter(
      (item) =>
        (!courseId || item.courseId === courseId) && workMatches(status, item),
    )
    .sort(workOrder)
    .map((item) => enrichWork(value, item));
  // Recompute totals only when the cached pages hold the whole filtered list.
  const summary =
    cached.data.summary.totalCount <= cached.data.work.length
      ? workSummary(work)
      : cached.data.summary;
  return { ...cached.data, work, summary };
}
function mergeWorkCache(value: LocalState, item: AcademicWork) {
  for (const [path, cached] of Object.entries(value.cache)) {
    if (!path.startsWith('/api/v1/academic-work/browse?')) continue;
    const parsed = academicWorkBrowseResponseSchema.safeParse(cached.data);
    if (!parsed.success) continue;
    const query = new URL(path, 'http://local').searchParams;
    const courseId = query.get('courseId');
    if (courseId && item.courseId !== courseId) continue;
    const work = parsed.data.work.filter((entry) => entry.id !== item.id);
    if (!item.deletedAt && workMatches(query.get('status') ?? 'all', item))
      work.push(enrichWork(value, item));
    work.sort(workOrder);
    const summary =
      parsed.data.summary.totalCount <= parsed.data.work.length
        ? workSummary(work)
        : parsed.data.summary;
    value.cache[path] = {
      ...cached,
      data: { ...parsed.data, work, summary },
    };
  }
}
function projectedEvents(value: LocalState) {
  const cached = calendarListSchema.safeParse(
    value.cache['/api/v1/calendar']?.data,
  );
  const events = new Map<string, CalendarRecord>(
    (cached.success ? cached.data.events : []).map((event) => [
      event.id,
      event,
    ]),
  );
  for (const job of queuedPlanner(value)) {
    if (job.kind !== 'event' && job.kind !== 'occurrence') continue;
    const event = job.entity as CalendarRecord;
    if (event.deletedAt) events.delete(event.id);
    else events.set(event.id, event);
  }
  return [...events.values()].sort(
    (left, right) =>
      left.startsAt.localeCompare(right.startsAt) ||
      left.id.localeCompare(right.id),
  );
}
function projectedOccurrences(value: LocalState, path: string) {
  const query = new URL(path, 'http://local').searchParams;
  const range = rangeSchema.safeParse({
    from: query.get('from'),
    to: query.get('to'),
    timeZone: query.get('timeZone'),
  });
  if (!range.success) return undefined;
  const cached = occurrencesResponseSchema.safeParse(value.cache[path]?.data);
  const jobs = queuedPlanner(value);
  const events = new Map<string, CalendarRecord>();
  const lastSeriesEdit = new Map<string, number>();
  const occurrenceEdits: {
    index: number;
    id: string;
    date: string;
    replacement: CalendarInput | null;
  }[] = [];
  jobs.forEach((job, index) => {
    if (job.kind === 'event') {
      const event = job.entity as CalendarRecord;
      events.set(event.id, event);
      lastSeriesEdit.set(event.id, index);
    } else if (job.kind === 'occurrence' && job.occurrenceDate) {
      occurrenceEdits.push({
        index,
        id: job.entity.id,
        date: job.occurrenceDate,
        replacement: job.replacement ?? null,
      });
    }
  });
  const occurrences = (cached.success ? cached.data.occurrences : []).filter(
    (occurrence) => !events.has(occurrence.id),
  );
  for (const event of events.values())
    if (!event.deletedAt)
      occurrences.push(
        ...expandEvent(
          event,
          range.data.from,
          range.data.to,
          range.data.timeZone,
        ),
      );
  // Patch single occurrences from the cached window. A later series edit
  // resets its series' exceptions, so edits before it no longer apply.
  const series = new Map(
    projectedEvents(value).map((event) => [event.id, event]),
  );
  for (const [id, event] of series) {
    const byDate = new Map<string, { replacement: CalendarInput | null }>();
    const resetAt = lastSeriesEdit.get(id) ?? -1;
    for (const edit of occurrenceEdits)
      if (edit.id === id && edit.index > resetAt)
        byDate.set(edit.date, { replacement: edit.replacement });
    if (!byDate.size || event.deletedAt) continue;
    for (const date of byDate.keys())
      for (let index = occurrences.length - 1; index >= 0; index -= 1)
        if (
          occurrences[index]!.id === id &&
          occurrences[index]!.originalDate === date
        )
          occurrences.splice(index, 1);
    for (const [date, edit] of byDate)
      occurrences.push(
        ...expandEvent(
          event,
          range.data.from,
          range.data.to,
          range.data.timeZone,
          [
            {
              originalDate: date,
              cancelled: edit.replacement === null,
              replacement: edit.replacement,
            },
          ],
        ).filter((occurrence) => occurrence.originalDate === date),
      );
  }
  occurrences.sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt),
  );
  return { occurrences };
}
function projectedReminders(value: LocalState): ReminderList {
  const cached = remindersSchema.safeParse(
    value.cache['/api/v1/reminders']?.data,
  );
  const reminders = new Map<string, Reminder>(
    (cached.success ? cached.data.reminders : []).map((reminder) => [
      reminder.id,
      reminder,
    ]),
  );
  for (const job of queuedPlanner(value)) {
    if (job.kind !== 'reminder') continue;
    if (job.related) reminders.set(job.related.id, job.related);
    reminders.set(job.entity.id, job.entity as Reminder);
  }
  // The server cancels a targeted reminder when its occurrence changes.
  const now = new Date().toISOString();
  for (const job of queuedPlanner(value)) {
    if (job.kind !== 'occurrence' || !job.occurrenceDate) continue;
    for (const [id, reminder] of reminders) {
      if (
        reminder.targetKind === 'event' &&
        reminder.targetId === job.entity.id &&
        reminder.occurrenceDate === job.occurrenceDate &&
        ['queued', 'running', 'paused'].includes(reminder.status)
      )
        reminders.set(id, {
          ...reminder,
          status: 'cancelled',
          version: reminder.version + 1,
          updatedAt: now,
        });
    }
  }
  return {
    reminders: [...reminders.values()].sort(
      (left, right) =>
        right.scheduledAt.localeCompare(left.scheduledAt) ||
        left.id.localeCompare(right.id),
    ),
    worker: cached.success
      ? cached.data.worker
      : { lastTick: null, healthy: false, errorCode: null },
  };
}
function mergeReminderCache(value: LocalState, saved: Reminder[]) {
  const cached = remindersSchema.safeParse(
    value.cache['/api/v1/reminders']?.data,
  );
  const reminders = new Map<string, Reminder>(
    (cached.success ? cached.data.reminders : []).map((reminder) => [
      reminder.id,
      reminder,
    ]),
  );
  for (const reminder of saved) reminders.set(reminder.id, reminder);
  value.cache['/api/v1/reminders'] = {
    data: {
      reminders: [...reminders.values()].sort(
        (left, right) =>
          right.scheduledAt.localeCompare(left.scheduledAt) ||
          left.id.localeCompare(right.id),
      ),
      worker: cached.success
        ? cached.data.worker
        : { lastTick: null, healthy: false, errorCode: null },
    },
    savedAt: new Date().toISOString(),
  };
}
function mergeEventOccurrences(value: LocalState, event: CalendarRecord) {
  for (const [path, cached] of Object.entries(value.cache)) {
    if (!path.startsWith('/api/v1/calendar/occurrences?')) continue;
    const query = new URL(path, 'http://local').searchParams;
    const range = rangeSchema.safeParse({
      from: query.get('from'),
      to: query.get('to'),
      timeZone: query.get('timeZone'),
    });
    const current = occurrencesResponseSchema.safeParse(cached.data);
    if (!range.success || !current.success) continue;
    const occurrences = current.data.occurrences.filter(
      (occurrence) => occurrence.id !== event.id,
    );
    if (!event.deletedAt)
      occurrences.push(
        ...expandEvent(
          event,
          range.data.from,
          range.data.to,
          range.data.timeZone,
        ),
      );
    occurrences.sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt),
    );
    value.cache[path] = { ...cached, data: { occurrences } };
  }
}
function mergeEventList(value: LocalState, event: CalendarRecord) {
  const cached = calendarListSchema.safeParse(
    value.cache['/api/v1/calendar']?.data,
  );
  const items = cached.success ? cached.data.events : [];
  const next = event.deletedAt
    ? items.filter((item) => item.id !== event.id)
    : [...items.filter((item) => item.id !== event.id), event];
  value.cache['/api/v1/calendar'] = {
    data: {
      events: next.sort(
        (left, right) =>
          left.startsAt.localeCompare(right.startsAt) ||
          left.id.localeCompare(right.id),
      ),
    },
    savedAt: new Date().toISOString(),
  };
}
function mergePlannerCache(
  value: LocalState,
  kind: 'course' | 'topic' | 'event',
  entity: Course | Topic | CalendarRecord,
) {
  if (kind === 'event') {
    const event = entity as CalendarRecord;
    mergeEventList(value, event);
    mergeEventOccurrences(value, event);
    return;
  }
  const savedAt = new Date().toISOString();
  const path = kind === 'course' ? '/api/v1/courses' : '/api/v1/topics';
  if (kind === 'course') {
    const cached = coursesSchema.safeParse(value.cache[path]?.data);
    const items = cached.success ? cached.data.courses : [];
    const next = entity.deletedAt
      ? items.filter((course) => course.id !== entity.id)
      : [
          ...items.filter((course) => course.id !== entity.id),
          entity as Course,
        ];
    value.cache[path] = { data: { courses: byName(next) }, savedAt };
  } else {
    const cached = topicsSchema.safeParse(value.cache[path]?.data);
    const items = cached.success ? cached.data.topics : [];
    const next = entity.deletedAt
      ? items.filter((topic) => topic.id !== entity.id)
      : [...items.filter((topic) => topic.id !== entity.id), entity as Topic];
    value.cache[path] = { data: { topics: byName(next) }, savedAt };
  }
}
/** Applies one replayed occurrence change without dropping other exceptions. */
function mergeOccurrenceCache(
  value: LocalState,
  event: CalendarRecord,
  date: string,
  replacement: CalendarInput | null,
) {
  mergeEventList(value, event);
  for (const [path, cached] of Object.entries(value.cache)) {
    if (!path.startsWith('/api/v1/calendar/occurrences?')) continue;
    const query = new URL(path, 'http://local').searchParams;
    const range = rangeSchema.safeParse({
      from: query.get('from'),
      to: query.get('to'),
      timeZone: query.get('timeZone'),
    });
    const current = occurrencesResponseSchema.safeParse(cached.data);
    if (!range.success || !current.success) continue;
    const occurrences = current.data.occurrences.filter(
      (occurrence) =>
        !(occurrence.id === event.id && occurrence.originalDate === date),
    );
    if (!event.deletedAt)
      occurrences.push(
        ...expandEvent(
          event,
          range.data.from,
          range.data.to,
          range.data.timeZone,
          [
            {
              originalDate: date,
              cancelled: replacement === null,
              replacement,
            },
          ],
        ).filter((occurrence) => occurrence.originalDate === date),
      );
    occurrences.sort((left, right) =>
      left.startsAt.localeCompare(right.startsAt),
    );
    value.cache[path] = { ...cached, data: { occurrences } };
  }
}
export async function rememberSession(session: SessionResponse) {
  if (currentOwner !== (session.user?.id ?? null)) epoch++;
  currentOwner = session.user?.id ?? null;
  await state(true, (value) => {
    if (session.user && value.session?.user?.id !== session.user.id)
      Object.assign(value, empty());
    if (session.user) value.session = session;
    value.locked = !session.user;
  });
  changed();
}
export async function cachedSession() {
  return state(false, (value) => {
    const session = value.session;
    if (
      value.locked ||
      !session?.user ||
      !session.expiresAt ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      return null;
    if (currentOwner !== session.user.id) epoch++;
    currentOwner = session.user.id;
    return session;
  });
}
export async function lockOffline() {
  epoch++;
  currentOwner = null;
  await state(true, (value) => {
    value.locked = true;
  });
  changed();
}
export async function clearOffline() {
  epoch++;
  currentOwner = null;
  await state(true, (value) => Object.assign(value, empty()));
  changed();
}
export async function pendingCount() {
  return state(
    false,
    (value) => value.jobs.length + queuedPlanner(value).length,
  );
}
export async function cacheResponse(path: string, data: unknown) {
  const owner = currentOwner;
  await state(true, (value) => {
    if (!owner || owner !== currentOwner || !authorized(value)) return;
    value.cache[path] = { data, savedAt: new Date().toISOString() };
    if (path === '/api/v1/tasks') {
      const remote = tasksResponseSchema.parse(data).tasks;
      const pending = new Set(value.jobs.map((job) => job.task.id));
      value.tasks = [
        ...remote.filter((task) => !pending.has(task.id)),
        ...value.tasks.filter((task) => pending.has(task.id)),
      ];
    }
  });
}
export async function cacheTask(task: Task) {
  await state(true, (value) => {
    if (!authorized(value)) return;
    value.tasks = [...value.tasks.filter((item) => item.id !== task.id), task];
  });
}
/** A cached occurrence from any stored window, including queued changes. */
export async function cachedOccurrence(
  id: string,
  date: string,
): Promise<Occurrence | undefined> {
  return state(false, (value) => {
    if (!authorized(value)) return undefined;
    for (const path of Object.keys(value.cache)) {
      if (!path.startsWith('/api/v1/calendar/occurrences?')) continue;
      const found = projectedOccurrences(value, path)?.occurrences.find(
        (occurrence) =>
          occurrence.id === id && occurrence.originalDate === date,
      );
      if (found) return found;
    }
    return undefined;
  });
}
export async function cachedResponse(path: string) {
  return state(false, (value) => {
    if (!authorized(value)) return undefined;
    if (path === '/api/v1/tasks' && (value.cache[path] || value.jobs.length))
      return { tasks: projected(value) };
    if (
      path === '/api/v1/courses' &&
      (value.cache[path] ||
        queuedPlanner(value).some((job) => job.kind === 'course'))
    )
      return { courses: projectedCourses(value) };
    if (
      path === '/api/v1/topics' &&
      (value.cache[path] ||
        queuedPlanner(value).some((job) => job.kind === 'topic'))
    )
      return { topics: projectedTopics(value) };
    if (
      path.startsWith('/api/v1/academic-work/browse?') &&
      value.cache[path] &&
      queuedPlanner(value).some((job) => job.kind === 'work')
    )
      return projectedWorkBrowse(value, path);
    if (
      path === '/api/v1/calendar' &&
      (value.cache[path] ||
        queuedPlanner(value).some(
          (job) => job.kind === 'event' || job.kind === 'occurrence',
        ))
    )
      return { events: projectedEvents(value) };
    if (path.startsWith('/api/v1/calendar/occurrences?')) {
      const jobs = queuedPlanner(value);
      const projectable = value.cache[path]
        ? jobs.some((job) => job.kind === 'event' || job.kind === 'occurrence')
        : jobs.some((job) => job.kind === 'event');
      if (projectable) return projectedOccurrences(value, path);
    }
    if (
      path === '/api/v1/reminders' &&
      (value.cache[path] ||
        queuedPlanner(value).some((job) => job.kind === 'reminder'))
    )
      return projectedReminders(value);
    return value.cache[path]?.data;
  });
}
export async function cachedAt(path: string) {
  return state(false, (value) =>
    authorized(value) ? (value.cache[path]?.savedAt ?? null) : null,
  );
}
export async function hasTaskQueue() {
  return state(false, (value) => authorized(value) && value.jobs.length > 0);
}
export async function enqueueTask(
  path: string,
  method: string,
  body: Record<string, unknown>,
) {
  if (!navigator.locks)
    throw new Error('Offline edits are unavailable in this browser.');
  const task = await state(true, (value) => {
    if (!authorized(value))
      throw new Error('Sign in online before using offline tasks.');
    const repeated = value.jobs.find(
      (job) => job.body.operationId === body.operationId,
    );
    if (repeated) {
      if (
        repeated.path !== path ||
        repeated.method !== method ||
        JSON.stringify(repeated.body) !== JSON.stringify(body)
      )
        throw new Error('Operation conflict.');
      return repeated.task;
    }
    const now = new Date().toISOString();
    let item: Task;
    if (method === 'POST') {
      const input = createTaskSchema.parse(body);
      if (input.canvasSourceRef)
        throw new Error('Connect to create a task from Canvas.');
      item = taskSchema.parse({
        ...input,
        id: input.clientId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    } else {
      const id = path.split('/').at(-1)!;
      if (value.jobs.some((job) => job.task.id === id && job.error))
        throw new Error('Resolve the task conflict before editing.');
      const original = projected(value).find((task) => task.id === id);
      const input =
        method === 'DELETE'
          ? deleteItemSchema.parse(body)
          : updateTaskSchema.parse(body);
      if (!original || input.expectedVersion !== original.version)
        throw new Error('Reload tasks before editing.');
      item = taskSchema.parse({
        ...original,
        ...(method === 'PUT' ? input : {}),
        sensitivity:
          'sensitivity' in input
            ? (input.sensitivity ?? original.sensitivity)
            : original.sensitivity,
        version: original.version + 1,
        updatedAt: now,
        deletedAt: method === 'DELETE' ? now : null,
      });
    }
    value.jobs.push({ path, method, body, task: item, error: null });
    return item;
  });
  changed();
  return { task };
}
export async function enqueuePlanner(
  path: string,
  method: string,
  body: Record<string, unknown>,
  local?: CalendarRecord | AcademicWork,
): Promise<unknown> {
  if (!navigator.locks)
    throw new Error('Offline edits are unavailable in this browser.');
  const isCourse = /^\/api\/v1\/courses(?:\/|$)/.test(path);
  const isTopic = /^\/api\/v1\/topics(?:\/|$)/.test(path);
  const isCalendar = /^\/api\/v1\/calendar(?:\/|$)/.test(path);
  const isWork = /^\/api\/v1\/academic-work(?:\/|$)/.test(path);
  const kind: PlannerKind = isCourse
    ? 'course'
    : isTopic
      ? 'topic'
      : isCalendar
        ? 'event'
        : isWork
          ? 'work'
          : 'reminder';
  const snooze = kind === 'reminder' && /\/snooze$/.test(path);
  const needsClientId =
    (kind === 'event' && method === 'POST' && path === '/api/v1/calendar') ||
    (kind === 'work' && method === 'POST' && !/\/restore$/.test(path)) ||
    (kind === 'reminder' &&
      (snooze || (method === 'POST' && path === '/api/v1/reminders')));
  const normalizedBody = needsClientId
    ? { ...body, clientId: body.clientId ?? body.operationId }
    : body;
  const result = await state(true, (value) => {
    if (!authorized(value))
      throw new Error('Sign in online before using offline edits.');
    const repeated = [...value.jobs, ...queuedPlanner(value)].find(
      (job) => job.body.operationId === normalizedBody.operationId,
    );
    if (repeated) {
      if (
        repeated.path !== path ||
        repeated.method !== method ||
        JSON.stringify(repeated.body) !== JSON.stringify(normalizedBody)
      )
        throw new Error('Operation conflict.');
      if ('kind' in repeated && repeated.kind === kind)
        return repeated.response;
      throw new Error('Operation conflict.');
    }
    const now = new Date().toISOString();
    const restore =
      /^\/api\/v1\/(calendar|academic-work)\/([a-f\d-]{36})\/restore$/.exec(
        path,
      );
    if (restore && method === 'POST') {
      const resource = restore[1]!;
      const id = restore[2]!;
      const input = restoreItemSchema.parse(normalizedBody);
      const deleted = local;
      if (!deleted || deleted.id !== id)
        throw new Error('Reload the deleted list before restoring.');
      if (input.expectedVersion !== deleted.version)
        throw new Error('Reload the deleted list before restoring.');
      if (resource === 'calendar') {
        const item = calendarRecordSchema.parse({
          ...(deleted as CalendarRecord),
          version: deleted.version + 1,
          updatedAt: now,
          deletedAt: null,
        });
        const response = { event: item };
        value.plannerJobs ??= [];
        value.plannerJobs.push({
          path,
          method,
          body: normalizedBody,
          kind: 'event',
          entity: item,
          response,
          error: null,
        });
        return response;
      }
      const item = academicWorkSchema.parse({
        ...(deleted as AcademicWork),
        version: deleted.version + 1,
        updatedAt: now,
        deletedAt: null,
      });
      const response = { work: item };
      value.plannerJobs ??= [];
      value.plannerJobs.push({
        path,
        method,
        body: normalizedBody,
        kind: 'work',
        entity: item,
        response,
        error: null,
      });
      return response;
    }
    if (kind === 'course' || kind === 'topic') {
      let item: Course | Topic;
      if (method === 'POST') {
        const clientId =
          typeof normalizedBody.clientId === 'string'
            ? normalizedBody.clientId
            : undefined;
        if (!clientId)
          throw new Error('Offline creates need a client identifier.');
        if (kind === 'course') {
          const input = courseWriteSchema.parse(normalizedBody);
          if (projectedCourses(value).some((course) => course.id === clientId))
            throw new Error('Reload classes before adding another.');
          item = courseSchema.parse({
            ...input,
            id: clientId,
            version: 1,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });
        } else {
          const input = topicWriteSchema.parse(normalizedBody);
          if (
            !projectedCourses(value).some(
              (course) => course.id === input.courseId,
            )
          )
            throw new Error('Reload classes before adding a topic.');
          item = topicSchema.parse({
            ...input,
            id: clientId,
            version: 1,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            academicLabels: null,
          });
        }
      } else {
        const id = path.split('/').at(-1)!;
        const original =
          kind === 'course'
            ? projectedCourses(value).find((course) => course.id === id)
            : projectedTopics(value).find((topic) => topic.id === id);
        if (!original) throw new Error('Reload classes before editing.');
        if (method === 'PUT' && kind === 'course') {
          const input = courseWriteSchema.parse(normalizedBody);
          if (input.expectedVersion !== original.version)
            throw new Error('Reload classes before editing.');
          item = courseSchema.parse({
            ...original,
            ...input,
            version: original.version + 1,
            updatedAt: now,
            deletedAt: null,
          });
        } else if (method === 'PUT') {
          const input = topicWriteSchema.parse(normalizedBody);
          if (input.expectedVersion !== original.version)
            throw new Error('Reload classes before editing.');
          if (input.courseId !== (original as Topic).courseId)
            throw new Error('A topic must remain in its original class.');
          item = topicSchema.parse({
            ...original,
            ...input,
            version: original.version + 1,
            updatedAt: now,
            deletedAt: null,
          });
        } else {
          const input = deleteItemSchema.parse(normalizedBody);
          if (input.expectedVersion !== original.version)
            throw new Error('Reload classes before editing.');
          item =
            kind === 'course'
              ? courseSchema.parse({
                  ...original,
                  version: original.version + 1,
                  updatedAt: now,
                  deletedAt: now,
                })
              : topicSchema.parse({
                  ...original,
                  version: original.version + 1,
                  updatedAt: now,
                  deletedAt: now,
                });
        }
      }
      const response =
        kind === 'course'
          ? { course: item as Course }
          : { topic: item as Topic };
      const job: PlannerJob = {
        path,
        method,
        body: normalizedBody,
        kind,
        entity: item,
        response,
        error: null,
      };
      value.plannerJobs ??= [];
      value.plannerJobs.push(job);
      return response;
    }

    if (kind === 'work') {
      if (/\/batch$/.test(path))
        throw new Error('Batch changes need a connection.');
      let item: AcademicWork;
      if (method === 'POST') {
        const input = academicWorkWriteSchema.parse(normalizedBody);
        const clientId = input.clientId;
        if (!clientId)
          throw new Error('Offline creates need a client identifier.');
        const course = projectedCourses(value).find(
          (entry) => entry.id === input.courseId,
        );
        if (!course) throw new Error('Reload classes before adding work.');
        if (projectedWork(value).some((work) => work.id === clientId))
          throw new Error('Reload work before adding another.');
        const labels = [
          ...new Set([input.sensitivity, course.sensitivity]),
        ].filter(
          (label): label is 'personal' | 'restricted' =>
            label === 'personal' || label === 'restricted',
        );
        item = academicWorkSchema.parse({
          ...input,
          id: clientId,
          provenance: 'owner-entered',
          academicLabels: labels,
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      } else {
        const id = path.split('/').at(-1)!;
        const original = projectedWork(value).find((work) => work.id === id);
        if (!original) throw new Error('Reload work before editing.');
        if (method === 'PUT') {
          const input = academicWorkUpdateSchema.parse(normalizedBody);
          if (input.expectedVersion !== original.version)
            throw new Error('Reload work before editing.');
          if (input.courseId !== original.courseId)
            throw new Error('Keep the original class for this record.');
          item = academicWorkSchema.parse({
            ...original,
            ...input,
            version: original.version + 1,
            updatedAt: now,
            deletedAt: null,
          });
        } else {
          const input = deleteItemSchema.parse(normalizedBody);
          if (input.expectedVersion !== original.version)
            throw new Error('Reload work before editing.');
          item = academicWorkSchema.parse({
            ...original,
            version: original.version + 1,
            updatedAt: now,
            deletedAt: now,
          });
        }
      }
      const response = { work: item };
      const job: PlannerJob = {
        path,
        method,
        body: normalizedBody,
        kind: 'work',
        entity: item,
        response,
        error: null,
      };
      value.plannerJobs ??= [];
      value.plannerJobs.push(job);
      return response;
    }
    const occurrence =
      /^\/api\/v1\/calendar\/([a-f\d-]{36})\/occurrences\/(\d{4}-\d{2}-\d{2})$/.exec(
        path,
      );
    if (kind === 'event' && occurrence && method !== 'POST') {
      const id = occurrence[1]!;
      const date = occurrence[2]!;
      const series = projectedEvents(value).find((event) => event.id === id);
      if (!series) throw new Error('Reload calendar before editing.');
      let replacement: CalendarInput | null = null;
      if (method === 'PUT') {
        const input = calendarWriteSchema.parse(normalizedBody);
        if (input.canvasSourceRef)
          throw new Error('Source links cannot be replaced offline.');
        if (input.expectedVersion !== series.version)
          throw new Error('Reload calendar before editing.');
        if (input.recurrence) throw new Error('An occurrence cannot repeat.');
        replacement = {
          title: input.title,
          notes: input.notes,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timeZone: input.timeZone,
          sensitivity: input.sensitivity,
          allDay: input.allDay,
          startDate: input.startDate,
          endDate: input.endDate,
          recurrence: input.recurrence ?? null,
          courseId: input.courseId,
          topicId: input.topicId,
          studyStatus: input.studyStatus,
        };
      } else {
        const input = deleteItemSchema.parse(normalizedBody);
        if (input.expectedVersion !== series.version)
          throw new Error('Reload calendar before editing.');
      }
      const entity = calendarRecordSchema.parse({
        ...series,
        version: series.version + 1,
        updatedAt: now,
        deletedAt: null,
      });
      const response = { event: entity };
      const job: PlannerJob = {
        path,
        method,
        body: normalizedBody,
        kind: 'occurrence',
        entity,
        occurrenceDate: date,
        replacement,
        response,
        error: null,
      };
      value.plannerJobs ??= [];
      value.plannerJobs.push(job);
      return response;
    }
    if (kind === 'event') {
      let item: CalendarRecord;
      if (method === 'POST' && path === '/api/v1/calendar') {
        const input = calendarWriteSchema.parse(normalizedBody);
        if (input.canvasSourceRef)
          throw new Error('Connect to create an event from Canvas.');
        if (!input.clientId)
          throw new Error('Offline creates need a client identifier.');
        if (projectedEvents(value).some((event) => event.id === input.clientId))
          throw new Error('Reload calendar before adding another.');
        item = calendarRecordSchema.parse({
          ...input,
          id: input.clientId,
          academicLabels: null,
          canvasSource: null,
          academicSource: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      } else {
        const id = path.split('/').at(-1)!;
        const original = projectedEvents(value).find(
          (event) => event.id === id,
        );
        if (!original) throw new Error('Reload calendar before editing.');
        if (method === 'PUT') {
          const input = calendarWriteSchema.parse(normalizedBody);
          if (input.canvasSourceRef)
            throw new Error('Source links cannot be replaced offline.');
          if (input.expectedVersion !== original.version)
            throw new Error('Reload calendar before editing.');
          item = calendarRecordSchema.parse({
            ...original,
            ...input,
            version: original.version + 1,
            updatedAt: now,
            deletedAt: null,
          });
        } else {
          const input = deleteItemSchema.parse(normalizedBody);
          if (input.expectedVersion !== original.version)
            throw new Error('Reload calendar before editing.');
          item = calendarRecordSchema.parse({
            ...original,
            version: original.version + 1,
            updatedAt: now,
            deletedAt: now,
          });
        }
      }
      const response = { event: item };
      const job: PlannerJob = {
        path,
        method,
        body: normalizedBody,
        kind,
        entity: item,
        response,
        error: null,
      };
      value.plannerJobs ??= [];
      value.plannerJobs.push(job);
      return response;
    }

    const reminderId = /^\/api\/v1\/reminders\/([a-f\d-]{36})/.exec(path)?.[1];
    let item: Reminder;
    let related: Reminder | undefined;
    let response: unknown;
    if (method === 'POST' && path === '/api/v1/reminders') {
      const input = reminderWriteSchema.parse(normalizedBody);
      if (!input.clientId)
        throw new Error('Offline creates need a client identifier.');
      if (
        projectedReminders(value).reminders.some(
          (reminder) => reminder.id === input.clientId,
        )
      )
        throw new Error('Reload reminders before adding another.');
      item = reminderSchema.parse({
        ...input,
        id: input.clientId,
        version: 1,
        status: 'queued',
        attempts: 0,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        snoozedFromId: null,
      });
      response = { reminder: item };
    } else if (method === 'PUT' && reminderId) {
      const input = reminderWriteSchema.parse(normalizedBody);
      const original = projectedReminders(value).reminders.find(
        (reminder) => reminder.id === reminderId,
      );
      if (!original) throw new Error('Reload reminders before editing.');
      if (input.expectedVersion !== original.version)
        throw new Error('Reload reminders before editing.');
      if (!['queued', 'paused', 'failed'].includes(original.status))
        throw new Error('This reminder cannot be rescheduled.');
      item = reminderSchema.parse({
        ...original,
        ...input,
        status: 'queued',
        attempts: 0,
        lastError: null,
        version: original.version + 1,
        updatedAt: now,
      });
      response = { reminder: item };
    } else if (method === 'POST' && reminderId && /\/control$/.test(path)) {
      const input = reminderControlSchema.parse(normalizedBody);
      const original = projectedReminders(value).reminders.find(
        (reminder) => reminder.id === reminderId,
      );
      if (!original) throw new Error('Reload reminders before editing.');
      if (input.expectedVersion !== original.version)
        throw new Error('Reload reminders before editing.');
      const allowed: Record<string, string[]> = {
        pause: ['queued', 'running'],
        resume: ['paused'],
        retry: ['failed'],
        cancel: ['queued', 'running', 'paused', 'failed'],
      };
      if (!allowed[input.action]!.includes(original.status))
        throw new Error(
          'This control is not available for the current status.',
        );
      const status =
        input.action === 'pause'
          ? 'paused'
          : input.action === 'cancel'
            ? 'cancelled'
            : 'queued';
      item = reminderSchema.parse({
        ...original,
        status,
        attempts: input.action === 'retry' ? 0 : original.attempts,
        lastError: null,
        version: original.version + 1,
        updatedAt: now,
      });
      response = { reminder: item };
    } else if (method === 'POST' && reminderId && snooze) {
      const input = reminderSnoozeSchema.parse(normalizedBody);
      const source = projectedReminders(value).reminders.find(
        (reminder) => reminder.id === reminderId,
      );
      if (!source) throw new Error('Reload reminders before snoozing.');
      if (input.expectedVersion !== source.version)
        throw new Error('Reload reminders before snoozing.');
      if (source.status !== 'delivered')
        throw new Error('Only delivered reminders can be snoozed.');
      if (
        projectedReminders(value).reminders.some(
          (reminder) => reminder.snoozedFromId === source.id,
        )
      )
        throw new Error('This reminder has already been snoozed.');
      const scheduled = Date.parse(input.scheduledAt);
      if (scheduled <= Date.now() || scheduled > Date.now() + 365 * 86400000)
        throw new Error('Choose a future time within 365 days.');
      if (!input.clientId)
        throw new Error('Offline creates need a client identifier.');
      const sourceReminder = reminderSchema.parse({
        ...source,
        version: source.version + 1,
        updatedAt: now,
      });
      item = reminderSchema.parse({
        ...source,
        id: input.clientId,
        version: 1,
        status: 'queued',
        scheduledAt: input.scheduledAt,
        attempts: 0,
        lastError: null,
        snoozedFromId: source.id,
        createdAt: now,
        updatedAt: now,
      });
      related = sourceReminder;
      response = {
        sourceReminder,
        reminder: item,
        notification: {
          id: crypto.randomUUID(),
          reminderId: source.id,
          runId: null,
          conversationId: null,
          title: source.title,
          createdAt: now,
          readAt: now,
        },
      };
    } else {
      throw new Error('This reminder change is not supported offline.');
    }
    const job: PlannerJob = {
      path,
      method,
      body: normalizedBody,
      kind,
      entity: item,
      ...(related ? { related } : {}),
      response,
      error: null,
    };
    value.plannerJobs ??= [];
    value.plannerJobs.push(job);
    return response;
  });
  changed();
  return result;
}
type Transport = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;
async function syncPlanner(send: Transport, owner: string) {
  for (let count = 0; count < 100; count++) {
    const job = await state(false, (value) =>
      authorized(value) ? queuedPlanner(value)[0] : undefined,
    );
    if (!job || job.error || owner !== currentOwner) break;
    try {
      const response = await send(job.path, {
        method: job.method,
        body: job.body,
      });
      const saved =
        job.kind === 'course'
          ? {
              kind: 'course' as const,
              entity: courseResponseSchema.parse(response).course,
            }
          : job.kind === 'topic'
            ? {
                kind: 'topic' as const,
                entity: topicResponseSchema.parse(response).topic,
              }
            : job.kind === 'work'
              ? {
                  kind: 'work' as const,
                  entity: academicWorkResponseSchema.parse(response).work,
                }
              : job.kind === 'occurrence'
                ? {
                    kind: 'occurrence' as const,
                    entity: calendarResponseSchema.parse(response).event,
                    date: job.occurrenceDate!,
                    replacement: job.replacement ?? null,
                  }
                : job.kind === 'event'
                  ? {
                      kind: 'event' as const,
                      entity: calendarResponseSchema.parse(response).event,
                    }
                  : /\/snooze$/.test(job.path)
                    ? {
                        kind: 'reminder' as const,
                        entities: (() => {
                          const parsed =
                            reminderSnoozeResponseSchema.parse(response);
                          return [parsed.sourceReminder, parsed.reminder];
                        })(),
                      }
                    : {
                        kind: 'reminder' as const,
                        entities: [
                          reminderResponseSchema.parse(response).reminder,
                        ],
                      };
      await state(true, (value) => {
        if (!authorized(value) || value.session?.user?.id !== owner) return;
        value.plannerJobs = queuedPlanner(value).filter(
          (item) => item.body.operationId !== job.body.operationId,
        );
        if (saved.kind === 'reminder')
          mergeReminderCache(value, saved.entities);
        else if (saved.kind === 'work') mergeWorkCache(value, saved.entity);
        else if (saved.kind === 'occurrence')
          mergeOccurrenceCache(
            value,
            saved.entity,
            saved.date,
            saved.replacement,
          );
        else mergePlannerCache(value, saved.kind, saved.entity);
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      const status =
        error && typeof error === 'object' && 'status' in error
          ? Number(error.status)
          : 0;
      if (status === 401 || status === 403) {
        await lockOffline();
        window.dispatchEvent(new Event('hub-auth-required'));
      } else if (status >= 400 && status < 500 && status !== 429)
        await state(true, (value) => {
          const item = queuedPlanner(value).find(
            (item) => item.body.operationId === job.body.operationId,
          );
          if (item) item.error = code || 'REQUEST_FAILED';
        });
      break;
    }
  }
  changed();
}
/** Resolves true only after a server session round-trip, not when skipped. */
export async function syncTasks(send: Transport): Promise<boolean> {
  if (!navigator.onLine || !navigator.locks || !currentOwner) return false;
  return navigator.locks.request(
    'hub-task-sync',
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return false;
      const owner = currentOwner;
      const session = sessionResponseSchema.parse(
        await send('/api/v1/auth/session'),
      );
      if (owner !== currentOwner) return false;
      if (session.user?.id !== owner) {
        await lockOffline();
        window.dispatchEvent(new Event('hub-auth-required'));
        return false;
      }
      await rememberSession(session);
      for (let count = 0; count < 100; count++) {
        const job = await state(false, (value) =>
          authorized(value) ? value.jobs[0] : undefined,
        );
        if (!job || job.error || owner !== currentOwner) break;
        try {
          const response = (await send(job.path, {
            method: job.method,
            body: job.body,
          })) as { task: unknown };
          const task = taskSchema.parse(response.task);
          await state(true, (value) => {
            if (!authorized(value) || value.session?.user?.id !== owner) return;
            value.jobs = value.jobs.filter(
              (item) => item.body.operationId !== job.body.operationId,
            );
            value.tasks = [
              ...value.tasks.filter((item) => item.id !== task.id),
              task,
            ];
          });
        } catch (error) {
          const code =
            error && typeof error === 'object' && 'code' in error
              ? String(error.code)
              : '';
          const status =
            error && typeof error === 'object' && 'status' in error
              ? Number(error.status)
              : 0;
          if (status === 401 || status === 403) {
            await lockOffline();
            window.dispatchEvent(new Event('hub-auth-required'));
          } else if (status >= 400 && status < 500 && status !== 429)
            await state(true, (value) => {
              const item = value.jobs.find(
                (item) => item.body.operationId === job.body.operationId,
              );
              if (item) item.error = code || 'REQUEST_FAILED';
            });
          break;
        }
      }
      const tasksRemain = await state(false, (value) =>
        authorized(value) ? value.jobs.length > 0 : false,
      );
      if (!tasksRemain) await syncPlanner(send, owner);
      changed();
      return true;
    },
  );
}
export async function offlineStatus() {
  return state(false, (value) => {
    const planner = queuedPlanner(value);
    return {
      unavailable,
      pending: value.jobs.length + planner.length,
      /** Task IDs with queued, unacknowledged changes (for inline row state). */
      queued: [...new Set(value.jobs.map((job) => job.task.id))],
      /** Queued changes wait for the same owner to sign in again. */
      locked: value.locked && value.jobs.length + planner.length > 0,
      lastSaved: value.cache['/api/v1/tasks']?.savedAt ?? null,
      conflicts: value.jobs
        .filter((job) => job.error)
        .map((job) => ({
          id: job.task.id,
          title: job.task.title,
          notes: job.task.notes,
          task: job.task,
          error: job.error,
        })),
      plannerConflicts: planner
        .filter((job) => job.error)
        .map((job) => ({
          id: job.entity.id,
          kind: job.kind,
          title: 'name' in job.entity ? job.entity.name : job.entity.title,
          error: job.error!,
        })),
    };
  });
}
export async function discardTask(id: string) {
  await navigator.locks.request('hub-task-sync', async () => {
    await state(true, (value) => {
      if (!authorized(value)) throw new Error('Sign in online first.');
      value.jobs = value.jobs.filter((job) => job.task.id !== id);
      // The next authenticated list refresh supplies the current server record.
      value.tasks = value.tasks.filter((task) => task.id !== id);
    });
  });
  changed();
}
export async function discardPlanner(kind: PlannerKind, id: string) {
  await navigator.locks.request('hub-task-sync', async () => {
    await state(true, (value) => {
      if (!authorized(value)) throw new Error('Sign in online first.');
      value.plannerJobs = queuedPlanner(value).filter(
        (job) => !(job.kind === kind && job.entity.id === id),
      );
    });
  });
  changed();
}
