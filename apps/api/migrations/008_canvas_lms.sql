CREATE TABLE canvas_lms_sources (
  owner_id UUID PRIMARY KEY REFERENCES users(id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK(sensitivity IN ('unlabeled','personal','restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  last_imported_at TIMESTAMPTZ,
  next_sync_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE canvas_lms_courses (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES canvas_lms_sources(owner_id),
  provider_id TEXT NOT NULL,
  provider_data JSONB NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('available','missing')),
  course_id UUID,
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK(sensitivity IN ('unlabeled','personal','restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,provider_id),
  UNIQUE(id,owner_id),
  FOREIGN KEY(course_id,owner_id) REFERENCES courses(id,owner_id)
);
CREATE TABLE canvas_lms_assignments (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  canvas_course_id UUID NOT NULL,
  provider_id TEXT NOT NULL,
  provider_data JSONB NOT NULL,
  availability TEXT NOT NULL CHECK(availability IN ('available','missing')),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=10000),
  sensitivity TEXT NOT NULL DEFAULT 'unlabeled' CHECK(sensitivity IN ('unlabeled','personal','restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,canvas_course_id,provider_id),
  FOREIGN KEY(canvas_course_id,owner_id) REFERENCES canvas_lms_courses(id,owner_id)
);
CREATE INDEX canvas_lms_class ON canvas_lms_courses(owner_id,course_id);
CREATE INDEX canvas_lms_assignment_course ON canvas_lms_assignments(owner_id,canvas_course_id);
CREATE TABLE canvas_lms_jobs (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES canvas_lms_sources(owner_id),
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','automatic')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  error_code TEXT,
  counts JSONB,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX canvas_lms_one_active_job ON canvas_lms_jobs(owner_id) WHERE status IN ('queued','running');
CREATE INDEX canvas_lms_job_history ON canvas_lms_jobs(owner_id,created_at DESC);
