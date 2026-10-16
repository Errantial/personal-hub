CREATE TABLE mail_broker_workflows (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  conversation_id uuid NOT NULL,
  deadline_at timestamptz NOT NULL,
  retrieval_id uuid,
  UNIQUE(owner_id,operation_id),
  FOREIGN KEY(owner_id,retrieval_id) REFERENCES mail_broker_retrievals(owner_id,id)
);

CREATE TABLE mail_broker_forwardings (
  retrieval_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  binding jsonb NOT NULL,
  digest text NOT NULL,
  UNIQUE(owner_id,request_id),
  FOREIGN KEY(owner_id,retrieval_id) REFERENCES mail_broker_retrievals(owner_id,id)
);

ALTER TABLE ai_conversation_turns ADD COLUMN mail_broker jsonb;
