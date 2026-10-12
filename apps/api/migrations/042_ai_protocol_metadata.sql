ALTER TABLE ai_attempts ADD COLUMN protocol_metadata jsonb;
ALTER TABLE ai_attempts ADD CONSTRAINT ai_attempts_protocol_metadata_check CHECK (
  protocol_metadata IS NULL OR (
    jsonb_typeof(protocol_metadata)='object'
    AND protocol_metadata ?& ARRAY['synthetic','protocol','generationId','outputState']
    AND protocol_metadata-ARRAY['synthetic','protocol','generationId','outputState']::text[]='{}'::jsonb
    AND protocol_metadata->'synthetic'='true'::jsonb
    AND jsonb_typeof(protocol_metadata->'protocol')='string'
    AND protocol_metadata->>'protocol'='openrouter'
    AND jsonb_typeof(protocol_metadata->'generationId')='string'
    AND protocol_metadata->>'generationId' ~ '^[A-Za-z0-9_-]{1,160}$'
    AND jsonb_typeof(protocol_metadata->'outputState')='string'
    AND protocol_metadata->>'outputState' IN ('validated','invalid','provider-error','blocked')
    AND status IN ('completed','failed')
  )
);
