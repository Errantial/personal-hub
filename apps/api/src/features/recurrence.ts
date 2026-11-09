import { randomUUID } from 'node:crypto';
import {
  Temporal,
  nextOccurrenceDate,
  recurrenceDates,
  recurrenceSchema,
} from '@hub/contracts';
import type { RecurrenceRule } from '@hub/contracts';
import type { Database, QueryExecutor } from '../db/database.js';

type SeriesRow = {
  id: string;
  rule: unknown;
  time_zone: string;
  anchor_date: string | Date;
  cancelled_from: string | Date | null;
  deleted_at: unknown;
};

const day = (value: string | Date) =>
  typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
const instantOf = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);
const offsets = (value: unknown): number[] => {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is number => Number.isInteger(item))
    : [];
};

export async function createRecurrenceSeries(
  tx: QueryExecutor,
  owner: string,
  kind: 'task' | 'reminder',
  rule: RecurrenceRule,
  anchorDate: string,
) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO recurrence_series(id,owner_id,kind,rule,time_zone,anchor_date)
     VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
    [
      id,
      owner,
      kind,
      JSON.stringify(rule),
      rule.timeZone ?? 'America/Denver',
      anchorDate,
    ],
  );
  return id;
}

async function readSeries(tx: QueryExecutor, owner: string, id: string) {
  const [row] = await tx.query<SeriesRow>(
    `SELECT id,rule,time_zone,anchor_date,cancelled_from,deleted_at
     FROM recurrence_series WHERE id=$1 AND owner_id=$2`,
    [id, owner],
  );
  if (!row) return null;
  return {
    ...row,
    rule: recurrenceSchema.parse(row.rule),
    anchorDate: day(row.anchor_date),
    cancelledFrom: row.cancelled_from ? day(row.cancelled_from) : null,
  };
}

export async function updateRecurrenceSeries(
  tx: QueryExecutor,
  owner: string,
  id: string,
  rule: RecurrenceRule,
  anchorDate: string,
) {
  await tx.query(
    `UPDATE recurrence_series SET rule=$3::jsonb,time_zone=$4,anchor_date=$5,
       cancelled_from=CASE WHEN cancelled_from IS NOT NULL AND cancelled_from < $5 THEN cancelled_from ELSE NULL END,
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND owner_id=$2`,
    [
      id,
      owner,
      JSON.stringify(rule),
      rule.timeZone ?? 'America/Denver',
      anchorDate,
    ],
  );
}

export async function deleteRecurrenceSeries(
  tx: QueryExecutor,
  owner: string,
  id: string,
  cancelledFrom?: string,
) {
  await tx.query(
    `UPDATE recurrence_series SET deleted_at=CURRENT_TIMESTAMP,
       cancelled_from=COALESCE(cancelled_from,$3::date),
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND owner_id=$2`,
    [id, owner, cancelledFrom ?? null],
  );
}

export async function stopRecurrenceSeriesFrom(
  tx: QueryExecutor,
  owner: string,
  id: string,
  date: string,
) {
  await tx.query(
    `UPDATE recurrence_series SET
       cancelled_from=CASE WHEN cancelled_from IS NULL OR cancelled_from > $3::date THEN $3::date ELSE cancelled_from END,
       version=version+1,updated_at=CURRENT_TIMESTAMP
     WHERE id=$1 AND owner_id=$2`,
    [id, owner, date],
  );
}

function timedDue(dueAt: string, zone: string, nextDate: Temporal.PlainDate) {
  const time = Temporal.Instant.from(dueAt)
    .toZonedDateTimeISO(zone)
    .toPlainTime();
  return nextDate
    .toPlainDateTime(time)
    .toZonedDateTime(zone, { disambiguation: 'compatible' })
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}

