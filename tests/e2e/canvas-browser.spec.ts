import { expect, test } from '@playwright/test';
import { authenticate } from './auth';
import { openCanvas } from './shell';

test('Canvas browser coverage stays explicit and course selection is owner-controlled on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await authenticate(page);
  const stamp = '2026-10-16T19:00:00.000Z';
  const course = {
    id: crypto.randomUUID(),
    providerId: '101',
    name: 'Browser collected course',
    canonicalUrl: 'https://canvas.colorado.edu/courses/101',
    availability: 'available' as const,
    selected: false,
    courseId: null,
    courseName: null,
    courseDeleted: false,
    notes: '',
    sensitivity: 'unlabeled' as const,
    effectiveSensitivity: 'personal' as const,
    lastContactAt: stamp,
    lastImportAt: stamp,
    lastCompleteAt: null,
    lastObservationStatus: 'partial' as const,
    lastObservedCount: 1,
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const item = {
    id: crypto.randomUUID(),
    browserCourseId: course.id,
    resourceKind: 'quiz' as const,
    providerId: '202',
    canonicalUrl: 'https://canvas.colorado.edu/courses/101/quizzes/202',
    title: 'Browser collected quiz',
    dueAt: null,
    capturedAt: stamp,
    availability: 'available' as const,
    notes: '',
    sensitivity: 'unlabeled' as const,
    effectiveSensitivity: 'personal' as const,
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const data = {
    configured: false,
    version: 1,
    sensitivity: 'personal' as const,
    healthStatus: 'partial' as const,
    lastAttemptAt: stamp,
    lastContactAt: stamp,
    lastImportAt: stamp,
    lastCompleteAt: null,
    lastAttemptOutcome: 'partial' as const,
    lastErrorCode: 'traversal-limit' as const,
    courses: [course],
    items: [item],
    attempts: [
      {
        id: crypto.randomUUID(),
        sourceVersion: 1,
        outcome: 'partial' as const,
        errorCode: 'traversal-limit' as const,
        discoveryStatus: 'complete' as const,
        selectedCount: 1,
        completeCount: 0,
        startedAt: stamp,
        finishedAt: stamp,
      },
    ],
  };
  await page.route('**/api/v1/connections/canvas/browser**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ json: data });
    if (path.endsWith('/token')) {
      data.configured = true;
      data.version++;
      return route.fulfill({
        json: {
          token: `hubcb_${'A'.repeat(43)}`,
          connection: data,
        },
      });
    }
    if (path === '/api/v1/connections/canvas/browser') {
      const body = request.postDataJSON();
      data.sensitivity = body.sensitivity;
      data.version++;
      return route.fulfill({ json: data });
    }
    if (path.includes('/courses/')) {
      const body = request.postDataJSON();
      Object.assign(course, {
        selected: body.selected,
        notes: body.notes,
        sensitivity: body.sensitivity,
        version: course.version + 1,
      });
      data.version++;
      return route.fulfill({
        json: { course, sourceVersion: data.version },
      });
    }
    return route.fulfill({
      status: 500,
      json: { error: { code: 'TEST_ROUTE' } },
    });
  });

  await page.goto('/');
  await openCanvas(page, 'Browser collector');
  await expect(page).toHaveURL('/settings/connections/canvas?tab=browser');
  const region = page.getByRole('region', {
    name: 'Canvas browser connection',
  });
  await expect(region).toContainText('Partial');
  await expect(region).toContainText('traversal-limit');
  await expect(region).toContainText('Complete through: Never');
  const browserCourse = region.getByRole('region', {
    name: 'Canvas browser course Browser collected course',
  });
  await expect(browserCourse).toContainText('Not selected');
  await expect(browserCourse).toContainText('Coverage: partial');
  await expect(browserCourse).toContainText('Browser collected quiz');
  await expect(browserCourse).toContainText('No due date');

  await region.getByRole('button', { name: 'Create collector token' }).click();
  await expect(
    region.getByRole('textbox', { name: 'Canvas browser collector token' }),
  ).toHaveValue(/^hubcb_/);
  await region.getByRole('button', { name: 'I saved it' }).click();
  await expect(
    region.getByRole('textbox', { name: 'Canvas browser collector token' }),
  ).toHaveCount(0);

  await browserCourse
    .getByRole('button', { name: 'Edit browser course' })
    .click();
  const form = browserCourse.getByRole('form', {
    name: 'Canvas browser course editor',
  });
  await region.getByLabel('Imported Canvas label').selectOption('restricted');
  await form.getByRole('checkbox', { name: 'Collect this course' }).check();
  await form
    .getByLabel('Personal notes')
    .fill('Keep this selected for browser coverage.');
  course.version++;
  data.version++;
  await page.waitForTimeout(5200);
  await expect(region.getByLabel('Imported Canvas label')).toHaveValue(
    'restricted',
  );
  await expect(form.getByLabel('Personal notes')).toHaveValue(
    'Keep this selected for browser coverage.',
  );
  await expect(
    form.getByRole('checkbox', { name: 'Collect this course' }),
  ).toBeChecked();
  await region.getByRole('button', { name: 'Reload source version' }).click();
  await form.getByRole('button', { name: 'Reload course version' }).click();
  await expect(region.getByLabel('Imported Canvas label')).toHaveValue(
    'restricted',
  );
  await expect(form.getByLabel('Personal notes')).toHaveValue(
    'Keep this selected for browser coverage.',
  );
  await region.getByRole('button', { name: 'Save source label' }).click();
  await expect(region).toContainText('Canvas browser source label saved.');
  await form.getByRole('button', { name: 'Save browser course' }).click();
  await expect(region).toContainText('Canvas browser course saved.');
  await expect(browserCourse).toContainText('Selected');

  const browserItem = browserCourse.getByRole('region', {
    name: 'Canvas browser quiz Browser collected quiz',
  });
  await browserItem
    .getByRole('button', { name: 'Edit browser item notes' })
    .click();
  const itemForm = browserItem.getByRole('form', {
    name: 'Canvas browser item editor',
  });
  await itemForm.getByLabel('Personal notes').fill('Unsaved item note.');
  item.version++;
  await page.waitForTimeout(5200);
  await itemForm.getByRole('button', { name: 'Reload item version' }).click();
  await expect(itemForm.getByLabel('Personal notes')).toHaveValue(
    'Unsaved item note.',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
