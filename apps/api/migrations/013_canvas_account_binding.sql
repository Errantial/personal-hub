ALTER TABLE canvas_lms_sources ADD COLUMN account_provider_id TEXT
  CHECK (account_provider_id ~ '^[1-9][0-9]{0,19}$');
