import {
  calendarListSchema,
  calendarRecordSchema,
  calendarResponseSchema,
  calendarWriteSchema,
  courseResponseSchema,
  courseSchema,
  coursesSchema,
  courseWriteSchema,
  createTaskRequestSchema,
  deleteItemSchema,
  expandEvent,
  occurrencesResponseSchema,
  reminderResponseSchema,
  reminderSchema,
  remindersSchema,
  reminderWriteSchema,
  sessionResponseSchema,
  taskSchema,
  tasksResponseSchema,
  topicResponseSchema,
  topicSchema,
  topicsSchema,
  topicWriteSchema,
  updateTaskSchema,
} from '@hub/contracts';
import type {
  CalendarRecord,
  Course,
  Reminder,
  SessionResponse,
  Task,
  Topic,
} from '@hub/contracts';
import { nativePlatform } from './transport';
import { projectTaskDeadline } from './task-deadline';

export type OfflineKind = 'task' | 'calendar' | 'reminder' | 'course' | 'topic';
type OfflineRecord = Task | CalendarRecord | Reminder | Course | Topic;
type LegacyJob = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  task: Task;
  error: string | null;
};
type Job = {
  kind: OfflineKind;
  path: string;
  method: string;
  body: Record<string, unknown>;
  record: OfflineRecord;
  previous: OfflineRecord | null;
  error: string | null;
};
type LocalState = {
  session: SessionResponse | null;
  locked: boolean;
  cache: Record<string, { data: unknown; savedAt: string }>;
  tasks: Task[];
  calendar: CalendarRecord[];
  reminders: Reminder[];
  courses: Course[];
  topics: Topic[];
  jobs: Job[];
};
const empty = (): LocalState => ({
  session: null,
  locked: true,
  cache: {},
  tasks: [],
  calendar: [],
  reminders: [],
  courses: [],
  topics: [],
  jobs: [],
});

/** Lazily upgrades the single stored state value from the original task-only
 * shape. No IndexedDB schema migration is needed because the object store is
 * unchanged. */
