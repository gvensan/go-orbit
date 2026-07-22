-- 0003_merge_log.sql - dedup merge journal (DEDUP_MERGE spec: every merge is
-- undoable). snapshot holds the JSON needed to reverse the merge: the primary's
-- prior fields, the secondary's full row, its original edges/tags, the edge
-- rows created on the primary, and the interaction ids that were moved.

CREATE TABLE merge_log (
  id           INTEGER PRIMARY KEY,
  primary_id   INTEGER NOT NULL,
  secondary_id INTEGER NOT NULL,
  snapshot     TEXT NOT NULL,
  merged_at    INTEGER NOT NULL
);
