import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';

it('upgrades a populated pre-reconciliation database without rewriting annotations, snapshots, receipts or tombstones', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 9)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const itemId = randomUUID();
    const courseId = randomUUID();
    const assignmentId = randomUUID();
    const taskId = randomUUID();
    const localClassId = randomUUID();
    const legacyTopicId = randomUUID();
    const legacyEventId = randomUUID();
    const operationId = randomUUID();
    const legacySnapshot = {
      title: 'Historical assignment title',
      sensitivity: 'restricted',
      inputKind: 'assignment-api',
      version: 1,
    };
    await db.query(
      'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
      [owner, 'upgrade-synthetic@example.test', 'unused'],
    );
    await db.query(
      "INSERT INTO courses(id,owner_id,name,sensitivity) VALUES($1,$2,'Retained local class','personal')",
      [localClassId, owner],
    );
    await db.query(
      "INSERT INTO topics(id,owner_id,course_id,name,sensitivity,notes,version) VALUES($1,$2,$3,'Retained legacy topic','restricted','Retained topic notes',3)",
      [legacyTopicId, owner, localClassId],
    );
    await db.query(
      "INSERT INTO events(id,owner_id,title,starts_at,ends_at,time_zone,course_id,topic_id,sensitivity,notes,version) VALUES($1,$2,'Retained legacy study','2027-05-01T10:00:00Z','2027-05-01T11:00:00Z','UTC',$3,$4,'restricted','Retained study notes',4)",
      [legacyEventId, owner, localClassId, legacyTopicId],
    );
    await db.query(
      "INSERT INTO canvas_sources(owner_id,sensitivity) VALUES($1,'personal')",
      [owner],
    );
    await db.query(
      "INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,input_kind,notes,version) VALUES($1,$2,'upgrade-synthetic',$3::jsonb,'available','calendar-file','Retained feed notes',3)",
      [itemId, owner, JSON.stringify({ title: 'Historical feed title' })],
    );
    await db.query(
      "INSERT INTO canvas_lms_sources(owner_id,sensitivity,version,last_imported_at) VALUES($1,'personal',4,'2026-10-01T12:00:00Z')",
      [owner],
    );
    await db.query(
      "INSERT INTO canvas_lms_courses(id,owner_id,provider_id,provider_data,availability,notes,version) VALUES($1,$2,'10',$3::jsonb,'available','Retained course notes',5)",
      [courseId, owner, JSON.stringify({ name: 'Historical course' })],
    );
    await db.query(
      "INSERT INTO canvas_lms_assignments(id,owner_id,canvas_course_id,provider_id,provider_data,availability,sensitivity,notes,version) VALUES($1,$2,$3,'20',$4::jsonb,'missing','restricted','Retained assignment notes',6)",
      [
        assignmentId,
        owner,
        courseId,
        JSON.stringify({ title: 'Historical assignment title' }),
      ],
    );
    await db.query(
      "INSERT INTO tasks(id,owner_id,title,version,deleted_at,canvas_assignment_id,canvas_assignment_snapshot) VALUES($1,$2,'Retained deleted task',7,'2026-10-02T12:00:00Z',$3,$4::jsonb)",
      [taskId, owner, assignmentId, JSON.stringify(legacySnapshot)],
    );
    await db.query(
      'INSERT INTO mutation_receipts(owner_id,operation_id,payload_hash,result) VALUES($1,$2,$3,$4::jsonb)',
      [
        owner,
        operationId,
        'synthetic-hash',
        JSON.stringify({ ok: true, version: 7 }),
      ],
    );
    const retained = async () => {
      const tables = [
        'canvas_items',
        'canvas_lms_courses',
        'canvas_lms_assignments',
        'tasks',
        'mutation_receipts',
      ] as const;
      return Promise.all(
        tables.map((table) =>
          db.query(`SELECT * FROM ${table} WHERE owner_id=$1`, [owner]),
        ),
      );
    };
    const before = await retained();
    await migrate(db);
    expect(await retained()).toEqual(before);
    const [source] = await db.query(
      'SELECT version,sensitivity,account_provider_id,last_imported_at FROM canvas_lms_sources WHERE owner_id=$1',
      [owner],
    );
    expect(source).toMatchObject({
      version: 4,
      sensitivity: 'personal',
      account_provider_id: null,
    });
    const [context] = await db.query(
      'SELECT sensitivity,attachment_derived,labels FROM canvas_assignment_context WHERE owner_id=$1 AND id=$2',
      [owner, assignmentId],
    );
    expect(context).toEqual({
      sensitivity: 'restricted',
      attachment_derived: false,
      labels: ['personal', 'restricted'],
    });
    expect(
      (
        await db.query(
          'SELECT academic_labels,notes,version FROM topics WHERE id=$1',
          [legacyTopicId],
        )
      )[0],
    ).toEqual({
      academic_labels: null,
      notes: 'Retained topic notes',
      version: 3,
    });
    expect(
      (
        await db.query(
          'SELECT academic_labels,notes,version FROM events WHERE id=$1',
          [legacyEventId],
        )
      )[0],
    ).toEqual({
      academic_labels: null,
      notes: 'Retained study notes',
      version: 4,
    });
    expect(await db.query('SELECT * FROM ai_routing_policies')).toHaveLength(0);
    expect(await db.query('SELECT * FROM canvas_reconciliations')).toHaveLength(
      0,
    );
    await migrate(db);
    expect(await retained()).toEqual(before);
    expect(await db.query('SELECT name FROM schema_migrations')).toHaveLength(
      names.length,
    );
  } finally {
    await db.close();
  }
});

