-- Existing values cannot prove owner origin after historical conversations
-- have been deleted. Never manufacture provenance during an upgrade.
ALTER TABLE tasks ADD COLUMN ai_origin text NOT NULL DEFAULT 'legacy-unknown'
  CHECK (ai_origin IN ('owner-entered','legacy-unknown','bound-derived'));
ALTER TABLE events ADD COLUMN ai_origin text NOT NULL DEFAULT 'legacy-unknown'
  CHECK (ai_origin IN ('owner-entered','legacy-unknown','bound-derived'));
ALTER TABLE tasks ALTER COLUMN ai_origin SET DEFAULT 'owner-entered';
ALTER TABLE events ALTER COLUMN ai_origin SET DEFAULT 'owner-entered';
ALTER TABLE tasks ADD COLUMN ai_labels text[] NOT NULL DEFAULT '{}'
  CHECK (ai_labels <@ ARRAY['unlabeled','personal','restricted']::text[]);
ALTER TABLE events ADD COLUMN ai_labels text[] NOT NULL DEFAULT '{}'
  CHECK (ai_labels <@ ARRAY['unlabeled','personal','restricted']::text[]);

CREATE TABLE ai_turn_origins (
  owner_id uuid NOT NULL REFERENCES users(id),
  turn_id uuid PRIMARY KEY REFERENCES ai_conversation_turns(id),
  request_id uuid NOT NULL,
  capture jsonb NOT NULL CHECK (jsonb_typeof(capture)='object'),
  proposal_digests jsonb NOT NULL CHECK (jsonb_typeof(proposal_digests)='object'),
  FOREIGN KEY (owner_id,request_id) REFERENCES ai_assistant_requests(owner_id,id)
);
-- No prompt, proposal, message, reply or private digest is copied to planner
-- lineage. These bounded identity/label captures outlive conversation text.
CREATE TABLE ai_planner_origins (
  owner_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('task','event')),
  record_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES ai_conversation_turns(id),
  capture jsonb NOT NULL CHECK (jsonb_typeof(capture)='object'),
  PRIMARY KEY(owner_id,kind,record_id,turn_id)
);

CREATE FUNCTION preserve_ai_planner_floor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.ai_labels := ARRAY(SELECT DISTINCT value FROM unnest(OLD.ai_labels || NEW.ai_labels) value ORDER BY value);
    IF OLD.ai_origin <> 'owner-entered' AND NEW.ai_origin='owner-entered' THEN
      NEW.ai_origin := OLD.ai_origin;
    END IF;
  END IF;
  IF 'restricted'=ANY(NEW.ai_labels) THEN NEW.sensitivity := 'restricted';
  ELSIF 'personal'=ANY(NEW.ai_labels) AND NEW.sensitivity='unlabeled' THEN NEW.sensitivity := 'personal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_ai_floor BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION preserve_ai_planner_floor();
CREATE TRIGGER events_ai_floor BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION preserve_ai_planner_floor();

-- Label additions propagate even to deleted derived records. No recursive
-- inference resolution is enabled: all derived records remain withheld.
CREATE FUNCTION propagate_ai_planner_floor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind text;
BEGIN
  IF NEW.sensitivity='unlabeled' OR NEW.sensitivity=OLD.sensitivity THEN RETURN NEW; END IF;
  source_kind := CASE WHEN TG_TABLE_NAME='tasks' THEN 'task' ELSE 'event' END;
  UPDATE tasks p SET ai_labels=array_append(p.ai_labels,NEW.sensitivity),version=p.version+1,updated_at=CURRENT_TIMESTAMP
    WHERE p.owner_id=NEW.owner_id AND NOT(NEW.sensitivity=ANY(p.ai_labels)) AND EXISTS (
      SELECT 1 FROM ai_planner_origins o,jsonb_array_elements(o.capture->'sources') s
      WHERE o.owner_id=p.owner_id AND o.kind='task' AND o.record_id=p.id AND s->>'kind'=source_kind AND s->>'id'=NEW.id::text);
  UPDATE events p SET ai_labels=array_append(p.ai_labels,NEW.sensitivity),version=p.version+1,updated_at=CURRENT_TIMESTAMP
    WHERE p.owner_id=NEW.owner_id AND NOT(NEW.sensitivity=ANY(p.ai_labels)) AND EXISTS (
      SELECT 1 FROM ai_planner_origins o,jsonb_array_elements(o.capture->'sources') s
      WHERE o.owner_id=p.owner_id AND o.kind='event' AND o.record_id=p.id AND s->>'kind'=source_kind AND s->>'id'=NEW.id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_ai_propagation AFTER UPDATE OF sensitivity ON tasks FOR EACH ROW EXECUTE FUNCTION propagate_ai_planner_floor();
CREATE TRIGGER events_ai_propagation AFTER UPDATE OF sensitivity ON events FOR EACH ROW EXECUTE FUNCTION propagate_ai_planner_floor();
