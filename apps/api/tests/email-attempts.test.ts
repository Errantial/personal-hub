import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  emailDraftResponseSchema,
  emailApprovalResponseSchema,
  emailAttemptPageSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { EmailDraft } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import {
  beginSyntheticEmailAttempt,
  confirmSyntheticEmailAttempt,
  executeSyntheticEmail,
} from '../src/email/synthetic-execution.js';
import type { SyntheticEmailInput } from '../src/email/synthetic-execution.js';

const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
const origin = 'http://127.0.0.1:5173';
const base = '/api/v1/email/drafts';
let db: Awaited<ReturnType<typeof openDatabase>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: string, cookie: string, other: string, otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = (url: string, session = cookie) =>
  app.inject({ url, headers: headers(session) });
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: headers(), payload });
const message = () => ({
  connection: 'proton-mail',
  sender: 'sender@example.test',
  to: ['to@example.test'],
  cc: ['cc@example.test'],
  bcc: ['bcc@example.test'],
  subject: 'Synthetic attempt',
  body: 'Synthetic private plain text',
});
async function draft(fields: object = {}) {
  const response = await post(base, {
    operationId: randomUUID(),
    message: { ...message(), ...fields },
  });
  expect(response.statusCode).toBe(200);
  return emailDraftResponseSchema.parse(response.json()).draft;
}
async function approved(value: EmailDraft): Promise<SyntheticEmailInput> {
  const response = await post(`${base}/${value.id}/approve`, {
    operationId: randomUUID(),
    expectedVersion: value.version,
    reviewedContentHash: value.contentHash,
    decision: 'approve-exact-message',
  });
  expect(response.statusCode).toBe(200);
  const approval = emailApprovalResponseSchema.parse(response.json()).approval;
  return {
    draftId: value.id,
    expectedVersion: value.version,
    reviewedContentHash: value.contentHash,
    approvalId: approval.id,
    expectedApprovalVersion: approval.version,
  };
}
async function edit(value: EmailDraft, fields: object = {}) {
  const response = await app.inject({
    method: 'PUT',
    url: `${base}/${value.id}`,
    headers: headers(),
    payload: {
      operationId: randomUUID(),
      expectedVersion: value.version,
      message: { ...value.message, ...fields },
    },
  });
  expect(response.statusCode).toBe(200);
  return emailDraftResponseSchema.parse(response.json()).draft;
}
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in synthetic email attempt tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'attempt-owner@example.test',
      password: 'synthetic-attempt-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-attempt@example.test',
    'unusable-synthetic-hash',
  ]);
  await db.query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES($1,$2,CURRENT_TIMESTAMP+INTERVAL '1 day')",
    [createHash('sha256').update(token).digest('hex'), other],
  );
  otherCookie = `hub_session=${token}`;
});
afterEach(async () => {
  await app.close();
  expect(fetch).not.toHaveBeenCalled();
});

