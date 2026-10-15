-- Live context admission, boundary 1 (docs/live-context-admission-design.md).
-- Each live exchange binds its exact envelope to a server-only manifest of
-- source identities, versions, labels and private digests. No prompt, mail
-- text, reply or credential is stored here; the table is never exported.
ALTER TABLE ai_assistant_requests
  ADD CONSTRAINT ai_assistant_requests_owner_id_key UNIQUE (owner_id, id);
ALTER TABLE ai_assistant_requests DROP CONSTRAINT ai_assistant_requests_reason_check;
ALTER TABLE ai_assistant_requests ADD CONSTRAINT ai_assistant_requests_reason_check
  CHECK (reason IN ('invalid','provider-error','blocked','unauthorized','payment-required','unavailable','rate-limited','rejected','timeout','transport','response','billing','context-changed','route-blocked'));

CREATE TABLE ai_live_exchanges (
  request_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  format_version smallint NOT NULL CHECK (format_version = 1),
  manifest jsonb NOT NULL,
  integrity_hash text NOT NULL CHECK (integrity_hash ~ '^[a-f0-9]{64}$'),
  destination_revision text NOT NULL CHECK (destination_revision ~ '^[a-f0-9]{64}$'),
  source_count integer NOT NULL CHECK (source_count BETWEEN 0 AND 350),
  -- admitted: bound, not yet verified; verified: the guard passed and the
  -- exact bytes were handed to transport; blocked: never sent.
  guard_state text NOT NULL DEFAULT 'admitted' CHECK (guard_state IN ('admitted','verified','blocked')),
  guarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id, request_id) REFERENCES ai_assistant_requests(owner_id, id),
  CHECK ((guard_state = 'admitted') = (guarded_at IS NULL))
);

-- The owner's one approved live destination: one OpenRouter model pinned to
-- one declared upstream. revision binds model, upstream and the server's live
-- terms; a mismatch blocks until the owner approves again.
CREATE TABLE ai_live_destinations (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (char_length(model) <= 100 AND model ~ '^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  upstream text NOT NULL CHECK (upstream ~ '^[a-z][a-z0-9-]{0,47}$'),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  approved_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Bound turns may be resent as history: their kept reply came from a verified
-- exchange, and inference_sources holds the transitive source references
-- (identity and labels only). Legacy turns stay unbound and readable.
-- Turns that sent mail keep their proposals read-only until their origin can
-- be retained with the applied record.
ALTER TABLE ai_conversation_turns
  ADD COLUMN inference_history text NOT NULL DEFAULT 'unbound' CHECK (inference_history IN ('unbound','bound')),
  ADD COLUMN inference_digest text CHECK (inference_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN inference_sources jsonb CHECK (jsonb_typeof(inference_sources) = 'array' AND jsonb_array_length(inference_sources) <= 1000),
  ADD COLUMN proposal_access text NOT NULL DEFAULT 'applicable' CHECK (proposal_access IN ('applicable','read-only')),
  ADD CONSTRAINT ai_conversation_turns_inference_bound CHECK (
    (inference_history = 'bound') = (inference_digest IS NOT NULL AND inference_sources IS NOT NULL)
  );
UPDATE ai_conversation_turns SET proposal_access = 'read-only' WHERE jsonb_array_length(mail) > 0;
