import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  mailCategoryWriteSchema,
  mailCategoryResultSchema,
  mailRuleCreateSchema,
  mailRuleUpdateSchema,
  mailRuleDeleteSchema,
  mailRuleResultSchema,
  mailRulesSchema,
  mailRulesPreviewInputSchema,
  mailRulesPreviewSchema,
  mailRulesApplyInputSchema,
  mailRulesApplyResultSchema,
} from '@hub/contracts';
import type { MailRule } from '@hub/contracts';
import type { authService } from '../auth/routes.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { mutate } from '../planner/mutations.js';
import { ApiError } from '../errors.js';
import { stamp, version } from './common.js';

const base = '/api/v1/email';
const params = z.object({ id: z.string().uuid() });
const categoryColumns =
  'id,version,category,category_source AS "categorySource",category_rule_id AS "categoryRuleId"';
const ruleColumns = `id,version,name,field,match,category,enabled,${stamp('created_at', 'createdAt')},${stamp('deleted_at', 'deletedAt')}`;
async function readRules(tx: QueryExecutor, owner: string) {
  const [state] = await tx.query(
    'SELECT revision FROM mail_rule_settings WHERE owner_id=$1',
    [owner],
  );
  const rules = await tx.query(
    `SELECT ${ruleColumns} FROM mail_rules WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`,
    [owner],
  );
  return mailRulesSchema.parse({ revision: state?.revision ?? 1, rules });
}
async function lockRules(tx: QueryExecutor, owner: string, expected?: number) {
  await tx.query(
    'INSERT INTO mail_rule_settings(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [owner],
  );
  const [row] = await tx.query(
    'SELECT revision FROM mail_rule_settings WHERE owner_id=$1 FOR UPDATE',
    [owner],
  );
  if (expected !== undefined && row!.revision !== expected)
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'Reload mail rules before applying changes.',
    );
}
async function advanceRules(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'UPDATE mail_rule_settings SET revision=revision+1 WHERE owner_id=$1 RETURNING revision',
    [owner],
  );
  return Number(row!.revision);
}
function matchRule(rule: MailRule, row: Record<string, unknown>) {
  const match = rule.match.toLowerCase();
  return rule.field === 'subject'
    ? String(row.subject).toLowerCase().includes(match)
    : String(
        (row.from_address as { address?: string } | null)?.address ?? '',
      ).toLowerCase() === match;
}
async function decisions(
  tx: QueryExecutor,
  owner: string,
  references: { id: string; expectedVersion: number }[],
  rules: MailRule[],
  lock = false,
) {
  const rows = await tx.query(
    `SELECT ${categoryColumns},category_rule_capture,subject,from_address FROM email_messages WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [owner, references.map((ref) => ref.id)],
  );
  if (rows.length !== references.length)
    throw new ApiError(404, 'NOT_FOUND', 'Selected mail is not available.');
  return references.map((ref) => {
    const row = rows.find((row) => row.id === ref.id.toLowerCase())!;
    version(row, ref.expectedVersion);
    const protectedByOwner = row.categorySource === 'owner';
    const rule = protectedByOwner
      ? null
      : rules.find((rule) => rule.enabled && matchRule(rule, row));
    const category = protectedByOwner ? row.category : (rule?.category ?? null);
    const categorySource = protectedByOwner ? 'owner' : rule ? 'rule' : null;
    const categoryRuleId = protectedByOwner ? null : (rule?.id ?? null);
    const capture = rule
      ? {
          id: rule.id,
          version: rule.version,
          name: rule.name,
          field: rule.field,
          match: rule.match,
          category: rule.category,
        }
      : null;
    return {
      id: row.id,
      version: row.version,
      category,
      categorySource,
      categoryRuleId,
      capture,
      previousCategory: row.category,
      protected: protectedByOwner,
      changed:
        row.category !== category ||
        row.categorySource !== categorySource ||
        row.categoryRuleId !== categoryRuleId ||
        (rule !== null &&
          rule !== undefined &&
          (row.category_rule_capture as { version?: number } | null)
            ?.version !== rule.version),
      ruleVersion: rule?.version ?? null,
    };
  });
}

export function registerMailOrganization(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  app.get(`${base}/rules`, async (request) => {
    const owner = await auth.requireUser(request);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return readRules(tx, owner.id);
    });
  });
  app.post(`${base}/rules`, async (request, reply) => {
    const owner = await auth.requireUser(request);
    const input = mailRuleCreateSchema.parse(request.body);
    const result = await mutate(
      database,
      owner.id,
      input.operationId,
      { kind: 'mail.rule.create', ...input },
      async (tx) => {
        await lockRules(tx, owner.id, input.expectedRevision);
        const [count] = await tx.query(
          'SELECT COUNT(*)::integer AS count FROM mail_rules WHERE owner_id=$1 AND deleted_at IS NULL',
          [owner.id],
        );
        if (Number(count!.count) >= 200)
          throw new ApiError(
            409,
            'MAIL_RULE_LIMIT',
            'Remove a rule before adding more.',
          );
        const id = randomUUID();
        await tx.query(
          'INSERT INTO mail_rules(id,owner_id,name,field,match,category,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            owner.id,
            input.name,
            input.field,
            input.match,
            input.category,
            input.enabled,
          ],
        );
        return { id, version: 1, revision: await advanceRules(tx, owner.id) };
      },
      {
        authorize: async (tx) => {
          if (!(await auth.currentUser(request, tx)))
            throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
        },
      },
    );
    return reply.code(201).send(mailRuleResultSchema.parse(result));
  });
  app.put(`${base}/rules/:id`, async (request) => {
    const owner = await auth.requireUser(request),
      { id } = params.parse(request.params);
    const input = mailRuleUpdateSchema.parse(request.body);
    return mailRuleResultSchema.parse(
      await mutate(
        database,
        owner.id,
        input.operationId,
        { kind: 'mail.rule.update', id, ...input },
        async (tx) => {
          await lockRules(tx, owner.id, input.expectedRevision);
          const [row] = await tx.query(
            'SELECT version FROM mail_rules WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
            [owner.id, id],
          );
          if (!row)
            throw new ApiError(404, 'NOT_FOUND', 'Rule is not available.');
          version(row, input.expectedVersion);
          await tx.query(
            'UPDATE mail_rules SET name=$3,field=$4,match=$5,category=$6,enabled=$7,version=version+1 WHERE owner_id=$1 AND id=$2',
            [
              owner.id,
              id,
              input.name,
              input.field,
              input.match,
              input.category,
              input.enabled,
            ],
          );
          return {
            id,
            version: input.expectedVersion + 1,
            revision: await advanceRules(tx, owner.id),
          };
        },
        {
          authorize: async (tx) => {
            if (!(await auth.currentUser(request, tx)))
              throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
          },
        },
      ),
    );
  });
  app.delete(`${base}/rules/:id`, async (request) => {
    const owner = await auth.requireUser(request),
      { id } = params.parse(request.params);
    const input = mailRuleDeleteSchema.parse(request.body);
    return mailRuleResultSchema.parse(
      await mutate(
        database,
        owner.id,
        input.operationId,
        { kind: 'mail.rule.delete', id, ...input },
        async (tx) => {
          await lockRules(tx, owner.id, input.expectedRevision);
          const [row] = await tx.query(
            'SELECT version FROM mail_rules WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
            [owner.id, id],
          );
          if (!row)
            throw new ApiError(404, 'NOT_FOUND', 'Rule is not available.');
          version(row, input.expectedVersion);
          await tx.query(
            'UPDATE mail_rules SET deleted_at=CURRENT_TIMESTAMP,version=version+1 WHERE owner_id=$1 AND id=$2',
            [owner.id, id],
          );
          return {
            id,
            version: input.expectedVersion + 1,
            revision: await advanceRules(tx, owner.id),
          };
        },
        {
          authorize: async (tx) => {
            if (!(await auth.currentUser(request, tx)))
              throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
          },
        },
      ),
    );
  });
  app.put(`${base}/messages/:id/category`, async (request) => {
    const owner = await auth.requireUser(request),
      { id } = params.parse(request.params);
    const input = mailCategoryWriteSchema.parse(request.body);
    return mailCategoryResultSchema.parse(
      await mutate(
        database,
        owner.id,
        input.operationId,
        { kind: 'mail.category', id, ...input },
        async (tx) => {
          const [row] = await tx.query(
            'SELECT version FROM email_messages WHERE owner_id=$1 AND id=$2 FOR UPDATE',
            [owner.id, id],
          );
          if (!row)
            throw new ApiError(404, 'NOT_FOUND', 'Message is not available.');
          version(row, input.expectedVersion);
          const [updated] = await tx.query(
            `UPDATE email_messages SET category=$3,category_source=$4,category_rule_id=NULL,category_rule_capture=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2 RETURNING ${categoryColumns}`,
            [
              owner.id,
              id,
              input.mode === 'owner' ? input.category : null,
              input.mode === 'owner' ? 'owner' : null,
            ],
          );
          return mailCategoryResultSchema.parse(updated);
        },
        {
          authorize: async (tx) => {
            if (!(await auth.currentUser(request, tx)))
              throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
          },
        },
      ),
    );
  });
  app.post(`${base}/rules/preview`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = mailRulesPreviewInputSchema.parse(request.body);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const state = await readRules(tx, owner.id);
      return mailRulesPreviewSchema.parse({
        revision: state.revision,
        decisions: await decisions(tx, owner.id, input.messages, state.rules),
      });
    });
  });
  app.post(`${base}/rules/apply`, async (request) => {
    const owner = await auth.requireUser(request);
    const input = mailRulesApplyInputSchema.parse(request.body);
    return mailRulesApplyResultSchema.parse(
      await mutate(
        database,
        owner.id,
        input.operationId,
        { kind: 'mail.rules.apply', ...input },
        async (tx) => {
          await lockRules(tx, owner.id, input.expectedRevision);
          const state = await readRules(tx, owner.id);
          const proposed = await decisions(
            tx,
            owner.id,
            input.messages,
            state.rules,
            true,
          );
          const changed = proposed.filter((decision) => decision.changed);
          for (const decision of changed)
            await tx.query(
              'UPDATE email_messages SET category=$3,category_source=$4,category_rule_id=$5,category_rule_capture=$6::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
              [
                owner.id,
                decision.id,
                decision.category,
                decision.categorySource,
                decision.categoryRuleId,
                decision.capture ? JSON.stringify(decision.capture) : null,
              ],
            );
          return {
            changed: changed.length,
            messages: proposed.map((decision) =>
              mailCategoryResultSchema.parse({
                ...decision,
                version: Number(decision.version) + (decision.changed ? 1 : 0),
              }),
            ),
          };
        },
        {
          // Collector refreshes lock message rows too. Retry only rolled-back
          // serialization/deadlock conflicts; receipts keep application once-only.
          isolation: 'repeatable read',
          authorize: async (tx) => {
            if (!(await auth.currentUser(request, tx)))
              throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
          },
        },
      ),
    );
  });
}
