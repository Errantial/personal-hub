-- SQL CHECK treats unknown as accepted; require an affirmative capture match.
ALTER TABLE email_messages DROP CONSTRAINT email_message_rule_capture;
ALTER TABLE email_messages ADD CONSTRAINT email_message_rule_capture CHECK (
  category_rule_capture IS NULL OR COALESCE((
    category_source='rule' AND jsonb_typeof(category_rule_capture)='object'
    AND category_rule_capture->>'id'=category_rule_id::text
    AND category_rule_capture->>'category'=category
  ),false)
);
