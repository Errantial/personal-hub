ALTER TABLE canvas_items ADD COLUMN course_id UUID;
ALTER TABLE canvas_items ADD CONSTRAINT canvas_item_owned_course FOREIGN KEY(course_id,owner_id) REFERENCES courses(id,owner_id);
CREATE INDEX canvas_items_class ON canvas_items(owner_id,course_id);
