import {
  sensitivitySchema,
  taskSchema,
  calendarRecordSchema,
} from '@hub/contracts';
import { z } from 'zod';
import type { QueryExecutor } from '../db/database.js';
import { taskColumns } from '../planner/routes.js';
import { eventColumns } from '../features/common.js';
import { openTask, openEvent } from './live-projections.js';
import {
  liveHistorySourceSchema,
  maxHistorySources,
  maxHistoryTurns,
  turnDigest,
} from './live-manifest.js';
import type { LiveHistorySource } from './live-manifest.js';
import {
  brokerLineageEligible,
  brokerDependencyCount,
} from './broker-lineage.js';

// Bound conversation history (docs/live-context-admission-design.md). Only
// turns whose kept reply came from a verified exchange are resent, together
// with the transitive sources they depended on. History stops at the first
// turn that is unbound or whose sources are no longer eligible; it is never
// certified by replaying today's source list.

const historyChars = 8000;
type Sensitivity = z.infer<typeof sensitivitySchema>;

const sameLabels = (a: Sensitivity[], b: Sensitivity[]) =>
  a.length === b.length && a.every((label) => b.includes(label));

/**
 * Whether every source a history turn depended on still exists with the
 * same labels (and connector version for mail) and may go to the approved
 * destination. Ordinary edits do not matter; deletion and relabeling do.
 */
export async function historySourcesEligible(
  tx: QueryExecutor,
  owner: string,
  refs: LiveHistorySource[],
  rules: { allowed: Sensitivity[]; useMail: boolean },
) {
  const brokers = refs.filter((ref) => ref.kind === 'mail-broker');
  if (brokers.length && !rules.useMail) return false;
  if (
    refs.length +
      (await brokerDependencyCount(
        tx,
        owner,
        brokers.map((ref) => ref.id),
      )) >
    maxHistorySources
  )
    return false;
  for (const ref of brokers)
    if (
      !ref.brokerDigest ||
      !(await brokerLineageEligible(tx, owner, ref.id, ref.brokerDigest))
    )
      return false;
  if (refs.some((ref) => ref.labels.some((l) => !rules.allowed.includes(l))))
    return false;
  const ids = (kind: LiveHistorySource['kind']) =>
    refs.filter((ref) => ref.kind === kind).map((ref) => ref.id);
  const mail = ids('mail-message');
  if (mail.length && !rules.useMail) return false;
  // Legacy direct-mail history has no broker scope receipt to reauthorize it.
  if (mail.length && !brokers.length) return false;
  const current = new Map<
    string,
    {
      labels: Sensitivity[];
      connector?: { id: string; version: number };
      academicCourse?: { id: string; version: number };
    }
  >();
  for (const [kind, table] of [
    ['task', 'tasks'],
    ['event', 'events'],
  ] as const) {
    const wanted = ids(kind);
    if (!wanted.length) continue;
    for (const row of await tx.query(
      `SELECT ${kind === 'task' ? taskColumns : eventColumns}, ai_origin AS "aiOrigin" FROM ${table} WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`,
      [owner, wanted],
    )) {
      const origin = String(row.aiOrigin ?? 'owner-entered');
      const eligible =
        kind === 'task'
          ? openTask(taskSchema.parse(row), origin)
          : openEvent(calendarRecordSchema.parse(row), origin);
      if (eligible)
        current.set(`${kind}:${row.id}`, {
          labels: [sensitivitySchema.parse(row.sensitivity)],
        });
    }
  }
  const academic = ids('academic-work');
  if (academic.length)
    for (const row of await tx.query(
      `SELECT w.id,w.sensitivity,w.academic_labels AS "academicLabels",w.course_id AS "courseId",c.sensitivity AS "courseSensitivity",c.version AS "courseVersion"
       FROM academic_work w JOIN courses c ON c.id=w.course_id AND c.owner_id=w.owner_id
       WHERE w.owner_id=$1 AND w.id=ANY($2::uuid[]) AND w.deleted_at IS NULL AND c.deleted_at IS NULL`,
      [owner, academic],
    ))
      current.set(`academic-work:${row.id}`, {
        labels: [
          ...new Set([
            sensitivitySchema.parse(row.sensitivity),
            sensitivitySchema.parse(row.courseSensitivity),
            ...sensitivitySchema
              .array()
              .max(2)
              .parse(row.academicLabels ?? []),
          ]),
        ],
        academicCourse: {
          id: String(row.courseId),
          version: Number(row.courseVersion),
        },
      });
  if (mail.length)
    for (const row of await tx.query(
      `SELECT m.id,m.sensitivity,m.text_origin,c.id AS "connectorId",c.sensitivity AS "connectorSensitivity",c.version AS "connectorVersion"
       FROM email_messages m JOIN email_connectors c ON c.id=m.connector_id AND c.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[])`,
      [owner, mail],
    ))
      if (row.text_origin === 'message-body-v1')
        current.set(`mail-message:${row.id}`, {
          labels: [
            ...new Set([
              sensitivitySchema.parse(row.sensitivity),
              sensitivitySchema.parse(row.connectorSensitivity),
            ]),
          ],
          connector: {
            id: String(row.connectorId),
            version: Number(row.connectorVersion),
          },
        });
  return refs.every((ref) => {
    if (ref.kind === 'mail-broker') return true;
    const now = current.get(`${ref.kind}:${ref.id}`);
    return (
      !!now &&
      sameLabels(now.labels, ref.labels) &&
      now.connector?.id === ref.connector?.id &&
      now.connector?.version === ref.connector?.version &&
      now.academicCourse?.id === ref.academicCourse?.id &&
      now.academicCourse?.version === ref.academicCourse?.version
    );
  });
}

