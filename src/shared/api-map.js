// api-map.js - the one table mapping window.api namespaces and methods to
// channels. The browser bridge (src/renderer/web-api.js) builds its fetchers
// from this table, and test/ipc-contract.test.js asserts it names exactly the
// channels the registry serves and IpcContract declares. CommonJS so both the
// Node side and the Vite-bundled renderer can load it.
//
// Three entries are handled in the browser and never reach the service as an
// RPC: dialogs.openFile / dialogs.saveFile (a file picker and a download) and
// app.onMenu / updates.onStatus (subscriptions). They stay in the table so the
// contract check still covers them.

/** @type {Record<string, Record<string, string>>} */
const API_MAP = {
  contacts: {
    list: "contacts:list",
    get: "contacts:get",
    create: "contacts:create",
    update: "contacts:update",
    softDelete: "contacts:softDelete",
    restore: "contacts:restore",
    purge: "contacts:purge",
    setTags: "contacts:setTags",
  },
  edges: {
    create: "edges:create",
    delete: "edges:delete",
    list: "edges:list",
    update: "edges:update",
  },
  profile: {
    get: "profile:get",
    set: "profile:set",
    setOwner: "profile:setOwner",
  },
  location: {
    search: "location:search",
    online: "location:online",
    setOnline: "location:setOnline",
    backfill: "location:backfill",
  },
  map: {
    tile: "map:tile",
  },
  interactions: {
    list: "interactions:list",
    add: "interactions:add",
  },
  tags: {
    list: "tags:list",
  },
  graph: {
    snapshot: "graph:snapshot",
    ego: "graph:ego",
    path: "graph:path",
    centrality: "graph:centrality",
  },
  search: {
    query: "search:query",
  },
  updates: {
    status: "update:status",
    check: "update:check",
    install: "update:install",
  },
  dedup: {
    candidates: "dedup:candidates",
    merge: "dedup:merge",
    undo: "dedup:undo",
  },
  setup: {
    status: "setup:status",
    mark: "setup:mark",
  },
  health: {
    scan: "health:scan",
    last: "health:last",
    setStatus: "health:setStatus",
    fix: "health:fix",
  },
  dialogs: {
    openFile: "dialog:openFile",
    saveFile: "dialog:saveFile",
  },
  insights: {
    summary: "insights:summary",
  },
  explore: {
    query: "explore:query",
    fieldValues: "explore:fieldValues",
  },
  find: {
    query: "find:query",
  },
  insightsExt: {
    extended: "insights:extended",
    breakdown: "insights:breakdown",
  },
  searches: {
    list: "searches:list",
    save: "searches:save",
    delete: "searches:delete",
  },
  data: {
    backupNow: "backup:now",
    backupStatus: "backup:status",
    backupList: "backup:list",
    restoreLatest: "backup:restoreLatest",
    restoreBackup: "backup:restore",
    deleteBackup: "backup:delete",
    clearAll: "data:clearAll",
    exportArchive: "export:archive",
    exportCsv: "export:csv",
    exportGraphML: "export:graphml",
    exportImage: "export:image",
    importArchive: "import:archive",
    importPreview: "import:preview",
    importFile: "import:file",
    importParse: "import:parse",
    importRecords: "import:records",
    importMatch: "import:match",
    importWriteResults: "import:writeResults",
    seedSample: "data:seedSample",
    sampleStatus: "data:sampleStatus",
  },
};

/** Channels whose handler runs in the browser, never as an RPC. */
const BROWSER_ONLY_CHANNELS = ["dialog:openFile", "dialog:saveFile"];

/** Channels that hand a file to the user: the bridge turns the granted export
 *  slot into a browser download once the handler has written it. */
const DOWNLOAD_CHANNELS = ["export:archive", "export:csv", "export:graphml", "export:image", "import:writeResults"];

/** Channels after which the service restarts; the bridge waits for it to come
 *  back and reloads the page. */
const RESTART_CHANNELS = ["backup:restoreLatest", "backup:restore", "update:install"];

/** @returns {string[]} every channel named in the table */
function allChannels() {
  return Object.values(API_MAP).flatMap((ns) => Object.values(ns));
}

module.exports = { API_MAP, BROWSER_ONLY_CHANNELS, DOWNLOAD_CHANNELS, RESTART_CHANNELS, allChannels };
