-- Direct manual planner captures are durable provenance. Labels may only grow;
-- identities, snapshots and capture times cannot be rewritten or removed.
CREATE OR REPLACE FUNCTION hub_guard_academic_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Academic planning origins cannot be removed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Academic planning captures are immutable';
  END IF;
  IF NOT (OLD.labels <@ NEW.labels) THEN
    RAISE EXCEPTION 'Academic planning labels cannot be removed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER academic_origin_guard BEFORE UPDATE OR DELETE ON academic_planner_sources
FOR EACH ROW EXECUTE FUNCTION hub_guard_academic_origin();