it('commits consumption before the callback and concurrent/historical retries never dispatch twice', async () => {
  const value = await draft();
  const input = await approved(value);
  const execute = vi.fn(async ({ message: payload }: { message: unknown }) => {
    expect(payload).toEqual(value.message);
    expect(
      await db.query('SELECT status FROM email_attempts WHERE owner_id=$1', [
        owner,
      ]),
    ).toEqual([{ status: 'uncertain' }]);
    return { outcome: 'sent' };
  });
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      executeSyntheticEmail(db, config, owner, input, {
        kind: 'synthetic',
        execute,
      }),
    ),
  );
  expect(new Set(results.map((result) => result.id)).size).toBe(1);
  expect(execute).toHaveBeenCalledTimes(1);
  const again = await executeSyntheticEmail(db, config, owner, input, {
    kind: 'synthetic',
    execute,
  });
  expect(again).toMatchObject({
    status: 'sent',
    version: 2,
    finishedAt: expect.any(String),
  });
  const preview = await post(`${base}/${value.id}/send-preview`, {
    expectedVersion: 1,
  });
  expect(preview.json()).toMatchObject({
    executionEnabled: false,
    approvalState: 'consumed',
    attempt: again,
  });
  expect(preview.json().blockers).toContain('EMAIL_ATTEMPT_EXISTS');
  expect(preview.json().blockers).toContain('SENDER_UNVERIFIED');
  expect(
    (
      await post(`${base}/${value.id}/approve`, {
        operationId: randomUUID(),
        expectedVersion: 1,
        reviewedContentHash: value.contentHash,
        decision: 'approve-exact-message',
      })
    ).json().error.code,
  ).toBe('EMAIL_ATTEMPT_EXISTS');
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.emailAttempts).toEqual([again]);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('blocks production/development, non-synthetic adapters and non-test addresses before dispatch', async () => {
  const input = await approved(await draft());
  const execute = vi.fn(async () => ({ outcome: 'sent' }));
  for (const NODE_ENV of ['development', 'production'] as const) {
    const blocked = { ...config, NODE_ENV };
    await expect(
      beginSyntheticEmailAttempt(db, blocked, owner, input),
    ).rejects.toMatchObject({ code: 'EMAIL_EXECUTION_UNAVAILABLE' });
    await expect(
      executeSyntheticEmail(db, blocked, owner, input, {
        kind: 'synthetic',
        execute,
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_EXECUTION_UNAVAILABLE' });
    await expect(
      confirmSyntheticEmailAttempt(db, blocked, owner, randomUUID(), {
        outcome: 'sent',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_EXECUTION_UNAVAILABLE' });
  }
  await expect(
    executeSyntheticEmail(db, config, owner, input, {
      kind: 'smtp' as 'synthetic',
      execute,
    }),
  ).rejects.toMatchObject({ code: 'EMAIL_EXECUTION_UNAVAILABLE' });
  for (const fields of [
    { sender: 'sender@example.com' },
    { to: ['to@example.com'] },
    { cc: ['cc@example.com'] },
    { bcc: ['bcc@example.com'] },
  ]) {
    const nonTest = await approved(await draft(fields));
    await expect(
      executeSyntheticEmail(db, config, owner, nonTest, {
        kind: 'synthetic',
        execute,
      }),
    ).rejects.toMatchObject({ code: 'SYNTHETIC_ADDRESS_REQUIRED' });
  }
  expect(await db.query('SELECT id FROM email_attempts')).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
  for (const path of ['send', 'attempts', 'attempts/retry', 'attempts/confirm'])
    expect(
      (await post(`${base}/${input.draftId}/${path}`, {})).statusCode,
    ).toBe(404);
});

it('requires exact owned current approved content and never consumes failed admissions', async () => {
  const value = await draft({ purpose: 'calendar-cancellation' });
  const input = await approved(value);
  for (const candidate of [
    { ...input, expectedVersion: 2 },
    { ...input, expectedApprovalVersion: 2 },
    { ...input, reviewedContentHash: '0'.repeat(64) },
    { ...input, approvalId: randomUUID() },
  ])
    await expect(
      beginSyntheticEmailAttempt(db, config, owner, candidate),
    ).rejects.toBeDefined();
  await expect(
    beginSyntheticEmailAttempt(db, config, other, input),
  ).rejects.toMatchObject({ statusCode: 404 });
  await post(`${base}/${value.id}/approvals/${input.approvalId}/revoke`, {
    operationId: randomUUID(),
    expectedVersion: 1,
  });
  await expect(
    beginSyntheticEmailAttempt(db, config, owner, {
      ...input,
      expectedApprovalVersion: 2,
    }),
  ).rejects.toMatchObject({ code: 'EMAIL_APPROVAL_REQUIRED' });
  const fresh = await approved(value);
  await edit(value, { body: 'Changed after review' });
  await expect(
    beginSyntheticEmailAttempt(db, config, owner, fresh),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(await db.query('SELECT id FROM email_attempts')).toEqual([]);
  const deleted = await draft();
  const deletedInput = await approved(deleted);
  await app.inject({
    method: 'DELETE',
    url: `${base}/${deleted.id}`,
    headers: headers(),
    payload: { operationId: randomUUID(), expectedVersion: 1 },
  });
  await expect(
    beginSyntheticEmailAttempt(db, config, owner, deletedInput),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('serializes competing edits and admission so an unreviewed replacement is never dispatched', async () => {
  const value = await draft();
  const input = await approved(value);
  const [claim, changed] = await Promise.allSettled([
    beginSyntheticEmailAttempt(db, config, owner, input),
    edit(value, { body: 'Competing unreviewed replacement' }),
  ]);
  expect(changed.status).toBe('fulfilled');
  if (claim.status === 'fulfilled') {
    expect(claim.value.claimed).toBe(true);
    if (claim.value.claimed) expect(claim.value.message).toEqual(value.message);
  } else expect(claim.reason).toMatchObject({ statusCode: 409 });
  expect((await get(`${base}/${value.id}`)).json().draft).toMatchObject({
    version: 2,
    approval: null,
    status: 'pending',
  });
  const attempts = (await get(`${base}/${value.id}/attempts`)).json().attempts;
  expect(attempts).toHaveLength(claim.status === 'fulfilled' ? 1 : 0);
  for (const attempt of attempts)
    expect(attempt).toMatchObject({
      draftVersion: 1,
      contentHash: value.contentHash,
    });
});

it('retains uncertainty on thrown/malformed callbacks and confirmation failure without retrying transport', async () => {
  for (const result of [
    'throw',
    {},
    { outcome: 'sent', privateText: 'unsupported' },
  ]) {
    const value = await draft();
    const input = await approved(value);
    const execute = vi.fn(async () => {
      if (result === 'throw')
        throw new Error('Synthetic private message or credential text');
      return result;
    });
    const attempt = await executeSyntheticEmail(db, config, owner, input, {
      kind: 'synthetic',
      execute,
    });
    expect(attempt).toMatchObject({
      status: 'uncertain',
      version: 1,
      finishedAt: null,
    });
    expect(
      await executeSyntheticEmail(db, config, owner, input, {
        kind: 'synthetic',
        execute,
      }),
    ).toEqual(attempt);
    const preview = (
      await post(`${base}/${value.id}/send-preview`, { expectedVersion: 1 })
    ).json();
    expect(preview.blockers).toContain('EMAIL_DELIVERY_UNCERTAIN');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(attempt)).not.toContain('private');
  }
  const input = await approved(await draft());
  await db.exec(
    "CREATE FUNCTION reject_email_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic settlement failure'; END $$; CREATE TRIGGER reject_email_confirmation BEFORE UPDATE ON email_attempts FOR EACH ROW EXECUTE FUNCTION reject_email_confirmation();",
  );
  const execute = vi.fn(async () => ({ outcome: 'sent' }));
  const attempt = await executeSyntheticEmail(db, config, owner, input, {
    kind: 'synthetic',
    execute,
  });
  expect(attempt.status).toBe('uncertain');
  await db.exec(
    'DROP TRIGGER reject_email_confirmation ON email_attempts; DROP FUNCTION reject_email_confirmation();',
  );
  const confirmed = await confirmSyntheticEmailAttempt(
    db,
    config,
    owner,
    attempt.id,
    { outcome: 'sent' },
  );
  expect(confirmed).toMatchObject({ status: 'sent', version: 2 });
  expect(
    await confirmSyntheticEmailAttempt(db, config, owner, attempt.id, {
      outcome: 'sent',
    }),
  ).toEqual(confirmed);
  await expect(
    confirmSyntheticEmailAttempt(db, config, owner, attempt.id, {
      outcome: 'not-sent',
    }),
  ).rejects.toMatchObject({ code: 'EMAIL_RESULT_CONFLICT' });
  expect(
    (
      await executeSyntheticEmail(db, config, owner, input, {
        kind: 'synthetic',
        execute,
      })
    ).status,
  ).toBe('sent');
  expect(execute).toHaveBeenCalledTimes(1);
});

it('keeps claimed payload immutable through later edits/revocation and only a newly reviewed revision may get another attempt', async () => {
  const value = await draft({
    purpose: 'calendar-invitation',
    sensitivity: 'restricted',
  });
  const input = await approved(value);
  let updated: EmailDraft | undefined;
  const execute = vi.fn(async ({ message: payload }: { message: unknown }) => {
    updated = await edit(value, {
      body: 'Owner changed text during synthetic dispatch',
    });
    expect(payload).toEqual(value.message);
    return { outcome: 'not-sent' };
  });
  const attempt = await executeSyntheticEmail(db, config, owner, input, {
    kind: 'synthetic',
    execute,
  });
  expect(attempt.status).toBe('not-sent');
  expect(
    await executeSyntheticEmail(db, config, owner, input, {
      kind: 'synthetic',
      execute,
    }),
  ).toEqual(attempt);
  await expect(
    beginSyntheticEmailAttempt(db, config, owner, {
      ...input,
      expectedApprovalVersion: 2,
    }),
  ).rejects.toMatchObject({ code: 'EMAIL_ATTEMPT_EXISTS' });
  expect(
    (
      await post(`${base}/${value.id}/send-preview`, { expectedVersion: 2 })
    ).json(),
  ).toMatchObject({ approvalState: 'missing', attempt: null });
  const nextInput = await approved(updated!);
  const second = await executeSyntheticEmail(db, config, owner, nextInput, {
    kind: 'synthetic',
    execute: async ({ message: payload }) => {
      expect(payload).toEqual(updated!.message);
      return { outcome: 'sent' };
    },
  });
  expect(second.id).not.toBe(attempt.id);
  expect(
    (await get(`${base}/${value.id}/revisions/1`)).json().revision.message,
  ).toEqual(value.message);
  expect(
    (await get(`${base}/${value.id}/attempts`)).json().attempts,
  ).toHaveLength(2);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('rejects corrupted payloads and rolls back failed claim insertion without modifying approval or receipts', async () => {
  const value = await draft();
  const input = await approved(value);
  await db.exec(
    "CREATE FUNCTION reject_email_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic claim failure'; END $$; CREATE TRIGGER reject_email_claim BEFORE INSERT ON email_attempts FOR EACH ROW EXECUTE FUNCTION reject_email_claim();",
  );
  const receipts = await db.query(
    'SELECT * FROM mutation_receipts ORDER BY operation_id',
  );
  await expect(
    beginSyntheticEmailAttempt(db, config, owner, input),
  ).rejects.toBeDefined();
  expect(await db.query('SELECT id FROM email_attempts')).toEqual([]);
  expect((await get(`${base}/${value.id}`)).json().draft.approval.version).toBe(
    1,
  );
  expect(
    await db.query('SELECT * FROM mutation_receipts ORDER BY operation_id'),
  ).toEqual(receipts);
  await db.exec(
    'DROP TRIGGER reject_email_claim ON email_attempts; DROP FUNCTION reject_email_claim();',
  );
  await db.query(
    "UPDATE email_draft_revisions SET message=jsonb_set(message,'{body}','\"Tampered synthetic body\"'::jsonb) WHERE draft_id=$1",
    [value.id],
  );
  await expect(
    beginSyntheticEmailAttempt(db, config, owner, input),
  ).rejects.toMatchObject({ code: 'EMAIL_PAYLOAD_UNAVAILABLE' });
  expect(await db.query('SELECT id FROM email_attempts')).toEqual([]);
});

it('provides private metadata-only guarded history, tombstone history and same-owner foreign keys', async () => {
  const value = await draft();
  const input = await approved(value);
  const first = await beginSyntheticEmailAttempt(db, config, owner, input);
  const next = await edit(value);
  const second = await beginSyntheticEmailAttempt(
    db,
    config,
    owner,
    await approved(next),
  );
  const page = emailAttemptPageSchema.parse(
    (await get(`${base}/${value.id}/attempts?limit=1`)).json(),
  );
  expect(page.attempts).toHaveLength(1);
  expect(page.nextAfter).not.toBeNull();
  expect(JSON.stringify(page)).not.toContain(value.message.body);
  expect(JSON.stringify(page)).not.toContain(value.message.bcc[0]);
  const anchor = page.nextAfter!;
  expect(
    emailAttemptPageSchema.parse(
      (
        await get(
          `${base}/${value.id}/attempts?limit=1&after=${anchor.id}&expectedCursorVersion=${anchor.version}`,
        )
      ).json(),
    ).attempts,
  ).toHaveLength(1);
  await confirmSyntheticEmailAttempt(db, config, owner, anchor.id, {
    outcome: 'not-sent',
  });
  expect(
    (
      await get(
        `${base}/${value.id}/attempts?after=${anchor.id}&expectedCursorVersion=1`,
      )
    ).statusCode,
  ).toBe(409);
  for (const suffix of ['/attempts', `/attempts/${first.attempt.id}`])
    expect(
      (await get(`${base}/${value.id}${suffix}`, otherCookie)).statusCode,
    ).toBe(404);
  await expect(
    confirmSyntheticEmailAttempt(db, config, other, first.attempt.id, {
      outcome: 'sent',
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  const different = await draft();
  const differentInput = await approved(different);
  await expect(
    db.query(
      "INSERT INTO email_attempts(id,owner_id,draft_id,draft_version,content_hash,approval_id,approval_version,adapter) VALUES($1,$2,$3,1,$4,$5,1,'synthetic')",
      [
        randomUUID(),
        owner,
        different.id,
        different.contentHash,
        input.approvalId,
      ],
    ),
  ).rejects.toBeDefined();
  await expect(
    db.query(
      "INSERT INTO email_attempts(id,owner_id,draft_id,draft_version,content_hash,approval_id,approval_version,adapter) VALUES($1,$2,$3,1,$4,$5,1,'live')",
      [
        randomUUID(),
        owner,
        different.id,
        different.contentHash,
        differentInput.approvalId,
      ],
    ),
  ).rejects.toBeDefined();
  expect(
    (await get(`${base}/${different.id}/attempts/${first.attempt.id}`))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await get(
        `${base}/${different.id}/attempts?after=${first.attempt.id}&expectedCursorVersion=1`,
      )
    ).statusCode,
  ).toBe(404);
  expect((await get(`${base}/${value.id}/attempts?limit=101`)).statusCode).toBe(
    400,
  );
  expect(
    (await get(`${base}/${value.id}/attempts?after=${randomUUID()}`))
      .statusCode,
  ).toBe(400);
  expect((await get(`${base}/${value.id}/attempts`, '')).statusCode).toBe(401);
  await expect(
    db.query(
      "INSERT INTO email_attempts(id,owner_id,draft_id,draft_version,content_hash,approval_id,approval_version,adapter) VALUES($1,$2,$3,1,$4,$5,1,'synthetic')",
      [randomUUID(), other, value.id, value.contentHash, input.approvalId],
    ),
  ).rejects.toBeDefined();
  await expect(
    db.query(
      "UPDATE email_attempts SET status='sent',finished_at=NULL WHERE id=$1",
      [second.attempt.id],
    ),
  ).rejects.toBeDefined();
  await app.inject({
    method: 'DELETE',
    url: `${base}/${value.id}`,
    headers: headers(),
    payload: { operationId: randomUUID(), expectedVersion: 2 },
  });
  expect(
    (await get(`${base}/${value.id}/attempts`)).json().attempts,
  ).toHaveLength(2);
  expect(
    plannerExportSchema.parse((await get('/api/v1/planner/export')).json())
      .records.emailAttempts,
  ).toHaveLength(2);
  expect(
    (await get('/api/v1/planner/export', otherCookie)).json().records
      .emailAttempts,
  ).toEqual([]);
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await get(`${base}/${value.id}/attempts`)).statusCode).toBe(401);
});

it('applies migration 032 over populated approved drafts without losing prior receipts or history', async () => {
  const value = await draft();
  const input = await approved(value);
  const before = (await get('/api/v1/planner/export')).json();
  const receipts = await db.query(
    'SELECT * FROM mutation_receipts ORDER BY operation_id',
  );
  await db.exec(
    'DROP TABLE email_attempts; ALTER TABLE email_approvals DROP CONSTRAINT email_approvals_owned_payload;',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name='032_email_attempts.sql'",
  );
  await migrate(db);
  expect((await get(`${base}/${value.id}`)).json().draft).toEqual(
    before.records.emailDrafts[0],
  );
  expect(
    await db.query('SELECT * FROM mutation_receipts ORDER BY operation_id'),
  ).toEqual(receipts);
  expect(
    (await beginSyntheticEmailAttempt(db, config, owner, input)).claimed,
  ).toBe(true);
  delete before.records.emailAttempts;
  expect(plannerExportSchema.parse(before).records.emailAttempts).toEqual([]);
});

it('retains uncertain consumed claims across a persisted restart and never automatically resumes dispatch', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'email-attempt-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let storage: Awaited<ReturnType<typeof openDatabase>> | undefined;
  let server: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    storage = await openDatabase(persistent);
    server = await buildApp(
      { logger: false },
      { config: persistent, database: storage },
    );
    const setup = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-attempt@example.test',
        password: 'synthetic-persisted-attempt',
      },
    });
    const h = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const user = setup.json().user.id;
    const created = await server.inject({
      method: 'POST',
      url: base,
      headers: h,
      payload: { operationId: randomUUID(), message: message() },
    });
    const value = emailDraftResponseSchema.parse(created.json()).draft;
    const reviewed = await server.inject({
      method: 'POST',
      url: `${base}/${value.id}/approve`,
      headers: h,
      payload: {
        operationId: randomUUID(),
        expectedVersion: 1,
        reviewedContentHash: value.contentHash,
        decision: 'approve-exact-message',
      },
    });
    const approval = emailApprovalResponseSchema.parse(
      reviewed.json(),
    ).approval;
    const input = {
      draftId: value.id,
      expectedVersion: 1,
      reviewedContentHash: value.contentHash,
      approvalId: approval.id,
      expectedApprovalVersion: 1,
    };
    const claim = await beginSyntheticEmailAttempt(
      storage,
      persistent,
      user,
      input,
    );
    await server.close();
    server = undefined;
    storage = undefined;
    storage = await openDatabase(persistent);
    server = await buildApp(
      { logger: false },
      { config: persistent, database: storage },
    );
    const execute = vi.fn(async () => ({ outcome: 'sent' }));
    expect(
      await executeSyntheticEmail(storage, persistent, user, input, {
        kind: 'synthetic',
        execute,
      }),
    ).toEqual(claim.attempt);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `${base}/${value.id}/send-preview`,
          headers: h,
          payload: { expectedVersion: 1 },
        })
      ).json(),
    ).toMatchObject({
      approvalState: 'consumed',
      attempt: { status: 'uncertain' },
      executionEnabled: false,
    });
    expect(
      (
        await confirmSyntheticEmailAttempt(
          storage,
          persistent,
          user,
          claim.attempt.id,
          { outcome: 'not-sent' },
        )
      ).status,
    ).toBe('not-sent');
    expect(
      (
        await executeSyntheticEmail(storage, persistent, user, input, {
          kind: 'synthetic',
          execute,
        })
      ).status,
    ).toBe('not-sent');
    expect(execute).not.toHaveBeenCalled();
  } finally {
    if (server) await server.close();
    else await storage?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
