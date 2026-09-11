// search/service.js - main-process handle on the search worker.
//
// Correlation uses a service-internal token, NOT the renderer's requestId:
// several UI surfaces (palette, relationship picker) keep independent
// requestId counters, so ids alone can collide. The renderer's requestId is
// echoed back untouched for the contract's stale-discard semantics
// (INTERFACE_CONTRACT.md §3); superseded queries resolve empty under their
// own requestId so callers drop them quietly.

const path = require("path");
const { Worker } = require("worker_threads");
const config = require("../config");
const { AppError } = require("../ipc/errors");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKER_PATH = path.join(__dirname, "..", "workers", "search-worker.js");

class SearchService {
  /** @param {{ dbPath: string, key: string, log?: (m: string) => void }} opts */
  constructor({ dbPath, key, log = () => {} }) {
    this.seq = 0;
    /** @type {Map<number, { requestId: number, resolve: (r: any) => void, reject: (e: any) => void }>} */
    this.pending = new Map();
    this.worker = new Worker(WORKER_PATH, { workerData: { dbPath, key } });
    this.terminating = false;
    /** Resolves true once the worker has loaded the addon and opened its
     *  connection, false if it died first. terminate() waits on this: tearing a
     *  thread down mid-addon-load aborts the whole process (N-API fatal). */
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    /** @type {Promise<number>} the worker's exit code, once it has exited */
    this.exited = new Promise((resolve) => { this.worker.once("exit", (code) => resolve(code)); });
    this.worker.on("message", (msg) => {
      if (msg && msg.ready) { this.resolveReady(true); return; }
      const entry = this.pending.get(msg.token);
      if (!entry) return; // superseded or unknown; drop
      this.pending.delete(msg.token);
      if (msg.error) entry.reject(new AppError("INTERNAL", `Search failed: ${msg.error}`));
      else entry.resolve({ requestId: msg.requestId, results: msg.results, didYouMean: msg.didYouMean });
    });
    const failAll = (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    };
    this.worker.on("error", (err) => {
      log(`[search] worker error: ${err.message}`);
      this.resolveReady(false);
      failAll(new AppError("INTERNAL", "Search worker crashed."));
    });
    this.worker.on("exit", (code) => {
      this.resolveReady(false);
      if (code !== 0 && !this.terminating) failAll(new AppError("INTERNAL", "Search worker exited."));
    });
  }

  /**
   * @param {{ text: string, requestId: number, limit?: number }} query
   * @returns {Promise<import('../../shared/types').SearchResponse>}
   */
  query(query) {
    return new Promise((resolve, reject) => {
      const token = ++this.seq;
      // Anything still in flight is now superseded: resolve each empty under
      // its own requestId so the caller's stale-id check discards it quietly.
      for (const [t, entry] of this.pending) {
        this.pending.delete(t);
        entry.resolve({ requestId: entry.requestId, results: [] });
      }
      this.pending.set(token, { requestId: query.requestId, resolve, reject });
      this.worker.postMessage({ token, requestId: query.requestId, text: query.text, limit: query.limit });
    });
  }

  /**
   * Shut the worker down without ever killing it mid-load: wait for ready (or
   * death, or the timeout), ask it to close its connection and exit, and only
   * force-terminate if it does not. In-flight queries resolve empty under their
   * own requestId, the same quiet discard a superseded query gets.
   * @returns {Promise<number | null>} the worker's exit code, null if forced
   */
  async terminate() {
    if (this.terminating) return this.exited;
    this.terminating = true;
    for (const [t, entry] of this.pending) {
      this.pending.delete(t);
      entry.resolve({ requestId: entry.requestId, results: [] });
    }
    const alive = await Promise.race([this.ready, sleep(config.search.workerReadyTimeoutMs).then(() => "timeout")]);
    if (alive === false) return this.exited; // already gone
    try { this.worker.postMessage({ close: true }); } catch { /* port closed: fall through to terminate */ }
    const code = await Promise.race([this.exited, sleep(config.search.workerCloseTimeoutMs).then(() => null)]);
    if (code === null) await this.worker.terminate();
    return code;
  }
}

exports.SearchService = SearchService;
