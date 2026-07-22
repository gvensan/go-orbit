-- 0006_saved_search_kind.sql - distinguish free-text saved searches (palette /
-- Explore) from structured Find queries stored as JSON in the same table.

ALTER TABLE saved_searches ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
