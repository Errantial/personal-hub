import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

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
          }),
          runWorker: true,
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
    } finally {
      await app?.close();
      await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrator.end();
    }
  },
  30000,
);