/** Creates exactly one next occurrence for a completed or skipped task. */
export async function generateNextTaskOccurrence(
  tx: QueryExecutor,
  owner: string,
  taskId: string,
) {
  const [task] = await tx.query<Record<string, unknown>>(
    `SELECT t.id,t.title,t.notes,t.due_date,t.due_at,t.due_time_zone,t.priority,
       t.sensitivity,t.reminder_offsets,t.occurrence_key,t.series_id,
       t.canvas_source_id,t.canvas_source_snapshot,t.canvas_assignment_id,
       t.canvas_assignment_snapshot,t.ai_origin,t.ai_labels
     FROM tasks t WHERE t.owner_id=$1 AND t.id=$2`,
    [owner, taskId],
  );
  if (!task?.series_id) return null;
  const series = await readSeries(tx, owner, String(task.series_id));
  if (!series || series.deleted_at) return null;
  const currentKey = day(
    (task.occurrence_key as string | Date | null) ??
      (task.due_date as string | Date),
  );
  const next = nextOccurrenceDate(
    series.rule,
    Temporal.PlainDate.from(series.anchorDate),
    Temporal.PlainDate.from(currentKey),
  );
  if (!next) return null;
  const nextKey = next.toString();
  if (series.cancelledFrom && nextKey >= series.cancelledFrom) return null;
  const zone =
    (task.due_time_zone as string | null) ??
    series.rule.timeZone ??
    'America/Denver';
  const dueAt =
    task.due_at !== null ? timedDue(instantOf(task.due_at), zone, next) : null;
  const [saved] = await tx.query<{ id: string }>(
    `INSERT INTO tasks(id,owner_id,title,notes,due_date,due_at,due_time_zone,
       priority,completed,sensitivity,recurrence,series_id,occurrence_key,
       reminder_offsets,canvas_source_id,canvas_source_snapshot,
       canvas_assignment_id,canvas_assignment_snapshot,ai_origin,ai_labels,
       auto_generated)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10::jsonb,$11,$12,$13::jsonb,
       $14,$15::jsonb,$16,$17::jsonb,$18,$19::text[],true)
     ON CONFLICT (owner_id,series_id,occurrence_key)
       WHERE series_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      owner,
      task.title,
      task.notes,
      nextKey,
      dueAt,
      task.due_time_zone,
      task.priority,
      task.sensitivity,
      JSON.stringify(series.rule),
      series.id,
      nextKey,
      JSON.stringify(offsets(task.reminder_offsets)),
      task.canvas_source_id,
      task.canvas_source_snapshot
        ? JSON.stringify(task.canvas_source_snapshot)
        : null,
      task.canvas_assignment_id,
      task.canvas_assignment_snapshot
        ? JSON.stringify(task.canvas_assignment_snapshot)
        : null,
      task.ai_origin,
      task.ai_labels,
    ],
  );
  if (saved) await syncTaskReminderOffsets(tx, owner, saved.id);
  return saved?.id ?? null;
}

/** Creates exactly one next occurrence after a repeat reminder is delivered. */
export async function generateNextReminderOccurrence(
  tx: QueryExecutor,
  owner: string,
  reminderId: string,
) {
  const [row] = await tx.query<Record<string, unknown>>(
    `SELECT id,title,scheduled_at,target_kind,target_id,occurrence_date,
       recurrence,series_id,occurrence_key,offset_minutes
     FROM reminders WHERE owner_id=$1 AND id=$2`,
    [owner, reminderId],
  );
  if (!row?.series_id || row.offset_minutes !== null) return null;
  const series = await readSeries(tx, owner, String(row.series_id));
  if (!series || series.deleted_at) return null;
  const currentKey = day(
    (row.occurrence_key as string | Date | null) ??
      (row.occurrence_date as string | Date),
  );
  const next = nextOccurrenceDate(
    series.rule,
    Temporal.PlainDate.from(series.anchorDate),
    Temporal.PlainDate.from(currentKey),
  );
  if (!next) return null;
  const nextKey = next.toString();
  if (series.cancelledFrom && nextKey >= series.cancelledFrom) return null;
  const wall = Temporal.Instant.from(instantOf(row.scheduled_at))
    .toZonedDateTimeISO(series.rule.timeZone ?? 'America/Denver')
    .toPlainTime();
  const scheduledAt = next
    .toPlainDateTime(wall)
    .toZonedDateTime(series.rule.timeZone ?? 'America/Denver', {
      disambiguation: 'compatible',
    })
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
  const [saved] = await tx.query<{ id: string }>(
    `INSERT INTO reminders(id,owner_id,title,scheduled_at,target_kind,target_id,
       occurrence_date,recurrence,series_id,occurrence_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     ON CONFLICT (owner_id,series_id,occurrence_key)
       WHERE series_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      owner,
      row.title,
      scheduledAt,
      row.target_kind,
      row.target_id,
      row.occurrence_date ? day(row.occurrence_date as string | Date) : null,
      JSON.stringify(series.rule),
      series.id,
      nextKey,
    ],
  );
  return saved?.id ?? null;
}

