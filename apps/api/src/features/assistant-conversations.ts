import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  assistantConversationDeleteSchema,
  assistantConversationDeletedSchema,
  assistantConversationListSchema,
  assistantConversationResponseSchema,
  assistantItemsUpdateSchema,
  assistantProposalSchema,
  assistantTurnResponseSchema,
} from '@hub/contracts';
import type {
  AssistantItem,
  AssistantProposal,
  AssistantTurn,
} from '@hub/contracts';
import { z } from 'zod';
import type { authService } from '../auth/routes.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import { liveReceipt } from '../ai/live-request.js';
import { stamp } from './common.js';

// Assistant conversations (docs/ai-assistant.md, D55): asks, replies,
// proposals and their applied/undone state live on the owner's server.
// Deleting a conversation keeps a tombstone and clears its text.

/** Turns resent as context: the newest that fit, oldest first. */
const historyTurns = 10;
const historyChars = 8000;

const idSchema = z.object({ id: z.string().uuid() });
const notFound = () =>
  new ApiError(404, 'NOT_FOUND', 'This conversation no longer exists.');

const conversationColumns = `c.id,c.title,c.version,${stamp('c.created_at', 'createdAt')},${stamp('c.updated_at', 'updatedAt')},(SELECT count(*)::int FROM ai_conversation_turns t WHERE t.conversation_id=c.id) AS "turnCount"`;

/**
 * Creates the conversation on its first ask (the first ask is its title), or
 * locks an existing one so turn positions stay in order.
 */
export async function openConversation(
  tx: QueryExecutor,
  owner: string,
  id: string,
  ask: string,
) {
  await tx.query(
    `INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING`,
    [id, owner, ask.replace(/\s+/g, ' ').trim().slice(0, 80)],
  );
  const [row] = await tx.query(
    'SELECT owner_id,deleted_at FROM ai_conversations WHERE id=$1 FOR UPDATE',
    [id],
  );
  if (!row || row.owner_id !== owner || row.deleted_at !== null)
    throw notFound();
}

/** Earlier asks and replies to resend, within the turn and size limits. */
export async function readHistory(
  tx: QueryExecutor,
  owner: string,
  conversationId: string,
) {
  const rows = await tx.query(
    `SELECT ask,reply FROM ai_conversation_turns WHERE owner_id=$1 AND conversation_id=$2 AND ask IS NOT NULL AND reply IS NOT NULL ORDER BY position DESC LIMIT ${historyTurns}`,
    [owner, conversationId],
  );
  const history: { ask: string; reply: string }[] = [];
  let size = 0;
  for (const row of rows) {
    size += String(row.ask).length + String(row.reply).length;
    if (size > historyChars) break;
    history.unshift({ ask: String(row.ask), reply: String(row.reply) });
  }
  return history;
}

/** Records the ask before anything is sent, so a retry finds its turn. */
export async function startTurn(
  database: Database,
  owner: string,
  turn: { id: string; conversationId: string; ask: string },
) {
  await database.transaction(async (tx) => {
    await openConversation(tx, owner, turn.conversationId, turn.ask);
    await tx.query(
      `INSERT INTO ai_conversation_turns(id,owner_id,conversation_id,position,ask)
       VALUES($1,$2,$3,(SELECT COALESCE(max(position)+1,0) FROM ai_conversation_turns WHERE conversation_id=$3),$4)`,
      [turn.id, owner, turn.conversationId, turn.ask],
    );
    await tx.query(
      'UPDATE ai_conversations SET updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1',
      [turn.conversationId],
    );
  });
}

/** Stores the answer; every proposal starts unapplied with fresh write IDs. */
export async function finishTurn(
  database: Database,
  owner: string,
  id: string,
  answer: { reply: string | null; proposals: AssistantProposal[] } | null,
) {
  const items: AssistantItem[] = (answer?.proposals ?? []).map(() => ({
    state: 'proposed',
    applied: null,
    error: null,
    applyId: randomUUID(),
    undoId: randomUUID(),
  }));
  await database.query(
    `UPDATE ai_conversation_turns SET reply=$3,proposals=$4,items=$5,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2`,
    [
      owner,
      id,
      answer?.reply ?? null,
      JSON.stringify(answer?.proposals ?? []),
      JSON.stringify(items),
    ],
  );
}

const turnColumns = `t.id,t.conversation_id AS "conversationId",t.ask,t.reply,t.proposals,t.items,t.version`;

