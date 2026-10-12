-- Retain deletion metadata when an explicit restore clears a current tombstone.
-- Mutation receipts independently preserve retry results; neither table is pruned.
CREATE TABLE planner_restorations (
  owner_id uuid NOT NULL REFERENCES users(id),
  item_kind text NOT NULL CHECK (item_kind IN ('task', 'event')),
  item_id uuid NOT NULL,
  deleted_version integer NOT NULL CHECK (deleted_version > 0),
  deleted_at timestamptz NOT NULL,
  restored_version integer NOT NULL CHECK (restored_version = deleted_version + 1),
  restored_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, item_kind, item_id, deleted_version)
);
