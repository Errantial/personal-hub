import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { Config } from '../config.js';

export interface QueryExecutor {
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<T[]>;
  exec(sql: string): Promise<void>;
}
export interface Database extends QueryExecutor {
  transaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
function postgresQueries(client: Pool | PoolClient): QueryExecutor {
  return {
    async query<T extends Record<string, unknown>>(
      sql: string,
      values: unknown[] = [],
    ) {
      return (await client.query<T>(sql, values)).rows;
    },
    async exec(sql) {
      await client.query(sql);
    },
  };
}
export async function openDatabase(config: Config): Promise<Database> {
  if (config.DATABASE_URL) {
    const pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
    });
    pool.on('error', () => {
      /* Readiness checks expose availability without logging credentials. */
    });
    return {
      ...postgresQueries(pool),
      async transaction(work) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(postgresQueries(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (config.PGLITE_DATA_DIR !== 'memory://')
    await mkdir(config.PGLITE_DATA_DIR, { recursive: true, mode: 0o700 });
  const pg = await PGlite.create(config.PGLITE_DATA_DIR);
  return {
    async query<T extends Record<string, unknown>>(
      sql: string,
      values: unknown[] = [],
    ) {
      return (await pg.query<T>(sql, values)).rows;
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    transaction: (work) =>
      pg.transaction((transaction) =>
        work({
          async query<T extends Record<string, unknown>>(
            sql: string,
            values: unknown[] = [],
          ) {
            return (await transaction.query<T>(sql, values)).rows;
          },
          async exec(sql) {
            await transaction.exec(sql);
          },
        }),
      ),
    close: () => pg.close(),
  };
}
