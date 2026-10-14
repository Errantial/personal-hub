-- AI mail category suggestions (docs/mail-classification.md).
-- Requests share the assistant's metadata-only ledger; the owner explicitly
-- allows Personal-labeled mail to be sent to OpenRouter (default off).
ALTER TABLE ai_assistant_requests
  ADD COLUMN kind text NOT NULL DEFAULT 'planner' CHECK (kind IN ('planner','mail-classify'));
ALTER TABLE ai_assistant_requests DROP CONSTRAINT ai_assistant_requests_proposal_count_check;
ALTER TABLE ai_assistant_requests ADD CONSTRAINT ai_assistant_requests_proposal_count_check CHECK (proposal_count BETWEEN 0 AND 20);
ALTER TABLE ai_assistant_requests DROP CONSTRAINT ai_assistant_requests_dropped_check;
ALTER TABLE ai_assistant_requests ADD CONSTRAINT ai_assistant_requests_dropped_check CHECK (dropped BETWEEN 0 AND 20);
ALTER TABLE ai_assistant_settings
  ADD COLUMN allow_personal_mail boolean NOT NULL DEFAULT false;
