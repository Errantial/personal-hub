CREATE TABLE courses (
  id UUID PRIMARY KEY, owner_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200), term TEXT NOT NULL DEFAULT '', instructor TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TIMESTAMPTZ,
  UNIQUE(id, owner_id)
);
CREATE TABLE topics (
  id UUID PRIMARY KEY, owner_id UUID NOT NULL REFERENCES users(id), course_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200), notes TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'unknown' CHECK (confidence IN ('unknown','low','medium','high')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TIMESTAMPTZ,
  FOREIGN KEY(course_id, owner_id) REFERENCES courses(id, owner_id), UNIQUE(id, owner_id)
);
ALTER TABLE events ADD COLUMN all_day BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN start_date DATE;
ALTER TABLE events ADD COLUMN end_date DATE;
ALTER TABLE events ADD COLUMN recurrence JSONB;
ALTER TABLE events ADD COLUMN course_id UUID;
ALTER TABLE events ADD COLUMN topic_id UUID;
ALTER TABLE events ADD COLUMN study_status TEXT NOT NULL DEFAULT 'planned' CHECK (study_status IN ('planned','completed','cancelled'));
ALTER TABLE events ADD CONSTRAINT events_course_owner FOREIGN KEY(course_id, owner_id) REFERENCES courses(id, owner_id);
ALTER TABLE events ADD CONSTRAINT events_topic_owner FOREIGN KEY(topic_id, owner_id) REFERENCES topics(id, owner_id);
ALTER TABLE events ADD CONSTRAINT events_date_range CHECK ((NOT all_day AND start_date IS NULL AND end_date IS NULL) OR (all_day AND start_date IS NOT NULL AND end_date > start_date));
CREATE TABLE event_exceptions (
  event_id UUID NOT NULL REFERENCES events(id), original_date DATE NOT NULL, cancelled BOOLEAN NOT NULL DEFAULT FALSE, replacement JSONB,
  PRIMARY KEY(event_id, original_date)
);
CREATE TABLE reminders (
  id UUID PRIMARY KEY, owner_id UUID NOT NULL REFERENCES users(id), title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200), scheduled_at TIMESTAMPTZ NOT NULL,
  target_kind TEXT CHECK (target_kind IN ('task','event')), target_id UUID, occurrence_date DATE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_token UUID, lease_until TIMESTAMPTZ, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((target_kind IS NULL AND target_id IS NULL AND occurrence_date IS NULL) OR (target_kind IS NOT NULL AND target_id IS NOT NULL AND (occurrence_date IS NULL OR target_kind = 'event')))
);
CREATE INDEX reminder_work_idx ON reminders(status, scheduled_at, next_attempt_at);
CREATE INDEX reminder_owner_idx ON reminders(owner_id, scheduled_at);
CREATE TABLE notifications (
  id UUID PRIMARY KEY, reminder_id UUID NOT NULL UNIQUE REFERENCES reminders(id), owner_id UUID NOT NULL REFERENCES users(id), title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TIMESTAMPTZ
);
CREATE TABLE worker_state (name TEXT PRIMARY KEY, last_tick TIMESTAMPTZ NOT NULL, error_code TEXT);
