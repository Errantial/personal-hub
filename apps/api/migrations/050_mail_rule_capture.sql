-- Preserve the rule explanation even when a rule is later edited or deleted.
ALTER TABLE email_messages ADD COLUMN category_rule_capture jsonb;
ALTER TABLE email_messages ADD CONSTRAINT email_message_rule_capture CHECK (
  category_rule_capture IS NULL OR (
    category_source='rule' AND jsonb_typeof(category_rule_capture)='object'
    AND category_rule_capture->>'id'=category_rule_id::text
    AND category_rule_capture->>'category'=category
  )
);
