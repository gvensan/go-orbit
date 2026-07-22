// search-worker.js - the search thread (SEARCH_REQUIREMENTS §5, execution model).
//
// Owns its own READ-ONLY keyed connection so queries never block or get blocked
// by writes (WAL). Receives { requestId, text, limit } messages, replies with
// the SearchResponse from the engine. Sequential by design; the service side
// discards stale responses by requestId.

const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3-multiple-ciphers");
const { prepareStatements, search } = require("../search/engine");

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma(`key = '${String(workerData.key).replace(/'/g, "''")}'`);
const stmts = prepareStatements(db);

parentPort.on("message", (query) => {
  try {
    // token correlates with the service; requestId is the renderer's.
    parentPort.postMessage({ token: query.token, ...search(stmts, query) });
  } catch (err) {
    parentPort.postMessage({
      token: query && query.token,
      requestId: query && query.requestId,
      error: String(err && err.message),
    });
  }
});
