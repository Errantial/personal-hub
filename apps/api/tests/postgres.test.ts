import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  reserveAIBudget,
  changeAIBudgetReservation,
  readBudgetUsage,
} from '../src/ai/budget.js';

// CI provides a disposable PostgreSQL instance. A dedicated schema keeps this
// opt-in check separate from all existing tables in a developer's test database.
it.skipIf(!process.env.TEST_DATABASE_URL)(
  'executes migrations, idempotency and conflicting writes through the standard PostgreSQL driver',
  async () => {
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    const administrator = new Pool({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5000,
    });
    const schema = `hub_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^hub_test_[a-f0-9]{32}$/.test(schema))
      throw new Error('Invalid test schema');
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let accounting: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      await administrator.query(`CREATE SCHEMA ${schema}`);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      const origin = 'http://127.0.0.1:5173';
      app = await buildApp(
        { logger: false },
        {
          config: readConfig({
            NODE_ENV: 'test',
            DATABASE_URL: connection.toString(),
            CANVAS_API_TOKEN: 'synthetic-postgres-only',
          }),
          runWorker: true,
          canvasApiFetcher: async () => ({
            accountProviderId: '30',
            courses: [
              {
                providerId: '10',
                data: {
                  name: 'Postgres API course',
                  code: 'PG',
                  term: 'Test',
                  timeZone: 'UTC',
                },
              },
            ],
            assignments: [
              {
                providerId: '20',
                courseProviderId: '10',
                data: {
                  title: 'Postgres API assignment',
                  dueAt: '2027-03-01T17:00:00.000Z',
                  pointsPossible: 25,
                  published: true,
                  locked: false,
                },
              },
            ],
          }),
        },
      );
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: { origin },
        payload: {
          email: 'postgres@example.test',
          password: 'synthetic-postgres-password',
        },
      });
      expect(setup.statusCode).toBe(201);
      const headers = {
        origin,
        cookie: String(setup.headers['set-cookie']).split(';')[0]!,
      };
      const payload = {
        title: 'PostgreSQL task',
        dueDate: '2026-11-03',
        operationId: randomUUID(),
      };
      const create = () =>
        app!.inject({ method: 'POST', url: '/api/v1/tasks', headers, payload });
      const [first, second] = await Promise.all([create(), create()]);
      expect(first.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(first.json().task.dueDate).toBe(payload.dueDate);
      const id = first.json().task.id as string;
      const writes = await Promise.all(
        ['First edit', 'Second edit'].map((title) =>
          app!.inject({
            method: 'PUT',
            url: `/api/v1/tasks/${id}`,
            headers,
            payload: { title, expectedVersion: 1, operationId: randomUUID() },
          }),
        ),
      );
      expect(writes.map((response) => response.statusCode).sort()).toEqual([
        200, 409,
      ]);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tasks/${id}`,
        headers,
        payload: { expectedVersion: 2, operationId: randomUUID() },
      });
      expect(removed.json().task).toMatchObject({ version: 3 });
      expect(removed.json().task.deletedAt).not.toBeNull();
      const event = await app.inject({
        method: 'POST',
        url: '/api/v1/events',
        headers,
        payload: {
          title: 'PostgreSQL event',
          startsAt: '2026-11-03T09:00:00-07:00',
          endsAt: '2026-11-03T10:00:00-07:00',
          timeZone: 'America/Denver',
          operationId: randomUUID(),
        },
      });
      expect(event.statusCode).toBe(200);
      expect(event.json().event.startsAt).toBe('2026-11-03T16:00:00.000Z');
      const course = await app.inject({
        method: 'POST',
        url: '/api/v1/courses',
        headers,
        payload: { name: 'PostgreSQL class', operationId: randomUUID() },
      });
      expect(course.statusCode).toBe(200);
      const calendar = await app.inject({
        method: 'POST',
        url: '/api/v1/calendar',
        headers,
        payload: {
          title: 'Repeated study',
          startsAt: '2027-03-07T16:00:00Z',
          endsAt: '2027-03-07T17:00:00Z',
          timeZone: 'America/Denver',
          courseId: course.json().course.id,
          recurrence: {
            frequency: 'weekly',
            interval: 1,
            count: 2,
            until: null,
          },
          operationId: randomUUID(),
        },
      });
      expect(calendar.statusCode).toBe(200);
      const occurrences = await app.inject({
        url: '/api/v1/calendar/occurrences?from=2027-03-14&to=2027-03-15&timeZone=America%2FDenver',
        headers,
      });
      expect(occurrences.json().occurrences[0].startsAt).toBe(
        '2027-03-14T15:00:00.000Z',
      );
      const reminder = await app.inject({
        method: 'POST',
        url: '/api/v1/reminders',
        headers,
        payload: {
          title: 'PostgreSQL reminder',
          scheduledAt: '2020-01-01T10:00:00Z',
          operationId: randomUUID(),
        },
      });
      expect(reminder.statusCode).toBe(200);
      await expect
        .poll(
          async () => {
            const inbox = await app!.inject({
              url: '/api/v1/notifications',
              headers,
            });
            return inbox.json().notifications.length;
          },
          { timeout: 10000 },
        )
        .toBe(1);
      const account = await app.inject({
        url: '/api/v1/auth/account',
        headers,
      });
      expect(account.statusCode).toBe(200);
      expect(account.json().sessions[0].current).toBe(true);
      const exported = await app.inject({
        url: '/api/v1/planner/export',
        headers,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.json().records.notifications).toHaveLength(1);
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/connections/canvas/import',
        headers,
        payload: {
          operationId: randomUUID(),
          feed: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:postgres-synthetic\r\nDTSTART:20270301T170000Z\r\nSUMMARY:Postgres source entry\r\nURL:https://canvas.colorado.edu/courses/10/assignments/20\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        },
      });
      expect(imported.statusCode).toBe(200);
      const canvasConnection = await app.inject({
        url: '/api/v1/connections/canvas',
        headers,
      });
      expect(canvasConnection.json().items[0].inputKind).toBe('calendar-file');
      const canvasItem = canvasConnection.json().items[0];
      const linked = await app.inject({
        method: 'PUT',
        url: `/api/v1/connections/canvas/items/${canvasItem.id}`,
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: canvasItem.version,
          notes: 'Postgres linked note',
          sensitivity: 'unlabeled',
          courseId: course.json().course.id,
        },
      });
      expect(linked.statusCode).toBe(200);
      const canvasAgenda = await app.inject({
        url: '/api/v1/connections/canvas/calendar?from=2027-03-01&to=2027-03-02&timeZone=UTC',
        headers,
      });
      expect(canvasAgenda.statusCode).toBe(200);
      expect(canvasAgenda.json().items[0].courseId).toBe(
        course.json().course.id,
      );
      const sourceTask = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers,
        payload: {
          operationId: randomUUID(),
          title: 'Postgres source task',
          canvasSourceRef: {
            itemId: canvasItem.id,
            expectedVersion: linked.json().item.version,
          },
        },
      });
      expect(sourceTask.statusCode).toBe(200);
      expect(sourceTask.json().task.canvasSource).toMatchObject({
        itemId: canvasItem.id,
        inputKind: 'calendar-file',
        currentInputKind: 'calendar-file',
      });
      const sourceStudy = await app.inject({
        method: 'POST',
        url: '/api/v1/calendar',
        headers,
        payload: {
          operationId: randomUUID(),
          title: 'Postgres source study',
          courseId: course.json().course.id,
          timeZone: 'UTC',
          startsAt: '2027-02-28T17:00:00Z',
          endsAt: '2027-02-28T18:00:00Z',
          canvasSourceRef: {
            itemId: canvasItem.id,
            expectedVersion: linked.json().item.version,
          },
        },
      });
      expect(sourceStudy.statusCode).toBe(200);
      expect(sourceStudy.json().event.canvasSource.itemId).toBe(canvasItem.id);
      const concurrentTopic = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/topics',
          headers,
          payload: {
            operationId: randomUUID(),
            courseId: course.json().course.id,
            name: 'Concurrent PostgreSQL topic',
            sensitivity: 'restricted',
          },
        })
      ).json().topic;
      const concurrentWrites = await Promise.all([
        app.inject({
          method: 'PUT',
          url: `/api/v1/courses/${course.json().course.id}`,
          headers,
          payload: {
            operationId: randomUUID(),
            expectedVersion: course.json().course.version,
            name: 'PostgreSQL class',
            sensitivity: 'personal',
          },
        }),
        app.inject({
          method: 'PUT',
          url: `/api/v1/topics/${concurrentTopic.id}`,
          headers,
          payload: {
            operationId: randomUUID(),
            expectedVersion: concurrentTopic.version,
            courseId: course.json().course.id,
            name: concurrentTopic.name,
            notes: 'Concurrent topic edit',
            sensitivity: 'restricted',
          },
        }),
        app.inject({
          method: 'PUT',
          url: `/api/v1/calendar/${sourceStudy.json().event.id}`,
          headers,
          payload: {
            operationId: randomUUID(),
            expectedVersion: sourceStudy.json().event.version,
            title: 'Concurrent study edit',
            startsAt: '2027-02-28T17:00:00Z',
            endsAt: '2027-02-28T18:00:00Z',
            timeZone: 'UTC',
            courseId: course.json().course.id,
          },
        }),
      ]);
      expect(concurrentWrites[0]!.statusCode).toBe(200);
      expect(
        concurrentWrites.every((response) =>
          [200, 409].includes(response.statusCode),
        ),
      ).toBe(true);
      const lmsBase = '/api/v1/connections/canvas/lms';
      await app.inject({
        method: 'POST',
        url: `${lmsBase}/sync`,
        headers,
        payload: { operationId: randomUUID() },
      });
      await expect
        .poll(
          async () =>
            (await app!.inject({ url: lmsBase, headers })).json().assignments
              .length,
          { timeout: 10000 },
        )
        .toBe(1);
      const lms = (await app.inject({ url: lmsBase, headers })).json();
      expect(lms.accountProviderId).toBe('30');
      const annotation = await app.inject({
        method: 'PUT',
        url: `${lmsBase}/assignments/${lms.assignments[0].id}`,
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: lms.assignments[0].version,
          notes: 'Postgres API notes',
          sensitivity: 'restricted',
        },
      });
      expect(annotation.statusCode).toBe(200);
      const reconciled = await app.inject({
        method: 'PUT',
        url: `/api/v1/connections/canvas/reconciliation/${canvasItem.id}`,
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: null,
          expectedItemVersion: linked.json().item.version,
          assignmentId: lms.assignments[0].id,
          expectedAssignmentVersion: annotation.json().assignment.version,
          expectedCourseVersion: lms.courses[0].version,
        },
      });
      expect(reconciled.statusCode).toBe(200);
      const refreshedLms = (await app.inject({ url: lmsBase, headers })).json();
      expect(refreshedLms.assignments[0]).toMatchObject({
        attachmentDerived: true,
        effectiveSensitivity: 'restricted',
      });
      const work = await app.inject({
        url: `/api/v1/connections/canvas/planner-work?kind=assignment-api&itemId=${lms.assignments[0].id}`,
        headers,
      });
      expect(work.statusCode).toBe(200);
      expect(work.json().tasks[0].id).toBe(sourceTask.json().task.id);
      expect(work.json().studies[0].id).toBe(sourceStudy.json().event.id);
      const rule = { allowed: ['synthetic'], preferred: 'synthetic' };
      const policy = await app.inject({
        method: 'PUT',
        url: '/api/v1/ai/routing',
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: { unlabeled: rule, personal: rule, restricted: rule },
        },
      });
      expect(policy.statusCode).toBe(200);
      const preview = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/routing/preview',
        headers,
        payload: {
          expectedPolicyVersion: policy.json().version,
          text: 'Postgres synthetic routing',
          sensitivity: 'unlabeled',
          sources: [
            {
              kind: 'canvas-assignment',
              id: lms.assignments[0].id,
              expectedVersion: refreshedLms.assignments[0].version,
            },
          ],
          simulatedAvailableProviders: ['synthetic'],
        },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        status: 'blocked',
        reason: 'ATTACHMENT_DERIVED',
        labels: ['unlabeled', 'personal', 'restricted'],
        dispatchEnabled: false,
      });
      const registry = (
        await app.inject({ url: '/api/v1/ai/providers', headers })
      ).json();
      const preflightPayload = {
        operationId: randomUUID(),
        expectedRegistryRevision: registry.revision,
        expectedPolicyVersion: policy.json().version,
        expectedBudgetVersion: 1,
        text: 'Postgres synthetic preflight',
        sensitivity: 'unlabeled',
        sources: [],
      };
      const parallel = await Promise.all(
        Array.from({ length: 4 }, () =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/ai/preflights',
            headers,
            payload: preflightPayload,
          }),
        ),
      );
      for (const response of parallel) {
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual(parallel[0]!.json());
      }
      expect(parallel[0]!.json()).toMatchObject({
        reason: 'PROVIDER_UNAVAILABLE',
        contextAssembled: false,
        budgetVersion: 1,
      });
      const secondPreflight = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/preflights',
        headers,
        payload: { ...preflightPayload, operationId: randomUUID() },
      });
      expect(secondPreflight.statusCode).toBe(201);
      await administrator.query(
        `UPDATE ${schema}.ai_preflights SET created_at='2026-10-10T21:00:00.123456Z'`,
      );
      const firstPage = (
        await app.inject({ url: '/api/v1/ai/preflights?limit=1', headers })
      ).json();
      const secondPage = (
        await app.inject({
          url: `/api/v1/ai/preflights?limit=1&before=${firstPage.nextBefore}`,
          headers,
        })
      ).json();
      expect(secondPage.preflights).toHaveLength(1);
      expect(secondPage.preflights[0].id).not.toBe(firstPage.preflights[0].id);
      const budgetWrite = await app.inject({
        method: 'PUT',
        url: '/api/v1/ai/budget',
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: { monthlyLimitMicros: 100, perRequestLimitMicros: 80 },
        },
      });
      expect(budgetWrite.statusCode).toBe(200);
      accounting = await openDatabase(
        readConfig({ NODE_ENV: 'test', DATABASE_URL: connection.toString() }),
      );
      const owner = setup.json().user.id;
      const reserve = () =>
        reserveAIBudget(accounting!, owner, {
          requestId: randomUUID(),
          expectedPolicyVersion: budgetWrite.json().version,
          provider: 'synthetic',
          model: 'synthetic-model',
          maximumChargeMicros: 80,
        });
      const attempts = await Promise.allSettled([
        reserve(),
        reserve(),
        reserve(),
      ]);
      expect(
        attempts.filter((item) => item.status === 'fulfilled'),
      ).toHaveLength(1);
      const accepted = attempts.find((item) => item.status === 'fulfilled')!;
      if (accepted.status !== 'fulfilled')
        throw new Error('Expected synthetic reservation');
      expect(
        attempts.filter((item) => item.status === 'rejected'),
      ).toHaveLength(2);
      for (const item of attempts)
        if (item.status === 'rejected')
          expect(item.reason).toMatchObject({
            code: 'MONTHLY_BUDGET_EXCEEDED',
          });
      const uncertain = await changeAIBudgetReservation(
        accounting,
        owner,
        accepted.value.id,
        { operationId: randomUUID(), expectedVersion: 1, outcome: 'uncertain' },
      );
      expect(await readBudgetUsage(accounting, owner)).toMatchObject({
        heldMicros: '80',
        uncertainMicros: '80',
        spentMicros: '0',
      });
      await expect(
        changeAIBudgetReservation(accounting, owner, uncertain.id, {
          operationId: randomUUID(),
          expectedVersion: uncertain.version,
          outcome: 'released',
        }),
      ).rejects.toMatchObject({ code: 'BUDGET_STATE' });
      await changeAIBudgetReservation(accounting, owner, uncertain.id, {
        operationId: randomUUID(),
        expectedVersion: uncertain.version,
        outcome: 'settled',
        actualMicros: 20,
      });
      await reserve();
      expect(await readBudgetUsage(accounting, owner)).toMatchObject({
        heldMicros: '80',
        uncertainMicros: '0',
        spentMicros: '20',
      });
      const finalExport = (
        await app.inject({ url: '/api/v1/planner/export', headers })
      ).json();
      expect(finalExport.records.canvasReconciliations).toHaveLength(1);
      expect(finalExport.records.aiRouting.version).toBe(policy.json().version);
      expect(finalExport.records.aiPreflights).toHaveLength(2);
      expect(finalExport.records.aiBudgetReservations).toHaveLength(2);
      expect(finalExport.records.canvasLmsSource.accountProviderId).toBe('30');
    } finally {
      await app?.close();
      await accounting?.close();
      await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrator.end();
    }
  },
  30000,
);
