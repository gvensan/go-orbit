// menu.js - the native application menu. Every app-specific item forwards a
// command id to the renderer over the app:menu event channel; standard roles
// (edit/window/zoom) stay native so copy/paste and shortcuts behave.

const { app, Menu } = require("electron");

/**
 * @param {(id: string) => void} send forward a command id to the renderer
 * @param {{ isDev: boolean }} opts
 */
function buildAppMenu(send, { isDev }) {
  const cmd = (label, id, accelerator) => ({
    label,
    accelerator,
    click: () => send(id),
  });

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(process.platform === "darwin"
      ? [{
          label: app.name,
          submenu: [
            { role: /** @type {const} */ ("about") },
            { type: /** @type {const} */ ("separator") },
            { role: /** @type {const} */ ("hide") },
            { role: /** @type {const} */ ("hideOthers") },
            { role: /** @type {const} */ ("unhide") },
            { type: /** @type {const} */ ("separator") },
            { role: /** @type {const} */ ("quit") },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        cmd("New Contact…", "new-contact", "CmdOrCtrl+N"),
        cmd("Quick Add…", "quick-add"),
        { type: "separator" },
        cmd("Import Contacts…", "import"),
        cmd("Export Archive…", "export-archive", "CmdOrCtrl+E"),
        cmd("Export Graph as PNG…", "export-png"),
        cmd("Export Network as GraphML…", "export-graphml"),
        { type: "separator" },
        cmd("Back Up Now", "backup"),
        ...(process.platform === "darwin" ? [] : [{ type: /** @type {const} */ ("separator") }, { role: /** @type {const} */ ("quit") }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        cmd("Find…", "palette", "CmdOrCtrl+K"),
      ],
    },
    {
      label: "View",
      submenu: [
        cmd("Graph Home", "home"),
        cmd("Full Network", "full-network"),
        cmd("List", "list", "CmdOrCtrl+L"),
        cmd("Insights", "insights"),
        cmd("Review Duplicates", "dedup"),
        cmd("Trash", "trash"),
        { type: "separator" },
        cmd("Settings…", "settings", "CmdOrCtrl+,"),
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(isDev
          ? [{ type: /** @type {const} */ ("separator") }, { role: /** @type {const} */ ("reload") }, { role: /** @type {const} */ ("toggleDevTools") }]
          : []),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin" ? [{ role: /** @type {const} */ ("front") }] : [{ role: /** @type {const} */ ("close") }]),
      ],
    },
    {
      label: "Help",
      submenu: [cmd("Keyboard Shortcuts", "shortcuts")],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildAppMenu };
