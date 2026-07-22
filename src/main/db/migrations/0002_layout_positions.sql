-- 0002_layout_positions.sql - persisted graph layout (GRAPH_CANVAS §6:
-- "Persist computed layout positions so reopening the app doesn't recompute").
-- Written by the layout worker on settle and by node drag; read into
-- graph:snapshot. Derived data: ON DELETE CASCADE is correct here.

CREATE TABLE layout_positions (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
