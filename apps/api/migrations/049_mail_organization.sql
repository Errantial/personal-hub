CREATE TABLE mail_rule_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0)
);
CREATE TABLE mail_rules (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
  field text NOT NULL CHECK(field IN ('sender','subject')),
  match text NOT NULL CHECK(char_length(match) BETWEEN 1 AND 200),
  category text NOT NULL CHECK(category IN ('actionable','academic','personal','receipts','newsletters','possible-spam')),
  enabled boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  UNIQUE(owner_id,id)
);
ALTER TABLE email_messages ADD COLUMN category text CHECK(category IN ('actionable','academic','personal','receipts','newsletters','possible-spam'));
ALTER TABLE email_messages ADD COLUMN category_source text CHECK(category_source IN ('owner','rule'));
ALTER TABLE email_messages ADD COLUMN category_rule_id uuid;
ALTER TABLE email_messages ADD FOREIGN KEY(owner_id,category_rule_id) REFERENCES mail_rules(owner_id,id);
ALTER TABLE email_messages ADD CONSTRAINT email_message_category_origin CHECK (
  CASE WHEN category_source IS NULL THEN category IS NULL AND category_rule_id IS NULL
       WHEN category_source='owner' THEN category_rule_id IS NULL
       WHEN category_source='rule' THEN category IS NOT NULL AND category_rule_id IS NOT NULL
       ELSE false END
);
