CREATE TABLE outlook_access_gate (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  backend text NOT NULL DEFAULT 'unknown' CHECK (backend IN ('unknown','exchange-online','other')),
  tenant text NOT NULL DEFAULT 'unknown' CHECK (tenant IN ('unknown','school-managed','other')),
  mailbox_scope text NOT NULL DEFAULT 'unknown' CHECK (mailbox_scope IN ('unknown','primary-only','shared-required')),
  app_registration text NOT NULL DEFAULT 'unknown' CHECK (app_registration IN ('unknown','owner-can-register','admin-must-register','registration-blocked')),
  consent text NOT NULL DEFAULT 'unknown' CHECK (consent IN ('unknown','user-can-consent','admin-consent-required','consent-blocked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
