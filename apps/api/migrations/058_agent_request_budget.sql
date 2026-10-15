-- Attribute holds before turn/round persistence, so a crash cannot hide agent spend.
ALTER TABLE ai_assistant_requests
  ADD COLUMN agent_id uuid,
  ADD CONSTRAINT ai_assistant_requests_owned_agent
    FOREIGN KEY(owner_id,agent_id) REFERENCES responsibilities(owner_id,id);
CREATE INDEX ai_assistant_requests_agent ON ai_assistant_requests(owner_id,agent_id)
  WHERE agent_id IS NOT NULL;
