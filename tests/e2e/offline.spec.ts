import { expect, test } from '@playwright/test';
import {
  addTask,
  open,
  openTask,
  showTasks,
  syncNow,
  syncState,
  signOut,
  taskEditor,
  tasksRegion,
} from './shell';
import { authenticate } from './auth';
test.beforeEach(async ({ page }) => {
  await authenticate(page);
});
test('two tabs share the durable queue and synchronize each creation once', async ({
  page,
  context,
}) => {
  await warm(page);
  const other = await context.newPage();
  await warm(other);
  await context.setOffline(true);
  for (const [tab, title] of [
    [page, 'Offline tab one'],
    [other, 'Offline tab two'],
  ] as const) {
    await addTask(tab, title);
  }
  await context.setOffline(false);
  await Promise.all([page, other].map((tab) => syncNow(tab)));
  await expect
    .poll(async () => {
      const tasks = (await (await page.request.get('/api/v1/tasks')).json())
        .tasks as { title: string }[];
      return tasks.filter(
        (item) =>
          item.title === 'Offline tab one' || item.title === 'Offline tab two',
      ).length;
    })
    .toBe(2);
  await page.reload();
  await expect(syncState(page)).toContainText('All saved');
  await other.close();
});
test('a revoked session locks queued drafts until the same owner signs in again', async ({
  page,
  context,
}) => {
  await warm(page);
  await context.setOffline(true);
  const panel = tasksRegion(page);
  await addTask(page, 'Revoked session draft');
  await expect(syncState(page)).toContainText('1 queued');
  // The server-side request bypasses the page client, simulating revocation.
  await page.request.post('/api/v1/auth/logout', {
    headers: { Origin: 'http://127.0.0.1:5180' },
    data: {},
  });
  await context.setOffline(false);
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  expect((await page.request.get('/api/v1/tasks')).status()).toBe(401);
  await page.getByLabel('Email', { exact: true }).fill('browser@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(syncState(page)).toContainText('All saved');
  await expect(
    panel.getByText('Revoked session draft', { exact: true }),
  ).toBeVisible();
});
test('expired cached sessions cannot reopen private views offline', async ({
  page,
  context,
}) => {
  await warm(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('hub-offline');
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('local', 'readwrite');
      const store = tx.objectStore('local');
      const r = store.get('state');
      r.onsuccess = () => {
        const value = r.result;
        value.session.expiresAt = '2000-01-01T00:00:00.000Z';
        store.put(value, 'state');
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    });
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tasks' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toBeVisible();
});
async function warm(page: import('@playwright/test').Page) {
  await page.goto('/tasks');
  await expect(
    tasksRegion(page).getByRole('button', { name: 'Add task', exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    tasksRegion(page).getByRole('button', { name: 'Add task', exact: true }),
  ).toBeEnabled();
  // The list must finish loading (and be cached) before going offline.
  await expect(
    tasksRegion(page).getByRole('button', { name: 'Reload tasks' }),
  ).toBeEnabled();
}
test('academic source relabeling retains an offline task draft and inherited labels', async ({
  page,
  context,
}) => {
  const headers = { Origin: 'http://127.0.0.1:5180' };
  const courseReply = await page.request.post('/api/v1/courses', {
    headers,
    data: { name: 'Offline academic class', operationId: crypto.randomUUID() },
  });
  expect(courseReply.status()).toBe(200);
  const course = (await courseReply.json()).course;
  const workReply = await page.request.post('/api/v1/academic-work', {
    headers,
    data: {
      courseId: course.id,
      title: 'Offline academic source',
      operationId: crypto.randomUUID(),
    },
  });
  expect(workReply.status()).toBe(200);
  const work = (await workReply.json()).work;
  const planned = await page.request.post(
    `/api/v1/academic-work/${work.id}/planner-work`,
    {
      headers,
      data: {
        kind: 'task',
        expectedWorkVersion: work.version,
        expectedCourseVersion: course.version,
        operationId: crypto.randomUUID(),
        task: { title: 'Academic offline task' },
      },
    },
  );
  expect(planned.status()).toBe(200);
  const task = (await planned.json()).task;
  await warm(page);
  await context.setOffline(true);
  await openTask(page, 'Academic offline task');
  const editor = taskEditor(page);
  await editor
    .getByLabel('Title', { exact: true })
    .fill('Academic retained draft');
  await editor
    .getByLabel('Notes (optional)', { exact: true })
    .fill('Academic local notes');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(syncState(page)).toContainText('1 queued');
  await page.route('**/api/v1/tasks/*', (route) => route.abort());
  await context.setOffline(false);
  const relabeled = await page.request.put(`/api/v1/academic-work/${work.id}`, {
    headers,
    data: {
      courseId: course.id,
      title: work.title,
      status: work.status,
      grade: null,
      sensitivity: 'restricted',
      expectedVersion: work.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(relabeled.status()).toBe(200);
  await page.unroute('**/api/v1/tasks/*');
  await syncNow(page);
  const conflicts = page.getByRole('alert', { name: 'Task conflicts' });
  await expect(conflicts).toContainText('Academic retained draft');
  await page.reload();
  await expect(conflicts).toContainText('Academic retained draft');
  await conflicts.getByText('Local draft', { exact: true }).click();
  await expect(
    conflicts.getByText('Academic local notes', { exact: true }),
  ).toBeVisible();
  const current = await page.request.get(`/api/v1/tasks/${task.id}`);
  expect(current.status()).toBe(200);
  expect((await current.json()).task).toMatchObject({
    title: 'Academic offline task',
    completed: false,
    version: task.version + 1,
    sensitivity: 'restricted',
    academicSource: { workId: work.id, labels: ['restricted'] },
  });
});
test('offline create, edit, completion and delete survive reload and reconcile once', async ({
  page,
  context,
}) => {
  await warm(page);
  const panel = tasksRegion(page);
  const sync = syncState(page);
  await context.setOffline(true);
  await addTask(page, 'Offline task');
  await openTask(page, 'Offline task');
  await taskEditor(page)
    .getByLabel('Title', { exact: true })
    .fill('Offline revised');
  await taskEditor(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(taskEditor(page).getByRole('status')).toHaveText(
    'Changes queued for sync.',
  );
  await panel
    .getByRole('checkbox', { name: 'Complete Offline revised', exact: true })
    .click();
  await expect(sync).toContainText('Offline · 3 queued');
  await page.reload();
  await showTasks(page, 'Done');
  await expect(
    panel.getByRole('checkbox', {
      name: 'Complete Offline revised',
      exact: true,
    }),
  ).toBeChecked();
  await expect(sync).toContainText('Offline · 3 queued');
  await showTasks(page, 'Open');
  await addTask(page, 'Offline deleted');
  await openTask(page, 'Offline deleted');
  await taskEditor(page).getByRole('button', { name: 'Delete task' }).click();
  // Offline deletions cannot be undone until they sync, so they are confirmed.
  const confirm = page.getByRole('dialog', {
    name: 'Delete task “Offline deleted”?',
  });
  await confirm.getByRole('button', { name: 'Delete task' }).click();
  await expect(
    panel.getByText('Deletion of “Offline deleted” queued for sync.'),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(sync).toContainText('Offline · 5 queued');
  await signOut(page);
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Sync or discard pending tasks' }),
  ).toBeVisible();
  await context.setOffline(false);
  await syncNow(page);
  await expect(sync).toContainText('Online · All saved', { timeout: 15000 });
  const response = await page.request.get('/api/v1/tasks');
  const tasks = (await response.json()).tasks as {
    title: string;
    completed: boolean;
    version: number;
  }[];
  expect(tasks.filter((item) => item.title === 'Offline revised')).toEqual([
    expect.objectContaining({ completed: true, version: 3 }),
  ]);
  expect(tasks.some((item) => item.title === 'Offline deleted')).toBe(false);
  await page.reload();
  await open(page, 'Tasks');
  await showTasks(page, 'Done');
  await expect(
    panel.getByRole('checkbox', {
      name: 'Complete Offline revised',
      exact: true,
    }),
  ).toBeChecked();
});
test('offline conflicts retain local drafts until explicitly discarded', async ({
  page,
  context,
}) => {
  await warm(page);
  await addTask(page, 'Offline conflict');
  const task = (
    await (await page.request.get('/api/v1/tasks')).json()
  ).tasks.find(
    (item: { title: string }) => item.title === 'Offline conflict',
  ) as { id: string; version: number };
  await context.setOffline(true);
  await openTask(page, 'Offline conflict');
  const editor = taskEditor(page);
  await editor
    .getByLabel('Title', { exact: true })
    .fill('Retained offline draft');
  await editor
    .getByLabel('Notes (optional)', { exact: true })
    .fill('Local conflict notes');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  // Pause automatic replay while another device changes the server record.
  await page.route('**/api/v1/tasks/*', (route) => route.abort());
  await context.setOffline(false);
  const remote = await page.request.put(`/api/v1/tasks/${task.id}`, {
    headers: { Origin: 'http://127.0.0.1:5180' },
    data: {
      title: 'Remote newer task',
      expectedVersion: task.version,
      operationId: crypto.randomUUID(),
    },
  });
  expect(remote.status()).toBe(200);
  await page.unroute('**/api/v1/tasks/*');
  await syncNow(page);
  const conflicts = page.getByRole('alert', { name: 'Task conflicts' });
  await expect(conflicts).toContainText(
    'Task conflict: Retained offline draft',
  );
  await expect(syncState(page)).toContainText('Conflict · 1');
  // The editor refuses edits while a queued change conflicts.
  await expect(editor.getByRole('alert').first()).toContainText(
    'sync conflict',
  );
  await expect(
    editor.getByRole('button', { name: 'Save changes' }),
  ).toBeDisabled();
  await page.reload();
  await expect(conflicts).toContainText(
    'Task conflict: Retained offline draft',
  );
  await conflicts.getByText('Local draft', { exact: true }).click();
  await expect(
    conflicts.getByText('Local conflict notes', { exact: true }),
  ).toBeVisible();
  await expect(
    conflicts.getByRole('link', { name: 'Open task' }),
  ).toBeVisible();
  await conflicts
    .getByRole('button', { name: 'Discard local changes' })
    .click();
  // Discarding needs explicit confirmation; Cancel keeps the draft.
  const dialog = page.getByRole('dialog', {
    name: 'Discard queued changes to “Retained offline draft”?',
  });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(conflicts).toBeVisible();
  await conflicts
    .getByRole('button', { name: 'Discard local changes' })
    .click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(syncState(page)).toContainText('All saved');
  await expect(conflicts).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Tasks', exact: true })
      .getByRole('link', { name: 'Remote newer task', exact: true }),
  ).toBeVisible();
});
test('sign-out clears private cached data and Help is available by keyboard', async ({
  page,
  context,
}) => {
  await warm(page);
  await expect(
    page.getByText('A little more breathing room.', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  const help = page.getByRole('button', { name: 'Help: Offline tasks' });
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Tasks can be created, edited/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(/Tasks can be created, edited/)).toHaveCount(0);
  await expect(help).toBeFocused();
  await signOut(page);
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  const state = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('hub-offline');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return new Promise<{
      session: unknown;
      tasks: unknown[];
      jobs: unknown[];
      cache: object;
    }>((resolve) => {
      const tx = db.transaction('local');
      const r = tx.objectStore('local').get('state');
      r.onsuccess = () => resolve(r.result);
      tx.oncomplete = () => db.close();
    });
  });
  expect(state).toMatchObject({
    session: null,
    tasks: [],
    jobs: [],
    cache: {},
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tasks' })).toHaveCount(0);
});

test('views not yet opened load offline at their own URLs after one online visit', async ({
  page,
  context,
}) => {
  await warm(page);
  // Views are prefetched after sign-in; wait until the service worker has them.
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await Promise.all(
              (await caches.keys()).map(async (name) =>
                (await caches.open(name)).keys(),
              ),
            )
          )
            .flat()
            .filter((request) => /(Settings|Connections)View/.test(request.url))
            .length,
      ),
    )
    .toBe(2);
  await context.setOffline(true);
  await page.goto('/settings/appearance');
  await expect(
    page.getByRole('checkbox', { name: 'Use e-ink mode' }),
  ).toBeVisible();
  await page.goto('/settings/connections');
  await expect(
    page.getByRole('heading', { name: 'Connections', level: 2 }),
  ).toBeVisible();
  await context.setOffline(false);
});
