// config.js — the ONE place tunables live. Never hardcode these elsewhere.

module.exports = {
  window: {
    width: 1200,
    height: 800,
    minWidth: 900,   // below this the two-column layout breaks (see APP_SHELL_UX)
    minHeight: 600,
  },

  db: {
    filename: "contacts.db",
    // synchronous=NORMAL is WAL-safe; FULL only if last-write power-loss durability is required
    pragmas: {
      journal_mode: "WAL",
      synchronous: "NORMAL",
      foreign_keys: "ON",
      busy_timeout: 5000,
    },
  },

  insights: {
    dormantDays: 180,           // "well-connected but untouched" threshold
    dormantLimit: 10,
    overdueLimit: 15,           // cadence-overdue rows surfaced
    connectorsLimit: 5,
    orgsLimit: 6,
  },

  explore: {
    resultLimit: 500,           // rows returned to the table (total is exact)
    facetTopN: 24,              // org/tag facet values surfaced, by count
    // Connection-strength buckets: [key, label, minDegree, maxDegree]
    degreeBuckets: [
      ["hub", "Hubs (20+)", 20, Infinity],
      ["connected", "Connected (5-19)", 5, 19],
      ["peripheral", "Peripheral (1-4)", 1, 4],
      ["isolated", "Isolated (0)", 0, 0],
    ],
  },

  trash: {
    autoPurgeDays: 30,          // trashed contacts are hard-deleted after this
  },

  backup: {
    dirName: "backups",
    intervalMs: 15 * 60 * 1000, // periodic snapshot
    onlyWhenChanged: true,      // skip a periodic snapshot when nothing changed since the last one
    keep: 10,                   // rotation depth (routine snapshots)
    keepPreMigration: 5,        // reserved within `keep`, never added on top
    onExit: true,               // best-effort final snapshot (never blocks quit)
  },

  search: {
    debounceMs: 120,
    candidateK: 200,            // FTS candidates handed to the fuzzy re-rank
    limit: 20,                  // results returned to the UI
    // Field weights for BM25 (name highest). Centralized so ranking is tunable.
    fieldWeights: { name: 10, email: 6, phone: 6, tags: 5, company: 4, role: 4, notes: 2 },
    // Re-rank blend + signal boosts.
    rerank: { wBm25: 0.45, wName: 0.30, wRecency: 0.15, wDegree: 0.10 },
    exactBoost: 0.25,
    prefixBoost: 0.12,
    fuzzyScanMin: 0.72,         // JW/DL floor for the last-resort name scan
    didYouMeanMin: 0.6,         // suggestion floor when recall is empty
    recencyHalfLifeDays: 90,    // interaction recency decay half-life
    hopsMax: 3,                 // cap for the near:/hops: graph operator
  },

  dedup: {
    nameSimMin: 0.92,           // Jaro-Winkler floor for name+org candidate pairs
    maxCandidates: 200,         // pairs surfaced to the review queue
    // Import match preview (advisory only - the user decides every record).
    matchNameSimMin: 0.86,      // lower fuzzy floor: surface POSSIBLE import matches
    matchMaxCandidates: 5,      // ranked candidates shown per incoming record
    matchConnections: 6,        // a candidate's related contacts shown for context
  },

  // In-app hover tooltips (tooltip.js). The renderer suppresses the native OS
  // tooltip and draws its own so help appears promptly and in the app's voice.
  tooltip: {
    showDelayMs: 120,   // long enough that sweeping the pointer doesn't flash tips
    repeatDelayMs: 40,  // moving between neighbouring controls feels instant
    hideDelayMs: 60,    // survives the gap between a control and its wrapper
    edgePadPx: 8,       // keep the bubble this far inside the window
    gapPx: 8,           // distance from the anchor
    maxWidthPx: 320,
  },

  graph: {
    lodLabelZoom: 1.4,          // labels appear above this zoom
    lodLabelMinDegree: 10,      // ...or for hubs at any zoom
    betweennessCacheTtlMs: 60 * 60 * 1000,
    egoDepthMax: 6,             // upper bound accepted by graph:ego
  },

  // Payload bounds enforced by IPC validation (renderer is untrusted).
  limits: {
    nameMax: 300,
    fieldKeyMax: 64,
    fieldValueMax: 10000,
    fieldsMaxKeys: 100,
    metadataMaxBytes: 16384,
    edgeTypeMax: 40,
    noteMax: 20000,
    listMax: 25000,             // hard cap on any list response
    importMaxBytes: 64 * 1024 * 1024, // refuse import files beyond this
    imageMaxBytes: 50 * 1024 * 1024,  // PNG export payload cap over IPC
    savedSearchMax: 100,              // saved searches kept
    bulkMax: 1000,                    // list-view bulk operation cap
  },

  security: {
    // Renderer hardening — asserted at window creation.
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'",
  },

  sample: {
    defaultContacts: 2000,      // data:seedSample default network size
    small: 100,                 // "small" sample preset
    large: 5000,                // "large" sample preset
    maxContacts: 20000,         // hard cap accepted over IPC
  },

  // Online location autocomplete and detailed maps. Enabled by default; the
  // user can explicitly disable both with one preference. Fetches happen in the
  // MAIN process so the renderer keeps connect-src 'none'. OpenStreetMap Photon:
  // free, no API key, built for as-you-type city search.
  location: {
    onlineDefault: true,
    photonUrl: "https://photon.komoot.io/api/",
    limit: 8,
    minChars: 2,
    timeoutMs: 4000,
    backfillOnlineMax: 40,  // online geocodes per backfill pass (politeness cap)
    backfillDelayMs: 200,   // pause between online geocode calls
  },

  // Online map tiles ride the same "location.online" preference. Fetched
  // in the MAIN process and handed to the renderer as data: URLs, so the renderer
  // keeps connect-src 'none'. Cached on disk to be polite to OSM's tile servers
  // and to keep pan/zoom snappy offline once tiles are seen.
  map: {
    // CARTO basemaps (OpenStreetMap-derived), light + dark so the map follows
    // the app theme. No API key. Cached per style so switching theme is instant
    // after first view.
    // @2x = retina tiles (512px), crisp on high-DPI screens.
    tileUrl: {
      light: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
      // Separate dark geography and labels so the renderer can improve label
      // contrast without making the basemap compete with contact markers.
      darkBase: "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png",
      darkLabels: "https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png",
    },
    tileTag: "@2x", // cache-key suffix so a resolution change doesn't reuse old tiles
    attribution: "© OpenStreetMap © CARTO",
    cacheDir: "tile-cache",
    maxZoom: 19,
    timeoutMs: 6000,
  },

  dev: {
    reloadDebounceMs: 150,      // window reload settle time in dev:watch mode
  },

  update: {
    enabled: true,
    // GitHub Releases feed is wired in electron-builder.yml (publish).
    intervalMs: 6 * 60 * 60 * 1000,
    backupBeforeApply: true,
  },
};
