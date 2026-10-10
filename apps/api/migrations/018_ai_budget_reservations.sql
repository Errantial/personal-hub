CREATE TABLE ai_budget_reservations (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES ai_budget_policies(owner_id),
  request_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  month DATE NOT NULL CHECK(EXTRACT(DAY FROM month)=1),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>0),
  reserved_micros BIGINT NOT NULL CHECK(reserved_micros BETWEEN 1 AND 1000000000000),
  actual_micros BIGINT CHECK(actual_micros BETWEEN 0 AND 1000000000000),
  status TEXT NOT NULL CHECK(status IN ('reserved','uncertain','settled','released')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,request_id),
  CHECK((status IN ('reserved','uncertain') AND actual_micros IS NULL) OR
        (status='settled' AND actual_micros IS NOT NULL) OR
        (status='released' AND actual_micros=0))
);
CREATE INDEX ai_budget_month ON ai_budget_reservations(owner_id,month);
