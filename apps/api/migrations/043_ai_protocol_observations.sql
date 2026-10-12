ALTER TABLE ai_attempts ADD COLUMN protocol_observation jsonb;
ALTER TABLE ai_attempts ADD CONSTRAINT ai_attempts_protocol_observation_check CHECK (
  protocol_observation IS NULL OR (
    jsonb_typeof(protocol_observation)='object'
    AND protocol_observation ?& ARRAY['synthetic','protocol','state','generationId']
    AND protocol_observation->'synthetic'='true'::jsonb
    AND protocol_observation->'protocol'='"openrouter"'::jsonb
    AND (
      (protocol_observation->'state'='"uncertain"'::jsonb
        AND protocol_observation ? 'reason'
        AND protocol_observation-ARRAY['synthetic','protocol','state','generationId','reason']::text[]='{}'::jsonb
        AND jsonb_typeof(protocol_observation->'reason')='string'
        AND protocol_observation->>'reason' IN ('transport','timeout','aborted','response','destination','billing')
        AND (protocol_observation->'generationId'='null'::jsonb OR
          (jsonb_typeof(protocol_observation->'generationId')='string' AND protocol_observation->>'generationId' ~ '^[A-Za-z0-9_-]{1,160}$')))
      OR
      (protocol_observation->'state'='"reported"'::jsonb
        AND protocol_observation ?& ARRAY['usage','outputState']
        AND protocol_observation-ARRAY['synthetic','protocol','state','generationId','usage','outputState']::text[]='{}'::jsonb
        AND jsonb_typeof(protocol_observation->'generationId')='string'
        AND protocol_observation->>'generationId' ~ '^[A-Za-z0-9_-]{1,160}$'
        AND jsonb_typeof(protocol_observation->'outputState')='string'
        AND protocol_observation->>'outputState' IN ('validated','invalid','provider-error','blocked')
        AND jsonb_typeof(protocol_observation->'usage')='object'
        AND protocol_observation->'usage' ?& ARRAY['inputTokens','outputTokens','actualMicros']
        AND (protocol_observation->'usage')-ARRAY['inputTokens','outputTokens','actualMicros']::text[]='{}'::jsonb
        AND CASE WHEN jsonb_typeof(protocol_observation->'usage'->'inputTokens')='number' THEN
          (protocol_observation->'usage'->>'inputTokens')::numeric BETWEEN 0 AND 2000000
          AND (protocol_observation->'usage'->>'inputTokens')::numeric=trunc((protocol_observation->'usage'->>'inputTokens')::numeric) ELSE false END
        AND CASE WHEN jsonb_typeof(protocol_observation->'usage'->'outputTokens')='number' THEN
          (protocol_observation->'usage'->>'outputTokens')::numeric BETWEEN 0 AND 2000000
          AND (protocol_observation->'usage'->>'outputTokens')::numeric=trunc((protocol_observation->'usage'->>'outputTokens')::numeric) ELSE false END
        AND CASE WHEN jsonb_typeof(protocol_observation->'usage'->'actualMicros')='number' THEN
          (protocol_observation->'usage'->>'actualMicros')::numeric BETWEEN 0 AND 1000000000000
          AND (protocol_observation->'usage'->>'actualMicros')::numeric=trunc((protocol_observation->'usage'->>'actualMicros')::numeric) ELSE false END)
    )
  )
);
CREATE FUNCTION hub_guard_protocol_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.protocol_observation IS NOT NULL THEN RAISE EXCEPTION 'Protocol observation requires an existing attempt'; END IF;
  ELSE
    IF OLD.protocol_observation IS NOT NULL AND NEW.protocol_observation IS DISTINCT FROM OLD.protocol_observation THEN
      RAISE EXCEPTION 'Protocol observations are immutable';
    END IF;
    IF OLD.protocol_observation IS NULL AND NEW.protocol_observation IS NOT NULL
      AND (OLD.status<>'uncertain' OR NEW.status<>'uncertain' OR NEW.version<>OLD.version+1) THEN
      RAISE EXCEPTION 'Protocol observation requires a versioned uncertain attempt';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_protocol_observation_guard BEFORE INSERT OR UPDATE ON ai_attempts
FOR EACH ROW EXECUTE FUNCTION hub_guard_protocol_observation();
