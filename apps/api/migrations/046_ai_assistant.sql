-- Live planner assistant (docs/ai-assistant.md). Settings hold the owner's
-- OpenRouter model; requests hold metadata only (no prompt, reply or proposals).
CREATE TABLE ai_assistant_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  model text NOT NULL CHECK (char_length(model) BETWEEN 3 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ai_assistant_requests (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  model text NOT NULL CHECK (char_length(model) BETWEEN 3 AND 100),
  reservation_id uuid NOT NULL REFERENCES ai_budget_reservations(id),
  status text NOT NULL CHECK (status IN ('uncertain','completed','failed')),
  reason text CHECK (reason IN ('invalid','provider-error','blocked','unauthorized','payment-required','unavailable','rate-limited','rejected','timeout','transport','response','billing')),
  generation_id text CHECK (generation_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cost_micros bigint CHECK (cost_micros >= 0),
  proposal_count integer NOT NULL DEFAULT 0 CHECK (proposal_count BETWEEN 0 AND 10),
  dropped integer NOT NULL DEFAULT 0 CHECK (dropped BETWEEN 0 AND 10),
  withheld integer NOT NULL DEFAULT 0 CHECK (withheld >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id, operation_id),
  CHECK ((status = 'completed') = (cost_micros IS NOT NULL))
);
CREATE INDEX ai_assistant_requests_owner_created ON ai_assistant_requests(owner_id, created_at DESC);
