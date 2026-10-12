ALTER TABLE reminders ADD COLUMN snoozed_from_id uuid;
ALTER TABLE reminders ADD CONSTRAINT reminders_id_owner_unique UNIQUE (id, owner_id);
ALTER TABLE reminders ADD CONSTRAINT reminder_snooze_owner_fk
  FOREIGN KEY (snoozed_from_id, owner_id) REFERENCES reminders (id, owner_id);
ALTER TABLE reminders ADD CONSTRAINT reminder_snooze_once UNIQUE (snoozed_from_id);
ALTER TABLE reminders ADD CONSTRAINT reminder_snooze_not_self CHECK (snoozed_from_id IS NULL OR snoozed_from_id <> id);
CREATE INDEX reminders_owner_history ON reminders (owner_id, created_at DESC, id DESC);
CREATE INDEX notifications_owner_history ON notifications (owner_id, created_at DESC, id DESC);
CREATE INDEX notifications_owner_unread ON notifications (owner_id) WHERE read_at IS NULL;
