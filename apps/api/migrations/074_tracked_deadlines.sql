-- First-class local tracking for exact Canvas assignment/quiz identities.
-- Provider facts stay in their existing source tables. These tables retain
-- owner state plus stable exact-source associations and never write to Canvas.
CREATE TABLE tracked_deadlines (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  provider_kind text NOT NULL DEFAULT 'canvas' CHECK (provider_kind='canvas'),
  canonical_key text NOT NULL CHECK (char_length(canonical_key) BETWEEN 1 AND 1200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  completed_at timestamptz,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 10000),
  title_override text CHECK (title_override IS NULL OR char_length(title_override) BETWEEN 1 AND 200),
  due_override_kind text NOT NULL DEFAULT 'provider' CHECK (due_override_kind IN ('provider','timed','date','unknown')),
  due_at_override timestamptz,
  due_date_override date,
  due_time_zone text CHECK (due_time_zone IS NULL OR char_length(due_time_zone) BETWEEN 1 AND 100),
  sensitivity text NOT NULL DEFAULT 'unlabeled' CHECK (sensitivity IN ('unlabeled','personal','restricted')),
  source_labels text[] NOT NULL DEFAULT ARRAY['unlabeled']::text[]
    CHECK (cardinality(source_labels) BETWEEN 1 AND 3 AND source_labels <@ ARRAY['unlabeled','personal','restricted']::text[]),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id,provider_kind,canonical_key),
  UNIQUE(id,owner_id),
  CHECK (
    (due_override_kind IN ('provider','unknown') AND due_at_override IS NULL AND due_date_override IS NULL AND due_time_zone IS NULL)
    OR (due_override_kind='date' AND due_at_override IS NULL AND due_date_override IS NOT NULL AND due_time_zone IS NULL)
    OR (due_override_kind='timed' AND due_at_override IS NOT NULL AND due_date_override IS NULL AND due_time_zone IS NOT NULL)
  )
);
CREATE INDEX tracked_deadline_status ON tracked_deadlines(owner_id,completed_at,canonical_key,id);

