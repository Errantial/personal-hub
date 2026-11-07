import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { readMailBrokerSettings } from '../src/ai/broker-settings.js';

it('adds migration 076 without rewriting pre-076 broker receipts or inventing a Jev selection', async () => {
  const db = await openDatabase(
    readConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: 'memory://' }),
  );
  try {
    const directory = new URL('../migrations/', import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort();
    await db.exec(
      'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    for (const name of names.filter((name) => Number(name.slice(0, 3)) < 76)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }

    const owner = randomUUID();
    const grant = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'broker-upgrade@example.test','unused')",
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

    const statuses = ['prepared', 'uncertain', 'completed'] as const;
    const retrievals: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const retrieval = randomUUID();
      retrievals.push(retrieval);
      const reservation =
        status === 'prepared'
          ? null
          : {
              id: randomUUID(),
              status: status === 'uncertain' ? 'uncertain' : 'settled',
              actual: status === 'completed' ? 5 : null,
            };
      if (reservation)
        await db.query(
          `INSERT INTO ai_budget_reservations(
            id,owner_id,request_id,request_hash,month,provider,model,policy_version,
            reserved_micros,actual_micros,status
          ) VALUES($1,$2,$3,$4,'2026-10-01','mail-broker','google/gemini-2.5-flash-lite',1,4020,$5,$6)`,
          [
            reservation.id,
            owner,
            randomUUID(),
            `broker-reservation-${index}`,
            reservation.actual,
            reservation.status,
          ],
        );
      await db.query(
        `INSERT INTO mail_broker_retrievals(
          id,owner_id,operation_id,request_hash,grant_id,grant_version,intent_digest,
          snapshot,context,limits,cursor_token,coverage,status,selected_ids
        ) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          retrieval,
          owner,
          randomUUID(),
          `request-${index}`,
          grant,
          `intent-${index}`,
          JSON.stringify([]),
          JSON.stringify({ logicalRequestId: randomUUID() }),
          JSON.stringify({
            maxResults: 50,
            maxCandidates: 500,
            windowHasMore: false,
          }),
          randomUUID(),
          JSON.stringify({ inspected: 0, selected: 0 }),
          status === 'prepared'
            ? 'pending'
            : status === 'uncertain'
              ? 'uncertain'
              : 'completed',
          [],
        ],
      );
      await db.query(
        `INSERT INTO mail_broker_batches(
          id,owner_id,retrieval_id,position,next_position,sources,status,reason,
          rubric_revision,bounds_revision,threshold_revision,profile_revision,
          approval_version,verification_revision,reservation_id,decisions,usage
        ) VALUES($1,$2,$3,0,0,$4,$5,$6,'mail-relevance-enum-v1','openrouter-mail-bounds-v1','direct-relevance-v1','legacy-profile',1,'legacy-verification',$7,$8,$9)`,
        [
          randomUUID(),
          owner,
          retrieval,
          JSON.stringify([]),
          status,
          status === 'uncertain' ? 'transport' : null,
          reservation?.id ?? null,
          status === 'completed'
            ? JSON.stringify([
                {
                  id: randomUUID(),
                  judgment: 'directly_relevant',
                  selected: true,
                },
              ])
            : null,
          status === 'completed'
            ? JSON.stringify({
                inputTokens: 100,
                outputTokens: 10,
                actualMicros: 5,
              })
            : null,
        ],
      );
    }
    const legacyBinding = {
      grantId: grant,
      grantVersion: 1,
      sources: [],
      selectedIds: [],
      policy: 'legacy-policy-digest',
    };
    await db.query(
      'INSERT INTO mail_broker_forwardings(retrieval_id,owner_id,request_id,binding,digest) VALUES($1,$2,$3,$4,$5)',
      [
        retrievals[2],
        owner,
        randomUUID(),
        JSON.stringify(legacyBinding),
        'legacy-forwarding-digest',
      ],
    );

    const answerReservation = randomUUID();
    const answerRequest = randomUUID();
    const conversation = randomUUID();
    await db.query(
      `INSERT INTO ai_budget_reservations(
        id,owner_id,request_id,request_hash,month,provider,model,policy_version,
        reserved_micros,actual_micros,status
      ) VALUES($1,$2,$3,'answer-reservation','2026-10-01','openrouter','synthetic-answer-model',1,1000,7,'settled')`,
      [answerReservation, owner, answerRequest],
    );
    await db.query(
      `INSERT INTO ai_assistant_requests(
        id,owner_id,operation_id,request_hash,model,reservation_id,status,cost_micros
      ) VALUES($1,$2,$3,'answer-request','synthetic-answer-model',$4,'completed',7)`,
      [answerRequest, owner, randomUUID(), answerReservation],
    );
    await db.query(
      "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Retained broker turn')",
      [conversation, owner],
    );
    await db.query(
      `INSERT INTO ai_conversation_turns(
        id,owner_id,conversation_id,position,ask,reply,mail_broker
      ) VALUES($1,$2,$3,0,'Synthetic ask','Synthetic answer',$4)`,
      [
        answerRequest,
        owner,
        conversation,
        JSON.stringify({
          receipt: {
            id: retrievals[2],
            status: 'completed',
            coverage: { inspected: 1, judged: 1, selected: 1 },
          },
          continuation: randomUUID(),
        }),
      ],
    );

    const before = {
      grants: await db.query(
        'SELECT * FROM mail_broker_grants WHERE owner_id=$1',
        [owner],
      ),
      retrievals: await db.query(
        'SELECT * FROM mail_broker_retrievals WHERE owner_id=$1 ORDER BY request_hash',
        [owner],
      ),
      batches: await db.query(
        'SELECT * FROM mail_broker_batches WHERE owner_id=$1 ORDER BY status',
        [owner],
      ),
      forwardings: await db.query(
        'SELECT * FROM mail_broker_forwardings WHERE owner_id=$1',
        [owner],
      ),
      reservations: await db.query(
        'SELECT * FROM ai_budget_reservations WHERE owner_id=$1 ORDER BY request_hash',
        [owner],
      ),
      turns: await db.query(
        'SELECT id,mail_broker,version FROM ai_conversation_turns WHERE owner_id=$1',
        [owner],
      ),
    };

    const migrationName = '076_mail_broker_settings.sql';
    const migration = await readFile(new URL(migrationName, directory), 'utf8');
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
        'SELECT * FROM mail_broker_retrievals WHERE owner_id=$1 ORDER BY request_hash',
        [owner],
      ),
    ).toEqual(before.retrievals);
    expect(
      await db.query(
        'SELECT * FROM mail_broker_batches WHERE owner_id=$1 ORDER BY status',
        [owner],
      ),
    ).toEqual(before.batches);
    expect(
      await db.query(
        'SELECT * FROM mail_broker_forwardings WHERE owner_id=$1',
        [owner],
      ),
    ).toEqual(before.forwardings);
    expect(
      await db.query(
        'SELECT * FROM ai_budget_reservations WHERE owner_id=$1 ORDER BY request_hash',
        [owner],
      ),
    ).toEqual(before.reservations);
    expect(
      await db.query(
        'SELECT id,mail_broker,version FROM ai_conversation_turns WHERE owner_id=$1',
        [owner],
      ),
    ).toEqual(before.turns);
    expect(await db.query('SELECT * FROM mail_broker_settings')).toEqual([]);
    expect(await readMailBrokerSettings(db, owner)).toEqual({
      version: 1,
      selectedAlias: 'mail-broker',
    });
  } finally {
    await db.close();
  }
});
