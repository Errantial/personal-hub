import { randomUUID } from 'node:crypto';
import {
  studyPreferencesInputSchema,
  studyPreferencesSchema,
  taskSchema,
  calendarRecordSchema,
} from '@hub/contracts';
import type { AssistantProposal } from '@hub/contracts';
import type { PlannerContext } from './live-projections.js';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { taskColumns, saveTask } from '../planner/routes.js';
import { saveEvent } from '../features/calendar.js';
import { eventColumns } from '../features/common.js';
import { restorePlannerItem } from '../planner/restore.js';
import { readStudyPreferences } from '../features/study-engine.js';
import { recordCapabilityAudit } from '../features/capability-audit.js';
import { transactionDatabase } from '../planner/nested-database.js';

type Risk = 1 | 2 | 3;
type Definition = {
  tier: Risk;
  schema: z.ZodTypeAny;
  summary: (args: Record<string, unknown>) => string;
};

const idVersion = z.strictObject({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
const deleteScope = z.strictObject({
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  scope: z.enum(['this', 'future', 'series']).optional(),
});
const preferences = z.strictObject({
  timeZone: studyPreferencesInputSchema.shape.timeZone.optional(),
  sessionMinutes: studyPreferencesInputSchema.shape.sessionMinutes.optional(),
  breakMinutes: studyPreferencesInputSchema.shape.breakMinutes.optional(),
  dailyMaximumMinutes:
    studyPreferencesInputSchema.shape.dailyMaximumMinutes.optional(),
  windows: studyPreferencesInputSchema.shape.windows.optional(),
});

export const capabilityDefinitions: Record<string, Definition> = {
  'task.delete': {
    tier: 2,
    schema: deleteScope,
    summary: (args) =>
      args.scope === 'series'
        ? 'Delete repeating task series (approval required)'
        : args.scope === 'future'
          ? 'Delete this and future task occurrences (approval required)'
          : 'Delete task (approval required)',
  },
  'task.restore': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Restore task from Recently deleted',
  },
  'event.delete': {
    tier: 2,
    schema: deleteScope,
    summary: () => 'Delete calendar event series (approval required)',
  },
  'event.restore': {
    tier: 2,
    schema: idVersion,
    summary: () => 'Restore calendar event from Recently deleted',
  },
  'study.preferences.update': {
    tier: 1,
    schema: preferences,
    summary: () => 'Update study availability preferences',
  },
};

/** Resolves a model tool call (refs, not private IDs) into a checked proposal. */
export function modelCapabilityProposal(
  capability: string,
  rawArguments: string,
  context: PlannerContext,
): AssistantProposal | null {
  const definition = capabilityDefinitions[capability];
  if (!definition) return null;
  let arguments_: Record<string, unknown>;
  try {
    arguments_ = JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (capability === 'task.delete' || capability === 'event.delete') {
    const ref = typeof arguments_.ref === 'string' ? arguments_.ref : '';
    const match = /^([te])(\d+)$/.exec(ref);
    if (!match) return null;
    const list = match[1] === 't' ? context.tasks : context.events;
    const target = list[Number(match[2]) - 1];
    if (!target) return null;
    arguments_ = {
      id: target.id,
      expectedVersion: target.version,
      ...(arguments_.scope === 'this' ||
      arguments_.scope === 'future' ||
      arguments_.scope === 'series'
        ? { scope: arguments_.scope }
        : {}),
    };
  }
  const parsed = definition.schema.safeParse(arguments_);
  if (!parsed.success) return null;
  return proposal(
    capability,
    parsed.data as Record<string, unknown>,
    definition.tier,
  );
}

export function capabilityNames() {
  return Object.keys(capabilityDefinitions);
}

function proposal(
  capability: string,
  args: Record<string, unknown>,
  tier: Risk,
): AssistantProposal {
  return {
    kind: 'capability',
    capability,
    arguments: args,
    summary: capabilityDefinitions[capability]!.summary(args),
    tier,
  };
}

export async function executeCapability(
  database: Database,
  owner: string,
  turnId: string,
  capability: string,
  raw: unknown,
  operationId: string,
  agentId?: string,
  autoApproved = false,
) {
  const definition = capabilityDefinitions[capability];
  if (!definition)
    throw new ApiError(400, 'CAPABILITY_UNKNOWN', 'Unknown agent capability.');
  const args = definition.schema.parse(raw) as Record<string, unknown>;
  if (capability === 'event.delete' && args.scope && args.scope !== 'series')
    throw new ApiError(
      400,
      'CAPABILITY_SCOPE',
      'Event occurrence deletion is not available to this capability.',
    );
  const summary = definition.summary(args);
  const [existing] = await database.query(
    'SELECT id FROM ai_capability_audit WHERE owner_id=$1 AND operation_id=$2 AND tool=$3 LIMIT 1',
    [owner, operationId, capability],
  );
  if (existing) return { id: String(existing.id), version: 1 };
  const auditId = await database.transaction(async (tx) => {
    let before: unknown = null;
    let after: unknown = null;
    if (capability === 'task.delete' || capability === 'task.restore') {
      const id = String(args.id);
      const [row] = await tx.query(
        `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Task not available.');
      before = taskSchema.parse(row);
      if (capability === 'task.delete')
        await saveTask(transactionDatabase(tx), owner, 'DELETE', id, {
          operationId,
          expectedVersion: args.expectedVersion,
          ...(args.scope ? { scope: args.scope } : {}),
        });
      else
        await restorePlannerItem(
          tx,
          'tasks',
          taskColumns,
          owner,
          id,
          Number(args.expectedVersion),
        );
      const [next] = await tx.query(
        `SELECT ${taskColumns} FROM tasks WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      after = taskSchema.parse(next);
    } else if (
      capability === 'event.delete' ||
      capability === 'event.restore'
    ) {
      const id = String(args.id);
      const [row] = await tx.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      if (!row)
        throw new ApiError(404, 'NOT_FOUND', 'Calendar event not available.');
      before = calendarRecordSchema.parse(row);
      if (capability === 'event.delete')
        await saveEvent(transactionDatabase(tx), owner, 'DELETE', id, {
          operationId,
          expectedVersion: args.expectedVersion,
        });
      else
        await restorePlannerItem(
          tx,
          'events',
          eventColumns,
          owner,
          id,
          Number(args.expectedVersion),
        );
      const [next] = await tx.query(
        `SELECT ${eventColumns} FROM events WHERE owner_id=$1 AND id=$2`,
        [owner, id],
      );
      after = calendarRecordSchema.parse(next);
    } else if (capability === 'study.preferences.update') {
      const current = await readStudyPreferences(tx, owner);
      before = current;
      const settings = studyPreferencesInputSchema.parse({
        timeZone: current.timeZone,
        sessionMinutes: current.sessionMinutes,
        breakMinutes: current.breakMinutes,
        dailyMaximumMinutes: current.dailyMaximumMinutes,
        windows: current.windows,
        ...args,
      });
      await tx.query(
        'INSERT INTO study_preferences(owner_id,settings,version) VALUES($1,$2::jsonb,2) ON CONFLICT(owner_id) DO UPDATE SET settings=EXCLUDED.settings,version=study_preferences.version+1,updated_at=CURRENT_TIMESTAMP',
        [owner, JSON.stringify(settings)],
      );
      after = studyPreferencesSchema.parse({
        ...settings,
        version: Number(current.version) + 1,
        updatedAt: new Date().toISOString(),
      });
    }
    return recordCapabilityAudit(
      tx,
      owner,
      turnId,
      proposal(capability, args, definition.tier),
      'applied',
      {
        agentId,
        operationId,
        before,
        after,
        undoable: true,
        reason: summary,
        tool: capability,
        autoApproved,
      },
    );
  });
  return { id: auditId, version: 1 };
}

export async function undoCapability(
  database: Database,
  owner: string,
  auditId: string,
  operationId: string = randomUUID(),
) {
  return database.transaction(async (tx) => {
    const [row] = await tx.query(
      `SELECT capability,tool,operation_id,before,after,undoable,undone_at
       FROM ai_capability_audit WHERE owner_id=$1 AND id=$2 FOR UPDATE`,
      [owner, auditId],
    );
    if (!row || !row.undoable)
      throw new ApiError(404, 'NOT_FOUND', 'This action cannot be undone.');
    if (row.undone_at)
      throw new ApiError(
        409,
        'ALREADY_UNDONE',
        'This action was already undone.',
      );
    const before =
      typeof row.before === 'string' ? JSON.parse(row.before) : row.before;
    const after =
      typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
    if (row.tool === 'task.delete') {
      await restorePlannerItem(
        tx,
        'tasks',
        taskColumns,
        owner,
        after.id,
        after.version,
      );
    } else if (row.tool === 'task.restore') {
      await saveTask(transactionDatabase(tx), owner, 'DELETE', after.id, {
        operationId,
        expectedVersion: after.version,
      });
    } else if (row.tool === 'event.delete') {
      await restorePlannerItem(
        tx,
        'events',
        eventColumns,
        owner,
        after.id,
        after.version,
      );
    } else if (row.tool === 'event.restore') {
      await saveEvent(transactionDatabase(tx), owner, 'DELETE', after.id, {
        operationId,
        expectedVersion: after.version,
      });
    } else if (row.tool === 'study.preferences.update') {
      const current = await readStudyPreferences(tx, owner);
      if (current.version !== after.version)
        throw new ApiError(
          409,
          'VERSION_CONFLICT',
          'Study preferences changed again; undo would overwrite them.',
        );
      const restored = studyPreferencesInputSchema.parse({
        timeZone: before.timeZone,
        sessionMinutes: before.sessionMinutes,
        breakMinutes: before.breakMinutes,
        dailyMaximumMinutes: before.dailyMaximumMinutes,
        windows: before.windows,
      });
      await tx.query(
        'UPDATE study_preferences SET settings=$2::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1',
        [owner, JSON.stringify(restored)],
      );
    } else {
      throw new ApiError(
        400,
        'CAPABILITY_NOT_UNDOABLE',
        'This action cannot be undone.',
      );
    }
    await tx.query(
      'UPDATE ai_capability_audit SET undone_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND id=$2',
      [owner, auditId],
    );
    await tx.query(
      `INSERT INTO ai_capability_audit
        (id,owner_id,capability,action,target_kind,target_id,decision,reason,
         operation_id,before,after,undoable,tool,auto_approved)
       VALUES($1,$2,$3,'restore',$4,$5,'applied',$6,$7,$8::jsonb,$9::jsonb,
         false,'undo',false)`,
      [
        randomUUID(),
        owner,
        row.capability,
        row.tool === 'task.delete' || row.tool === 'task.restore'
          ? 'task'
          : row.tool === 'event.delete' || row.tool === 'event.restore'
            ? 'event'
            : null,
        after?.id ?? null,
        `Undid ${row.tool ?? 'capability action'}.`,
        operationId,
        JSON.stringify(after),
        JSON.stringify(before),
      ],
    );
    return { undone: true };
  });
}