function toTurn(
  row: Record<string, unknown>,
  receipt: Awaited<ReturnType<typeof liveReceipt>>,
): AssistantTurn {
  const proposals = z
    .array(assistantProposalSchema)
    .parse(
      typeof row.proposals === 'string'
        ? JSON.parse(row.proposals)
        : row.proposals,
    );
  const items = (
    typeof row.items === 'string' ? JSON.parse(row.items) : row.items
  ) as AssistantItem[];
  const answered = row.reply !== null || proposals.length > 0;
  return {
    id: row.id as string,
    conversationId: row.conversationId as string,
    ask: (row.ask as string | null) ?? '',
    version: row.version as number,
    items,
    request: {
      ...(receipt as AssistantTurn['request']),
      resultAvailable: answered,
      reply: (row.reply as string | null) ?? null,
      proposals,
    },
  };
}

/** One turn with its request receipt; null when it does not exist yet. */
export async function readTurn(database: Database, owner: string, id: string) {
  const [row] = await database.query(
    `SELECT ${turnColumns} FROM ai_conversation_turns t JOIN ai_conversations c ON c.id=t.conversation_id WHERE t.owner_id=$1 AND t.id=$2 AND c.deleted_at IS NULL`,
    [owner, id],
  );
  if (!row) return null;
  return toTurn(row, await liveReceipt(database, owner, id));
}

export function registerAssistantConversations(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/assistant/conversations';

  app.get(base, async (request) => {
    const owner = await auth.requireUser(request);
    const conversations = await database.query(
      `SELECT ${conversationColumns} FROM ai_conversations c WHERE c.owner_id=$1 AND c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM ai_conversation_turns t WHERE t.conversation_id=c.id) ORDER BY c.updated_at DESC LIMIT 100`,
      [owner.id],
    );
    return assistantConversationListSchema.parse({ conversations });
  });

  app.get(`${base}/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const [conversation] = await database.query(
      `SELECT ${conversationColumns} FROM ai_conversations c WHERE c.owner_id=$1 AND c.id=$2 AND c.deleted_at IS NULL`,
      [owner.id, id],
    );
    if (!conversation) throw notFound();
    const rows = await database.query(
      `SELECT ${turnColumns} FROM ai_conversation_turns t WHERE t.owner_id=$1 AND t.conversation_id=$2 ORDER BY t.position`,
      [owner.id, id],
    );
    const turns = [];
    for (const row of rows)
      turns.push(
        toTurn(row, await liveReceipt(database, owner.id, row.id as string)),
      );
    return assistantConversationResponseSchema.parse({ conversation, turns });
  });

  app.delete(`${base}/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = assistantConversationDeleteSchema.parse(request.body ?? {});
    await database.transaction(async (tx) => {
      const [row] = await tx.query(
        'SELECT version,deleted_at FROM ai_conversations WHERE owner_id=$1 AND id=$2 FOR UPDATE',
        [owner.id, id],
      );
      if (!row) throw notFound();
      // Repeating a delete is harmless.
      if (row.deleted_at !== null) return;
      if (row.version !== input.expectedVersion)
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'This conversation changed. Reload it first.',
        );
      await tx.query(
        `UPDATE ai_conversations SET title='',deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1`,
        [id],
      );
      await tx.query(
        `UPDATE ai_conversation_turns SET ask=NULL,reply=NULL,proposals='[]',items='[]',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE conversation_id=$1`,
        [id],
      );
    });
    return assistantConversationDeletedSchema.parse({ deleted: true });
  });

  // Records Apply/Undo results so other devices show them and reuse the
  // same write IDs.
  app.put('/api/v1/assistant/turns/:id/items', async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = assistantItemsUpdateSchema.parse(request.body);
    await database.transaction(async (tx) => {
      const [row] = await tx.query(
        `SELECT t.items,t.version FROM ai_conversation_turns t JOIN ai_conversations c ON c.id=t.conversation_id WHERE t.owner_id=$1 AND t.id=$2 AND c.deleted_at IS NULL FOR UPDATE OF t`,
        [owner.id, id],
      );
      if (!row) throw notFound();
      if (row.version !== input.expectedVersion)
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'These changes were updated on another device. Reload first.',
        );
      const stored = (
        typeof row.items === 'string' ? JSON.parse(row.items) : row.items
      ) as AssistantItem[];
      const same =
        stored.length === input.items.length &&
        stored.every(
          (item, index) =>
            item.applyId === input.items[index]!.applyId &&
            item.undoId === input.items[index]!.undoId,
        );
      if (!same)
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'The changes do not match this answer.',
        );
      await tx.query(
        'UPDATE ai_conversation_turns SET items=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
        [owner.id, id, JSON.stringify(input.items)],
      );
    });
    const turn = await readTurn(database, owner.id, id);
    return assistantTurnResponseSchema.parse({ turn });
  });
}
