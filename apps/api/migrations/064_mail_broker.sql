-- J1/J2 foundation only: existing agent mail choices are migrated in J4.
CREATE TABLE mail_broker_grants (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT false,
  scope jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,agent_id) REFERENCES responsibilities(owner_id,id)
);
CREATE UNIQUE INDEX mail_broker_grant_target ON mail_broker_grants(owner_id,COALESCE(agent_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE mail_broker_retrievals (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  grant_id uuid NOT NULL,
  grant_version integer NOT NULL,
  agent_id uuid,
  run_id uuid,
  intent_digest text NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  snapshot jsonb NOT NULL,
  context jsonb NOT NULL,
  limits jsonb NOT NULL,
  cursor_token uuid NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','partial','completed','blocked','uncertain')),
  coverage jsonb NOT NULL,
  UNIQUE(owner_id,operation_id),
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,grant_id) REFERENCES mail_broker_grants(owner_id,id),
  FOREIGN KEY(owner_id,agent_id) REFERENCES responsibilities(owner_id,id),
  FOREIGN KEY(owner_id,run_id) REFERENCES responsibility_runs(owner_id,id)
);
CREATE TABLE mail_broker_batches (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  retrieval_id uuid NOT NULL,
  position integer NOT NULL,
  next_position integer NOT NULL,
  sources jsonb NOT NULL,
  envelope_hash text,
  profile_revision text,
  approval_version integer,
  verification_revision text,
  reservation_id uuid REFERENCES ai_budget_reservations(id),
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','uncertain','completed','blocked')),
  reason text,
  decisions jsonb,
  usage jsonb,
  rubric_revision text NOT NULL DEFAULT 'mail-relevance-v1',
  bounds_revision text NOT NULL DEFAULT 'mail-bounds-v1',
  UNIQUE(retrieval_id,position),
  FOREIGN KEY(owner_id,retrieval_id) REFERENCES mail_broker_retrievals(owner_id,id)
);
CREATE INDEX mail_broker_run ON mail_broker_retrievals(owner_id,run_id);
CREATE INDEX mail_broker_agent ON mail_broker_retrievals(owner_id,agent_id);
