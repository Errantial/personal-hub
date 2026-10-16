import { randomUUID } from 'node:crypto';
import { resolveLiveDestination } from '../../src/ai/live-destination.js';
import { sealEnvelope } from '../../src/ai/live-envelope.js';
import { transmitLive } from '../../src/ai/live-guard.js';
import type { GuardContext, LiveSealed } from '../../src/ai/live-guard.js';
import type { LiveManifest } from '../../src/ai/live-manifest.js';
import {
  academicSources,
  livePlannerContext,
  plannerSources,
  projectTask,
} from '../../src/ai/live-projections.js';
import type { AcademicContextItem } from '../../src/ai/live-projections.js';
import { admitLive, readAssistantSettings } from '../../src/ai/live-request.js';
import { model } from './openrouter.js';
import { pinnedRouting } from '../../src/ai/openrouter-live.js';
import type { Harness } from './openrouter.js';

// Synthetic sealed planner exchanges for live admission tests.

export const createTask = async (h: Harness, title: string) =>
  (
    await h.call('POST', '/api/v1/tasks', { title, operationId: randomUUID() })
  ).json().task as { id: string; version: number };

/** Seals and admits a planner exchange over the current live context. */
export async function admitPlanner(
  h: Harness,
  edit?: (sealed: LiveSealed) => LiveSealed,
  options: { conversationId?: string; academic?: AcademicContextItem[] } = {},
) {
  const requestId = randomUUID();
  const operationId = randomUUID();
  const settings = await readAssistantSettings(h.database, h.owner);
  const destination = await resolveLiveDestination(
    h.database,
    h.config,
    h.owner,
  );
  const context = await livePlannerContext(h.database, h.owner, {
    limit: 150,
  });
  const body = {
    model,
    max_tokens: 100,
    provider: pinnedRouting(destination.upstream),
    messages: [
      {
        role: 'user',
        content: JSON.stringify(
          context.tasks.map((task, i) => projectTask(task, `t${i + 1}`)),
        ),
      },
    ],
  };
  const manifest: LiveManifest = {
    formatVersion: 1,
    owner: h.owner,
    requestId,
    kind: 'planner',
    round: 1,
    conversationId: options.conversationId ?? null,
    priorRequestIds: [],
    destination,
    settingsVersion: settings.version,
    useMail: false,
    request: { provenance: 'owner-entered', labels: ['unlabeled'] },
    timeZone: 'UTC',
    history: { turns: [], sources: [], withheld: 0 },
    sources: [
      ...plannerSources(h.owner, requestId, context, 'UTC'),
      ...academicSources(h.owner, requestId, options.academic ?? []),
    ],
    bytes: Buffer.byteLength(JSON.stringify(body)),
  };
  let sealed: LiveSealed = sealEnvelope(h.owner, requestId, body, manifest);
  await admitLive(h.database, h.owner, {
    id: requestId,
    kind: 'planner',
    operationId,
    hash: 'synthetic-hash',
    model,
    maximumMicros: 1000,
    withheld: context.withheld,
    sealed,
  });
  if (edit) sealed = edit(sealed);
  return { sealed, operationId };
}

/** Request, hold and guard state of one exchange. */
export const exchangeState = async (h: Harness, requestId: string) =>
  (
    await h.database.query(
      `SELECT a.status,a.reason,b.status AS hold,b.actual_micros::int AS actual,x.guard_state AS guard
       FROM ai_assistant_requests a JOIN ai_budget_reservations b ON b.id=a.reservation_id
       JOIN ai_live_exchanges x ON x.request_id=a.id WHERE a.id=$1`,
      [requestId],
    )
  )[0];

export const transmit = (
  h: Harness,
  sealed: LiveSealed,
  context: GuardContext = {},
) =>
  transmitLive(
    h.database,
    h.config,
    h.fetcher,
    'sk-or-synthetic-test',
    sealed,
    context,
  );
