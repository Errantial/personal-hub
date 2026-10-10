import { expect, test } from '@playwright/test';
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
    const panel = tab.getByRole('region', { name: 'Tasks' });
    await panel.getByLabel('Task title').fill(title);
    await panel.getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(panel.getByText(title, { exact: true })).toBeVisible();
  }
  await context.setOffline(false);
  await Promise.all(
    [page, other].map((tab) =>
      tab
        .getByRole('region', { name: 'Task sync' })
        .getByRole('button', { name: 'Sync now' })
        .click(),
    ),
  );
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
  await expect(page.getByRole('region', { name: 'Task sync' })).toContainText(
    '0 pending changes',
  );
  await other.close();
});
test('a revoked session locks queued drafts until the same owner signs in again', async ({
  page,
  context,
}) => {
  await warm(page);
  await context.setOffline(true);
  const panel = page.getByRole('region', { name: 'Tasks' });
  await panel.getByLabel('Task title').fill('Revoked session draft');
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Task sync' })).toContainText(
    '1 pending changes',
  );
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
  await expect(page.getByRole('region', { name: 'Task sync' })).toContainText(
    '0 pending changes',
  );
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
  await page.goto('/');
  await expect(
    page
      .getByRole('region', { name: 'Tasks' })
      .getByRole('button', { name: 'Add task', exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Tasks' })
      .getByRole('button', { name: 'Add task', exact: true }),
  ).toBeEnabled();
}
test('offline create, edit, completion and delete survive reload and reconcile once', async ({
  page,
  context,
}) => {
  await warm(page);
  const panel = page.getByRole('region', { name: 'Tasks' });
  const sync = page.getByRole('region', { name: 'Task sync' });
  await context.setOffline(true);
  await panel.getByLabel('Task title').fill('Offline task');
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(panel.getByText('Offline task', { exact: true })).toBeVisible();
  await panel
    .getByRole('button', { name: 'Edit Offline task', exact: true })
    .click();
  await panel.getByLabel('Task title').fill('Offline revised');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await panel
    .getByRole('checkbox', { name: 'Complete Offline revised', exact: true })
    .check();
  await expect(sync).toContainText('3 pending changes');
  await page.reload();
  await expect(
    panel.getByRole('checkbox', {
      name: 'Complete Offline revised',
      exact: true,
    }),
  ).toBeChecked();
  await expect(sync).toContainText('3 pending changes');
  await panel.getByLabel('Task title').fill('Offline deleted');
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Delete Offline deleted', exact: true })
    .click();
  await expect(sync).toContainText('5 pending changes');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Sync or discard pending tasks' }),
  ).toBeVisible();
  await context.setOffline(false);
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await expect(sync).toContainText('0 pending changes', { timeout: 15000 });
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
  const panel = page.getByRole('region', { name: 'Tasks' });
  await panel.getByLabel('Task title').fill('Offline conflict');
  await panel.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(
    panel.getByText('Offline conflict', { exact: true }),
  ).toBeVisible();
  const task = (
    await (await page.request.get('/api/v1/tasks')).json()
  ).tasks.find(
    (item: { title: string }) => item.title === 'Offline conflict',
  ) as { id: string; version: number };
  await context.setOffline(true);
  await panel
    .getByRole('button', { name: 'Edit Offline conflict', exact: true })
    .click();
  await panel.getByLabel('Task title').fill('Retained offline draft');
  await panel.getByLabel('Notes', { exact: true }).fill('Local conflict notes');
  await panel.getByRole('button', { name: 'Save changes' }).click();
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
  const sync = page.getByRole('region', { name: 'Task sync' });
  await sync.getByRole('button', { name: 'Sync now' }).click();
  await expect(sync.getByRole('alert')).toContainText(
    'Task conflict: Retained offline draft',
  );
  await page.reload();
  await expect(sync.getByRole('alert')).toContainText(
    'Task conflict: Retained offline draft',
  );
  await sync.getByText('Local draft', { exact: true }).click();
  await expect(
    sync.getByText('Local conflict notes', { exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await sync.getByRole('button', { name: 'Discard local changes' }).click();
  await expect(sync).toContainText('0 pending changes');
  await expect(
    panel.getByText('Remote newer task', { exact: true }),
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
  const help = page.getByLabel('Offline tasks help', { exact: true });
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Tasks can be created, edited/)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
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
