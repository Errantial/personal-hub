import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { outlookBrowserConnectionSchema } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const base = '/api/v1/connections/outlook/browser';
const collectorBase = '/api/v1/outlook/browser/collector';

let app: Awaited<ReturnType<typeof buildApp>>;
let database: Awaited<ReturnType<typeof openDatabase>>;
let cookie: string;
let ownerId: string;
let otherCookie: string;

const owner = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'GET' | 'PUT' | 'POST',
    url,
    headers: { origin, cookie },
    ...(payload ? { payload } : {}),
  });

const collector = (
  token: string,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `${collectorBase}/${path}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

const get = async () =>
  outlookBrowserConnectionSchema.parse((await owner('GET', base)).json());

const issueToken = async () => {
  const state = await get();
  const response = await owner('POST', `${base}/token`, {
    operationId: randomUUID(),
    expectedVersion: state.version,
  });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
};

const folder = (providerId = 'inbox', name = 'Inbox') => ({
  providerId,
  name,
  canonicalUrl: `https://outlook.office.com/mail/${providerId}`,
});

const message = (
  providerId = 'syntheticMessage0001',
  overrides: Record<string, unknown> = {},
) => ({
  providerId,
  conversationId: `syntheticConversation${providerId.slice(-4)}`,
  canonicalUrl: `https://outlook.office.com/mail/inbox/id/${providerId}`,
  subject: 'Synthetic subject',
  senderDisplay: 'Synthetic Advisor',
  senderAddress: 'advisor@example.test',
  receivedAt: '2026-11-01T15:30:00.000Z',
  snippet: 'Synthetic preview',
  bodyText: 'Synthetic body text.',
  ...overrides,
});

async function begin(token: string) {
  const state = (await collector(token, 'GET', 'state')).json();
  const attemptId = randomUUID();
  const response = await collector(token, 'POST', 'attempt', {
    attemptId,
    expectedSourceVersion: state.sourceVersion,
  });
  expect(response.statusCode).toBe(200);
  return attemptId;
}

async function discover(
  token: string,
  attemptId: string,
  status: 'complete' | 'partial' = 'complete',
  folders = [folder()],
) {
  return collector(token, 'POST', 'discovery', {
    attemptId,
    status,
    capturedAt: '2026-11-13T18:00:00.000Z',
    folders,
  });
}

