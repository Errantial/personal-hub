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
    const after = await retained();
    after.forEach((rows, index) =>
      rows.forEach((row, at) => expect(row).toMatchObject(before[index]![at]!)),
    );
    expect(after[3]![0]).toMatchObject({
      ai_origin: 'legacy-unknown',
      ai_labels: [],
    });
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
          'SELECT academic_labels,ai_origin,ai_labels,notes,version FROM events WHERE id=$1',
          [legacyEventId],
        )
      )[0],
    ).toEqual({
      academic_labels: null,
      ai_origin: 'legacy-unknown',
      ai_labels: [],
      notes: 'Retained study notes',
      version: 4,
    });
    expect(await db.query('SELECT * FROM ai_routing_policies')).toHaveLength(0);
    expect(await db.query('SELECT * FROM canvas_reconciliations')).toHaveLength(
      0,
    );
    await migrate(db);
    expect(await retained()).toEqual(after);
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

it('upgrades populated assistant turns through 068 without rewriting them', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 62)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const conversation = randomUUID();
    const turn = randomUUID();
    const reservation = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'academic-upgrade@example.test','unused')",
      [owner],
    );
    await db.query('INSERT INTO ai_budget_policies(owner_id) VALUES($1)', [
      owner,
    ]);
    await db.query(
      "INSERT INTO ai_budget_reservations(id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,actual_micros,status) VALUES($1,$2,$3,'h','2026-10-01','openrouter','anthropic/claude-haiku-5.5',1,10,0,'released')",
      [reservation, owner, turn],
    );
    await db.query(
      "INSERT INTO ai_assistant_requests(id,owner_id,operation_id,request_hash,model,reservation_id,status,reason) VALUES($1,$2,$3,'h','anthropic/claude-haiku-5.5',$4,'failed',NULL)",
      [turn, owner, randomUUID(), reservation],
    );
    await db.query(
      "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Legacy')",
      [conversation, owner],
    );
    await db.query(
      `INSERT INTO ai_conversation_turns(id,owner_id,conversation_id,position,ask,reply,proposals,items,mail) VALUES($1,$2,$3,0,'Synthetic ask','Synthetic reply','[]','[]','[{"id":"m1"}]')`,
      [turn, owner, conversation],
    );
    const retained = () =>
      db.query(
        'SELECT id,ask,reply,proposals,items,mail,version FROM ai_conversation_turns',
      );
    const before = await retained();
    await migrate(db);
    // Every existing value is unchanged; the new column defaults to empty.
    expect(await retained()).toEqual(before);
    expect(
      (await db.query('SELECT academic, memory FROM ai_conversation_turns'))[0],
    ).toEqual({ academic: [], memory: [] });
    // At most 20 academic summaries per turn.
    await expect(
      db.query(
        'UPDATE ai_conversation_turns SET academic=$2::jsonb WHERE id=$1',
        [turn, JSON.stringify(Array.from({ length: 21 }, () => ({ id: 'x' })))],
      ),
    ).rejects.toThrow();
    // At most 10 memory items per turn.
    await expect(
      db.query(
        'UPDATE ai_conversation_turns SET memory=$2::jsonb WHERE id=$1',
        [turn, JSON.stringify(Array.from({ length: 11 }, () => ({ id: 'x' })))],
      ),
    ).rejects.toThrow();
    expect(await db.query('SELECT name FROM schema_migrations')).toHaveLength(
      names.length,
    );
  } finally {
    await db.close();
  }
});

