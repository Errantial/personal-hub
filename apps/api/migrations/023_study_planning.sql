CREATE TABLE planner_schedule_locks (owner_id uuid PRIMARY KEY REFERENCES users(id));
CREATE TABLE study_preferences (
  owner_id uuid PRIMARY KEY REFERENCES users(id),
  settings jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE study_goals (
  owner_id uuid NOT NULL REFERENCES users(id),
  course_id uuid NOT NULL,
  minutes_per_week integer NOT NULL CHECK(minutes_per_week BETWEEN 0 AND 2400),
  priority integer NOT NULL CHECK(priority BETWEEN 1 AND 5),
  target_date date,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(owner_id,course_id),
  FOREIGN KEY(course_id,owner_id) REFERENCES courses(id,owner_id)
);
CREATE TABLE study_plans (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','cancelled')),
  preview jsonb NOT NULL,
  event_links jsonb NOT NULL DEFAULT '[]',
  preserved_event_ids jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz
);
CREATE INDEX study_plan_history ON study_plans(owner_id,created_at DESC,id DESC);
