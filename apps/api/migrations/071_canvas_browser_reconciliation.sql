-- Owner-confirmed associations between Canvas browser items and calendar-feed
-- items. Facts remain separate; the association only records that the owner
-- confirmed the two source identities refer to the same Canvas record.
CREATE TABLE canvas_browser_reconciliations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  browser_item_id uuid NOT NULL,
  item_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  UNIQUE(owner_id,browser_item_id),
  FOREIGN KEY(owner_id,browser_item_id) REFERENCES canvas_browser_items(owner_id,id),
  FOREIGN KEY(owner_id,item_id) REFERENCES canvas_items(owner_id,id)
);

CREATE UNIQUE INDEX canvas_browser_reconciliation_feed_active
ON canvas_browser_reconciliations(owner_id,item_id)
WHERE deleted_at IS NULL;

CREATE INDEX canvas_browser_reconciliation_feed
ON canvas_browser_reconciliations(owner_id,item_id);
