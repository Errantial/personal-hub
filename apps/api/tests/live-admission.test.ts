import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundLiveHash } from '../src/ai/context-binding.js';
import { sealEnvelope } from '../src/ai/live-envelope.js';
import {
  destinationRevision,
  decodeCompletion,
  exchange,
  hasPrivateHost,
  pinnedRouting,
  zdrUrl,
} from '../src/ai/openrouter-live.js';
import type { OpenRouterFetch } from '../src/ai/openrouter-live.js';
import { academicContext } from '../src/ai/live-projections.js';
import {
  liveManifestSchema,
  liveSourceSchema,
} from '../src/ai/live-manifest.js';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { completion, model } from './helpers/openrouter.js';

// Live context admission (docs/live-context-admission-design.md). Every
// exchange is injected; nothing reaches the network.

const owner = randomUUID();
const zdrList = (tags: [string, string][]) =>
  new Response(
    JSON.stringify({
      data: tags.map(([modelId, tag]) => ({
        model_id: modelId,
        tag,
        supported_parameters: ['structured_outputs'],
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('sealed envelopes', () => {
  it('sends the sealed bytes exactly', async () => {
    const body = {
      model,
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Synthetic ask' }],
    };
    const sealed = sealEnvelope(owner, randomUUID(), body, { sources: [] });
    body.messages[0]!.content = 'Mutated after sealing';
    let sent: unknown;
    const fetcher: OpenRouterFetch = async (_url, init) => {
      sent = init.body;
      return completion({ reply: 'ok', actions: [] });
    };
    await exchange(fetcher, 'synthetic-key', sealed);
    expect(sent).toBe(sealed.bytes);
    expect(sealed.bytes).toContain('Synthetic ask');
    expect(sealed.bytes).not.toContain('Mutated');
  });

  it('freezes the envelope and binds bytes and manifest in the hash', () => {
    const requestId = randomUUID();
    const manifest = { sources: [{ id: 'a' }, { id: 'b' }] };
    const sealed = sealEnvelope(
      owner,
      requestId,
      { model, max_tokens: 100 },
      manifest,
    );
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.manifest)).toBe(true);
    manifest.sources.pop();
    expect(sealed.manifest).toEqual({ sources: [{ id: 'a' }, { id: 'b' }] });
    expect(boundLiveHash(owner, requestId, sealed.bytes, sealed.manifest)).toBe(
      sealed.integrityHash,
    );
    expect(
      boundLiveHash(owner, requestId, sealed.bytes + ' ', sealed.manifest),
    ).not.toBe(sealed.integrityHash);
    expect(
      boundLiveHash(owner, requestId, sealed.bytes, {
        sources: [{ id: 'b' }, { id: 'a' }],
      }),
    ).not.toBe(sealed.integrityHash);
  });
});

describe('pinned destinations', () => {
  it('rejects a different response model even when its name has the approved prefix', async () => {
    const raw = await completion('Synthetic reply').text();
    expect(decodeCompletion(raw, model, 100)).toMatchObject({
      outputState: 'validated',
    });
    expect(
      decodeCompletion(
        raw.replace(`"model":"${model}"`, `"model":"${model}-other"`),
        model,
        100,
      ),
    ).toMatchObject({
      status: 'confirmed',
      content: null,
      outputState: 'blocked',
    });
  });
  it('pins one upstream without fallback', () => {
    expect(pinnedRouting('google-vertex')).toEqual({
      only: ['google-vertex'],
      order: ['google-vertex'],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      zdr: true,
    });
  });

  it('checks the pinned upstream against the ZDR list', async () => {
    const fetcher: OpenRouterFetch = async (url) => {
      expect(url).toBe(zdrUrl);
      return zdrList([
        [model, 'google-vertex/global'],
        [model, 'azure/x'],
      ]);
    };
    expect(await hasPrivateHost(fetcher, model, 'google-vertex')).toBe(true);
    expect(await hasPrivateHost(fetcher, model, 'anthropic')).toBe(false);
    // Azure is not a declared host for Anthropic models.
    expect(await hasPrivateHost(fetcher, model, 'azure')).toBe(false);
  });

  it('binds model, upstream and terms in the destination revision', () => {
    const base = destinationRevision(model, 'google-vertex');
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(destinationRevision(model, 'anthropic')).not.toBe(base);
    expect(destinationRevision('anthropic/other', 'google-vertex')).not.toBe(
      base,
    );
  });
});

describe('academic projections', () => {
  let db: Awaited<ReturnType<typeof openDatabase>>;
  let ownerId: string;
  beforeAll(async () => {
    db = await openDatabase(
      readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' }),
    );
    await migrate(db);
    ownerId = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'academic-live@example.test','unused')",
      [ownerId],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  async function seed(
    options: {
      courseSensitivity?: string;
      workSensitivity?: string;
      academicLabels?: string[];
      workVersion?: number;
      courseVersion?: number;
      title?: string;
      kind?: string;
      notes?: string;
      dueDate?: string | null;
      estimatedMinutes?: number | null;
      status?: string;
      priority?: number;
      grade?: { earned: number; possible: number } | null;
      workDeleted?: boolean;
      courseArchived?: boolean;
    } = {},
  ) {
    const courseId = randomUUID();
    const workId = randomUUID();
    await db.query(
      'INSERT INTO courses(id,owner_id,name,sensitivity,version,deleted_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        courseId,
        ownerId,
        'Synthetic class',
        options.courseSensitivity ?? 'unlabeled',
        options.courseVersion ?? 1,
        options.courseArchived ? '2026-10-01T00:00:00Z' : null,
      ],
    );
    await db.query(
      `INSERT INTO academic_work(id,owner_id,course_id,title,kind,notes,due_date,estimated_minutes,priority,status,sensitivity,academic_labels,version,grade,deleted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        workId,
        ownerId,
        courseId,
        options.title ?? 'Synthetic work',
        options.kind ?? 'assignment',
        options.notes ?? 'Private working note',
        options.dueDate ?? null,
        options.estimatedMinutes ?? null,
        options.priority ?? 3,
        options.status ?? 'planned',
        options.workSensitivity ?? 'unlabeled',
        options.academicLabels ?? [],
        options.workVersion ?? 1,
        options.grade ? JSON.stringify(options.grade) : null,
        options.workDeleted ? '2026-10-01T00:00:00Z' : null,
      ],
    );
    return { courseId, workId };
  }

  it('projects exactly the allowlisted planning fields, never notes or grades', async () => {
    const { workId } = await seed({
      title: 'Final essay',
      kind: 'exam',
      notes: 'SECRET working notes',
      dueDate: '2026-11-01',
      estimatedMinutes: 90,
      status: 'submitted',
      priority: 2,
      grade: { earned: 9, possible: 10 },
    });
    const context = await academicContext(
      db,
      ownerId,
      [{ id: workId, expectedVersion: 1, expectedCourseVersion: 1 }],
      ['unlabeled', 'personal', 'restricted'],
    );
    expect(context.withheld).toBe(0);
    expect(context.items).toHaveLength(1);
    const projected = context.items[0]!.projected;
    expect(projected).toEqual({
      ref: 'w1',
      title: 'Final essay',
      kind: 'exam',
      dueDate: '2026-11-01',
      estimatedMinutes: 90,
      status: 'submitted',
      priority: 2,
    });
    expect(Object.keys(projected).sort()).toEqual([
      'dueDate',
      'estimatedMinutes',
      'kind',
      'priority',
      'ref',
      'status',
      'title',
    ]);
    const wire = JSON.stringify(projected);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('earned');
    expect(wire).not.toContain('possible');
    // Missing deadline and effort stay unknown, never zero or "none".
    const unknown = await seed({ dueDate: null, estimatedMinutes: null });
    const bare = await academicContext(
      db,
      ownerId,
      [{ id: unknown.workId, expectedVersion: 1, expectedCourseVersion: 1 }],
      ['unlabeled'],
    );
    expect(bare.items[0]!.projected).toMatchObject({
      dueDate: null,
      estimatedMinutes: null,
    });
  });

  it('blocks stale versions, deleted work and archived classes before any hold', async () => {
    const stale = await seed({ workVersion: 3, courseVersion: 2 });
    const select = [
      { id: stale.workId, expectedVersion: 3, expectedCourseVersion: 2 },
    ];
    await expect(
      academicContext(
        db,
        ownerId,
        [{ ...select[0]!, expectedVersion: 2 }],
        ['unlabeled'],
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });
    await expect(
      academicContext(
        db,
        ownerId,
        [{ ...select[0]!, expectedCourseVersion: 1 }],
        ['unlabeled'],
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });
    const deleted = await seed({ workDeleted: true });
    await expect(
      academicContext(
        db,
        ownerId,
        [
          {
            id: deleted.workId,
            expectedVersion: 1,
            expectedCourseVersion: 1,
          },
        ],
        ['unlabeled'],
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    const archived = await seed({ courseArchived: true });
    await expect(
      academicContext(
        db,
        ownerId,
        [
          {
            id: archived.workId,
            expectedVersion: 1,
            expectedCourseVersion: 1,
          },
        ],
        ['unlabeled'],
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACADEMIC_CLASS_ARCHIVED',
    });
  });

  it('withholds restricted and disallowed personal work and counts it', async () => {
    const restricted = await seed({ workSensitivity: 'restricted' });
    const personal = await seed({ academicLabels: ['personal'] });
    const withheld = await academicContext(
      db,
      ownerId,
      [
        { id: restricted.workId, expectedVersion: 1, expectedCourseVersion: 1 },
        { id: personal.workId, expectedVersion: 1, expectedCourseVersion: 1 },
      ],
      ['unlabeled'],
    );
    expect(withheld.items).toEqual([]);
    expect(withheld.withheld).toBe(2);
    const allowed = await academicContext(
      db,
      ownerId,
      [{ id: personal.workId, expectedVersion: 1, expectedCourseVersion: 1 }],
      ['unlabeled', 'personal'],
    );
    expect(allowed.withheld).toBe(0);
    expect(allowed.items[0]!.labels).toEqual(['unlabeled', 'personal']);
    expect(allowed.sent[0]).toMatchObject({ id: personal.workId, ref: 'w1' });
  });

  it('accepts an academic manifest source and rejects a duplicate', async () => {
    const source = {
      projection: 'academic-work-v1' as const,
      kind: 'academic-work' as const,
      id: randomUUID(),
      version: 1,
      ref: 'w1',
      labels: ['unlabeled'] as const,
      academicCourse: { id: randomUUID(), version: 1 },
      digest: 'a'.repeat(64),
    };
    expect(liveSourceSchema.parse(source)).toMatchObject({
      projection: 'academic-work-v1',
    });
    const manifest = (sources: unknown[]) => ({
      formatVersion: 1,
      owner: ownerId,
      requestId: randomUUID(),
      kind: 'planner',
      round: 1,
      conversationId: null,
      priorRequestIds: [],
      destination: {
        model,
        upstream: 'google-vertex',
        revision: 'a'.repeat(64),
        version: 1,
      },
      settingsVersion: 1,
      useMail: false,
      request: { provenance: 'owner-entered', labels: ['unlabeled'] },
      timeZone: 'UTC',
      history: { turns: [], sources: [], withheld: 0 },
      sources,
      bytes: 1,
    });
    expect(liveManifestSchema.safeParse(manifest([source])).success).toBe(true);
    expect(
      liveManifestSchema.safeParse(manifest([source, source])).success,
    ).toBe(false);
  });
});
