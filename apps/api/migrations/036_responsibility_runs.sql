CREATE TABLE responsibility_runs (
  id uuid PRIMARY KEY,owner_id uuid NOT NULL,responsibility_id uuid NOT NULL,responsibility_version integer NOT NULL CHECK(responsibility_version>0),version integer NOT NULL DEFAULT 1 CHECK(version>0),
  trigger text NOT NULL CHECK(trigger IN ('manual','schedule')),scheduled_for timestamptz,schedule_version integer CHECK(schedule_version>0),skipped_intervals integer NOT NULL DEFAULT 0 CHECK(skipped_intervals>=0),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),labels text[] NOT NULL CHECK(cardinality(labels) BETWEEN 1 AND 3 AND labels <@ ARRAY['unlabeled','personal','restricted']::text[] AND array_position(labels,NULL) IS NULL),
  status text NOT NULL DEFAULT 'blocked' CHECK(status IN ('blocked','cancelled')),
  cancel_reason text CHECK(cancel_reason IN ('owner-dismissed','responsibility-paused','responsibility-cancelled','responsibility-deleted','source-changed','schedule-changed')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,cancelled_at timestamptz,
  UNIQUE(owner_id,id),UNIQUE(owner_id,responsibility_id,id),UNIQUE(owner_id,responsibility_id,scheduled_for),
  FOREIGN KEY(owner_id,responsibility_id) REFERENCES responsibilities(owner_id,id),
  CHECK((status='blocked' AND cancelled_at IS NULL AND cancel_reason IS NULL) OR (status='cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CHECK((trigger='manual' AND scheduled_for IS NULL AND schedule_version IS NULL AND skipped_intervals=0) OR (trigger='schedule' AND scheduled_for IS NOT NULL AND schedule_version IS NOT NULL))
);
CREATE INDEX responsibility_runs_owner_page ON responsibility_runs(owner_id,responsibility_id,id);
CREATE TABLE responsibility_activities (
  id uuid PRIMARY KEY,owner_id uuid NOT NULL,responsibility_id uuid NOT NULL,responsibility_version integer NOT NULL CHECK(responsibility_version>0),
  kind text NOT NULL CHECK(kind IN ('created','updated','resumed','paused','cancelled','deleted','schedule-set','schedule-cleared','run-created','run-dismissed','runs-cancelled')),
  run_id uuid,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(owner_id,responsibility_id) REFERENCES responsibilities(owner_id,id),
  FOREIGN KEY(owner_id,responsibility_id,run_id) REFERENCES responsibility_runs(owner_id,responsibility_id,id)
);
CREATE INDEX responsibility_activities_owner_page ON responsibility_activities(owner_id,responsibility_id,id);
