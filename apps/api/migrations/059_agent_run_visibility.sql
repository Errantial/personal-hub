-- Metadata only. Do not fabricate start/progress timestamps for legacy runs.
ALTER TABLE responsibility_runs
  ADD COLUMN started_at timestamptz,
  ADD COLUMN progress_at timestamptz,
  ADD COLUMN progress_stage text CHECK (progress_stage IN (
    'claimed','checking-provider','provider-request','applying','retry-scheduled','finished'
  ));
CREATE INDEX responsibility_runs_agent_history
  ON responsibility_runs(owner_id,responsibility_id,created_at DESC,id DESC);
