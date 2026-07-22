-- 0005_cadence_starred.sql - relationship upkeep fields.
-- cadence_days: "stay in touch every N days"; NULL = no cadence set.
-- starred: favorites, pinned in the palette's empty state.

ALTER TABLE contacts ADD COLUMN cadence_days INTEGER;
ALTER TABLE contacts ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
