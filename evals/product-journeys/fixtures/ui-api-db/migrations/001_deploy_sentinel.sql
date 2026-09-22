-- Marker table the staging health check reads. Created only by this
-- migration, never by server boot, so an unmigrated database is detectable.
CREATE TABLE IF NOT EXISTS deploy_sentinel (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO deploy_sentinel (id) VALUES (1);
