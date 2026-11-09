import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
import { addTask, taskEditor } from './shell';

const headers = { Origin: 'http://127.0.0.1:5180' };

function day(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

test.beforeEach(async ({ page }) => {
  await authenticate(page);
});

test('creates a repeating task with a summary and repeat icon', async ({
  page,
}) => {
  await page.goto('/tasks');
  const dueDate = day(1);
  await addTask(page, 'Weekly review', dueDate);
  const row = page.getByRole('listitem').filter({ hasText: 'Weekly review' });
  await row.getByRole('link', { name: 'Weekly review', exact: true }).click();
  const editor = taskEditor(page);
  await expect(editor.getByLabel(/^Repeat/)).toHaveValue('none');
  await editor.getByLabel(/^Repeat/).selectOption('weekly');
  await expect(editor.getByText(/^Weekly on/)).toBeVisible();
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByText('Saved.')).toBeVisible();
  await expect(row.locator('.repeat-mark')).toBeVisible();
  const saved = await page.request.get('/api/v1/tasks', { headers });
  const tasks = (
    (await saved.json()) as { tasks: { title: string; recurrence: unknown }[] }
  ).tasks;
  expect(
    tasks.find((task) => task.title === 'Weekly review')?.recurrence,
  ).toMatchObject({ frequency: 'weekly' });
});
