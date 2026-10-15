-- Retain revoked approvals so optimistic versions never reset after deletion.
-- Old admitted envelopes must not regain approval after revoke/reapprove.
ALTER TABLE ai_live_destinations ADD COLUMN revoked boolean NOT NULL DEFAULT false;
