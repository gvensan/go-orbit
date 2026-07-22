-- 0001_init.sql — M0 initial schema.
-- Applied inside a transaction by migrate.js. Sets user_version = 1.
-- All timestamps are Unix epoch milliseconds (INTEGER).

-- ---------------------------------------------------------------------------
-- Core entities
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  fields     TEXT,                         -- flexible JSON schema
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                       -- NULL = live; set = soft-deleted
);
CREATE INDEX idx_contacts_deleted ON contacts(deleted_at);
CREATE INDEX idx_contacts_name    ON contacts(name);

CREATE TABLE edges (
  source_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  directed   INTEGER NOT NULL DEFAULT 0,
  metadata   TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, type)
);
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);

CREATE TABLE interactions (
  id          INTEGER PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  kind        TEXT,
  note        TEXT
);
CREATE INDEX idx_interactions_contact ON interactions(contact_id, occurred_at DESC);

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE contact_tags (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- Search projection + FTS (see docs/SEARCH_REQUIREMENTS.md §6)
-- Flattened columns so FTS can index JSON-extracted fields.
-- ---------------------------------------------------------------------------
CREATE TABLE contacts_search (
  id      INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  name    TEXT, email TEXT, phone TEXT, company TEXT, role TEXT, tags TEXT, notes TEXT
);

CREATE VIRTUAL TABLE contacts_fts USING fts5(
  name, email, phone, company, role, tags, notes,
  content='contacts_search', content_rowid='id',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE contacts_trigram USING fts5(
  name, company, email,
  content='contacts_search', content_rowid='id',
  tokenize = 'trigram'
);

-- Keep the search projection in sync with contacts. The projection row is the
-- single source the FTS tables mirror; app code rebuilds it on write via
-- json_extract. These triggers mirror projection -> FTS.
CREATE TRIGGER contacts_search_ai AFTER INSERT ON contacts_search BEGIN
  INSERT INTO contacts_fts(rowid, name, email, phone, company, role, tags, notes)
    VALUES (new.id, new.name, new.email, new.phone, new.company, new.role, new.tags, new.notes);
  INSERT INTO contacts_trigram(rowid, name, company, email)
    VALUES (new.id, new.name, new.company, new.email);
END;

CREATE TRIGGER contacts_search_ad AFTER DELETE ON contacts_search BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, name, email, phone, company, role, tags, notes)
    VALUES ('delete', old.id, old.name, old.email, old.phone, old.company, old.role, old.tags, old.notes);
  INSERT INTO contacts_trigram(contacts_trigram, rowid, name, company, email)
    VALUES ('delete', old.id, old.name, old.company, old.email);
END;

CREATE TRIGGER contacts_search_au AFTER UPDATE ON contacts_search BEGIN
  INSERT INTO contacts_fts(contacts_fts, rowid, name, email, phone, company, role, tags, notes)
    VALUES ('delete', old.id, old.name, old.email, old.phone, old.company, old.role, old.tags, old.notes);
  INSERT INTO contacts_fts(rowid, name, email, phone, company, role, tags, notes)
    VALUES (new.id, new.name, new.email, new.phone, new.company, new.role, new.tags, new.notes);
  INSERT INTO contacts_trigram(contacts_trigram, rowid, name, company, email)
    VALUES ('delete', old.id, old.name, old.company, old.email);
  INSERT INTO contacts_trigram(rowid, name, company, email)
    VALUES (new.id, new.name, new.company, new.email);
END;
