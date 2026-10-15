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
  AssistantMailSent,
  AssistantProposal,
  AssistantTurn,
} from '@hub/contracts';
import { z } from 'zod';
import type { authService } from '../auth/routes.js';
import type { Database, QueryExecutor } from '../db/database.js';
import { ApiError } from '../errors.js';
import {
  historyRefs,
  liveManifestSchema,
  maxHistorySources,
  turnDigest,
} from '../ai/live-manifest.js';
import { liveReceipt } from '../ai/live-request.js';
import { stamp } from './common.js';

// Assistant conversations (docs/ai-assistant.md, D55): asks, replies,
// proposals and their applied/undone state live on the owner's server.
// Deleting a conversation keeps a tombstone and clears its text.

const idSchema = z.object({ id: z.string().uuid() });
const notFound = () =>
  new ApiError(404, 'NOT_FOUND', 'This conversation no longer exists.');

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** The pinned agent's state for its thread (D57); null for ordinary threads. */
const agentSummary = `(SELECT json_build_object('id',r.id,'title',r.title,'status',r.status,'pauseReason',r.pause_reason,
  'nextRunAt',CASE WHEN r.status='active' THEN ${utc('s.next_due_at')} END,
  'lastOutcome',(SELECT outcome FROM responsibility_runs x WHERE x.responsibility_id=r.id AND x.finished_at IS NOT NULL ORDER BY x.finished_at DESC LIMIT 1),
  'lastRunAt',(SELECT ${utc('max(x.finished_at)')} FROM responsibility_runs x WHERE x.responsibility_id=r.id))
  FROM responsibilities r LEFT JOIN responsibility_schedules s ON s.owner_id=r.owner_id AND s.responsibility_id=r.id AND s.deleted_at IS NULL
  WHERE r.id=c.responsibility_id AND r.deleted_at IS NULL AND r.status<>'cancelled') AS agent`;
const conversationColumns = `c.id,c.title,c.version,${stamp('c.created_at', 'createdAt')},${stamp('c.updated_at', 'updatedAt')},(SELECT count(*)::int FROM ai_conversation_turns t WHERE t.conversation_id=c.id) AS "turnCount",${agentSummary}`;

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

/** Records the ask before anything is sent, so a retry finds its turn. */
export async function startTurn(
  database: Database,
  owner: string,
  turn: {
    id: string;
    conversationId: string;
    ask: string;
    useMail: boolean;
    trigger: 'owner' | 'agent';
  },
) {
  await database.transaction(async (tx) => {
    await openConversation(tx, owner, turn.conversationId, turn.ask);
    await tx.query(
      `INSERT INTO ai_conversation_turns(id,owner_id,conversation_id,position,ask,use_mail,trigger)
       VALUES($1,$2,$3,(SELECT COALESCE(max(position)+1,0) FROM ai_conversation_turns WHERE conversation_id=$3),$4,$5,$6)`,
      [
        turn.id,
        owner,
        turn.conversationId,
        turn.ask,
        turn.useMail,
        turn.trigger,
      ],
    );
    await tx.query(
      'UPDATE ai_conversations SET updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1',
      [turn.conversationId],
    );
  });
}

/** Links a later call of a mail-enabled ask to its turn. */
export async function recordRound(
  database: Database,
  round: { requestId: string; turnId: string; round: number },
) {
  await database.query(
    'INSERT INTO ai_conversation_turn_rounds(request_id,turn_id,round) VALUES($1,$2,$3)',
    [round.requestId, round.turnId, round.round],
  );
}

/** Stores the answer; every proposal starts unapplied with fresh write IDs. */
export async function finishTurn(
  database: Database,
  owner: string,
  id: string,
  answer: { reply: string | null; proposals: AssistantProposal[] } | null,
  mail: {
    mail: AssistantMailSent[];
    mailWithheld: number;
    mailNote: string | null;
    proposalAccess?: 'read-only' | 'applicable';
    binding?: { requestId: string } | null;
  } = { mail: [], mailWithheld: 0, mailNote: null },
) {
  const items: AssistantItem[] = (answer?.proposals ?? []).map(() => ({
    state: 'proposed',
    applied: null,
    error: null,
    applyId: randomUUID(),
    undoId: randomUUID(),
  }));
  await database.transaction(async (tx) => {
    // Serialize with conversation deletion before touching its turns. A late
    // provider reply remains charged but may not resurrect cleared text.
    const parent = await tx.query(
      'SELECT c.id FROM ai_conversations c JOIN ai_conversation_turns t ON t.conversation_id=c.id WHERE t.owner_id=$1 AND t.id=$2 AND c.deleted_at IS NULL FOR SHARE OF c',
      [owner, id],
    );
    if (!parent.length) return;
    let digest: string | null = null;
    let sources: ReturnType<typeof historyRefs> | null = null;
    if (mail.binding && answer?.reply) {
      const [exchange] = await tx.query(
        "SELECT manifest FROM ai_live_exchanges WHERE owner_id=$1 AND request_id=$2 AND guard_state='verified'",
        [owner, mail.binding.requestId],
      );
      if (exchange) {
        const manifest = liveManifestSchema.parse(
          typeof exchange.manifest === 'string'
            ? JSON.parse(exchange.manifest)
            : exchange.manifest,
        );
        const refs = historyRefs(manifest);
        const [turn] = await tx.query(
          'SELECT ask FROM ai_conversation_turns WHERE owner_id=$1 AND id=$2',
          [owner, id],
        );
        if (turn?.ask !== null && turn && refs.length <= maxHistorySources) {
          sources = refs;
          digest = turnDigest(owner, id, String(turn.ask), answer.reply);
        }
      }
    }
    await tx.query(
      `UPDATE ai_conversation_turns SET reply=$3,proposals=$4,items=$5,mail=$6,mail_withheld=$7,mail_note=$8,proposal_access=$9,inference_history=$10,inference_digest=$11,inference_sources=$12,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2`,
      [
        owner,
        id,
        answer?.reply ?? null,
        JSON.stringify(answer?.proposals ?? []),
        JSON.stringify(items),
        JSON.stringify(mail.mail),
        mail.mailWithheld,
        mail.mailNote,
        mail.proposalAccess ?? 'applicable',
        digest ? 'bound' : 'unbound',
        digest,
        sources ? JSON.stringify(sources) : null,
      ],
    );
  });
}

