CREATE TABLE email_drafts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  message jsonb NOT NULL CHECK (jsonb_typeof(message) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  UNIQUE (owner_id,id)
);
CREATE INDEX email_drafts_owner_page ON email_drafts(owner_id,id);
CREATE TABLE email_draft_revisions (
  owner_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  message jsonb NOT NULL CHECK (jsonb_typeof(message) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id,draft_id,version),
  UNIQUE (owner_id,draft_id,version,content_hash),
  FOREIGN KEY (owner_id,draft_id) REFERENCES email_drafts(owner_id,id)
);
CREATE TABLE email_approvals (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version integer NOT NULL,
  content_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz,
  FOREIGN KEY (owner_id,draft_id,draft_version,content_hash)
    REFERENCES email_draft_revisions(owner_id,draft_id,version,content_hash)
);
CREATE UNIQUE INDEX email_approvals_one_current_revision ON email_approvals(owner_id,draft_id,draft_version) WHERE revoked_at IS NULL;
CREATE INDEX email_approvals_owner_page ON email_approvals(owner_id,draft_id,id);
