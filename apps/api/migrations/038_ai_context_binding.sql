ALTER TABLE ai_requests ADD COLUMN context_hash text CHECK(context_hash IS NULL OR context_hash ~ '^[a-f0-9]{64}$');
