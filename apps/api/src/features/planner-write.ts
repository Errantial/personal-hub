import type { PlannedRequest } from '@hub/contracts';
import type { Database } from '../db/database.js';
import { saveTask } from '../planner/routes.js';
import { saveAcademicPlanning } from './academic-planning.js';
import { saveEvent } from './calendar.js';
import { cancelReminderProposal, saveReminderProposal } from './reminders.js';
import { executeCapability, undoCapability } from '../ai/capabilities.js';

const plannerPath = /^\/api\/v1\/(tasks|calendar)(?:\/([0-9a-f-]{36}))?$/i;

/**
 * Sends one Apply/Undo planner write (built by applyRequest/undoRequest) on
 * the server, through the same versioned mutation the browser's request
 * would reach. Used by the agent worker (D57).
 */
export async function plannedWrite(
  database: Database,
  owner: string,
  request: PlannedRequest,
  audit?: {
    turnId: string;
    agentId?: string | undefined;
    autoApproved?: boolean;
  },
): Promise<{ id: string; version: number }> {
  if (request.path === '/internal/ai/capability') {
    if (!audit) throw new Error('Capability execution needs a turn.');
    return executeCapability(
      database,
      owner,
      audit.turnId,
      String(request.body.capability),
      request.body.arguments,
      String(request.body.operationId),
      audit.agentId,
      audit.autoApproved ?? false,
    );
  }
  if (request.path === '/internal/ai/capability/undo') {
    await undoCapability(database, owner, String(request.body.auditId));
    return { id: String(request.body.auditId), version: 1 };
  }
  const academic =
    /^\/api\/v1\/academic-work\/([0-9a-f-]{36})\/planner-work$/i.exec(
      request.path,
    );
  if (academic && request.method === 'POST') {
    const result = await saveAcademicPlanning(
      database,
      owner,
      academic[1]!,
      request.body,
      true,
    );
    const item = result.kind === 'task' ? result.task : result.event;
    return { id: item.id, version: item.version };
  }
  const control = /^\/api\/v1\/reminders\/([0-9a-f-]{36})\/control$/i.exec(
    request.path,
  );
  if (control && request.method === 'POST') {
    const { reminder } = await cancelReminderProposal(
      database,
      owner,
      control[1]!,
      request.body,
    );
    return { id: reminder.id, version: reminder.version };
  }
  if (
    /^\/api\/v1\/reminders(?:\/[0-9a-f-]{36})?$/i.test(request.path) &&
    (request.method === 'POST' || request.method === 'PUT')
  ) {
    const id =
      request.method === 'PUT' ? request.path.split('/').at(-1)! : null;
    const { reminder } = await saveReminderProposal(
      database,
      owner,
      request.method,
      id,
      request.body,
    );
    return { id: reminder.id, version: reminder.version };
  }
  const match = plannerPath.exec(request.path);
  if (!match) throw new Error(`Unsupported planner path ${request.path}`);
  const [, table, id = null] = match;
  if (table === 'tasks') {
    const { task } = await saveTask(
      database,
      owner,
      request.method,
      id,
      request.body,
    );
    return { id: task.id, version: task.version };
  }
  const { event } = await saveEvent(
    database,
    owner,
    request.method,
    id,
    request.body,
  );
  return { id: event.id, version: event.version };
}
