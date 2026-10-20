import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { readMailBrokerSettings } from '../src/ai/broker-settings.js';

it.skipIf(!process.env.TEST_DATABASE_URL)(
  'upgrades populated pre-076 broker state on PostgreSQL without rewriting receipts or inventing a selector',
  async () => {
    const connection = new URL(process.env.TEST_DATABASE_URL!);
    const administrator = new Pool({
      connectionString: connection.toString(),
      connectionTimeoutMillis: 5000,
    });
    const schema = `hub_broker_upgrade_${randomUUID().replaceAll('-', '')}`;
    if (!/^hub_broker_upgrade_[a-f0-9]{32}$/.test(schema))
      throw new Error('Invalid test schema');
    let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      await administrator.query(`CREATE SCHEMA ${schema}`);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      db = await openDatabase(
        readConfig({ NODE_ENV: 'test', DATABASE_URL: connection.toString() }),
      );
      const directory = new URL('../migrations/', import.meta.url);
      const names = (await readdir(directory))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort();
      await db.exec(
        'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)',
      );
      for (const name of names.filter(
        (name) => Number(name.slice(0, 3)) < 76,
      )) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        await db.exec(sql);
        await db.query(
          'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
          [name, createHash('sha256').update(sql).digest('hex')],
        );
      }

      const owner = randomUUID();
      const grant = randomUUID();
      const retrieval = randomUUID();
      const reservation = randomUUID();
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,'broker-pg-upgrade@example.test','unused')",
        [owner],
      );
      await db.query(
        'INSERT INTO ai_budget_policies(owner_id,monthly_limit_micros,per_request_limit_micros) VALUES($1,1000000,100000)',
        [owner],
      );
      await db.query(
        'INSERT INTO mail_broker_grants(id,owner_id,enabled,scope) VALUES($1,$2,true,$3)',
        [
          grant,
          owner,
          JSON.stringify({
            connectorIds: [randomUUID()],
            receivedAfter: null,
            receivedBefore: null,
          }),
        ],
      );
      await db.query(
        `INSERT INTO ai_budget_reservations(
          id,owner_id,request_id,request_hash,month,provider,model,policy_version,
          reserved_micros,actual_micros,status
        ) VALUES($1,$2,$3,'legacy-broker-reservation','2026-10-01','mail-broker','google/gemini-2.5-flash-lite',1,4020,5,'settled')`,
        [reservation, owner, randomUUID()],
      );
      await db.query(
        `INSERT INTO mail_broker_retrievals(
          id,owner_id,operation_id,request_hash,grant_id,grant_version,intent_digest,
          snapshot,context,limits,cursor_token,coverage,status,selected_ids
        ) VALUES($1,$2,$3,'legacy-request',$4,1,'legacy-intent','[]',$5,$6,$7,$8,'completed','{}')`,
        [
          retrieval,
          owner,
          randomUUID(),
          grant,
          JSON.stringify({ logicalRequestId: randomUUID() }),
          JSON.stringify({
            maxResults: 50,
            maxCandidates: 500,
            windowHasMore: false,
          }),
          randomUUID(),
          JSON.stringify({ inspected: 1, judged: 1, selected: 1 }),
        ],
      );
      await db.query(
        `INSERT INTO mail_broker_batches(
          id,owner_id,retrieval_id,position,next_position,sources,status,
          rubric_revision,bounds_revision,threshold_revision,profile_revision,
          approval_version,verification_revision,reservation_id,decisions,usage
        ) VALUES($1,$2,$3,0,0,'[]','completed','mail-relevance-enum-v1','openrouter-mail-bounds-v1','direct-relevance-v1','legacy-profile',1,'legacy-verification',$4,$5,$6)`,
        [
          randomUUID(),
          owner,
          retrieval,
          reservation,
          JSON.stringify([
            {
              id: randomUUID(),
              judgment: 'directly_relevant',
              selected: true,
            },
          ]),
          JSON.stringify({
            inputTokens: 100,
            outputTokens: 10,
            actualMicros: 5,
          }),
        ],
      );
      const binding = {
        grantId: grant,
        grantVersion: 1,
        sources: [],
        selectedIds: [],
        policy: 'legacy-policy-digest',
      };
      await db.query(
        'INSERT INTO mail_broker_forwardings(retrieval_id,owner_id,request_id,binding,digest) VALUES($1,$2,$3,$4,$5)',
        [
          retrieval,
          owner,
          randomUUID(),
          JSON.stringify(binding),
          'legacy-forwarding-digest',
        ],
      );

      const before = {
        grants: await db.query(
          'SELECT * FROM mail_broker_grants WHERE owner_id=$1',
          [owner],
        ),
        retrievals: await db.query(
          'SELECT * FROM mail_broker_retrievals WHERE owner_id=$1',
          [owner],
        ),
        batches: await db.query(
          'SELECT * FROM mail_broker_batches WHERE owner_id=$1',
          [owner],
        ),
        reservations: await db.query(
          'SELECT * FROM ai_budget_reservations WHERE owner_id=$1',
          [owner],
        ),
        forwardings: await db.query(
          'SELECT * FROM mail_broker_forwardings WHERE owner_id=$1',
          [owner],
        ),
      };

      const migrationName = '076_mail_broker_settings.sql';
      const migration = await readFile(
        new URL(migrationName, directory),
        'utf8',
      );
      await db.exec(migration);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [migrationName, createHash('sha256').update(migration).digest('hex')],
      );

      expect(
        await db.query('SELECT * FROM mail_broker_grants WHERE owner_id=$1', [
          owner,
        ]),
      ).toEqual(before.grants);
      expect(
        await db.query(
          'SELECT * FROM mail_broker_retrievals WHERE owner_id=$1',
          [owner],
        ),
      ).toEqual(before.retrievals);
      expect(
        await db.query('SELECT * FROM mail_broker_batches WHERE owner_id=$1', [
          owner,
        ]),
      ).toEqual(before.batches);
      expect(
        await db.query(
          'SELECT * FROM ai_budget_reservations WHERE owner_id=$1',
          [owner],
        ),
      ).toEqual(before.reservations);
      expect(
        await db.query(
          'SELECT * FROM mail_broker_forwardings WHERE owner_id=$1',
          [owner],
        ),
      ).toEqual(before.forwardings);
      expect(await db.query('SELECT * FROM mail_broker_settings')).toEqual([]);
      expect(await readMailBrokerSettings(db, owner)).toEqual({
        version: 1,
        selectedAlias: 'mail-broker',
      });
    } finally {
      await db?.close();
      await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrator.end();
    }
  },
  30000,
);
