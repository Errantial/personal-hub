import {
  courseResponseSchema,
  courseSchema,
  coursesSchema,
  courseWriteSchema,
  createTaskSchema,
  updateTaskSchema,
  deleteItemSchema,
  taskSchema,
  tasksResponseSchema,
  topicResponseSchema,
  topicSchema,
  topicsSchema,
  topicWriteSchema,
  sessionResponseSchema,
} from '@hub/contracts';
import { nativePlatform } from './transport';
import type { Course, Task, Topic, SessionResponse } from '@hub/contracts';

type Job = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  task: Task;
  error: string | null;
};
type PlannerKind = 'course' | 'topic';
type PlannerJob = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  kind: PlannerKind;
  entity: Course | Topic;
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
    if (job.entity.deletedAt) courses.delete(job.entity.id);
    else courses.set(job.entity.id, job.entity as Course);
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
    if (job.entity.deletedAt) topics.delete(job.entity.id);
    else topics.set(job.entity.id, job.entity as Topic);
  }
  const deletedCourses = new Set(
    queuedPlanner(value)
      .filter((job) => job.kind === 'course' && job.entity.deletedAt)
      .map((job) => job.entity.id),
  );
  return byName(
    [...topics.values()].filter((topic) => !deletedCourses.has(topic.courseId)),
  );
}
function mergePlannerCache(
  value: LocalState,
  kind: PlannerKind,
  entity: Course | Topic,
) {
  const path = kind === 'course' ? '/api/v1/courses' : '/api/v1/topics';
  const savedAt = new Date().toISOString();
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
): Promise<{ course?: Course; topic?: Topic }> {
  if (!navigator.locks)
    throw new Error('Offline edits are unavailable in this browser.');
  const kind: PlannerKind = /^\/api\/v1\/courses(?:\/|$)/.test(path)
    ? 'course'
    : 'topic';
  const result = await state(true, (value) => {
    if (!authorized(value))
      throw new Error('Sign in online before using offline edits.');
    const repeated = [...value.jobs, ...queuedPlanner(value)].find(
      (job) => job.body.operationId === body.operationId,
    );
    if (repeated) {
      if (
        repeated.path !== path ||
        repeated.method !== method ||
        JSON.stringify(repeated.body) !== JSON.stringify(body)
      )
        throw new Error('Operation conflict.');
      if ('kind' in repeated && repeated.kind === kind)
        return kind === 'course'
          ? { course: repeated.entity as Course }
          : { topic: repeated.entity as Topic };
      throw new Error('Operation conflict.');
    }
    const now = new Date().toISOString();
    let item: Course | Topic;
    if (method === 'POST') {
      const clientId =
        typeof body.clientId === 'string' ? body.clientId : undefined;
      if (!clientId)
        throw new Error('Offline creates need a client identifier.');
      if (kind === 'course') {
        const input = courseWriteSchema.parse(body);
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
        const input = topicWriteSchema.parse(body);
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
        const input = courseWriteSchema.parse(body);
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
        const input = topicWriteSchema.parse(body);
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
        const input = deleteItemSchema.parse(body);
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
    const job: PlannerJob = {
      path,
      method,
      body,
      kind,
      entity: item,
      error: null,
    };
    value.plannerJobs ??= [];
    value.plannerJobs.push(job);
    return kind === 'course'
      ? { course: item as Course }
      : { topic: item as Topic };
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
          ? courseResponseSchema.parse(response).course
          : topicResponseSchema.parse(response).topic;
      await state(true, (value) => {
        if (!authorized(value) || value.session?.user?.id !== owner) return;
        value.plannerJobs = queuedPlanner(value).filter(
          (item) => item.body.operationId !== job.body.operationId,
        );
        mergePlannerCache(value, job.kind, saved);
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
          title: job.entity.name,
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
