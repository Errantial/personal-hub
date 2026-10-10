CREATE TABLE canvas_reconciliations (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  item_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  UNIQUE(owner_id,item_id),
  FOREIGN KEY(item_id,owner_id) REFERENCES canvas_items(id,owner_id),
  FOREIGN KEY(assignment_id,owner_id) REFERENCES canvas_lms_assignments(id,owner_id)
);
CREATE INDEX canvas_reconciliation_assignment ON canvas_reconciliations(owner_id,assignment_id) WHERE deleted_at IS NULL;
-- An explicit association shares provenance, even when the provider later changes its URL or omits a record.
CREATE VIEW canvas_reconciliation_context AS
SELECT r.owner_id,r.item_id,r.assignment_id,
  CASE WHEN 'restricted' IN (fs.sensitivity,i.sensitivity,fc.sensitivity,s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 2
    WHEN 'personal' IN (fs.sensitivity,i.sensitivity,fc.sensitivity,s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 1 ELSE 0 END AS sensitivity_rank,
  i.input_kind='calendar-file' AS attachment_derived
FROM canvas_reconciliations r
JOIN canvas_items i ON i.id=r.item_id AND i.owner_id=r.owner_id
JOIN canvas_sources fs ON fs.owner_id=r.owner_id
LEFT JOIN courses fc ON fc.id=i.course_id AND fc.owner_id=r.owner_id
JOIN canvas_lms_assignments a ON a.id=r.assignment_id AND a.owner_id=r.owner_id
JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=r.owner_id
JOIN canvas_lms_sources s ON s.owner_id=r.owner_id
LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=r.owner_id
WHERE r.deleted_at IS NULL;
CREATE VIEW canvas_item_context AS
SELECT i.id,i.owner_id,
  CASE GREATEST(
    CASE WHEN 'restricted' IN (s.sensitivity,i.sensitivity,c.sensitivity) THEN 2 WHEN 'personal' IN (s.sensitivity,i.sensitivity,c.sensitivity) THEN 1 ELSE 0 END,
    COALESCE((SELECT MAX(r.sensitivity_rank) FROM canvas_reconciliation_context r WHERE r.owner_id=i.owner_id AND r.item_id=i.id),0))
    WHEN 2 THEN 'restricted' WHEN 1 THEN 'personal' ELSE 'unlabeled' END AS sensitivity,
  i.input_kind='calendar-file' AS attachment_derived
FROM canvas_items i JOIN canvas_sources s ON s.owner_id=i.owner_id
LEFT JOIN courses c ON c.id=i.course_id AND c.owner_id=i.owner_id;
CREATE VIEW canvas_assignment_context AS
SELECT a.id,a.owner_id,
  CASE GREATEST(
    CASE WHEN 'restricted' IN (s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 2 WHEN 'personal' IN (s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 1 ELSE 0 END,
    COALESCE((SELECT MAX(r.sensitivity_rank) FROM canvas_reconciliation_context r WHERE r.owner_id=a.owner_id AND r.assignment_id=a.id),0))
    WHEN 2 THEN 'restricted' WHEN 1 THEN 'personal' ELSE 'unlabeled' END AS sensitivity,
  COALESCE((SELECT BOOL_OR(r.attachment_derived) FROM canvas_reconciliation_context r WHERE r.owner_id=a.owner_id AND r.assignment_id=a.id),FALSE) AS attachment_derived
FROM canvas_lms_assignments a JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id
JOIN canvas_lms_sources s ON s.owner_id=a.owner_id
LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=a.owner_id;
