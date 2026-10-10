CREATE TABLE ai_preflights (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  UNIQUE(id,owner_id)
);
CREATE INDEX ai_preflights_history ON ai_preflights(owner_id,created_at DESC,id DESC);
