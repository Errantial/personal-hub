import type { PlannedRequest } from '@hub/contracts';
import type { Database } from '../db/database.js';
import { saveTask } from '../planner/routes.js';
import { saveAcademicPlanning } from './academic-planning.js';
import { saveEvent } from './calendar.js';

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
): Promise<{ id: string; version: number }> {
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
