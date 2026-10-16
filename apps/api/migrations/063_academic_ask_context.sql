-- What one ask sent from the owner's manual academic work: allowlisted
-- planning text only (no notes, grades, class/instructor text or provider
-- data). Mirrors the mail column so a later UI can show coverage even after
-- the source work changes or is deleted.
ALTER TABLE ai_conversation_turns ADD COLUMN academic jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(academic) = 'array' AND jsonb_array_length(academic) <= 20);