it('upgrades populated email connectors through 069 without inventing health or membership', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 68)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const connector = randomUUID();
    const message = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'mail-upgrade@example.test','unused')",
      [owner],
    );
    await db.query(
      "INSERT INTO email_connectors(id,owner_id,name,token_hash,sensitivity,since,last_seen_at) VALUES($1,$2,'Bridge',$3,'personal','2026-10-01','2026-10-15T12:00:00Z')",
      [connector, owner, 'a'.repeat(64)],
    );
    await db.query(
      "INSERT INTO email_folders(owner_id,connector_id,path,uid_validity,last_uid,exists_count,window_count) VALUES($1,$2,'INBOX','7',5,5,1)",
      [owner, connector],
    );
    await db.query(
      "INSERT INTO email_messages(id,owner_id,connector_id,message_key,received_at,body,body_truncated,folders,sensitivity) VALUES($1,$2,$3,'<legacy@example.test>','2026-10-15T12:00:00Z','Body',false,ARRAY['INBOX'],'personal')",
      [message, owner, connector],
    );
    await migrate(db);
    expect(
      (
        await db.query(
          `SELECT last_attempt_at,last_contact_at,last_import_at,last_complete_at,active_attempt_id,last_attempt_outcome,last_error_code FROM email_connectors WHERE id=$1`,
          [connector],
        )
      )[0],
    ).toEqual({
      last_attempt_at: null,
      last_contact_at: null,
      last_import_at: null,
      last_complete_at: null,
      active_attempt_id: null,
      last_attempt_outcome: null,
      last_error_code: null,
    });
    expect(
      (
        await db.query(
          'SELECT last_complete_at,last_complete_uid FROM email_folders WHERE connector_id=$1',
          [connector],
        )
      )[0],
    ).toEqual({ last_complete_at: null, last_complete_uid: null });
    expect(await db.query('SELECT * FROM email_folder_memberships')).toEqual(
      [],
    );
    const [retainedMessage] = await db.query(
      'SELECT folders FROM email_messages WHERE id=$1',
      [message],
    );
    expect(retainedMessage).toBeDefined();
    expect(retainedMessage!.folders).toEqual(['INBOX']);
  } finally {
    await db.close();
  }
});

it('upgrades populated sources through 070 without inventing Canvas browser observations', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 69)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const apiCourse = randomUUID();
    const apiAssignment = randomUUID();
    const feedItem = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'canvas-browser-upgrade@example.test','unused')",
      [owner],
    );
    await db.query(
      "INSERT INTO canvas_sources(owner_id,sensitivity,last_imported_at) VALUES($1,'personal','2026-10-15T12:00:00Z')",
      [owner],
    );
    await db.query(
      "INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,input_kind,notes) VALUES($1,$2,'retained-feed',$3::jsonb,'available','calendar-feed','Retained feed note')",
      [feedItem, owner, JSON.stringify({ title: 'Retained feed item' })],
    );
    await db.query(
      "INSERT INTO canvas_lms_sources(owner_id,sensitivity,last_imported_at) VALUES($1,'restricted','2026-10-15T12:00:00Z')",
      [owner],
    );
    await db.query(
      "INSERT INTO canvas_lms_courses(id,owner_id,provider_id,provider_data,availability,notes) VALUES($1,$2,'10',$3::jsonb,'available','Retained API course note')",
      [apiCourse, owner, JSON.stringify({ name: 'Retained API course' })],
    );
    await db.query(
      "INSERT INTO canvas_lms_assignments(id,owner_id,canvas_course_id,provider_id,provider_data,availability,notes) VALUES($1,$2,$3,'20',$4::jsonb,'available','Retained API assignment note')",
      [
        apiAssignment,
        owner,
        apiCourse,
        JSON.stringify({ title: 'Retained API assignment' }),
      ],
    );
    const beforeFeed = await db.query(
      'SELECT * FROM canvas_items WHERE owner_id=$1',
      [owner],
    );
    const beforeCourses = await db.query(
      'SELECT * FROM canvas_lms_courses WHERE owner_id=$1',
      [owner],
    );
    const beforeAssignments = await db.query(
      'SELECT * FROM canvas_lms_assignments WHERE owner_id=$1',
      [owner],
    );

    await migrate(db);

    expect(
      await db.query('SELECT * FROM canvas_items WHERE owner_id=$1', [owner]),
    ).toEqual(beforeFeed);
    expect(
      await db.query('SELECT * FROM canvas_lms_courses WHERE owner_id=$1', [
        owner,
      ]),
    ).toEqual(beforeCourses);
    expect(
      await db.query('SELECT * FROM canvas_lms_assignments WHERE owner_id=$1', [
        owner,
      ]),
    ).toEqual(beforeAssignments);
    expect(await db.query('SELECT * FROM canvas_browser_sources')).toEqual([]);
    expect(await db.query('SELECT * FROM canvas_browser_courses')).toEqual([]);
    expect(await db.query('SELECT * FROM canvas_browser_items')).toEqual([]);
    expect(await db.query('SELECT * FROM canvas_browser_attempts')).toEqual([]);
    expect(
      await db.query('SELECT * FROM canvas_browser_course_observations'),
    ).toEqual([]);
    expect(
      await db.query('SELECT * FROM canvas_browser_item_captures'),
    ).toEqual([]);
  } finally {
    await db.close();
  }
});

