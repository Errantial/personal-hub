import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import {
  evaluateAIRouting,
  aiRoutingPolicySchema,
  aiRoutingSettingsSchema,
  aiRoutingPreviewResponseSchema,
  plannerExportSchema,
  emptyAIRoutingPolicy,
} from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/database.js';
import { readConfig } from '../src/config.js';
import { applyCanvasSnapshot } from '../src/connections/canvas.js';
import { parseCanvasFeed } from '../src/connections/canvas-feed.js';
const origin = 'http://127.0.0.1:5173';
const base = '/api/v1/ai/routing';
const policy = aiRoutingPolicySchema.parse({
  unlabeled: { allowed: ['routine', 'private', 'vault'], preferred: 'routine' },
  personal: { allowed: ['private', 'vault'], preferred: 'private' },
  restricted: { allowed: ['vault'], preferred: 'vault' },
});
it('intersects all explicit labels, prefers the strongest-label route and blocks unavailable destinations without fallback', () => {
  expect(
    evaluateAIRouting(policy, ['unlabeled'], false, ['routine', 'private']),
  ).toMatchObject({ status: 'selected', provider: 'routine' });
  expect(
    evaluateAIRouting(policy, ['unlabeled', 'personal'], false, [
      'routine',
      'private',
    ]),
  ).toMatchObject({
    status: 'selected',
    provider: 'private',
    sensitivity: 'personal',
  });
  expect(
    evaluateAIRouting(policy, ['personal', 'unlabeled', 'restricted'], false, [
      'vault',
    ]),
  ).toMatchObject({
    status: 'selected',
    provider: 'vault',
    sensitivity: 'restricted',
  });
  expect(
    evaluateAIRouting(policy, ['personal', 'unlabeled'], false, [
      'routine',
      'vault',
    ]),
  ).toMatchObject({
    status: 'blocked',
    provider: 'private',
    reason: 'PROVIDER_UNAVAILABLE',
  });
  expect(
    evaluateAIRouting(
      { ...policy, personal: { allowed: ['private'], preferred: 'private' } },
      ['personal', 'restricted'],
      false,
      ['private', 'vault'],
    ),
  ).toMatchObject({ status: 'blocked', reason: 'NO_APPROVED_PROVIDER' });
  expect(
    evaluateAIRouting(policy, ['restricted'], true, ['vault']),
  ).toMatchObject({
    status: 'blocked',
    provider: null,
    reason: 'ATTACHMENT_DERIVED',
  });
  expect(
    evaluateAIRouting(emptyAIRoutingPolicy, ['unlabeled'], false, ['routine']),
  ).toMatchObject({ status: 'blocked', reason: 'NO_APPROVED_PROVIDER' });
  expect(() => evaluateAIRouting(policy, [], false, ['routine'])).toThrow(
    'provenance',
  );
});
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = (session = cookie) =>
  app.inject({ url: base, headers: headers(session) });
const preview = (payload: object, session = cookie) =>
  app.inject({
    method: 'POST',
    url: `${base}/preview`,
    headers: headers(session),
    payload,
  });
