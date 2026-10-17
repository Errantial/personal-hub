import { test, expect } from '@playwright/test';
import { openCanvas } from './shell';
import { authenticate } from './auth';
test('reconciliation preserves conflicts and retry identity, shows source differences and removes changed links on a narrow screen', async ({
  page,
}) => {
  await authenticate(page);
  const stamp = '2027-05-01T17:00:00.000Z';
  const course = {
    id: crypto.randomUUID(),
    providerId: '10',
    providerData: {
      name: 'Reconciliation API course',
      code: 'API',
      term: 'Test',
      timeZone: 'UTC',
    },
    courseId: null,
    courseName: null,
    courseDeleted: false,
    notes: '',
    sensitivity: 'unlabeled',
    effectiveSensitivity: 'unlabeled',
    availability: 'available',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const assignment = {
    id: crypto.randomUUID(),
    canvasCourseId: course.id,
    providerId: '20',
    providerData: {
      title: 'API comparison assignment',
      dueAt: '2027-05-02T17:00:00.000Z',
      pointsPossible: 20,
      published: true,
      locked: false,
    },
    availability: 'available',
    notes: '',
    sensitivity: 'unlabeled',
    effectiveSensitivity: 'unlabeled',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const item = {
    id: crypto.randomUUID(),
    uid: 'comparison-feed',
    providerData: {
      title: 'Feed comparison assignment',
      description: '',
      startsAt: stamp,
      endsAt: stamp,
      startDate: null,
      endDate: null,
      allDay: false,
      sourceUrl: 'https://canvas.colorado.edu/courses/10/assignments/20',
    },
    inputKind: 'calendar-file',
    availability: 'available',
    courseId: null,
    courseName: null,
    courseDeleted: false,
    notes: '',
    sensitivity: 'restricted',
    effectiveSensitivity: 'restricted',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const data = {
    courses: [course],
    assignments: [assignment],
    items: [item],
    links: [] as {
      id: string;
      itemId: string;
      assignmentId: string;
      version: number;
      createdAt: string;
      updatedAt: string;
      deletedAt: string | null;
    }[],
  };
  let loseResponse = true;
  const receipts = new Map<string, (typeof data.links)[number]>();
  const operations: string[] = [];
  await page.route(
    '**/api/v1/connections/canvas/reconciliation**',
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: data });
      const body = route.request().postDataJSON();
      operations.push(body.operationId);
      if (receipts.has(body.operationId))
        return route.fulfill({
          json: { link: receipts.get(body.operationId) },
        });
      if (body.expectedItemVersion !== item.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'VERSION_CONFLICT' } },
        });
      const previous = data.links[0];
      const link = {
        id: previous?.id ?? crypto.randomUUID(),
        itemId: item.id,
        assignmentId: assignment.id,
        version: (previous?.version ?? 0) + 1,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: body.assignmentId ? null : stamp,
      };
      data.links = [link];
      item.version++;
      assignment.version++;
      receipts.set(body.operationId, link);
      if (loseResponse) {
        loseResponse = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: { link } });
    },
  );
  await page.goto('/');
  await openCanvas(page, 'Matching');
  await page.setViewportSize({ width: 320, height: 900 });
  const panel = page.getByRole('region', {
    name: 'Canvas reconciliation',
    exact: true,
  });
  const entry = panel.getByRole('article', {
    name: 'Compare Feed comparison assignment',
  });
  await entry.getByText('Compare sources', { exact: true }).click();
  await expect(entry).toContainText('Dates differ.');
  await expect(entry).toContainText('Titles differ.');
  await entry
    .getByRole('button', { name: 'Link assignment', exact: true })
    .click();
  const form = entry.getByRole('form', { name: 'Canvas reconciliation' });
  item.version++;
  await form.getByRole('button', { name: 'Confirm link', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await expect(form.getByLabel('Reconciliation assignment')).toHaveValue(
    assignment.id,
  );
  await form
    .getByRole('button', { name: 'Reload link versions', exact: true })
    .click();
  await form.getByRole('button', { name: 'Confirm link', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await form.getByRole('button', { name: 'Confirm link', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Link confirmed.');
  expect(operations.at(-1)).toBe(operations.at(-2));
  item.providerData.sourceUrl =
    'https://canvas.colorado.edu/courses/10/assignments/21';
  item.version++;
  await panel
    .getByRole('button', { name: 'Reload comparisons', exact: true })
    .click();
  await expect(entry).toContainText(
    'Assignment URL changed. Review this link.',
  );
  await entry.getByRole('button', { name: 'Review link', exact: true }).click();
  await form.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Link removed.');
  await expect(panel).toContainText('No matching assignment URLs.');
  expect(data.links[0]!.deletedAt).not.toBeNull();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('browser reconciliation keeps browser facts when the calendar feed later omits the linked item', async ({
  page,
}) => {
  await authenticate(page);
  const stamp = '2027-05-01T17:00:00.000Z';
  const feedItem = {
    id: crypto.randomUUID(),
    uid: 'browser-feed-comparison',
    providerData: {
      title: 'Calendar feed title',
      description: '',
      startsAt: stamp,
      endsAt: stamp,
      startDate: null,
      endDate: null,
      allDay: false,
      sourceUrl: 'https://canvas.colorado.edu/courses/10/assignments/20',
    },
    inputKind: 'calendar-feed',
    availability: 'available',
    courseId: null,
    courseName: null,
    courseDeleted: false,
    notes: '',
    sensitivity: 'unlabeled',
    effectiveSensitivity: 'unlabeled',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const browserItem = {
    id: crypto.randomUUID(),
    browserCourseId: crypto.randomUUID(),
    resourceKind: 'assignment',
    providerId: '20',
    canonicalUrl: 'https://canvas.colorado.edu/courses/10/assignments/20',
    title: 'Browser title',
    dueAt: '2027-05-02T17:00:00.000Z',
    capturedAt: stamp,
    availability: 'available',
    notes: '',
    sensitivity: 'personal',
    effectiveSensitivity: 'personal',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const data = {
    courses: [],
    assignments: [],
    items: [feedItem],
    links: [],
    browserItems: [browserItem],
    browserLinks: [] as {
      id: string;
      browserItemId: string;
      itemId: string;
      version: number;
      createdAt: string;
      updatedAt: string;
      deletedAt: string | null;
    }[],
  };
  await page.route(
    '**/api/v1/connections/canvas/reconciliation**',
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: data });
      const body = route.request().postDataJSON();
      if (!route.request().url().includes('/browser/'))
        return route.fulfill({
          status: 404,
          json: { error: { code: 'NOT_FOUND' } },
        });
      const link = {
        id: data.browserLinks[0]?.id ?? crypto.randomUUID(),
        browserItemId: browserItem.id,
        itemId: feedItem.id,
        version: (data.browserLinks[0]?.version ?? 0) + 1,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: body.itemId ? null : stamp,
      };
      data.browserLinks = [link];
      browserItem.version++;
      feedItem.version++;
      return route.fulfill({ json: { link } });
    },
  );
  await page.goto('/');
  await openCanvas(page, 'Matching');
  await page.setViewportSize({ width: 320, height: 900 });
  const panel = page.getByRole('region', {
    name: 'Canvas reconciliation',
    exact: true,
  });
  const entry = panel.getByRole('article', {
    name: 'Compare browser Browser title',
  });
  await entry.getByText('Compare browser and feed', { exact: true }).click();
  await expect(entry).toContainText('Dates differ.');
  await expect(entry).toContainText('Titles differ.');
  await entry
    .getByRole('button', { name: 'Link browser item', exact: true })
    .click();
  await entry
    .getByRole('button', { name: 'Confirm browser link', exact: true })
    .click();
  await expect(panel.getByRole('status')).toHaveText('Browser link confirmed.');

  feedItem.availability = 'missing';
  await panel
    .getByRole('button', { name: 'Reload comparisons', exact: true })
    .click();
  await expect(entry).toContainText(
    'Linked · assignment · available · personal',
  );
  await entry.getByText('Compare browser and feed', { exact: true }).click();
  await expect(entry).toContainText('missing');
  await expect(entry).not.toContainText('No calendar-feed item with this URL');
  expect(data.browserLinks[0]!.deletedAt).toBeNull();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
