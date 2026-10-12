ALTER TABLE reminders DROP CONSTRAINT reminders_target_kind_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_target_kind_check CHECK(target_kind IN ('task','event','academic-work'));
ALTER TABLE reminders ADD COLUMN academic_work_id uuid GENERATED ALWAYS AS
  (CASE WHEN target_kind='academic-work' THEN target_id ELSE NULL END) STORED;
ALTER TABLE reminders ADD CONSTRAINT reminders_owned_academic_work
  FOREIGN KEY(academic_work_id,owner_id) REFERENCES academic_work(id,owner_id);
CREATE INDEX reminders_academic_work ON reminders(owner_id,academic_work_id) WHERE academic_work_id IS NOT NULL;
