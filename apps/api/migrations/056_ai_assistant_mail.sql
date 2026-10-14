-- Assistant mail reading (docs/ai-assistant.md, D56). With "Use mail" ticked,
-- one ask may take up to three model calls: plan a search, choose messages,
-- answer with up to five bodies. Each call is its own request row and budget
-- hold; the turn records which messages were sent.
ALTER TABLE ai_assistant_requests DROP CONSTRAINT ai_assistant_requests_kind_check;
ALTER TABLE ai_assistant_requests ADD CONSTRAINT ai_assistant_requests_kind_check CHECK (kind IN ('planner','mail-classify','mail-tasks','planner-round'));
ALTER TABLE ai_assistant_settings ADD COLUMN use_mail boolean NOT NULL DEFAULT false;
ALTER TABLE ai_conversation_turns ADD COLUMN use_mail boolean NOT NULL DEFAULT false;
-- Messages sent in this turn: [{ id, subject, from, receivedAt, read }].
ALTER TABLE ai_conversation_turns ADD COLUMN mail jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ai_conversation_turns ADD COLUMN mail_withheld integer NOT NULL DEFAULT 0 CHECK (mail_withheld >= 0);
-- Why mail reading stopped early (budget or a failed call), if it did.
ALTER TABLE ai_conversation_turns ADD COLUMN mail_note text CHECK (char_length(mail_note) <= 300);
CREATE TABLE ai_conversation_turn_rounds (
  request_id uuid PRIMARY KEY REFERENCES ai_assistant_requests(id),
  turn_id uuid NOT NULL REFERENCES ai_conversation_turns(id),
  round integer NOT NULL CHECK (round BETWEEN 2 AND 3),
  UNIQUE (turn_id, round)
);
