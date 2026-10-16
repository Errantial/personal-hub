import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
import { toggleEink } from './shell';
import AxeBuilder from '@axe-core/playwright';

const headers = { Origin: 'http://127.0.0.1:5180' };

for (const width of [1280, 320])
  test(`academic study suggestion reuses preview, approval and cancellation at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await authenticate(page);
    const course = (
      await (
        await page.request.post('/api/v1/courses', {
          headers,
          data: {
            operationId: crypto.randomUUID(),
            name: `Suggested study ${crypto.randomUUID().slice(0, 6)}`,
          },
        })
      ).json()
    ).course;
    const prefs = await (
      await page.request.get('/api/v1/study/preferences')
    ).json();
    expect(
      (
        await page.request.put('/api/v1/study/preferences', {
          headers,
          data: {
            operationId: crypto.randomUUID(),
            expectedVersion: prefs.version,
            timeZone: 'UTC',
            sessionMinutes: 30,
            breakMinutes: 5,
            dailyMaximumMinutes: 120,
            windows: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
              day,
              startMinute: 540,
              endMinute: 720,
            })),
          },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.put(`/api/v1/study/goals/${course.id}`, {
          headers,
          data: {
            operationId: crypto.randomUUID(),
            expectedVersion: 1,
            minutesPerWeek: 90,
            priority: 3,
            targetDate: null,
          },
        })
      ).ok(),
    ).toBe(true);
    const turnId = crypto.randomUUID();
    const suggestionId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const range = { from: '2036-05-12', to: '2036-05-19' };
    const assistant = { turnId, suggestionId };
    const request = {
      id: turnId,
      status: 'completed',
      reason: null,
      model: 'anthropic/claude-haiku-5.5',
      resultAvailable: true,
      reply: 'Review the study plan.',
      proposals: [],
      dropped: 0,
      withheld: 0,
      costMicros: 123,
      heldMicros: 0,
      createdAt: new Date().toISOString(),
    };
    const turn = {
      id: turnId,
      conversationId,
      ask: 'Suggest study time',
      request,
      version: 1,
      items: [],
      inferenceHistory: 'bound',
      proposalAccess: 'applicable',
      academic: [],
      studySuggestions: [
        {
          id: suggestionId,
          ...range,
          sources: [
            {
              id: crypto.randomUUID(),
              title: 'Selected essay',
              expectedVersion: 1,
              expectedCourseVersion: 1,
            },
          ],
        },
      ],
    };
    const conversation = {
      id: conversationId,
      title: 'Study suggestion',
      version: 1,
      turnCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await page.route('**/api/v1/assistant/conversations', (route) =>
      route.fulfill({ json: { conversations: [conversation] } }),
    );
    await page.route(
      `**/api/v1/assistant/conversations/${conversationId}`,
      (route) => route.fulfill({ json: { conversation, turns: [turn] } }),
    );
    await page.route(`**/api/v1/assistant/turns/${turnId}`, (route) =>
      route.fulfill({ json: { turn } }),
    );
    // Test-only origin adapter. API tests exercise real saved-answer provenance;
    // here real deterministic study operations prove that the existing UI is reused.
    const forwarded: string[] = [];
    await page.route('**/api/v1/study/preview', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.assistant).toEqual(assistant);
      forwarded.push('preview');
      const result = await page.request.post('/api/v1/study/preview', {
        headers,
        data: range,
      });
      await route.fulfill({ response: result });
    });
    await page.route('**/api/v1/study/plans', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const { assistant: supplied, ...body } = route.request().postDataJSON();
      expect(supplied).toEqual(assistant);
      forwarded.push('draft');
      const result = await page.request.post('/api/v1/study/plans', {
        headers,
        data: body,
      });
      await route.fulfill({ response: result });
    });
    await page.goto(`/assistant/${conversationId}`);
    if (width === 320) await toggleEink(page);
    const suggestion = page.getByRole('region', { name: 'Study suggestion' });
    await expect(suggestion.getByText('Selected essay')).toBeVisible();
    await suggestion
      .getByRole('button', { name: 'Help: Study suggestion' })
      .click();
    await expect(
      suggestion.getByText(/Nothing is scheduled by this suggestion/),
    ).toBeVisible();
    await suggestion.getByRole('link', { name: 'Review study plan' }).click();
    await expect(page).toHaveURL(
      new RegExp(`turn=${turnId}&suggestion=${suggestionId}`),
    );
    const view = page.getByRole('region', { name: 'Study plan' });
    await expect(view.getByLabel('Starting')).toHaveValue(range.from);
    await expect(view.getByLabel('Starting')).toBeDisabled();
    await view.getByRole('button', { name: 'Preview plan' }).click();
    await expect(
      view
        .getByText('Only your planner calendar was checked', { exact: false })
        .first(),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include('.study-plan').analyze())
        .violations,
    ).toEqual([]);
    await view.getByRole('button', { name: 'Save as draft' }).click();
    const open = view
      .getByRole('region', { name: 'Plans' })
      .locator('li[aria-current="true"]');
    await open.getByRole('button', { name: 'Approve plan' }).click();
    await expect(open.getByText(/^Added \d+ study blocks to/)).toBeVisible();
    await open.getByRole('button', { name: 'Cancel plan' }).click();
    await page
      .getByRole('dialog', { name: 'Cancel this plan?' })
      .getByRole('button', { name: 'Cancel plan' })
      .click();
    await expect(
      open.getByText('All of its planned blocks were cancelled.'),
    ).toBeVisible();
    expect(forwarded).toEqual(['preview', 'draft']);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