function normalizeState(raw: LocalState | undefined): LocalState {
  if (!raw) return empty();
  const value = raw as unknown as Omit<LocalState, 'jobs'> & {
    calendar?: CalendarRecord[];
    reminders?: Reminder[];
    courses?: Course[];
    topics?: Topic[];
    jobs: Array<Job | LegacyJob>;
  };
  return {
    session: value.session ?? null,
    locked: value.locked ?? true,
    cache: value.cache ?? {},
    tasks: value.tasks ?? [],
    calendar: value.calendar ?? [],
    reminders: value.reminders ?? [],
    courses: value.courses ?? [],
    topics: value.topics ?? [],
    jobs: (value.jobs ?? []).map((job) =>
      'kind' in job
        ? job
        : {
            kind: 'task' as const,
            path: job.path,
            method: job.method,
            body: job.body,
            record: job.task,
            previous: null,
            error: job.error,
          },
    ),
  };
}

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
        const value = normalizeState(request.result as LocalState | undefined);
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
function baseRecords(value: LocalState, kind: OfflineKind): OfflineRecord[] {
  if (kind === 'task') return value.tasks;
  if (kind === 'calendar') return value.calendar;
  if (kind === 'reminder') return value.reminders;
  if (kind === 'course') return value.courses;
  return value.topics;
}
function replaceBase(
  value: LocalState,
  kind: OfflineKind,
  record: OfflineRecord,
) {
  if (kind === 'task')
    value.tasks = [
      ...value.tasks.filter((item) => item.id !== record.id),
      taskSchema.parse(record),
    ];
  else if (kind === 'calendar')
    value.calendar = [
      ...value.calendar.filter((item) => item.id !== record.id),
      calendarRecordSchema.parse(record),
    ];
  else if (kind === 'reminder')
    value.reminders = [
      ...value.reminders.filter((item) => item.id !== record.id),
      reminderSchema.parse(record),
    ];
  else if (kind === 'course')
    value.courses = [
      ...value.courses.filter((item) => item.id !== record.id),
      courseSchema.parse(record),
    ];
  else if (kind === 'topic')
    value.topics = [
      ...value.topics.filter((item) => item.id !== record.id),
      topicSchema.parse(record),
    ];
}
function activeRecord(record: OfflineRecord) {
  return !('deletedAt' in record) || record.deletedAt === null;
}
function projected(value: LocalState, kind: OfflineKind): OfflineRecord[] {
  const records = new Map(
    baseRecords(value, kind).map((record) => [record.id, record]),
  );
  for (const job of value.jobs)
    if (job.kind === kind) records.set(job.record.id, job.record);
  const active = [...records.values()].filter(activeRecord);
  if (kind !== 'topic') return active;
  const courseIds = new Set(
    projected(value, 'course').map((record) => courseSchema.parse(record).id),
  );
  return active.filter((record) =>
    courseIds.has(topicSchema.parse(record).courseId),
  );
}
function pendingIds(value: LocalState, kind: OfflineKind) {
  return new Set(
    value.jobs.filter((job) => job.kind === kind).map((job) => job.record.id),
  );
}
function parseOccurrenceRange(path: string) {
  if (!path.startsWith('/api/v1/calendar/occurrences?')) return null;
  const query = new URL(path, 'http://hub.invalid').searchParams;
  const from = query.get('from');
  const to = query.get('to');
  const timeZone = query.get('timeZone');
  return from && to && timeZone ? { from, to, timeZone } : null;
}
function calendarReset(previous: CalendarRecord, next: CalendarRecord) {
  return (
    previous.startsAt !== next.startsAt ||
    previous.timeZone !== next.timeZone ||
    previous.allDay !== next.allDay ||
    previous.startDate !== next.startDate ||
    previous.endDate !== next.endDate ||
    JSON.stringify(previous.recurrence) !== JSON.stringify(next.recurrence)
  );
}
function overlayOccurrenceJobs(
  path: string,
  data: unknown,
  jobs: readonly Job[],
) {
  const range = parseOccurrenceRange(path);
  if (!range) return data;
  let occurrences = [...occurrencesResponseSchema.parse(data).occurrences];
  for (const job of jobs.filter((item) => item.kind === 'calendar')) {
    const next = calendarRecordSchema.parse(job.record);
    const previous = job.previous
      ? calendarRecordSchema.parse(job.previous)
      : null;
    if (!activeRecord(next)) {
      occurrences = occurrences.filter((item) => item.id !== next.id);
      continue;
    }
    if (job.method === 'POST' || (previous && calendarReset(previous, next))) {
      occurrences = occurrences.filter((item) => item.id !== next.id);
      occurrences.push(
        ...expandEvent(next, range.from, range.to, range.timeZone),
      );
      continue;
    }
    if (job.method === 'PUT') {
      const duration = Date.parse(next.endsAt) - Date.parse(next.startsAt);
      occurrences = occurrences.map((item) => {
        if (item.id !== next.id || item.overridden) return item;
        return {
          ...item,
          title: next.title,
          notes: next.notes,
          endsAt: new Date(Date.parse(item.startsAt) + duration).toISOString(),
          sensitivity: next.sensitivity,
          courseId: next.courseId,
          topicId: next.topicId,
          studyStatus: next.studyStatus,
          academicLabels: next.academicLabels,
          canvasSource: next.canvasSource,
          academicSource: next.academicSource,
          version: next.version,
          updatedAt: next.updatedAt,
        };
      });
    }
  }
  return occurrencesResponseSchema.parse({
    occurrences: occurrences.sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    ),
  });
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
  return state(false, (value) => value.jobs.length);
}
export async function cacheResponse(path: string, data: unknown) {
  const owner = currentOwner;
  await state(true, (value) => {
    if (!owner || owner !== currentOwner || !authorized(value)) return;
    const savedAt = new Date().toISOString();
    value.cache[path] = {
      data,
      savedAt,
    };
    if (path === '/api/v1/tasks')
      value.tasks = tasksResponseSchema.parse(data).tasks;
    else if (path === '/api/v1/calendar')
      value.calendar = calendarListSchema.parse(data).events;
    else if (path === '/api/v1/reminders')
      value.reminders = remindersSchema.parse(data).reminders;
    else if (path === '/api/v1/courses')
      value.courses = coursesSchema.parse(data).courses;
    else if (path === '/api/v1/topics')
      value.topics = topicsSchema.parse(data).topics;
  });
}
export async function cacheRecord(kind: OfflineKind, record: OfflineRecord) {
  await state(true, (value) => {
    if (!authorized(value)) return;
    replaceBase(value, kind, record);
  });
}
export async function cacheTask(task: Task) {
  return cacheRecord('task', task);
}
export async function cachedResponse(path: string) {
  return state(false, (value) => {
    if (!authorized(value)) return undefined;
    if (path === '/api/v1/tasks' && (value.cache[path] || value.jobs.length))
      return { tasks: projected(value, 'task') };
    if (path === '/api/v1/calendar' && (value.cache[path] || value.jobs.length))
      return { events: projected(value, 'calendar') };
    if (path === '/api/v1/reminders' && value.cache[path]) {
      const cached = remindersSchema.parse(value.cache[path].data);
      return { ...cached, reminders: projected(value, 'reminder') };
    }
    if (path === '/api/v1/courses' && value.cache[path])
      return { courses: projected(value, 'course') };
    if (path === '/api/v1/topics' && value.cache[path])
      return { topics: projected(value, 'topic') };
    if (parseOccurrenceRange(path) && value.cache[path])
      return overlayOccurrenceJobs(path, value.cache[path].data, value.jobs);
    return value.cache[path]?.data;
  });
}
export async function cachedAt(path: string) {
  return state(false, (value) =>
    authorized(value) ? (value.cache[path]?.savedAt ?? null) : null,
  );
}
export async function hasQueue() {
  return state(false, (value) => authorized(value) && value.jobs.length > 0);
}
export const hasTaskQueue = hasQueue;
export async function hasQueuedKinds(kinds: readonly OfflineKind[]) {
  return state(
    false,
    (value) =>
      authorized(value) && value.jobs.some((job) => kinds.includes(job.kind)),
  );
}

