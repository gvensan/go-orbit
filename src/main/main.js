// main.js - Electron main process lifecycle orchestrator. Thin by design:
// the data layer lives in db/, the graph model in graph/, the IPC surface in
// ipc/registry.js, and every tunable in config.js.
//
// Startup order (dependency order):   lock -> key -> database -> graph -> services -> IPC -> UI
// Shutdown order (strict reverse):    UI -> services -> database -> release
//
// The database comes up first and goes down last so durability is always
// guaranteed. Teardown is idempotent and wired to every exit path so the app
// never leaves a dangling WAL behind (the main local-corruption risk).

const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require("electron");
const fs = require("fs");
const path = require("path");
const log = require("electron-log/main");
const config = require("./config");
const dbLayer = require("./db");
const contactsRepo = require("./db/contacts");
const { AppError } = require("./ipc/errors");
const { CentralityService } = require("./graph/centrality-service");
const { ExploreService } = require("./explore/service");
const { LayoutService } = require("./graph/layout-service");
const { GraphStore } = require("./graph/store");
const { registerIpc } = require("./ipc/registry");
const { getOrCreateDbKey } = require("./keys");
const { buildAppMenu } = require("./menu");
const { SearchService } = require("./search/service");

// NOTE: no app.setName() here. On macOS, safeStorage's keychain entry is
// derived from the app name, so renaming orphans the encrypted DB key; and
// the dev menu-bar title says "Electron" regardless (packaging fixes it via
// productName). Cross-profile migration is what export/import archives are for.
log.initialize();

const runtime = {
  /** @type {any} */ db: null,
  /** @type {GraphStore | null} */ graph: null,
  /** @type {SearchService | null} */ search: null,
  /** @type {LayoutService | null} */ layout: null,
  /** @type {CentralityService | null} */ centrality: null,
  /** @type {ExploreService | null} */ explore: null,
  /** @type {NodeJS.Timeout | null} */ backupTimer: null,
  /** @type {BrowserWindow | null} */ window: null,
  key: "",
  backupDir: "",
};

/** WebContents created by us; IPC from anything else is rejected. */
const trustedContents = new Set();

/** File paths the user picked via a dialog; import/export only honor these. */
const grantedPaths = new Set();

let shuttingDown = false; // teardown re-entrancy guard

// ===========================================================================
// COMPONENT: window (UI) - created last, after the data layer is ready
// ===========================================================================
function createWindow() {
  const win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    show: false,
    webPreferences: {
      contextIsolation: config.security.contextIsolation,
      sandbox: config.security.sandbox,
      nodeIntegration: config.security.nodeIntegration,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // Capture the WebContents ref: inside the "destroyed" handler the
  // `win.webContents` getter throws "Object has been destroyed", so we must not
  // read it there (this fired on every dev reload).
  const wc = win.webContents;
  trustedContents.add(wc);
  wc.once("destroyed", () => trustedContents.delete(wc));
  win.on("closed", () => {
    // Never leave a destroyed window referenced (macOS keeps the app alive).
    if (runtime.window === win) runtime.window = null;
  });
  if (!app.isPackaged) {
    win.webContents.on("console-message", (_e, _level, message) =>
      log.info(`[renderer] ${message}`)
    );
  }
  win.once("ready-to-show", () => win.show());
  const indexHtml = path.join(__dirname, "..", "..", "dist", "renderer", "index.html");
  const loadRenderer = () => win.loadFile(indexHtml).catch(() => {});

  // Dev: `vite --watch` empties dist/renderer on startup/rebuild (emptyOutDir),
  // so index.html can be momentarily absent right as Electron boots. Wait for
  // it before the first load so we don't flash an ERR_FILE_NOT_FOUND.
  if (app.isPackaged || fs.existsSync(indexHtml)) {
    loadRenderer();
  } else {
    let tries = 0;
    const iv = setInterval(() => {
      if (win.isDestroyed()) return clearInterval(iv);
      if (fs.existsSync(indexHtml) || tries++ > 100) { clearInterval(iv); loadRenderer(); }
    }, 50);
  }
  if (!app.isPackaged) {
    // Backstop: a hot-reload that lands mid-rebuild (ERR_FILE_NOT_FOUND = -6)
    // just retries until the rebuild has written index.html back.
    let retries = 0;
    win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code === -6 && retries++ < 25) setTimeout(loadRenderer, 120);
    });
    win.webContents.on("did-finish-load", () => { retries = 0; });
  }
  return win;
}

