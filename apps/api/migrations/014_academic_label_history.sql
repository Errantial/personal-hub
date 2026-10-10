-- Existing records have no complete historical ancestor labels; retain that uncertainty.
ALTER TABLE events ADD COLUMN academic_labels TEXT[]
  CHECK (cardinality(academic_labels)<=2 AND academic_labels <@ ARRAY['personal','restricted']::TEXT[]);
ALTER TABLE events ALTER COLUMN academic_labels SET DEFAULT ARRAY[]::TEXT[];
