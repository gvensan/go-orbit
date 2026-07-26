// updater.js - signed packaged-release updates with a verified database
// snapshot as the gate to installation. Development builds never initialize
// electron-updater and therefore make no release-feed network requests.

const { app } = require("electron");
const config = require("./config");
const dbLayer = require("./db");

/**
 * @param {{ db: any, backupDir: string, key: string, log: any,
 *           notify?: (state: any) => void }} opts
 */
function createUpdater({ db, backupDir, key, log, notify = () => {} }) {
  const state = {
    supported: app.isPackaged && config.update.enabled,
    currentVersion: app.getVersion(),
    phase: app.isPackaged && config.update.enabled ? "idle" : "disabled",
    availableVersion: null,
    error: null,
  };
  let autoUpdater = null;
  let timer = null;

  const status = () => ({ ...state });
  // Push the current state to the renderer so it can show/clear the update hint
  // without polling. Best-effort: a dead window must never break the updater.
  const emit = () => { try { notify(status()); } catch { /* window gone */ } };

  async function check() {
    if (!state.supported || !autoUpdater) return status();
    state.phase = "checking";
    state.error = null;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.updateInfo || state.phase === "checking") state.phase = "up-to-date";
      return status();
    } catch (err) {
      state.phase = "error";
      state.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  function start() {
    if (!state.supported) return;
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    // Installation becomes eligible only after update-downloaded has produced
    // and verified a snapshot in this process.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("checking-for-update", () => { state.phase = "checking"; state.error = null; emit(); });
    autoUpdater.on("update-not-available", () => { state.phase = "up-to-date"; state.availableVersion = null; emit(); });
    autoUpdater.on("update-available", (info) => {
      state.phase = "downloading";
      state.availableVersion = info.version;
      emit();
    });
    autoUpdater.on("download-progress", () => { state.phase = "downloading"; });
    autoUpdater.on("update-downloaded", (info) => {
      state.availableVersion = info.version;
      try {
        if (config.update.backupBeforeApply) {
          dbLayer.takeBackup(db, backupDir, { key });
        }
        autoUpdater.autoInstallOnAppQuit = true;
        state.phase = "ready";
        log.info(`[update] ${info.version} downloaded; verified backup complete; will install on quit`);
      } catch (err) {
        autoUpdater.autoInstallOnAppQuit = false;
        state.phase = "blocked";
        state.error = `Update downloaded, but the safety backup failed: ${err.message}`;
        log.error(`[update] install blocked: ${state.error}`);
      }
      emit();
    });
    autoUpdater.on("error", (err) => {
      state.phase = "error";
      state.error = err instanceof Error ? err.message : String(err);
      log.error("[update]", err);
      emit();
    });
    check().catch(() => {});
    timer = setInterval(() => check().catch(() => {}), config.update.intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Install a downloaded update now and relaunch. Only valid once "ready"
   *  (which means the verified DB backup already succeeded). */
  function install() {
    if (state.phase !== "ready" || !autoUpdater) return { ok: false };
    autoUpdater.quitAndInstall();
    return { ok: true };
  }

  return { start, stop, check, status, install };
}

module.exports = { createUpdater };
