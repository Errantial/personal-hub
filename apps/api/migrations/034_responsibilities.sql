CREATE TABLE responsibilities (
  id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES users(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  title text NOT NULL CHECK(char_length(btrim(title)) BETWEEN 1 AND 160),
  goal text NOT NULL CHECK(char_length(btrim(goal)) BETWEEN 1 AND 4000),
  source text NOT NULL DEFAULT 'owner-entered' CHECK(source='owner-entered'),
  sensitivity text NOT NULL CHECK(sensitivity IN ('unlabeled','personal','restricted')),
  labels text[] NOT NULL CHECK(array_ndims(labels)=1 AND cardinality(labels) BETWEEN 1 AND 3 AND labels <@ ARRAY['unlabeled','personal','restricted']::text[] AND sensitivity=ANY(labels) AND array_position(labels,NULL) IS NULL
    AND cardinality(labels)=(CASE WHEN 'unlabeled'=ANY(labels) THEN 1 ELSE 0 END+CASE WHEN 'personal'=ANY(labels) THEN 1 ELSE 0 END+CASE WHEN 'restricted'=ANY(labels) THEN 1 ELSE 0 END)),
  status text NOT NULL DEFAULT 'paused' CHECK(status IN ('paused','active','cancelled')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,deleted_at timestamptz,
  UNIQUE(owner_id,id),CHECK(deleted_at IS NULL OR status='cancelled')
);
CREATE INDEX responsibilities_owner_page ON responsibilities(owner_id,id);