/** Rebuilds the automatic reminder rows for one task and its offsets. */
export async function syncTaskReminderOffsets(
  tx: QueryExecutor,
  owner: string,
  taskId: string,
) {
  const [task] = await tx.query<Record<string, unknown>>(
    `SELECT id,title,due_date,due_at,due_time_zone,completed,deleted_at,
       reminder_offsets,recurrence,series_id,occurrence_key
     FROM tasks WHERE owner_id=$1 AND id=$2`,
    [owner, taskId],
  );
  if (!task) return;
  if (task.deleted_at || task.completed) {
    await tx.query(
      `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
         updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND target_kind='task' AND target_id=$2
         AND offset_minutes IS NOT NULL AND status IN ('queued','running','paused')`,
      [owner, taskId],
    );
    return;
  }
  const dueDate = task.due_date ? day(task.due_date as string | Date) : null;
  const selected = offsets(task.reminder_offsets);
  if (!dueDate || selected.length === 0) {
    await tx.query(
      `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
         updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND target_kind='task' AND target_id=$2
         AND offset_minutes IS NOT NULL AND status IN ('queued','running','paused')`,
      [owner, taskId],
    );
    return;
  }
  const zone =
    (task.due_time_zone as string | null) ??
    (task.recurrence
      ? (recurrenceSchema.parse(task.recurrence).timeZone ?? 'America/Denver')
      : 'America/Denver');
  const due =
    task.due_at !== null
      ? Temporal.Instant.from(instantOf(task.due_at))
      : Temporal.PlainDate.from(dueDate)
          .toPlainDateTime({ hour: 9 })
          .toZonedDateTime(zone, { disambiguation: 'compatible' })
          .toInstant();
  await tx.query(
    `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND target_kind='task' AND target_id=$2
       AND offset_minutes IS NOT NULL
       AND (NOT (offset_minutes = ANY($3::int[]))
         OR occurrence_date IS DISTINCT FROM $4::date)
       AND status IN ('queued','running','paused')`,
    [owner, taskId, selected, dueDate],
  );
  for (const offset of selected) {
    const scheduledAt = due
      .subtract({ minutes: offset })
      .toString({ smallestUnit: 'millisecond' });
    if (Date.parse(scheduledAt) <= Date.now()) continue;
    const updated = await tx.query(
      `UPDATE reminders SET title=$4,scheduled_at=$5,
         status=CASE WHEN status='failed' THEN 'queued' ELSE status END,
         attempts=CASE WHEN status='failed' THEN 0 ELSE attempts END,
         last_error=CASE WHEN status='failed' THEN NULL ELSE last_error END,
         cancel_reason=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND target_kind='task' AND target_id=$2
         AND occurrence_date=$3 AND offset_minutes=$6
         AND status IN ('queued','running','paused','failed')
         AND (title IS DISTINCT FROM $4 OR scheduled_at IS DISTINCT FROM $5)
       RETURNING id`,
      [owner, taskId, dueDate, task.title, scheduledAt, offset],
    );
    if (updated.length) continue;
    const revived = await tx.query(
      `UPDATE reminders SET status='queued',title=$4,scheduled_at=$5,
         attempts=0,last_error=NULL,lease_token=NULL,lease_until=NULL,
         next_attempt_at=CURRENT_TIMESTAMP,cancel_reason=NULL,
         version=version+1,updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND target_kind='task' AND target_id=$2
         AND occurrence_date=$3 AND offset_minutes=$6 AND status='cancelled'
         AND cancel_reason IN ('sync','target-unavailable')
       RETURNING id`,
      [owner, taskId, dueDate, task.title, scheduledAt, offset],
    );
    if (revived.length) continue;
    await tx.query(
      `INSERT INTO reminders(id,owner_id,title,scheduled_at,target_kind,
         target_id,occurrence_date,offset_minutes)
       VALUES($1,$2,$3,$4,'task',$5,$6,$7)
       ON CONFLICT (owner_id,target_kind,target_id,occurrence_date,offset_minutes)
         WHERE offset_minutes IS NOT NULL AND target_kind IS NOT NULL
           AND occurrence_date IS NOT NULL
       DO NOTHING`,
      [randomUUID(), owner, task.title, scheduledAt, taskId, dueDate, offset],
    );
  }
}

function eventOccurrenceStart(
  startsAt: string,
  zone: string,
  date: Temporal.PlainDate,
) {
  const time = Temporal.Instant.from(startsAt)
    .toZonedDateTimeISO(zone)
    .toPlainTime();
  return date
    .toPlainDateTime(time)
    .toZonedDateTime(zone, { disambiguation: 'compatible' })
    .toInstant();
}

