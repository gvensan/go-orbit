// centrality-service.js - on-demand betweenness with a TTL cache
// (config.graph.betweennessCacheTtlMs). One computation at a time; concurrent
// requests share the same in-flight promise. Writes invalidate via bump().

const path = require("path");
const { Worker } = require("worker_threads");
const config = require("../config");
const { AppError } = require("../ipc/errors");

const WORKER_PATH = path.join(__dirname, "..", "workers", "betweenness-worker.js");

class CentralityService {
  /** @param {{ dbPath: string, key: string, log?: (m: string) => void }} opts */
  constructor({ dbPath, key, log = () => {} }) {
    this.dbPath = dbPath;
    this.key = key;
    this.log = log;
    this.cache = null;      // { values, computedAt }
    this.inFlight = null;   // Promise
  }

  /** Invalidate after any write that changes the graph. */
  bump() {
    this.cache = null;
  }

  /** @returns {Promise<Record<number, number>>} */
  betweenness() {
    const ttl = config.graph.betweennessCacheTtlMs;
    if (this.cache && Date.now() - this.cache.computedAt < ttl) {
      return Promise.resolve(this.cache.values);
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = new Promise((resolve, reject) => {
      const started = Date.now();
      const worker = new Worker(WORKER_PATH, {
        workerData: { dbPath: this.dbPath, key: this.key },
      });
      worker.once("message", (msg) => {
        this.cache = { values: msg.values, computedAt: Date.now() };
        this.log(`[centrality] betweenness computed in ${Date.now() - started}ms`);
        resolve(msg.values);
        worker.terminate().catch(() => {});
      });
      worker.once("error", (err) => {
        this.log(`[centrality] worker error: ${err.message}`);
        reject(new AppError("INTERNAL", "Centrality computation failed."));
      });
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}

exports.CentralityService = CentralityService;
