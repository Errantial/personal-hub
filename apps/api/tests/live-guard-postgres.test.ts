import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { expect, it } from 'vitest';
import {
  admitPlanner,
  createTask,
  exchangeState,
  transmit,
} from './helpers/live.js';
import { startHarness } from './helpers/openrouter.js';
import type { Harness } from './helpers/openrouter.js';

// Disposable standard PostgreSQL only. No provider or owner database access.
it.skipIf(!process.env.TEST_DATABASE_URL)(
  'linearizes revocation without contended source locks and sends an exchange only once',
  async () => {
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    const admin = new Pool({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5000,
    });
    const schema = `hub_test_${randomUUID().replaceAll('-', '')}`;
    let h: Harness | undefined;
    let competitor: Pool | undefined;
    let transaction: PoolClient | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      h = await startHarness({ databaseUrl: connection.toString() });
      const task = await createTask(h, 'Synthetic guard race');
      const conversationId = randomUUID();
      await h.database.query(
        'INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,$3)',
        [conversationId, h.owner, 'Synthetic guard race'],
      );
      const options = { conversationId };
      const first = await admitPlanner(h, undefined, options);
      const during = await admitPlanner(h, undefined, options);
      const after = await admitPlanner(h, undefined, options);
      competitor = new Pool({
        connectionString: connection.toString(),
        connectionTimeoutMillis: 5000,
      });
      transaction = await competitor.connect();
      await transaction.query('BEGIN');
      await transaction.query(
        'SELECT 1 FROM ai_budget_policies WHERE owner_id=$1 FOR UPDATE',
        [h.owner],
      );
      await transaction.query(
        'SELECT 1 FROM ai_conversations WHERE id=$1 FOR UPDATE',
        [conversationId],
      );
      await transaction.query('SELECT 1 FROM tasks WHERE id=$1 FOR UPDATE', [
        task.id,
      ]);
      // A guard must read the committed snapshot without waiting for these locks.
      const bounded = <T>(work: Promise<T>) =>
        Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Guard waited for source locks')),
              2000,
            );
          }),
        ]).finally(() => clearTimeout(timeout));
      expect(await bounded(transmit(h, first.sealed))).toMatchObject({
        status: 'confirmed',
      });
      await transaction.query(
        "UPDATE tasks SET sensitivity='personal',version=version+1 WHERE id=$1",
        [task.id],
      );
      // This revocation is not committed at the next guard snapshot yet.
      expect(await bounded(transmit(h, during.sealed))).toMatchObject({
        status: 'confirmed',
      });
      await transaction.query('COMMIT');
      expect(await transmit(h, after.sealed)).toMatchObject({
        status: 'withheld',
        reason: 'context-changed',
      });
      expect(h.chatCalls()).toBe(2);
      expect(await exchangeState(h, after.sealed.requestId)).toMatchObject({
        hold: 'released',
        actual: 0,
        guard: 'blocked',
      });

      const raced = await admitPlanner(h);
      const results = await Promise.all([
        transmit(h, raced.sealed),
        transmit(h, raced.sealed),
      ]);
      expect(
        results.filter((result) => result.status === 'confirmed'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'withheld'),
      ).toHaveLength(1);
      expect(h.chatCalls()).toBe(3);
      // The losing guard cannot release the winner's charge hold.
      expect(await exchangeState(h, raced.sealed.requestId)).toMatchObject({
        hold: 'uncertain',
        guard: 'verified',
      });
    } finally {
      clearTimeout(timeout);
      if (transaction) {
        await transaction.query('ROLLBACK').catch(() => undefined);
        transaction.release();
      }
      await competitor?.end();
      await h?.app.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
  30000,
);