CREATE TABLE tracked_deadline_sources (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  deadline_id uuid NOT NULL,
  canvas_item_id uuid,
  canvas_assignment_id uuid,
  canvas_browser_item_id uuid,
  source_kind text NOT NULL CHECK (source_kind IN ('calendar-feed','calendar-file','assignment-api','browser')),
  is_primary boolean NOT NULL DEFAULT false,
  source_version integer NOT NULL CHECK (source_version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(id,owner_id),
  FOREIGN KEY(deadline_id,owner_id) REFERENCES tracked_deadlines(id,owner_id),
  FOREIGN KEY(canvas_item_id,owner_id) REFERENCES canvas_items(id,owner_id),
  FOREIGN KEY(canvas_assignment_id,owner_id) REFERENCES canvas_lms_assignments(id,owner_id),
  FOREIGN KEY(canvas_browser_item_id,owner_id) REFERENCES canvas_browser_items(id,owner_id),
  CHECK (
    (canvas_item_id IS NOT NULL)::integer
      + (canvas_assignment_id IS NOT NULL)::integer
      + (canvas_browser_item_id IS NOT NULL)::integer = 1
  )
);
CREATE UNIQUE INDEX tracked_deadline_source_feed ON tracked_deadline_sources(owner_id,canvas_item_id) WHERE canvas_item_id IS NOT NULL;
CREATE UNIQUE INDEX tracked_deadline_source_assignment ON tracked_deadline_sources(owner_id,canvas_assignment_id) WHERE canvas_assignment_id IS NOT NULL;
CREATE UNIQUE INDEX tracked_deadline_source_browser ON tracked_deadline_sources(owner_id,canvas_browser_item_id) WHERE canvas_browser_item_id IS NOT NULL;
CREATE UNIQUE INDEX tracked_deadline_one_primary ON tracked_deadline_sources(owner_id,deadline_id) WHERE is_primary;
CREATE INDEX tracked_deadline_source_root ON tracked_deadline_sources(owner_id,deadline_id);

-- Preserve exact eligible source records already present before this migration.
-- Calendar events and malformed/noncanonical URLs are intentionally excluded.
INSERT INTO tracked_deadlines(id,owner_id,canonical_key,source_labels)
SELECT gen_random_uuid(),i.owner_id,
  'canvas:canvas.colorado.edu:' || regexp_replace(i.provider_data->>'sourceUrl','^https://canvas\.colorado\.edu',''),
  x.labels
FROM canvas_items i
JOIN canvas_item_context x ON x.id=i.id AND x.owner_id=i.owner_id
WHERE i.provider_data->>'sourceUrl' ~ '^https://canvas\.colorado\.edu/courses/[1-9][0-9]{0,19}/(assignments|quizzes)/[1-9][0-9]{0,19}$'
ON CONFLICT(owner_id,provider_kind,canonical_key) DO UPDATE
SET source_labels=hub_sensitivity_labels(tracked_deadlines.source_labels || EXCLUDED.source_labels);

INSERT INTO tracked_deadlines(id,owner_id,canonical_key,source_labels)
SELECT gen_random_uuid(),a.owner_id,
  'canvas:canvas.colorado.edu:/courses/' || lc.provider_id || '/assignments/' || a.provider_id,
  x.labels
FROM canvas_lms_assignments a
JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id
JOIN canvas_assignment_context x ON x.id=a.id AND x.owner_id=a.owner_id
WHERE lc.provider_id ~ '^[1-9][0-9]{0,19}$' AND a.provider_id ~ '^[1-9][0-9]{0,19}$'
ON CONFLICT(owner_id,provider_kind,canonical_key) DO UPDATE
SET source_labels=hub_sensitivity_labels(tracked_deadlines.source_labels || EXCLUDED.source_labels);

INSERT INTO tracked_deadlines(id,owner_id,canonical_key,source_labels)
SELECT gen_random_uuid(),bi.owner_id,
  'canvas:canvas.colorado.edu:' || regexp_replace(bi.canonical_url,'^https://canvas\.colorado\.edu',''),
  hub_sensitivity_labels(ARRAY[bs.sensitivity,bc.sensitivity,bi.sensitivity,c.sensitivity])
FROM canvas_browser_items bi
JOIN canvas_browser_courses bc ON bc.id=bi.browser_course_id AND bc.owner_id=bi.owner_id
JOIN canvas_browser_sources bs ON bs.owner_id=bi.owner_id
LEFT JOIN courses c ON c.id=bc.course_id AND c.owner_id=bc.owner_id
WHERE bi.canonical_url ~ '^https://canvas\.colorado\.edu/courses/[1-9][0-9]{0,19}/(assignments|quizzes)/[1-9][0-9]{0,19}$'
ON CONFLICT(owner_id,provider_kind,canonical_key) DO UPDATE
SET source_labels=hub_sensitivity_labels(tracked_deadlines.source_labels || EXCLUDED.source_labels);

INSERT INTO tracked_deadline_sources(id,owner_id,deadline_id,canvas_item_id,source_kind,source_version,created_at,updated_at)
SELECT gen_random_uuid(),i.owner_id,d.id,i.id,i.input_kind,i.version,i.created_at,i.updated_at
FROM canvas_items i
JOIN tracked_deadlines d ON d.owner_id=i.owner_id AND d.provider_kind='canvas'
  AND d.canonical_key='canvas:canvas.colorado.edu:' || regexp_replace(i.provider_data->>'sourceUrl','^https://canvas\.colorado\.edu','')
WHERE i.provider_data->>'sourceUrl' ~ '^https://canvas\.colorado\.edu/courses/[1-9][0-9]{0,19}/(assignments|quizzes)/[1-9][0-9]{0,19}$';

INSERT INTO tracked_deadline_sources(id,owner_id,deadline_id,canvas_assignment_id,source_kind,source_version,created_at,updated_at)
SELECT gen_random_uuid(),a.owner_id,d.id,a.id,'assignment-api',a.version,a.created_at,a.updated_at
FROM canvas_lms_assignments a
JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id
JOIN tracked_deadlines d ON d.owner_id=a.owner_id AND d.provider_kind='canvas'
  AND d.canonical_key='canvas:canvas.colorado.edu:/courses/' || lc.provider_id || '/assignments/' || a.provider_id
WHERE lc.provider_id ~ '^[1-9][0-9]{0,19}$' AND a.provider_id ~ '^[1-9][0-9]{0,19}$';

INSERT INTO tracked_deadline_sources(id,owner_id,deadline_id,canvas_browser_item_id,source_kind,source_version,created_at,updated_at)
SELECT gen_random_uuid(),bi.owner_id,d.id,bi.id,'browser',bi.version,bi.created_at,bi.updated_at
FROM canvas_browser_items bi
JOIN tracked_deadlines d ON d.owner_id=bi.owner_id AND d.provider_kind='canvas'
  AND d.canonical_key='canvas:canvas.colorado.edu:' || regexp_replace(bi.canonical_url,'^https://canvas\.colorado\.edu','')
WHERE bi.canonical_url ~ '^https://canvas\.colorado\.edu/courses/[1-9][0-9]{0,19}/(assignments|quizzes)/[1-9][0-9]{0,19}$';

-- Existing records have no prior primary choice. Pick one once using retained
-- source chronology plus a deterministic source-kind/id tiebreak; live updates
-- never change this choice implicitly.
WITH ranked AS (
  SELECT id,row_number() OVER (
    PARTITION BY owner_id,deadline_id
    ORDER BY created_at,
      CASE WHEN canvas_item_id IS NOT NULL THEN 1 WHEN canvas_assignment_id IS NOT NULL THEN 2 ELSE 3 END,
      COALESCE(canvas_item_id,canvas_assignment_id,canvas_browser_item_id)::text
  ) AS position
  FROM tracked_deadline_sources
)
UPDATE tracked_deadline_sources s SET is_primary=true
FROM ranked r WHERE r.id=s.id AND r.position=1;
