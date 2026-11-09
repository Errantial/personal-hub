-- Extend the 077 capability audit with before/after snapshots and undo state.
ALTER TABLE ai_action_policies
  ADD COLUMN auto_approve boolean NOT NULL DEFAULT false;
ALTER TABLE ai_capability_audit
  ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;
ALTER TABLE ai_capability_audit
  DROP CONSTRAINT IF EXISTS ai_capability_audit_capability_check;
ALTER TABLE ai_capability_audit
  DROP CONSTRAINT IF EXISTS ai_capability_audit_action_check;
ALTER TABLE ai_capability_audit
  ADD CONSTRAINT ai_capability_audit_action_check CHECK (action IN ('create','update','cancel','delete','restore','send'));
ALTER TABLE ai_capability_audit
  ADD CONSTRAINT ai_capability_audit_capability_check CHECK (capability IN ('task','calendar','reminder','email','general'));
ALTER TABLE ai_capability_audit
  ADD COLUMN operation_id uuid,
  ADD COLUMN tool text,
  ADD COLUMN before jsonb,
  ADD COLUMN after jsonb,
  ADD COLUMN undoable boolean NOT NULL DEFAULT false,
  ADD COLUMN undone_at timestamptz;
CREATE UNIQUE INDEX ai_capability_audit_operation
  ON ai_capability_audit(owner_id, operation_id, tool)
  WHERE operation_id IS NOT NULL AND tool IS NOT NULL;
CREATE INDEX ai_capability_audit_undo
  ON ai_capability_audit(owner_id, created_at DESC)
  WHERE undoable AND undone_at IS NULL;

-- Additive Tier-1 general capability grant; existing policy rows read as
-- approval-required through the application default.
ALTER TABLE ai_action_policies
  DROP CONSTRAINT IF EXISTS ai_action_policies_policy_check;
ALTER TABLE ai_action_policies
  ADD CONSTRAINT ai_action_policies_policy_check CHECK (
    jsonb_typeof(policy) = 'object'
    AND policy ?& ARRAY['tasks','calendar','email']
    AND policy - ARRAY['tasks','calendar','reminders','capabilities','email']::text[] = '{}'::jsonb
    AND jsonb_typeof(policy->'tasks') = 'string'
    AND jsonb_typeof(policy->'calendar') = 'string'
    AND jsonb_typeof(policy->'email') = 'string'
    AND (NOT policy ? 'reminders' OR jsonb_typeof(policy->'reminders') = 'string')
    AND (NOT policy ? 'capabilities' OR jsonb_typeof(policy->'capabilities') = 'string')
    AND policy->>'tasks' IN ('automatic','approval-required','blocked')
    AND policy->>'calendar' IN ('automatic','approval-required','blocked')
    AND (NOT policy ? 'reminders' OR policy->>'reminders' IN ('automatic','approval-required','blocked'))
    AND (NOT policy ? 'capabilities' OR policy->>'capabilities' IN ('automatic','approval-required','blocked'))
    AND policy->>'email' = 'approval-required'
  );
ALTER TABLE ai_action_policies ALTER COLUMN policy SET DEFAULT
  '{"tasks":"approval-required","calendar":"automatic","reminders":"approval-required","capabilities":"approval-required","email":"approval-required"}'::jsonb;
