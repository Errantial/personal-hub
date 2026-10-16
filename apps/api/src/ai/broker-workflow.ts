import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import {
  beginBrokerRetrieval,
  readBrokerRetrieval,
  prepareBrokerPage,
} from './mail-broker.js';
import type { BrokerContext } from './mail-broker.js';
import {
  executeBrokerBatch,
  selectedBrokerMail,
  releaseBrokerHeadroom,
} from './broker-execution.js';
import type { OpenRouterFetch } from './openrouter-live.js';
import { lockBudget } from './budget.js';

/** Pins identity/deadline before the first paid batch. Retries reuse confirmed receipts. */
export async function openBrokerWorkflow(
  database: Database,
  owner: string,
  operationId: string,
  hash: string,
  conversationId: string,
) {
  return database.transaction(async (tx) => {
    await lockBudget(tx, owner);
    await tx.query(
      `INSERT INTO mail_broker_workflows(id,owner_id,operation_id,request_hash,conversation_id,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,operation_id) DO NOTHING`,
      [
        randomUUID(),
        owner,
        operationId,
        hash,
        conversationId,
        new Date(Date.now() + 120000),
      ],
    );
    const [row] = await tx.query(
      'SELECT id,request_hash,conversation_id,deadline_at FROM mail_broker_workflows WHERE owner_id=$1 AND operation_id=$2',
      [owner, operationId],
    );
    if (row!.request_hash !== hash)
      throw new ApiError(409, 'OPERATION_CONFLICT', 'Mail request changed.');
    return {
      id: String(row!.id),
      conversationId: String(row!.conversation_id),
      deadlineAt: new Date(row!.deadline_at as string | Date).toISOString(),
    };
  });
}

/** Only raw owner asks or server-read agent goals become broker intents. No model-generated request. */
export async function retrieveBrokerMail(
  database: Database,
  config: Config,
  fetcher: OpenRouterFetch,
  owner: string,
  workflowId: string,
  intent: string,
  context: BrokerContext,
  maxCandidates: number,
  authority?: (tx: QueryExecutor) => Promise<boolean>,
  continuation?: string,
) {
  const [grant] = await database.query(
    'SELECT id,version FROM mail_broker_grants WHERE owner_id=$1 AND agent_id IS NOT DISTINCT FROM $2::uuid AND enabled=true',
    [owner, context.agent?.id ?? null],
  );
  if (!grant)
    throw new ApiError(
      409,
      'MAIL_BROKER_APPROVAL_REQUIRED',
      'Enable an explicit broker mail scope before using mail.',
    );
  if (authority && !(await authority(database)))
    throw new ApiError(
      401,
      'MAIL_AUTHORITY_CHANGED',
      'Owner authorization expired.',
    );
  const started = await beginBrokerRetrieval(
    database,
    config,
    owner,
    {
      operationId: workflowId,
      grantId: String(grant.id),
      expectedGrantVersion: Number(grant.version),
      intent,
      maxCandidates,
      maxResults: 50,
      ...(continuation ? { continuation } : {}),
    },
    context,
  );
  const retrievalId = started.receipt.id;
  await database.query(
    'UPDATE mail_broker_workflows SET retrieval_id=$3 WHERE owner_id=$1 AND id=$2 AND (retrieval_id IS NULL OR retrieval_id=$3)',
    [owner, workflowId, retrievalId],
  );
  // Each durable batch is claimed at most once. A confirmed page can be resumed;
  // uncertain transport never authorizes a retry, a raw read or a downstream answer.
  const brokerFetch = ((url, init) =>
    fetcher(String(url), init!)) as typeof fetch;
  try {
    for (;;) {
      const row = await readBrokerRetrieval(database, owner, retrievalId);
      if (row.status === 'uncertain' || row.status === 'blocked')
        throw new ApiError(
          409,
          'MAIL_BROKER_INCOMPLETE',
          'Mail retrieval is blocked or uncertain. No mail was forwarded.',
        );
      if (row.position >= row.snapshot.length) break;
      const batch = await prepareBrokerPage(
        database,
        config,
        owner,
        retrievalId,
        row.cursor_token,
        intent,
      );
      const result = await executeBrokerBatch(
        database,
        config,
        owner,
        batch.id,
        intent,
        brokerFetch,
        { ...(authority ? { authority } : {}) },
      );
      if (result.status === 'uncertain' || result.status === 'blocked') {
        await releaseBrokerHeadroom(database, owner, retrievalId);
        throw new ApiError(
          409,
          'MAIL_BROKER_INCOMPLETE',
          'Mail retrieval is blocked or uncertain. No mail was forwarded.',
        );
      }
    }
    return await selectedBrokerMail(database, config, owner, retrievalId);
  } catch (error) {
    // Explicit guard/admission failures are terminal; a process loss is not.
    // Unknown batch usage stays held. Only the unsent answer headroom is released.
    if (
      error instanceof ApiError &&
      error.code !== 'MAIL_BROKER_INCOMPLETE' &&
      error.code !== 'MAIL_CURSOR_INVALID'
    ) {
      await database.transaction(async (tx) => {
        await lockBudget(tx, owner);
        await tx.query(
          "UPDATE mail_broker_retrievals SET status='blocked',coverage=jsonb_set(coverage,'{stopReason}','\"blocked\"') WHERE owner_id=$1 AND id=$2 AND status IN ('pending','partial','completed')",
          [owner, retrievalId],
        );
      });
      await releaseBrokerHeadroom(database, owner, retrievalId);
    }
    throw error;
  }
}
