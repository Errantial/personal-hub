-- What one ask sent from the owner's explicitly selected memory items:
-- allowlisted plain text only (kind, title, content, observedOn).
-- Stored on the turn so UI can show coverage and history eligibility can check
-- whether the memory items and global settings remain active and enabled.
ALTER TABLE ai_conversation_turns ADD COLUMN memory jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(memory) = 'array' AND jsonb_array_length(memory) <= 10);
