-- Durable selected identities/coverage, never copied private text.
ALTER TABLE mail_broker_retrievals ADD COLUMN selected_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE mail_broker_batches ADD COLUMN threshold_revision text NOT NULL DEFAULT 'synthetic-threshold-v1';
