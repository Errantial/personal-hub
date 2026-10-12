-- Advance this row on schedule admission so repeatable-read competitors must
-- retry their snapshots after another planner transaction commits.
ALTER TABLE planner_schedule_locks ADD COLUMN revision bigint NOT NULL DEFAULT 0;
