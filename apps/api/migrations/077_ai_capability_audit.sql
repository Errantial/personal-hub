-- Owner-scoped audit for Assistant/agent capability decisions. Additive only.
CREATE TABLE IF NOT EXISTS ai_capability_audit (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid,
  turn_id uuid REFERENCES ai_conversation_turns(id),
  capability text NOT NULL CHECK (capability IN ('task','calendar','reminder','email')),
  action text NOT NULL CHECK (action IN ('create','update','cancel','delete','send')),
  target_kind text CHECK (target_kind IS NULL OR target_kind IN ('task','event','reminder')),
  target_id uuid,
  decision text NOT NULL CHECK (decision IN ('applied','proposed','blocked','failed')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id, agent_id) REFERENCES responsibilities(owner_id, id)
);
CREATE INDEX IF NOT EXISTS ai_capability_audit_owner_created
  ON ai_capability_audit(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_capability_audit_turn
  ON ai_capability_audit(owner_id, turn_id);

-- Per-capability reminder grants are additive; existing policy rows without
-- the key remain valid and read as approval-required in the application.
ALTER TABLE ai_action_policies
  DROP CONSTRAINT IF EXISTS ai_action_policies_policy_check;
ALTER TABLE ai_action_policies
  ADD CONSTRAINT ai_action_policies_policy_check CHECK (
    jsonb_typeof(policy) = 'object'
    AND policy ?& ARRAY['tasks','calendar','email']
    AND policy - ARRAY['tasks','calendar','reminders','email']::text[] = '{}'::jsonb
    AND jsonb_typeof(policy->'tasks') = 'string'
    AND jsonb_typeof(policy->'calendar') = 'string'
    AND jsonb_typeof(policy->'email') = 'string'
    AND (NOT policy ? 'reminders' OR jsonb_typeof(policy->'reminders') = 'string')
    AND policy->>'tasks' IN ('automatic','approval-required','blocked')
    AND policy->>'calendar' IN ('automatic','approval-required','blocked')
    AND (NOT policy ? 'reminders' OR policy->>'reminders' IN ('automatic','approval-required','blocked'))
    AND policy->>'email' = 'approval-required'
  );
ALTER TABLE ai_action_policies ALTER COLUMN policy SET DEFAULT
  '{"tasks":"approval-required","calendar":"automatic","reminders":"approval-required","email":"approval-required"}'::jsonb;
