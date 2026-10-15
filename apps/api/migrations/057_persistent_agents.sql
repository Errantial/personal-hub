-- Persistent agents (D57, docs/superpowers/specs/2026-10-14-persistent-agents-design.md).
-- An agent is a responsibility with a template, a pinned conversation and a
-- local schedule. Runs gain an executing lifecycle; legacy rows stay valid.

ALTER TABLE responsibilities
  ADD COLUMN template text CHECK (template IN ('daily-plan','mail-triage','deadline-watch','custom')),
  ADD COLUMN conversation_id uuid REFERENCES ai_conversations(id),
  ADD COLUMN time_zone text CHECK (char_length(time_zone) BETWEEN 1 AND 100),
  ADD COLUMN use_mail boolean NOT NULL DEFAULT false,
  ADD COLUMN monthly_cap_micros bigint NOT NULL DEFAULT 2000000 CHECK (monthly_cap_micros > 0),
  ADD COLUMN pause_reason text CHECK (pause_reason IN ('cap-reached')),
  ADD CONSTRAINT responsibilities_agent_fields CHECK (template IS NULL OR (conversation_id IS NOT NULL AND time_zone IS NOT NULL)),
  ADD CONSTRAINT responsibilities_pause_reason_state CHECK (pause_reason IS NULL OR status = 'paused');

ALTER TABLE ai_conversations ADD COLUMN responsibility_id uuid REFERENCES responsibilities(id);
ALTER TABLE ai_conversation_turns
  ADD COLUMN trigger text NOT NULL DEFAULT 'owner' CHECK (trigger IN ('owner','agent')),
  ADD COLUMN not_allowed integer NOT NULL DEFAULT 0 CHECK (not_allowed BETWEEN 0 AND 10);

-- Run lifecycle: drop the unnamed status/cancel checks from 036 and replace them.
DO $$
DECLARE existing record;
BEGIN
  FOR existing IN SELECT conname FROM pg_constraint
    WHERE conrelid='responsibility_runs'::regclass AND contype='c'
      AND (pg_get_constraintdef(oid) LIKE '%blocked%' OR pg_get_constraintdef(oid) LIKE '%owner-dismissed%')
  LOOP
    EXECUTE format('ALTER TABLE responsibility_runs DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  FOR existing IN SELECT conname FROM pg_constraint
    WHERE conrelid='responsibility_activities'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%run-dismissed%'
  LOOP
    EXECUTE format('ALTER TABLE responsibility_activities DROP CONSTRAINT %I', existing.conname);
  END LOOP;
END;
$$;
ALTER TABLE responsibility_runs
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN not_before timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN turn_id uuid REFERENCES ai_conversation_turns(id),
  ADD COLUMN outcome text CHECK (outcome IN ('quiet','applied','needs-approval','warning','failed')),
  ADD COLUMN error_code text CHECK (error_code ~ '^[A-Z][A-Z_]{0,63}$'),
  ADD COLUMN finished_at timestamptz,
  ADD CONSTRAINT responsibility_runs_status_check CHECK (status IN ('blocked','cancelled','queued','running','completed','failed')),
  ADD CONSTRAINT responsibility_runs_cancel_reason_check CHECK (cancel_reason IN ('owner-dismissed','responsibility-paused','responsibility-cancelled','responsibility-deleted','source-changed','schedule-changed','cap-reached')),
  ADD CONSTRAINT responsibility_runs_state CHECK (
    (status IN ('blocked','queued','running') AND cancelled_at IS NULL AND cancel_reason IS NULL AND finished_at IS NULL AND outcome IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND outcome IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND outcome IS NOT NULL AND outcome <> 'failed' AND cancelled_at IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND outcome = 'failed' AND error_code IS NOT NULL AND cancelled_at IS NULL)
  ),
  ADD CONSTRAINT responsibility_runs_lease CHECK (status <> 'running' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL));
CREATE INDEX responsibility_runs_work ON responsibility_runs(status, not_before, created_at) WHERE status IN ('queued','running');
ALTER TABLE responsibility_activities ADD CONSTRAINT responsibility_activities_kind_check CHECK (kind IN (
  'created','updated','resumed','paused','cancelled','deleted','schedule-set','schedule-cleared','run-created','run-dismissed','runs-cancelled',
  'run-started','run-completed','run-failed','cap-reached'));

-- Daily rules may list up to six local times; the first equals localTime.
CREATE FUNCTION hub_valid_local_times(times jsonb, first jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(times) <> 'array' THEN false
    WHEN jsonb_array_length(times) NOT BETWEEN 1 AND 6 THEN false
    WHEN times->0 IS DISTINCT FROM first THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(times) WITH ORDINALITY AS e(value, position)
      WHERE jsonb_typeof(e.value) <> 'string'
        OR e.value #>> '{}' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        OR (e.position > 1 AND e.value #>> '{}' <= times ->> (e.position::int - 2)))
  END
$$;
ALTER TABLE responsibility_schedules DROP CONSTRAINT responsibility_schedules_local_state;
ALTER TABLE responsibility_schedules ADD CONSTRAINT responsibility_schedules_local_state CHECK(
  (local_rule IS NULL AND next_local_index IS NULL)
  OR (local_rule IS NOT NULL AND interval_minutes IS NULL
    AND jsonb_typeof(local_rule)='object'
    AND local_rule ?& ARRAY['startDate','localTime','timeZone','frequency','interval']
    AND local_rule-ARRAY['startDate','localTime','timeZone','frequency','interval','times']::text[]='{}'::jsonb
    AND jsonb_typeof(local_rule->'startDate')='string' AND local_rule->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND jsonb_typeof(local_rule->'localTime')='string' AND local_rule->>'localTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND jsonb_typeof(local_rule->'timeZone')='string' AND char_length(local_rule->>'timeZone') BETWEEN 1 AND 100
    AND jsonb_typeof(local_rule->'frequency')='string' AND local_rule->>'frequency' IN ('daily','weekly')
    AND CASE WHEN jsonb_typeof(local_rule->'interval')='number' THEN (local_rule->>'interval')::numeric BETWEEN 1 AND 52 AND (local_rule->>'interval')::numeric=trunc((local_rule->>'interval')::numeric) ELSE false END
    AND (NOT local_rule ? 'times' OR hub_valid_local_times(local_rule->'times', local_rule->'localTime'))
    AND ((next_due_at IS NULL AND next_local_index IS NULL) OR (next_due_at IS NOT NULL AND next_local_index IS NOT NULL)))
);

-- Inbox notifications come from a reminder, or from an agent run and its thread.
ALTER TABLE notifications
  ALTER COLUMN reminder_id DROP NOT NULL,
  ADD COLUMN run_id uuid UNIQUE REFERENCES responsibility_runs(id),
  ADD COLUMN conversation_id uuid REFERENCES ai_conversations(id),
  ADD CONSTRAINT notifications_source CHECK (
    (reminder_id IS NOT NULL AND run_id IS NULL AND conversation_id IS NULL)
    OR (reminder_id IS NULL AND run_id IS NOT NULL AND conversation_id IS NOT NULL)
  );

-- Owners without saved action settings now get task changes as proposals
-- (approval-required) instead of blocked. Saved rows are untouched.
ALTER TABLE ai_action_policies ALTER COLUMN policy SET DEFAULT '{"tasks":"approval-required","calendar":"automatic","email":"approval-required"}'::jsonb;
