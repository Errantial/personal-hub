ALTER TABLE topics ADD COLUMN academic_labels TEXT[]
  CHECK (cardinality(academic_labels)<=2 AND academic_labels <@ ARRAY['personal','restricted']::TEXT[]);
ALTER TABLE topics ALTER COLUMN academic_labels SET DEFAULT ARRAY[]::TEXT[];