it('upgrades populated Canvas browser records through 071 without inventing reconciliation links', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 70)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const browserCourse = randomUUID();
    const browserItem = randomUUID();
    const feedItem = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'canvas-browser-reconciliation-upgrade@example.test','unused')",
      [owner],
    );
    await db.query('INSERT INTO canvas_sources(owner_id) VALUES($1)', [owner]);
    await db.query(
      "INSERT INTO canvas_items(id,owner_id,uid,provider_data,availability,input_kind) VALUES($1,$2,'feed',$3::jsonb,'available','calendar-feed')",
      [
        feedItem,
        owner,
        JSON.stringify({
          title: 'Feed',
          sourceUrl: 'https://canvas.colorado.edu/courses/10/assignments/20',
        }),
      ],
    );
    await db.query('INSERT INTO canvas_browser_sources(owner_id) VALUES($1)', [
      owner,
    ]);
    await db.query(
      "INSERT INTO canvas_browser_courses(id,owner_id,provider_id,name,canonical_url) VALUES($1,$2,'10','Course','https://canvas.colorado.edu/courses/10')",
      [browserCourse, owner],
    );
    await db.query(
      "INSERT INTO canvas_browser_items(id,owner_id,browser_course_id,resource_kind,provider_id,canonical_url,title,captured_at) VALUES($1,$2,$3,'assignment','20','https://canvas.colorado.edu/courses/10/assignments/20','Browser','2027-05-01T12:00:00Z')",
      [browserItem, owner, browserCourse],
    );
    const beforeFeed = await db.query(
      'SELECT * FROM canvas_items WHERE owner_id=$1',
      [owner],
    );
    const beforeBrowser = await db.query(
      'SELECT * FROM canvas_browser_items WHERE owner_id=$1',
      [owner],
    );
    await migrate(db);
    expect(
      await db.query('SELECT * FROM canvas_items WHERE owner_id=$1', [owner]),
    ).toEqual(beforeFeed);
    expect(
      await db.query('SELECT * FROM canvas_browser_items WHERE owner_id=$1', [
        owner,
      ]),
    ).toEqual(beforeBrowser);
    expect(
      await db.query('SELECT * FROM canvas_browser_reconciliations'),
    ).toEqual([]);
    expect(await db.query('SELECT name FROM schema_migrations')).toHaveLength(
      names.length,
    );
  } finally {
    await db.close();
  }
});

it('upgrades populated owner data through 072 without inventing Outlook access findings', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 71)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const task = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,'outlook-upgrade@example.test','unused')",
      [owner],
    );
    await db.query(
      "INSERT INTO tasks(id,owner_id,title,notes,version) VALUES($1,$2,'Retained task','Retained notes',3)",
      [task, owner],
    );
    const before = await db.query('SELECT * FROM tasks WHERE owner_id=$1', [
      owner,
    ]);
    await migrate(db);
    expect(
      await db.query('SELECT * FROM tasks WHERE owner_id=$1', [owner]),
    ).toEqual(before);
    expect(await db.query('SELECT * FROM outlook_access_gate')).toEqual([]);
    expect(await db.query('SELECT name FROM schema_migrations')).toHaveLength(
      names.length,
    );
  } finally {
    await db.close();
  }
});

