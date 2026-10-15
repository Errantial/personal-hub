import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { runAgentTick } from '../src/features/agent-worker.js';
import { chatUrl, modelsUrl, zdrUrl } from '../src/ai/openrouter-live.js';
import { action, answer, model } from './helpers/openrouter.js';
import { admitLive, settleLive } from '../src/ai/live-request.js';

// Opt-in, disposable-schema PostgreSQL test: no provider or owner database use.
it.skipIf(!process.env.TEST_DATABASE_URL)(
  'serializes two workers and fences an expired worker after another claims work',
  async () => {
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    const admin = new Pool({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5000,
    });
    const schema = `hub_test_${randomUUID().replaceAll('-', '')}`;
    let database: Awaited<ReturnType<typeof openDatabase>> | undefined;
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let firstTick: Promise<unknown> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      const config = readConfig({
        NODE_ENV: 'test',
        DATABASE_URL: connection.toString(),
        AI_SECRET_OPENROUTER: 'synthetic-only',
      });
      database = await openDatabase(config);
      let calls = 0;
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          headers: { 'content-type': 'application/json' },
        });
      const fetcher = async (url: string) => {
        if (url === modelsUrl)
          return json({
            data: [
              {
                id: model,
                architecture: {
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                pricing: { prompt: '0.0000001', completion: '0.0000005' },
              },
            ],
          });
        if (url === zdrUrl)
          return json({
            data: [
              {
                model_id: model,
                tag: 'google-vertex/global',
                supported_parameters: ['structured_outputs'],
              },
            ],
          });
        if (url !== chatUrl) throw new Error('Unexpected synthetic URL');
        calls++;
        if (calls === 1) {
          entered();
          await released;
          return answer('A stale block.', [
            action({
              type: 'event.create',
              title: 'Must not commit',
              start: '2036-03-09T09:00',
              end: '2036-03-09T10:00',
            }),
          ]);
        }
        return answer('Nothing to change.');
      };
      app = await buildApp(
        { logger: false },
        { config, database, openRouterFetch: fetcher },
      );
      const origin = 'http://127.0.0.1:5173';
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: { origin },
        payload: {
          email: 'worker@example.test',
          password: 'synthetic-password',
        },
      });
      expect(setup.statusCode).toBe(201);
      const headers = {
        origin,
        cookie: String(setup.headers['set-cookie']).split(';')[0]!,
      };
      const budget = await app.inject({
        method: 'PUT',
        url: '/api/v1/ai/budget',
        headers,
        payload: {
          operationId: randomUUID(),
          expectedVersion: 1,
          policy: {
            monthlyLimitMicros: 50000000,
            perRequestLimitMicros: 250000,
          },
        },
      });
      expect(budget.statusCode).toBe(200);
      const [owner] = await database.query('SELECT id FROM users');
      const agent = randomUUID();
      const conversation = randomUUID();
      await database.query(
        "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Worker test')",
        [conversation, owner!.id],
      );
      await database.query(
        "INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels,status,template,conversation_id,time_zone) VALUES($1,$2,'Worker test','Plan','unlabeled',ARRAY['unlabeled'],'active','daily-plan',$3,'UTC')",
        [agent, owner!.id, conversation],
      );
      await database.query(
        'UPDATE ai_conversations SET responsibility_id=$1 WHERE id=$2',
        [agent, conversation],
      );
      await database.query(
        'UPDATE responsibilities SET monthly_cap_micros=1000 WHERE id=$1',
        [agent],
      );
      const requests = [randomUUID(), randomUUID()].map((id) => ({
        id,
        kind: 'planner' as const,
        operationId: randomUUID(),
        hash: 'a'.repeat(64),
        model,
        maximumMicros: 700,
        withheld: 0,
        agentId: agent,
      }));
      const admissions = await Promise.allSettled(
        requests.map((request) =>
          admitLive(database!, String(owner!.id), request),
        ),
      );
      expect(admissions.map((result) => result.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const denied = admissions.find((result) => result.status === 'rejected');
      expect(denied).toMatchObject({
        reason: { code: 'AGENT_BUDGET_EXCEEDED' },
      });
      const admitted =
        requests[
          admissions.findIndex((result) => result.status === 'fulfilled')
        ]!;
      await settleLive(
        database,
        String(owner!.id),
        admitted.id,
        { status: 'rejected', reason: 'rate-limited' },
        { proposals: 0, dropped: 0 },
        null,
      );
      await database.query(
        'UPDATE responsibilities SET monthly_cap_micros=2000000 WHERE id=$1',
        [agent],
      );
      const ids = [randomUUID(), randomUUID()];
      for (const id of ids)
        await database.query(
          "INSERT INTO responsibility_runs(id,owner_id,responsibility_id,responsibility_version,trigger,input_hash,labels,status) VALUES($1,$2,$3,1,'manual',$4,ARRAY['unlabeled'],'queued')",
          [id, owner!.id, agent, 'b'.repeat(64)],
        );
      firstTick = runAgentTick(database, config, fetcher);
      await dispatched;
      const [first] = await database.query(
        "SELECT id FROM responsibility_runs WHERE status='running'",
      );
      expect((await runAgentTick(database, config, fetcher)).ran).toBeNull();
      expect(calls).toBe(1);
      await database.query(
        "UPDATE responsibility_runs SET lease_until=CURRENT_TIMESTAMP - interval '1 second' WHERE id=$1",
        [first!.id],
      );
      const next = await runAgentTick(database, config, fetcher);
      expect(next.ran).not.toBe(first!.id);
      expect(calls).toBe(2);
      release();
      await firstTick;
      const [expired] = await database.query(
        'SELECT status,error_code FROM responsibility_runs WHERE id=$1',
        [first!.id],
      );
      expect(expired).toMatchObject({
        status: 'failed',
        error_code: 'LEASE_EXPIRED',
      });
      const [events] = await database.query(
        'SELECT count(*)::int AS count FROM events',
      );
      expect(events!.count).toBe(0);
    } finally {
      release();
      await firstTick?.catch(() => undefined);
      await app?.close();
      if (!app) await database?.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
  30000,
);
