import {
  aiRoutingSettingsSchema,
  aiRoutingWriteSchema,
  aiRoutingPreviewSchema,
  aiRoutingPreviewResponseSchema,
  emptyAIRoutingPolicy,
  evaluateAIRouting,
  plannerSensitivity,
  plannerTextIsAttachmentDerived,
  taskSchema,
  calendarRecordSchema,
  sensitivitySchema,
} from '@hub/contracts';
import type { AIContextRef } from '@hub/contracts';
import type { FastifyInstance } from 'fastify';
import type { Database, QueryExecutor } from '../db/database.js';
import type { authService } from '../auth/routes.js';
import { ApiError } from '../errors.js';
import { mutate } from '../planner/mutations.js';
import { taskColumns } from '../planner/routes.js';
import { eventColumns, strongest, version } from './common.js';
export async function readAIRoutingPolicy(tx: QueryExecutor, owner: string) {
  const [row] = await tx.query(
    'SELECT version,policy FROM ai_routing_policies WHERE owner_id=$1',
    [owner],
  );
  return aiRoutingSettingsSchema.parse(
    row ?? { version: 1, policy: emptyAIRoutingPolicy },
  );
}
export async function resolveAIContext(
  tx: QueryExecutor,
  owner: string,
  ref: AIContextRef,
) {
  let sensitivity: 'unlabeled' | 'personal' | 'restricted';
  let attachmentDerived: boolean;
  let currentVersion: number;
  let labels: ('unlabeled' | 'personal' | 'restricted')[] = [];
  if (ref.kind === 'task' || ref.kind === 'event') {
    const [row] = await tx.query(
      `SELECT ${ref.kind === 'task' ? taskColumns : eventColumns} FROM ${ref.kind === 'task' ? 'tasks' : 'events'} WHERE owner_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [owner, ref.id],
    );
    if (!row)
      throw new ApiError(404, 'NOT_FOUND', 'Context source not available.');
    version(row, ref.expectedVersion);
    currentVersion = Number(row.version);
    const record =
      ref.kind === 'task'
        ? taskSchema.parse(row)
        : calendarRecordSchema.parse(row);
    sensitivity = plannerSensitivity(record);
    attachmentDerived = plannerTextIsAttachmentDerived(record);
    if (
      record.canvasSource &&
      !attachmentDerived &&
      (!record.canvasSource.labels || !record.canvasSource.currentLabels)
    )
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'Captured source labels need review before AI processing.',
      );
    labels = [
      record.sensitivity,
      ...(record.canvasSource?.labels ?? [
        record.canvasSource?.sensitivity ?? 'unlabeled',
      ]),
      ...(record.canvasSource?.currentLabels ?? [
        record.canvasSource?.currentSensitivity ?? 'unlabeled',
      ]),
    ];
    if (ref.kind === 'event') {
      const event = calendarRecordSchema.parse(row);
      if (!attachmentDerived && event.academicLabels === null)
        throw new ApiError(
          409,
          'PROVENANCE_UNAVAILABLE',
          'Academic label history is incomplete.',
        );
      labels.push(...(event.academicLabels ?? []));
      sensitivity = strongest(sensitivity, ...(event.academicLabels ?? []));
      const [academicLabels] = await tx.query(
        'SELECT (SELECT sensitivity FROM courses WHERE owner_id=$1 AND id=$2) AS course,(SELECT sensitivity FROM topics WHERE owner_id=$1 AND id=$3) AS topic,(SELECT academic_labels FROM topics WHERE owner_id=$1 AND id=$3) AS "topicHistory"',
        [owner, event.courseId, event.topicId],
      );
      if (
        !attachmentDerived &&
        event.topicId &&
        academicLabels?.topicHistory === null
      )
        throw new ApiError(
          409,
          'PROVENANCE_UNAVAILABLE',
          'Academic label history is incomplete.',
        );
      const topicHistory = academicLabels?.topicHistory
        ? sensitivitySchema.array().parse(academicLabels.topicHistory)
        : [];
      labels.push(...topicHistory);
      sensitivity = strongest(
        sensitivity,
        String(academicLabels?.course ?? 'unlabeled'),
        String(academicLabels?.topic ?? 'unlabeled'),
        ...topicHistory,
      );
      for (const value of [academicLabels?.course, academicLabels?.topic])
        if (value !== undefined && value !== null)
          labels.push(sensitivitySchema.parse(value));
    }
  } else {
    const sql = {
      course:
        'SELECT version,sensitivity,FALSE AS attachment_derived,hub_sensitivity_labels(ARRAY[sensitivity]) AS labels FROM courses WHERE owner_id=$1 AND id=$2',
      topic:
        "SELECT t.version,t.academic_labels,CASE WHEN 'restricted' IN(t.sensitivity,c.sensitivity) OR 'restricted'=ANY(t.academic_labels) THEN 'restricted' WHEN 'personal' IN(t.sensitivity,c.sensitivity) OR 'personal'=ANY(t.academic_labels) THEN 'personal' ELSE 'unlabeled' END AS sensitivity,FALSE AS attachment_derived,hub_sensitivity_labels(ARRAY[t.sensitivity,c.sensitivity] || COALESCE(t.academic_labels,ARRAY[]::text[])) AS labels FROM topics t JOIN courses c ON c.id=t.course_id AND c.owner_id=t.owner_id WHERE t.owner_id=$1 AND t.id=$2",
      'canvas-item':
        'SELECT i.version,x.sensitivity,x.attachment_derived,x.labels FROM canvas_items i JOIN canvas_item_context x ON x.id=i.id AND x.owner_id=i.owner_id WHERE i.owner_id=$1 AND i.id=$2',
      'canvas-assignment':
        'SELECT a.version,x.sensitivity,x.attachment_derived,x.labels FROM canvas_lms_assignments a JOIN canvas_assignment_context x ON x.id=a.id AND x.owner_id=a.owner_id WHERE a.owner_id=$1 AND a.id=$2',
    }[ref.kind];
    const [row] = await tx.query(sql, [owner, ref.id]);
    if (!row)
      throw new ApiError(404, 'NOT_FOUND', 'Context source not available.');
    version(row, ref.expectedVersion);
    currentVersion = Number(row.version);
    if (ref.kind === 'topic' && row.academic_labels === null)
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'Academic label history is incomplete.',
      );
    // These views return explicit/inherited labels. Missing or invalid provenance must fail closed.
    if (
      !['unlabeled', 'personal', 'restricted'].includes(
        String(row.sensitivity),
      ) ||
      typeof row.attachment_derived !== 'boolean'
    )
      throw new ApiError(
        409,
        'PROVENANCE_UNAVAILABLE',
        'Context provenance unavailable.',
      );
    sensitivity = row.sensitivity as typeof sensitivity;
    attachmentDerived = row.attachment_derived;
    labels = sensitivitySchema.array().min(1).max(3).parse(row.labels);
  }
  const applied = (['personal', 'restricted'] as const).filter((value) =>
    labels.includes(value),
  );
  const resolved = applied.length ? applied : ['unlabeled' as const];
  return {
    kind: ref.kind,
    id: ref.id,
    version: currentVersion,
    sensitivity,
    attachmentDerived,
    labels: resolved,
  };
}
export function registerAIRouting(
  app: FastifyInstance,
  database: Database,
  auth: ReturnType<typeof authService>,
) {
  const base = '/api/v1/ai/routing';
  app.get(base, async (request) => {
    const user = await auth.requireUser(request);
    return readAIRoutingPolicy(database, user.id);
  });
  app.put(base, async (request) => {
    const user = await auth.requireUser(request);
    const input = aiRoutingWriteSchema.parse(request.body);
    return mutate(
      database,
      user.id,
      input.operationId,
      { kind: 'ai.routing.permissions', input },
      async (tx) => {
        await tx.query(
          'INSERT INTO ai_routing_policies(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
          [user.id],
        );
        const [row] = await tx.query(
          'UPDATE ai_routing_policies SET policy=$3::jsonb,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE owner_id=$1 AND version=$2 RETURNING version,policy',
          [user.id, input.expectedVersion, JSON.stringify(input.policy)],
        );
        if (!row)
          throw new ApiError(
            409,
            'VERSION_CONFLICT',
            'Reload routing permissions.',
          );
        return aiRoutingSettingsSchema.parse(row);
      },
    );
  });
  app.post(`${base}/preview`, async (request) => {
    const user = await auth.requireUser(request);
    const input = aiRoutingPreviewSchema.parse(request.body);
    // Preview is read-only and never dispatches, persists text or treats availability simulation as authority.
    return database.transaction(async (tx) => {
      await tx.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const settings = await readAIRoutingPolicy(tx, user.id);
      version(settings, input.expectedPolicyVersion);
      const sources = [];
      for (const ref of input.sources)
        sources.push(await resolveAIContext(tx, user.id, ref));
      const labels = [
        input.sensitivity,
        ...sources.flatMap((row) => row.labels),
      ];
      const decision = evaluateAIRouting(
        settings.policy,
        labels,
        sources.some((row) => row.attachmentDerived),
        input.simulatedAvailableProviders,
      );
      return aiRoutingPreviewResponseSchema.parse({
        ...decision,
        simulation: true,
        dispatchEnabled: false,
        policyVersion: settings.version,
        sources,
      });
    });
  });
}
