ALTER TABLE tasks
  ADD COLUMN due_at TIMESTAMPTZ NULL,
  ADD COLUMN due_time_zone TEXT NULL,
  ADD CONSTRAINT tasks_due_time_pair CHECK (
    (due_at IS NULL AND due_time_zone IS NULL)
    OR (due_at IS NOT NULL AND due_time_zone IS NOT NULL)
  ),
  ADD CONSTRAINT tasks_due_time_requires_date CHECK (
    due_at IS NULL OR due_date IS NOT NULL
  );
