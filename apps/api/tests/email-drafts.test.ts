import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  emailDraftResponseSchema,
  emailDraftPageSchema,
  emailApprovalPageSchema,
  emailRevisionPageSchema,
  plannerExportSchema,
} from '@hub/contracts';
import type { EmailDraft, EmailMessage, EmailApproval } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { hashEmailMessage } from '../src/features/email-drafts.js';

const base = '/api/v1/email/drafts';
const origin = 'http://127.0.0.1:5173';
const config = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' });
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof openDatabase>>;
let owner: string, cookie: string, other: string, otherCookie: string;
const headers = (session = cookie) => ({ origin, cookie: session });
const get = (url: string, session = cookie) =>
  app.inject({ url, headers: headers(session) });
const write = (
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload: object,
  session = cookie,
) => app.inject({ method, url, headers: headers(session), payload });
const change = (expectedVersion: number) => ({
  expectedVersion,
  operationId: randomUUID(),
});
const message = (fields: object = {}) => ({
  connection: 'proton-mail',
  sender: 'sender@example.test',
  to: ['recipient@example.test'],
  subject: 'Synthetic subject',
  body: 'Synthetic plain text\nSecond line',
  ...fields,
});
async function create(
  fields: object = {},
  session = cookie,
): Promise<EmailDraft> {
  const response = await write(
    'POST',
    base,
    { operationId: randomUUID(), message: message(fields) },
    session,
  );
  expect(response.statusCode).toBe(200);
  return emailDraftResponseSchema.parse(response.json()).draft;
}
const approvalInput = (draft: EmailDraft) => ({
  ...change(draft.version),
  reviewedContentHash: draft.contentHash,
  decision: 'approve-exact-message',
});
const approve = (draft: EmailDraft, fields: object = {}) =>
  write('POST', `${base}/${draft.id}/approve`, {
    ...approvalInput(draft),
    ...fields,
  });
const preview = (draft: EmailDraft, approval?: EmailApproval) =>
  write('POST', `${base}/${draft.id}/send-preview`, {
    expectedVersion: draft.version,
    ...(approval
      ? { approval: { id: approval.id, expectedVersion: approval.version } }
      : {}),
  });
beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden in synthetic email tests.');
    }),
  );
  db = await openDatabase(config);
  app = await buildApp({ logger: false }, { config, database: db });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin },
    payload: {
      email: 'email-owner@example.test',
      password: 'synthetic-email-password',
    },
  });
  expect(setup.statusCode).toBe(201);
  owner = setup.json().user.id;
  cookie = String(setup.headers['set-cookie']).split(';')[0]!;
  other = randomUUID();
  const token = randomBytes(32).toString('hex');
  await db.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    other,
    'other-email@example.test',
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
it('normalizes explicit empty attachments/recipient lists and rejects content outside the text-only draft contract', async () => {
  const draft = await create({ sender: ' sender@example.test ' });
  expect(draft).toMatchObject({
    version: 1,
    status: 'pending',
    approval: null,
    message: {
      sender: 'sender@example.test',
      cc: [],
      bcc: [],
      attachments: [],
      sensitivity: 'unlabeled',
      purpose: 'email',
    },
  });
  expect(draft.contentHash).toBe(hashEmailMessage(draft.message));
  expect(
    (
      await write('POST', '/api/v1/ai/routing/preview', {
        expectedPolicyVersion: 1,
        text: 'Synthetic context',
        sensitivity: 'unlabeled',
        simulatedAvailableProviders: [],
        sources: [{ kind: 'email-draft', id: draft.id, expectedVersion: 1 }],
      })
    ).statusCode,
  ).toBe(400);
  for (const fields of [
    { sender: 'invalid' },
    { to: [] },
    { to: ['recipient@example.test'], cc: ['RECIPIENT@example.test'] },
    { to: Array.from({ length: 51 }, (_, i) => `synthetic-${i}@example.test`) },
    { sender: 'sender@example.test\r\nBcc: injected@example.test' },
    { subject: 'Subject\nBcc: injected@example.test' },
    { body: 'Null\0text' },
    { body: 'x'.repeat(12001) },
    { attachments: [{ name: 'attachment.txt' }] },
    { html: '<p>Unsupported</p>' },
    { screenshot: 'synthetic' },
    { sourceId: randomUUID() },
    { purpose: 'automatic-send' },
    { connection: 'custom-provider' },
  ])
    expect(
      (
        await write('POST', base, {
          operationId: randomUUID(),
          message: message(fields),
        })
      ).statusCode,
    ).toBe(400);
  expect(
    await db.query('SELECT id FROM email_drafts WHERE owner_id=$1', [owner]),
  ).toHaveLength(1);
  expect(
    await db.query(
      'SELECT version FROM email_draft_revisions WHERE owner_id=$1',
      [owner],
    ),
  ).toHaveLength(1);
});
it('deduplicates concurrent creates and requires explicit review of the current exact hash before approval', async () => {
  const payload = { operationId: randomUUID(), message: message() };
  const [first, retry] = await Promise.all([
    write('POST', base, payload),
    write('POST', base, payload),
  ]);
  expect(first.statusCode).toBe(200);
  expect(retry.json()).toEqual(first.json());
  const draft = first.json().draft as EmailDraft;
  expect(
    (
      await write('POST', base, {
        ...payload,
        message: message({ body: 'Changed synthetic body' }),
      })
    ).json().error.code,
  ).toBe('OPERATION_CONFLICT');
  const wrong = {
    ...approvalInput(draft),
    reviewedContentHash: '0'.repeat(64),
  };
  expect((await approve(draft, wrong)).json().error.code).toBe(
    'EMAIL_REVIEW_CONFLICT',
  );
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [owner, wrong.operationId],
    ),
  ).toHaveLength(0);
  expect((await approve(draft, { expectedVersion: 2 })).json().error.code).toBe(
    'VERSION_CONFLICT',
  );
  expect((await approve(draft, { decision: 'send-now' })).statusCode).toBe(400);
  const approvePayload = approvalInput(draft);
  const [one, two] = await Promise.all([
    approve(draft, approvePayload),
    approve(draft, approvePayload),
  ]);
  expect(one.statusCode).toBe(200);
  expect(two.json()).toEqual(one.json());
  expect((await approve(draft)).json()).toEqual(one.json());
  expect(
    await db.query('SELECT id FROM email_approvals WHERE owner_id=$1', [owner]),
  ).toHaveLength(1);
  expect((await get(`${base}/${draft.id}`)).json().draft).toMatchObject({
    version: 1,
    status: 'approved',
    approval: one.json().approval,
  });
  expect((await preview(draft)).json()).toMatchObject({
    executionEnabled: false,
    approvalState: 'current',
    blockers: [
      'SENDER_UNVERIFIED',
      'SEND_CAPABILITY_UNVERIFIED',
      'EMAIL_EXECUTION_UNAVAILABLE',
    ],
  });
  expect((await write('POST', `${base}/${draft.id}/send`, {})).statusCode).toBe(
    404,
  );
  expect(
    await db.query('SELECT id FROM ai_requests WHERE owner_id=$1', [owner]),
  ).toHaveLength(0);
});
it('invalidates approval for every approved field and retains immutable revisions and historical retry responses', async () => {
  let draft = await create();
  const changes: Array<Partial<EmailMessage>> = [
    { connection: 'outlook-mail' },
    { purpose: 'calendar-invitation' },
    { sender: 'second-sender@example.test' },
    { to: ['new-to@example.test'] },
    { cc: ['new-cc@example.test'] },
    { bcc: ['new-bcc@example.test'] },
    { subject: 'Changed synthetic subject' },
    { body: 'Changed synthetic body\r\nPreserved whitespace ' },
    { sensitivity: 'restricted' },
  ];
  for (const fields of changes) {
    const approved = (await approve(draft)).json().approval as EmailApproval;
    const before = draft;
    const payload = {
      ...change(draft.version),
      message: { ...draft.message, ...fields },
    };
    const response = await write('PUT', `${base}/${draft.id}`, payload);
    expect(response.statusCode).toBe(200);
    draft = emailDraftResponseSchema.parse(response.json()).draft;
    expect(draft.version).toBe(before.version + 1);
    expect(draft.contentHash).not.toBe(before.contentHash);
    expect(draft).toMatchObject({ status: 'pending', approval: null });
    const oldRevision = (
      await get(`${base}/${draft.id}/revisions/${before.version}`)
    ).json().revision;
    expect(oldRevision.message).toEqual(before.message);
    expect(oldRevision.contentHash).toBe(before.contentHash);
    const approvalRows = await db.query(
      'SELECT version,revoked_at FROM email_approvals WHERE id=$1',
      [approved.id],
    );
    expect(approvalRows[0]!.version).toBe(2);
    expect(approvalRows[0]!.revoked_at).not.toBeNull();
    const stale = await preview(draft, { ...approved, version: 2 });
    expect(stale.json().approvalState).toBe('stale');
    expect(stale.json().blockers).toContain('APPROVAL_STALE');
    expect((await write('PUT', `${base}/${draft.id}`, payload)).json()).toEqual(
      response.json(),
    );
  }
  const reviewed = (await approve(draft)).json().approval;
  const same = await write('PUT', `${base}/${draft.id}`, {
    ...change(draft.version),
    message: draft.message,
  });
  expect(same.json().draft).toMatchObject({
    version: draft.version + 1,
    contentHash: draft.contentHash,
    status: 'pending',
    approval: null,
  });
  expect(
    (
      await db.query('SELECT version FROM email_approvals WHERE id=$1', [
        reviewed.id,
      ])
    )[0]!.version,
  ).toBe(2);
});
it('revokes approvals durably, supports deliberate reapproval and cannot revive approval through retries', async () => {
  const draft = await create();
  const payload = approvalInput(draft);
  const approved = await approve(draft, payload);
  const approval = approved.json().approval as EmailApproval;
  const revokeInput = change(approval.version);
  const url = `${base}/${draft.id}/approvals/${approval.id}/revoke`;
  const [one, two] = await Promise.all([
    write('POST', url, revokeInput),
    write('POST', url, revokeInput),
  ]);
  expect(one.statusCode).toBe(200);
  expect(two.json()).toEqual(one.json());
  expect(one.json().approval).toMatchObject({
    version: 2,
    revokedAt: expect.any(String),
  });
  expect((await preview(draft, one.json().approval)).json()).toMatchObject({
    approvalState: 'revoked',
    executionEnabled: false,
  });
  expect((await preview(draft, approval)).json().error.code).toBe(
    'VERSION_CONFLICT',
  );
  expect((await approve(draft, payload)).json()).toEqual(approved.json());
  expect((await get(`${base}/${draft.id}`)).json().draft.status).toBe(
    'pending',
  );
  const next = await approve(draft);
  expect(next.statusCode).toBe(200);
  expect(next.json().approval.id).not.toBe(approval.id);
  expect((await preview(draft)).json().approvalState).toBe('current');
  expect((await write('POST', url, change(2))).json().error.code).toBe(
    'APPROVAL_REVOKED',
  );
});
it('preserves deletion/restore tombstones and export history without restoring old approval', async () => {
  const draft = await create({
    purpose: 'calendar-cancellation',
    bcc: ['hidden@example.test'],
  });
  const approved = (await approve(draft)).json().approval as EmailApproval;
  const deletion = change(1);
  const removed = await write('DELETE', `${base}/${draft.id}`, deletion);
  expect(removed.statusCode).toBe(200);
  const tombstone = removed.json().draft as EmailDraft;
  expect(tombstone).toMatchObject({
    version: 2,
    status: 'deleted',
    approval: null,
    message: draft.message,
    deletedAt: expect.any(String),
  });
  expect((await get(base)).json().drafts).toHaveLength(0);
  expect((await get(`${base}?deleted=true`)).json().drafts[0].id).toBe(
    draft.id,
  );
  expect((await approve(tombstone)).statusCode).toBe(409);
  expect(
    (await preview(tombstone, { ...approved, version: 2 })).json().blockers,
  ).toContain('DRAFT_DELETED');
  const restored = await write(
    'POST',
    `${base}/${draft.id}/restore`,
    change(2),
  );
  expect(restored.statusCode).toBe(200);
  expect(restored.json().draft).toMatchObject({
    version: 3,
    status: 'pending',
    approval: null,
    message: draft.message,
    deletedAt: null,
  });
  expect(
    (await write('DELETE', `${base}/${draft.id}`, deletion)).json(),
  ).toEqual(removed.json());
  expect((await get(`${base}/${draft.id}`)).json().draft.version).toBe(3);
  const exported = plannerExportSchema.parse(
    (await get('/api/v1/planner/export')).json(),
  );
  expect(exported.records.emailDrafts[0]!.version).toBe(3);
  expect(exported.records.emailDraftRevisions.map((r) => r.version)).toEqual([
    1, 2, 3,
  ]);
  expect(exported.records.emailApprovals[0]!.revokedAt).not.toBeNull();
  const old = structuredClone(exported) as {
    records: {
      emailDrafts?: unknown;
      emailDraftRevisions?: unknown;
      emailApprovals?: unknown;
    };
  };
  delete old.records.emailDrafts;
  delete old.records.emailDraftRevisions;
  delete old.records.emailApprovals;
  expect(plannerExportSchema.parse(old).records.emailDrafts).toEqual([]);
});
it('serializes approval against editing and collapses competing approvals to one current record', async () => {
  const draft = await create();
  const approvals = await Promise.all([approve(draft), approve(draft)]);
  expect(approvals.every((response) => response.statusCode === 200)).toBe(true);
  expect(approvals[0]!.json()).toEqual(approvals[1]!.json());
  const edited = await create();
  const [approved, updated] = await Promise.all([
    approve(edited),
    write('PUT', `${base}/${edited.id}`, {
      ...change(1),
      message: { ...edited.message, body: 'New synthetic body' },
    }),
  ]);
  expect([200, 409]).toContain(approved.statusCode);
  expect(updated.statusCode).toBe(200);
  expect((await get(`${base}/${edited.id}`)).json().draft).toMatchObject({
    version: 2,
    status: 'pending',
    approval: null,
  });
  expect(
    await db.query(
      'SELECT id FROM email_approvals WHERE owner_id=$1 AND draft_id=$2 AND revoked_at IS NULL',
      [owner, edited.id],
    ),
  ).toHaveLength(0);
});
it('rolls back revision failure, approval invalidation, task-independent state and mutation receipts atomically', async () => {
  const draft = await create();
  const approval = (await approve(draft)).json().approval;
  await db.exec(`CREATE FUNCTION reject_synthetic_email_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.version=2 THEN RAISE EXCEPTION 'Synthetic revision failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_synthetic_email_revision BEFORE INSERT ON email_draft_revisions FOR EACH ROW EXECUTE FUNCTION reject_synthetic_email_revision();`);
  const payload = {
    ...change(1),
    message: { ...draft.message, subject: 'Failed synthetic edit' },
  };
  const failed = await write('PUT', `${base}/${draft.id}`, payload);
  expect(failed.statusCode).toBe(500);
  expect(failed.json().error).toEqual({
    code: 'INTERNAL_ERROR',
    message: 'The request could not be completed.',
  });
  expect((await get(`${base}/${draft.id}`)).json().draft).toMatchObject({
    version: 1,
    message: draft.message,
    status: 'approved',
    approval,
  });
  expect(
    await db.query(
      'SELECT operation_id FROM mutation_receipts WHERE owner_id=$1 AND operation_id=$2',
      [owner, payload.operationId],
    ),
  ).toHaveLength(0);
  expect(
    await db.query(
      'SELECT version FROM email_draft_revisions WHERE owner_id=$1 AND draft_id=$2',
      [owner, draft.id],
    ),
  ).toHaveLength(1);
  await db.exec(
    'DROP TRIGGER reject_synthetic_email_revision ON email_draft_revisions; DROP FUNCTION reject_synthetic_email_revision();',
  );
  expect((await write('PUT', `${base}/${draft.id}`, payload)).statusCode).toBe(
    200,
  );
});
it('isolates all private drafts, revisions, approval routes and receipt identities and rejects foreign revision links in SQL', async () => {
  const draft = await create();
  const foreign = await create(
    { subject: 'Other owner synthetic subject' },
    otherCookie,
  );
  const approved = (await approve(draft)).json().approval;
  const foreignApproval = await write(
    'POST',
    `${base}/${foreign.id}/approve`,
    approvalInput(foreign),
    otherCookie,
  );
  expect(foreignApproval.statusCode).toBe(200);
  for (const path of [
    `${base}/${foreign.id}`,
    `${base}/${foreign.id}/revisions`,
    `${base}/${foreign.id}/revisions/1`,
    `${base}/${foreign.id}/approvals`,
  ])
    expect((await get(path)).statusCode).toBe(404);
  for (const [method, path, payload] of [
    [
      'PUT',
      `${base}/${foreign.id}`,
      { ...change(1), message: foreign.message },
    ],
    ['DELETE', `${base}/${foreign.id}`, change(1)],
    ['POST', `${base}/${foreign.id}/restore`, change(1)],
    ['POST', `${base}/${foreign.id}/approve`, approvalInput(foreign)],
    ['POST', `${base}/${foreign.id}/send-preview`, { expectedVersion: 1 }],
    [
      'POST',
      `${base}/${draft.id}/approvals/${foreignApproval.json().approval.id}/revoke`,
      change(1),
    ],
  ] as const)
    expect((await write(method, path, payload)).statusCode).toBe(404);
  expect(
    (
      await write('POST', `${base}/${draft.id}/send-preview`, {
        expectedVersion: 1,
        approval: {
          id: foreignApproval.json().approval.id,
          expectedVersion: 1,
        },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await get(base)).json().drafts.map((d: { id: string }) => d.id),
  ).toEqual([draft.id]);
  expect(
    (await get('/api/v1/planner/export'))
      .json()
      .records.emailApprovals.map((a: { id: string }) => a.id),
  ).toEqual([approved.id]);
  await expect(
    db.query(
      'INSERT INTO email_approvals(id,owner_id,draft_id,draft_version,content_hash) VALUES($1,$2,$3,1,$4)',
      [randomUUID(), owner, foreign.id, foreign.contentHash],
    ),
  ).rejects.toThrow();
  for (const route of [
    base,
    `${base}/${draft.id}`,
    `${base}/${draft.id}/revisions/1`,
  ])
    expect((await app.inject(route)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/${draft.id}/approve`,
        headers: { origin: 'https://foreign.example.test', cookie },
        payload: approvalInput(draft),
      })
    ).statusCode,
  ).toBe(403);
  await db.query(
    'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
    [owner],
  );
  expect((await get(base)).statusCode).toBe(401);
  expect((await approve(draft)).statusCode).toBe(401);
  expect((await preview(draft)).statusCode).toBe(401);
});
it('pages body-free draft/revision/approval history and guards changed or foreign cursors', async () => {
  const drafts = [await create(), await create(), await create()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const first = emailDraftPageSchema.parse(
    (await get(`${base}?limit=1`)).json(),
  );
  expect(first.drafts[0]!.id).toBe(drafts[0]!.id);
  expect(JSON.stringify(first)).not.toContain('Synthetic plain text');
  const cursor = first.nextAfter!;
  const after = `after=${cursor.id}&expectedCursorVersion=${cursor.version}`;
  expect(
    (await get(`${base}?limit=2&${after}`))
      .json()
      .drafts.map((d: { id: string }) => d.id),
  ).toEqual(drafts.slice(1).map((d) => d.id));
  const draft = drafts[0]!;
  const approved = (await approve(draft)).json().approval;
  const changed = await write('PUT', `${base}/${draft.id}`, {
    ...change(1),
    message: draft.message,
  });
  expect(changed.statusCode).toBe(200);
  expect((await get(`${base}?${after}`)).statusCode).toBe(409);
  const revisionPage = emailRevisionPageSchema.parse(
    (await get(`${base}/${draft.id}/revisions?limit=1`)).json(),
  );
  expect(revisionPage.nextAfterVersion).toBe(1);
  expect(revisionPage.revisions[0]!.version).toBe(1);
  expect(
    (await get(`${base}/${draft.id}/revisions?afterVersion=1`)).json()
      .revisions[0].version,
  ).toBe(2);
  expect(
    (await get(`${base}/${draft.id}/revisions?afterVersion=99`)).statusCode,
  ).toBe(404);
  const approvalPage = emailApprovalPageSchema.parse(
    (await get(`${base}/${draft.id}/approvals`)).json(),
  );
  expect(approvalPage.approvals[0]!.version).toBe(2);
  expect(
    (
      await get(
        `${base}/${draft.id}/approvals?after=${approved.id}&expectedCursorVersion=1`,
      )
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await get(
        `${base}/${drafts[1]!.id}/approvals?after=${approved.id}&expectedCursorVersion=2`,
      )
    ).statusCode,
  ).toBe(404);
  for (const query of [
    'limit=0',
    'limit=101',
    'after=' + randomUUID(),
    'deleted=yes',
    'body=unexpected',
  ])
    expect((await get(`${base}?${query}`)).statusCode).toBe(400);
  expect(
    (await get(`${base}?after=${randomUUID()}&expectedCursorVersion=1`))
      .statusCode,
  ).toBe(404);
  expect((await get(`${base}/${draft.id}/revisions/99`)).statusCode).toBe(404);
});
it('blocks approval and send preview when current or historical payload integrity is unavailable', async () => {
  const draft = await create();
  await db.query('UPDATE email_drafts SET message=$2::jsonb WHERE id=$1', [
    draft.id,
    JSON.stringify({ ...draft.message, body: 'Tampered synthetic body' }),
  ]);
  expect((await approve(draft)).json().error.code).toBe(
    'EMAIL_PAYLOAD_UNAVAILABLE',
  );
  expect((await preview(draft)).json().error.code).toBe(
    'EMAIL_PAYLOAD_UNAVAILABLE',
  );
  await db.query('UPDATE email_drafts SET message=$2::jsonb WHERE id=$1', [
    draft.id,
    JSON.stringify(draft.message),
  ]);
  await db.query(
    'UPDATE email_draft_revisions SET message=$2::jsonb WHERE draft_id=$1 AND version=1',
    [
      draft.id,
      JSON.stringify({ ...draft.message, body: 'Tampered synthetic revision' }),
    ],
  );
  expect((await approve(draft)).json().error.code).toBe(
    'EMAIL_PAYLOAD_UNAVAILABLE',
  );
  expect((await preview(draft)).json().error.code).toBe(
    'EMAIL_PAYLOAD_UNAVAILABLE',
  );
  expect((await get(`${base}/${draft.id}/revisions/1`)).json().error.code).toBe(
    'EMAIL_PAYLOAD_UNAVAILABLE',
  );
  expect((await get('/api/v1/planner/export')).json().error.code).toBe(
    'EMAIL_PAYLOAD_UNAVAILABLE',
  );
  expect(
    await db.query('SELECT id FROM email_approvals WHERE owner_id=$1', [owner]),
  ).toHaveLength(0);
});
it('adds migration 031 without altering populated planner data or previous receipts', async () => {
  const task = await write('POST', '/api/v1/tasks', {
    title: 'Retained synthetic planner record',
    operationId: randomUUID(),
  });
  expect(task.statusCode).toBe(200);
  const receipts = await db.query(
    'SELECT * FROM mutation_receipts WHERE owner_id=$1',
    [owner],
  );
  await db.exec(
    'DROP TABLE email_attempts; DROP TABLE email_approvals; DROP TABLE email_draft_revisions; DROP TABLE email_drafts;',
  );
  await db.query(
    "DELETE FROM schema_migrations WHERE name IN ('031_email_drafts.sql','032_email_attempts.sql')",
  );
  await migrate(db);
  expect((await get(`/api/v1/tasks/${task.json().task.id}`)).json()).toEqual(
    task.json(),
  );
  expect(
    await db.query('SELECT * FROM mutation_receipts WHERE owner_id=$1', [
      owner,
    ]),
  ).toEqual(receipts);
  expect((await get(base)).json().drafts).toEqual([]);
  const draft = await create();
  expect((await approve(draft)).statusCode).toBe(200);
});
it('retains exact approved revisions across restart and historical retries never reactivate invalidated approval', async () => {
  const root = resolve('.artifacts');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'email-approval-'));
  const persistent = readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: path });
  let reopened: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    reopened = await buildApp({ logger: false }, { config: persistent });
    const setup = await reopened.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin },
      payload: {
        email: 'persisted-email@example.test',
        password: 'synthetic-persisted-email',
      },
    });
    expect(setup.statusCode).toBe(201);
    const h = {
      origin,
      cookie: String(setup.headers['set-cookie']).split(';')[0]!,
    };
    const createInput = {
      operationId: randomUUID(),
      message: message({ purpose: 'calendar-attendee-update' }),
    };
    const created = await reopened.inject({
      method: 'POST',
      url: base,
      headers: h,
      payload: createInput,
    });
    expect(created.statusCode).toBe(200);
    const draft = created.json().draft as EmailDraft;
    const approvedInput = approvalInput(draft);
    const approved = await reopened.inject({
      method: 'POST',
      url: `${base}/${draft.id}/approve`,
      headers: h,
      payload: approvedInput,
    });
    expect(approved.statusCode).toBe(200);
    await reopened.close();
    reopened = undefined;
    reopened = await buildApp({ logger: false }, { config: persistent });
    expect(
      (
        await reopened.inject({
          method: 'POST',
          url: `${base}/${draft.id}/send-preview`,
          headers: h,
          payload: { expectedVersion: 1 },
        })
      ).json(),
    ).toMatchObject({ approvalState: 'current', executionEnabled: false });
    const updated = await reopened.inject({
      method: 'PUT',
      url: `${base}/${draft.id}`,
      headers: h,
      payload: {
        ...change(1),
        message: { ...draft.message, body: 'New persisted synthetic body' },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (
        await reopened.inject({
          method: 'POST',
          url: `${base}/${draft.id}/approve`,
          headers: h,
          payload: approvedInput,
        })
      ).json(),
    ).toEqual(approved.json());
    expect(
      (
        await reopened.inject({
          method: 'POST',
          url: base,
          headers: h,
          payload: createInput,
        })
      ).json(),
    ).toEqual(created.json());
    expect(
      (await reopened.inject({ url: `${base}/${draft.id}`, headers: h })).json()
        .draft,
    ).toMatchObject({ version: 2, status: 'pending', approval: null });
    expect(
      (
        await reopened.inject({
          url: `${base}/${draft.id}/revisions/1`,
          headers: h,
        })
      ).json().revision.message,
    ).toEqual(draft.message);
  } finally {
    await reopened?.close();
    expect(dirname(path)).toBe(root);
    await rm(path, { recursive: true, force: true });
  }
});
