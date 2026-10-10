CREATE FUNCTION hub_sensitivity_labels(input_labels TEXT[]) RETURNS TEXT[]
LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT label ORDER BY label) FILTER (WHERE label IN ('personal','restricted')),ARRAY['unlabeled']::TEXT[])
  FROM unnest(input_labels) AS labels(label)
$$;
CREATE OR REPLACE VIEW canvas_reconciliation_context AS
SELECT r.owner_id,r.item_id,r.assignment_id,
  CASE WHEN 'restricted' IN (fs.sensitivity,i.sensitivity,fc.sensitivity,s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 2
    WHEN 'personal' IN (fs.sensitivity,i.sensitivity,fc.sensitivity,s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 1 ELSE 0 END AS sensitivity_rank,
  i.input_kind='calendar-file' AS attachment_derived,
  hub_sensitivity_labels(ARRAY[fs.sensitivity,i.sensitivity,fc.sensitivity,s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity]) AS labels
FROM canvas_reconciliations r
JOIN canvas_items i ON i.id=r.item_id AND i.owner_id=r.owner_id
JOIN canvas_sources fs ON fs.owner_id=r.owner_id
LEFT JOIN courses fc ON fc.id=i.course_id AND fc.owner_id=r.owner_id
JOIN canvas_lms_assignments a ON a.id=r.assignment_id AND a.owner_id=r.owner_id
JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=r.owner_id
JOIN canvas_lms_sources s ON s.owner_id=r.owner_id
LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=r.owner_id
WHERE r.deleted_at IS NULL;
CREATE OR REPLACE VIEW canvas_item_context AS
SELECT i.id,i.owner_id,
  CASE GREATEST(
    CASE WHEN 'restricted' IN (s.sensitivity,i.sensitivity,c.sensitivity) THEN 2 WHEN 'personal' IN (s.sensitivity,i.sensitivity,c.sensitivity) THEN 1 ELSE 0 END,
    COALESCE((SELECT MAX(r.sensitivity_rank) FROM canvas_reconciliation_context r WHERE r.owner_id=i.owner_id AND r.item_id=i.id),0))
    WHEN 2 THEN 'restricted' WHEN 1 THEN 'personal' ELSE 'unlabeled' END AS sensitivity,
  i.input_kind='calendar-file' AS attachment_derived,
  hub_sensitivity_labels(ARRAY[s.sensitivity,i.sensitivity,c.sensitivity] || COALESCE((
    SELECT array_agg(inherited.label) FROM canvas_reconciliation_context r CROSS JOIN LATERAL unnest(r.labels) AS inherited(label)
    WHERE r.owner_id=i.owner_id AND r.item_id=i.id),ARRAY[]::TEXT[])) AS labels
FROM canvas_items i JOIN canvas_sources s ON s.owner_id=i.owner_id
LEFT JOIN courses c ON c.id=i.course_id AND c.owner_id=i.owner_id;
CREATE OR REPLACE VIEW canvas_assignment_context AS
SELECT a.id,a.owner_id,
  CASE GREATEST(
    CASE WHEN 'restricted' IN (s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 2 WHEN 'personal' IN (s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity) THEN 1 ELSE 0 END,
    COALESCE((SELECT MAX(r.sensitivity_rank) FROM canvas_reconciliation_context r WHERE r.owner_id=a.owner_id AND r.assignment_id=a.id),0))
    WHEN 2 THEN 'restricted' WHEN 1 THEN 'personal' ELSE 'unlabeled' END AS sensitivity,
  COALESCE((SELECT BOOL_OR(r.attachment_derived) FROM canvas_reconciliation_context r WHERE r.owner_id=a.owner_id AND r.assignment_id=a.id),FALSE) AS attachment_derived,
  hub_sensitivity_labels(ARRAY[s.sensitivity,lc.sensitivity,a.sensitivity,c.sensitivity] || COALESCE((
    SELECT array_agg(inherited.label) FROM canvas_reconciliation_context r CROSS JOIN LATERAL unnest(r.labels) AS inherited(label)
    WHERE r.owner_id=a.owner_id AND r.assignment_id=a.id),ARRAY[]::TEXT[])) AS labels
FROM canvas_lms_assignments a JOIN canvas_lms_courses lc ON lc.id=a.canvas_course_id AND lc.owner_id=a.owner_id
JOIN canvas_lms_sources s ON s.owner_id=a.owner_id
LEFT JOIN courses c ON c.id=lc.course_id AND c.owner_id=a.owner_id;
