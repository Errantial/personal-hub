-- Additive repeating-item support. Existing tasks, events and reminders keep
-- working unchanged because every new column is nullable or has a default.

CREATE TABLE recurrence_series (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('task','reminder')),
  rule JSONB NOT NULL CHECK (jsonb_typeof(rule) = 'object'),
  time_zone TEXT NOT NULL,
  anchor_date DATE NOT NULL,
  cancelled_from DATE,
  deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, owner_id)
);
CREATE INDEX recurrence_series_owner_idx ON recurrence_series(owner_id, kind);

ALTER TABLE tasks
  ADD COLUMN recurrence JSONB,
  ADD COLUMN series_id UUID,
  ADD COLUMN occurrence_key DATE,
  ADD COLUMN reminder_offsets JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_series_owner
  FOREIGN KEY (series_id, owner_id) REFERENCES recurrence_series (id, owner_id);
CREATE UNIQUE INDEX tasks_series_occurrence
  ON tasks (owner_id, series_id, occurrence_key)
  WHERE series_id IS NOT NULL;
CREATE INDEX tasks_series_future
  ON tasks (owner_id, series_id, occurrence_key)
  WHERE series_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE events
  ADD COLUMN reminder_offsets JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE reminders
  ADD COLUMN recurrence JSONB,
  ADD COLUMN series_id UUID,
  ADD COLUMN occurrence_key DATE,
  ADD COLUMN offset_minutes INTEGER CHECK (offset_minutes BETWEEN 0 AND 10080);
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_target_pair_check CHECK (
  (target_kind IS NULL AND target_id IS NULL AND occurrence_date IS NULL)
  OR (target_kind IS NOT NULL AND target_id IS NOT NULL
      AND (occurrence_date IS NULL OR target_kind IN ('event','task')))
);
ALTER TABLE reminders ADD CONSTRAINT reminders_recurrence_series_owner
  FOREIGN KEY (series_id, owner_id) REFERENCES recurrence_series (id, owner_id);
CREATE UNIQUE INDEX reminders_series_occurrence
  ON reminders (owner_id, series_id, occurrence_key)
  WHERE series_id IS NOT NULL;
CREATE UNIQUE INDEX reminders_target_occurrence_offset
  ON reminders (owner_id, target_kind, target_id, occurrence_date, offset_minutes)
  WHERE offset_minutes IS NOT NULL
    AND target_kind IS NOT NULL
    AND occurrence_date IS NOT NULL;
