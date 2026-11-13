-- Read-only Outlook Web browser collector. Browser-derived mail facts stay in
-- their own tables, separate from the owner-recorded Outlook Graph access gate.
-- Tokens are SHA-256 only; messages store bounded metadata and plain text.
CREATE TABLE outlook_browser_sources (
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
  last_error_code text CHECK (last_error_code IN ('sign-in-required','mfa-required','browser-unavailable','outlook-unavailable','foreign-origin','traversal-failed','traversal-limit'))
);

CREATE TABLE outlook_browser_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES outlook_browser_sources(owner_id),
  source_version integer NOT NULL CHECK (source_version > 0),
  coverage_revision integer NOT NULL CHECK (coverage_revision > 0),
  outcome text CHECK (outcome IN ('complete','partial','failed')),
  error_code text CHECK (error_code IN ('sign-in-required','mfa-required','browser-unavailable','outlook-unavailable','foreign-origin','traversal-failed','traversal-limit')),
  discovery_status text CHECK (discovery_status IN ('complete','partial')),
  discovery_hash text CHECK (discovery_hash IS NULL OR discovery_hash ~ '^[0-9a-f]{64}$'),
  discovery_counts jsonb,
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  complete_count integer NOT NULL DEFAULT 0 CHECK (complete_count >= 0),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at timestamptz,
  UNIQUE(owner_id,id)
);
CREATE INDEX outlook_browser_attempt_history ON outlook_browser_attempts(owner_id,started_at DESC,id);

CREATE TABLE outlook_browser_folders (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES outlook_browser_sources(owner_id),
  provider_id text NOT NULL CHECK (provider_id ~ '^[A-Za-z0-9_-]{1,200}$' AND provider_id NOT IN ('id','deeplink','options','settings')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  canonical_url text NOT NULL CHECK (char_length(canonical_url) BETWEEN 1 AND 2000),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','missing')),
  selected boolean NOT NULL DEFAULT false,
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
  UNIQUE(owner_id,id)
);
CREATE INDEX outlook_browser_folder_selection ON outlook_browser_folders(owner_id,selected);

CREATE TABLE outlook_browser_messages (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  browser_folder_id uuid NOT NULL,
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 8 AND 2000 AND provider_id ~ '^[A-Za-z0-9_-]+$'),
  conversation_id text CHECK (conversation_id IS NULL OR (char_length(conversation_id) BETWEEN 8 AND 2000 AND conversation_id ~ '^[A-Za-z0-9_-]+$')),
  canonical_url text NOT NULL CHECK (char_length(canonical_url) BETWEEN 1 AND 2000),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 500),
  sender_display text NOT NULL CHECK (char_length(sender_display) BETWEEN 1 AND 200),
  sender_address text CHECK (sender_address IS NULL OR (char_length(sender_address) BETWEEN 3 AND 320 AND position('@' IN sender_address) > 1)),
  received_at timestamptz,
  snippet text NOT NULL DEFAULT '' CHECK (char_length(snippet) <= 2000),
  body_text text NOT NULL DEFAULT '' CHECK (char_length(body_text) <= 20000),
  captured_at timestamptz NOT NULL,
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','missing')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 10000),
  sensitivity text NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,browser_folder_id,provider_id),
  UNIQUE(owner_id,id),
  FOREIGN KEY(browser_folder_id,owner_id) REFERENCES outlook_browser_folders(id,owner_id)
);
CREATE INDEX outlook_browser_message_folder ON outlook_browser_messages(owner_id,browser_folder_id);
CREATE INDEX outlook_browser_message_recent ON outlook_browser_messages(owner_id,received_at DESC,id);

CREATE TABLE outlook_browser_folder_observations (
  attempt_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  browser_folder_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial','inaccessible')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  observed_count integer NOT NULL CHECK (observed_count >= 0),
  counts jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(attempt_id,browser_folder_id),
  FOREIGN KEY(owner_id,attempt_id) REFERENCES outlook_browser_attempts(owner_id,id),
  FOREIGN KEY(owner_id,browser_folder_id) REFERENCES outlook_browser_folders(owner_id,id)
);

CREATE TABLE outlook_browser_message_captures (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  browser_message_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,attempt_id,browser_message_id),
  FOREIGN KEY(owner_id,attempt_id) REFERENCES outlook_browser_attempts(owner_id,id),
  FOREIGN KEY(owner_id,browser_message_id) REFERENCES outlook_browser_messages(owner_id,id)
);
CREATE INDEX outlook_browser_message_capture_history ON outlook_browser_message_captures(owner_id,browser_message_id,captured_at DESC,id);

CREATE FUNCTION guard_outlook_browser_message_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Outlook browser message captures are immutable';
END $$;
CREATE TRIGGER outlook_browser_message_capture_immutable
BEFORE UPDATE OR DELETE ON outlook_browser_message_captures
FOR EACH ROW EXECUTE FUNCTION guard_outlook_browser_message_capture();
