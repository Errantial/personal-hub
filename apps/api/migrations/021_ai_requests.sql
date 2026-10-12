CREATE TABLE ai_requests (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  preflight_id uuid NOT NULL REFERENCES ai_preflights(id),
  input_manifest jsonb NOT NULL,
  text_hash text NOT NULL,
  status text NOT NULL DEFAULT 'blocked' CHECK (status IN ('blocked','cancelled','uncertain','completed','failed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  UNIQUE(owner_id,id)
);
CREATE INDEX ai_requests_history ON ai_requests(owner_id,created_at DESC,id DESC);
