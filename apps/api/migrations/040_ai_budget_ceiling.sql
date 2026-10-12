-- Owner-confirmed deployment policy: $50/month and an initial $0.25/request.
-- Preserve spend, uncertain holds and historical operation receipts.
INSERT INTO ai_budget_policies(owner_id,monthly_limit_micros,per_request_limit_micros)
SELECT id,50000000,250000 FROM users ON CONFLICT(owner_id) DO NOTHING;
UPDATE ai_budget_policies SET monthly_limit_micros=50000000,per_request_limit_micros=250000,
  version=version+1,updated_at=CURRENT_TIMESTAMP
WHERE monthly_limit_micros IS DISTINCT FROM 50000000 OR per_request_limit_micros IS DISTINCT FROM 250000;
ALTER TABLE ai_budget_policies ADD CONSTRAINT ai_budget_monthly_hard_ceiling
CHECK(monthly_limit_micros IS NULL OR monthly_limit_micros<=50000000);
