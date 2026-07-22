-- 0007_app_meta.sql - a small key/value store for app-level singletons that
-- aren't graph data: the owner profile ("you"), and room for future settings.
-- Values are TEXT; structured values are stored as JSON by the caller.

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
