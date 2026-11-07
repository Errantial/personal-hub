CREATE TABLE mail_broker_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  version integer NOT NULL CHECK (version > 0),
  selected_alias text NOT NULL CHECK (selected_alias IN ('mail-broker','jev-mail')),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
