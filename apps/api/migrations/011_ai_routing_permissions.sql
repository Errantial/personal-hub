CREATE TABLE ai_routing_policies (
  owner_id UUID PRIMARY KEY REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  policy JSONB NOT NULL DEFAULT '{"unlabeled":{"allowed":[],"preferred":null},"personal":{"allowed":[],"preferred":null},"restricted":{"allowed":[],"preferred":null}}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
