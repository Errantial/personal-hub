CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE owner_setup (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id UUID NOT NULL REFERENCES users(id)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sessions_owner_idx ON sessions(owner_id);
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  due_date DATE,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled', 'personal', 'restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX tasks_owner_idx ON tasks(owner_id, updated_at);
CREATE TABLE events (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  time_zone TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled', 'personal', 'restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX events_owner_idx ON events(owner_id, starts_at);
CREATE TABLE mutation_receipts (
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  payload_hash TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, operation_id)
);
