// layout-service.js - drives the full-graph layout worker: seeds from
// persisted positions, streams ticks to the renderer over the
// graph:layout:tick event channel, persists the settled result.

const path = require("path");
const { Worker } = require("worker_threads");
const config = require("../config");

const WORKER_PATH = path.join(__dirname, "..", "workers", "layout-worker.js");

class LayoutService {
  /** @param {{ db: any, log?: (m: string) => void }} opts */
  constructor({ db, log = () => {} }) {
    this.db = db;
    this.log = log;
    /** @type {Worker | null} */
    this.worker = null;
  }

  get running() {
    return this.worker !== null;
  }

  /**
   * @param {import('./store').GraphStore} graphStore
   * @param {(positions: Record<number, {x: number, y: number}>) => void} sendTick
   */
  start(graphStore, sendTick) {
    if (this.worker) return { running: true };

    const persisted = new Map(
      this.db.prepare("SELECT contact_id, x, y FROM layout_positions").all()
        .map((r) => [r.contact_id, r])
    );
    const snap = graphStore.snapshot();
    const R = 100 * Math.sqrt(Math.max(1, snap.nodes.length) / 50);
    const nodes = snap.nodes.map((n, i) => {
      const p = persisted.get(n.id);
      const angle = (2 * Math.PI * i) / Math.max(1, snap.nodes.length);
      return {
        id: n.id,
        x: p ? p.x : R * Math.cos(angle),
        y: p ? p.y : R * Math.sin(angle),
        size: Math.max(1, Math.sqrt(n.degree ?? 1)),
      };
    });
    const edges = snap.links.map((l) => ({ source: l.source, target: l.target }));

    const fa2 = config.graph.forceAtlas2;
    const worker = new Worker(WORKER_PATH, {
      workerData: { nodes, edges, iterations: fa2.iterations, chunkIterations: fa2.chunkIterations },
    });
    this.worker = worker;

    worker.on("message", (msg) => {
      if (msg.type === "tick") {
        sendTick(msg.positions);
      } else if (msg.type === "done") {
        sendTick(msg.positions);
        this.persist(msg.positions);
        this.log(`[layout] settled ${Object.keys(msg.positions).length} positions`);
        this.stop();
      }
    });
    worker.on("error", (err) => {
      this.log(`[layout] worker error: ${err.message}`);
      this.stop();
    });
    return { running: true };
  }

  persist(positions) {
    const now = Date.now();
    const upsert = this.db.prepare(
      `INSERT INTO layout_positions (contact_id, x, y, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(contact_id) DO UPDATE SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`
    );
    const tx = this.db.transaction(() => {
      for (const [id, p] of Object.entries(positions)) upsert.run(Number(id), p.x, p.y, now);
    });
    tx();
  }

  stop() {
    if (this.worker) {
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    return { running: false };
  }
}

module.exports = { LayoutService };
