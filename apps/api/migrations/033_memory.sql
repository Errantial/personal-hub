CREATE TABLE memory_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE memories (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('preference','goal','fact')),
  source text NOT NULL DEFAULT 'owner-entered' CHECK (source = 'owner-entered'),
  title text,
  content text,
  observed_on date,
  enabled boolean NOT NULL DEFAULT true,
  sensitivity text NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  labels text[] NOT NULL CHECK (array_ndims(labels)=1 AND cardinality(labels) BETWEEN 1 AND 3 AND labels <@ ARRAY['unlabeled','personal','restricted']::text[] AND sensitivity = ANY(labels) AND array_position(labels,NULL) IS NULL
    AND cardinality(labels) = (CASE WHEN 'unlabeled'=ANY(labels) THEN 1 ELSE 0 END + CASE WHEN 'personal'=ANY(labels) THEN 1 ELSE 0 END + CASE WHEN 'restricted'=ANY(labels) THEN 1 ELSE 0 END)),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  CHECK (
    (deleted_at IS NULL AND title IS NOT NULL AND char_length(btrim(title)) BETWEEN 1 AND 160 AND content IS NOT NULL AND char_length(btrim(content)) BETWEEN 1 AND 4000)
    OR (deleted_at IS NOT NULL AND title IS NULL AND content IS NULL AND observed_on IS NULL AND NOT enabled)
  ),
  UNIQUE (owner_id,id)
);
CREATE INDEX memories_owner_page ON memories(owner_id,id);