async function selectFolder(providerId = 'inbox') {
  const state = await get();
  const selected = state.folders.find(
    (value) => value.providerId === providerId,
  );
  if (!selected) throw new Error('folder not discovered');
  const response = await owner('PUT', `${base}/folders/${selected.id}`, {
    operationId: randomUUID(),
    expectedVersion: selected.version,
    selected: true,
    notes: '',
    sensitivity: 'unlabeled',
  });
  expect(response.statusCode).toBe(200);
  return response.json().folder;
}

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden.');
    }),
  );
  database = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'outlook-browser@example.test',
      password: 'synthetic-password-only',
    },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  ownerId = setup.json().user.id;
  const other = randomUUID();
  await database.query(
    'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
    [other, 'other-outlook-browser@example.test', 'unused'],
  );
  const session = randomBytes(32).toString('hex');
  await database.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(session).digest('hex'), other],
  );
  otherCookie = `hub_session=${session}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

it('issues a one-time hash-only collector token, isolates it from browser sessions and revokes it', async () => {
  let state = await get();
  expect(state).toMatchObject({
    configured: false,
    healthStatus: 'never-synced',
    folders: [],
    messages: [],
    messagesTruncated: false,
  });
  const operationId = randomUUID();
  const issued = await owner('POST', `${base}/token`, {
    operationId,
    expectedVersion: state.version,
  });
  expect(issued.statusCode).toBe(200);
  const { token } = issued.json();
  expect(token).toMatch(/^hubob_/);
  const [stored] = await database.query(
    'SELECT token_hash FROM outlook_browser_sources WHERE owner_id=$1',
    [ownerId],
  );
  expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(
    JSON.stringify(
      await database.query('SELECT result FROM mutation_receipts'),
    ),
  ).not.toContain(token);
  expect(
    (
      await owner('POST', `${base}/token`, {
        operationId,
        expectedVersion: state.version,
      })
    ).statusCode,
  ).toBe(409);
  expect((await collector(token, 'GET', 'state')).statusCode).toBe(200);
  expect((await owner('GET', `${collectorBase}/state`)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: base,
        headers: { origin, cookie: otherCookie },
      })
    ).json(),
  ).toMatchObject({ configured: false, folders: [], messages: [] });
  expect(
    (
      await app.inject({
        url: base,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(401);

  state = await get();
  const revoked = await owner('POST', `${base}/revoke`, {
    operationId: randomUUID(),
    expectedVersion: state.version,
  });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json().healthStatus).toBe('revoked');
  expect((await collector(token, 'GET', 'state')).statusCode).toBe(401);
});

it('discovers folders, requires explicit selection and preserves owner labels', async () => {
  const token = await issueToken();
  let state = await get();
  state = outlookBrowserConnectionSchema.parse(
    (
      await owner('PUT', base, {
        operationId: randomUUID(),
        expectedVersion: state.version,
        sensitivity: 'restricted',
      })
    ).json(),
  );
  expect(state.sensitivity).toBe('restricted');

  const attemptId = await begin(token);
  const discovery = await discover(token, attemptId, 'complete', [
    folder('inbox', 'Inbox'),
    folder('sentitems', 'Sent Items'),
  ]);
  expect(discovery.statusCode).toBe(200);
  expect(discovery.json()).toEqual({ added: 2, updated: 0, missing: 0 });
  expect(
    (
      await discover(token, attemptId, 'complete', [
        folder('inbox', 'Inbox'),
        folder('sentitems', 'Sent Items'),
      ])
    ).json(),
  ).toEqual(discovery.json());
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.folders).toHaveLength(2);
  expect(state.folders.every((value) => !value.selected)).toBe(true);
  expect(
    state.folders.every((value) => value.effectiveSensitivity === 'restricted'),
  ).toBe(true);

  const beforeSelection = state.version;
  const selected = await selectFolder('inbox');
  expect(selected).toMatchObject({
    selected: true,
    effectiveSensitivity: 'restricted',
  });
  state = await get();
  expect(state.version).toBe(beforeSelection + 1);
  expect(state.healthStatus).toBe('partial');

  const other = (
    await app.inject({
      url: base,
      headers: { origin, cookie: otherCookie },
    })
  ).json();
  expect(other.folders).toEqual([]);

  expect(
    (
      await owner('PUT', `${base}/folders/${selected.id}`, {
        operationId: randomUUID(),
        expectedVersion: selected.version,
        selected: false,
        notes: '',
        sensitivity: 'unlabeled',
      })
    ).statusCode,
  ).toBe(200);
});

it('reconciles only complete folder observations, keeps captures append-only and never prunes on partial data', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  const selected = await selectFolder();

  attemptId = await begin(token);
  await discover(token, attemptId);
  const capturedAt = '2026-11-13T18:10:00.000Z';
  const payload = {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt,
    messages: [
      message('syntheticMessage0001'),
      message('syntheticMessage0002', {
        conversationId: 'syntheticConversation0002',
        subject: 'Synthetic second message',
        snippet: 'Second synthetic preview',
        bodyText: 'Second synthetic body.',
      }),
    ],
  };
  const observed = await collector(token, 'POST', 'folder', payload);
  expect(observed.statusCode).toBe(200);
  expect(observed.json()).toEqual({ added: 2, updated: 0, missing: 0 });
  expect((await collector(token, 'POST', 'folder', payload)).json()).toEqual(
    observed.json(),
  );
  expect(
    (
      await collector(token, 'POST', 'folder', {
        ...payload,
        messages: [
          message('syntheticMessage0001', { subject: 'Changed retry' }),
        ],
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);

  let state = await get();
  expect(state.healthStatus).toBe('current');
  expect(state.messages).toHaveLength(2);
  const firstMessage = state.messages.find(
    (value) => value.providerId === 'syntheticMessage0001',
  )!;
  const detail = await owner('GET', `${base}/messages/${firstMessage.id}`);
  expect(detail.statusCode).toBe(200);
  expect(detail.json().message.bodyText).toBe('Synthetic body text.');
  expect(detail.json().captures).toHaveLength(1);
  expect(detail.json().captures[0].effectiveSensitivity).toBe('unlabeled');
  expect(JSON.stringify(detail.json())).not.toContain('token_hash');

  const finishedAttempt = attemptId;
  const retryFinished = await collector(token, 'POST', 'attempt', {
    attemptId: finishedAttempt,
    expectedSourceVersion: state.version,
  });
  expect(retryFinished.statusCode).toBe(409);
  expect(retryFinished.json().error.code).toBe('ATTEMPT_CHANGED');

  attemptId = await begin(token);
  await discover(token, attemptId);
  const emptyComplete = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:15:00.000Z',
    messages: [],
  });
  expect(emptyComplete.statusCode).toBe(400);
  state = await get();
  expect(
    state.messages.every((value) => value.availability === 'available'),
  ).toBe(true);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });

  attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'partial',
    capturedAt: '2026-11-13T18:20:00.000Z',
    messages: [
      message('syntheticMessage0001', {
        subject: 'Changed title',
        bodyText: 'Changed synthetic body.',
      }),
    ],
  });
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: 'traversal-failed',
  });
  state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.messages).toHaveLength(2);
  expect(
    state.messages.find((value) => value.providerId === 'syntheticMessage0002')
      ?.availability,
  ).toBe('available');
  expect(
    state.messages.find((value) => value.providerId === 'syntheticMessage0001'),
  ).toMatchObject({ subject: 'Changed title' });

  attemptId = await begin(token);
  await discover(token, attemptId);
  const complete = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:30:00.000Z',
    messages: [message('syntheticMessage0001', { subject: 'Changed title' })],
  });
  expect(complete.json().missing).toBe(1);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'complete',
    errorCode: null,
  });
  state = await get();
  expect(
    state.messages.find((value) => value.providerId === 'syntheticMessage0002')
      ?.availability,
  ).toBe('missing');
  const captures = await database.query<{
    snapshot: { subject: string };
  }>(
    `SELECT snapshot FROM outlook_browser_message_captures
     WHERE owner_id=$1 ORDER BY captured_at,id`,
    [ownerId],
  );
  expect(captures).toHaveLength(4);
  expect(captures.map((value) => value.snapshot.subject).sort()).toEqual(
    [
      'Synthetic subject',
      'Synthetic second message',
      'Changed title',
      'Changed title',
    ].sort(),
  );
  await expect(
    database.query(
      'UPDATE outlook_browser_message_captures SET snapshot=$2::jsonb WHERE owner_id=$1',
      [ownerId, JSON.stringify({})],
    ),
  ).rejects.toThrow();

  state = outlookBrowserConnectionSchema.parse(
    (
      await owner('PUT', base, {
        operationId: randomUUID(),
        expectedVersion: state.version,
        sensitivity: 'restricted',
      })
    ).json(),
  );
  const exported = (await owner('GET', '/api/v1/planner/export')).json();
  expect(exported.records.outlookBrowserSource).toEqual({
    sensitivity: 'restricted',
    version: state.version,
  });
  expect(exported.records.outlookBrowserFolders).toHaveLength(1);
  expect(exported.records.outlookBrowserMessages).toHaveLength(2);
  expect(exported.records.outlookBrowserMessageCaptures).toHaveLength(4);
  expect(
    exported.records.outlookBrowserMessages.find(
      (value: { providerId: string }) =>
        value.providerId === 'syntheticMessage0001',
    ).bodyText,
  ).toBe('Synthetic body text.');
  expect(
    exported.records.outlookBrowserMessageCaptures.every(
      (value: { effectiveSensitivity: string }) =>
        value.effectiveSensitivity === 'restricted',
    ),
  ).toBe(true);
  expect(
    exported.records.outlookBrowserFolders.every(
      (value: { effectiveSensitivity: string }) =>
        value.effectiveSensitivity === 'restricted',
    ),
  ).toBe(true);
  expect(JSON.stringify(exported)).not.toContain(token);
  expect(JSON.stringify(exported.records)).not.toContain('activeAttemptId');
  expect(JSON.stringify(exported.records)).not.toContain('discoveryHash');
});

it('exports read-time sensitivity for captures outside the 200-message summary window', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  const selected = await selectFolder();
  attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:00:00.000Z',
    messages: [
      message('syntheticOldMessage0001', {
        subject: 'Old synthetic message',
        receivedAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
  });
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);
  const original = (await get()).messages.find(
    (value) => value.providerId === 'syntheticOldMessage0001',
  )!;
  for (let index = 1; index <= 200; index++) {
    const suffix = String(index).padStart(4, '0');
    await database.query(
      `INSERT INTO outlook_browser_messages(id,owner_id,browser_folder_id,provider_id,canonical_url,subject,sender_display,sender_address,received_at,snippet,body_text,captured_at,availability,sensitivity)
       VALUES($1,$2,$3,$4,$5,$6,'Synthetic Advisor','advisor@example.test','2026-11-13T12:00:00Z','Bulk preview','Bulk synthetic body','2026-11-13T12:00:00Z','available','unlabeled')`,
      [
        randomUUID(),
        ownerId,
        selected.id,
        `syntheticBulk${suffix}`,
        `https://outlook.office.com/mail/inbox/id/syntheticBulk${suffix}`,
        `Bulk synthetic ${suffix}`,
      ],
    );
  }
  const state = await get();
  const folder = state.folders.find((value) => value.id === selected.id)!;
  expect(
    (
      await owner('PUT', `${base}/folders/${folder.id}`, {
        operationId: randomUUID(),
        expectedVersion: folder.version,
        selected: true,
        notes: '',
        sensitivity: 'restricted',
      })
    ).statusCode,
  ).toBe(200);
  const exported = (await owner('GET', '/api/v1/planner/export')).json();
  expect(exported.records.outlookBrowserMessages).toHaveLength(201);
  const capture = exported.records.outlookBrowserMessageCaptures.find(
    (value: { browserMessageId: string }) =>
      value.browserMessageId === original.id,
  );
  expect(capture).toMatchObject({ effectiveSensitivity: 'restricted' });
  expect(
    exported.records.outlookBrowserMessages.every(
      (value: { effectiveSensitivity: string }) =>
        value.effectiveSensitivity === 'restricted',
    ),
  ).toBe(true);
});

