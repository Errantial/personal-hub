ALTER TABLE study_plans ADD CONSTRAINT study_plans_owned_id UNIQUE(id,owner_id);
ALTER TABLE academic_work ADD CONSTRAINT academic_work_owned_id UNIQUE(id,owner_id);
ALTER TABLE events ADD CONSTRAINT events_owned_id UNIQUE(id,owner_id);

CREATE TABLE study_workload_contexts (
  plan_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  context_revision text NOT NULL CHECK(context_revision ~ '^[a-f0-9]{64}$'),
  source_count integer NOT NULL CHECK(source_count BETWEEN 0 AND 5000),
  captured_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(plan_id,owner_id),
  FOREIGN KEY(plan_id,owner_id) REFERENCES study_plans(id,owner_id)
);
CREATE TABLE study_workload_sources (
  plan_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  work_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'
    AND snapshot ? 'id' AND snapshot->>'id'=work_id::text),
  PRIMARY KEY(plan_id,owner_id,work_id),
  FOREIGN KEY(plan_id,owner_id) REFERENCES study_workload_contexts(plan_id,owner_id),
  FOREIGN KEY(work_id,owner_id) REFERENCES academic_work(id,owner_id)
);
CREATE INDEX study_workload_source_dependents ON study_workload_sources(owner_id,work_id,plan_id);
CREATE TABLE study_event_contexts (
  event_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  PRIMARY KEY(event_id,owner_id),
  FOREIGN KEY(event_id,owner_id) REFERENCES events(id,owner_id),
  FOREIGN KEY(plan_id,owner_id) REFERENCES study_workload_contexts(plan_id,owner_id)
);
CREATE INDEX study_event_context_plan ON study_event_contexts(owner_id,plan_id,event_id);