it('upgrades populated assistant turns and requests through 060 without rewriting them', async () => {
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
    for (const name of names.filter((name) => Number(name.slice(0, 3)) <= 59)) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await db.exec(sql);
      await db.query(
        'INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',
        [name, createHash('sha256').update(sql).digest('hex')],
      );
    }
    const owner = randomUUID();
    const other = randomUUID();
    const conversation = randomUUID();
    for (const [id, email] of [
      [owner, 'live-upgrade@example.test'],
      [other, 'live-upgrade-other@example.test'],
    ])
      await db.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'unused')",
        [id, email],
      );
    const request = async (user: string, reason: string | null = null) => {
      const id = randomUUID();
      const reservation = randomUUID();
      await db.query(
        "INSERT INTO ai_budget_reservations(id,owner_id,request_id,request_hash,month,provider,model,policy_version,reserved_micros,actual_micros,status) VALUES($1,$2,$3,'h','2026-10-01','openrouter','anthropic/claude-haiku-5.5',1,10,0,'released')",
        [reservation, user, id],
      );
      await db.query(
        "INSERT INTO ai_assistant_requests(id,owner_id,operation_id,request_hash,model,reservation_id,status,reason) VALUES($1,$2,$3,'h','anthropic/claude-haiku-5.5',$4,'failed',$5)",
        [id, user, randomUUID(), reservation, reason],
      );
      return id;
    };
    for (const user of [owner, other])
      await db.query('INSERT INTO ai_budget_policies(owner_id) VALUES($1)', [
        user,
      ]);
    const mailTurn = await request(owner);
    const plainTurn = await request(owner);
    const foreign = await request(other);
    await db.query(
      "INSERT INTO ai_conversations(id,owner_id,title) VALUES($1,$2,'Legacy')",
      [conversation, owner],
    );
    await db.query(
      `INSERT INTO ai_conversation_turns(id,owner_id,conversation_id,position,ask,reply,proposals,items,mail) VALUES
        ($1,$3,$4,0,'Synthetic ask','Synthetic reply','[{"kind":"task.create"}]','[{"state":"proposed"}]','[{"id":"m1","subject":"Synthetic"}]'),
        ($2,$3,$4,1,'Second ask','Second reply','[]','[]','[]')`,
      [mailTurn, plainTurn, owner, conversation],
    );
    const turns = () =>
      db.query(
        'SELECT id,ask,reply,proposals,items,mail,version FROM ai_conversation_turns ORDER BY position',
      );
    const before = await turns();
    await migrate(db);
    expect(await turns()).toEqual(before);
    expect(
      await db.query(
        'SELECT proposal_access,inference_history,inference_digest,inference_sources FROM ai_conversation_turns ORDER BY position',
      ),
    ).toEqual([
      {
        proposal_access: 'read-only',
        inference_history: 'unbound',
        inference_digest: null,
        inference_sources: null,
      },
      {
        proposal_access: 'applicable',
        inference_history: 'unbound',
        inference_digest: null,
        inference_sources: null,
      },
    ]);
    // A bound turn needs both its digest and its sources.
    await expect(
      db.query(
        "UPDATE ai_conversation_turns SET inference_history='bound' WHERE id=$1",
        [plainTurn],
      ),
    ).rejects.toThrow();
    await request(owner, 'context-changed');
    await request(owner, 'route-blocked');
    await expect(request(owner, 'nope')).rejects.toThrow();
    // An exchange binding must belong to its request's owner.
    await expect(
      db.query(
        "INSERT INTO ai_live_exchanges(request_id,owner_id,format_version,manifest,integrity_hash,destination_revision,source_count) VALUES($1,$2,1,'{}',$3,$3,0)",
        [foreign, owner, 'a'.repeat(64)],
      ),
    ).rejects.toThrow();
    await db.query(
      "INSERT INTO ai_live_exchanges(request_id,owner_id,format_version,manifest,integrity_hash,destination_revision,source_count) VALUES($1,$2,1,'{}',$3,$3,0)",
      [foreign, other, 'a'.repeat(64)],
    );
    await expect(
      db.query(
        "INSERT INTO ai_live_destinations(owner_id,model,upstream,revision,version) VALUES($1,'anthropic/claude-haiku-5.5','google-vertex/x',$2,1)",
        [owner, 'b'.repeat(64)],
      ),
    ).rejects.toThrow();
    expect(await db.query('SELECT name FROM schema_migrations')).toHaveLength(
      names.length,
    );
  } finally {
    await db.close();
  }
});
