CREATE TABLE ai_attempts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  reservation_id uuid NOT NULL REFERENCES ai_budget_reservations(id),
  adapter text NOT NULL CHECK (adapter = 'synthetic'),
  price_snapshot jsonb NOT NULL,
  admission_metadata jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uncertain' CHECK (status IN ('uncertain','completed','failed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  input_tokens integer,
  output_tokens integer,
  actual_micros bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at timestamptz,
  FOREIGN KEY(owner_id,request_id) REFERENCES ai_requests(owner_id,id),
  UNIQUE(owner_id,request_id),
  UNIQUE(reservation_id),
  CHECK ((status='uncertain' AND input_tokens IS NULL AND output_tokens IS NULL AND actual_micros IS NULL AND finished_at IS NULL)
    OR (status IN ('completed','failed') AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND actual_micros IS NOT NULL AND input_tokens>=0 AND output_tokens>=0 AND actual_micros>=0 AND finished_at IS NOT NULL))
);