it('upgrades populated responsibilities, notifications and action policies through 057 without rewriting them', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 56)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const responsibility = randomUUID();
    const run = randomUUID();
    const reminder = randomUUID();
    await db.query(
      'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',
      [owner, 'agents-upgrade@example.test', 'unused'],
    );
    await db.query(
      "INSERT INTO responsibilities(id,owner_id,title,goal,sensitivity,labels) VALUES($1,$2,'Legacy review','Review weekly','unlabeled',ARRAY['unlabeled'])",
      [responsibility, owner],
    );
    await db.query(
      "INSERT INTO responsibility_runs(id,owner_id,responsibility_id,responsibility_version,trigger,input_hash,labels) VALUES($1,$2,$3,1,'manual',$4,ARRAY['unlabeled'])",
      [run, owner, responsibility, 'a'.repeat(64)],
    );
    await db.query(
      "INSERT INTO reminders(id,owner_id,title,scheduled_at) VALUES($1,$2,'Legacy reminder',CURRENT_TIMESTAMP)",
      [reminder, owner],
    );
    await db.query(
      "INSERT INTO notifications(id,reminder_id,owner_id,title) VALUES($1,$2,$3,'Legacy reminder')",
      [randomUUID(), reminder, owner],
    );
    await db.query(
      `INSERT INTO ai_action_policies(owner_id,policy) VALUES($1,'{"tasks":"blocked","calendar":"automatic","email":"approval-required"}'::jsonb)`,
      [owner],
    );
    const retained = () =>
      Promise.all(
        [
          'responsibilities',
          'responsibility_runs',
          'notifications',
          'ai_action_policies',
        ].map((table) =>
          db.query(`SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY 1`, [
            owner,
          ]),
        ),
      );
    const before = await retained();
    await migrate(db);
    const after = await retained();
    // New columns appear with defaults; every existing value is unchanged.
    after.forEach((rows, index) =>
      rows.forEach((row, at) => expect(row).toMatchObject(before[index]![at]!)),
    );
    expect(after[1]![0]).toMatchObject({ status: 'blocked', outcome: null });
    expect(after[3]![0]!.policy).toEqual({
      tasks: 'blocked',
      calendar: 'automatic',
      email: 'approval-required',
    });
    // An agent notification needs both its run and its conversation.
    await expect(
      db.query(
        "INSERT INTO notifications(id,run_id,owner_id,title) VALUES($1,$2,$3,'Run')",
        [randomUUID(), run, owner],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "INSERT INTO notifications(id,owner_id,title) VALUES($1,$2,'Nothing')",
        [randomUUID(), owner],
      ),
    ).rejects.toThrow();
    expect(await db.query('SELECT name FROM schema_migrations')).toHaveLength(
      names.length,
    );
  } finally {
    await db.close();
  }
});