function conflictFor(value: LocalState, kind: OfflineKind, id: string) {
  return value.jobs.some(
    (job) => job.kind === kind && job.record.id === id && job.error,
  );
}
function requireVersion(
  original: OfflineRecord | undefined,
  expectedVersion: number | undefined,
  label: string,
) {
  if (!original || expectedVersion !== original.version)
    throw new Error(`Reload ${label} before editing.`);
  return original;
}
function taskRecord(
  value: LocalState,
  path: string,
  method: string,
  body: Record<string, unknown>,
  now: string,
) {
  if (method === 'POST') {
    const input = createTaskRequestSchema.parse(body);
    if (input.canvasSourceRef)
      throw new Error('Connect to create a task from Canvas.');
    return taskSchema.parse({
      ...input,
      id: input.clientId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }
  const id = path.split('/').at(-1)!;
  if (conflictFor(value, 'task', id))
    throw new Error('Resolve the task conflict before editing.');
  const updateInput = method === 'PUT' ? updateTaskSchema.parse(body) : null;
  const input = updateInput ?? deleteItemSchema.parse(body);
  const original = taskSchema.parse(
    requireVersion(
      projected(value, 'task').find((record) => record.id === id),
      input.expectedVersion,
      'tasks',
    ),
  );
  const deadline = projectTaskDeadline(original, updateInput ?? {});
  return taskSchema.parse({
    ...original,
    ...(method === 'PUT' ? input : {}),
    ...deadline,
    sensitivity:
      'sensitivity' in input
        ? (input.sensitivity ?? original.sensitivity)
        : original.sensitivity,
    version: original.version + 1,
    updatedAt: now,
    deletedAt: method === 'DELETE' ? now : null,
  });
}
function calendarRecord(
  value: LocalState,
  path: string,
  method: string,
  body: Record<string, unknown>,
  now: string,
) {
  if (path.includes('/occurrences/'))
    throw new Error('Connect to edit one occurrence.');
  if (method === 'POST') {
    const input = calendarWriteSchema.parse(body);
    if (input.canvasSourceRef)
      throw new Error('Connect to create an event from Canvas.');
    if (input.courseId || input.topicId)
      throw new Error('Connect to create class-linked study time.');
    if (!input.clientId)
      throw new Error('Offline event creation requires a stable ID.');
    return {
      previous: null,
      record: calendarRecordSchema.parse({
        ...input,
        id: input.clientId,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        academicLabels: null,
        canvasSource: null,
        academicSource: null,
      }),
    };
  }
  const id = path.split('/').at(-1)!;
  if (conflictFor(value, 'calendar', id))
    throw new Error('Resolve the calendar conflict before editing.');
  const input =
    method === 'DELETE'
      ? deleteItemSchema.parse(body)
      : calendarWriteSchema.parse(body);
  const original = calendarRecordSchema.parse(
    requireVersion(
      projected(value, 'calendar').find((record) => record.id === id),
      input.expectedVersion,
      'calendar',
    ),
  );
  if ('canvasSourceRef' in input && input.canvasSourceRef)
    throw new Error('Connect to change an event source.');
  if (
    original.courseId ||
    original.topicId ||
    ('courseId' in input && (input.courseId || input.topicId))
  )
    throw new Error('Connect to edit class-linked study time.');
  const next = calendarRecordSchema.parse({
    ...original,
    ...(method === 'PUT' ? input : {}),
    version: original.version + 1,
    updatedAt: now,
    deletedAt: method === 'DELETE' ? now : null,
  });
  if (method === 'PUT' && original.recurrence)
    throw new Error('Connect to edit a recurring event.');
  return {
    previous: original,
    record: next,
  };
}
function reminderRecord(
  value: LocalState,
  path: string,
  method: string,
  body: Record<string, unknown>,
  now: string,
) {
  if (path.endsWith('/control') || path.endsWith('/snooze'))
    throw new Error('Connect to control or snooze a reminder.');
  if (method === 'POST') {
    const input = reminderWriteSchema.parse(body);
    if (!input.clientId)
      throw new Error('Offline reminder creation requires a stable ID.');
    return reminderSchema.parse({
      ...input,
      id: input.clientId,
      version: 1,
      status: 'queued',
      attempts: 0,
      lastError: null,
      snoozedFromId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (method !== 'PUT') throw new Error('Connect to change this reminder.');
  const id = path.split('/').at(-1)!;
  if (conflictFor(value, 'reminder', id))
    throw new Error('Resolve the reminder conflict before editing.');
  const input = reminderWriteSchema.parse(body);
  const original = reminderSchema.parse(
    requireVersion(
      projected(value, 'reminder').find((record) => record.id === id),
      input.expectedVersion,
      'reminders',
    ),
  );
  if (!['queued', 'paused', 'failed'].includes(original.status))
    throw new Error('Connect to refresh this reminder before rescheduling.');
  return reminderSchema.parse({
    ...original,
    ...input,
    status: 'queued',
    attempts: 0,
    lastError: null,
    version: original.version + 1,
    updatedAt: now,
  });
}

const strongestLabel = (
  left: Course['sensitivity'],
  right: Course['sensitivity'],
) =>
  left === 'restricted' || right === 'restricted'
    ? 'restricted'
    : left === 'personal' || right === 'personal'
      ? 'personal'
      : 'unlabeled';

function courseRecord(
  value: LocalState,
  path: string,
  method: string,
  body: Record<string, unknown>,
  now: string,
) {
  if (method === 'POST') {
    const input = courseWriteSchema.parse(body);
    if (!input.clientId)
      throw new Error('Offline class creation requires a stable ID.');
    return courseSchema.parse({
      ...input,
      id: input.clientId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }
  if (method !== 'DELETE') throw new Error('Connect to edit this class.');
  const id = path.split('/').at(-1)!;
  if (conflictFor(value, 'course', id))
    throw new Error('Resolve the class conflict before editing.');
  const input = deleteItemSchema.parse(body);
  const original = courseSchema.parse(
    requireVersion(
      projected(value, 'course').find((record) => record.id === id),
      input.expectedVersion,
      'classes',
    ),
  );
  return courseSchema.parse({
    ...original,
    version: original.version + 1,
    updatedAt: now,
    deletedAt: now,
  });
}

function topicRecord(
  value: LocalState,
  path: string,
  method: string,
  body: Record<string, unknown>,
  now: string,
) {
  if (method === 'POST') {
    const input = topicWriteSchema.parse(body);
    if (!input.clientId)
      throw new Error('Offline topic creation requires a stable ID.');
    const parent = projected(value, 'course')
      .map((record) => courseSchema.parse(record))
      .find((course) => course.id === input.courseId);
    if (!parent) throw new Error('Reload classes before adding a topic.');
    const inherited = [input.sensitivity, parent.sensitivity].filter(
      (label) => label !== 'unlabeled',
    );
    return topicSchema.parse({
      ...input,
      sensitivity: strongestLabel(input.sensitivity, parent.sensitivity),
      academicLabels: inherited.length ? [...new Set(inherited)] : null,
      id: input.clientId,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }
  const id = path.split('/').at(-1)!;
  if (conflictFor(value, 'topic', id))
    throw new Error('Resolve the topic conflict before editing.');
  const original = topicSchema.parse(
    requireVersion(
      projected(value, 'topic').find((record) => record.id === id),
      Number(body.expectedVersion),
      'topics',
    ),
  );
  if (method === 'DELETE') {
    deleteItemSchema.parse(body);
    return topicSchema.parse({
      ...original,
      version: original.version + 1,
      updatedAt: now,
      deletedAt: now,
    });
  }
  if (method !== 'PUT' || 'sensitivity' in body)
    throw new Error('Connect to change this topic label.');
  if (
    original.sensitivity !== 'unlabeled' ||
    (original.academicLabels?.length ?? 0) > 0
  )
    throw new Error('Connect to edit this labeled topic.');
  const input = topicWriteSchema.parse(body);
  return topicSchema.parse({
    ...original,
    ...input,
    sensitivity: original.sensitivity,
    academicLabels: original.academicLabels,
    version: original.version + 1,
    updatedAt: now,
  });
}

export async function enqueueMutation(
  kind: OfflineKind,
  path: string,
  method: string,
  body: Record<string, unknown>,
) {
  if (!navigator.locks)
    throw new Error('Offline edits are unavailable in this browser.');
  const record = await state(true, (value) => {
    if (!authorized(value))
      throw new Error('Sign in online before using offline edits.');
    const repeated = value.jobs.find(
      (job) => job.body.operationId === body.operationId,
    );
    if (repeated) {
      if (
        repeated.kind !== kind ||
        repeated.path !== path ||
        repeated.method !== method ||
        JSON.stringify(repeated.body) !== JSON.stringify(body)
      )
        throw new Error('Operation conflict.');
      return repeated.record;
    }
    const now = new Date().toISOString();
    let next: OfflineRecord;
    let previous: OfflineRecord | null = null;
    if (kind === 'task') next = taskRecord(value, path, method, body, now);
    else if (kind === 'calendar') {
      const result = calendarRecord(value, path, method, body, now);
      next = result.record;
      previous = result.previous;
    } else if (kind === 'reminder')
      next = reminderRecord(value, path, method, body, now);
    else if (kind === 'course')
      next = courseRecord(value, path, method, body, now);
    else next = topicRecord(value, path, method, body, now);
    const job: Job = {
      kind,
      path,
      method,
      body,
      record: next,
      previous,
      error: null,
    };
    value.jobs.push(job);
    return next;
  });
  changed();
  if (kind === 'task') return { task: taskSchema.parse(record) };
  if (kind === 'calendar')
    return calendarResponseSchema.parse({ event: record });
  if (kind === 'reminder')
    return reminderResponseSchema.parse({ reminder: record });
  if (kind === 'course') return courseResponseSchema.parse({ course: record });
  return topicResponseSchema.parse({ topic: record });
}
export async function enqueueTask(
  path: string,
  method: string,
  body: Record<string, unknown>,
) {
  return enqueueMutation('task', path, method, body);
}

type Transport = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;
function responseRecord(job: Job, response: unknown): OfflineRecord {
  if (job.kind === 'task')
    return taskSchema.parse((response as { task: unknown }).task);
  if (job.kind === 'calendar')
    return calendarRecordSchema.parse((response as { event: unknown }).event);
  if (job.kind === 'reminder')
    return reminderSchema.parse((response as { reminder: unknown }).reminder);
  if (job.kind === 'course')
    return courseSchema.parse((response as { course: unknown }).course);
  return topicSchema.parse((response as { topic: unknown }).topic);
}
export async function syncOutbox(send: Transport) {
  if (!navigator.onLine || !navigator.locks || !currentOwner) return;
  return navigator.locks.request(
    'hub-task-sync',
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return;
      const owner = currentOwner;
      const session = sessionResponseSchema.parse(
        await send('/api/v1/auth/session'),
      );
      if (owner !== currentOwner) return;
      if (session.user?.id !== owner) {
        await lockOffline();
        window.dispatchEvent(new Event('hub-auth-required'));
        return;
      }
      await rememberSession(session);
      for (let count = 0; count < 100; count++) {
        const job = await state(false, (value) =>
          authorized(value) ? value.jobs[0] : undefined,
        );
        if (!job || job.error || owner !== currentOwner) break;
        try {
          const response = await send(job.path, {
            method: job.method,
            body: job.body,
          });
          const record = responseRecord(job, response);
          await state(true, (value) => {
            if (!authorized(value) || value.session?.user?.id !== owner) return;
            value.jobs = value.jobs.filter(
              (item) => item.body.operationId !== job.body.operationId,
            );
            replaceBase(value, job.kind, record);
            if (job.kind === 'calendar')
              for (const key of Object.keys(value.cache))
                if (parseOccurrenceRange(key)) delete value.cache[key];
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
          } else if (
            status >= 400 &&
            status < 500 &&
            status !== 429 &&
            code !== 'RETRY_REQUIRED'
          )
            await state(true, (value) => {
              const item = value.jobs.find(
                (item) => item.body.operationId === job.body.operationId,
              );
              if (item) item.error = code || 'REQUEST_FAILED';
            });
          break;
        }
      }
      changed();
    },
  );
}
export const syncTasks = syncOutbox;

const titleOf = (record: OfflineRecord) =>
  'title' in record ? record.title : record.name;
const notesOf = (record: OfflineRecord) =>
  'notes' in record ? record.notes : '';
export async function offlineStatus() {
  return state(false, (value) => {
    const itemConflicts = value.jobs
      .filter((job) => job.error)
      .map((job) => ({
        kind: job.kind,
        id: job.record.id,
        title: titleOf(job.record),
        notes: notesOf(job.record),
        record: job.record,
        error: job.error,
      }));
    return {
      unavailable,
      pending: value.jobs.length,
      /** Task IDs retained for existing inline task-row state. */
      queued: [...pendingIds(value, 'task')],
      queuedItems: value.jobs.map((job) => ({
        kind: job.kind,
        id: job.record.id,
      })),
      /** Queued changes wait for the same owner to sign in again. */
      locked: value.locked && value.jobs.length > 0,
      lastSaved:
        value.cache['/api/v1/tasks']?.savedAt ??
        value.cache['/api/v1/calendar']?.savedAt ??
        value.cache['/api/v1/reminders']?.savedAt ??
        null,
      /** Backward-compatible task-only conflicts for task editor/row state. */
      conflicts: itemConflicts
        .filter((item) => item.kind === 'task')
        .map((item) => ({
          id: item.id,
          title: item.title,
          notes: item.notes,
          task: taskSchema.parse(item.record),
          error: item.error,
        })),
      itemConflicts,
    };
  });
}
export async function discardOffline(kind: OfflineKind, id: string) {
  await navigator.locks.request('hub-task-sync', async () => {
    await state(true, (value) => {
      if (!authorized(value)) throw new Error('Sign in online first.');
      value.jobs = value.jobs.filter(
        (job) => !(job.kind === kind && job.record.id === id),
      );
      if (kind !== 'task') return;
      if (kind === 'task')
        value.tasks = value.tasks.filter((record) => record.id !== id);
    });
  });
  changed();
}
export async function discardTask(id: string) {
  return discardOffline('task', id);
}
