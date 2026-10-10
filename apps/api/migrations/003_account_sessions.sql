ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0);
ALTER TABLE sessions ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD CONSTRAINT sessions_id_unique UNIQUE (id);
ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE sessions ADD COLUMN revoked_at TIMESTAMPTZ;
