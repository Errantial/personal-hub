ALTER TABLE responsibility_schedules ADD COLUMN local_rule jsonb;
ALTER TABLE responsibility_schedules ADD COLUMN next_local_index integer CHECK(next_local_index>=0);
ALTER TABLE responsibility_schedules ADD CONSTRAINT responsibility_schedules_local_state CHECK(
  (local_rule IS NULL AND next_local_index IS NULL)
  OR (local_rule IS NOT NULL AND interval_minutes IS NULL
    AND jsonb_typeof(local_rule)='object'
    AND local_rule ?& ARRAY['startDate','localTime','timeZone','frequency','interval']
    AND local_rule-ARRAY['startDate','localTime','timeZone','frequency','interval']::text[]='{}'::jsonb
    AND jsonb_typeof(local_rule->'startDate')='string' AND local_rule->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND jsonb_typeof(local_rule->'localTime')='string' AND local_rule->>'localTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND jsonb_typeof(local_rule->'timeZone')='string' AND char_length(local_rule->>'timeZone') BETWEEN 1 AND 100
    AND jsonb_typeof(local_rule->'frequency')='string' AND local_rule->>'frequency' IN ('daily','weekly')
    AND CASE WHEN jsonb_typeof(local_rule->'interval')='number' THEN (local_rule->>'interval')::numeric BETWEEN 1 AND 52 AND (local_rule->>'interval')::numeric=trunc((local_rule->>'interval')::numeric) ELSE false END
    AND ((next_due_at IS NULL AND next_local_index IS NULL) OR (next_due_at IS NOT NULL AND next_local_index IS NOT NULL)))
);
