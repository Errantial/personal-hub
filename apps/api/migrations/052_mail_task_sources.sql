ALTER TABLE email_messages ADD CONSTRAINT email_messages_owner_id_unique UNIQUE(owner_id,id);
CREATE TABLE mail_task_sources (
  owner_id uuid NOT NULL REFERENCES users(id),
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  message_id uuid NOT NULL,
  message_version integer NOT NULL CHECK(message_version>0),
  connector_id uuid NOT NULL,
  connector_version integer NOT NULL CHECK(connector_version>0),
  quote text NOT NULL CHECK(char_length(quote) BETWEEN 1 AND 2000 AND length(trim(quote))>0),
  labels text[] NOT NULL CHECK(cardinality(labels) BETWEEN 1 AND 3 AND labels <@ ARRAY['unlabeled','personal','restricted']::text[]),
  confirmed_due_date date,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(owner_id,message_id) REFERENCES email_messages(owner_id,id),
  FOREIGN KEY(owner_id,connector_id) REFERENCES email_connectors(owner_id,id)
);
CREATE FUNCTION hub_guard_mail_task_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Mail task captures are immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM tasks t JOIN email_messages m ON m.owner_id=t.owner_id
    JOIN email_connectors c ON c.owner_id=m.owner_id AND c.id=m.connector_id
    WHERE t.id=NEW.task_id AND t.owner_id=NEW.owner_id AND m.id=NEW.message_id
      AND m.version=NEW.message_version AND c.id=NEW.connector_id AND c.version=NEW.connector_version
      AND m.text_origin='message-body-v1' AND position(NEW.quote in m.body)>0
      AND m.sensitivity=ANY(NEW.labels) AND c.sensitivity=ANY(NEW.labels)) THEN
    RAISE EXCEPTION 'Mail task capture requires owned body text and labels';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_task_source_guard BEFORE INSERT OR UPDATE OR DELETE ON mail_task_sources
FOR EACH ROW EXECUTE FUNCTION hub_guard_mail_task_source();
