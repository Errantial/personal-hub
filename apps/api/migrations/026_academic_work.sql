CREATE TABLE academic_work (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  course_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('assignment','exam','project','other')),
  notes text NOT NULL DEFAULT '',
  due_date date,
  estimated_minutes integer CHECK (estimated_minutes BETWEEN 0 AND 60000),
  priority integer NOT NULL CHECK (priority BETWEEN 1 AND 5),
  status text NOT NULL CHECK (status IN ('planned','in_progress','submitted','cancelled')),
  grade jsonb CHECK (grade IS NULL OR (
    status='submitted' AND jsonb_typeof(grade)='object'
    AND grade ? 'earned' AND grade ? 'possible'
    AND jsonb_typeof(grade->'earned')='number'
    AND jsonb_typeof(grade->'possible')='number'
    AND (grade->>'earned')::numeric BETWEEN 0 AND 1000000
    AND (grade->>'possible')::numeric BETWEEN 0.0001 AND 1000000
    AND (grade->>'earned')::numeric * 10000 = floor((grade->>'earned')::numeric * 10000)
    AND (grade->>'possible')::numeric * 10000 = floor((grade->>'possible')::numeric * 10000)
  )),
  sensitivity text NOT NULL CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  academic_labels text[] NOT NULL DEFAULT '{}'
    CHECK (academic_labels <@ ARRAY['personal','restricted']::text[]),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  FOREIGN KEY (course_id,owner_id) REFERENCES courses(id,owner_id)
);
CREATE INDEX academic_work_owner_history ON academic_work(owner_id,created_at DESC,id DESC);
CREATE INDEX academic_work_course ON academic_work(owner_id,course_id);
