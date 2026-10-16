-- New suggestions only. Older drafts/turns acquire no invented origin.
ALTER TABLE ai_conversation_turns ADD COLUMN study_suggestions jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(study_suggestions)='array' AND jsonb_array_length(study_suggestions)<=1);
ALTER TABLE ai_conversation_turns ADD CONSTRAINT ai_study_turn_owned UNIQUE(owner_id,id);
CREATE TABLE study_plan_ai_origins (
  owner_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid PRIMARY KEY REFERENCES study_plans(id),
  turn_id uuid NOT NULL,
  suggestion_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  capture jsonb NOT NULL CHECK (jsonb_typeof(capture)='object'),
  FOREIGN KEY(owner_id,turn_id) REFERENCES ai_conversation_turns(owner_id,id),
  FOREIGN KEY(plan_id,owner_id) REFERENCES study_plans(id,owner_id)
);
