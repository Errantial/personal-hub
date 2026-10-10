-- Conservatively classify existing imports as files until a network refresh replaces them.
ALTER TABLE canvas_items ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'calendar-file' CHECK(input_kind IN ('calendar-feed','calendar-file'));
