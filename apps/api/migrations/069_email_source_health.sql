-- P10 mail source-health receipts. Keep contact/import/complete state distinct
-- so an empty successful sync is fresh, while partial/error runs stay visible.
ALTER TABLE email_connectors ADD COLUMN last_attempt_at timestamptz;
ALTER TABLE email_connectors ADD COLUMN last_contact_at timestamptz;
ALTER TABLE email_connectors ADD COLUMN last_import_at timestamptz;
ALTER TABLE email_connectors ADD COLUMN last_complete_at timestamptz;
ALTER TABLE email_connectors ADD COLUMN active_attempt_id uuid;
ALTER TABLE email_connectors ADD COLUMN last_attempt_outcome text
  CHECK (last_attempt_outcome IN ('complete','partial','failed'));
ALTER TABLE email_connectors ADD COLUMN last_error_code text
  CHECK (last_error_code IN ('bridge-auth','bridge-unavailable','hub-unavailable','collection-failed'));

ALTER TABLE email_folders ADD COLUMN last_complete_at timestamptz;
ALTER TABLE email_folders ADD COLUMN last_complete_uid bigint CHECK (last_complete_uid >= 0);

CREATE TABLE email_folder_memberships (
  owner_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1000),
  uid_validity text NOT NULL CHECK (uid_validity ~ '^\d{1,20}$'),
  uid bigint NOT NULL CHECK (uid > 0),
  message_id uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connector_id,path,uid_validity,uid),
  FOREIGN KEY (owner_id,connector_id) REFERENCES email_connectors(owner_id,id),
  FOREIGN KEY (owner_id,message_id) REFERENCES email_messages(owner_id,id)
);
CREATE INDEX email_folder_memberships_message ON email_folder_memberships(owner_id,message_id);
