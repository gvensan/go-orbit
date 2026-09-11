// config.js — the ONE place tunables live. Never hardcode these elsewhere.

module.exports = {
  // The service: a Node HTTP server bound to loopback, one per data home.
  server: {
    host: "127.0.0.1",          // never configurable; the app is single-machine by design
    port: 7779,
    portEnv: "ORBIT_PORT",      // overrides port (the launchd agent sets it)
    homeEnv: "ORBIT_HOME",      // overrides the data home
    homeDirName: ".orbit",      // default data home under the user's home directory
    sessionCookie: "orbit_session",
    sessionMaxAgeDays: 365,        // cookie lifetime; the token itself never expires (bin/orbit reset-session rotates it)
    // Covers the largest legitimate bodies: a 64 MB import upload and the base64
    // PNG export payload (limits.imageMaxBytes * 4/3).
    bodyMaxBytes: 80 * 1024 * 1024,
    uploadTtlMs: 60 * 60 * 1000,   // an idle import upload lingers at most this long (refreshed on every read)
    exportTtlMs: 60 * 60 * 1000,   // an export waits at most this long to be downloaded
    restartExitCode: 3,            // non-zero so launchd (KeepAlive on failure) restarts us
    bootFailureExitCode: 0,        // a boot failure stays down (no 5-second crash loop); doctor and logs say why
    restartDrainMs: 10 * 1000,     // wait for in-flight requests before a restart, at most this long
    localHosts: ["localhost", "127.0.0.1", "[::1]", "::1"],
    launchdLabel: "dev.orbit",     // the macOS login agent (bin/orbit reads it too)
    logMaxBytes: 5 * 1024 * 1024,  // orbit.log rotates to orbit.log.1 past this
    livenessPollMs: 5 * 1000,      // browser polls /api/health (cheap, unauthenticated) at this rate
    statusPollMs: 30 * 1000,       // browser polls update:status at this rate
    restartPollMs: 500,            // browser polls health while the service restarts
    restartWaitMaxMs: 30 * 1000,   // give up waiting for a restart after this
  },

  window: {
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
    // Worker lifecycle. Terminating a worker while it is still loading the
    // native SQLite addon is a fatal in N-API (the whole process aborts), so
    // shutdown waits for the worker to report ready, asks it to close, and only
    // forces termination past these limits.
    workerReadyTimeoutMs: 5000,
    workerCloseTimeoutMs: 2000,
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
    // Sent as a response header on every page and asserted equal to the meta tag
    // in index.html by test/ipc-contract.test.js. connect-src 'self' is the one
    // relaxation from the desktop build: the UI must reach its own service. It
    // still cannot reach any other origin; tiles and geocoding are proxied.
    csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  },

  sample: {
    defaultContacts: 2000,      // data:seedSample default network size
    small: 100,                 // "small" sample preset
    large: 5000,                // "large" sample preset
    maxContacts: 20000,         // hard cap accepted over IPC
  },

  // Online location autocomplete and detailed maps. Enabled by default; the
  // user can explicitly disable both with one preference. Fetches happen in the
  // SERVICE so the browser never talks to a third party. OpenStreetMap Photon:
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

  // Online map tiles ride the same "location.online" preference. Fetched by
  // the service and handed to the browser as data: URLs, so the page's CSP
  // stays 'self'-only. Cached on disk to be polite to OSM's tile servers
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

  // The "Add to Orbit" bookmarklet (Settings > Setup): what it carries and where it lands.
  bookmarklet: {
    selectionMax: 2000,     // characters of selected page text passed along as notes
    windowName: "orbit",    // the app names its window this, so the bookmarklet can reuse a tab it opened
    matchMin: 0.86,         // a candidate at or above this asks "already have them?" first
  },

  dev: {
    reloadDebounceMs: 150,      // dev:watch settle time between a rebuild and a restart
  },

  // "Updates" in the service model mean: newer code is on disk (bin/orbit
  // update, or a git pull) and the running process has not restarted yet.
  update: {
    enabled: true,
    codeChangeGraceMs: 2000,    // ignore mtimes this close to process start
    codeChangeCacheMs: 2000,    // stat the source tree at most this often (every tab polls health)
    backupBeforeApply: true,    // verified snapshot before a restart applies new code
  },
};
