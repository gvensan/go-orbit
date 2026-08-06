-- Canonicalise undirected edges so a symmetric tie is a single row.
--
-- An undirected relationship (family / friend / colleague / acquaintance) is
-- symmetric, but earlier code could write it from either direction, so the same
-- tie sometimes existed as two rows (A->B and B->A). That surfaced as duplicate
-- rows in the detailed CSV export and double-counted edges in the graph. Collapse
-- every undirected edge to one canonical row with source_id < target_id. Directed
-- ties (e.g. "introduced") keep their direction and are left untouched.

-- 1. Preserve kin/metadata: if the canonical row lacks metadata that its reverse
--    twin carries, copy it over before the twin is dropped. (Family kin maps are
--    keyed by contact id, so they read the same from either direction.)
UPDATE edges
   SET metadata = (
     SELECT r.metadata FROM edges r
      WHERE r.directed = 0 AND r.type = edges.type
        AND r.source_id = edges.target_id AND r.target_id = edges.source_id
        AND r.metadata IS NOT NULL
      LIMIT 1)
 WHERE directed = 0 AND source_id < target_id AND metadata IS NULL
   AND EXISTS (
     SELECT 1 FROM edges r
      WHERE r.directed = 0 AND r.type = edges.type
        AND r.source_id = edges.target_id AND r.target_id = edges.source_id
        AND r.metadata IS NOT NULL);

-- 2. Drop the reverse twin wherever a canonical (source_id < target_id) row exists.
DELETE FROM edges
 WHERE directed = 0 AND source_id > target_id
   AND EXISTS (
     SELECT 1 FROM edges c
      WHERE c.directed = 0 AND c.type = edges.type
        AND c.source_id = edges.target_id AND c.target_id = edges.source_id);

-- 3. Flip any remaining non-canonical undirected rows (no twin) to canonical.
UPDATE edges
   SET source_id = target_id, target_id = source_id
 WHERE directed = 0 AND source_id > target_id;
