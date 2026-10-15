import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authenticate } from './auth';

const conversationId = '00000000-0000-4000-8000-0000000000a1';
const note = (agent: boolean, title: string) => ({
  id: crypto.randomUUID(),
  reminderId: agent ? null : crypto.randomUUID(),
  runId: agent ? crypto.randomUUID() : null,
  conversationId: agent ? conversationId : null,
  title,
  createdAt: new Date().toISOString(),
  readAt: null as string | null,
});
async function stub(page: Page) {
  const state = {
    items: [] as ReturnType<typeof note>[],
    reads: [] as string[][],
  };
  await page.route('**/api/v1/notifications', (route) =>
    route.fulfill({ json: { notifications: state.items } }),
  );
  await page.route('**/api/v1/notifications/summary', (route) =>
    route.fulfill({
      json: { unreadCount: state.items.filter((item) => !item.readAt).length },
    }),
  );
  await page.route('**/api/v1/notifications/history?*', (route) =>
    route.fulfill({
      json: {
        notifications: state.items.filter((item) => !item.readAt),
        nextBefore: null,
        unreadCount: state.items.filter((item) => !item.readAt).length,
      },
    }),
  );
  await page.route('**/api/v1/notifications/read', (route) => {
    const { notificationIds } = route.request().postDataJSON() as {
      notificationIds: string[];
    };
    state.reads.push(notificationIds);
    state.items = state.items.map((item) =>
      notificationIds.includes(item.id)
        ? { ...item, readAt: new Date().toISOString() }
        : item,
    );
    return route.fulfill({
      json: {
        notifications: state.items.filter((item) =>
          notificationIds.includes(item.id),
        ),
      },
    });
  });
  await page.route('**/api/v1/agents', (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(
    `**/api/v1/assistant/conversations/${conversationId}`,
    (route) =>
      route.fulfill({
        json: {
          conversation: {
            id: conversationId,
            title: 'Kept agent conversation',
            turnCount: 0,
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            agent: null,
          },
          turns: [],
        },
      }),
  );
  return state;
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('Inbox links an agent result without a browser alert; reminder alerts still work', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { notificationCalls: calls });
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission = 'granted';
        constructor(_title: string, options?: NotificationOptions) {
          calls.push(options?.tag ?? '');
        }
      },
    });
  });
  const state = await stub(page);
  await page.goto('/inbox');
  await expect(
    page.getByText('No notifications.', { exact: true }),
  ).toBeVisible();
  const reminder = note(false, 'Reminder result');
  const agent = note(true, 'Daily plan needs approval');
  state.items = [agent, reminder];
  const link = page.getByRole('link', { name: agent.title, exact: true });
  await expect(link).toBeVisible({ timeout: 15000 });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { notificationCalls: string[] })
          .notificationCalls,
    ),
  ).toEqual([reminder.id]);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/assistant/${conversationId}$`));
  await expect(
    page.getByRole('heading', { name: 'Kept agent conversation' }),
  ).toBeVisible();
  await expect.poll(() => state.reads.flat()).toEqual([agent.id]);
  expect(
    state.items.find((item) => item.id === reminder.id)!.readAt,
  ).toBeNull();
});

test('opening a kept thread directly marks only its notifications read, including older pages', async ({
  page,
}) => {
  const state = await stub(page);
  const agent = note(true, 'Older agent result');
  const unrelated = note(true, 'Another thread');
  unrelated.conversationId = crypto.randomUUID();
  state.items = [unrelated, agent];
  const cursor = crypto.randomUUID();
  await page.route('**/api/v1/notifications/history?*', (route) =>
    route.fulfill({
      json: {
        notifications: new URL(route.request().url()).searchParams.has('before')
          ? [agent]
          : [unrelated],
        nextBefore: new URL(route.request().url()).searchParams.has('before')
          ? null
          : cursor,
        unreadCount: 2,
      },
    }),
  );
  await page.goto(`/assistant/${conversationId}`);
  await expect.poll(() => state.reads.flat()).toEqual([agent.id]);
  expect(
    state.items.find((item) => item.id === unrelated.id)!.readAt,
  ).toBeNull();
});

test('Today unread notifications link to the agent conversation', async ({
  page,
}) => {
  const state = await stub(page);
  const agent = note(true, 'Daily plan applied changes');
  state.items = [agent];
  await page.goto('/today');
  await page.getByText('Unread notifications · 1', { exact: true }).click();
  await page.getByRole('link', { name: agent.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/assistant/${conversationId}$`));
  await expect.poll(() => state.reads.flat()).toEqual([agent.id]);
});

test('Retry refreshes the unread badge after a committed read loses its response', async ({
  page,
}) => {
  const state = await stub(page);
  const agent = note(true, 'Lost read response');
  state.items = [agent];
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await page.route('**/api/v1/notifications/read', async (route) => {
    await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('1');
    state.items = state.items.map((item) => ({
      ...item,
      readAt: new Date().toISOString(),
    }));
    await route.abort('failed');
  });
  await page.goto(`/assistant/${conversationId}`);
  await expect(page.getByRole('alert')).toContainText(
    'Could not mark this conversation',
  );
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('1');
  await page.getByRole('button', { name: 'Retry notification read' }).click();
  await expect(nav.getByRole('link', { name: /Inbox/ })).not.toContainText('1');
});
