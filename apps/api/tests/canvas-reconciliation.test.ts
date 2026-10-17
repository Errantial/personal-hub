import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeEach, afterEach, it, expect } from 'vitest';
import {
  canvasReconciliationListSchema,
  plannerExportSchema,
  plannerSensitivity,
  plannerTextIsAttachmentDerived,
  taskResponseSchema,
  canvasPlannerWorkSchema,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runCanvasLmsSync } from '../src/connections/canvas-lms.js';
import { applyCanvasSnapshot } from '../src/connections/canvas.js';
import { parseCanvasFeed } from '../src/connections/canvas-feed.js';
const origin = 'http://127.0.0.1:5173';
const base = '/api/v1/connections/canvas/reconciliation';
const config = readConfig({
  NODE_ENV: 'test',
  PGLITE_DATA_DIR: 'memory://',
  CANVAS_API_TOKEN: 'synthetic-only',
});
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
let owner: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const feed = (url = 'https://canvas.colorado.edu/courses/10/assignments/20') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:reconcile-assignment\r\nDTSTART:20270501T170000Z\r\nDTEND:20270501T170000Z\r\nSUMMARY:Feed assignment title\r\nURL:${url}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const get = async () =>
  canvasReconciliationListSchema.parse(
    (await app.inject({ url: base, headers: headers() })).json(),
  );
const publish = async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/connections/canvas/import',
        headers: headers(),
        payload: { operationId: randomUUID(), feed: feed() },
      })
    ).statusCode,
  ).toBe(200);
  await app.inject({
    method: 'POST',
    url: '/api/v1/connections/canvas/lms/sync',
    headers: headers(),
    payload: { operationId: randomUUID() },
  });
  await runCanvasLmsSync(db, config, async () => ({
    accountProviderId: '30',
    courses: [
      {
        providerId: '10',
        data: {
          name: 'API course',
          code: 'API',
          term: 'Test',
          timeZone: 'UTC',
        },
      },
    ],
    assignments: [
      {
        providerId: '20',
        courseProviderId: '10',
        data: {
          title: 'API assignment title',
          dueAt: '2027-05-02T17:00:00.000Z',
          pointsPossible: 20,
          published: true,
          locked: false,
        },
      },
    ],
  }));
};
const linkBody = (data: Awaited<ReturnType<typeof get>>) => ({
  operationId: randomUUID(),
  expectedVersion: data.links[0]?.version ?? null,
  expectedItemVersion: data.items[0]!.version,
  assignmentId: data.assignments[0]!.id,
  expectedAssignmentVersion: data.assignments[0]!.version,
  expectedCourseVersion: data.courses[0]!.version,
});
const put = (itemId: string, payload: object, session = cookie) =>
  app.inject({
    method: 'PUT',
    url: `${base}/${itemId}`,
    headers: headers(session),
    payload,
  });
