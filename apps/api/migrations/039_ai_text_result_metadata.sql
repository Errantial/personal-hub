ALTER TABLE ai_attempts ADD COLUMN result_metadata jsonb CHECK (
  result_metadata IS NULL OR (
    jsonb_typeof(result_metadata)='object'
    AND result_metadata ?& ARRAY['synthetic','retained','status','answerCharacters','suggestionCount']
    AND result_metadata-ARRAY['synthetic','retained','status','answerCharacters','suggestionCount']::text[]='{}'::jsonb
    AND result_metadata->'synthetic'='true'::jsonb
    AND result_metadata->'retained'='false'::jsonb
    AND status IN ('completed','failed')
    AND (
      (result_metadata->>'status'='invalid' AND result_metadata->'answerCharacters'='null'::jsonb AND result_metadata->'suggestionCount'='null'::jsonb)
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
