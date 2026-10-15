import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  aiActionSettingsSchema,
  aiActionPreviewResponseSchema,
  defaultAIActionPolicy,
  plannerExportSchema,
} from '@hub/contracts';
import type { AIActionPolicy } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';

const base = '/api/v1/ai/actions';
const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, other: string, otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = (url = base, session = cookie) =>
  app.inject({ url, headers: headers(session) });
const save = (payload: object, session = cookie) =>
  app.inject({ method: 'PUT', url: base, headers: headers(session), payload });
const preview = (action: object, expectedPolicyVersion = 1, session = cookie) =>
  app.inject({
    method: 'POST',
    url: `${base}/preview`,
    headers: headers(session),
    payload: { action, expectedPolicyVersion },
  });
const change = (policy: AIActionPolicy, expectedVersion = 1) => ({
  policy,
  expectedVersion,
  operationId: randomUUID(),
});
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in synthetic action policy tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'actions@example.test',
      password: 'synthetic-action-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-actions@example.test',
    'unused',
  ]);
  await db.query(
    'INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,$3)',
    [
      createHash('sha256').update(token).digest('hex'),
      other,
      new Date(Date.now() + 3600000),
    ],
  );
  otherCookie = `hub_session=${token}`;
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  await app?.close();
});
it('exposes confirmed calendar authority with ask-first task defaults without enabling or persisting execution', async () => {
  expect(aiActionSettingsSchema.parse((await get()).json())).toEqual({
    version: 1,
    policy: {
      tasks: 'approval-required',
      calendar: 'automatic',
      email: 'approval-required',
    },
  });
  const receipts = await db.query('SELECT * FROM mutation_receipts');
  for (const operation of ['create', 'update', 'delete', 'restore']) {
    const task = await preview({
      kind: `task.${operation}`,
      connection: 'hub',
    });
    expect(task.statusCode).toBe(200);
    expect(aiActionPreviewResponseSchema.parse(task.json())).toMatchObject({
      policyDecision: 'approval-required',
      writeCapability: 'local',
      executionEnabled: false,
      blockers: ['OWNER_APPROVAL_REQUIRED', 'ACTION_EXECUTION_UNAVAILABLE'],
      emailApprovalRequired: false,
    });
    const calendar = await preview({
      kind: `calendar.${operation}`,
      connection: 'hub',
    });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toMatchObject({
      policyDecision: 'automatic',
      writeCapability: 'local',
      executionEnabled: false,
      action: { outboundEmail: 'none' },
      blockers: ['ACTION_EXECUTION_UNAVAILABLE'],
    });
  }
  expect(await db.query('SELECT * FROM ai_action_policies')).toHaveLength(0);
  expect(await db.query('SELECT * FROM mutation_receipts')).toEqual(receipts);
  expect(await db.query('SELECT id FROM tasks')).toHaveLength(0);
  expect(await db.query('SELECT id FROM events')).toHaveLength(0);
  expect(await db.query('SELECT id FROM ai_requests')).toHaveLength(0);
});
it('requires email approval for sends and every invitation, attendee update or cancellation regardless of calendar authority', async () => {
  for (const connection of ['proton-mail', 'outlook-mail']) {
    const response = await preview({ kind: 'email.send', connection });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      policyDecision: 'approval-required',
      emailApprovalRequired: true,
      writeCapability: 'unverified',
      executionEnabled: false,
      blockers: [
        'EMAIL_APPROVAL_REQUIRED',
        'WRITE_CAPABILITY_UNVERIFIED',
        'ACTION_EXECUTION_UNAVAILABLE',
      ],
    });
  }
  for (const connection of [
    'hub',
    'canvas',
    'proton-calendar',
    'outlook-calendar',
  ]) {
    for (const outboundEmail of [
      'invitation',
      'attendee-update',
      'cancellation',
    ]) {
      const response = await preview({
        kind: 'calendar.update',
        connection,
        outboundEmail,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().policyDecision).toBe('automatic');
      expect(response.json().emailApprovalRequired).toBe(true);
      expect(response.json().blockers).toContain('EMAIL_APPROVAL_REQUIRED');
      if (connection === 'hub')
        expect(response.json().blockers).toContain(
          'OUTBOUND_EMAIL_UNSUPPORTED',
        );
      if (connection === 'canvas')
        expect(response.json().blockers).toContain('READ_ONLY_TARGET');
      if (connection.includes('-calendar'))
        expect(response.json().blockers).toContain(
          'WRITE_CAPABILITY_UNVERIFIED',
        );
    }
  }
});
it('keeps read-only and unverified targets blocked even when all category permissions are automatic', async () => {
  const policy: AIActionPolicy = {
    tasks: 'automatic',
    calendar: 'automatic',
    email: 'approval-required',
  };
  expect((await save(change(policy))).statusCode).toBe(200);
  for (const connection of ['canvas', 'proton-calendar', 'outlook-calendar']) {
    const response = await preview({ kind: 'calendar.create', connection }, 2);
    expect(response.statusCode).toBe(200);
    expect(response.json().executionEnabled).toBe(false);
    expect(response.json().blockers).toContain(
      connection === 'canvas'
        ? 'READ_ONLY_TARGET'
        : 'WRITE_CAPABILITY_UNVERIFIED',
    );
  }
  const task = await preview({ kind: 'task.delete', connection: 'hub' }, 2);
  expect(task.json().policyDecision).toBe('automatic');
  expect(task.json().blockers).toEqual(['ACTION_EXECUTION_UNAVAILABLE']);
  const settings = await save(
    change({ ...policy, calendar: 'approval-required', tasks: 'blocked' }, 2),
  );
  expect(settings.statusCode).toBe(200);
  expect(
    (await preview({ kind: 'calendar.delete', connection: 'hub' }, 3)).json()
      .blockers,
  ).toEqual(['OWNER_APPROVAL_REQUIRED', 'ACTION_EXECUTION_UNAVAILABLE']);
});
it('rejects unsupported actions, client capability claims, content and attempts to relax mandatory email approval', async () => {
  for (const policy of [
    { ...defaultAIActionPolicy, email: 'automatic' },
    { ...defaultAIActionPolicy, email: 'blocked' },
    { ...defaultAIActionPolicy, tasks: 'allowed' },
    { ...defaultAIActionPolicy, calendar: null },
    { ...defaultAIActionPolicy, capabilities: ['email.send'] },
    { tasks: 'automatic', calendar: 'automatic' },
  ])
    expect(
      (await save({ ...change(defaultAIActionPolicy), policy })).statusCode,
    ).toBe(400);
  for (const action of [
    { kind: 'email.send', connection: 'hub' },
    { kind: 'task.update', connection: 'canvas' },
    { kind: 'calendar.invite', connection: 'hub' },
    { kind: 'calendar.update', connection: 'hub', outboundEmail: true },
    { kind: 'calendar.update', connection: 'proton-calendar', writable: true },
    { kind: 'email.send', connection: 'proton-mail', approved: true },
    { kind: 'task.create', connection: 'hub', title: 'Unapproved content' },
    { kind: 'task.create', connection: 'hub', screenshot: 'synthetic' },
  ])
    expect((await preview(action)).statusCode).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/preview`,
        headers: headers(),
        payload: {
          expectedPolicyVersion: 1,
          action: { kind: 'task.create', connection: 'hub' },
          provider: 'client-chosen',
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(await db.query('SELECT * FROM ai_action_policies')).toHaveLength(0);
});
it('deduplicates settings writes, rejects stale/changed operations and retains historical retry results', async () => {
  const payload = change({ ...defaultAIActionPolicy, tasks: 'automatic' });
  const [first, duplicate] = await Promise.all([save(payload), save(payload)]);
  expect(first.statusCode).toBe(200);
  expect(duplicate.json()).toEqual(first.json());
  expect(first.json()).toEqual({ version: 2, policy: payload.policy });
  expect((await save(change(defaultAIActionPolicy))).json().error.code).toBe(
    'VERSION_CONFLICT',
  );
  expect(
    (await save({ ...payload, policy: defaultAIActionPolicy })).json().error
      .code,
  ).toBe('OPERATION_CONFLICT');
  expect(
    (await save(change({ ...defaultAIActionPolicy, calendar: 'blocked' }, 2)))
      .statusCode,
  ).toBe(200);
  expect((await save(payload)).json()).toEqual(first.json());
  expect((await get()).json().version).toBe(3);
  expect(
    (await preview({ kind: 'calendar.create', connection: 'hub' }, 2)).json()
      .error.code,
  ).toBe('VERSION_CONFLICT');
  const current = await preview(
    { kind: 'calendar.create', connection: 'hub' },
    3,
  );
  expect(current.json().blockers).toContain('POLICY_BLOCKED');
});
it('serializes competing policy writes without affecting manual planner permissions', async () => {
  const payloads = [
    change({ ...defaultAIActionPolicy, tasks: 'automatic' }),
    change({ ...defaultAIActionPolicy, calendar: 'blocked' }),
  ];
  const responses = await Promise.all(payloads.map((payload) => save(payload)));
  expect(responses.map((response) => response.statusCode).sort()).toEqual([
    200, 409,
  ]);
  expect((await get()).json()).toEqual(
    responses.find((response) => response.statusCode === 200)!.json(),
  );
  expect(
    await db.query(
      'SELECT * FROM mutation_receipts WHERE owner_id=$1 AND operation_id=ANY($2::uuid[])',
      [owner, payloads.map((p) => p.operationId)],
    ),
  ).toHaveLength(1);
  const setting = (await get()).json();
  expect(
    (
      await save(
        change(
          { tasks: 'blocked', calendar: 'blocked', email: 'approval-required' },
          setting.version,
        ),
      )
    ).statusCode,
  ).toBe(200);
  const manualTask = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload: {
      title: 'Manual edit remains available',
      operationId: randomUUID(),
    },
  });
  expect(manualTask.statusCode).toBe(200);
  const manualCalendar = await app.inject({
    method: 'POST',
    url: '/api/v1/calendar',
    headers: headers(),
    payload: {
      title: 'Manual calendar remains available',
      startsAt: '2030-04-04T09:00:00Z',
      endsAt: '2030-04-04T10:00:00Z',
      timeZone: 'UTC',
      operationId: randomUUID(),
    },
  });
  expect(manualCalendar.statusCode).toBe(200);
});
it('isolates owner settings and receipts, protects preview sessions and exports compatible policy records', async () => {
  const payload = change({ ...defaultAIActionPolicy, tasks: 'automatic' });
  expect((await save(payload)).statusCode).toBe(200);
  expect((await get(base, otherCookie)).json()).toEqual({
    version: 1,
    policy: defaultAIActionPolicy,
  });
  const otherPayload = {
    ...payload,
    policy: { ...defaultAIActionPolicy, calendar: 'blocked' },
  };
  expect((await save(otherPayload, otherCookie)).statusCode).toBe(200);
  expect((await get()).json().policy.tasks).toBe('automatic');
  expect(
    (
      await preview(
        { kind: 'calendar.create', connection: 'hub' },
        2,
        otherCookie,
      )
    ).json().policyDecision,
  ).toBe('blocked');
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.aiActions).toEqual({
    version: 2,
    policy: payload.policy,
  });
  const oldExport = structuredClone(exported) as {
    records: { aiActions?: unknown };
  };
  delete oldExport.records.aiActions;
  expect(plannerExportSchema.parse(oldExport).records.aiActions).toBeNull();
  for (const options of [
    { url: base },
    { method: 'PUT' as const, url: base, headers: { origin }, payload },
    {
      method: 'POST' as const,
      url: `${base}/preview`,
      headers: { origin },
      payload: {
        expectedPolicyVersion: 1,
        action: { kind: 'task.create', connection: 'hub' },
      },
    },
  ])
    expect((await app.inject(options)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: base,
        headers: { origin: 'https://foreign.example.test', cookie },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await get()).statusCode).toBe(401);
  expect((await save(payload)).statusCode).toBe(401);
  expect(
    (await preview({ kind: 'task.create', connection: 'hub' }, 2)).statusCode,
  ).toBe(401);
});
it('applies the additive migration to populated storage and enforces policy shape and email approval in SQL', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: headers(),
    payload: {
      title: 'Populated upgrade task',
      notes: 'Preserved owner text',
      operationId: randomUUID(),
    },
  });
  const task = created.json().task;
  const receipts = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  await db.exec('DROP TABLE ai_action_policies');
  await db.query(
    "DELETE FROM schema_migrations WHERE name='030_ai_action_policies.sql'",
  );
  await migrate(db);
  expect((await get(`/api/v1/tasks/${task.id}`)).json().task).toEqual(task);
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(receipts);
  expect((await get()).json()).toEqual({
    version: 1,
    policy: defaultAIActionPolicy,
  });
  for (const policy of [
    { ...defaultAIActionPolicy, email: 'automatic' },
    { ...defaultAIActionPolicy, tasks: null },
    { ...defaultAIActionPolicy, calendar: 1 },
    { ...defaultAIActionPolicy, extra: true },
    {},
    [],
  ])
    await expect(
      db.query(
        'INSERT INTO ai_action_policies(owner_id,policy) VALUES($1,$2::jsonb)',
        [owner, JSON.stringify(policy)],
      ),
    ).rejects.toThrow();
  expect((await save(change(defaultAIActionPolicy))).statusCode).toBe(200);
});
it('retains policy versions and exact receipts after persisted restart without dispatching actions', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'ai-actions-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    reopened = await buildApp({ logger: false }, { config: persistent });
    const setup = await reopened.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-actions@example.test',
        password: 'synthetic-persisted-actions',
      },
    });
    expect(setup.statusCode).toBe(201);
    const h = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const payload = change({ ...defaultAIActionPolicy, calendar: 'blocked' });
    const result = await reopened.inject({
      method: 'PUT',
      url: base,
      headers: h,
      payload,
    });
    expect(result.statusCode).toBe(200);
    await reopened.close();
    reopened = undefined;
    reopened = await buildApp({ logger: false }, { config: persistent });
    expect((await reopened.inject({ url: base, headers: h })).json()).toEqual(
      result.json(),
    );
    expect(
      (
        await reopened.inject({ method: 'PUT', url: base, headers: h, payload })
      ).json(),
    ).toEqual(result.json());
    const response = await reopened.inject({
      method: 'POST',
      url: `${base}/preview`,
      headers: h,
      payload: {
        expectedPolicyVersion: 2,
        action: { kind: 'calendar.delete', connection: 'hub' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      policyDecision: 'blocked',
      executionEnabled: false,
    });
  } finally {
    await reopened?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