export type BoundHistory = {
  history: { ask: string; reply: string }[];
  turns: { id: string; digest: string }[];
  sources: LiveHistorySource[];
  /** Earlier answered turns not sent. */
  withheld: number;
};

/** The resendable history of a conversation, newest turns first in, oldest first out. */
export async function readBoundHistory(
  tx: QueryExecutor,
  owner: string,
  conversationId: string,
  rules: { allowed: Sensitivity[]; useMail: boolean },
): Promise<BoundHistory> {
  const rows = await tx.query(
    `SELECT id,ask,reply,inference_history,inference_digest,inference_sources,COUNT(*) OVER() AS "answeredCount" FROM ai_conversation_turns
     WHERE owner_id=$1 AND conversation_id=$2 AND ask IS NOT NULL AND reply IS NOT NULL ORDER BY position DESC LIMIT $3`,
    [owner, conversationId, maxHistoryTurns],
  );
  const result: BoundHistory = {
    history: [],
    turns: [],
    sources: [],
    withheld: Number(rows[0]?.answeredCount ?? 0),
  };
  const union = new Map<string, LiveHistorySource>();
  let size = 0;
  for (const row of rows) {
    if (
      row.inference_history !== 'bound' ||
      row.inference_digest !==
        turnDigest(owner, String(row.id), String(row.ask), String(row.reply))
    )
      break;
    size += String(row.ask).length + String(row.reply).length;
    if (size > historyChars) break;
    let parsed;
    try {
      parsed = z
        .array(liveHistorySourceSchema)
        .max(maxHistorySources)
        .safeParse(
          typeof row.inference_sources === 'string'
            ? JSON.parse(row.inference_sources)
            : row.inference_sources,
        );
    } catch {
      break;
    }
    if (!parsed.success) break;
    const refs = parsed.data;
    if (
      refs.some((ref) => ref.kind === 'mail-message') &&
      !refs.some((ref) => ref.kind === 'mail-broker')
    )
      break;
    const merged = new Map(union);
    for (const ref of refs) merged.set(`${ref.kind}:${ref.id}`, ref);
    if (merged.size > maxHistorySources) break;
    if (!(await historySourcesEligible(tx, owner, [...merged.values()], rules)))
      break;
    union.clear();
    for (const [key, ref] of merged) union.set(key, ref);
    result.history.unshift({ ask: String(row.ask), reply: String(row.reply) });
    result.turns.unshift({
      id: String(row.id),
      digest: String(row.inference_digest),
    });
  }
  result.sources = [...union.values()];
  result.withheld -= result.turns.length;
  return result;
}