it('invalidates complete coverage when selected folders change and requires every folder', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  await discover(token, attemptId, 'complete', [
    folder('inbox', 'Inbox'),
    folder('sentitems', 'Sent Items'),
  ]);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  const first = await selectFolder('inbox');
  const second = await selectFolder('sentitems');

  attemptId = await begin(token);
  await discover(token, attemptId, 'complete', [
    folder('inbox', 'Inbox'),
    folder('sentitems', 'Sent Items'),
  ]);
  await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: first.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:40:00.000Z',
    messages: [message('syntheticMessage0001')],
  });
  const incomplete = await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'complete',
    errorCode: null,
  });
  expect(incomplete.statusCode).toBe(409);
  expect(incomplete.json().error.code).toBe('COVERAGE_INCOMPLETE');
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  let state = await get();
  expect(state.healthStatus).toBe('partial');

  attemptId = await begin(token);
  await discover(token, attemptId, 'complete', [
    folder('inbox', 'Inbox'),
    folder('sentitems', 'Sent Items'),
  ]);
  for (const selected of [first, second])
    await collector(token, 'POST', 'folder', {
      attemptId,
      folderId: selected.id,
      status: 'complete',
      capturedAt: '2026-11-13T18:50:00.000Z',
      messages: [
        message(
          `syntheticMessage000${selected.providerId === 'inbox' ? '1' : '2'}`,
          {
            canonicalUrl: `https://outlook.office.com/mail/${selected.providerId}/id/syntheticMessage000${
              selected.providerId === 'inbox' ? '1' : '2'
            }`,
          },
        ),
      ],
    });
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);
  state = await get();
  expect(state.healthStatus).toBe('current');

  const removed = await owner('PUT', `${base}/folders/${second.id}`, {
    operationId: randomUUID(),
    expectedVersion: second.version,
    selected: false,
    notes: '',
    sensitivity: 'unlabeled',
  });
  expect(removed.statusCode).toBe(200);
  state = await get();
  expect(state.healthStatus).toBe('partial');
  expect(state.lastCompleteAt).not.toBeNull();
});

