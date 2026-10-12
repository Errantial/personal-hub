ALTER TABLE ai_attempts DROP CONSTRAINT ai_attempts_retained_result_check;
ALTER TABLE ai_attempts ADD CONSTRAINT ai_attempts_retained_result_check CHECK (
  result_metadata IS NULL OR (
    jsonb_typeof(result_metadata)='object'
    AND result_metadata ?& ARRAY['synthetic','retained','status','answerCharacters','suggestionCount']
    AND result_metadata-ARRAY['synthetic','retained','status','answerCharacters','suggestionCount']::text[]='{}'::jsonb
    AND result_metadata->'synthetic'='true'::jsonb
    AND jsonb_typeof(result_metadata->'retained')='boolean'
    AND status IN ('completed','failed')
    AND (
      (result_metadata->>'status' IN ('invalid','unavailable')
        AND result_metadata->'retained'='false'::jsonb
        AND result_metadata->'answerCharacters'='null'::jsonb
        AND result_metadata->'suggestionCount'='null'::jsonb
        AND (result_metadata->>'status'='invalid' OR COALESCE(
          status='completed'
          AND protocol_metadata->'outputState'='"validated"'::jsonb
          AND protocol_observation->'state'='"reported"'::jsonb
          AND protocol_observation->'outputState'='"validated"'::jsonb
          AND protocol_metadata->'generationId'=protocol_observation->'generationId'
          AND input_tokens=(protocol_observation->'usage'->>'inputTokens')::numeric
          AND output_tokens=(protocol_observation->'usage'->>'outputTokens')::numeric
          AND actual_micros=(protocol_observation->'usage'->>'actualMicros')::numeric,
          false)))
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