/** Creates or refreshes automatic offset reminders for an event occurrence. */
export async function syncEventReminderOffsets(
  tx: QueryExecutor,
  owner: string,
  eventId: string,
  from = Temporal.Now.plainDateISO(),
) {
  const [event] = await tx.query<Record<string, unknown>>(
    `SELECT id,title,starts_at,time_zone,recurrence,reminder_offsets,deleted_at
     FROM events WHERE owner_id=$1 AND id=$2`,
    [owner, eventId],
  );
  if (!event || event.deleted_at) return;
  const selected = offsets(event.reminder_offsets);
  if (!selected.length) {
    await tx.query(
      `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
         updated_at=CURRENT_TIMESTAMP
       WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
         AND offset_minutes IS NOT NULL AND status IN ('queued','running','paused')`,
      [owner, eventId],
    );
    return;
  }
  const zone = String(event.time_zone);
  const rule = event.recurrence
    ? recurrenceSchema.parse(event.recurrence)
    : null;
  const start = Temporal.Instant.from(instantOf(event.starts_at))
    .toZonedDateTimeISO(zone)
    .toPlainDate();
  const until = from.add({ days: 45 });
  const exceptions = new Map(
    (
      await tx.query<{
        original_date: string | Date;
        cancelled: boolean;
        replacement: Record<string, unknown> | null;
      }>(
        `SELECT original_date,cancelled,replacement FROM event_exceptions
         WHERE event_id=$1`,
        [eventId],
      )
    ).map((row) => [day(row.original_date), row]),
  );
  const dates = (
    rule ? recurrenceDates(rule, start, from, until) : [start]
  ).filter((date) => !exceptions.get(date.toString())?.cancelled);
  await tx.query(
    `UPDATE reminders SET status='cancelled',cancel_reason='sync',version=version+1,
       updated_at=CURRENT_TIMESTAMP
     WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
       AND offset_minutes IS NOT NULL
       AND occurrence_date <> ALL($3::date[])
       AND status IN ('queued','running','paused')`,
    [owner, eventId, dates.map((date) => date.toString())],
  );
  for (const date of dates) {
    const occurrenceDate = date.toString();
    const replacement = exceptions.get(occurrenceDate)?.replacement;
    const startsAt = replacement?.startsAt
      ? Temporal.Instant.from(String(replacement.startsAt))
      : eventOccurrenceStart(instantOf(event.starts_at), zone, date);
    for (const offset of selected) {
      const scheduledAt = startsAt
        .subtract({ minutes: offset })
        .toString({ smallestUnit: 'millisecond' });
      if (Date.parse(scheduledAt) <= Date.now()) continue;
      const updated = await tx.query(
        `UPDATE reminders SET title=$4,scheduled_at=$5,
           status=CASE WHEN status='failed' THEN 'queued' ELSE status END,
           attempts=CASE WHEN status='failed' THEN 0 ELSE attempts END,
           last_error=CASE WHEN status='failed' THEN NULL ELSE last_error END,
           cancel_reason=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP
         WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
           AND occurrence_date=$3 AND offset_minutes=$6
           AND status IN ('queued','running','paused','failed')
           AND (title IS DISTINCT FROM $4 OR scheduled_at IS DISTINCT FROM $5)
         RETURNING id`,
        [owner, eventId, occurrenceDate, event.title, scheduledAt, offset],
      );
      if (updated.length) continue;
      const revived = await tx.query(
        `UPDATE reminders SET status='queued',title=$4,scheduled_at=$5,
           attempts=0,last_error=NULL,lease_token=NULL,lease_until=NULL,
           next_attempt_at=CURRENT_TIMESTAMP,cancel_reason=NULL,
           version=version+1,updated_at=CURRENT_TIMESTAMP
         WHERE owner_id=$1 AND target_kind='event' AND target_id=$2
           AND occurrence_date=$3 AND offset_minutes=$6 AND status='cancelled'
           AND cancel_reason IN ('sync','target-unavailable')
         RETURNING id`,
        [owner, eventId, occurrenceDate, event.title, scheduledAt, offset],
      );
      if (revived.length) continue;
      await tx.query(
        `INSERT INTO reminders(id,owner_id,title,scheduled_at,target_kind,
           target_id,occurrence_date,offset_minutes)
         VALUES($1,$2,$3,$4,'event',$5,$6,$7)
         ON CONFLICT (owner_id,target_kind,target_id,occurrence_date,offset_minutes)
           WHERE offset_minutes IS NOT NULL AND target_kind IS NOT NULL
             AND occurrence_date IS NOT NULL
         DO NOTHING`,
        [
          randomUUID(),
          owner,
          event.title,
          scheduledAt,
          eventId,
          occurrenceDate,
          offset,
        ],
      );
    }
  }
}

/** Worker sweep: keeps the next weeks of recurring event reminders present. */
export async function syncRecurringEventReminders(
  database: Database,
  now = new Date(),
) {
  const [row] = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM events WHERE deleted_at IS NULL AND recurrence IS NOT NULL AND reminder_offsets <> '[]'::jsonb",
  );
  if (!row || Number(row.count) === 0) return;
  const events = await database.query<{ id: string; owner_id: string }>(
    "SELECT id,owner_id FROM events WHERE deleted_at IS NULL AND recurrence IS NOT NULL AND reminder_offsets <> '[]'::jsonb",
  );
  const from = Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO('UTC')
    .toPlainDate();
  for (const event of events) {
    try {
      await database.transaction((tx) =>
        syncEventReminderOffsets(tx, event.owner_id, event.id, from),
      );
    } catch {
      // One malformed or deleted event must not stop the rest of the sweep.
    }
  }
}