// ===========================================================================
// BOOT - ordered, fail-fast
// ===========================================================================
function boot() {
  const userData = app.getPath("userData");
  runtime.backupDir = path.join(userData, config.backup.dirName);
  const dbPath = path.join(userData, config.db.filename);

  runtime.key = getOrCreateDbKey(userData);                       // 1. keychain
  runtime.db = dbLayer.openDatabase({                             // 2. durable store
    dbPath,
    backupDir: runtime.backupDir,
    key: runtime.key,
    log: (m) => log.info(m),
  });
  const purged = contactsRepo.autoPurge(runtime.db, config.trash.autoPurgeDays);
  if (purged) log.info(`[trash] auto-purged ${purged} contact(s) trashed > ${config.trash.autoPurgeDays} days`);
  runtime.graph = new GraphStore().hydrate(runtime.db);           // 3. query layer
  log.info(`[graph] hydrated ${runtime.graph.order} nodes / ${runtime.graph.size} edges`);
  if (!app.isPackaged && process.env.ORBIT_ASSIGN_GENDER) {
    // Dev/demo one-shot: give existing contacts a random Male/Female gender.
    const rows = runtime.db.prepare("SELECT id, fields FROM contacts WHERE deleted_at IS NULL").all();
    const upd = runtime.db.prepare("UPDATE contacts SET fields = ?, updated_at = ? WHERE id = ?");
    const now = Date.now();
    let n = 0;
    const tx = runtime.db.transaction(() => {
      for (const r of rows) {
        const f = r.fields ? JSON.parse(r.fields) : {};
        if (!f.gender) {
          f.gender = Math.random() < 0.5 ? "Male" : "Female";
          upd.run(JSON.stringify(f), now, r.id);
          n++;
        }
      }
    });
    tx();
    log.info(`[dev] assigned random gender to ${n} contacts`);
  }
  if (!app.isPackaged && process.env.ORBIT_DEV_SEED && runtime.graph.order === 0) {
    // Dev convenience: ORBIT_DEV_SEED=<n> pre-seeds an empty DB at boot.
    const { seedSample } = require("./db/sample");
    const r = seedSample(runtime.db, { count: parseInt(process.env.ORBIT_DEV_SEED, 10) });
    runtime.graph.hydrate(runtime.db);
    log.info(`[dev] seeded sample network: ${r.contacts} contacts / ${r.edges} edges`);
  }
  runtime.search = new SearchService({                            // 4. services
    dbPath,
    key: runtime.key,
    log: (m) => log.error(m),
  });
  runtime.layout = new LayoutService({ db: runtime.db, log: (m) => log.info(m) });
  runtime.centrality = new CentralityService({
    dbPath,
    key: runtime.key,
    log: (m) => log.info(m),
  });
  runtime.explore = new ExploreService({ db: runtime.db, graph: runtime.graph });
  runtime.backupTimer = dbLayer.startBackupScheduler(runtime.db, runtime.backupDir, {
    key: runtime.key,
    log: (m) => log.info(m),
    onError: (e) => log.error(`[backup] failed: ${e.message}`),
  });
  registerIpc(                                                    // 5. wire IPC
    ipcMain,
    {
      db: runtime.db,
      graph: runtime.graph,
      search: runtime.search,
      layout: runtime.layout,
      centrality: runtime.centrality,
      explore: runtime.explore,
      backupDir: runtime.backupDir,
      key: runtime.key,
      sendLayoutTick: (positions) => {
        if (runtime.window && !runtime.window.isDestroyed()) {
          runtime.window.webContents.send("graph:layout:tick", positions);
        }
      },
      grantedPaths,
      dbPath,
      appVersion: app.getVersion(),
      logPath: log.transports.file.getFile().path,
      restoreLatestAndRelaunch: () => restoreLatestAndRelaunch(dbPath),
      restoreSnapshotAndRelaunch: (file) => restoreSnapshotAndRelaunch(dbPath, file),
      dialog: {
        openFile: async ({ filters }) => {
          const r = await dialog.showOpenDialog(runtime.window, {
            properties: ["openFile"],
            filters,
          });
          const path_ = r.canceled ? null : r.filePaths[0] ?? null;
          if (path_) grantedPaths.add(path_); // unlocks import for this path
          return { path: path_ };
        },
        saveFile: async ({ defaultName, filters }) => {
          const r = await dialog.showSaveDialog(runtime.window, {
            defaultPath: defaultName,
            filters,
          });
          const path_ = r.canceled ? null : r.filePath ?? null;
          if (path_) grantedPaths.add(path_); // unlocks export to this path
          return { path: path_ };
        },
      },
    },
    {
      isTrustedSender: (wc) => trustedContents.has(wc),
      log: (m, err) => log.error(m, err),
    }
  );
  runtime.window = createWindow();                                // 6. UI last
  Menu.setApplicationMenu(
    buildAppMenu(
      (id) => {
        if (runtime.window && !runtime.window.isDestroyed()) {
          runtime.window.webContents.send("app:menu", id);
        }
      },
      { isDev: !app.isPackaged }
    )
  );
  if (!app.isPackaged) watchRendererDist();                       // dev only
  log.info("[boot] all components up");
}