it('rejects foreign/mismatched identities, unselected folder uploads and other-owner detail', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  const foreign = await discover(token, attemptId, 'complete', [
    {
      providerId: 'inbox',
      name: 'Inbox',
      canonicalUrl: 'https://evil.example/mail/inbox',
    },
  ]);
  expect(foreign.statusCode).toBe(400);
  expect(foreign.json().error.code).toBe('INVALID_INPUT');

  const mismatch = await discover(token, attemptId, 'complete', [
    {
      providerId: 'inbox',
      name: 'Inbox',
      canonicalUrl: 'https://outlook.office.com/mail/other',
    },
  ]);
  expect(mismatch.statusCode).toBe(400);

  expect(
    (
      await discover(token, attemptId, 'complete', [
        folder('inbox', 'Inbox'),
        folder('sentitems', 'Sent Items'),
      ])
    ).statusCode,
  ).toBe(200);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'partial',
    errorCode: null,
  });
  const selected = await selectFolder();
  const unselectedFolder = (await get()).folders.find(
    (value) => value.providerId === 'sentitems',
  )!;
  attemptId = await begin(token);
  await discover(token, attemptId, 'complete', [
    folder('inbox', 'Inbox'),
    folder('sentitems', 'Sent Items'),
  ]);
  const unselectedObservation = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: unselectedFolder.id,
    status: 'partial',
    capturedAt: '2026-11-13T18:00:00.000Z',
    messages: [],
  });
  expect(unselectedObservation.statusCode).toBe(409);
  expect(unselectedObservation.json().error.code).toBe('FOLDER_CHANGED');
  const wrongProvider = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:00:00.000Z',
    messages: [
      message('syntheticMessage0001', {
        canonicalUrl:
          'https://outlook.office.com/mail/inbox/id/syntheticMessage9999',
      }),
    ],
  });
  expect(wrongProvider.statusCode).toBe(400);
  const wrongFolder = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:00:00.000Z',
    messages: [
      message('syntheticMessage0001', {
        canonicalUrl:
          'https://outlook.office.com/mail/sentitems/id/syntheticMessage0001',
      }),
    ],
  });
  expect(wrongFolder.statusCode).toBe(400);
  const oversized = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:00:00.000Z',
    messages: [
      message('syntheticMessage0001', { bodyText: 'x'.repeat(20001) }),
    ],
  });
  expect(oversized.statusCode).toBe(400);
  expect(
    (
      await collector(token, 'POST', 'folder', {
        attemptId,
        folderId: selected.id,
        status: 'complete',
        capturedAt: '2026-11-13T18:00:00.000Z',
        messages: [
          message('syntheticMessage0001', { senderAddress: 'not-mail' }),
        ],
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await collector(token, 'POST', 'folder', {
        attemptId,
        folderId: selected.id,
        status: 'inaccessible',
        capturedAt: '2026-11-13T18:00:00.000Z',
        messages: [message('syntheticMessage0001')],
      })
    ).statusCode,
  ).toBe(400);
  const observed = await collector(token, 'POST', 'folder', {
    attemptId,
    folderId: selected.id,
    status: 'complete',
    capturedAt: '2026-11-13T18:05:00.000Z',
    messages: [message('syntheticMessage0001')],
  });
  expect(observed.statusCode).toBe(200);
  const state = await get();
  const retained = state.messages.find(
    (value) => value.providerId === 'syntheticMessage0001',
  )!;
  expect(
    (
      await app.inject({
        url: `${base}/messages/${retained.id}`,
        headers: { origin, cookie: otherCookie },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await owner('GET', `${base}/messages/${retained.id}`)).statusCode,
  ).toBe(200);
  expect(
    (
      await collector(token, 'POST', 'attempt/finish', {
        attemptId,
        outcome: 'complete',
        errorCode: null,
      })
    ).statusCode,
  ).toBe(200);
  expect(state.folders).toHaveLength(2);
});

it('surfaces sign-in and MFA failures without pruning and leases active attempts by recent progress', async () => {
  const token = await issueToken();
  let attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'failed',
    errorCode: 'sign-in-required',
  });
  let state = await get();
  expect(state).toMatchObject({
    healthStatus: 'sign-in-required',
    lastAttemptOutcome: 'failed',
    lastErrorCode: 'sign-in-required',
  });
  expect(state.folders[0]?.lastCompleteAt).toBeNull();

  const selected = await selectFolder();
  attemptId = await begin(token);
  await discover(token, attemptId);
  await collector(token, 'POST', 'attempt/finish', {
    attemptId,
    outcome: 'failed',
    errorCode: 'mfa-required',
  });
  state = await get();
  expect(state.healthStatus).toBe('mfa-required');

  attemptId = await begin(token);
  await database.query(
    `UPDATE outlook_browser_sources SET last_attempt_at=CURRENT_TIMESTAMP-INTERVAL '8 hours',active_attempt_progress_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1`,
    [ownerId],
  );
  state = await get();
  expect(state.healthStatus).toBe('syncing');
  const current = (await collector(token, 'GET', 'state')).json();
  const blocked = await collector(token, 'POST', 'attempt', {
    attemptId: randomUUID(),
    expectedSourceVersion: current.sourceVersion,
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe('ATTEMPT_ACTIVE');

  await database.query(
    `UPDATE outlook_browser_sources SET active_attempt_progress_at=CURRENT_TIMESTAMP-INTERVAL '8 hours'
     WHERE owner_id=$1`,
    [ownerId],
  );
  state = await get();
  expect(state.healthStatus).toBe('partial');
  const replacement = randomUUID();
  expect(
    (
      await collector(token, 'POST', 'attempt', {
        attemptId: replacement,
        expectedSourceVersion: current.sourceVersion,
      })
    ).statusCode,
  ).toBe(200);
  const [oldAttempt] = await database.query(
    'SELECT outcome FROM outlook_browser_attempts WHERE owner_id=$1 AND id=$2',
    [ownerId, attemptId],
  );
  expect(oldAttempt?.outcome).toBe('partial');
  expect(selected.selected).toBe(true);
});
