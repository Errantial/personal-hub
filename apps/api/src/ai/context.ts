import {
  taskSchema,
  calendarRecordSchema,
  courseSchema,
  topicSchema,
  canvasProviderDataSchema,
  canvasLmsAssignmentDataSchema,
  aiContextManifestSchema,
  sensitivitySchema,
} from '@hub/contracts';
import type { QueryExecutor } from '../db/database.js';
import { stamp } from '../features/common.js';
import type { resolveAIContext } from '../features/ai-routing.js';
import { ApiError } from '../errors.js';
import { z } from 'zod';
const sourceMetadata = z.object({
  notes: z.string().max(10000),
  availability: z.enum(['available', 'missing', 'cancelled']),
});
type Source = Awaited<ReturnType<typeof resolveAIContext>>;
const projections = {
  task: {
    table: 'tasks',
    sql: 'title,notes,priority,completed,to_char(due_date,\'YYYY-MM-DD\') AS "dueDate"',
    schema: taskSchema.pick({
      title: true,
      notes: true,
      priority: true,
      completed: true,
      dueDate: true,
    }),
  },
  event: {
    table: 'events',
    sql: `title,notes,${stamp('starts_at', 'startsAt')},${stamp('ends_at', 'endsAt')},all_day AS "allDay",to_char(start_date,'YYYY-MM-DD') AS "startDate",to_char(end_date,'YYYY-MM-DD') AS "endDate",recurrence,time_zone AS "timeZone",study_status AS "studyStatus"`,
    schema: calendarRecordSchema.pick({
      title: true,
      notes: true,
      startsAt: true,
      endsAt: true,
      allDay: true,
      startDate: true,
      endDate: true,
      recurrence: true,
      timeZone: true,
      studyStatus: true,
    }),
  },
  course: {
    table: 'courses',
    sql: 'name,term,instructor,notes',
    schema: courseSchema.pick({
      name: true,
      term: true,
      instructor: true,
      notes: true,
    }),
  },
  topic: {
    table: 'topics',
    sql: 'name,notes,progress,confidence',
    schema: topicSchema.pick({
      name: true,
      notes: true,
      progress: true,
      confidence: true,
    }),
  },
} as const;
// A bounded allowlist, not serialization of arbitrary database rows or captured provider payloads.
// Caller must resolve labels and versions in the SAME repeatable snapshot before invoking this function.
export async function assembleAITextContext(
  tx: QueryExecutor,
  owner: string,
  text: string,
  sources: Source[],
  limit: number,
  sensitivity: z.infer<typeof sensitivitySchema> = 'unlabeled',
) {
  if (sources.some((source) => source.attachmentDerived))
    throw new ApiError(
      409,
      'ATTACHMENT_DERIVED',
      'File-derived context is not allowed.',
    );
  const fragments: {
    kind: Source['kind'];
    id: string;
    version: number;
    content: Record<string, unknown>;
  }[] = [];
  const counts: number[] = [];
  for (const source of sources) {
    let content: Record<string, unknown>;
    if (source.kind === 'memory') {
      const [row] = await tx.query(
        `SELECT m.version,m.kind,m.title,m.content,to_char(m.observed_on,'YYYY-MM-DD') AS "observedOn",s.version AS "settingsVersion" FROM memories m JOIN memory_settings s ON s.owner_id=m.owner_id WHERE m.owner_id=$1 AND m.id=$2 AND m.deleted_at IS NULL AND m.enabled AND s.enabled`,
        [owner, source.id],
      );
      if (
        !row ||
        row.version !== source.version ||
        row.settingsVersion !== source.memorySettingsVersion
      )
        throw new ApiError(409, 'VERSION_CONFLICT', 'Reload memory context.');
      content = z
        .object({
          kind: z.enum(['preference', 'goal', 'fact']),
          title: z.string().min(1).max(160),
          content: z.string().min(1).max(4000),
          observedOn: z.string().nullable(),
        })
        .parse(row);
    } else if (
      source.kind === 'canvas-item' ||
      source.kind === 'canvas-assignment'
    ) {
      const table =
        source.kind === 'canvas-item'
          ? 'canvas_items'
          : 'canvas_lms_assignments';
      const [row] = await tx.query(
        `SELECT version,provider_data,notes,availability FROM ${table} WHERE owner_id=$1 AND id=$2`,
        [owner, source.id],
      );
      if (!row || row.version !== source.version)
        throw new ApiError(409, 'VERSION_CONFLICT', 'Reload context sources.');
      const metadata = sourceMetadata.parse(row);
      if (source.kind === 'canvas-item') {
        const data = canvasProviderDataSchema.parse(row.provider_data);
        // URLs and hidden feed identifiers are not model context.
        const { sourceUrl: omitted, ...facts } = data;
        void omitted;
        content = {
          ...facts,
          ...metadata,
        };
      } else
        content = {
          ...canvasLmsAssignmentDataSchema.parse(row.provider_data),
          ...metadata,
        };
    } else {
      const projection = projections[source.kind];
      const [row] = await tx.query(
        `SELECT version,${projection.sql} FROM ${projection.table} WHERE owner_id=$1 AND id=$2`,
        [owner, source.id],
      );
      if (!row || row.version !== source.version)
        throw new ApiError(409, 'VERSION_CONFLICT', 'Reload context sources.');
      content = projection.schema.parse(row);
    }
    const characters = JSON.stringify(content).length;
    if (
      characters > limit ||
      counts.reduce((sum, value) => sum + value, 0) + characters > limit
    )
      return null;
    counts.push(characters);
    fragments.push({
      kind: source.kind,
      id: source.id,
      version: source.version,
      content,
    });
  }
  const payload = JSON.stringify({ request: text, sources: fragments });
  if (payload.length > limit) return null;
  return {
    payload,
    counts,
    contextCharacters: counts.reduce((sum, value) => sum + value, 0),
    manifest: aiContextManifestSchema.parse({
      formatVersion: 1,
      boundary: 'text-only',
      projection: 'owned-text-v1',
      request: {
        provenance: 'owner-entered',
        sensitivity,
        characters: text.length,
      },
      sources: sources.map((source, index) => ({
        kind: source.kind,
        id: source.id.toLowerCase(),
        version: source.version,
        labels: source.labels,
        attachmentDerived: false,
        memorySettingsVersion: source.memorySettingsVersion ?? null,
        characters: counts[index],
      })),
      payloadCharacters: payload.length,
    }),
  };
}
