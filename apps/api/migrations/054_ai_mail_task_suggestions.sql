-- AI task suggestions from one message (docs/mail-task-suggestions.md).
ALTER TABLE ai_assistant_requests DROP CONSTRAINT ai_assistant_requests_kind_check;
ALTER TABLE ai_assistant_requests ADD CONSTRAINT ai_assistant_requests_kind_check CHECK (kind IN ('planner','mail-classify','mail-tasks'));
