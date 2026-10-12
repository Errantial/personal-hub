CREATE TABLE responsibility_schedules (
  owner_id uuid NOT NULL,responsibility_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  starts_at timestamptz NOT NULL,interval_minutes integer CHECK(interval_minutes BETWEEN 15 AND 10080),next_due_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,deleted_at timestamptz,
  PRIMARY KEY(owner_id,responsibility_id),FOREIGN KEY(owner_id,responsibility_id) REFERENCES responsibilities(owner_id,id),
  CHECK(deleted_at IS NULL OR next_due_at IS NULL),CHECK(next_due_at IS NULL OR next_due_at>=starts_at)
);
CREATE INDEX responsibility_schedules_due ON responsibility_schedules(owner_id,next_due_at,responsibility_id) WHERE deleted_at IS NULL;
