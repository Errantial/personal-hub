-- Immutable local lineage from AI-created planner work back to one tracked
-- deadline. Provider/source records remain read-only; this table records only
-- the server-resolved planning snapshot used when the task/event was created.
CREATE TABLE tracked_deadline_planner_links (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  deadline_id uuid NOT NULL,
  task_id uuid,
  event_id uuid,
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot)='object'
    AND snapshot ? 'id'
    AND snapshot->>'id'=deadline_id::text
    AND snapshot ? 'version'
    AND snapshot ? 'title'
    AND snapshot ? 'due'
  ),
  labels text[] NOT NULL CHECK (
    cardinality(labels) BETWEEN 1 AND 3
    AND labels <@ ARRAY['unlabeled','personal','restricted']::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((task_id IS NOT NULL AND event_id IS NULL) OR (event_id IS NOT NULL AND task_id IS NULL)),
  UNIQUE(task_id,owner_id),
  UNIQUE(event_id,owner_id),
  FOREIGN KEY(deadline_id,owner_id) REFERENCES tracked_deadlines(id,owner_id),
  FOREIGN KEY(task_id,owner_id) REFERENCES tasks(id,owner_id),
  FOREIGN KEY(event_id,owner_id) REFERENCES events(id,owner_id)
);

CREATE INDEX tracked_deadline_planner_source
  ON tracked_deadline_planner_links(owner_id,deadline_id,id);
