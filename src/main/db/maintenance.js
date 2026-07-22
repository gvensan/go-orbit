// maintenance.js - destructive whole-database operations. clearAll() empties
// every data table for a fresh start; the caller takes a safety backup first
// (a VACUUM INTO snapshot), so it remains recoverable via Restore.

/**
 * Delete all user data. Deleting contacts cascades to edges, interactions,
 * contact_tags, layout_positions, and the search projection (whose triggers
 * clear the FTS mirrors); the rest are cleared explicitly.
 * @returns {{ contacts: number }} how many live+trashed contacts were removed
 */
function clearAll(db) {
  const before = db.prepare("SELECT COUNT(*) c FROM contacts").get().c;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM contacts").run(); // cascades derived rows
    db.prepare("DELETE FROM tags").run();
    db.prepare("DELETE FROM merge_log").run();
    db.prepare("DELETE FROM saved_searches").run();
    // app_meta holds the owner profile + sample-data flag; a full reset wipes
    // those too so "start my own network" begins from a truly clean slate.
    db.prepare("DELETE FROM app_meta").run();
    // Belt and braces in case any orphan rows survived a partial past state.
    for (const t of ["edges", "interactions", "contact_tags", "layout_positions", "contacts_search"]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  });
  tx();
  db.exec("VACUUM"); // reclaim the freed space (must be outside a transaction)
  return { contacts: before };
}

module.exports = { clearAll };
