-- 0004_saved_searches.sql - persisted palette queries (SEARCH spec, Need tier:
-- "Persist a query as a named, re-runnable view"). Name is the identity;
-- saving under an existing name replaces that search.

CREATE TABLE saved_searches (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  query      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
