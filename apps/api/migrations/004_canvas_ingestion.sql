CREATE TABLE canvas_sources (
  owner_id UUID PRIMARY KEY REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK(sensitivity IN ('unlabeled','personal','restricted')),
  last_imported_at TIMESTAMPTZ,
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE canvas_items (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES canvas_sources(owner_id),
  uid TEXT NOT NULL,
  provider_data JSONB NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('available','cancelled','missing')),
  notes TEXT NOT NULL DEFAULT '',
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK(sensitivity IN ('unlabeled','personal','restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,uid)
);
CREATE TABLE canvas_sync_jobs (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES canvas_sources(owner_id),
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','automatic','upload')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  counts JSONB,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX canvas_one_active_job ON canvas_sync_jobs(owner_id) WHERE status IN ('queued','running');
CREATE INDEX canvas_jobs_history ON canvas_sync_jobs(owner_id,created_at DESC);
