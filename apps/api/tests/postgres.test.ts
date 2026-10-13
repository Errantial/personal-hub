import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  academicWorkSchema,
  calendarRecordSchema,
  academicWorkBrowseResponseSchema,
} from '@hub/contracts';
import type { AcademicWork, CalendarRecord } from '@hub/contracts';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runReminderBatch } from '../src/features/reminders.js';
import { resolveAIContext } from '../src/features/ai-routing.js';
import {
  beginSyntheticEmailAttempt,
  confirmSyntheticEmailAttempt,
} from '../src/email/synthetic-execution.js';
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
            AI_PROVIDER_PROFILES: JSON.stringify([
              {
                alias: 'consent-test',
                adapter: 'anthropic',
                model: 'synthetic-only',
                credentialEnv: 'AI_SECRET_TEST',
                enabled: false,
                maxInputCharacters: 1000,
                maxOutputTokens: 100,
                retentionDisclosure: {
                  revision: 'synthetic-v1',
                  summary: 'Synthetic PostgreSQL test disclosure.',
                },
              },
            ]),
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
      const restorePayload = { expectedVersion: 3, operationId: randomUUID() };
      const restores = await Promise.all(
        [0, 1].map(() =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/tasks/${id}/restore`,
            headers,
            payload: restorePayload,
          }),
        ),
      );
      expect(restores.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(restores[0]!.json()).toEqual(restores[1]!.json());
      expect(restores[0]!.json().task).toMatchObject({
        version: 4,
        deletedAt: null,
      });
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
      const consentPayload = {
        operationId: randomUUID(),
        expectedVersion: 1,
        expectedRegistryRevision: registry.revision,
        approved: true,
      };
      const consentApprovals = await Promise.all(
        [0, 1].map(() =>
          app!.inject({
            method: 'PUT',
            url: '/api/v1/ai/provider-consents/consent-test',
            headers,
            payload: consentPayload,
          }),
        ),
      );
      expect(consentApprovals.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);
      expect(consentApprovals[0]!.json()).toEqual(consentApprovals[1]!.json());
      const competingConsents = await Promise.all(
        [0, 1].map(() =>
          app!.inject({
            method: 'PUT',
            url: '/api/v1/ai/provider-consents/consent-test',
            headers,
            payload: {
              ...consentPayload,
              expectedVersion: 2,
              operationId: randomUUID(),
              approved: false,
            },
          }),
        ),
      );
      expect(
        competingConsents.map((response) => response.statusCode).sort(),
      ).toEqual([200, 409]);
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
      const requestPayload = { ...preflightPayload, operationId: randomUUID() };
      const requestRace = await Promise.all(
        Array.from({ length: 4 }, () =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/ai/requests',
            headers,
            payload: requestPayload,
          }),
        ),
      );
      for (const response of requestRace) {
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual(requestRace[0]!.json());
      }
      const requestId = requestRace[0]!.json().id;
      const cancelRace = await Promise.all(
        Array.from({ length: 2 }, () =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/ai/requests/${requestId}/cancel`,
            headers,
            payload: { operationId: randomUUID(), expectedVersion: 1 },
          }),
        ),
      );
      expect(cancelRace.map((response) => response.statusCode).sort()).toEqual([
        200, 409,
      ]);
      const secondPreflight = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/preflights',
        headers,
        payload: { ...preflightPayload, operationId: randomUUID() },
      });
      const studyCourse = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/courses',
          headers,
          payload: { name: 'Postgres study', operationId: randomUUID() },
        })
      ).json().course;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/study/preferences',
            headers,
            payload: {
              operationId: randomUUID(),
              expectedVersion: 1,
              timeZone: 'UTC',
              sessionMinutes: 30,
              breakMinutes: 5,
              dailyMaximumMinutes: 60,
              windows: Array.from({ length: 7 }, (_, i) => ({
                day: i + 1,
                startMinute: 540,
                endMinute: 720,
              })),
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/study/goals/${studyCourse.id}`,
            headers,
            payload: {
              operationId: randomUUID(),
              expectedVersion: 1,
              minutesPerWeek: 60,
              priority: 3,
              targetDate: null,
            },
          })
        ).statusCode,
      ).toBe(200);
      const studyRange = { from: '2030-04-01', to: '2030-04-08' };
      const studyPreview = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/study/preview',
          headers,
          payload: studyRange,
        })
      ).json();
      const studyPlan = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/study/plans',
          headers,
          payload: {
            ...studyRange,
            operationId: randomUUID(),
            expectedContextRevision: studyPreview.contextRevision,
          },
        })
      ).json();
      const studyApproval = { operationId: randomUUID(), expectedVersion: 1 };
      const manualStudyWork = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/academic-work',
          headers,
          payload: {
            operationId: randomUUID(),
            courseId: studyCourse.id,
            title: 'Synthetic deadline',
            dueDate: studyRange.from,
            estimatedMinutes: 50,
          },
        })
      ).json().work;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/study/plans/${studyPlan.id}/approve`,
            headers,
            payload: studyApproval,
          })
        ).json().error.code,
      ).toBe('STUDY_CONTEXT_CONFLICT');
      const freshStudyPreview = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/study/preview',
          headers,
          payload: studyRange,
        })
      ).json();
      expect(
        freshStudyPreview.priorities.find(
          (p: { courseId: string }) => p.courseId === studyCourse.id,
        ).academicWork.estimatedOpenMinutes,
      ).toBe(50);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/study/plans/${studyPlan.id}`,
            headers,
            payload: {
              operationId: randomUUID(),
              expectedVersion: 1,
              expectedContextRevision: freshStudyPreview.contextRevision,
              slots: freshStudyPreview.slots,
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(manualStudyWork.courseId).toBe(studyCourse.id);
      studyApproval.expectedVersion = 2;
      studyApproval.operationId = randomUUID();
      const studyApprovals = await Promise.all(
        [0, 1].map(() =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/study/plans/${studyPlan.id}/approve`,
            headers,
            payload: studyApproval,
          }),
        ),
      );
      expect(studyApprovals.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(studyApprovals[0]!.json()).toEqual(studyApprovals[1]!.json());
      expect(studyApprovals[0]!.json().eventLinks).toHaveLength(2);
      const capturedWorkload = (
        await app.inject({
          url: `/api/v1/study/plans/${studyPlan.id}/workload`,
          headers,
        })
      ).json();
      expect(capturedWorkload).toMatchObject({
        history: 'captured',
        context: { sourceCount: 1 },
      });
      expect(capturedWorkload.sources[0]).toMatchObject({
        changed: false,
        snapshot: { id: manualStudyWork.id, version: 1, estimatedMinutes: 50 },
      });
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/academic-work/${manualStudyWork.id}`,
            headers,
            payload: {
              operationId: randomUUID(),
              expectedVersion: 1,
              courseId: studyCourse.id,
              title: 'Synthetic deadline',
              status: 'planned',
              grade: null,
              estimatedMinutes: 100,
              sensitivity: 'personal',
            },
          })
        ).statusCode,
      ).toBe(200);
      const sourceBlock = studyApprovals[0]!.json().eventLinks[0].eventId;
      const blockWorkload = (
        await app.inject({
          url: `/api/v1/calendar/${sourceBlock}/workload`,
          headers,
        })
      ).json();
      expect(blockWorkload).toMatchObject({
        history: 'captured',
        eventVersion: 2,
      });
      expect(blockWorkload.sources[0]).toMatchObject({
        changed: true,
        snapshot: { version: 1, estimatedMinutes: 50 },
        current: {
          version: 2,
          estimatedMinutes: 100,
          academicLabels: ['personal'],
        },
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
      // Independent PostgreSQL transactions must serialize competing snoozes,
      // retain the winner's receipt, and deliver the child once.
      const sourceReminderId = randomUUID();
      const sourceNotificationId = randomUUID();
      await accounting.query(
        "INSERT INTO reminders(id,owner_id,title,scheduled_at,status) VALUES($1,$2,'PostgreSQL snooze',CURRENT_TIMESTAMP,'delivered')",
        [sourceReminderId, owner],
      );
      await accounting.query(
        "INSERT INTO notifications(id,reminder_id,owner_id,title) VALUES($1,$2,$3,'PostgreSQL snooze')",
        [sourceNotificationId, sourceReminderId, owner],
      );
      const snoozeTime = new Date(Date.now() + 3600000).toISOString();
      const snoozeInputs = [1, 2].map(() => ({
        operationId: randomUUID(),
        expectedVersion: 1,
        scheduledAt: snoozeTime,
      }));
      const snoozes = await Promise.all(
        snoozeInputs.map((input) =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/reminders/${sourceReminderId}/snooze`,
            headers,
            payload: input,
          }),
        ),
      );
      expect(snoozes.map((result) => result.statusCode).sort()).toEqual([
        200, 409,
      ]);
      const winner = snoozes.findIndex((result) => result.statusCode === 200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/reminders/${sourceReminderId}/snooze`,
            headers,
            payload: snoozeInputs[winner]!,
          })
        ).json(),
      ).toEqual(snoozes[winner]!.json());
      await runReminderBatch(accounting, new Date(Date.parse(snoozeTime) + 1));
      await runReminderBatch(accounting, new Date(Date.parse(snoozeTime) + 2));
      expect(
        await accounting.query(
          'SELECT id FROM notifications WHERE reminder_id=$1',
          [snoozes[winner]!.json().reminder.id],
        ),
      ).toHaveLength(1);
      const markInput = {
        operationId: randomUUID(),
        notificationIds: [sourceNotificationId],
      };
      const marks = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/notifications/read',
            headers,
            payload: markInput,
          }),
        ),
      );
      expect(marks[0]!.statusCode).toBe(200);
      expect(marks[1]!.json()).toEqual(marks[0]!.json());
      const workCourse = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/courses',
          headers,
          payload: {
            name: 'PostgreSQL academic work',
            operationId: randomUUID(),
          },
        })
      ).json().course;
      const workRecord = (
        await app.inject({
          method: 'POST',
          url: '/api/v1/academic-work',
          headers,
          payload: {
            courseId: workCourse.id,
            title: 'Manual exam',
            status: 'submitted',
            grade: { earned: 85.5, possible: 100 },
            operationId: randomUUID(),
          },
        })
      ).json().work;
      const workWrites = await Promise.all(
        ['First work edit', 'Second work edit'].map((title) =>
          app!.inject({
            method: 'PUT',
            url: `/api/v1/academic-work/${workRecord.id}`,
            headers,
            payload: {
              courseId: workCourse.id,
              title,
              status: 'submitted',
              grade: workRecord.grade,
              operationId: randomUUID(),
              expectedVersion: 1,
            },
          }),
        ),
      );
      expect(workWrites.map((result) => result.statusCode).sort()).toEqual([
        200, 409,
      ]);
      const workDeleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/academic-work/${workRecord.id}`,
        headers,
        payload: { operationId: randomUUID(), expectedVersion: 2 },
      });
      expect(workDeleted.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/v1/courses/${workCourse.id}`,
            headers,
            payload: {
              name: 'PostgreSQL academic work',
              sensitivity: 'personal',
              operationId: randomUUID(),
              expectedVersion: 1,
            },
          })
        ).statusCode,
      ).toBe(200);
      const currentWork = (
        await app.inject({
          url: `/api/v1/academic-work/${workRecord.id}`,
          headers,
        })
      ).json().work;
      expect(currentWork).toMatchObject({
        version: 4,
        academicLabels: ['personal'],
      });
      const workRestoreInput = {
        operationId: randomUUID(),
        expectedVersion: 4,
      };
      const workRestores = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/academic-work/${workRecord.id}/restore`,
            headers,
            payload: workRestoreInput,
          }),
        ),
      );
      expect(workRestores[0]!.statusCode).toBe(200);
      expect(workRestores[1]!.json()).toEqual(workRestores[0]!.json());
      const agendaWorks: AcademicWork[] = [];
      for (const dueDate of ['2030-04-03', '2030-04-04', null]) {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/academic-work',
          headers,
          payload: {
            courseId: workCourse.id,
            title: 'Agenda work',
            dueDate,
            estimatedMinutes: 0,
            operationId: randomUUID(),
          },
        });
        expect(created.statusCode).toBe(200);
        agendaWorks.push(academicWorkSchema.parse(created.json().work));
      }
      const agendaUrl = `/api/v1/academic-work/agenda?asOf=2030-04-04&to=2030-04-11&courseId=${workCourse.id}&limit=1`;
      const firstAgenda = await app.inject({ url: agendaUrl, headers });
      expect(firstAgenda.statusCode).toBe(200);
      expect(firstAgenda.json().summary).toMatchObject({
        openCount: 3,
        overdueCount: 1,
        todayCount: 1,
        missingDeadlineCount: 1,
        missingEstimateCount: 0,
        estimatedOpenMinutes: 0,
      });
      expect(firstAgenda.json().entries[0].id).toBe(agendaWorks[0]!.id);
      const cursor = firstAgenda.json().nextAfter;
      const secondAgenda = await app.inject({
        url: `${agendaUrl}&after=${cursor.id}&expectedCursorVersion=${cursor.version}`,
        headers,
      });
      expect(secondAgenda.statusCode).toBe(200);
      expect(secondAgenda.json().entries[0].id).toBe(agendaWorks[1]!.id);
      const secondCursor = secondAgenda.json().nextAfter;
      const thirdAgenda = await app.inject({
        url: `${agendaUrl}&after=${secondCursor.id}&expectedCursorVersion=${secondCursor.version}`,
        headers,
      });
      expect(thirdAgenda.statusCode).toBe(200);
      expect(thirdAgenda.json().entries[0].id).toBe(agendaWorks[2]!.id);
      expect(thirdAgenda.json().nextAfter).toBeNull();
      const planningInput = {
        kind: 'task',
        expectedWorkVersion: 1,
        expectedCourseVersion: 2,
        operationId: randomUUID(),
        task: { title: 'Academic linked PostgreSQL task' },
      };
      const planningUrl = `/api/v1/academic-work/${agendaWorks[0]!.id}/planner-work`;
      const linkedCreates = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: planningUrl,
            headers,
            payload: planningInput,
          }),
        ),
      );
      expect(linkedCreates[0]!.statusCode).toBe(200);
      expect(linkedCreates[1]!.json()).toEqual(linkedCreates[0]!.json());
      const linkedTask = linkedCreates[0]!.json().task;
      const inspection = await app.inject({
        url: `/api/v1/tasks/${linkedTask.id}/academic-source`,
        headers,
      });
      expect(inspection.statusCode).toBe(200);
      expect(inspection.json().source.snapshot).toMatchObject({
        id: agendaWorks[0]!.id,
        version: 1,
        estimatedMinutes: 0,
      });
      // Manual academic text and direct planner origins use the same owned,
      // versioned provenance gates on the standard driver as on PGlite.
      const academicContext = await accounting!.transaction(async (tx) => {
        await tx.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
        return resolveAIContext(
          tx,
          setup.json().user.id,
          {
            kind: 'academic-work',
            id: agendaWorks[0]!.id,
            expectedVersion: 1,
            expectedCourseVersion: 2,
          },
          true,
        );
      });
      expect(academicContext.academicCourse).toEqual({
        id: workCourse.id,
        version: 2,
      });
      const plannerContext = await resolveAIContext(
        accounting!,
        setup.json().user.id,
        {
          kind: 'task',
          id: linkedTask.id,
          expectedVersion: linkedTask.version,
        },
        true,
      );
      expect(plannerContext.academicPlanning).toMatchObject({
        workId: agendaWorks[0]!.id,
      });
      await expect(
        accounting!.query(
          'DELETE FROM academic_planner_sources WHERE owner_id=$1 AND task_id=$2',
          [setup.json().user.id, linkedTask.id],
        ),
      ).rejects.toThrow('cannot be removed');
      const summary = await app.inject({
        url: `/api/v1/academic-work/${agendaWorks[0]!.id}/planner-work-summary?from=2030-04-04&to=2030-04-11&timeZone=UTC`,
        headers,
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().tasks.openCount).toBe(1);
      const academicReminder = await app.inject({
        method: 'POST',
        url: '/api/v1/reminders',
        headers,
        payload: {
          title: 'Academic PostgreSQL reminder',
          targetKind: 'academic-work',
          targetId: agendaWorks[0]!.id,
          scheduledAt: '2020-01-01T00:00:00Z',
          operationId: randomUUID(),
        },
      });
      expect(academicReminder.statusCode).toBe(200);
      await runReminderBatch(accounting!);
      expect(
        (
          await app.inject({
            url: `/api/v1/reminders/${academicReminder.json().reminder.id}`,
            headers,
          })
        ).json().reminder.status,
      ).toBe('delivered');
      const taskAgenda = await app.inject({
        url: '/api/v1/tasks/agenda?asOf=2030-04-04&to=2030-04-11&limit=200',
        headers,
      });
      expect(taskAgenda.statusCode).toBe(200);
      expect(
        taskAgenda
          .json()
          .entries.some(
            (entry: { task: { id: string } }) =>
              entry.task.id === linkedTask.id,
          ),
      ).toBe(true);
      const today = await app.inject({
        url: '/api/v1/today/summary?asOf=2030-04-04&to=2030-04-11',
        headers,
      });
      expect(today.statusCode).toBe(200);
      expect(today.json().tasks).toEqual(taskAgenda.json().summary);
      expect(today.json().reminders.unreadCount).toBeGreaterThan(0);
      expect(today.json().academicWork.openCount).toBeGreaterThan(0);
      const actionPolicyInput = {
        operationId: randomUUID(),
        expectedVersion: 1,
        policy: {
          tasks: 'automatic',
          calendar: 'automatic',
          email: 'approval-required',
        },
      };
      const actionPolicies = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'PUT',
            url: '/api/v1/ai/actions',
            headers,
            payload: actionPolicyInput,
          }),
        ),
      );
      expect(actionPolicies[0]!.statusCode).toBe(200);
      expect(actionPolicies[1]!.json()).toEqual(actionPolicies[0]!.json());
      const actionPreview = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/actions/preview',
        headers,
        payload: {
          expectedPolicyVersion: 2,
          action: {
            kind: 'calendar.update',
            connection: 'proton-calendar',
            outboundEmail: 'invitation',
          },
        },
      });
      expect(actionPreview.statusCode).toBe(200);
      expect(actionPreview.json()).toMatchObject({
        executionEnabled: false,
        emailApprovalRequired: true,
        blockers: [
          'EMAIL_APPROVAL_REQUIRED',
          'WRITE_CAPABILITY_UNVERIFIED',
          'ACTION_EXECUTION_UNAVAILABLE',
        ],
      });
      const emailCreated = await app.inject({
        method: 'POST',
        url: '/api/v1/email/drafts',
        headers,
        payload: {
          operationId: randomUUID(),
          message: {
            connection: 'outlook-mail',
            sender: 'sender@example.test',
            to: ['recipient@example.test'],
            subject: 'Synthetic PostgreSQL email',
            body: 'Synthetic text only',
          },
        },
      });
      expect(emailCreated.statusCode).toBe(200);
      const emailDraft = emailCreated.json().draft;
      const emailApprovalInput = {
        operationId: randomUUID(),
        expectedVersion: 1,
        reviewedContentHash: emailDraft.contentHash,
        decision: 'approve-exact-message',
      };
      const distinctEmailApprovals = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/email/drafts/${emailDraft.id}/approve`,
            headers,
            payload: { ...emailApprovalInput, operationId: randomUUID() },
          }),
        ),
      );
      expect(
        distinctEmailApprovals.every((response) => response.statusCode === 200),
      ).toBe(true);
      expect(distinctEmailApprovals[1]!.json()).toEqual(
        distinctEmailApprovals[0]!.json(),
      );
      const emailApprovals = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: `/api/v1/email/drafts/${emailDraft.id}/approve`,
            headers,
            payload: emailApprovalInput,
          }),
        ),
      );
      expect(emailApprovals[0]!.statusCode).toBe(200);
      expect(emailApprovals[1]!.json()).toEqual(emailApprovals[0]!.json());
      const admittedApproval = emailApprovals[0]!.json().approval;
      const emailClaimInput = {
        draftId: emailDraft.id,
        expectedVersion: 1,
        reviewedContentHash: emailDraft.contentHash,
        approvalId: admittedApproval.id,
        expectedApprovalVersion: admittedApproval.version,
      };
      const emailTestConfig = readConfig({
        NODE_ENV: 'test',
        DATABASE_URL: connection.toString(),
      });
      const emailClaims = await Promise.all(
        [1, 2].map(() =>
          beginSyntheticEmailAttempt(
            accounting!,
            emailTestConfig,
            owner,
            emailClaimInput,
          ),
        ),
      );
      expect(emailClaims.filter((claim) => claim.claimed)).toHaveLength(1);
      expect(emailClaims[1]!.attempt.id).toBe(emailClaims[0]!.attempt.id);
      const emailConfirmed = await Promise.all(
        [1, 2].map(() =>
          confirmSyntheticEmailAttempt(
            accounting!,
            emailTestConfig,
            owner,
            emailClaims[0]!.attempt.id,
            { outcome: 'not-sent' },
          ),
        ),
      );
      expect(emailConfirmed[1]).toEqual(emailConfirmed[0]);
      expect(emailConfirmed[0]).toMatchObject({
        version: 2,
        status: 'not-sent',
      });
      const emailEdited = await app.inject({
        method: 'PUT',
        url: `/api/v1/email/drafts/${emailDraft.id}`,
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: 1,
          message: {
            ...emailDraft.message,
            subject: 'Changed synthetic PostgreSQL email',
          },
        },
      });
      expect(emailEdited.statusCode).toBe(200);
      expect(emailEdited.json().draft).toMatchObject({
        version: 2,
        status: 'pending',
        approval: null,
      });
      const emailPreview = await app.inject({
        method: 'POST',
        url: `/api/v1/email/drafts/${emailDraft.id}/send-preview`,
        headers,
        payload: { expectedVersion: 2 },
      });
      expect(emailPreview.statusCode).toBe(200);
      expect(emailPreview.json()).toMatchObject({
        executionEnabled: false,
        approvalState: 'missing',
      });
      const batchTasks = await Promise.all(
        [1, 2].map((number) =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/tasks',
            headers,
            payload: {
              title: `Synthetic PostgreSQL batch ${number}`,
              operationId: randomUUID(),
            },
          }),
        ),
      );
      expect(batchTasks.every((response) => response.statusCode === 200)).toBe(
        true,
      );
      const batchInput = {
        operationId: randomUUID(),
        items: batchTasks.map((response) => ({
          id: response.json().task.id,
          expectedVersion: 1,
        })),
        action: {
          kind: 'update',
          changes: { completed: true, dueDate: '2030-04-04' },
        },
      };
      const batchResults = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/tasks/batch',
            headers,
            payload: batchInput,
          }),
        ),
      );
      expect(batchResults[0]!.statusCode).toBe(200);
      expect(batchResults[1]!.json()).toEqual(batchResults[0]!.json());
      const competingBatches = await Promise.all(
        ['high', 'low'].map((priority) =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/tasks/batch',
            headers,
            payload: {
              operationId: randomUUID(),
              items: batchInput.items.map((item) => ({
                ...item,
                expectedVersion: 2,
              })),
              action: { kind: 'update', changes: { priority } },
            },
          }),
        ),
      );
      expect(
        competingBatches.map((response) => response.statusCode).sort(),
      ).toEqual([200, 409]);
      const completedPage = await app.inject({
        url: '/api/v1/tasks/browse?status=completed&limit=200',
        headers,
      });
      expect(completedPage.statusCode).toBe(200);
      for (const selected of batchInput.items)
        expect(
          completedPage
            .json()
            .tasks.find((task: { id: string }) => task.id === selected.id),
        ).toMatchObject({ version: 3, completed: true });
      const finalExport = (
        await app.inject({ url: '/api/v1/planner/export', headers })
      ).json();
      const responsibilityRequest = {
        operationId: randomUUID(),
        title: 'Synthetic PostgreSQL responsibility',
        goal: 'Synthetic owner review text',
        sensitivity: 'restricted',
      };
      const responsibilityCreates = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/responsibilities',
            headers,
            payload: responsibilityRequest,
          }),
        ),
      );
      expect(responsibilityCreates[0]!.statusCode).toBe(200);
      expect(responsibilityCreates[1]!.json()).toEqual(
        responsibilityCreates[0]!.json(),
      );
      const responsibilityId =
        responsibilityCreates[0]!.json().responsibility.id;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/responsibilities/${responsibilityId}/resume`,
            headers,
            payload: { operationId: randomUUID(), expectedVersion: 1 },
          })
        ).statusCode,
      ).toBe(200);
      const responsibilitySchedule = await app.inject({
        method: 'PUT',
        url: `/api/v1/responsibilities/${responsibilityId}/schedule`,
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: 2,
          schedule: {
            startsAt: new Date(Date.now() - 60000).toISOString(),
            intervalMinutes: null,
          },
        },
      });
      expect(responsibilitySchedule.statusCode).toBe(200);
      const admission = {
        operationId: randomUUID(),
        items: [
          {
            id: responsibilityId,
            expectedVersion: 3,
            expectedScheduleVersion: 1,
          },
        ],
      };
      const admitted = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/responsibilities/admit-due',
            headers,
            payload: admission,
          }),
        ),
      );
      expect(admitted[0]!.statusCode).toBe(200);
      expect(admitted[1]!.json()).toEqual(admitted[0]!.json());
      expect(admitted[0]!.json()).toMatchObject({
        executionEnabled: false,
        runs: [{ status: 'blocked', trigger: 'schedule' }],
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/responsibilities/${responsibilityId}/pause`,
            headers,
            payload: { operationId: randomUUID(), expectedVersion: 3 },
          })
        ).statusCode,
      ).toBe(200);
      const responsibilityExport = (
        await app.inject({ url: '/api/v1/planner/export', headers })
      ).json();
      expect(responsibilityExport.records.responsibilityRuns).toHaveLength(1);
      expect(responsibilityExport.records.responsibilityRuns[0]).toMatchObject({
        status: 'cancelled',
        cancelReason: 'responsibility-paused',
        version: 2,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/responsibilities/${responsibilityId}/resume`,
            headers,
            payload: { operationId: randomUUID(), expectedVersion: 4 },
          })
        ).statusCode,
      ).toBe(200);
      const manualReview = await app.inject({
        method: 'POST',
        url: `/api/v1/responsibilities/${responsibilityId}/runs`,
        headers,
        payload: { operationId: randomUUID(), expectedVersion: 5 },
      });
      expect(manualReview.statusCode).toBe(200);
      const reviewInbox = await app.inject({
        url: '/api/v1/responsibilities/runs/inbox',
        headers,
      });
      expect(reviewInbox.statusCode).toBe(200);
      expect(reviewInbox.json()).toMatchObject({
        counts: { blocked: 1, cancelled: 1 },
        executionEnabled: false,
      });
      const selectedDismiss = {
        operationId: randomUUID(),
        items: [{ id: manualReview.json().run.id, expectedVersion: 1 }],
      };
      const reviewDismissals = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/responsibilities/runs/dismiss-batch',
            headers,
            payload: selectedDismiss,
          }),
        ),
      );
      expect(reviewDismissals[0]!.statusCode).toBe(200);
      expect(reviewDismissals[1]!.json()).toEqual(reviewDismissals[0]!.json());
      expect(
        (
          await app.inject({
            url: '/api/v1/responsibilities/attention',
            headers,
          })
        ).json(),
      ).toMatchObject({
        runs: { blocked: 0, cancelled: 2 },
        dueCount: 0,
        executionEnabled: false,
      });
      const localRule = {
        startDate: '2026-03-07',
        localTime: '09:00',
        timeZone: 'America/Denver',
        frequency: 'daily',
        interval: 1,
      };
      const localSchedule = await app.inject({
        method: 'PUT',
        url: `/api/v1/responsibilities/${responsibilityId}/local-schedule`,
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: 5,
          rule: localRule,
        },
      });
      expect(localSchedule.statusCode).toBe(200);
      expect(localSchedule.json().schedule.localRule).toEqual(localRule);
      const localAdmission = await app.inject({
        method: 'POST',
        url: '/api/v1/responsibilities/admit-due',
        headers,
        payload: {
          operationId: randomUUID(),
          items: [
            {
              id: responsibilityId,
              expectedVersion: 6,
              expectedScheduleVersion: localSchedule.json().schedule.version,
            },
          ],
        },
      });
      expect(localAdmission.statusCode).toBe(200);
      const localExport = (
        await app.inject({ url: '/api/v1/planner/export', headers })
      ).json();
      expect(localExport.records.responsibilitySchedules[0].localRule).toEqual(
        localRule,
      );
      expect(
        localExport.records.responsibilitySchedules[0].nextLocalIndex,
      ).toBeGreaterThan(0);
      const memoryRequest = {
        operationId: randomUUID(),
        kind: 'preference',
        title: 'Synthetic PostgreSQL preference',
        content: 'Synthetic PostgreSQL memory text',
        sensitivity: 'restricted',
      };
      const memoryCreates = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/memory',
            headers,
            payload: memoryRequest,
          }),
        ),
      );
      expect(memoryCreates[0]!.statusCode).toBe(200);
      expect(memoryCreates[1]!.json()).toEqual(memoryCreates[0]!.json());
      expect(JSON.stringify(memoryCreates[0]!.json())).not.toContain(
        memoryRequest.content,
      );
      const memoryId = memoryCreates[0]!.json().memory.id;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/memory/settings',
            headers,
            payload: {
              operationId: randomUUID(),
              expectedVersion: 1,
              enabled: true,
            },
          })
        ).statusCode,
      ).toBe(200);
      const memoryContextInput = {
        expectedPolicyVersion: (
          await app.inject({ url: '/api/v1/ai/routing', headers })
        ).json().version,
        text: 'Synthetic PostgreSQL memory context',
        sensitivity: 'unlabeled',
        sources: [
          {
            kind: 'memory',
            id: memoryId,
            expectedVersion: 1,
            expectedMemorySettingsVersion: 2,
          },
        ],
        simulatedAvailableProviders: [
          'routine',
          'private',
          'vault',
          'consent-test',
        ],
      };
      const memoryContext = await app.inject({
        method: 'POST',
        url: '/api/v1/ai/routing/preview',
        headers,
        payload: memoryContextInput,
      });
      expect(memoryContext.statusCode).toBe(200);
      expect(memoryContext.json().sources[0]).toMatchObject({
        kind: 'memory',
        labels: ['restricted'],
        memorySettingsVersion: 2,
      });
      const memoryForget = { operationId: randomUUID(), expectedVersion: 1 };
      const memoryDeletes = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'DELETE',
            url: `/api/v1/memory/${memoryId}`,
            headers,
            payload: memoryForget,
          }),
        ),
      );
      expect(memoryDeletes[0]!.statusCode).toBe(200);
      expect(memoryDeletes[1]!.json()).toEqual(memoryDeletes[0]!.json());
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/ai/routing/preview',
            headers,
            payload: memoryContextInput,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/memory',
            headers,
            payload: memoryRequest,
          })
        ).json(),
      ).toEqual(memoryCreates[0]!.json());
      const forgottenMemoryExport = (
        await app.inject({ url: '/api/v1/planner/export', headers })
      ).json();
      expect(forgottenMemoryExport.records.memories).toHaveLength(1);
      expect(forgottenMemoryExport.records.memories[0]).toMatchObject({
        title: null,
        content: null,
        version: 2,
        enabled: false,
      });
      expect(JSON.stringify(forgottenMemoryExport)).not.toContain(
        memoryRequest.content,
      );
      expect(finalExport.records.canvasReconciliations).toHaveLength(1);
      expect(finalExport.records.aiRouting.version).toBe(policy.json().version);
      expect(finalExport.records.aiActions).toEqual(actionPolicies[0]!.json());
      expect(finalExport.records.emailApprovals[0]).toMatchObject({
        draftId: emailDraft.id,
        version: 2,
        revokedAt: expect.any(String),
      });
      expect(finalExport.records.emailAttempts).toEqual([emailConfirmed[0]]);
      expect(finalExport.records.aiPreflights).toHaveLength(2);
      expect(finalExport.records.aiBudgetReservations).toHaveLength(2);
      expect(finalExport.records.canvasLmsSource.accountProviderId).toBe('30');
      const batchCourse = await app.inject({
        method: 'POST',
        url: '/api/v1/courses',
        headers,
        payload: {
          operationId: randomUUID(),
          name: 'PostgreSQL selected changes',
        },
      });
      expect(batchCourse.statusCode).toBe(200);
      const batchCourseId = batchCourse.json().course.id;
      const selectedWork: AcademicWork[] = [];
      for (let index = 0; index < 3; index++) {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/academic-work',
          headers,
          payload: {
            operationId: randomUUID(),
            courseId: batchCourseId,
            title: 'PostgreSQL selected work',
            dueDate: index ? null : '2030-04-04',
            estimatedMinutes: 0,
          },
        });
        expect(created.statusCode).toBe(200);
        selectedWork.push(academicWorkSchema.parse(created.json().work));
      }
      const browsed = await app.inject({
        url: `/api/v1/academic-work/browse?courseId=${batchCourseId}&limit=1`,
        headers,
      });
      expect(browsed.statusCode).toBe(200);
      const browseResult = academicWorkBrowseResponseSchema.parse(
        browsed.json(),
      );
      expect(browseResult.summary).toMatchObject({
        totalCount: 3,
        openCount: 3,
        missingDeadlineCount: 2,
        missingEstimateCount: 0,
        estimatedOpenMinutes: 0,
      });
      const browseCursor = browseResult.nextAfter!;
      expect(
        (
          await app.inject({
            url: `/api/v1/academic-work/browse?courseId=${batchCourseId}&after=${browseCursor.id}&expectedCursorVersion=${browseCursor.version}&expectedCourseVersion=${browseCursor.courseVersion}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      const workBatch = {
        operationId: randomUUID(),
        items: selectedWork.map((value) => ({
          id: value.id,
          expectedVersion: value.version,
          expectedCourseVersion: 1,
        })),
        action: { kind: 'update', changes: { priority: 4 } },
      };
      const workCopies = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/academic-work/batch',
            headers,
            payload: workBatch,
          }),
        ),
      );
      expect(workCopies[0]!.statusCode).toBe(200);
      expect(workCopies[1]!.json()).toEqual(workCopies[0]!.json());
      const workUpdates: AcademicWork[] = workCopies[0]!.json().work;
      const workRaces = await Promise.all(
        [
          [workUpdates[0]!, workUpdates[1]!],
          [workUpdates[1]!, workUpdates[2]!],
        ].map((values, index) =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/academic-work/batch',
            headers,
            payload: {
              operationId: randomUUID(),
              items: values.map((value) => ({
                id: value.id,
                expectedVersion: value.version,
                expectedCourseVersion: 1,
              })),
              action: { kind: 'update', changes: { priority: index ? 5 : 3 } },
            },
          }),
        ),
      );
      expect(workRaces.map((response) => response.statusCode).sort()).toEqual([
        200, 409,
      ]);
      const preservedWork =
        workRaces[0]!.statusCode === 200 ? workUpdates[2]! : workUpdates[0]!;
      expect(
        (
          await app.inject({
            url: `/api/v1/academic-work/${preservedWork.id}`,
            headers,
          })
        ).json().work,
      ).toEqual(preservedWork);
      const selectedEvents: CalendarRecord[] = [];
      for (let index = 0; index < 3; index++) {
        const created = await app.inject({
          method: 'POST',
          url: '/api/v1/calendar',
          headers,
          payload: {
            operationId: randomUUID(),
            courseId: batchCourseId,
            title: 'PostgreSQL selected study',
            startsAt: '2030-04-04T09:00:00Z',
            endsAt: '2030-04-04T09:25:00Z',
            timeZone: 'UTC',
          },
        });
        expect(created.statusCode).toBe(200);
        selectedEvents.push(calendarRecordSchema.parse(created.json().event));
      }
      const eventBatch = {
        operationId: randomUUID(),
        items: selectedEvents.map((event) => ({
          id: event.id,
          expectedVersion: event.version,
        })),
        action: { kind: 'study-status', status: 'completed' },
      };
      const eventCopies = await Promise.all(
        [1, 2].map(() =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/calendar/batch',
            headers,
            payload: eventBatch,
          }),
        ),
      );
      expect(eventCopies[0]!.statusCode).toBe(200);
      expect(eventCopies[1]!.json()).toEqual(eventCopies[0]!.json());
      const eventUpdates: CalendarRecord[] = eventCopies[0]!.json().events;
      const eventRaces = await Promise.all(
        [
          [eventUpdates[0]!, eventUpdates[1]!],
          [eventUpdates[1]!, eventUpdates[2]!],
        ].map((events) =>
          app!.inject({
            method: 'POST',
            url: '/api/v1/calendar/batch',
            headers,
            payload: {
              operationId: randomUUID(),
              items: events.map((event) => ({
                id: event.id,
                expectedVersion: event.version,
              })),
              action: { kind: 'delete' },
            },
          }),
        ),
      );
      expect(
        eventRaces.filter((response) => response.statusCode === 200),
      ).toHaveLength(1);
      expect(
        eventRaces.filter((response) =>
          [404, 409].includes(response.statusCode),
        ),
      ).toHaveLength(1);
      const preservedEvent =
        eventRaces[0]!.statusCode === 200 ? eventUpdates[2]! : eventUpdates[0]!;
      expect(
        (
          await app.inject({
            url: `/api/v1/calendar/${preservedEvent.id}`,
            headers,
          })
        ).json().event,
      ).toEqual(preservedEvent);
    } finally {
      await app?.close();
      await accounting?.close();
      await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrator.end();
    }
  },
  30000,
);
