-- Read-only mail ingestion from a local Proton Bridge connector
-- (docs/email-ingestion.md). Bodies are plain text; attachments are never stored.
CREATE TABLE email_connectors (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  sensitivity text NOT NULL CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  since date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (owner_id, id)
);
CREATE TABLE email_folders (
  owner_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1000),
  role text,
  uid_validity text NOT NULL CHECK (uid_validity ~ '^\d{1,20}$'),
  last_uid bigint NOT NULL DEFAULT 0 CHECK (last_uid >= 0),
  exists_count integer NOT NULL DEFAULT 0 CHECK (exists_count >= 0),
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connector_id, path),
  FOREIGN KEY (owner_id, connector_id) REFERENCES email_connectors(owner_id, id)
);
CREATE TABLE email_messages (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  message_key text NOT NULL CHECK (char_length(message_key) BETWEEN 3 AND 1000),
  from_address jsonb,
  to_addresses jsonb NOT NULL DEFAULT '[]',
  cc_addresses jsonb NOT NULL DEFAULT '[]',
  subject text NOT NULL DEFAULT '',
  sent_at timestamptz,
  received_at timestamptz NOT NULL,
  body text NOT NULL CHECK (char_length(body) <= 32000),
  body_truncated boolean NOT NULL,
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  folders text[] NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, connector_id, message_key),
  FOREIGN KEY (owner_id, connector_id) REFERENCES email_connectors(owner_id, id)
);
CREATE INDEX email_messages_owner_received ON email_messages(owner_id, received_at DESC, id DESC);