const turnColumns = `t.id,t.conversation_id AS "conversationId",t.ask,t.reply,t.proposals,t.items,t.version,t.use_mail AS "useMail",t.mail,t.mail_withheld AS "mailWithheld",t.mail_note AS "mailNote",t.trigger,t.not_allowed AS "notAllowed",t.inference_history AS "inferenceHistory",t.proposal_access AS "proposalAccess"`;
const json = (value: unknown) =>
  typeof value === 'string' ? JSON.parse(value) : value;

type Receipt = Awaited<ReturnType<typeof liveReceipt>> & {
  status?: string;
  reason?: string | null;
};
/**
 * The turn's receipt: the first call's, with costs and holds summed over
 * every call and the status and reason of the last one.
 */
async function turnReceipt(database: Database, owner: string, id: string) {
  const first = (await liveReceipt(database, owner, id)) as Receipt;
  const rounds = await database.query(
    'SELECT request_id FROM ai_conversation_turn_rounds WHERE turn_id=$1 ORDER BY round',
    [id],
  );
  if (!rounds.length) return first;
  const later: Receipt[] = [];
  for (const row of rounds)
    later.push(
      (await liveReceipt(database, owner, row.request_id as string)) as Receipt,
    );
  const all = [first, ...later];
  const last = later[later.length - 1]!;
  const costs = all
    .map((item) => item.costMicros)
    .filter((value): value is number => value !== null);
  return {
    ...first,
    status: last.status,
    reason: last.reason,
    costMicros: costs.length
      ? costs.reduce((sum, value) => sum + value, 0)
      : null,
    heldMicros: all.reduce((sum, item) => sum + item.heldMicros, 0),
  };
}

function toTurn(
  row: Record<string, unknown>,
  receipt: Awaited<ReturnType<typeof turnReceipt>>,
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
    useMail: row.useMail === true,
    trigger: row.trigger === 'agent' ? 'agent' : 'owner',
    notAllowed: Number(row.notAllowed ?? 0),
    mail: ((json(row.mail) ?? []) as AssistantMailSent[]).map((item) => ({
      ...item,
      truncated: item.truncated === true,
    })),
    mailWithheld: Number(row.mailWithheld ?? 0),
    mailNote: (row.mailNote as string | null) ?? null,
    inferenceHistory: row.inferenceHistory === 'bound' ? 'bound' : 'unbound',
    proposalAccess:
      row.proposalAccess === 'read-only' ? 'read-only' : 'applicable',
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
  return toTurn(row, await turnReceipt(database, owner, id));
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
      `SELECT ${conversationColumns} FROM ai_conversations c WHERE c.owner_id=$1 AND c.deleted_at IS NULL AND (c.responsibility_id IS NOT NULL OR EXISTS (SELECT 1 FROM ai_conversation_turns t WHERE t.conversation_id=c.id)) ORDER BY c.updated_at DESC LIMIT 100`,
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
        toTurn(row, await turnReceipt(database, owner.id, row.id as string)),
      );
    return assistantConversationResponseSchema.parse({ conversation, turns });
  });

  app.delete(`${base}/:id`, async (request) => {
    const owner = await auth.requireUser(request);
    const { id } = idSchema.parse(request.params);
    const input = assistantConversationDeleteSchema.parse(request.body ?? {});
    await database.transaction(async (tx) => {
      const [row] = await tx.query(
        'SELECT version,deleted_at,responsibility_id FROM ai_conversations WHERE owner_id=$1 AND id=$2 FOR UPDATE',
        [owner.id, id],
      );
      if (!row) throw notFound();
      // Repeating a delete is harmless.
      if (row.deleted_at !== null) return;
      if (row.responsibility_id !== null)
        throw new ApiError(
          409,
          'AGENT_CONVERSATION',
          "This is an agent's conversation. Delete the agent instead.",
        );
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
        `UPDATE ai_conversation_turns SET ask=NULL,reply=NULL,proposals='[]',items='[]',inference_history='unbound',inference_digest=NULL,inference_sources=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE conversation_id=$1`,
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
        `SELECT t.items,t.version,t.proposal_access FROM ai_conversation_turns t JOIN ai_conversations c ON c.id=t.conversation_id WHERE t.owner_id=$1 AND t.id=$2 AND c.deleted_at IS NULL FOR UPDATE OF t`,
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
      if (
        row.proposal_access === 'read-only' &&
        stored.some(
          (item, index) =>
            item.state !== 'applied' &&
            item.state !== 'undone' &&
            input.items[index]?.state === 'applied',
        )
      )
        throw new ApiError(
          409,
          'PROPOSAL_READ_ONLY',
          "These suggestions came from mail and can't be applied yet.",
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
