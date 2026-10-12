import {
  aiActionSettingsSchema,
  aiActionWriteSchema,
  aiActionPreviewRequestSchema,
  aiActionPreviewResponseSchema,
  defaultAIActionPolicy,
} from '@hub/contracts';
import type {
  AIAction,
  AIActionSettings,
  AIActionPreview,
} from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { mutate } from '../planner/mutations.js';
import { version } from './common.js';
import { ApiError } from '../errors.js';

export async function readAIActionPolicy(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'SELECT version,policy FROM ai_action_policies WHERE owner_id=$1',
    [owner],
  );
  return aiActionSettingsSchema.parse(
    row ?? { version: 1, policy: defaultAIActionPolicy },
  );
}
export function previewAIAction(
  settings: AIActionSettings,
  action: AIAction,
): AIActionPreview {
  const group = action.kind.startsWith('task.')
    ? 'tasks'
    : action.kind.startsWith('calendar.')
      ? 'calendar'
      : 'email';
  const policyDecision = settings.policy[group];
  const emailApprovalRequired =
    action.kind === 'email.send' ||
    ('outboundEmail' in action && action.outboundEmail !== 'none');
  const writeCapability =
    action.connection === 'hub'
      ? 'local'
      : action.connection === 'canvas'
        ? 'read-only'
        : 'unverified';
  const blockers: AIActionPreview['blockers'] = [];
  if (policyDecision === 'blocked') blockers.push('POLICY_BLOCKED');
  if (policyDecision === 'approval-required' && action.kind !== 'email.send')
    blockers.push('OWNER_APPROVAL_REQUIRED');
  if (emailApprovalRequired) blockers.push('EMAIL_APPROVAL_REQUIRED');
  if (writeCapability === 'read-only') blockers.push('READ_ONLY_TARGET');
  if (writeCapability === 'unverified')
    blockers.push('WRITE_CAPABILITY_UNVERIFIED');
  if (emailApprovalRequired && action.connection === 'hub')
    blockers.push('OUTBOUND_EMAIL_UNSUPPORTED');
  blockers.push('ACTION_EXECUTION_UNAVAILABLE');
  return aiActionPreviewResponseSchema.parse({
    policyVersion: settings.version,
    action,
    policyDecision,
    emailApprovalRequired,
    writeCapability,
    executionEnabled: false,
    blockers,
  });
}
export function registerAIActions(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/ai/actions';
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return readAIActionPolicy(database, user.id);
  });
  app.put(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = aiActionWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.actions.permissions', input },
      async (tx) => {
        await tx.query(
          'INSERT INTO ai_action_policies(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
          [user.id],
        );
        const [row] = await tx.query(
          'UPDATE ai_action_policies SET policy=$3::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING version,policy',
          [user.id, input.expectedVersion, JSON.stringify(input.policy)],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload action permissions.',
          );
        return aiActionSettingsSchema.parse(row);
      },
    );
  });
  app.post(`${base}/preview`, async (request) => {
    const user = await auth.requireUser(request);
    const input = aiActionPreviewRequestSchema.parse(request.body);
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      if (!(await auth.currentUser(request, tx)))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again.');
      const settings = await readAIActionPolicy(tx, user.id);
      version(settings, input.expectedPolicyVersion);
      return previewAIAction(settings, input.action);
    });
  });
}
