-- Read-only Canvas browser collector. Browser-derived facts stay distinct from
-- calendar-feed and Canvas API provenance so partial DOM observations cannot
-- mark records from another adapter missing.
CREATE TABLE canvas_browser_sources (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  token_issued_at timestamptz,
  token_revoked_at timestamptz,
  sensitivity text NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  coverage_revision integer NOT NULL DEFAULT 1 CHECK (coverage_revision > 0),
  last_attempt_at timestamptz,
  last_contact_at timestamptz,
  last_import_at timestamptz,
  last_complete_at timestamptz,
  last_complete_coverage_revision integer CHECK (last_complete_coverage_revision > 0),
  active_attempt_id uuid,
  active_attempt_progress_at timestamptz,
  last_attempt_outcome text CHECK (last_attempt_outcome IN ('complete','partial','failed')),
  last_error_code text CHECK (last_error_code IN ('sign-in-required','browser-unavailable','canvas-unavailable','traversal-failed','traversal-limit'))
);

CREATE TABLE canvas_browser_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES canvas_browser_sources(owner_id),
  source_version integer NOT NULL CHECK (source_version > 0),
  coverage_revision integer NOT NULL CHECK (coverage_revision > 0),
  outcome text CHECK (outcome IN ('complete','partial','failed')),
  error_code text CHECK (error_code IN ('sign-in-required','browser-unavailable','canvas-unavailable','traversal-failed','traversal-limit')),
  discovery_status text CHECK (discovery_status IN ('complete','partial')),
  discovery_hash text CHECK (discovery_hash IS NULL OR discovery_hash ~ '^[0-9a-f]{64}$'),
  discovery_counts jsonb,
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  complete_count integer NOT NULL DEFAULT 0 CHECK (complete_count >= 0),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at timestamptz,
  UNIQUE(owner_id,id)
);
CREATE INDEX canvas_browser_attempt_history ON canvas_browser_attempts(owner_id,started_at DESC,id);

CREATE TABLE canvas_browser_courses (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES canvas_browser_sources(owner_id),
  provider_id text NOT NULL CHECK (provider_id ~ '^[1-9][0-9]{0,19}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  canonical_url text NOT NULL CHECK (char_length(canonical_url) BETWEEN 1 AND 1000),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','missing')),
  selected boolean NOT NULL DEFAULT false,
  course_id uuid,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 10000),
  sensitivity text NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  last_contact_at timestamptz,
  last_import_at timestamptz,
  last_complete_at timestamptz,
  last_observation_status text CHECK (last_observation_status IN ('complete','partial','inaccessible')),
  last_observed_count integer NOT NULL DEFAULT 0 CHECK (last_observed_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,provider_id),
  UNIQUE(owner_id,id),
  FOREIGN KEY(course_id,owner_id) REFERENCES courses(id,owner_id)
);
CREATE INDEX canvas_browser_class ON canvas_browser_courses(owner_id,course_id);

CREATE TABLE canvas_browser_items (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  browser_course_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('assignment','quiz')),
  provider_id text NOT NULL CHECK (provider_id ~ '^[1-9][0-9]{0,19}$'),
  canonical_url text NOT NULL CHECK (char_length(canonical_url) BETWEEN 1 AND 1000),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  due_at timestamptz,
  captured_at timestamptz NOT NULL,
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','missing')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 10000),
  sensitivity text NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,browser_course_id,resource_kind,provider_id),
  UNIQUE(owner_id,id),
  FOREIGN KEY(browser_course_id,owner_id) REFERENCES canvas_browser_courses(id,owner_id)
);
CREATE INDEX canvas_browser_item_course ON canvas_browser_items(owner_id,browser_course_id);

CREATE TABLE canvas_browser_course_observations (
  attempt_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  browser_course_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial','inaccessible')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  observed_count integer NOT NULL CHECK (observed_count >= 0),
  counts jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(attempt_id,browser_course_id),
  FOREIGN KEY(owner_id,attempt_id) REFERENCES canvas_browser_attempts(owner_id,id),
  FOREIGN KEY(owner_id,browser_course_id) REFERENCES canvas_browser_courses(owner_id,id)
);

CREATE TABLE canvas_browser_item_captures (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  browser_item_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,attempt_id,browser_item_id),
  FOREIGN KEY(owner_id,attempt_id) REFERENCES canvas_browser_attempts(owner_id,id),
  FOREIGN KEY(owner_id,browser_item_id) REFERENCES canvas_browser_items(owner_id,id)
);
CREATE INDEX canvas_browser_item_capture_history ON canvas_browser_item_captures(owner_id,browser_item_id,captured_at DESC,id);

CREATE FUNCTION guard_canvas_browser_item_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Canvas browser item captures are immutable';
END $$;
CREATE TRIGGER canvas_browser_item_capture_immutable
BEFORE UPDATE OR DELETE ON canvas_browser_item_captures
FOR EACH ROW EXECUTE FUNCTION guard_canvas_browser_item_capture();