beforeAll(async () => {
  const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'routing@example.test',
      password: 'synthetic-routing-password',
    },
  });
  const cookies = setup.headers['set-cookie']!;
  cookie = (Array.isArray(cookies) ? cookies[0]! : cookies).split(';')[0]!;
  const other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-routing@example.test',
    'unused',
  ]);
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
});
afterAll(async () => {
  await app?.close();
});
it('protects versioned permissions, deduplicates retries and exports only owner configuration', async () => {
  expect((await get('')).statusCode).toBe(401);
  const initial = aiRoutingSettingsSchema.parse((await get()).json());
  expect(initial.policy).toEqual(emptyAIRoutingPolicy);
  const body = {
    operationId: randomUUID(),
    expectedVersion: initial.version,
    policy,
  };
  const save = () =>
    app.inject({ method: 'PUT', url: base, headers: headers(), payload: body });
  const reply = await save();
  expect(reply.statusCode).toBe(200);
  expect((await save()).json()).toEqual(reply.json());
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: base,
        headers: headers(),
        payload: { ...body, operationId: randomUUID() },
      })
    ).statusCode,
  ).toBe(409);
  expect((await get(otherCookie)).json().policy).toEqual(emptyAIRoutingPolicy);
  const exported = plannerExportSchema.parse(
    (
      await app.inject({ url: '/api/v1/planner/export', headers: headers() })
    ).json(),
  );
  expect(exported.records.aiRouting).toEqual(reply.json());
  const invalid = {
    ...body,
    operationId: randomUUID(),
    expectedVersion: reply.json().version,
    policy: {
      ...policy,
      personal: { allowed: ['private'], preferred: 'routine' },
    },
  };
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: base,
        headers: headers(),
        payload: invalid,
      })
    ).statusCode,
  ).toBe(400);
});
it('previews owned context labels and stale versions without network calls, text persistence or sensitivity inference', async () => {
  const network = vi.fn(() => {
    throw new Error('No provider call permitted.');
  });
  vi.stubGlobal('fetch', network);
  const task = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        title: 'Synthetic private task',
        sensitivity: 'personal',
      },
    })
  ).json().task;
  const settings = (await get()).json();
  const body = {
    expectedPolicyVersion: settings.version,
    text: 'Text stays local to preview, regardless of words like password.',
    sensitivity: 'unlabeled',
    sources: [{ kind: 'task', id: task.id, expectedVersion: task.version }],
    simulatedAvailableProviders: ['routine', 'private'],
  };
  const reply = await preview(body);
  expect(reply.statusCode).toBe(200);
  expect(aiRoutingPreviewResponseSchema.parse(reply.json())).toMatchObject({
    simulation: true,
    dispatchEnabled: false,
    status: 'selected',
    provider: 'private',
    labels: ['unlabeled', 'personal'],
    sources: [
      {
        kind: 'task',
        id: task.id,
        sensitivity: 'personal',
        attachmentDerived: false,
      },
    ],
  });
  expect(reply.body).not.toContain(body.text);
  expect(reply.body).not.toContain(task.title);
  expect((await preview({ ...body, sources: [] })).json()).toMatchObject({
    provider: 'routine',
    sensitivity: 'unlabeled',
  });
  expect(
    (
      await preview({ ...body, simulatedAvailableProviders: ['routine'] })
    ).json(),
  ).toMatchObject({
    status: 'blocked',
    provider: 'private',
    reason: 'PROVIDER_UNAVAILABLE',
  });
  expect(
    (await preview({ ...body, expectedPolicyVersion: 1 }, otherCookie))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await preview({
        ...body,
        sources: [
          { kind: 'task', id: task.id, expectedVersion: task.version + 1 },
        ],
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (await preview({ ...body, expectedPolicyVersion: settings.version + 1 }))
      .statusCode,
  ).toBe(409);
  for (const extra of [
    { attachments: [] },
    { screenshot: 'forbidden' },
    {
      sources: [
        {
          kind: 'task',
          id: task.id,
          expectedVersion: task.version,
          sensitivity: 'unlabeled',
        },
      ],
    },
  ])
    expect((await preview({ ...body, ...extra })).statusCode).toBe(400);
  expect(network).not.toHaveBeenCalled();
  const [receipts] = await db.query(
    'SELECT COUNT(*)::int AS count FROM mutation_receipts WHERE result::text LIKE $1',
    [`%${body.text}%`],
  );
  expect(receipts!.count).toBe(0);
});
it('blocks direct and planner-derived uploaded-file context and inherits archived class/topic labels', async () => {
  const feed =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:routing-file\r\nDTSTART:20270501T170000Z\r\nDTEND:20270501T170000Z\r\nSUMMARY:Synthetic file context\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  await app.inject({
    method: 'POST',
    url: '/api/v1/connections/canvas/import',
    headers: headers(),
    payload: { operationId: randomUUID(), feed },
  });
  const item = (
    await app.inject({ url: '/api/v1/connections/canvas', headers: headers() })
  ).json().items[0];
  const taskReply = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      title: 'File-derived task',
      canvasSourceRef: { itemId: item.id, expectedVersion: item.version },
    },
  });
  expect(taskReply.statusCode).toBe(200);
  const task = taskReply.json().task;
  const settings = (await get()).json();
  const body = {
    expectedPolicyVersion: settings.version,
    text: 'Synthetic preview',
    sensitivity: 'unlabeled',
    simulatedAvailableProviders: ['routine', 'private', 'vault'],
  };
  for (const source of [
    { kind: 'canvas-item', id: item.id, expectedVersion: item.version },
    { kind: 'task', id: task.id, expectedVersion: task.version },
  ])
    expect(
      (await preview({ ...body, sources: [source] })).json(),
    ).toMatchObject({
      status: 'blocked',
      reason: 'ATTACHMENT_DERIVED',
      provider: null,
    });
  const course = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        name: 'Archived routing class',
        sensitivity: 'restricted',
      },
    })
  ).json().course;
  const topic = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/topics',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        name: 'Routing topic',
        sensitivity: 'unlabeled',
      },
    })
  ).json().topic;
  await app.inject({
    method: 'DELETE',
    url: `/api/v1/courses/${course.id}`,
    headers: headers(),
    payload: { operationId: randomUUID(), expectedVersion: course.version },
  });
  expect(
    (
      await preview({
        ...body,
        sources: [
          { kind: 'topic', id: topic.id, expectedVersion: topic.version + 1 },
        ],
      })
    ).json(),
  ).toMatchObject({
    status: 'selected',
    provider: 'vault',
    sensitivity: 'restricted',
  });
});
it('requires a destination permitted by every inherited label, including event class/topic labels', async () => {
  const stored = (await get()).json();
  await app.inject({
    method: 'PUT',
    url: base,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: stored.version,
      policy: {
        ...policy,
        personal: { allowed: ['private'], preferred: 'private' },
      },
    },
  });
  const course = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        name: 'Mixed-label class',
        sensitivity: 'personal',
      },
    })
  ).json().course;
  const topic = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/topics',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        name: 'Mixed-label topic',
        sensitivity: 'restricted',
      },
    })
  ).json().topic;
  const event = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        topicId: topic.id,
        title: 'Mixed-label study',
        startsAt: '2027-05-01T10:00:00Z',
        endsAt: '2027-05-01T11:00:00Z',
        timeZone: 'UTC',
      },
    })
  ).json().event;
  const settings = (await get()).json();
  for (const source of [
    { kind: 'topic', id: topic.id, expectedVersion: topic.version },
    { kind: 'event', id: event.id, expectedVersion: event.version },
  ]) {
    const result = await preview({
      expectedPolicyVersion: settings.version,
      text: 'Synthetic mixed context',
      sensitivity: 'unlabeled',
      sources: [source],
      simulatedAvailableProviders: ['routine', 'private', 'vault'],
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      status: 'blocked',
      reason: 'NO_APPROVED_PROVIDER',
      labels: ['unlabeled', 'personal', 'restricted'],
      sources: [{ labels: ['personal', 'restricted'] }],
    });
  }
});
it('blocks historical source snapshots with incomplete label provenance rather than guessing their route', async () => {
  const feed =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:legacy-routing-network\r\nDTSTART:20270501T170000Z\r\nDTEND:20270501T170000Z\r\nSUMMARY:Legacy synthetic context\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const [setup] = await db.query(
    'SELECT owner_id FROM owner_setup WHERE singleton=1',
  );
  await db.transaction(async (tx) => {
    await tx.query(
      'SELECT owner_id FROM canvas_sources WHERE owner_id=$1 FOR UPDATE',
      [setup!.owner_id],
    );
    await applyCanvasSnapshot(
      tx,
      String(setup!.owner_id),
      parseCanvasFeed(feed),
      'calendar-feed',
    );
  });
  const item = (
    await app.inject({ url: '/api/v1/connections/canvas', headers: headers() })
  )
    .json()
    .items.find((row: { uid: string }) => row.uid === 'legacy-routing-network');
  const task = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        title: 'Legacy synthetic task',
        canvasSourceRef: { itemId: item.id, expectedVersion: item.version },
      },
    })
  ).json().task;
  await db.query(
    "UPDATE tasks SET canvas_source_snapshot=canvas_source_snapshot-'labels' WHERE owner_id=$1 AND id=$2",
    [setup!.owner_id, task.id],
  );
  const settings = (await get()).json();
  const blocked = await preview({
    expectedPolicyVersion: settings.version,
    text: 'Synthetic legacy preview',
    sensitivity: 'unlabeled',
    sources: [{ kind: 'task', id: task.id, expectedVersion: task.version }],
    simulatedAvailableProviders: ['routine', 'private', 'vault'],
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe('PROVENANCE_UNAVAILABLE');
});
it('retains every academic label through source relabeling and study detachment, and blocks unknown legacy history', async () => {
  const course = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: { operationId: randomUUID(), name: 'Historical routing class' },
    })
  ).json().course;
  const topic = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/topics',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        name: 'Historical routing topic',
        sensitivity: 'restricted',
      },
    })
  ).json().topic;
  const event = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        topicId: topic.id,
        title: 'Historical routing study',
        startsAt: '2027-05-01T10:00:00Z',
        endsAt: '2027-05-01T11:00:00Z',
        timeZone: 'UTC',
      },
    })
  ).json().event;
  expect(event.academicLabels).toEqual(['restricted']);
  for (const [expectedVersion, sensitivity] of [
    [1, 'personal'],
    [2, 'restricted'],
    [3, 'unlabeled'],
  ] as const) {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/courses/${course.id}`,
          headers: headers(),
          payload: {
            operationId: randomUUID(),
            expectedVersion,
            name: course.name,
            sensitivity,
          },
        })
      ).statusCode,
    ).toBe(200);
  }
  const latest = (
    await app.inject({ url: '/api/v1/calendar', headers: headers() })
  )
    .json()
    .events.find((row: { id: string }) => row.id === event.id);
  expect(latest.academicLabels).toEqual(['personal', 'restricted']);
  const detached = await app.inject({
    method: 'PUT',
    url: `/api/v1/calendar/${event.id}`,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: latest.version,
      title: latest.title,
      startsAt: latest.startsAt,
      endsAt: latest.endsAt,
      timeZone: 'UTC',
      courseId: null,
      topicId: null,
      sensitivity: 'unlabeled',
    },
  });
  expect(detached.statusCode).toBe(200);
  expect(detached.json().event.academicLabels).toEqual([
    'personal',
    'restricted',
  ]);
  const settings = (await get()).json();
  const body = {
    expectedPolicyVersion: settings.version,
    text: 'Synthetic retained academic labels',
    sensitivity: 'unlabeled',
    sources: [
      {
        kind: 'event',
        id: event.id,
        expectedVersion: detached.json().event.version,
      },
    ],
    simulatedAvailableProviders: ['routine', 'private', 'vault'],
  };
  expect((await preview(body)).json()).toMatchObject({
    status: 'blocked',
    reason: 'NO_APPROVED_PROVIDER',
    labels: ['unlabeled', 'personal', 'restricted'],
  });
  const currentTopic = (
    await app.inject({ url: '/api/v1/topics', headers: headers() })
  )
    .json()
    .topics.find((row: { id: string }) => row.id === topic.id);
  expect(currentTopic.academicLabels).toEqual(['personal', 'restricted']);
  expect(
    (
      await preview({
        ...body,
        sources: [
          {
            kind: 'topic',
            id: topic.id,
            expectedVersion: currentTopic.version,
          },
        ],
      })
    ).json(),
  ).toMatchObject({
    reason: 'NO_APPROVED_PROVIDER',
    labels: ['unlabeled', 'personal', 'restricted'],
  });
  await db.query('UPDATE events SET academic_labels=NULL WHERE id=$1', [
    event.id,
  ]);
  expect((await preview(body)).json().error.code).toBe(
    'PROVENANCE_UNAVAILABLE',
  );
  await db.query('UPDATE topics SET academic_labels=NULL WHERE id=$1', [
    topic.id,
  ]);
  expect(
    (
      await preview({
        ...body,
        sources: [
          {
            kind: 'topic',
            id: topic.id,
            expectedVersion: currentTopic.version,
          },
        ],
      })
    ).json().error.code,
  ).toBe('PROVENANCE_UNAVAILABLE');
});
it('captures occurrence academic labels on the series even after the occurrence is cancelled', async () => {
  const course = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        name: 'Occurrence routing class',
        sensitivity: 'personal',
      },
    })
  ).json().course;
  const series = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        title: 'Occurrence routing series',
        startsAt: '2027-05-01T10:00:00Z',
        endsAt: '2027-05-01T11:00:00Z',
        timeZone: 'UTC',
        recurrence: { frequency: 'daily', interval: 1, count: 2, until: null },
      },
    })
  ).json().event;
  expect(series.academicLabels).toEqual([]);
  const url = `/api/v1/calendar/${series.id}/occurrences/2027-05-02`;
  const edited = await app.inject({
    method: 'PUT',
    url,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: series.version,
      courseId: course.id,
      title: 'Owner labeled occurrence',
      startsAt: '2027-05-02T10:00:00Z',
      endsAt: '2027-05-02T11:00:00Z',
      timeZone: 'UTC',
    },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().event.academicLabels).toEqual(['personal']);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/v1/courses/${course.id}`,
        headers: headers(),
        payload: {
          operationId: randomUUID(),
          expectedVersion: course.version,
          name: course.name,
          sensitivity: 'restricted',
        },
      })
    ).statusCode,
  ).toBe(200);
  const refreshed = (
    await app.inject({ url: '/api/v1/calendar', headers: headers() })
  )
    .json()
    .events.find((row: { id: string }) => row.id === series.id);
  expect(refreshed.academicLabels).toEqual(['personal', 'restricted']);
  const cancelled = await app.inject({
    method: 'DELETE',
    url,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: refreshed.version,
    },
  });
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json().event.academicLabels).toEqual([
    'personal',
    'restricted',
  ]);
});
it('keeps an explicit personal label when a restricted academic parent supplies the strongest display label', async () => {
  const course = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        name: 'Masked-label class',
        sensitivity: 'restricted',
      },
    })
  ).json().course;
  const topic = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/topics',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        name: 'Masked-label topic',
        courseId: course.id,
        sensitivity: 'personal',
      },
    })
  ).json().topic;
  const study = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        title: 'Masked-label study',
        courseId: course.id,
        sensitivity: 'personal',
        startsAt: '2027-05-01T10:00:00Z',
        endsAt: '2027-05-01T11:00:00Z',
        timeZone: 'UTC',
      },
    })
  ).json().event;
  const settings = (await get()).json();
  for (const [kind, record] of [
    ['topic', topic],
    ['event', study],
  ] as const) {
    expect(record.sensitivity).toBe('restricted');
    expect(record.academicLabels).toEqual(['personal', 'restricted']);
    const reply = await preview({
      expectedPolicyVersion: settings.version,
      text: 'Synthetic masked-label context',
      sensitivity: 'unlabeled',
      sources: [{ kind, id: record.id, expectedVersion: record.version }],
      simulatedAvailableProviders: ['routine', 'private', 'vault'],
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      reason: 'NO_APPROVED_PROVIDER',
      labels: ['unlabeled', 'personal', 'restricted'],
    });
  }
});
it('propagates a newly masked topic label to a study before it is detached', async () => {
  const course = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/courses',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        name: 'Topic-edit routing class',
        sensitivity: 'restricted',
      },
    })
  ).json().course;
  const topic = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/topics',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        courseId: course.id,
        name: 'Topic-edit routing topic',
      },
    })
  ).json().topic;
  const event = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/calendar',
      headers: headers(),
      payload: {
        operationId: randomUUID(),
        title: 'Topic-edit routing study',
        courseId: course.id,
        topicId: topic.id,
        startsAt: '2027-05-01T10:00:00Z',
        endsAt: '2027-05-01T11:00:00Z',
        timeZone: 'UTC',
      },
    })
  ).json().event;
  expect(event.academicLabels).toEqual(['restricted']);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/v1/topics/${topic.id}`,
        headers: headers(),
        payload: {
          operationId: randomUUID(),
          expectedVersion: topic.version,
          courseId: course.id,
          name: topic.name,
          sensitivity: 'personal',
        },
      })
    ).statusCode,
  ).toBe(200);
  const latest = (
    await app.inject({ url: '/api/v1/calendar', headers: headers() })
  )
    .json()
    .events.find((row: { id: string }) => row.id === event.id);
  expect(latest.academicLabels).toEqual(['personal', 'restricted']);
  expect(latest.version).toBeGreaterThan(event.version);
  const detached = await app.inject({
    method: 'PUT',
    url: `/api/v1/calendar/${event.id}`,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: latest.version,
      title: latest.title,
      startsAt: latest.startsAt,
      endsAt: latest.endsAt,
      timeZone: 'UTC',
      sensitivity: 'unlabeled',
    },
  });
  expect(detached.statusCode).toBe(200);
  const settings = (await get()).json();
  expect(
    (
      await preview({
        expectedPolicyVersion: settings.version,
        text: 'Synthetic detached topic context',
        sensitivity: 'unlabeled',
        sources: [
          {
            kind: 'event',
            id: event.id,
            expectedVersion: detached.json().event.version,
          },
        ],
        simulatedAvailableProviders: ['routine', 'private', 'vault'],
      })
    ).json(),
  ).toMatchObject({
    reason: 'NO_APPROVED_PROVIDER',
    labels: ['unlabeled', 'personal', 'restricted'],
  });
});
