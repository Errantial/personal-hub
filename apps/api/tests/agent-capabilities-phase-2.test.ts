import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  academicWorkResponseSchema,
  assistantProposalSchema,
  courseResponseSchema,
  topicResponseSchema,
  topicSchema,
  trackedDeadlineResponseSchema,
  Temporal,
} from '@hub/contracts';
import { startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';
import { assistantContext } from '../src/ai/assistant-context.js';
import { academicContext, plannerSources } from '../src/ai/live-projections.js';
import {
  buildAssistantRequest,
  readAnswer,
  toProposal,
} from '../src/features/assistant.js';
import {
  executeCapability,
  modelCapabilityProposal,
  undoCapability,
} from '../src/ai/capabilities.js';
import {
  applyByPolicy,
  proposalPolicyMode,
  proposalTier,
} from '../src/features/agent-run.js';
import { topicColumns } from '../src/features/common.js';
import { readTurn } from '../src/features/assistant-conversations.js';
import { proposalDigest } from '../src/features/ai-planner-origin.js';
import { turnDigest } from '../src/ai/live-manifest.js';
import { trackedDeadlineContext } from '../src/ai/tracked-deadline-context.js';

async function seedTurn(h: Harness) {
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const reservation = randomUUID();
  await h.database.query(
    'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
    [conversationId, h.owner, 'Capability phase 2 test'],
  );
  await h.database.query(
    `INSERT INTO ai_budget_reservations
      (id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,actual_micros,status)
     VALUES($1,$2,$3,$4,'2026-11-01','synthetic','synthetic/model',1,1000,0,'released')`,
    [reservation, h.owner, turnId, 'h'.repeat(64)],
  );
  await h.database.query(
    `INSERT INTO ai_assistant_requests
      (id,owner_id,operation_id,request_hash,model,reservation_id,status,cost_micros)
     VALUES($1,$2,$3,$4,'synthetic/model',$5,'completed',0)`,
    [turnId, h.owner, randomUUID(), 'h'.repeat(64), reservation],
  );
  await h.database.query(
    `INSERT INTO ai_conversation_turns
      (id,owner_id,conversation_id,position,ask,reply,inference_history,inference_digest,inference_sources)
     VALUES($1,$2,$3,0,'Test','Done','bound',$4,'[]'::jsonb)`,
    [
      turnId,
      h.owner,
      conversationId,
      turnDigest(h.owner, turnId, 'Test', 'Done'),
    ],
  );
  return turnId;
}

async function saveTurnProposal(
  h: Harness,
  turnId: string,
  proposal: ReturnType<typeof assistantProposalSchema.parse>,
) {
  const item = {
    state: 'proposed',
    applied: null,
    error: null,
    applyId: randomUUID(),
    undoId: randomUUID(),
  };
  await h.database.query(
    'UPDATE ai_conversation_turns SET proposals=$2::jsonb,items=$3::jsonb WHERE owner_id=$1 AND id=$4',
    [h.owner, JSON.stringify([proposal]), JSON.stringify([item]), turnId],
  );
  await h.database.query(
    `INSERT INTO ai_turn_origins(owner_id,turn_id,request_id,capture,proposal_digests)
     VALUES($1,$2,$2,$3::jsonb,$4::jsonb)`,
    [
      h.owner,
      turnId,
      JSON.stringify({
        requestId: turnId,
        labels: ['unlabeled'],
        sources: [],
        useMail: false,
        destination: {
          model: 'synthetic/model',
          upstream: 'google-vertex',
          revision: 'a'.repeat(64),
          version: 1,
        },
      }),
      JSON.stringify({
        [item.applyId]: proposalDigest(h.owner, turnId, item.applyId, proposal),
      }),
    ],
  );
  return item;
}

const day = (offset: number) =>
  Temporal.Now.plainDateISO('America/Denver').add({ days: offset }).toString();
let providerId = 500;

async function seedDeadline(
  h: Harness,
  options: { title: string; dueDate: string; completed?: boolean },
) {
  await h.database.query(
    "INSERT INTO canvas_sources(owner_id,enabled,sensitivity) VALUES($1,true,'unlabeled') ON CONFLICT(owner_id) DO NOTHING",
    [h.owner],
  );
  const sourceId = randomUUID();
  const id = randomUUID();
  const number = String(providerId++);
  const sourceUrl = `https://canvas.colorado.edu/courses/10/assignments/${number}`;
  const canonicalKey = `canvas:canvas.colorado.edu:/courses/10/assignments/${number}`;
  await h.database.query(
    `INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,sensitivity,input_kind)
     VALUES($1,$2,$3,$4::jsonb,'available','unlabeled','calendar-feed')`,
    [
      sourceId,
      h.owner,
      `deadline-${number}`,
      JSON.stringify({
        title: options.title,
        allDay: true,
        startDate: options.dueDate,
        endDate: Temporal.PlainDate.from(options.dueDate)
          .add({ days: 1 })
          .toString(),
        sourceUrl,
      }),
    ],
  );
  await h.database.query(
    `INSERT INTO tracked_deadlines(id,owner_id,canonical_key,completed_at)
     VALUES($1,$2,$3,$4)`,
    [id, h.owner, canonicalKey, options.completed ? new Date() : null],
  );
  await h.database.query(
    `INSERT INTO tracked_deadline_sources
       (id,owner_id,deadline_id,canvas_item_id,source_kind,is_primary,source_version)
     VALUES($1,$2,$3,$4,'calendar-feed',true,1)`,
    [randomUUID(), h.owner, id, sourceId],
  );
  return { id, sourceId, sourceUrl };
}

async function createCourse(h: Harness, name: string) {
  const reply = await h.call('POST', '/api/v1/courses', {
    name,
    operationId: randomUUID(),
  });
  expect(reply.statusCode).toBe(200);
  return courseResponseSchema.parse(reply.json()).course;
}

async function createTopic(h: Harness, courseId: string, name: string) {
  const reply = await h.call('POST', '/api/v1/topics', {
    courseId,
    name,
    operationId: randomUUID(),
  });
  expect(reply.statusCode).toBe(200);
  return topicResponseSchema.parse(reply.json()).topic;
}

async function createWork(h: Harness, courseId: string, title: string) {
  const reply = await h.call('POST', '/api/v1/academic-work', {
    courseId,
    title,
    dueDate: '2030-01-05',
    operationId: randomUUID(),
  });
  expect(reply.statusCode).toBe(200);
  return academicWorkResponseSchema.parse(reply.json()).work;
}

describe('assistant capability matrix phase 2', { timeout: 60000 }, () => {
  it('resolves class, topic, work and deadline refs with pinned versions and tiers', async () => {
    const h = await startHarness();
    const course = await createCourse(h, 'Biology');
    const topic = await createTopic(h, course.id, 'Cells');
    const work = await createWork(h, course.id, 'Lab 1');
    const deadline = await seedDeadline(h, {
      title: 'Problem set',
      dueDate: day(2),
    });
    const context = await assistantContext(h.database, h.owner, 'UTC');
    expect(context.courses?.map((item) => item.id)).toContain(course.id);
    expect(context.topics?.map((item) => item.id)).toContain(topic.id);

    const academic = await academicContext(
      h.database,
      h.owner,
      [
        {
          id: work.id,
          expectedVersion: work.version,
          expectedCourseVersion: course.version,
        },
      ],
      ['unlabeled'],
    );
    const deadlines = await trackedDeadlineContext(
      h.database,
      h.owner,
      ['unlabeled'],
      'UTC',
    );
    expect(academic.items).toHaveLength(1);
    expect(deadlines.items).toHaveLength(1);

    const courseRef = `c${context.courses!.findIndex((item) => item.id === course.id) + 1}`;
    const topicRef = `p${context.topics!.findIndex((item) => item.id === topic.id) + 1}`;
    const workRef = academic.items[0]!.ref;
    const deadlineRef = deadlines.items[0]!.ref;

    const courseUpdate = modelCapabilityProposal(
      'course.update',
      JSON.stringify({ ref: courseRef, name: 'Biology II' }),
      context,
    );
    expect(assistantProposalSchema.parse(courseUpdate)).toMatchObject({
      kind: 'capability',
      capability: 'course.update',
      tier: 1,
      arguments: { id: course.id, expectedVersion: course.version },
    });
    const topicCreate = modelCapabilityProposal(
      'topic.create',
      JSON.stringify({ courseRef, name: 'Genetics' }),
      context,
    );
    expect(assistantProposalSchema.parse(topicCreate)).toMatchObject({
      capability: 'topic.create',
      arguments: {
        courseId: course.id,
        expectedCourseVersion: course.version,
        name: 'Genetics',
      },
    });
    const topicUpdate = modelCapabilityProposal(
      'topic.update',
      JSON.stringify({ ref: topicRef, progress: 40 }),
      context,
    );
    expect(assistantProposalSchema.parse(topicUpdate)).toMatchObject({
      capability: 'topic.update',
      arguments: { id: topic.id, expectedVersion: topic.version },
    });
    const workUpdate = modelCapabilityProposal(
      'academicWork.update',
      JSON.stringify({ ref: workRef, title: 'Lab 1 revised' }),
      context,
      academic.items,
      deadlines.items,
    );
    expect(assistantProposalSchema.parse(workUpdate)).toMatchObject({
      capability: 'academicWork.update',
      arguments: {
        id: work.id,
        expectedVersion: work.version,
        expectedCourseVersion: course.version,
      },
    });
    const deadlineUpdate = modelCapabilityProposal(
      'trackedDeadline.update',
      JSON.stringify({ ref: deadlineRef, priority: 'high' }),
      context,
      academic.items,
      deadlines.items,
    );
    expect(assistantProposalSchema.parse(deadlineUpdate)).toMatchObject({
      capability: 'trackedDeadline.update',
      tier: 1,
      arguments: { id: deadline.id, expectedVersion: 1 },
    });
    const timedOverride = modelCapabilityProposal(
      'trackedDeadline.update',
      JSON.stringify({
        ref: deadlineRef,
        dueOverride: {
          kind: 'timed',
          dueAt: '2030-01-10T17:00:00-07:00',
          timeZone: 'America/Denver',
        },
      }),
      context,
      academic.items,
      deadlines.items,
    );
    expect(assistantProposalSchema.parse(timedOverride)).toMatchObject({
      capability: 'trackedDeadline.update',
      arguments: {
        dueOverride: {
          kind: 'timed',
          dueAt: '2030-01-10T17:00:00-07:00',
          timeZone: 'America/Denver',
        },
      },
    });
    const dateOverride = modelCapabilityProposal(
      'trackedDeadline.update',
      JSON.stringify({
        ref: deadlineRef,
        dueOverride: { kind: 'date', dueDate: '2030-01-10' },
      }),
      context,
      academic.items,
      deadlines.items,
    );
    expect(assistantProposalSchema.parse(dateOverride)).toMatchObject({
      capability: 'trackedDeadline.update',
      arguments: {
        dueOverride: { kind: 'date', dueDate: '2030-01-10' },
      },
    });
    expect(
      modelCapabilityProposal(
        'trackedDeadline.reopen',
        JSON.stringify({ ref: deadlineRef }),
        context,
        academic.items,
        deadlines.items,
      ),
    ).toBeNull();
    expect(
      modelCapabilityProposal(
        'academicWork.restore',
        JSON.stringify({ ref: workRef }),
        context,
        academic.items,
      ),
    ).toBeNull();
    expect(
      modelCapabilityProposal(
        'course.update',
        JSON.stringify({ ref: 'c99', name: 'Missing' }),
        context,
      ),
    ).toBeNull();

    expect(modelCapabilityProposal('course.create', '{}', context)).toBeNull();
    expect(
      assistantProposalSchema.parse(
        modelCapabilityProposal(
          'course.create',
          JSON.stringify({ name: 'Chemistry' }),
          context,
        ),
      ),
    ).toMatchObject({ tier: 1 });
    expect(
      assistantProposalSchema.parse(
        modelCapabilityProposal(
          'course.delete',
          JSON.stringify({ ref: courseRef }),
          context,
        ),
      ),
    ).toMatchObject({ tier: 2 });
    expect(
      assistantProposalSchema.parse(
        modelCapabilityProposal(
          'academicWork.restore',
          JSON.stringify({ id: work.id, expectedVersion: 2 }),
          context,
        ),
      ),
    ).toMatchObject({ tier: 2 });

    const request = buildAssistantRequest(
      'anthropic/claude-haiku-5.5',
      context,
      'Update my class',
      'UTC',
      undefined,
      [],
      undefined,
      false,
      'google-vertex',
      academic.items.map((item) => item.projected),
      undefined,
      [],
      deadlines.items.map((item) => item.projected),
    );
    const payload = JSON.parse(
      (request.messages.at(-1)!.content as string) ?? '{}',
    ) as {
      topics?: Array<{ ref: string; courseRef: string | null }>;
      deadlines?: Array<{ ref: string; completed: boolean }>;
    };
    expect(payload.topics).toEqual([
      expect.objectContaining({ ref: 'p1', courseRef: 'c1' }),
    ]);
    expect(payload.deadlines).toEqual([
      expect.objectContaining({ ref: 'd1', completed: false }),
    ]);
    const system = request.messages[0]!.content as string;
    expect(system).toContain('Never state or infer a grade');
    expect(system).toContain('trackedDeadline.complete');
    expect(system).toContain('Never claim imported deadlines');

    const sources = plannerSources(h.owner, randomUUID(), context, 'UTC');
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projection: 'planner-topic-v1',
          kind: 'topic',
          id: topic.id,
          version: topic.version,
          ref: topicRef,
        }),
      ]),
    );

    const answer = readAnswer(
      JSON.stringify({
        reply: 'Updated the topic.',
        actions: [],
        tools: [
          {
            capability: 'topic.update',
            arguments: JSON.stringify({ ref: topicRef, progress: 50 }),
          },
          {
            capability: 'trackedDeadline.complete',
            arguments: JSON.stringify({ ref: deadlineRef }),
          },
        ],
        studySuggestions: [],
      }),
      context,
      'UTC',
      academic.items,
      deadlines.items,
    );
    expect(answer.proposals).toEqual([
      expect.objectContaining({
        kind: 'capability',
        capability: 'topic.update',
        arguments: expect.objectContaining({ id: topic.id }),
      }),
      expect.objectContaining({
        kind: 'capability',
        capability: 'trackedDeadline.complete',
        arguments: expect.objectContaining({ id: deadline.id }),
      }),
    ]);
    await h.app.close();
  });

  it('withholds lowered-label and legacy unknown-history topics', async () => {
    const h = await startHarness();
    const course = await createCourse(h, 'Labeled class');
    const topic = await createTopic(h, course.id, 'History topic');
    const personal = await h.call('PUT', `/api/v1/topics/${topic.id}`, {
      courseId: course.id,
      name: topic.name,
      notes: '',
      confidence: 'unknown',
      progress: 0,
      sensitivity: 'personal',
      expectedVersion: topic.version,
      operationId: randomUUID(),
    });
    expect(personal.statusCode).toBe(200);
    const lowered = await h.call('PUT', `/api/v1/topics/${topic.id}`, {
      courseId: course.id,
      name: topic.name,
      notes: '',
      confidence: 'unknown',
      progress: 0,
      sensitivity: 'unlabeled',
      expectedVersion: topicResponseSchema.parse(personal.json()).topic.version,
      operationId: randomUUID(),
    });
    expect(lowered.statusCode).toBe(200);
    const [stored] = await h.database.query(
      'SELECT sensitivity,academic_labels AS "academicLabels" FROM topics WHERE owner_id=$1 AND id=$2',
      [h.owner, topic.id],
    );
    expect(stored).toMatchObject({
      sensitivity: 'unlabeled',
      academicLabels: ['personal'],
    });

    const unlabeledOnly = await assistantContext(h.database, h.owner, 'UTC', [
      'unlabeled',
    ]);
    expect(unlabeledOnly.topics?.some((item) => item.id === topic.id)).toBe(
      false,
    );
    const personalAllowed = await assistantContext(h.database, h.owner, 'UTC', [
      'unlabeled',
      'personal',
    ]);
    expect(personalAllowed.topics?.some((item) => item.id === topic.id)).toBe(
      true,
    );
    const source = plannerSources(
      h.owner,
      randomUUID(),
      personalAllowed,
      'UTC',
    ).find((item) => item.kind === 'topic' && item.id === topic.id);
    expect(source?.labels).toEqual(['personal']);

    const legacyId = randomUUID();
    await h.database.query(
      `INSERT INTO topics(id,owner_id,course_id,name,notes,confidence,progress,sensitivity,academic_labels,version)
       VALUES($1,$2,$3,'Legacy null','','unknown',0,'unlabeled',NULL,1)`,
      [legacyId, h.owner, course.id],
    );
    const legacyContext = await assistantContext(h.database, h.owner, 'UTC', [
      'unlabeled',
      'personal',
    ]);
    expect(legacyContext.topics?.some((item) => item.id === legacyId)).toBe(
      false,
    );
    const [legacyRow] = await h.database.query(
      `SELECT ${topicColumns} FROM topics WHERE owner_id=$1 AND id=$2`,
      [h.owner, legacyId],
    );
    const legacyTopic = topicSchema.parse(legacyRow);
    expect(() =>
      plannerSources(
        h.owner,
        randomUUID(),
        {
          tasks: [],
          events: [],
          courses: [course],
          topics: [legacyTopic],
        },
        'UTC',
      ),
    ).toThrow('Topic label history is unavailable.');
    await h.app.close();
  });

  it('never leaves topics without a class ref after budget trimming', async () => {
    const h = await startHarness();
    for (let index = 0; index < 30; index++) {
      const courseId = randomUUID();
      await h.database.query(
        `INSERT INTO courses(id,owner_id,name,term,instructor,notes,sensitivity,version)
         VALUES($1,$2,$3,'','','','unlabeled',1)`,
        [courseId, h.owner, `${index} ${'c'.repeat(180)}`],
      );
      await h.database.query(
        `INSERT INTO topics(id,owner_id,course_id,name,notes,confidence,progress,sensitivity,academic_labels,version)
         VALUES($1,$2,$3,$4,'','unknown',0,'unlabeled','{}',1)`,
        [randomUUID(), h.owner, courseId, `${index} ${'t'.repeat(180)}`],
      );
    }
    for (let index = 0; index < 60; index++) {
      await h.database.query(
        `INSERT INTO tasks(id,owner_id,title,due_date,priority,completed,sensitivity)
         VALUES($1,$2,$3,'2030-01-01','normal',false,'unlabeled')`,
        [randomUUID(), h.owner, `${index} ${'x'.repeat(180)}`],
      );
      await h.database.query(
        `INSERT INTO events(id,owner_id,title,notes,starts_at,ends_at,time_zone,sensitivity,all_day,study_status,academic_labels)
         VALUES($1,$2,$3,'',CURRENT_TIMESTAMP + interval '1 day',CURRENT_TIMESTAMP + interval '1 day 1 hour','UTC','unlabeled',false,'planned','{}')`,
        [randomUUID(), h.owner, `${index} ${'e'.repeat(180)}`],
      );
    }
    const context = await assistantContext(h.database, h.owner, 'UTC');
    expect(context.topics!.length).toBeLessThan(30);
    expect(context.courses!.length).toBeLessThan(30);
    const request = buildAssistantRequest(
      'anthropic/claude-haiku-5.5',
      context,
      'Check my classes',
      'UTC',
    );
    const payload = JSON.parse(request.messages.at(-1)!.content as string) as {
      courses?: Array<{ ref: string }>;
      topics?: Array<{ ref: string; courseRef: string | null }>;
    };
    const courseRefs = new Set((payload.courses ?? []).map((item) => item.ref));
    for (const topic of payload.topics ?? [])
      expect(courseRefs.has(topic.courseRef ?? '')).toBe(true);
    await h.app.close();
  });

  it('creates, updates and deletes classes and topics with audit snapshots and undo', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const created = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'course.create',
      { name: 'History', term: 'Spring', instructor: 'Dr. Example' },
      randomUUID(),
    );
    const courses = (await h.call('GET', '/api/v1/courses')).json()
      .courses as Array<{ id: string; name: string; version: number }>;
    const course = courses.find((item) => item.name === 'History')!;
    const [createAudit] = await h.database.query(
      'SELECT before,after FROM ai_capability_audit WHERE id=$1',
      [created.id],
    );
    expect(createAudit!.before).toBeNull();
    expect(createAudit!.after).toMatchObject({
      id: course.id,
      name: 'History',
      version: 1,
    });

    const updated = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'course.update',
      { id: course.id, expectedVersion: 1, name: 'History II' },
      randomUUID(),
    );
    const [updateAudit] = await h.database.query(
      'SELECT before,after FROM ai_capability_audit WHERE id=$1',
      [updated.id],
    );
    expect(updateAudit!.before).toMatchObject({ name: 'History', version: 1 });
    expect(updateAudit!.after).toMatchObject({
      name: 'History II',
      version: 2,
    });
    const [updateTarget] = await h.database.query(
      'SELECT target_kind AS "targetKind",target_id AS "targetId" FROM ai_capability_audit WHERE id=$1',
      [updated.id],
    );
    expect(updateTarget).toMatchObject({
      targetKind: null,
      targetId: course.id,
    });
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'course.update',
        { id: course.id, expectedVersion: 1, name: 'Stale' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const retryOperation = randomUUID();
    const firstTopic = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'topic.create',
      {
        courseId: course.id,
        expectedCourseVersion: 2,
        name: 'Unit 1',
        progress: 10,
      },
      retryOperation,
    );
    const retriedTopic = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'topic.create',
      {
        courseId: course.id,
        expectedCourseVersion: 2,
        name: 'Unit 1',
        progress: 10,
      },
      retryOperation,
    );
    expect(retriedTopic.id).toBe(firstTopic.id);
    const [topicCount] = await h.database.query(
      "SELECT count(*)::int AS count FROM ai_capability_audit WHERE owner_id=$1 AND tool='topic.create'",
      [h.owner],
    );
    expect(topicCount!.count).toBe(1);
    const topics = (await h.call('GET', '/api/v1/topics')).json()
      .topics as Array<{ id: string; name: string; version: number }>;
    const topic = topics.find((item) => item.name === 'Unit 1')!;

    const topicUpdate = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'topic.update',
      { id: topic.id, expectedVersion: topic.version, progress: 45 },
      randomUUID(),
    );
    await undoCapability(h.database, h.owner, topicUpdate.id, randomUUID());
    const [restoredTopic] = await h.database.query(
      'SELECT progress,version FROM topics WHERE id=$1',
      [topic.id],
    );
    expect(restoredTopic).toMatchObject({ progress: 10 });
    const topicDelete = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'topic.delete',
      { id: topic.id, expectedVersion: restoredTopic!.version },
      randomUUID(),
    );
    const [deletedTopic] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM topics WHERE id=$1',
      [topic.id],
    );
    expect(deletedTopic!.deletedAt).not.toBeNull();
    await undoCapability(h.database, h.owner, topicDelete.id, randomUUID());
    const [reopenedTopic] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM topics WHERE id=$1',
      [topic.id],
    );
    expect(reopenedTopic!.deletedAt).toBeNull();

    const secondTopic = await createTopic(h, course.id, 'Unit 2');
    await executeCapability(
      h.database,
      h.owner,
      turnId,
      'course.delete',
      { id: course.id, expectedVersion: 2 },
      randomUUID(),
    );
    const [cascade] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM topics WHERE id=$1',
      [secondTopic.id],
    );
    expect(cascade!.deletedAt).not.toBeNull();
    const [deleteAudit] = await h.database.query(
      'SELECT before,after,target_id AS "targetId" FROM ai_capability_audit WHERE owner_id=$1 AND tool=\'course.delete\' ORDER BY created_at DESC LIMIT 1',
      [h.owner],
    );
    expect(deleteAudit!.before).toMatchObject({
      course: { id: course.id },
      topics: expect.arrayContaining([
        expect.objectContaining({ id: secondTopic.id }),
      ]),
    });
    expect(deleteAudit!.targetId).toBe(course.id);

    const auditList = (
      await h.call('GET', '/api/v1/ai/capabilities/audit')
    ).json().entries as Array<{
      id: string;
      tool: string;
      action: string;
      decision: string;
    }>;
    expect(auditList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'course.create',
          action: 'create',
          decision: 'applied',
        }),
        expect.objectContaining({
          tool: 'course.delete',
          action: 'delete',
          decision: 'applied',
        }),
      ]),
    );
    const apiUndo = await h.call('POST', '/api/v1/ai/capabilities/undo', {
      auditId: auditList.find((entry) => entry.tool === 'course.delete')!.id,
      operationId: randomUUID(),
    });
    expect(apiUndo.statusCode).toBe(200);
    const [courseAfterUndo] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM courses WHERE id=$1',
      [course.id],
    );
    expect(courseAfterUndo!.deletedAt).toBeNull();
    const [topicAfterUndo] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM topics WHERE id=$1',
      [secondTopic.id],
    );
    expect(topicAfterUndo!.deletedAt).toBeNull();
    const [undoAudit] = await h.database.query(
      'SELECT target_id AS "targetId" FROM ai_capability_audit WHERE owner_id=$1 AND tool=\'undo\' ORDER BY created_at DESC LIMIT 1',
      [h.owner],
    );
    expect(undoAudit!.targetId).toBe(course.id);

    await expect(
      undoCapability(h.database, h.owner, created.id, randomUUID()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const emptyCourseCreate = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'course.create',
      { name: 'Empty class' },
      randomUUID(),
    );
    const emptyCourse = (
      (await h.call('GET', '/api/v1/courses')).json().courses as Array<{
        id: string;
        name: string;
      }>
    ).find((item) => item.name === 'Empty class')!;
    await undoCapability(
      h.database,
      h.owner,
      emptyCourseCreate.id,
      randomUUID(),
    );
    const [emptyTombstone] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM courses WHERE id=$1',
      [emptyCourse.id],
    );
    expect(emptyTombstone!.deletedAt).not.toBeNull();

    const [restoredCourse] = await h.database.query(
      'SELECT version FROM courses WHERE owner_id=$1 AND id=$2',
      [h.owner, course.id],
    );
    const undoableTopicCreate = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'topic.create',
      {
        courseId: course.id,
        expectedCourseVersion: restoredCourse!.version,
        name: 'Unit 3',
      },
      randomUUID(),
    );
    const unitThree = (
      (await h.call('GET', '/api/v1/topics')).json().topics as Array<{
        id: string;
        name: string;
      }>
    ).find((item) => item.name === 'Unit 3')!;
    await undoCapability(
      h.database,
      h.owner,
      undoableTopicCreate.id,
      randomUUID(),
    );
    const [unitThreeTombstone] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM topics WHERE id=$1',
      [unitThree.id],
    );
    expect(unitThreeTombstone!.deletedAt).not.toBeNull();

    const dependentCourseCreate = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'course.create',
      { name: 'Dependent class' },
      randomUUID(),
    );
    const dependentCourse = (
      (await h.call('GET', '/api/v1/courses')).json().courses as Array<{
        id: string;
        name: string;
        version: number;
      }>
    ).find((item) => item.name === 'Dependent class')!;
    await executeCapability(
      h.database,
      h.owner,
      turnId,
      'topic.create',
      {
        courseId: dependentCourse.id,
        expectedCourseVersion: dependentCourse.version,
        name: 'Dependent topic',
      },
      randomUUID(),
    );
    await expect(
      undoCapability(
        h.database,
        h.owner,
        dependentCourseCreate.id,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await h.app.close();
  });

  it('keeps academic-work score rules, delete/restore and undo', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const course = await createCourse(h, 'Physics');
    await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.create',
      {
        courseId: course.id,
        expectedCourseVersion: course.version,
        title: 'Lab report',
        dueDate: '2030-02-01',
        estimatedMinutes: 90,
      },
      randomUUID(),
    );
    // A capability returns its audit id, not the created record id.
    const works = (await h.call('GET', '/api/v1/academic-work')).json()
      .work as Array<{ id: string; title: string; version: number }>;
    const createdWork = works.find((item) => item.title === 'Lab report')!;
    expect(createdWork).toMatchObject({ version: 1 });
    const updated = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.update',
      {
        id: createdWork.id,
        expectedVersion: createdWork.version,
        expectedCourseVersion: course.version,
        title: 'Lab report revised',
        priority: 2,
      },
      randomUUID(),
    );
    const [updateAudit] = await h.database.query(
      'SELECT before,after FROM ai_capability_audit WHERE id=$1',
      [updated.id],
    );
    expect(updateAudit!.before).toMatchObject({ title: 'Lab report' });
    expect(updateAudit!.after).toMatchObject({
      title: 'Lab report revised',
      priority: 2,
    });
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'academicWork.update',
        {
          id: createdWork.id,
          expectedVersion: createdWork.version,
          expectedCourseVersion: course.version,
          notes: 'Stale',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await h.database.query(
      `UPDATE academic_work SET status='submitted',grade='{"earned":9,"possible":10}'::jsonb,version=version+1 WHERE owner_id=$1 AND id=$2`,
      [h.owner, createdWork.id],
    );
    const [scored] = await h.database.query(
      'SELECT version FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, createdWork.id],
    );
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'academicWork.update',
        {
          id: createdWork.id,
          expectedVersion: scored!.version,
          expectedCourseVersion: course.version,
          status: 'planned',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ACADEMIC_SCORE_REVIEW_REQUIRED' });
    await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.update',
      {
        id: createdWork.id,
        expectedVersion: scored!.version,
        expectedCourseVersion: course.version,
        notes: 'Checked',
      },
      randomUUID(),
    );
    const [graded] = await h.database.query(
      'SELECT grade,status,notes FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, createdWork.id],
    );
    expect(graded).toMatchObject({
      status: 'submitted',
      notes: 'Checked',
      grade: { earned: 9, possible: 10 },
    });

    const deleted = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.delete',
      {
        id: createdWork.id,
        expectedVersion: Number(scored!.version) + 1,
        expectedCourseVersion: course.version,
      },
      randomUUID(),
    );
    await undoCapability(h.database, h.owner, deleted.id, randomUUID());
    const [restored] = await h.database.query(
      'SELECT deleted_at AS "deletedAt",version FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, createdWork.id],
    );
    expect(restored!.deletedAt).toBeNull();

    await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.delete',
      {
        id: createdWork.id,
        expectedVersion: restored!.version,
        expectedCourseVersion: course.version,
      },
      randomUUID(),
    );
    const [tombstone] = await h.database.query(
      'SELECT version FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, createdWork.id],
    );
    const restoredByCapability = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.restore',
      { id: createdWork.id, expectedVersion: tombstone!.version },
      randomUUID(),
    );
    const [afterRestore] = await h.database.query(
      'SELECT deleted_at AS "deletedAt",version FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, createdWork.id],
    );
    expect(afterRestore!.deletedAt).toBeNull();
    await undoCapability(
      h.database,
      h.owner,
      restoredByCapability.id,
      randomUUID(),
    );
    const [afterRestoreUndo] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, createdWork.id],
    );
    expect(afterRestoreUndo!.deletedAt).not.toBeNull();

    const extraCreate = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'academicWork.create',
      {
        courseId: course.id,
        expectedCourseVersion: course.version,
        title: 'Extra credit plan',
      },
      randomUUID(),
    );
    const extra = (
      (await h.call('GET', '/api/v1/academic-work')).json().work as Array<{
        id: string;
        title: string;
      }>
    ).find((item) => item.title === 'Extra credit plan')!;
    await undoCapability(h.database, h.owner, extraCreate.id, randomUUID());
    const [extraTombstone] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM academic_work WHERE owner_id=$1 AND id=$2',
      [h.owner, extra.id],
    );
    expect(extraTombstone!.deletedAt).not.toBeNull();
    await h.app.close();
  });

  it('updates, completes and reopens tracked deadlines locally without source writes', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const seed = await seedDeadline(h, {
      title: 'Imported essay',
      dueDate: day(3),
    });
    const beforeSource = await h.database.query(
      'SELECT provider_data,version FROM canvas_items WHERE id=$1',
      [seed.sourceId],
    );
    const deadline = trackedDeadlineResponseSchema.parse(
      (await h.call('GET', `/api/v1/deadlines/${seed.id}`)).json(),
    ).deadline;
    const updated = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'trackedDeadline.update',
      {
        id: deadline.id,
        expectedVersion: deadline.version,
        titleOverride: 'Local essay title',
        priority: 'high',
        notes: 'Local planning note',
        dueOverride: { kind: 'date', dueDate: '2030-03-01' },
        sensitivity: 'personal',
      },
      randomUUID(),
    );
    const [updateAudit] = await h.database.query(
      'SELECT before,after FROM ai_capability_audit WHERE id=$1',
      [updated.id],
    );
    expect(updateAudit!.before).toMatchObject({
      title: 'Imported essay',
      priority: 'normal',
    });
    expect(updateAudit!.after).toMatchObject({
      title: 'Local essay title',
      priority: 'high',
      notes: 'Local planning note',
      dueOverride: { kind: 'date', dueDate: '2030-03-01' },
      sensitivity: 'personal',
    });
    await undoCapability(h.database, h.owner, updated.id, randomUUID());
    const [reverted] = await h.database.query(
      `SELECT title_override AS "titleOverride",priority,notes,
         due_override_kind AS "dueOverrideKind",
         to_char(due_date_override,'YYYY-MM-DD') AS "dueDateOverride"
       FROM tracked_deadlines WHERE owner_id=$1 AND id=$2`,
      [h.owner, deadline.id],
    );
    expect(reverted).toMatchObject({
      titleOverride: null,
      priority: 'normal',
      notes: '',
      dueOverrideKind: 'provider',
      dueDateOverride: null,
    });

    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'trackedDeadline.update',
        {
          id: deadline.id,
          expectedVersion: deadline.version,
          priority: 'low',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const [current] = await h.database.query(
      'SELECT version FROM tracked_deadlines WHERE owner_id=$1 AND id=$2',
      [h.owner, deadline.id],
    );
    const completed = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'trackedDeadline.complete',
      { id: deadline.id, expectedVersion: current!.version },
      randomUUID(),
    );
    const [completeAudit] = await h.database.query(
      'SELECT before,after FROM ai_capability_audit WHERE id=$1',
      [completed.id],
    );
    expect(completeAudit!.before).toMatchObject({ completedAt: null });
    expect(completeAudit!.after).toMatchObject({
      completedAt: expect.any(String),
    });
    await undoCapability(h.database, h.owner, completed.id, randomUUID());
    const [reopened] = await h.database.query(
      'SELECT completed_at AS "completedAt",version FROM tracked_deadlines WHERE owner_id=$1 AND id=$2',
      [h.owner, deadline.id],
    );
    expect(reopened!.completedAt).toBeNull();

    await executeCapability(
      h.database,
      h.owner,
      turnId,
      'trackedDeadline.complete',
      { id: deadline.id, expectedVersion: reopened!.version },
      randomUUID(),
    );
    const [completedAgain] = await h.database.query(
      'SELECT version,completed_at AS "completedAt" FROM tracked_deadlines WHERE owner_id=$1 AND id=$2',
      [h.owner, deadline.id],
    );
    expect(completedAgain!.completedAt).not.toBeNull();
    const reopenedByCapability = await executeCapability(
      h.database,
      h.owner,
      turnId,
      'trackedDeadline.reopen',
      { id: deadline.id, expectedVersion: completedAgain!.version },
      randomUUID(),
    );
    const [afterReopen] = await h.database.query(
      'SELECT completed_at AS "completedAt" FROM tracked_deadlines WHERE owner_id=$1 AND id=$2',
      [h.owner, deadline.id],
    );
    expect(afterReopen!.completedAt).toBeNull();
    await undoCapability(
      h.database,
      h.owner,
      reopenedByCapability.id,
      randomUUID(),
    );
    const [afterReopenUndo] = await h.database.query(
      'SELECT completed_at AS "completedAt" FROM tracked_deadlines WHERE owner_id=$1 AND id=$2',
      [h.owner, deadline.id],
    );
    expect(afterReopenUndo!.completedAt).not.toBeNull();
    expect(
      await h.database.query(
        'SELECT provider_data,version FROM canvas_items WHERE id=$1',
        [seed.sourceId],
      ),
    ).toEqual(beforeSource);

    const completedContext = await trackedDeadlineContext(
      h.database,
      h.owner,
      ['unlabeled'],
      'UTC',
      undefined,
      { includeCompleted: true },
    );
    expect(completedContext.items).toEqual([
      expect.objectContaining({
        id: deadline.id,
        projected: expect.objectContaining({ completed: true }),
      }),
    ]);
    const completedProposal = modelCapabilityProposal(
      'trackedDeadline.reopen',
      JSON.stringify({ ref: 'd1' }),
      { tasks: [], events: [], withheld: 0 },
      [],
      completedContext.items,
    );
    expect(assistantProposalSchema.parse(completedProposal)).toMatchObject({
      capability: 'trackedDeadline.reopen',
      tier: 1,
      arguments: { id: deadline.id },
    });
    expect(
      toProposal(
        {
          type: 'task.create',
          ref: 'd1',
          title: 'Prepare after completion',
          dueDate: null,
          clearDueDate: false,
          priority: null,
          completed: null,
          start: null,
          end: null,
          allDay: null,
          notes: null,
          recurrence: null,
          reminderOffsets: null,
          scope: null,
        },
        { tasks: [], events: [], withheld: 0 },
        'UTC',
        [],
        completedContext.items,
      ),
    ).toBeNull();
    await h.app.close();
  });

  it('auto-approves new Tier 2 capabilities only with the owner switch', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const course = await createCourse(h, 'Geography');
    const topic = await createTopic(h, course.id, 'Maps');
    const proposal = assistantProposalSchema.parse({
      kind: 'capability',
      capability: 'topic.delete',
      arguments: { id: topic.id, expectedVersion: topic.version },
      summary: 'Delete topic (approval required)',
      tier: 2,
    });
    expect(proposalTier(proposal)).toBe(2);
    expect(
      proposalPolicyMode(proposal, {
        tasks: 'automatic',
        calendar: 'automatic',
        reminders: 'automatic',
        capabilities: 'automatic',
      }),
    ).toBe('approval-required');
    await saveTurnProposal(h, turnId, proposal);
    await h.database.query(
      `INSERT INTO ai_action_policies(owner_id,policy,auto_approve)
       VALUES($1,$2::jsonb,false)
       ON CONFLICT(owner_id) DO UPDATE SET policy=EXCLUDED.policy,auto_approve=false`,
      [
        h.owner,
        JSON.stringify({
          tasks: 'approval-required',
          calendar: 'approval-required',
          reminders: 'approval-required',
          capabilities: 'approval-required',
          email: 'approval-required',
        }),
      ],
    );
    await applyByPolicy(
      h.database,
      h.owner,
      (await readTurn(h.database, h.owner, turnId))!,
    );
    expect((await readTurn(h.database, h.owner, turnId))!.items[0]!.state).toBe(
      'proposed',
    );
    await h.database.query(
      'UPDATE ai_action_policies SET auto_approve=true WHERE owner_id=$1',
      [h.owner],
    );
    await applyByPolicy(
      h.database,
      h.owner,
      (await readTurn(h.database, h.owner, turnId))!,
    );
    expect((await readTurn(h.database, h.owner, turnId))!.items[0]!.state).toBe(
      'applied',
    );
    const [deleted] = await h.database.query(
      'SELECT deleted_at AS "deletedAt" FROM topics WHERE id=$1',
      [topic.id],
    );
    expect(deleted!.deletedAt).not.toBeNull();
    const [audit] = await h.database.query(
      'SELECT auto_approved AS "autoApproved" FROM ai_capability_audit WHERE owner_id=$1 AND tool=$2',
      [h.owner, 'topic.delete'],
    );
    expect(audit!.autoApproved).toBe(true);
    await h.app.close();
  });

  it('keeps foreign-owner records out of capability targets', async () => {
    const h = await startHarness();
    const turnId = await seedTurn(h);
    const foreignOwner = randomUUID();
    await h.database.query(
      'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
      [foreignOwner, 'foreign@example.test', 'synthetic'],
    );
    const courseId = randomUUID();
    await h.database.query(
      `INSERT INTO courses(id,owner_id,name,version) VALUES($1,$2,'Foreign class',1)`,
      [courseId, foreignOwner],
    );
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'course.update',
        { id: courseId, expectedVersion: 1, name: 'Hijack' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'course.delete',
        { id: courseId, expectedVersion: 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const topicId = randomUUID();
    await h.database.query(
      `INSERT INTO topics(id,owner_id,course_id,name,notes,confidence,progress,sensitivity,academic_labels,version)
       VALUES($1,$2,$3,'Foreign topic','','unknown',0,'unlabeled','{}',1)`,
      [topicId, foreignOwner, courseId],
    );
    const workId = randomUUID();
    await h.database.query(
      `INSERT INTO academic_work(id,owner_id,course_id,title,kind,notes,priority,status,sensitivity,academic_labels,version)
       VALUES($1,$2,$3,'Foreign work','assignment','',3,'planned','unlabeled','{}',1)`,
      [workId, foreignOwner, courseId],
    );
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'topic.update',
        { id: topicId, expectedVersion: 1, progress: 10 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'topic.delete',
        { id: topicId, expectedVersion: 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'academicWork.update',
        {
          id: workId,
          expectedVersion: 1,
          expectedCourseVersion: 1,
          notes: 'Hijack',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      executeCapability(
        h.database,
        h.owner,
        turnId,
        'academicWork.delete',
        {
          id: workId,
          expectedVersion: 1,
          expectedCourseVersion: 1,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await h.app.close();
  });
});