beforeEach(async () => {
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'reconciliation@example.test',
      password: 'synthetic-password-only',
    },
  });
  const setCookie = setup.headers['set-cookie']!;
  cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
    ';',
  )[0]!;
  owner = setup.json().user.id;
  const other = randomUUID();
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-reconciliation@example.test',
    'unused',
  ]);
  const token = randomBytes(32).toString('hex');
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
  await publish();
});
afterEach(async () => {
  await app?.close();
});
it('shows owned planner work across confirmed source identities without counting tombstones or inferring submission', async () => {
  let data = await get();
  const feedId = data.items[0]!.id;
  const assignmentId = data.assignments[0]!.id;
  const create = (source: object, title: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: { operationId: randomUUID(), title, canvasSourceRef: source },
    });
  const feedTask = (
    await create(
      { itemId: feedId, expectedVersion: data.items[0]!.version },
      'Feed planner work',
    )
  ).json().task;
  const apiTask = (
    await create(
      {
        kind: 'assignment-api',
        itemId: assignmentId,
        expectedVersion: data.assignments[0]!.version,
        expectedCourseVersion: data.courses[0]!.version,
      },
      'API planner work',
    )
  ).json().task;
  const work = (
    kind = 'assignment-api',
    itemId = assignmentId,
    session = cookie,
  ) =>
    app.inject({
      url: `/api/v1/connections/canvas/planner-work?${new URLSearchParams({ kind, itemId })}`,
      headers: headers(session),
    });
  expect((await work()).json().tasks).toHaveLength(1);
  expect((await work('calendar', feedId, otherCookie)).statusCode).toBe(404);
  expect((await work('assignment-api', randomUUID())).statusCode).toBe(404);
  expect((await work('unknown')).statusCode).toBe(400);
  expect((await put(feedId, linkBody(data))).statusCode).toBe(200);
  const linked = canvasPlannerWorkSchema.parse((await work()).json());
  expect(linked.tasks.map((row) => row.id).sort()).toEqual(
    [feedTask.id, apiTask.id].sort(),
  );
  expect(linked.studies).toEqual([]);
  expect((await work('calendar', feedId)).json().tasks).toHaveLength(2);
  await app.inject({
    method: 'DELETE',
    url: `/api/v1/tasks/${apiTask.id}`,
    headers: headers(),
    payload: { operationId: randomUUID(), expectedVersion: apiTask.version },
  });
  expect((await work()).json().tasks).toHaveLength(1);
  data = await get();
  await put(feedId, {
    operationId: randomUUID(),
    expectedVersion: data.links[0]!.version,
    expectedItemVersion: data.items[0]!.version,
    assignmentId: null,
    expectedAssignmentVersion: null,
    expectedCourseVersion: null,
  });
  expect((await work()).json().tasks).toEqual([]);
  expect((await work('calendar', feedId)).json().tasks).toHaveLength(1);
});
it('protects reconciliation ownership, validates source versions/identity and retries atomically', async () => {
  const data = await get();
  const item = data.items[0]!;
  const body = linkBody(data);
  expect((await app.inject(base)).statusCode).toBe(401);
  expect((await put(item.id, body, otherCookie)).statusCode).toBe(404);
  expect(
    (await put(item.id, { ...body, assignmentId: randomUUID() })).statusCode,
  ).toBe(404);
  expect(
    (await put(item.id, { ...body, expectedItemVersion: item.version + 1 }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await put(item.id, {
        ...body,
        expectedCourseVersion: body.expectedCourseVersion + 1,
      })
    ).statusCode,
  ).toBe(409);
  const result = await put(item.id, body);
  expect(result.statusCode).toBe(200);
  expect((await put(item.id, body)).json()).toEqual(result.json());
  expect((await put(item.id, { ...body, expectedVersion: 1 })).statusCode).toBe(
    409,
  );
  let current = await get();
  expect(current.links).toHaveLength(1);
  expect(current.items[0]!.version).toBe(item.version + 1);
  expect(current.assignments[0]!.version).toBe(
    body.expectedAssignmentVersion + 1,
  );
  const remove = {
    operationId: randomUUID(),
    expectedVersion: current.links[0]!.version,
    expectedItemVersion: current.items[0]!.version,
    assignmentId: null,
    expectedAssignmentVersion: null,
    expectedCourseVersion: null,
  };
  const removed = await put(item.id, remove);
  expect(removed.statusCode).toBe(200);
  expect(removed.json().link.deletedAt).toEqual(expect.any(String));
  expect((await put(item.id, remove)).json()).toEqual(removed.json());
  current = await get();
  expect(current.links[0]!.id).toBe(result.json().link.id);
  await app.inject({
    method: 'POST',
    url: '/api/v1/connections/canvas/import',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      feed: feed('https://canvas.colorado.edu/courses/10/assignments/21'),
    },
  });
  const mismatch = await put(item.id, linkBody(await get()));
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().error.code).toBe('SOURCE_IDENTITY_MISMATCH');
  const other = (
    await app.inject({ url: base, headers: headers(otherCookie) })
  ).json();
  expect(other.items).toEqual([]);
  expect(other.links).toEqual([]);
  expect(other.assignments).toEqual([]);
});
it('shares labels/file provenance without rewriting either source or planner edits and retains captured restrictions after unlink', async () => {
  let data = await get();
  const original = data.items[0]!;
  await app.inject({
    method: 'PUT',
    url: `/api/v1/connections/canvas/items/${original.id}`,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: original.version,
      notes: 'Feed personal note',
      sensitivity: 'restricted',
    },
  });
  data = await get();
  expect((await put(original.id, linkBody(data))).statusCode).toBe(200);
  data = await get();
  expect(data.assignments[0]).toMatchObject({
    effectiveSensitivity: 'restricted',
    attachmentDerived: true,
    providerData: {
      title: 'API assignment title',
      dueAt: '2027-05-02T17:00:00.000Z',
    },
  });
  expect(data.items[0]).toMatchObject({
    notes: 'Feed personal note',
    providerData: {
      title: 'Feed assignment title',
      startsAt: '2027-05-01T17:00:00.000Z',
    },
  });
  const assignment = data.assignments[0]!;
  const payload = {
    operationId: randomUUID(),
    title: 'Planner personal title',
    dueDate: '2027-05-03',
    canvasSourceRef: {
      kind: 'assignment-api',
      itemId: assignment.id,
      expectedVersion: assignment.version,
      expectedCourseVersion: data.courses[0]!.version,
    },
  };
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload,
  });
  expect(created.statusCode).toBe(200);
  let task = taskResponseSchema.parse(created.json()).task;
  expect(plannerSensitivity(task)).toBe('restricted');
  expect(plannerTextIsAttachmentDerived(task)).toBe(true);
  expect(task.canvasSource).toMatchObject({
    inputKind: 'assignment-api',
    attachmentDerived: true,
    currentAttachmentDerived: true,
    sensitivity: 'restricted',
  });
  const unlink = {
    operationId: randomUUID(),
    expectedVersion: data.links[0]!.version,
    expectedItemVersion: data.items[0]!.version,
    assignmentId: null,
    expectedAssignmentVersion: null,
    expectedCourseVersion: null,
  };
  expect((await put(original.id, unlink)).statusCode).toBe(200);
  data = await get();
  expect(data.assignments[0]).toMatchObject({
    effectiveSensitivity: 'unlabeled',
    attachmentDerived: false,
  });
  task = (await app.inject({ url: '/api/v1/tasks', headers: headers() })).json()
    .tasks[0];
  expect(task).toMatchObject({
    title: 'Planner personal title',
    dueDate: '2027-05-03',
    canvasSource: {
      currentSensitivity: 'unlabeled',
      currentAttachmentDerived: false,
    },
  });
  expect(plannerSensitivity(task)).toBe('restricted');
  expect(plannerTextIsAttachmentDerived(task)).toBe(true);
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(exported.records.canvasReconciliations[0]!.deletedAt).toEqual(
    expect.any(String),
  );
  expect(exported.records.tasks[0]!.canvasSource?.attachmentDerived).toBe(true);
});
it('retains links when provider facts change or disappear and includes live opposite-source labels', async () => {
  let data = await get();
  expect((await put(data.items[0]!.id, linkBody(data))).statusCode).toBe(200);
  const assignment = data.assignments[0]!;
  await app.inject({
    method: 'PUT',
    url: '/api/v1/connections/canvas/lms',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: 1,
      enabled: false,
      sensitivity: 'personal',
    },
  });
  data = await get();
  expect(data.items[0]!.effectiveSensitivity).toBe('personal');
  await db.transaction(async (tx) => {
    await tx.query(
      'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
      [owner],
    );
    await applyCanvasSnapshot(
      tx,
      owner,
      parseCanvasFeed(
        feed('https://canvas.colorado.edu/courses/10/assignments/21'),
      ),
      'calendar-feed',
    );
  });
  data = await get();
  expect(data.links[0]!.deletedAt).toBeNull();
  expect(data.assignments[0]!.attachmentDerived).toBe(false);
  await app.inject({
    method: 'POST',
    url: '/api/v1/connections/canvas/lms/sync',
    headers: headers(),
    payload: { operationId: randomUUID() },
  });
  await runCanvasLmsSync(db, config, async () => ({
    accountProviderId: '30',
    courses: [],
    assignments: [],
  }));
  data = await get();
  expect(data.links[0]!.assignmentId).toBe(assignment.id);
  expect(data.assignments[0]!.availability).toBe('missing');
  expect((await put(data.items[0]!.id, linkBody(data))).json().error.code).toBe(
    'SOURCE_UNAVAILABLE',
  );
  expect(
    (
      await put(data.items[0]!.id, {
        operationId: randomUUID(),
        expectedVersion: data.links[0]!.version,
        expectedItemVersion: data.items[0]!.version,
        assignmentId: null,
        expectedAssignmentVersion: null,
        expectedCourseVersion: null,
      })
    ).statusCode,
  ).toBe(200);
});

