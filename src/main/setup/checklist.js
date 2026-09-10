// checklist.js - the Setup checklist (Settings > Setup), modelled on the sibling
// golinks project: a handful of one-time steps, each either checked by the
// service itself or marked done by the user, with the exact action to take.
//
// Host-independent: the HTTP host supplies what only it knows (version, port,
// whether launchd started us, which credential store holds the key); the
// database supplies the rest (owner set, contacts present, backups taken, the
// online-maps preference, and the user's manual marks in app_meta).

const config = require("../config");
const meta = require("../db/meta");

const MARKS_KEY = "setup.done";

/** Every step id, in display order. The registry validates `setup:mark` against it. */
const STEP_IDS = ["service", "session", "owner", "contacts", "bookmarklet", "backup", "login", "online", "migrate"];
/** Steps a user marks by hand; the rest check themselves. */
const MANUAL_STEPS = new Set(["bookmarklet", "online", "migrate"]);
/** Until these are done the checklist stays in the sidebar. */
const REQUIRED_STEPS = new Set(["service", "session", "owner", "contacts"]);

/** @returns {Record<string, boolean>} */
function readMarks(db) {
  try {
    const raw = meta.get(db, MARKS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record a manual mark. Auto-checked steps cannot be marked: their state is
 * the truth the service observes, so a stale mark could never mislead.
 * @param {any} db @param {{ id: string, done: boolean }} p
 */
function markStep(db, { id, done }) {
  if (!MANUAL_STEPS.has(id)) return { ok: false };
  const marks = readMarks(db);
  if (done) marks[id] = true;
  else delete marks[id];
  meta.set(db, MARKS_KEY, JSON.stringify(marks));
  return { ok: true };
}

/**
 * @param {any} db
 * @param {{ version: string, port: number, url: string, home: string, backupDir: string,
 *           launchd: boolean, agentInstalled: boolean, keyBackend: string, bookmarklet: string,
 *           backupCount: number, lastBackupAt: number | null }} info
 * @returns {import('../../shared/types').SetupStatus}
 */
function buildSetupStatus(db, info) {
  const marks = readMarks(db);
  const ownerId = meta.getOwnerContactId(db);
  const counts = /** @type {{ live: number }} */ (db.prepare(
    "SELECT COUNT(*) AS live FROM contacts WHERE deleted_at IS NULL"
  ).get());
  const sample = meta.get(db, "sample.dataset");
  const onlineRaw = meta.get(db, "location.online");
  const online = onlineRaw == null ? config.location.onlineDefault : onlineRaw === "1";
  const ownContacts = counts.live > 0 && !sample;

  /** @type {import('../../shared/types').SetupStep[]} */
  const steps = [
    {
      id: "service",
      title: "Orbit is running",
      required: true,
      manual: false,
      done: true,
      detail: info.launchd
        ? `Version ${info.version} answers on port ${info.port} and starts on its own every time you log in. Nothing to do here.`
        : `Version ${info.version} answers on port ${info.port}, started by hand. It stops when that terminal closes; the "Start Orbit at login" step below makes it permanent.`,
      hint: "If this page ever says Orbit is not responding, open Terminal in the Orbit folder and run bin/orbit start.",
      actions: [],
    },
    {
      id: "session",
      title: "Keep this browser signed in",
      required: true,
      manual: false,
      done: true,
      detail: `This browser holds a session with your Orbit, and it lasts ${config.server.sessionMaxAgeDays} days. Bookmark the address below so Orbit is one click away.`,
      hint: "Another browser (or a cleared one) sees a locked page until you run bin/orbit open, which prints a one-time link that signs it in.",
      actions: [{ kind: "copy", label: "Copy address", value: info.url }],
    },
    {
      id: "owner",
      title: "Tell Orbit who you are",
      required: true,
      manual: false,
      done: ownerId != null,
      detail: ownerId != null
        ? "Your own card is set. The graph is drawn with you at the centre, and every ring, hop, and wedge counts out from it."
        : "Orbit draws your network with you at the centre, so it needs to know which card is yours. Two fields are enough; the rest is optional.",
      hint: "You can change this any time under Settings > You.",
      actions: ownerId != null ? [] : [{ kind: "tab", label: "Set up your card", value: "you" }],
    },
    {
      id: "contacts",
      title: "Add your people",
      required: true,
      manual: false,
      done: ownContacts,
      detail: ownContacts
        ? `${counts.live.toLocaleString()} contact${counts.live === 1 ? "" : "s"} in your network.`
        : sample
          ? "You are exploring the sample network. When you are ready, clear it (Settings > Data & Backups) and import your own contacts."
          : "Import a vCard or CSV export from your phone or address book, or add people one at a time from the search palette.",
      hint: "Imports are reviewed row by row before anything is written, and a backup is taken first.",
      actions: ownContacts ? [] : [{ kind: "import", label: "Import contacts…", value: "" }, { kind: "palette", label: "Add one by hand", value: "" }],
    },
    {
      id: "bookmarklet",
      title: "Add people from any web page",
      required: false,
      manual: true,
      done: Boolean(marks.bookmarklet),
      detail: "The Add to Orbit button is a bookmark. On a LinkedIn profile, a company page, or anywhere someone is named, click it and Orbit opens in a tab with that person drafted (name, role, company, link, anything you selected as notes), lets you pick who they connect to (you, or anyone already in Orbit, by name) and how, and adds them with their card open. Drag the button to your bookmarks bar once.",
      hint: "Show the bookmarks bar with Cmd+Shift+B (Ctrl+Shift+B on Windows). If dragging does not work, use Copy code, add a bookmark by hand and paste the code as its address. Select some text on the page first and it lands in the notes.",
      actions: [{ kind: "bookmarklet", label: "Add to Orbit", value: info.bookmarklet }],
    },
    {
      id: "backup",
      title: "Know where your data lives",
      required: false,
      manual: false,
      done: info.backupCount > 0,
      detail: `Everything is one encrypted file in ${info.home}. Orbit snapshots it every ${Math.round(config.backup.intervalMs / 60000)} minutes when something changed, before every import, and on every stop, keeping the last ${config.backup.keep} in ${info.backupDir}.` +
        (info.backupCount > 0 ? ` ${info.backupCount} snapshot${info.backupCount === 1 ? "" : "s"} so far.` : " No snapshot yet."),
      hint: `The database key is in the ${info.keyBackend}; the file is unreadable without it. Moving to another machine goes through an .orbit archive export, which carries its own passphrase.`,
      actions: info.backupCount > 0 ? [] : [{ kind: "backup", label: "Back up now", value: "" }],
    },
    {
      id: "login",
      title: "Start Orbit at login",
      required: false,
      manual: false,
      done: info.launchd || info.agentInstalled,
      detail: info.launchd || info.agentInstalled
        ? "The login agent is installed: Orbit comes up with your Mac and stays in the background."
        : "Register Orbit as a login agent so it is always there, with no terminal open. In the Orbit folder run the command below, once.",
      hint: "bin/orbit status shows the agent; bin/orbit stop takes it down until you start it again.",
      actions: info.launchd || info.agentInstalled ? [] : [{ kind: "copy", label: "Copy command", value: "bin/orbit install" }],
    },
    {
      id: "online",
      title: "Decide about online maps and location search",
      required: false,
      manual: true,
      done: Boolean(marks.online),
      detail: online
        ? "Currently ON: the Geomap fetches detailed map tiles and the location field looks up places online. Only the map area you view and the text you type leave this machine, to OpenStreetMap-based services."
        : "Currently OFF: the Geomap uses the bundled world map and locations resolve against the built-in city list only. Nothing leaves this machine.",
      hint: "This is the only network traffic Orbit ever makes. Either choice is fine; mark the step done once you have decided.",
      actions: [{ kind: "tab", label: "Open Privacy & Security", value: "privacy" }],
    },
    {
      id: "migrate",
      title: "Bring data from the desktop Orbit",
      required: false,
      manual: true,
      done: Boolean(marks.migrate),
      detail: "If you used the Electron version of Orbit, export an .orbit archive there (File > Export Archive) and import it here. The archive carries contacts, connections, tags, and history; its passphrase is yours, not the machine's.",
      hint: "Skip and mark done if you are starting fresh.",
      actions: [{ kind: "import", label: "Import an archive…", value: "" }],
    },
  ];

  const required = steps.filter((s) => s.required);
  const requiredDone = required.filter((s) => s.done).length;
  return {
    steps,
    requiredDone,
    requiredTotal: required.length,
    remaining: steps.filter((s) => !s.done).length,
    complete: requiredDone === required.length,
  };
}

module.exports = { buildSetupStatus, markStep, STEP_IDS, MANUAL_STEPS, REQUIRED_STEPS, MARKS_KEY };
