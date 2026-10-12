ALTER TABLE email_approvals ADD CONSTRAINT email_approvals_owned_payload
  UNIQUE (owner_id,id,draft_id,draft_version,content_hash);
CREATE TABLE email_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version integer NOT NULL CHECK (draft_version > 0),
  content_hash text NOT NULL,
  approval_id uuid NOT NULL,
  approval_version integer NOT NULL CHECK (approval_version > 0),
  adapter text NOT NULL CHECK (adapter = 'synthetic'),
  status text NOT NULL DEFAULT 'uncertain' CHECK (status IN ('uncertain','sent','not-sent')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at timestamptz,
  UNIQUE (owner_id,draft_id,draft_version),
  UNIQUE (owner_id,approval_id),
  FOREIGN KEY (owner_id,draft_id,draft_version,content_hash)
    REFERENCES email_draft_revisions(owner_id,draft_id,version,content_hash),
  FOREIGN KEY (owner_id,approval_id,draft_id,draft_version,content_hash)
    REFERENCES email_approvals(owner_id,id,draft_id,draft_version,content_hash),
  CHECK ((status = 'uncertain') = (finished_at IS NULL))
);
CREATE INDEX email_attempts_owner_page ON email_attempts(owner_id,draft_id,id);
