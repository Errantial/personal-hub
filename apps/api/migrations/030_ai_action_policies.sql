CREATE TABLE ai_action_policies (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  policy jsonb NOT NULL DEFAULT '{"tasks":"blocked","calendar":"automatic","email":"approval-required"}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    jsonb_typeof(policy) = 'object'
    AND policy ?& ARRAY['tasks','calendar','email']
    AND policy - ARRAY['tasks','calendar','email']::text[] = '{}'::jsonb
    AND jsonb_typeof(policy->'tasks') = 'string'
    AND jsonb_typeof(policy->'calendar') = 'string'
    AND jsonb_typeof(policy->'email') = 'string'
    AND policy->>'tasks' IN ('automatic','approval-required','blocked')
    AND policy->>'calendar' IN ('automatic','approval-required','blocked')
    AND policy->>'email' = 'approval-required'
  )
);