it('keeps browser/feed facts separate and reconciles them only through an exact owner-confirmed URL', async () => {
  const browserCourseId = randomUUID();
  const browserItemId = randomUUID();
  await db.query(
    "INSERT INTO canvas_browser_sources(owner_id,sensitivity) VALUES($1,'personal')",
    [owner],
  );
  await db.query(
    "INSERT INTO canvas_browser_courses(id,owner_id,provider_id,name,canonical_url,availability,selected) VALUES($1,$2,'10','Browser course','https://canvas.colorado.edu/courses/10','available',TRUE)",
    [browserCourseId, owner],
  );
  await db.query(
    "INSERT INTO canvas_browser_items(id,owner_id,browser_course_id,resource_kind,provider_id,canonical_url,title,due_at,captured_at,availability) VALUES($1,$2,$3,'assignment','20','https://canvas.colorado.edu/courses/10/assignments/20','Browser assignment','2027-05-03T17:00:00Z','2027-05-01T12:00:00Z','available')",
    [browserItemId, owner, browserCourseId],
  );

  let data = await get();
  expect(data.browserItems).toHaveLength(1);
  expect(data.browserLinks).toEqual([]);
  const feedItem = data.items[0]!;
  const browserItem = data.browserItems[0]!;
  const body = {
    operationId: randomUUID(),
    expectedVersion: null,
    expectedBrowserItemVersion: browserItem.version,
    itemId: feedItem.id,
    expectedItemVersion: feedItem.version,
  };
  const route = `${base}/browser/${browserItem.id}`;
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: route,
        headers: headers(otherCookie),
        payload: body,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: route,
        headers: headers(),
        payload: {
          ...body,
          expectedBrowserItemVersion: browserItem.version + 1,
        },
      })
    ).statusCode,
  ).toBe(409);

  const linked = await app.inject({
    method: 'PUT',
    url: route,
    headers: headers(),
    payload: body,
  });
  expect(linked.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: route,
        headers: headers(),
        payload: body,
      })
    ).json(),
  ).toEqual(linked.json());

  data = await get();
  expect(data.browserLinks).toHaveLength(1);
  expect(data.browserLinks[0]).toMatchObject({
    browserItemId,
    itemId: feedItem.id,
    deletedAt: null,
  });
  expect(data.browserItems[0]!.title).toBe('Browser assignment');
  expect(data.items[0]!.providerData.title).toBe('Feed assignment title');

  await db.transaction(async (tx) => {
    await tx.query(
      'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
      [owner],
    );
    await applyCanvasSnapshot(tx, owner, [], 'calendar-feed');
  });
  data = await get();
  expect(data.items[0]!.availability).toBe('missing');
  expect(data.browserItems[0]!.availability).toBe('available');
  expect(data.browserLinks[0]!.deletedAt).toBeNull();

  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(exported.records.canvasBrowserReconciliations).toHaveLength(1);

  const remove = {
    operationId: randomUUID(),
    expectedVersion: data.browserLinks[0]!.version,
    expectedBrowserItemVersion: data.browserItems[0]!.version,
    itemId: null,
    expectedItemVersion: null,
  };
  const removed = await app.inject({
    method: 'PUT',
    url: route,
    headers: headers(),
    payload: remove,
  });
  expect(removed.statusCode).toBe(200);
  expect(removed.json().link.deletedAt).toEqual(expect.any(String));
});

