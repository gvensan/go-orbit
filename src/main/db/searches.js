// searches.js - saved searches: a named, re-runnable query. `kind` separates
// free-text palette/Explore searches ('text') from structured Find queries
// ('find', whose `query` column holds JSON).

const config = require("../config");
const { AppError } = require("../ipc/errors");

const COLS = "id, name, query, kind, created_at AS createdAt";

function list(db, /** @type {{ kind?: "text" | "find" }} */ { kind } = {}) {
  if (kind) {
    return db.prepare(`SELECT ${COLS} FROM saved_searches WHERE kind = ? ORDER BY name`).all(kind);
  }
  return db.prepare(`SELECT ${COLS} FROM saved_searches ORDER BY name`).all();
}

/** Saving under an existing name replaces that search. */
function save(db, { name, query, kind = "text" }) {
  const tx = db.transaction(() => {
    const count = db.prepare("SELECT COUNT(*) c FROM saved_searches").get().c;
    const exists = db.prepare("SELECT id FROM saved_searches WHERE name = ?").get(name);
    if (!exists && count >= config.limits.savedSearchMax) {
      throw new AppError("VALIDATION", `At most ${config.limits.savedSearchMax} saved searches.`);
    }
    db.prepare(
      `INSERT INTO saved_searches (name, query, kind, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET query = excluded.query, kind = excluded.kind, created_at = excluded.created_at`
    ).run(name, query, kind, Date.now());
    return db.prepare(`SELECT ${COLS} FROM saved_searches WHERE name = ?`).get(name);
  });
  return tx();
}

function remove(db, id) {
  const info = db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
  return { ok: info.changes > 0 };
}

module.exports = { list, save, remove };