// Dev-only: reload the window when vite --watch rewrites dist/renderer
// (scripts/dev-watch.js). No dev server, so the CSP stays production-strict.
function watchRendererDist() {
  const dist = path.join(__dirname, "..", "..", "dist", "renderer");
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  try {
    fs.watch(dist, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        log.info("[dev] renderer changed, reloading window");
        runtime.window?.webContents.reload();
      }, config.dev.reloadDebounceMs);
    });
  } catch {
    /* dist not built yet; plain `npm run dev` builds it first */
  }
}

// ===========================================================================
// RESTORE - swap in the newest verified snapshot, then relaunch
// ===========================================================================
/** Restore a specific verified snapshot, then relaunch. */
function restoreSnapshotAndRelaunch(dbPath, target) {
  if (!dbLayer.verifySnapshot(target, runtime.key)) {
    throw new AppError("VALIDATION", "That backup can't be opened; nothing was changed.");
  }

  // Copy the chosen snapshot aside FIRST: the safety-net backup below can rotate
  // files out (keep-N), and a user might pick the oldest one - so preserve it
  // before anything else touches the backups directory.
  const stash = dbPath + ".restore-src";
  fs.copyFileSync(target, stash);

  // Safety net: the pre-restore state becomes a snapshot too, so a mistaken
  // restore is itself reversible.
  dbLayer.takeBackup(runtime.db, runtime.backupDir, { key: runtime.key });

  shuttingDown = true; // teardown must not double-close what we close here
  if (runtime.backupTimer) clearInterval(runtime.backupTimer);
  runtime.search?.terminate().catch(() => {});
  runtime.layout?.stop();
  dbLayer.checkpointAndClose(runtime.db);
  runtime.db = null;
  dbLayer.replaceDatabaseFile(dbPath, stash);
  try { fs.unlinkSync(stash); } catch {}
  log.info(`[restore] replaced database with ${path.basename(target)}; relaunching`);

  // Let the IPC reply reach the renderer before the process goes away.
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 400);
  return { ok: true, restoredFrom: path.basename(target) };
}

