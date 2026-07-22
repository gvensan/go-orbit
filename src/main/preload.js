// preload.js - the ONLY bridge between renderer and main.
//
// contextIsolation and sandbox are on, so the renderer sees exactly
// `window.api` and nothing else. One method per IPC channel (see
// docs/INTERFACE_CONTRACT.md). No raw ipcRenderer, no Node globals, cross this
// boundary. Sandboxed preloads cannot require() project files, so the channel
// list is literal here; test/ipc-contract.test.js asserts it matches the main
// process registry and IpcContract in types.d.ts.

const { contextBridge, ipcRenderer } = require("electron");

const MARKER = "IPCERR:";

/**
 * Wrap invoke so every call is a promise-returning method, and re-hydrate the
 * IpcError shape that main serialized into the Error message (Electron strips
 * custom error properties in transit).
 */
const invoke = (channel) => async (payload) => {
  try {
    return await ipcRenderer.invoke(channel, payload ?? {});
  } catch (err) {
    const msg = String(err && err.message);
    const at = msg.indexOf(MARKER);
    if (at !== -1) {
      try {
        const ipcError = JSON.parse(msg.slice(at + MARKER.length));
        throw Object.assign(new Error(ipcError.message), ipcError);
      } catch (parsed) {
        if (parsed instanceof SyntaxError) throw err;
        throw parsed;
      }
    }
    throw err;
  }
};

const api = {
  contacts: {
    list: invoke("contacts:list"),
    get: invoke("contacts:get"),
    create: invoke("contacts:create"),
    update: invoke("contacts:update"),
    softDelete: invoke("contacts:softDelete"),
    restore: invoke("contacts:restore"),
    purge: invoke("contacts:purge"),
    setTags: invoke("contacts:setTags"),
  },
  edges: {
    create: invoke("edges:create"),
    delete: invoke("edges:delete"),
    list: invoke("edges:list"),
    update: invoke("edges:update"),
  },
  profile: {
    get: invoke("profile:get"),
    set: invoke("profile:set"),
    setOwner: invoke("profile:setOwner"),
  },
  location: {
    search: invoke("location:search"),
    online: invoke("location:online"),
    setOnline: invoke("location:setOnline"),
    backfill: invoke("location:backfill"),
  },
  map: {
    tile: invoke("map:tile"),
  },
  interactions: {
    list: invoke("interactions:list"),
    add: invoke("interactions:add"),
  },
  tags: {
    list: invoke("tags:list"),
  },
  graph: {
    snapshot: invoke("graph:snapshot"),
    ego: invoke("graph:ego"),
    path: invoke("graph:path"),
    centrality: invoke("graph:centrality"),
    layoutStart: invoke("graph:layoutStart"),
    layoutStop: invoke("graph:layoutStop"),
    savePositions: invoke("graph:savePositions"),
    // Layout is a streamed event channel, not request/response.
    onLayoutTick: (cb) => {
      const listener = (_e, positions) => cb(positions);
      ipcRenderer.on("graph:layout:tick", listener);
      return () => ipcRenderer.removeListener("graph:layout:tick", listener);
    },
  },
  search: {
    query: invoke("search:query"),
  },
  app: {
    // Native menu commands stream in as ids (event channel, like layout ticks).
    onMenu: (cb) => {
      const listener = (_e, id) => cb(id);
      ipcRenderer.on("app:menu", listener);
      return () => ipcRenderer.removeListener("app:menu", listener);
    },
  },
  dedup: {
    candidates: invoke("dedup:candidates"),
    merge: invoke("dedup:merge"),
    undo: invoke("dedup:undo"),
  },
  dialogs: {
    openFile: invoke("dialog:openFile"),
    saveFile: invoke("dialog:saveFile"),
  },
  insights: {
    summary: invoke("insights:summary"),
  },
  explore: {
    query: invoke("explore:query"),
    fieldValues: invoke("explore:fieldValues"),
  },
  find: {
    query: invoke("find:query"),
  },
  insightsExt: {
    extended: invoke("insights:extended"),
    breakdown: invoke("insights:breakdown"),
  },
  searches: {
    list: invoke("searches:list"),
    save: invoke("searches:save"),
    delete: invoke("searches:delete"),
  },
  data: {
    backupNow: invoke("backup:now"),
    backupStatus: invoke("backup:status"),
    backupList: invoke("backup:list"),
    restoreLatest: invoke("backup:restoreLatest"),
    restoreBackup: invoke("backup:restore"),
    deleteBackup: invoke("backup:delete"),
    clearAll: invoke("data:clearAll"),
    exportArchive: invoke("export:archive"),
    exportGraphML: invoke("export:graphml"),
    exportImage: invoke("export:image"),
    importArchive: invoke("import:archive"),
    importPreview: invoke("import:preview"),
    importFile: invoke("import:file"),
    seedSample: invoke("data:seedSample"),
    sampleStatus: invoke("data:sampleStatus"),
  },
};

contextBridge.exposeInMainWorld("api", api);
