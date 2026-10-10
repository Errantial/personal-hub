import {
  createTaskSchema,
  updateTaskSchema,
  deleteItemSchema,
  taskSchema,
  tasksResponseSchema,
  sessionResponseSchema,
} from '@hub/contracts';
import type { Task, SessionResponse } from '@hub/contracts';

type Job = {
  path: string;
  method: string;
  body: Record<string, unknown>;
  task: Task;
  error: string | null;
};
type LocalState = {
  session: SessionResponse | null;
  locked: boolean;
  cache: Record<string, { data: unknown; savedAt: string }>;
  tasks: Task[];
  jobs: Job[];
};
const empty = (): LocalState => ({
  session: null,
  locked: true,
  cache: {},
  tasks: [],
  jobs: [],
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
    const request = indexedDB.open('hub-offline', 1);
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
    return value.cache[path]?.data;
  });
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
type Transport = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;
export async function syncTasks(send: Transport) {
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
      changed();
    },
  );
}
export async function offlineStatus() {
  return state(false, (value) => ({
    unavailable,
    pending: value.jobs.length,
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
  }));
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
