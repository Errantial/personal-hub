ALTER TABLE tasks ADD CONSTRAINT tasks_owned_id UNIQUE(id,owner_id);

CREATE TABLE academic_planner_sources (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  work_id uuid NOT NULL,
  task_id uuid,
  event_id uuid,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'
    AND snapshot ? 'id' AND snapshot->>'id'=work_id::text),
  labels text[] NOT NULL CHECK(labels <@ ARRAY['personal','restricted']::text[]),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((task_id IS NOT NULL AND event_id IS NULL) OR (event_id IS NOT NULL AND task_id IS NULL)),
  UNIQUE(task_id,owner_id),
  UNIQUE(event_id,owner_id),
  FOREIGN KEY(work_id,owner_id) REFERENCES academic_work(id,owner_id),
  FOREIGN KEY(task_id,owner_id) REFERENCES tasks(id,owner_id),
  FOREIGN KEY(event_id,owner_id) REFERENCES events(id,owner_id)
);
CREATE INDEX academic_planner_source_work ON academic_planner_sources(owner_id,work_id,id);