it('refuses browser/feed reconciliation when the canonical source URLs differ', async () => {
  const browserCourseId = randomUUID();
  const browserItemId = randomUUID();
  await db.query('INSERT INTO canvas_browser_sources(owner_id) VALUES($1)', [
    owner,
  ]);
  await db.query(
    "INSERT INTO canvas_browser_courses(id,owner_id,provider_id,name,canonical_url,availability) VALUES($1,$2,'10','Browser course','https://canvas.colorado.edu/courses/10','available')",
    [browserCourseId, owner],
  );
  await db.query(
    "INSERT INTO canvas_browser_items(id,owner_id,browser_course_id,resource_kind,provider_id,canonical_url,title,captured_at,availability) VALUES($1,$2,$3,'quiz','20','https://canvas.colorado.edu/courses/10/quizzes/20','Browser quiz','2027-05-01T12:00:00Z','available')",
    [browserItemId, owner, browserCourseId],
  );
  const data = await get();
  const result = await app.inject({
    method: 'PUT',
    url: `${base}/browser/${browserItemId}`,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: null,
      expectedBrowserItemVersion: data.browserItems[0]!.version,
      itemId: data.items[0]!.id,
      expectedItemVersion: data.items[0]!.version,
    },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().error.code).toBe('SOURCE_IDENTITY_MISMATCH');
  expect((await get()).browserLinks).toEqual([]);
});
