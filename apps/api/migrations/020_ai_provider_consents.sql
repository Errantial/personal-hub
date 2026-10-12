CREATE TABLE ai_provider_consents (
  owner_id uuid NOT NULL REFERENCES users(id),
  alias text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  approved boolean NOT NULL DEFAULT false,
  profile_revision text,
  profile_snapshot jsonb,
  updated_at timestamptz,
  PRIMARY KEY (owner_id, alias),
  CHECK (NOT approved OR (profile_revision IS NOT NULL AND profile_snapshot IS NOT NULL))
);