function restoreLatestAndRelaunch(dbPath) {
  const snaps = dbLayer.listBackups(runtime.backupDir);
  const target = snaps.find((s) => dbLayer.verifySnapshot(s, runtime.key));
  if (!target) throw new AppError("NOT_FOUND", "No verified backup snapshot to restore.");
  return restoreSnapshotAndRelaunch(dbPath, target);
}

// ===========================================================================
// TEARDOWN - idempotent, synchronous, strict reverse order
// ===========================================================================
function teardown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("[shutdown] tearing down components");

  // services: stop taking new snapshots, stop the search worker
  if (runtime.backupTimer) {
    clearInterval(runtime.backupTimer);
    runtime.backupTimer = null;
  }
  if (runtime.search) {
    runtime.search.terminate().catch(() => {}); // best-effort; dies with the process anyway
    runtime.search = null;
  }
  if (runtime.layout) {
    runtime.layout.stop();
    runtime.layout = null;
  }
  runtime.centrality = null; // its worker exits on its own

  // database: final snapshot (best-effort) -> checkpoint -> close
  if (runtime.db) {
    if (config.backup.onExit) {
      try {
        dbLayer.takeBackup(runtime.db, runtime.backupDir, { key: runtime.key });
      } catch (e) {
        log.error(`[shutdown] final backup skipped: ${e.message}`);
      }
    }
    try {
      dbLayer.checkpointAndClose(runtime.db);
    } catch (e) {
      log.error(`[shutdown] db close error: ${e.message}`);
    }
    runtime.db = null;
  }

  runtime.graph = null; // release in-memory graph
  log.info("[shutdown] clean");
}

// ===========================================================================
// SECURITY - renderer hardening beyond webPreferences
// (docs/SECURITY_AND_THREAT_MODEL.md §5; CSP is the meta tag in index.html,
// kept in lockstep with config.security.csp by test/csp.test.js)
// ===========================================================================
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
});

// ===========================================================================
// LIFECYCLE WIRING - cover every exit path
// ===========================================================================

// Single-instance lock: two processes on one SQLite file can corrupt it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (runtime.window && !runtime.window.isDestroyed()) {
      if (runtime.window.isMinimized()) runtime.window.restore();
      runtime.window.focus();
    }
  });

  app.whenReady().then(() => {
    // The renderer never legitimately needs a Chromium permission (geolocation,
    // media, notifications, ...): local content only. Deny them all.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // Brand the About panel as "Orbit" (independent of app.getName(), which we
    // must not change - it keys the encrypted DB). Packaged builds already read
    // "Orbit" from productName; this makes the About dialog + dock read right in
    // dev too, without touching the storage identity.
    const iconPath = path.join(__dirname, "..", "..", "build", "icon.png");
    try {
      app.setAboutPanelOptions({
        applicationName: "Orbit",
        applicationVersion: app.getVersion(),
        version: "",
        copyright: "© Orbit",
        iconPath,
      });
    } catch { /* about panel is cosmetic */ }
    // Dev: the dock/taskbar icon comes from electron-builder only when packaged,
    // so set it here for `electron .` runs. (Packaged builds use build/icon.png.)
    if (!app.isPackaged && process.platform === "darwin") {
      try {
        const { nativeImage } = require("electron");
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) app.dock.setIcon(img);
      } catch { /* icon is cosmetic; ignore */ }
    }
    try {
      boot();
    } catch (err) {
      log.error("[boot] FAILED:", err);
      dialog.showErrorBox(
        "Orbit could not start",
        `${err.message}\n\nYour data has not been modified. See the log for details.`
      );
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !shuttingDown && runtime.db) {
      runtime.window = createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Normal quit path - synchronous teardown, no async dance needed.
  app.on("before-quit", teardown);

  // Safety nets: OS signals and fatal errors still flush + close the DB.
  const hardExit = (code) => {
    teardown();
    process.exit(code);
  };
  process.on("SIGINT", () => hardExit(0));
  process.on("SIGTERM", () => hardExit(0));
  process.on("uncaughtException", (err) => {
    log.error("[fatal]", err);
    hardExit(1);
  });
}
