CREATE TABLE ai_budget_policies (
  owner_id UUID PRIMARY KEY REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  monthly_limit_micros BIGINT CHECK(monthly_limit_micros BETWEEN 0 AND 1000000000000),
  per_request_limit_micros BIGINT CHECK(per_request_limit_micros BETWEEN 0 AND 1000000000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((monthly_limit_micros IS NULL AND per_request_limit_micros IS NULL) OR
        (monthly_limit_micros IS NOT NULL AND per_request_limit_micros IS NOT NULL AND per_request_limit_micros<=monthly_limit_micros))
);
