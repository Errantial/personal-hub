import { test, expect } from '@playwright/test';
import { authenticate } from './auth';
test('Canvas API views preserve note conflicts and show linked assignments offline on a narrow screen', async ({
  page,
  context,
}) => {
  await authenticate(page);
  const localReply = await page.request.post('/api/v1/courses', {
    headers: { Origin: 'http://127.0.0.1:5180' },
    data: {
      operationId: crypto.randomUUID(),
      name: 'API portfolio browser class',
      sensitivity: 'personal',
    },
  });
  expect(localReply.status()).toBe(200);
  const local = (await localReply.json()).course;
  const stamp = '2027-05-01T17:00:00.000Z';
  const course = {
    id: crypto.randomUUID(),
    providerId: '101',
    providerData: {
      name: 'API browser course',
      code: 'API101',
      term: 'Test term',
      timeZone: 'UTC',
    },
    courseId: null as string | null,
    courseName: null as string | null,
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
    providerId: '202',
    canvasCourseId: course.id,
    providerData: {
      title: 'API browser assignment',
      dueAt: null,
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
  const data = {
    configured: false,
    enabled: false,
    sensitivity: 'unlabeled',
    version: 1,
    lastImportedAt: stamp,
    jobs: [],
    courses: [course],
    assignments: [assignment],
  };
  // Browser fixtures exercise UI contracts; real persistence/transport run in API tests.
  await page.route('**/api/v1/connections/canvas/lms**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET')
      return route.fulfill({
        json:
          path.endsWith('/records') && !course.courseId
            ? { courses: [], assignments: [], lastImportedAt: stamp }
            : data,
      });
    const body = request.postDataJSON();
    if (path.endsWith(`/courses/${course.id}`)) {
      if (body.expectedVersion !== course.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'VERSION_CONFLICT' } },
        });
      Object.assign(course, {
        notes: body.notes,
        sensitivity: body.sensitivity,
        courseId: body.courseId,
        courseName: local.name,
        effectiveSensitivity: 'personal',
        version: course.version + 1,
      });
      assignment.effectiveSensitivity = 'personal';
      return route.fulfill({ json: { course } });
    }
    if (path.endsWith(`/assignments/${assignment.id}`)) {
      if (body.expectedVersion !== assignment.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'VERSION_CONFLICT' } },
        });
      Object.assign(assignment, {
        notes: body.notes,
        sensitivity: body.sensitivity,
        version: assignment.version + 1,
      });
      return route.fulfill({ json: { assignment } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  const connection = page.getByRole('region', {
    name: 'Canvas API connection',
    exact: true,
  });
  await expect(connection).toContainText('API not configured');
  await expect(
    connection.getByRole('button', { name: 'Sync Canvas API', exact: true }),
  ).toBeDisabled();
  const apiCourse = connection.getByRole('region', {
    name: 'Canvas API course API browser course',
    exact: true,
  });
  await apiCourse
    .getByRole('button', { name: 'Edit API course notes', exact: true })
    .click();
  let form = apiCourse.getByRole('form', { name: 'Canvas API notes' });
  await form.getByLabel('API personal notes').fill('Browser API course note');
  await form.getByLabel('API linked class').selectOption(local.id);
  await form
    .getByRole('button', { name: 'Save API notes', exact: true })
    .click();
  await expect(connection.getByRole('status')).toHaveText(
    'Canvas API notes saved.',
  );
  const apiAssignment = connection.getByRole('region', {
    name: 'Canvas API assignment API browser assignment',
    exact: true,
  });
  await apiAssignment
    .getByRole('button', { name: 'Edit API assignment notes', exact: true })
    .click();
  form = apiAssignment.getByRole('form', { name: 'Canvas API notes' });
  await form.getByLabel('API personal notes').fill('Retained API note draft');
  assignment.version++;
  await form
    .getByRole('button', { name: 'Save API notes', exact: true })
    .click();
  await expect(connection.getByRole('alert')).toContainText(
    'changed elsewhere',
  );
  await expect(form.getByLabel('API personal notes')).toHaveValue(
    'Retained API note draft',
  );
  await connection
    .getByRole('button', { name: 'Reload Canvas API', exact: true })
    .click();
  await form
    .getByRole('button', { name: 'Reload API record version', exact: true })
    .click();
  await form
    .getByRole('button', { name: 'Save API notes', exact: true })
    .click();
  await expect(connection.getByRole('status')).toHaveText(
    'Canvas API notes saved.',
  );
  const plannerRequests: Record<string, unknown>[] = [];
  await page.route('**/api/v1/tasks', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (!(await page.evaluate(() => navigator.onLine)))
      return route.abort('internetdisconnected');
    const body = route.request().postDataJSON();
    plannerRequests.push(body);
    if (body.canvasSourceRef.expectedCourseVersion !== course.version)
      return route.fulfill({
        status: 409,
        json: { error: { code: 'VERSION_CONFLICT' } },
      });
    return route.fulfill({
      json: {
        task: {
          id: crypto.randomUUID(),
          title: body.title,
          notes: body.notes,
          dueDate: body.dueDate,
          priority: 'normal',
          completed: false,
          sensitivity: 'unlabeled',
          version: 1,
          createdAt: stamp,
          updatedAt: stamp,
          deletedAt: null,
        },
      },
    });
  });
  await apiAssignment
    .getByRole('button', { name: 'Create task', exact: true })
    .click();
  const planning = apiAssignment.getByRole('form', { name: 'Canvas planning' });
  await expect(planning.getByLabel('Task deadline')).toHaveValue('');
  await planning.getByLabel('Planner title').fill('API planner retained draft');
  course.version++;
  await planning
    .getByRole('button', { name: 'Save task', exact: true })
    .click();
  await expect(apiAssignment.getByRole('alert')).toContainText(
    'assignment or course changed',
  );
  await connection
    .getByRole('button', { name: 'Reload Canvas API', exact: true })
    .click();
  await planning
    .getByRole('button', { name: 'Reload source version', exact: true })
    .click();
  await expect(planning.getByLabel('Planner title')).toHaveValue(
    'API planner retained draft',
  );
  await context.setOffline(true);
  await planning
    .getByRole('button', { name: 'Save task', exact: true })
    .click();
  await expect(apiAssignment.getByRole('alert')).toContainText(
    'Connect to create a task from Canvas',
  );
  await context.setOffline(false);
  await planning
    .getByRole('button', { name: 'Save task', exact: true })
    .click();
  await expect(apiAssignment.getByRole('status')).toHaveText('Task created.');
  expect(plannerRequests.at(-1)?.canvasSourceRef).toEqual({
    kind: 'assignment-api',
    itemId: assignment.id,
    expectedVersion: assignment.version,
    expectedCourseVersion: course.version,
  });
  let studyRequest: Record<string, unknown> | undefined;
  await page.route('**/api/v1/calendar', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    studyRequest = route.request().postDataJSON();
    return route.fulfill({
      json: {
        event: {
          ...studyRequest,
          id: crypto.randomUUID(),
          sensitivity: 'unlabeled',
          version: 1,
          createdAt: stamp,
          updatedAt: stamp,
          deletedAt: null,
        },
      },
    });
  });
  await apiAssignment
    .getByRole('button', { name: 'Plan study', exact: true })
    .click();
  await expect(planning.getByLabel('Study class')).toHaveValue(local.id);
  await planning.getByLabel('Study timezone').fill('UTC');
  await planning.getByLabel('Study starts').fill('2027-04-30T15:00');
  await planning.getByLabel('Study ends').fill('2027-04-30T16:00');
  await planning
    .getByRole('button', { name: 'Save study block', exact: true })
    .click();
  await expect(apiAssignment.getByRole('status')).toHaveText(
    'Study block created.',
  );
  expect(studyRequest).toMatchObject({
    courseId: local.id,
    startsAt: '2027-04-30T15:00:00.000Z',
    canvasSourceRef: { kind: 'assignment-api' },
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Classes', exact: true }).click();
  await page.getByRole('button', { name: local.name, exact: true }).click();
  const portfolio = page.getByRole('region', {
    name: 'Class Canvas assignments',
    exact: true,
  });
  await expect(portfolio).toContainText('API browser assignment');
  await expect(portfolio).toContainText('Deadline unknown');
  await portfolio.getByText('Assignment details', { exact: true }).click();
  await expect(portfolio).toContainText('Possible points: 20');
  await portfolio.getByText('Personal notes', { exact: true }).click();
  await expect(portfolio).toContainText('Retained API note draft');
  await page.unroute('**/api/v1/connections/canvas/lms**');
  await context.setOffline(true);
  await portfolio
    .getByRole('button', { name: 'Reload assignments', exact: true })
    .click();
  await expect(portfolio).toContainText('API browser assignment');
  await expect(portfolio.getByRole('alert')).toHaveCount(0);
  await context.setOffline(false);
});
