ALTER TABLE ai_attempts ADD CONSTRAINT ai_attempts_owner_request_id_unique UNIQUE(owner_id,request_id,id);
DO $$
DECLARE existing_check text;
BEGIN
  SELECT conname INTO STRICT existing_check FROM pg_constraint
  WHERE conrelid='ai_attempts'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%result_metadata%';
  EXECUTE format('ALTER TABLE ai_attempts DROP CONSTRAINT %I',existing_check);
END;
$$;
ALTER TABLE ai_attempts ADD CONSTRAINT ai_attempts_retained_result_check CHECK (
  result_metadata IS NULL OR (
    jsonb_typeof(result_metadata)='object'
    AND result_metadata ?& ARRAY['synthetic','retained','status','answerCharacters','suggestionCount']
    AND result_metadata-ARRAY['synthetic','retained','status','answerCharacters','suggestionCount']::text[]='{}'::jsonb
    AND result_metadata->'synthetic'='true'::jsonb
    AND jsonb_typeof(result_metadata->'retained')='boolean'
    AND status IN ('completed','failed')
    AND (
      (result_metadata->>'status'='invalid' AND result_metadata->'retained'='false'::jsonb AND result_metadata->'answerCharacters'='null'::jsonb AND result_metadata->'suggestionCount'='null'::jsonb)
      OR (result_metadata->>'status'='validated'
        AND CASE WHEN jsonb_typeof(result_metadata->'answerCharacters')='number' THEN
          (result_metadata->>'answerCharacters')::numeric BETWEEN 1 AND 16000
          AND (result_metadata->>'answerCharacters')::numeric=trunc((result_metadata->>'answerCharacters')::numeric) ELSE false END
        AND CASE WHEN jsonb_typeof(result_metadata->'suggestionCount')='number' THEN
          (result_metadata->>'suggestionCount')::numeric BETWEEN 0 AND 20
          AND (result_metadata->>'suggestionCount')::numeric=trunc((result_metadata->>'suggestionCount')::numeric) ELSE false END)
    )
  )
);
CREATE TABLE ai_saved_answers (
  owner_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  synthetic boolean NOT NULL DEFAULT true CHECK(synthetic),
  labels text[] NOT NULL CHECK(cardinality(labels) BETWEEN 1 AND 3 AND labels <@ ARRAY['unlabeled','personal','restricted']::text[]),
  context_manifest jsonb NOT NULL,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  PRIMARY KEY(owner_id,request_id),
  UNIQUE(owner_id,attempt_id),
  FOREIGN KEY(owner_id,request_id) REFERENCES ai_requests(owner_id,id),
  FOREIGN KEY(owner_id,request_id,attempt_id) REFERENCES ai_attempts(owner_id,request_id,id),
  CHECK((deleted_at IS NULL AND output IS NOT NULL AND jsonb_typeof(output)='object') OR (deleted_at IS NOT NULL AND output IS NULL))
);
CREATE FUNCTION hub_check_saved_answer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM ai_requests r JOIN ai_attempts a ON a.owner_id=r.owner_id AND a.request_id=r.id
      WHERE r.owner_id=NEW.owner_id AND r.id=NEW.request_id AND a.id=NEW.attempt_id
      AND r.input_manifest->'saveAnswer'='true'::jsonb AND r.status='completed' AND a.status='completed'
      AND a.result_metadata->>'status'='validated' AND a.result_metadata->'retained'='true'::jsonb) THEN
      RAISE EXCEPTION 'Saved answer requires confirmed retention consent';
    END IF;
  ELSE
    IF NEW.owner_id<>OLD.owner_id OR NEW.request_id<>OLD.request_id OR NEW.attempt_id<>OLD.attempt_id
      OR NEW.labels IS DISTINCT FROM OLD.labels OR NEW.context_manifest IS DISTINCT FROM OLD.context_manifest
      OR NEW.synthetic<>OLD.synthetic OR NEW.created_at<>OLD.created_at
      OR OLD.deleted_at IS NOT NULL OR NEW.output IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'Saved answers are immutable except for forgetting';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_saved_answer_guard BEFORE INSERT OR UPDATE ON ai_saved_answers
FOR EACH ROW EXECUTE FUNCTION hub_check_saved_answer();
