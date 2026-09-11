# Decisions Log

Deliberate amendments to the original scaffold assumptions, per the CLAUDE.md
rule that assumptions change deliberately, not by drift. Newest first.

## Future TODO

- [ ] **Support touch and pen when dragging individual graph nodes.** The
  current custom node-drag lifecycle in `graph-view.js` listens to Sigma's
  mouse captor. General touch camera pan/zoom, Geomap dragging, and minimap
  dragging already work, but manually repositioning a node is not reliable on
  Windows touchscreens or with a stylus. Extend the same start/move/end,
  click-suppression, camera-locking, and persisted-position behavior through
  Sigma's touch captor or a unified pointer implementation. Verify mouse,
  touch, and pen input without double-selecting or moving the camera.

## 2026-09-11 - Never terminate a worker that is still loading the addon

- An intermittent whole-file failure in the suite (about one run in eight,
  always `server-app.test.js`, dead in under half a second with no error text)
  turned out to be a native abort: `FATAL ERROR: Error::New
  napi_get_last_error_info`, raised inside the search worker while it was
  still `require`-ing the SQLite addon. The main thread had called
  `worker.terminate()` first. A native module torn down mid-initialization
  cannot raise a JavaScript error, so N-API kills the process instead.
- This was a production bug wearing a test flake's clothes. The same race
  existed whenever the service was stopped or a restore ran within about half
  a second of boot, and an abort exits non-zero, which launchd reads as a crash
  and restarts the service the owner had just stopped.
- **The rule now: a worker is never killed before it is ready, and is asked to
  close before it is forced.** The search worker posts `{ ready: true }` once
  the addon is loaded and its connection open, and closes its connection and
  exits itself on `{ close: true }`. `SearchService.terminate()` waits for
  ready (bounded by `config.search.workerReadyTimeoutMs`), asks, waits for the
  exit (bounded by `workerCloseTimeoutMs`), and only then falls back to
  `terminate()`. Queries in flight resolve empty under their own requestId,
  the same quiet discard a superseded query gets. `runtime.teardown()` returns
  a promise that settles when the worker has exited, and the host awaits it
  before `process.exit`, so a stop is an exit 0 every time. The betweenness
  worker was already safe: it is only terminated after it has posted its
  result.
- Pinned by two tests: terminate immediately after construction must resolve
  with exit code 0, and a query in flight during terminate must resolve empty.

## 2026-09-11 - macOS is the platform; Windows leaves the CI matrix

- The Electron build listed macOS, Windows and Linux, and the service inherited
  a three-OS CI matrix. The first time that matrix actually ran (the repository
  had been private and Actions blocked), macOS and Ubuntu passed in under a
  minute and Windows hung in `npm test` for twenty minutes with no output.
  Rather than chase a platform nobody asked for, the owner's call: Orbit is a
  macOS app, like golinks. Everything user-facing already was (installer,
  launchd agent, keychain); only the matrix pretended otherwise.
- CI now runs on macOS and Ubuntu. Ubuntu stays because it is cheap, fast and
  catches "works only on my Mac" mistakes in the core (paths, permissions,
  the native prebuild on a second OS). The Windows key-store branch in
  `keys.js` is kept as written and unit-tested against a fake shell, but is
  documented as untried; the docs no longer suggest running on Windows.
- The diagnostic flags added while chasing the hang (job `timeout-minutes`,
  per-test `--test-timeout`, the spec reporter) stay: a hang anywhere should
  fail the job and name the test, not hold a runner.

## 2026-09-11 - The data home moves with `bin/orbit move`, and the CLI reads the installed one

- `ORBIT_HOME` was honoured by the service and baked into the launchd plist,
  but the CLI defaulted to `~/.orbit` unless the variable was exported again,
  so after a custom install `bin/orbit open` looked for the session token in
  the wrong folder. The CLI now reads the home and port from the installed
  plist when the shell does not set them; an explicit variable still wins.
- Moving the folder by hand can never work: keys.js derives the keychain
  account from the home's path (deliberately, so a scratch home's key can be
  deleted without touching the real one), so a copied folder meets a fresh key
  and fails closed. `bin/orbit move <dir>` is the supported route: stop the
  service, copy the database and every snapshot, re-key each copy to the new
  path's key with SQLCipher's `PRAGMA rekey` (verified before and after),
  carry the session token so browsers stay signed in, re-register the agent
  on the new folder. The old folder and its key are left untouched for the
  owner to delete; nothing in the move is destructive, and every refusal
  (service running, target not empty, source does not open) happens before
  anything is written. `src/server/move-home.js`, covered by
  `test/server-move-home.test.js`.
- Rejected: binding the key to the account rather than the path, which would
  make a bare folder move work. It would also make the demo instance's
  `stop.sh`, and any future scratch home, share and possibly delete the real
  key. A path-bound key plus an explicit move is the safer trade.

## 2026-09-11 - The repository is public, and named go-orbit

- Created as the private `my-orbit`, the repository is now public at
  `github.com/gvensan/go-orbit`, matching the sibling golinks project. The
  immediate trigger was GitHub Actions: private repositories draw on paid
  minutes and the account's billing block refused every job before it started,
  so no push had ever been proven on Windows or Linux. Public repositories run
  Actions free.
- **Why this is safe.** Orbit's security posture never rested on the code being
  secret: the database, its key, the session token and every backup live in
  `~/.orbit`, outside the repository and ignored by git, and the demo recording
  shows the built-in sample network, not real people. Making the code public
  changes nothing about what protects the data (SECURITY_AND_THREAT_MODEL.md).
- The rename is cosmetic. GitHub redirects the old name; every install, update
  and README reference was moved to the new one in the same push. The
  directory on the owner's machine (`gitmine/orbit`) and the npm package name
  (`orbit`) are unchanged: the product is Orbit, the repository is where it lives.

## 2026-09-11 - Dependency bumps: SQLCipher addon 13, supercluster 9, Vite 8.2

- `better-sqlite3-multiple-ciphers` 12.11.1 -> 13.0.3 (better-sqlite3 13.0.3,
  SQLite 3.53.4, SQLite3MultipleCiphers 2.4.0). Prebuilt binaries now start at
  Node 22, which the Node 24 floor already satisfies; `verify:native` passes,
  the suite passes, and the owner's existing database (written by 12.x) opens
  and passes quick_check under 13.x with no migration. `supercluster` 8 -> 9
  is ESM-only and ships its own types, so `@types/supercluster` is dropped; it
  is bundled by Vite and never required by Node, so the module format change
  costs nothing. `vite` 8.1.5 -> 8.2.2 routine. All three came from
  Dependabot; taken together after the full local suite because CI is blocked
  on the account's Actions billing.

## 2026-09-11 - Shortcuts move under Settings and become rebindable

- The sidebar's Shortcuts entry opened a modal that duplicated a list nobody
  could change. It is now a Settings tab, and `?`, the palette command and the
  sidebar's Settings all lead there. One table, `src/shared/keymap.js`, holds
  every rebindable command with its default (and, where the browser reserves
  the primary, a fallback every browser leaves alone); the app's keyboard
  handler and every hint or title that names a key read from it, so an edit
  shows up everywhere at once.
- **Why rebinding, and why no separate on/off.** Orbit lives in a browser tab
  and browsers already own several Cmd/Ctrl combos; which fallbacks are free
  varies by browser, extension set and layout, so a fixed table will collide
  with someone. A separate enable toggle adds little: an unused key costs
  nothing, and clearing a binding is the same as disabling it. Mouse gestures
  and list keys are not shortcuts in this sense and stay fixed.
- **Rules.** Click a key, press the new one; Backspace while recording clears
  it; Esc keeps the old one. A combo another command holds is refused by name.
  A combo the browser reserves is accepted with a warning at the moment of
  choosing, because a rebound Cmd+key still cannot beat the browser. Per-row
  and whole-table reset. Overrides are per device in localStorage
  (`orbit-keymap`), like the theme and palette: a key is about this keyboard,
  not about the data. A damaged store can only fall back to a default.
- The browser-safe alternates that the bridge used to hard-code (Control+key
  on macOS, Alt+key elsewhere) are now second bindings in the table, so they
  are visible and editable too.

## 2026-09-10 - Add to Orbit: a bookmarklet, in the golinks shape

- Golinks' "Add to Golinks" is a bookmarks-bar button that saves the page you
  are on. Orbit's equivalent adds the person the page is about: click it on a
  LinkedIn profile, a company page, or anything that names someone, and Orbit
  itself opens in a tab on a `#add=<query>` deep link with
  that person drafted: name, role, company, LinkedIn or website link, any
  selected text as notes. The app then runs its own add-connection flow in its
  own modal: a "Connect to" search over everyone in the graph (the palette's
  search worker, you preselected), the same coloured tie rows as the card's
  "Add connection" menu headed "New connection to <them>", plus "Just add, no
  connection"; a match
  against people you already have (the read-only `import:match`, floor
  `config.bookmarklet.matchMin`) offers to open them instead. Choosing a tie
  reuses `addConnectionTo` with the draft, so the card opens named and filled
  in, every field editable with the card's real controls.
- **A first cut as a separate popup page was built and thrown out the same
  day.** A bespoke `/add` form was a lesser copy of the card (its own inputs,
  its own styling, no tie picker with the palette colours) when the real app
  runs one navigation away. The rule this leaves behind: the bookmarklet drives
  the app; it never gets a UI of its own.
- **The page address is not kept** (the owner's call). A bookmark tool records
  where you were; Orbit records people, and the URL of a search page or an
  article is not a fact about the person. A LinkedIn profile link is, and it
  stays in the `linkedin` field. A short selection (a name) is the draft's
  name; a long one is notes.
- **What the bookmarklet carries.** The page's address, title, Open Graph
  title/description/site name, and up to `config.bookmarklet.selectionMax`
  characters of selected text, in the URL hash, which never reaches the
  service. Parsing (a LinkedIn "Name - Role - Company | LinkedIn" title into
  three fields) lives in `src/shared/page-guess.js`, unit-tested, and its
  result is shown before anything is written. The bookmarklet carries the
  port and nothing else; `src/server/bookmarklet.js` builds it.
- **A tab, not a popup** (the owner's call, and right): the app needs its full
  width for the rail, the canvas and the card panel, and the browser places and
  focuses a tab better than a sized window. The app names its window
  (`config.bookmarklet.windowName`) and the bookmarklet targets that name, so a
  tab it opened earlier is reused where the browser allows and the app handles
  the `hashchange`; browsers only honour a name across tabs that share an
  opener, so a tab the user opened by hand gets a sibling rather than being
  taken over. That limit is the browser's, not ours.
- **Cookie relaxed from Strict to Lax.** The tab is a top-level GET to our
  origin initiated from another site; Strict withholds the cookie on exactly
  that, so it would have shown the locked page. Lax still withholds the cookie
  on cross-site POSTs and subresources, and every write is a POST behind the
  Origin and `Sec-Fetch-Site` guards, so the CSRF posture is unchanged.
- `profile:get` now includes `contactId` (harmless, and useful to any future
  client that must find the owner without loading the graph).
- The Setup checklist gained an "Add people from any web page" step (manual)
  that renders the draggable button and a Copy code fallback, as golinks does.

## 2026-09-10 - Settings > Setup: a checklist in the golinks shape

- Golinks greets a new install with a setup checklist: a few one-time steps,
  each self-checking where the service can see the answer and "Mark done"
  where only the user knows, a live re-check, the exact value to copy, and a
  sidebar entry that disappears once the required steps are done while the page
  stays under Settings. Orbit now has the same, as the first Settings tab.
- **Steps.** Required: Orbit is running (auto; says whether launchd started it),
  keep this browser signed in (auto; copy the address, explains `bin/orbit open`
  for other browsers), tell Orbit who you are (auto; owner set), add your people
  (auto; own contacts present, a loaded sample deliberately does not count).
  Optional: know where your data lives (auto; first backup taken; names the
  home, the cadence, the key store), start Orbit at login (auto; launchd parent
  or the agent plist present; copy `bin/orbit install`), decide about online
  maps and location search (manual; shows the current preference), bring data
  from the desktop Orbit (manual; the .orbit archive path).
- **Where the truth lives.** `src/main/setup/checklist.js` builds the steps
  from the database and a small `setupInfo()` the host supplies (version, port,
  launchd, plist, key backend). Auto steps cannot be marked: a stale mark could
  only mislead. Manual marks are one JSON value in `app_meta` (`setup.done`),
  so they travel with the database and survive a reinstall of the code.
  Channels `setup:status` and `setup:mark`; the sidebar item and badge come from
  `refreshSetupNav()` in app.js on boot, on every data change, and when a mark
  changes; a first visit to Settings lands on Setup while a required step is
  open, later visits on the remembered tab.
- **Rejected.** Opening the checklist on its own on first launch: Orbit already
  has a landing screen for an empty database (choose a sample or start your
  own), and two competing first screens would be worse than one. The sidebar
  badge with the count of open required steps does the nudging instead.

## 2026-09-10 - Orbit is a local web service, not an Electron app

- **What changed.** The Electron host (`main.js`, `preload.js`, `menu.js`,
  `updater.js`, `keys.js`, electron-builder, the ABI shim) is gone. A Node HTTP
  service in `src/server/` binds `127.0.0.1:7779` (`config.server`), serves the
  Vite bundle from `dist/renderer`, and exposes every registry channel as
  `POST /api/rpc/<channel>`. `src/renderer/web-api.js` builds the same
  `window.api` the preload used to, from one shared table
  (`src/shared/api-map.js`). The shape is the same as the sibling golinks
  project: a login agent under launchd, plain Node, a browser tab as the UI,
  data in a folder the user owns (`~/.orbit`, `ORBIT_HOME`).
- **Why.** The desktop build's value was all in the engine and the renderer, and
  both were already host-independent: the data layer ran under plain Node in
  tests, and the renderer touched Electron only through `window.api`. What the
  Electron wrapper bought - a window, native dialogs, a native menu, a signed
  installer, auto-update - cost a native rebuild per Electron release, a
  code-signing pipeline, and an ABI shim around every script. A local service
  keeps everything that made Orbit Orbit (SQLCipher, workers, backups, FTS5)
  and drops the wrapper.
- **What did not change.** `src/main/` is unchanged in structure and is now the
  service core; the name is kept because renaming it would touch every test
  and doc for no behavioural gain. Registry, validation, error codes, schema,
  migrations, backups, workers, the search engine, dedup, health: untouched.
  The renderer is untouched apart from `boot.js` importing the bridge, one
  shortcuts row, the CSP meta, and a favicon.
- **The 23 channels that touched the host, and where each went.**
  - `dialog:openFile` / `dialog:saveFile` never reach the service. The bridge
    opens a browser file picker and POSTs the file to `/api/files/upload`,
    which writes it into a granted slot under `<home>/uploads/` and returns the
    path; the import channels then read it exactly as before (`requireGranted`
    still gates them, the grant now being "the service minted this path").
    `saveFile` asks `/api/files/export-slot` for a granted path under
    `<home>/exports/`; when the export channel resolves, the bridge triggers
    `GET /api/files/download?path=` and the slot is deleted as the bytes
    finish. The user sees the file in their Downloads; the toast names the
    file, not a server path.
  - `backup:restore*` restore exactly as before, then the process exits with
    `config.server.restartExitCode` (non-zero, so launchd's KeepAlive on failure
    brings up a fresh process; exit 0 means "stay down"). The bridge waits on
    `/api/health` for a new `startedAt` and reloads.
  - `update:*` keeps its phases so the top-bar pill works unchanged, but
    "ready" now means newer code is on disk than the process loaded
    (`bin/orbit update`, or an edit in dev). `install` takes the same verified
    backup the desktop updater did, then restarts.
  - `map:tile` and `location:search` stay server-side proxies. The browser CSP
    is `connect-src 'self'` (was `'none'`): the page reaches its own service and
    nothing else. The CSP is now also sent as a header.
  - `app:menu` has no native menu behind it. Everything the menu did is on the
    sidebar and in the palette; the bridge adds Control+N/L/I/, on macOS and
    Alt+N/L/I/, elsewhere for the accelerators browsers reserve (Cmd+N new
    window, Cmd+L address bar, Cmd+, preferences). The renderer's own Cmd+K/E/F
    still work.
- **The key.** `safeStorage` has no plain-Node equivalent, so
  `src/server/keys.js` uses the OS credential tool: `security` on macOS with
  commands over stdin (the key never appears in `ps`), `secret-tool` on Linux,
  PowerShell DPAPI on Windows (wrapped blob in `<home>/dbkey.bin`, mirroring the
  desktop layout). No store reachable means no start; there is deliberately no
  environment-variable or file fallback. The keychain account is derived from
  the data home so two homes never share a key. Consequence: the desktop app's
  database cannot be opened by the service (its key is bound to the Electron
  app); migrate with an `.orbit` archive.
- **Loopback is not a boundary.** Golinks trusts `127.0.0.1` plus a Host check;
  Orbit holds a person's whole social graph and the threat model puts "another
  user on the same machine" in scope, so the service adds a session: a random
  token in `<home>/session-token` (0600), delivered once through the launch URL
  (`bin/orbit open`) and exchanged for an `HttpOnly; SameSite=Strict` cookie.
  Every request except `/api/health` needs it; a browser without one sees a
  locked page that says how to get in and nothing else. Host, Origin and
  `Sec-Fetch-Site` checks run before routing. The desktop build's
  `contextIsolation`/`sandbox` model has no analogue and is retired from
  `config.security`.
- **Rejected.** (1) A JSON-file store like golinks: the FTS5 index and SQLCipher
  are the product. (2) Zero dependencies: the encrypted SQLite addon has to come
  along; it ships prebuilt for Node 20 through 26, so nothing compiles on
  install and the dependency list is otherwise unchanged. (3) Relaxing the CSP
  to fetch tiles directly from CARTO: the proxy keeps the "browser talks only to
  its own service" property and the on-disk tile cache. (4) A second in-page
  menubar: the palette already lists every command. (5) Keeping the Electron
  host alongside as a second target: no one asked for it and every guardrail
  would need two proofs.
- **Review pass, same day.** An independent review of the port found three
  defects that the tests now pin: (1) a restore whose file swap failed after the
  database was closed left a live process answering 503 forever; the swap now
  rolls back to the safety snapshot and the restart is requested in every case,
  since only a fresh process can serve after a close. (2) The wizard's "Save and
  reload" reopened a results file that its own download had just deleted;
  downloads take `keep=1` for that channel and the slot lives on the upload TTL.
  (3) An oversized upload destroyed the socket before the 413 left, so the
  browser reported "service not responding"; the body is paused instead, the
  413 carries `connection: close`, and the bridge also checks the file size
  before uploading. Smaller changes from the same pass: slots are refreshed on
  every channel read so a long review never expires under the user; the session
  cookie has a `Max-Age`; boot failures exit 0 so launchd does not crash-loop
  every five seconds (doctor and `bin/orbit status` explain a down service);
  `bin/orbit restart` sends SIGTERM and waits instead of `kickstart -k`
  (SIGKILL); the UI bundle is no longer treated as "code" for the restart pill
  (the page reloads onto a new bundle by itself, and waits while `vite build`
  has emptied `dist`); a restart drains in-flight requests first; the bridge
  marks its own conditions (offline, restarting, too large, session gone) so
  the toast shows their message instead of the generic code text.
- **Ops.** `bin/orbit install|start|stop|restart|status|open|doctor|update|logs|run`
  mirrors golinks; `launchd/dev.orbit.plist.tmpl` is rendered by `install`. The
  doctor answers "why isn't Orbit working" with a fix per finding, both at
  `/api/doctor` and in the terminal. Tests run under plain `node --test`; the
  contract test compares registry, `api-map.js` and `types.d.ts`; a new
  `test/server-app.test.js` drives the real HTTP host on an ephemeral port.

## 2026-08-06 - A contact is never left sitting on a line

- The owner zoomed in on contacts that looked crammed, and correctly guessed the
  cause was not contact-against-contact: it was a contact drawn ON a line. The
  spacing checks had only ever compared node to node, so this went unmeasured.
  On the owner's own graph, framed: **2 contacts drawn on an unrelated line and
  12 more grazing one within 6px** - including their own partner, sitting 13px
  inside a spoke leaving the owner.
- Two surgical passes at the end of `balloonLayout`, neither of which touches the
  rings, the lanes or the wedge order:
  - **A seat slides along its own ring** until it is clear of any line it has
    nothing to do with, never further than half the free space to its neighbours
    on that ring. A contact moves a few degrees at most.
  - **A couple turns as one** about its own middle, up to ~25 degrees, when
    either partner is on a line. Rigid, so the pair stays adjacent and keeps its
    heart. Couples are split AFTER the seat pass, which is why they need their
    own: the pass cannot see where a partner will land. Each partner is tested
    against the OTHER's lines - excusing both partners' lines is what hid the
    owner's own case.
- Result on that graph: **contacts on a line 2 -> 0**, grazing 12 -> 7, crossings
  still 0, couples still 15-32px apart. One contact-to-contact overlap remains,
  at -5px, where a wedge had to be squeezed.
- `BALLOON_LANE_STEP` 56 -> 65, which is half the ring gap. That ratio is a
  constraint, not a preference: wide enough that the two lanes of a ring clear
  each other, narrow enough that one ring's outer lane clears the next ring's
  inner lane. A relaxation pass that eased crowded seats apart within a lane was
  built, measured, and dropped - it fought the line-clearance pass and cost a
  crossing.

## 2026-08-06 - A line names its own tie; contacts of a kind sit together

- **Lines.** The relationship view briefly painted every line in its BRANCH's
  colour, so a marriage inside a friend's family was drawn friend-green. Reverted
  on the owner's call: a line always carries the colour of the tie it IS, in
  every view. The contact keeps the branch colour (`gateway`), which is what made
  a friend's family read as part of your friend's world in the first place - so
  the fill answers "how do I know this person" and the line answers "what is this
  tie", and the legend means one thing when you look at a line.
- **Grouping.** Contacts of a kind now sit together wherever a view is free to
  choose an order:
  - **Graph** groups every parent's people by the tie that connects them
    (`tieRank`), not only the root's. Partner grouping still wins where a couple
    is involved, or their lines cross.
  - **Mesh** orders the ring by what a contact mostly is (closest tie type they
    hold with anybody), then by id - blocks of one colour instead of a shuffle.
  - **Reach** walks each contact's neighbours closest-tie first, so a wedge holds
    one kind of tie rather than a mix.
  - **Clusters and Tree are deliberately untouched:** their groupings (community,
    generation) are the point of those views.
  - **Orbit is untouched too:** its wedges are communities, which is a different
    axis from its rings and is what that view is for.

## 2026-08-06 - The Graph view is one deterministic layout; the force engine is gone

- Graph now draws the radial tree and nothing else. The layout toggle, the
  ForceAtlas2 worker (`src/renderer/layout-worker.js`), the
  `graphology-layout-forceatlas2` dependency, the reshuffle control, and the
  ~250 lines of arrangement geometry that existed only to make a force layout
  presentable (`arrangeEgo`, `leafFan`, `fanExtent` and their constants) are all
  removed, along with their tests.
- **Why.** A force layout earns its keep by finding cluster structure in
  cross-links. The owner's network is a TREE - 97 contacts, 96 ties, not one
  cycle - so there is nothing for it to find, and it spent its freedom on
  arbitrary choices. Measured on that graph at fit-to-window: 24 edge crossings
  against the radial tree's 0, and 54 pairs of contacts overlapping on screen
  against 2. Several rounds of tuning moved those numbers around without fixing
  them, because the failure was not in the constants.
- **Circle packing was built and measured as the replacement, and rejected.**
  Containment is a packing's edge - d3 packings draw circles and no links - but
  this canvas draws every tie as a line, so lines sail over sibling circles: 75
  crossings. It also did not fix the crowding (31 overlapping pairs), because
  reserving the middle of each circle for the parent's own dot compounds over
  five levels and the drawing came out six times larger than a tight packing.
- **The measuring lesson, recorded because it cost a day.** A framed view sits at
  camera ratio 1: sigma draws a node at its full pixel size however far the
  camera pulled out to fit. So enlarging any gap enlarges the extent and the
  zoom-out cancels it exactly - only the RATIO of spacing to node size matters,
  and offline renders that scale node radii along with positions will flatter a
  layout badly. Measure on-screen or not at all.

## 2026-08-06 - A branch wears the colour of how you reach it; a couple keeps its gap when framed

- **Relationship view: the whole branch takes its gateway's colour.** A contact
  two hops out has no tie to YOU, so they used to fall back to their own
  commonest relationship - a friend's wife read as "family", with family-blue
  lines, inside a green friend's branch. `tagGateways()` walks out from the
  centre and records the tie type of the FIRST step; `applyRelationshipTint()`
  paints both the contact and every line inside that branch with it. On the
  owner's graph that is 22 contacts reached through friends, 58 through family,
  9 through work.
  - The legend changes meaning in this mode, deliberately: it now reads "how you
    reach this part of your network" rather than "what this one tie is". The
    other two colour modes (organization, community) are untouched, and leaving
    the relationship mode puts the lines back to naming their own tie.
- **The couple gap is a share of the partners' own size, not a fixed distance**
  (`COUPLE_SPREAD`, 2.6 x the two rims, floored at the heart's minimum). A view
  is framed to its extent and sigma keeps a node the same size on screen however
  far the camera pulls out, so a gap fixed in graph units closes up at
  fit-to-window exactly when a network gets big: on the owner's graph every
  couple was rendering at **-10px to +0.6px between rims**. Tying it to node size
  gives the biggest node in the view (you, halo and all) the widest berth, which
  is where the pinch showed.
  - Measured at fit: **12px to 26px between rims**, crossings still 0, and
    general spacing rose from 2.4 to 3.0 node-widths because the rings grew with
    the couples. The unit's radius is derived from the gap, so every layout still
    reserves the pair's real width and nothing is placed inside it.
  - A fixed point was tried first (widen, re-measure, repeat) and rejected on the
    numbers: it converges at a gap of 76 but only 5px on screen, because widening
    couples grows the extent and the zoom-out eats the gain.

## 2026-08-06 - A couple is split by what it is connected to, not by geometry

- The owner's observation, and it was the right one: crossings can be avoided by
  analysing the connections BEFORE positioning. `expandCouples` was splitting
  every pair on pure geometry (perpendicular to the line to the centre), so a
  partner could land on the far side from their own contacts, and every one of
  their lines then reached back across the other partner's.
- `partnerSides` (new, exported, shared) works out which partner each
  neighbouring unit actually knows. `expandCouples` takes it and turns each pair
  until member 0 faces member 0's own people. Balloon's inline version of this
  map is replaced by the shared one.
- On the owner's graph: force view **33 -> 24 crossings**; Balloon stays at 0
  (its child ordering already agreed with the split, which is why it was already
  clean - the same analysis, applied one step earlier).
- The remaining 24 in the force view were classified rather than guessed at: 20
  are INSIDE a single family - shapes ForceAtlas2 itself produced - and only 4
  are between branches. No placement pass can remove the 20; that needs the
  branch laid out as a tree, which is the Balloon engine. This is the force
  engine's floor, and it is worth stating rather than chasing.

## 2026-08-06 - The owner couple's ties, and why the drawing now has no crossings

- Zoomed into a family, the owner spotted lines crossing that had no reason to.
  Classifying every crossing in the real graph (rather than reading the picture)
  showed all four were one pattern: **the owner's own ties crossing their
  partner's.** The root's children were sorted by tie type, and that sort ran
  AFTER the by-partner sort and destroyed it, so the two halves of the couple
  interleaved around the circle and each had to reach across the other.
- The root's children now sort by partner FIRST, tie type within. Each partner's
  contacts form a contiguous arc, so no line reaches across. **The Balloon view
  now draws the owner's whole network with zero crossings.**
- Two things tried and rejected, both measured: filing a contact tied to BOTH
  partners between the two halves (4 -> 12 crossings; two parents with n shared
  children cannot be drawn flat here, so filing them with the first partner means
  one line reaches instead of two), and turning the drawing so the first
  partner's arc faces the way that partner is split (4 -> 12; the circular mean
  of an arc wider than half the circle points the wrong way).

## 2026-08-06 - Tooltips are drawn by the app, not by the OS

- Every control that needed hover help got a `title`, but the native bubble is
  the wrong surface: it waits roughly a second, renders in the OS font on an OS
  background (so it reads as "not part of Orbit"), wraps where it likes, and
  never appears for a keyboard user. `wizard.js` had already worked around this
  once with its own `.warn-tip` popup for row problems.
- `src/renderer/tooltip.js` installs a single delegated listener on the document
  and **hijacks `title` rather than inventing a parallel attribute**: the first
  time an element is hovered or focused, its `title` is moved to `data-tip`,
  which both suppresses the OS bubble and leaves one shared element to draw the
  text in the app's type. Consequence worth knowing: `title` is the API. Any
  control, anywhere, present or future, gets an in-app tooltip for free with no
  registration, and re-setting `title` to reflect state (pressed, disabled,
  selected) is picked up on the next hover.
- Timings live in `config.tooltip`: 120 ms to appear, dropping to 40 ms when the
  pointer has recently been shown one, so sweeping across a toolbar does not
  re-serve the full delay per button but a fast pass over the sidebar does not
  strobe either.
- Focus shows a tooltip only when `:focus-visible` matches. Showing it on every
  focus meant clicking a button dismissed the bubble on `pointerdown` and then
  immediately re-opened it under the cursor, which read as a flicker.
- Rejected: a `data-tooltip` attribute set alongside `title`. It doubles the
  authoring cost on every control forever, and any `title` someone forgets to
  mirror silently falls back to the OS bubble - the exact inconsistency this
  replaces.
- Verified against the running app over CDP rather than by inspection: tooltips
  appear on hover in all six views and all six Settings tabs, the native `title`
  is gone from the DOM once hovered, the bubble flips above a control at the
  window's bottom edge without covering it, clamps inside the window at the
  right edge, layers above the modal overlay (z-index 200 vs 15) while staying
  click-through, and zero visible interactive controls remain without help text.

## 2026-08-06 - Spacing is measured in node-widths, on the real graph

- "Clustered too close" is measurable: the median distance from a contact to its
  nearest neighbour, MINUS both painted radii, expressed in node-widths. A
  partner is excluded - a couple is meant to be adjacent, and including them just
  reports `COUPLE_GAP` back (that mistake made the first sweep look flat).
- On the owner's own graph the Balloon view measured **1.0 node-widths** median
  with a p10 of 9 units and a deepest overlap of -6. It now measures **2.4**,
  p10 45, deepest +12 (nothing overlaps at all). The force view went from **0.64**
  to **2.35**, deepest -12 to +3.
- Constants, all swept against the live graph rather than chosen:
  `BALLOON_NODE_PAD` 1.45 -> 3.0 (angular pitch), `BALLOON_LANE_STEP` 48 -> 56,
  `BALLOON_RING_GAP` 96 -> 130, `LEAF_PITCH` 1.25 -> 2.4, `LEAF_ROW_GAP` 30 ->
  60, `EGO_BRANCH_PAD` 0.12 -> 0.28, FA2 `scalingRatio` 18 -> 40.
- The lane step was NOT pushed as far as the numbers allowed (80 measured 3.1
  node-widths). Past ~56 the two lanes of a ring stop reading as one ring and
  start reading as two, which costs more than the spacing buys.
- Worth knowing for future tuning: a bigger layout is not neutral. Sigma shrinks
  nodes as the square root of the zoom-out while distances shrink linearly, so
  spreading the drawing out genuinely buys on-screen air - the figure of merit is
  gap / sqrt(extent), not gap alone.

## 2026-08-06 - Two defects only the owner's own database could show

- Every render used to sign off this work was a synthetic stand-in, and it
  flattered the result: it had 15 couples where the real network has 26. A
  headless Electron probe now reads the live database through the app's own
  keychain path, works on a **copy** (never the live file, so a running app is
  never disturbed), and takes structure, tie type and gender only - no names.
  Layout work is validated against it from here on.
- **Couples were drawn back to front on half the circle.** `expandCouples` chose
  which partner went on which side by screen x. Balloon orders a couple's
  children by the partner they belong to, so on any couple in the lower half of
  the circle the two rules disagreed and every one of that couple's lines crossed
  its sibling's. The split now always runs the way angles increase. On the real
  graph: **crossings 24 -> 4.**
- **A couple was given a whole ring lane to itself.** Safe, but it made a couple
  cost five times a single contact and put ring 1 at radius 306 where its
  occupants need 92. Couples share the lane like everyone else, with the lane
  step widened (32 -> 48, ring gap 78 -> 96) so the seat on the other lane still
  clears a partner reaching sideways. **First ring 306 -> 156, whole drawing
  halved.**
- Ring growth is bounded against the radius a ring needs to seat its contacts
  (`BALLOON_RING_MAX`): a crowded wedge could previously multiply its own ring
  and every ring outside it, pass after pass, which is what turned 97 contacts
  into a 1335-unit sprawl.
- Sigma's label grid cell (default 100) is narrower than a contact's name at
  12px, so neighbouring cells still collided. Now 140: a colliding label is
  dropped rather than overprinted, and hover still names anybody.
- Measured on the real graph, tie-type grouping is worth keeping in the FORCE
  view too (37 crossings with it, 64 without) even though that engine cannot be
  made radial: the owner's family runs five hops deep, so nine large simulated
  shapes crowd one side whatever the wedges do.

## 2026-08-06 - Balloon is the default ego layout; one wedge per relationship

- The owner compared the shipped Graph view against the rendered target and they
  did not match. Cause found: the corona seats were placed in the free sky
  BETWEEN branch spokes, walked from an arbitrary start, while the branch groups
  were allocated separately. The two allocations drift apart, so a type's dead
  ends land wherever there is room rather than under their own branches. It went
  unnoticed because the fixture used to design it was almost all dead ends; the
  real network has many direct contacts carrying a partner or a child, which
  makes them branches. **Fixtures now mirror that mix.**
- `arrangeEgo` allocates the circle ONCE: a relationship owns a wedge holding
  both its branches and its own dead ends, the latter on a ring close in, the
  former beyond it. That is the structural fix.
- **Balloon becomes the default** (`layoutMode`; the toolbar toggle switches in
  one click). The localStorage key is **versioned** (`orbit-layout-mode-2`): a
  stored "force" from when force WAS the default is not a preference, it is just
  what the app used to open with, and honouring it hid the new default entirely -
  the owner kept seeing the force view and reasonably concluded the promised
  picture had not been delivered. A choice made from here on is remembered.
- A group's wedge was allowed to be scaled below what its corona needs, which
  piled a type's dead ends into a tight bundle at the end of a bunch of parallel
  spokes (visible in the app before this fix). The corona's need is now a **hard
  floor** and branches yield instead - they have somewhere to go, since moving a
  branch outward costs nothing and buys angle (`needAt`, `EGO_LIFT_MAX` 4). The owner asked twice for the radial
  picture, and a force layout cannot produce it: each family is a shape the
  simulation found sitting at the end of its own spoke, and nine of them claim
  most of the circle however the wedges are shared. Four approaches were built
  and measured before accepting this - evening the wedges (crossings 2 -> 23,
  because a branch is a rigid body and squeezing its wedge only makes it
  overlap), capping the corona radius, ringing the branches outward by re-costing
  each branch as a body rather than an angle (`needAt`, kept, `EGO_LIFT_MAX`),
  and making branch demand a hard floor with elastic corona demand. None turns a
  force layout into a radial one, because what makes the radial picture legible
  is putting every contact on a ring by depth - exactly what the force engine
  refuses to do. Its job is the real shape of the network, and it is now clean at
  that job: grouped corona, no clutter, every heart drawn.

## 2026-08-06 - A layout is told the radius the canvas PAINTS, not the bare body

- Every gap in `graph-geometry.mjs` measured a contact as `2 x size x pad`, while
  the canvas paints `size + 4.5` for the gender ring (`size + 13` for the owner's
  halo). Every clearance in the view was therefore about 20% short of the thing
  it was meant to clear, which is what read as clutter, and the necklace sized
  itself so seats *just* touched. `graph-view.layoutSize()` now feeds both
  engines `nodeHaloRadius()`, so one honest number fixes spacing everywhere.
- Measured on a 89-contact stand-in for the owner's network, changing nothing
  else: node overlaps 21 -> 4, couple bonds with room for their heart 0/10 ->
  10/10, crossings unchanged. That single constant was worth more than the lane
  rebuild it was competing with.
- **`COUPLE_GAP` is now derived, not chosen.** It is exactly what
  `pairHeartSpots` needs to return a legible heart at the size the overlay asks
  for (`2 x PAIR_HEART_PAD + 2 x (1.35 s + 1.2)`, about 22). The hand-set 18 was
  8 short of the requirement, so the mark was shrunk below legibility or dropped
  on every couple in the view. A test asserts the heart fits at four different
  size pairings rather than trusting the constant.
- Two follow-on defects the measurement exposed, both fixed: the necklace sized
  its ring by the WIDEST seat times the count, so one couple (a contracted node
  three times as wide) inflated the whole corona and forced a second row - seats
  now each take their own width; and the branch push is a translation, so a node
  off to the side of its branch could end up nearer the hub than the trunk that
  was pushed clear and land on the necklace - the push now measures what the
  branch actually clears and repeats by the shortfall.

## 2026-08-06 - Relationship arcs: rank the branch, never the contact

- Both engines now lay the circle out in tie-type order (`TIE_RANK`: family,
  colleague, friend, acquaintance, vendor, introduced) with clear sky between
  groups, so the view reads as a chart of who these people are.
- **The ranking applies to BRANCHES and to the hub's own dead ends, never to
  contacts in general**, and that distinction is the whole design. A prototype
  that segmented every ring by tie type was built and measured: 697 crossings
  against 3 today. A contact two hops out has no tie to you at all, so ranking it
  individually tears its family across the drawing and every line reaches back
  over everything else. Ranking the branch keeps the family whole and still
  delivers the arcs. `balloonLayout` ranks only the root's children for the same
  reason.
- Ranks reach the worker as `[[id, rank]]` and are mapped onto couple units by
  the better-known partner, so a pair never straddles two groups.

## 2026-08-06 - Balloon rings are lanes, and its wedges are evened out

- A ring was a rope one contact thick. It is now a LANE `BALLOON_LANES` (2) seats
  deep: neighbours take turns on the inner and outer lane, so a ring holds twice
  the circumference and sits half as far out, which is what keeps the drawing
  compact enough to read. `BALLOON_RING_GAP` 58 -> 78 and `BALLOON_LANE_STEP` 32
  keep the lanes of adjacent rings clear of each other.
- A couple is split ACROSS its ring rather than stacked along it, so it takes its
  whole width on one lane (`lanesFor`) - reserving half, like everyone else, put
  a partner on top of the next group's contact.
- An only child takes the inner lane whatever its turn: on a thin branch that is
  the difference between a short line and one long lonely spoke to the next ring.
- Wedges at the root blend 45% equal-share with 55% subtree-weight
  (`BALLOON_EVEN`): pure weight let one large family own most of the circle and
  squash work and friends into slivers.
- The leaf-only stagger (`BALLOON_STAGGER`, `BALLOON_STAGGER_MIN`) is retired,
  since lanes now do that job for every ring rather than just fans of dead ends.
- Signature change: `balloonLayout(nodes, edges, rootId, { pairs, rankOf })`.
  Measured on the same fixture: 0 crossings, 0 overlaps, 10/10 hearts.

## 2026-08-05 - Graph view: the force pass shapes branches, an arrangement places them

- ForceAtlas2 does not know one node is the centre of an ego network. Which way
  each family points is an accident of the seed, so branches bunched on one
  side, the hub's ~35 one-off contacts fanned into whatever wedge was left, and
  their spokes crossed the families. No repulsion or gap tuning fixes an
  ARRANGEMENT problem, so the two jobs are now separate: the force pass shapes
  each branch, `arrangeEgo` decides where each one sits. It is a presentation
  transform applied to the tick output - the simulation never sees it, so it
  cannot destabilise, and every branch keeps its organic form.
- A tick is now: FA2 on the core → `arrangeEgo` → `leafFan` → `expandCouples`.
  Only the first is a simulation; the other three are pure functions in
  `graph-geometry.mjs` with unit tests.
- **arrangeEgo.** Branches are the components left when the hub is lifted out.
  Each is rotated rigidly about the hub into a slot sized by the sky it needs -
  including the sky its leaf fan will want (`fanExtent`), or neighbouring
  families get touching slots and their fans interleave. Slots share the whole
  circle, so bunched branches spread. Current cyclic order is kept and the walk
  starts from where the first branch already points, so the arrangement settles
  the layout rather than spinning it, and nothing leapfrogs between ticks.
  Branches are also drawn toward a common inner ring (clamped, so a big family
  stays further out than a small one).
- **The necklace.** The hub's own dead ends are no longer fanned. They ring the
  hub close in, seated at ONE pitch across the free sky between the spokes -
  near the hub a branch blocks only the sliver its trunk needs, so there is far
  more room here than at the rim. Spoke blocking is capped (`EGO_SPOKE_MAX`) so
  a view with many branches degrades to a spoke passing behind a contact rather
  than a necklace flung outward. One clean ring is strongly preferred; a second
  and third row only when a single ring would be absurd - a multi-row corona was
  built and rejected on sight, it reads as debris.
- Measured on a 97-node stand-in for the owner's own network (rendered offline
  through the real pipeline): edge crossings 65 → 5, node overlaps 9 → 3,
  angular imbalance 0.38 → 0.34. An earlier cut that let pendants compete with
  branches for angle at the RIM measured 142 crossings - worse than shipping
  nothing - which is why the necklace is placed inside the branch ring.

## 2026-08-05 - Switching Balloon → Graph re-seeds the force layout

- `setLayoutMode("force")` re-ran the layout without rebuilding the view, so FA2
  continued from the BALLOON coordinates. LinLog with `adjustSizes` cannot
  escape a structure that strong in 420 iterations, and the result was a
  half-melted radial layout smeared along a diagonal. `runEgoLayout` now
  re-seeds onto the deterministic ring `buildView` lays down whenever the last
  engine was not the force one (`layoutSeed`: ring | force | balloon).

## 2026-08-05 - Graph spacing: leaf fans take rows, balloon rings are derived

- **Force view.** A parent's degree-1 contacts rode ONE ring whose radius grows
  as (total leaf width / arc), so a hub with 35 one-offs threw them far out on
  long spokes and still left them shoulder to shoulder. The fan now deals its
  leaves round-robin into up to three concentric **rows**
  (`leafFan` in `graph-geometry.mjs`, moved out of the worker so the placement
  rule is unit-tested): neighbours sit at different radii, each row's angular
  pitch multiplies, and the fan stays near its parent. The fan may also open to
  a full π now (was 0.9π). FA2 itself gets more air - `scalingRatio` 12 → 18,
  `gravity` 1.2 → 0.9 - because nodes render at a near-constant on-screen size,
  so a core packed at the old ratio collided its labels once the camera framed
  the whole network.
- **Balloon view.** Ring radius was `max(previous + gap, worst single wedge)`
  **capped** at `previous + 3 gaps`; with a 40-child hub the cap bound and the
  inner ring simply overlapped. Radius is now derived: a ring must seat everyone
  standing on it (its circumference holds every footprint), and a crowded wedge
  widens its own ring and everything outside it - never the rings inside, which
  is what hollowed the middle when growth was applied globally (measured on a
  46-branch ego graph: ring 1 at 341 with global growth vs 228 targeted, extent
  1286 → 503).
- Wedges are no longer pure weight shares. Each child is guaranteed the arc its
  **whole subtree** needs (`reserve`), then the leftover is split by subtree
  weight. Reserving only a node's own body left a long chain in a sliver that no
  radius could seat and ran the outer rings away (1228 on the same fixture);
  reserving the subtree keeps the fractal reading and a lone contact beside a
  twenty-person family still gets a readable slice.
- `BALLOON_RING_GAP` 52 → 58, `BALLOON_NODE_PAD` 1.3 → 1.45, and a fan of five
  or more dead ends now alternates half a ring-gap outward (`BALLOON_STAGGER`)
  so their labels have room without pushing the ring - and its branches - out.

## 2026-08-05 - Couples are one layout unit in Graph, not two nodes with a bond

- `drawCoupleBonds` marked the partner tie and trusted the force layout to pull
  the pair together. One extra spring loses to each partner's own subtree, so
  couples routinely settled on opposite sides and the bond line crossed the
  whole web. Tree mode never had this problem because `layoutTree` places
  couples as **units**; the force and balloon layouts now use the same rule.
- New pure helpers in `graph-geometry.mjs`: `coupleUnits` (a **matching** -
  each person joins at most one unit, deterministic by id), `contractCouples`
  (couple folded into one node carrying both partners' edges and a radius that
  covers the pair; the bond itself becomes an internal edge and drops out) and
  `expandCouples` (splits the unit back into two people **perpendicular to the
  direction from the graph centre**, so partners share a distance from the hub
  and their branches fan outward beside each other rather than one reaching
  around the other). `COUPLE_GAP` is the clear space between their rims.
- `layout-worker.js` contracts on receipt and expands on every tick, so FA2
  cannot separate a couple by construction rather than by tuning. Leaf
  placement now runs over units, so a spouse-pair hanging off one person is
  fanned as a single leaf and stays adjacent. `balloonLayout` takes an optional
  `pairs` argument, contracts for the BFS/wedge math (the wedge is sized for
  the wider unit) and splits along the ring, which is exactly "side by side" at
  a fixed depth; centring on one half of a couple centres the unit.
- `graph-view.viewPairs()` reads the `pair` edge flag that `drawCoupleBonds`
  already sets and orders each pair man-left, matching Tree.
- Known limit, accepted: a remarriage or an A-B-C co-parent chain gives someone
  two bonds and the matching can only honour one. The second bond still draws
  and can still travel across the view.

## 2026-08-04 - Preset pruning: Dusk, Jewel Pop, Retro Heat, Terracotta Sage retired

- Per user choice the preset list shrinks to Ember Coast and Crayon Box (plus
  named user palettes and Custom). Dusk was also the DEFAULT and the fallback
  everywhere (shipped literals, custom/user slot fallbacks, unknown-id
  resolution, the custom reset target), so **Ember Coast is the new default**:
  the `EDGE_COLORS` literals now carry its values, every fallback resolves
  through `DEFAULT_PALETTE_ID`, and reset/save-as flows say "defaults" rather
  than naming a preset. Saved choices pointing at a retired id self-heal to
  the default on next launch. The palette test's stricter default-only
  contrast floor (3.0/3.0) is retired with Dusk - Ember Coast trades a little
  night/day headroom for warmth (floors 2.4 night / 1.4 day now apply
  uniformly); the ring-fuse rule still binds every preset.
- Named palettes gained **Rename** (id stays stable, so the active pointer is
  unaffected); `promptModal` accepts an initial `value` to seed such flows.
  "Making a palette the default" for a user is simply applying it - the
  applied choice persists across restarts.
- **Superseded same day: "Rainbow" is the coded default.** The owner's own
  scheme (extracted from the app's local storage by request) is baked into
  `shared/palettes.js` as preset `rainbow` with `curated: false`, and
  `DEFAULT_PALETTE_ID` points at it; the `EDGE_COLORS`/`GENDER_COLORS`
  literals carry its values (it recolors the gender rings too, which curated
  presets never do). It knowingly bends the guardrails - acquaintance sits
  17° off its Female ring at 1.6:1, family 17° off its Male ring at 1.9:1,
  and the two neons fall under the day-canvas floor - so the fuse/floor test
  gates now bind only `curated` presets, with the exemption explicit in both
  test files rather than the rules being quietly weakened.
- **Amended: the preset is named "Signature"** (id `signature`; the old
  `rainbow` pointer self-heals to the default). And the Custom editor gained
  its own baseline, `CUSTOM_DEFAULTS`: a TRUE rainbow in spectrum order
  (red/orange/yellow/green/blue/violet across the six slots) with the classic
  neon rings. Unset custom slots, malformed saved values, and "Reset custom
  to rainbow" all resolve there instead of to the default preset, and the
  first-open-seeds-from-applied behavior is gone - Custom now always starts
  from its rainbow baseline.

## 2026-08-03 - Named user palettes

- The Custom editor gains "Save as new palette…": the current scheme is
  snapshotted under a user-chosen name, joins the palette list (between the
  presets and Custom) with Apply / "Edit a copy" (loads it back into Custom) /
  Delete (confirmed; the default takes over if it was active), and Custom then
  resets to its Dusk baseline so it stays a clean scratchpad. Stored in
  localStorage (`orbit-palette-user`, capped at 20, slug ids kept unique
  against every source, malformed slots falling back to Dusk like the custom
  palette). `activePaletteId`/`paletteColors` resolve user ids, so a named
  palette survives restarts as the active choice. The Appearance section was
  refactored to a rebuild-everything renderer since rows now come and go.

## 2026-08-03 - Explore: rich edits move to a popup; per-row pencil needs no mode

- In-cell editors for the rich controls kept fighting the grid (virtualized
  rows, sticky columns, cell clipping, focus-leave semantics) and the
  edit-mode gate itself proved easy to be silently out of (it now persists and
  announces itself, but the dependency was the flaw). The rich entries -
  phone, location, notes - now open an **edit popup** built on the app's
  modal primitive: every supported field on one form, using the same shared
  controls (`field-controls.js`), validation, normalization, and the card's
  location-resolution save semantics; validate-all-then-one-write.
- A **per-row ✎ pencil** (name column, shown on hover, keyboard-focusable)
  opens the popup with NO mode required - editing a phone number no longer
  depends on the edit-mode toggle at all. In-cell editing remains for simple
  one-line values in edit mode; clicking a phone/location/notes cell there
  routes to the popup focused on that field.
- **Amended same day - sidebar-grade assistance in the popup**: location uses
  a new shared `createLocationControl` (bundled-city suggestions instantly,
  online geocoder results debounced while typing, picked suggestions carry
  their structured match into the same resolution keys the card writes), and
  company/role inputs get the existing-values datalists (skipped when the
  card's identically-named ones are already in the DOM).
- **Bulk "Set common field" rewritten on the shared stack** (after first
  fixing its stuck-dropdown bug - a stale `controlHost` variable re-appended
  the detached location editor for every field choice): the dialog now uses
  the sidebar's own controls per field (gender preset select, notes textarea,
  url inputs, company/role datalists, the shared live-suggestion location
  control) plus the shared `validateField` + `normalizeFieldValue` on apply,
  and the shared location appliers (its bulk-only extra, the manual
  pin-on-map, remains, recording `manualPin` in the resolution). ~200 lines
  of bespoke location UI deleted. Layout is a label/control grid sized to the
  dialog so no control overflows it.

## 2026-08-03 - Explore: vendors list under Organizations; one shared business rule

- The Organization facet only knew the `company` field, so vendors (which ARE
  the company) never appeared. A business contact with no company field now
  projects its own name as its org: it lists in the facet with its count, the
  org filter matches it, `org:` query syntax works, and the Company column
  shows it. Real companies are untouched; a person with a vendor tie plus
  personal ties stays a person.
- The "is this a business" rule was extracted to
  `isBusinessContact()` in `src/shared/relationships.js` (flagged, or all ties
  business-typed, with the owner/gendered person tiebreakers); the graph
  snapshot and the Explore projection both call it, so the two can never
  disagree about who is a business.

## 2026-08-03 - Explore: in-place cell editing behind an Edit toggle

- Explore's table gains inline editing for the columns that map directly to
  contact fields: name, nickname, gender (preset select), birthday (date),
  email, phone, company, role, website, linkedin, notes. Location columns stay
  read-only (they are geocode-derived; the card's map picker owns that flow),
  as do computed columns (relationships, kinship, degree, activity).
- Gated behind an "✎ Edit" toolbar toggle rather than modeless editing: a row
  click normally opens the contact, so modeless would either steal that click
  or need a dblclick-delay that taxes every navigation. In edit mode a click
  opens the cell editor (Enter/blur commit, Esc cancels, invalid values keep
  the editor open with the validator's message).
- Writes reuse `contacts:update` with a get-merge-update so one cell can never
  drop the contact's other fields, and every value runs through the shared
  `validateField` + `normalizeFieldValue` - the card, the importer, and now
  Explore literally share the write hygiene. After a commit the table
  re-queries and `onChanged` refreshes the graph.
- **Amended same day - identical controls, not lookalikes**: the card's field
  editors moved verbatim into `src/renderer/field-controls.js` (`createControl`
  + the phone country widget), imported by BOTH the card and Explore, so a
  phone edited in a cell gets the same country picker and lands as the same
  "+dial grouped" string. The location column became editable too, using the
  same save semantics extracted alongside (`applyLocationMatch` /
  `clearLocationResolution` / `resolveLocation`: text saved exactly as typed,
  resolution via the bundled city list then the opt-in online geocoder, keys
  cleared when nothing maps); the card's own location save now uses the shared
  appliers. Commit fires on focus leaving the WHOLE control (the phone
  widget's internal focus hops must not commit), and a picked select option
  commits immediately.
- **Phone country picker is a searchable combobox** (also same day): the
  native select's type-to-jump was invisible and reset after a beat. The
  picker shows a compact "🇮🇳 +91" when idle, becomes a search box on focus,
  and filters by country name, ISO code, or dial code as you type - full
  combobox ARIA, arrow/Enter navigation, Escape closing just the menu so the
  next one reaches the surrounding editor. Dropdown chrome reused from the
  location suggestions; both the card and Explore get it via
  `field-controls.js`.

## 2026-08-03 - Card details: core fields always visible, writes normalized like imports

- Details lists only fields that HAVE values (sparse contacts stay short
  cards), and the "+ Add field" quick-pick chips now offer the FULL supported
  catalog - core channels (email, phone, company, role) plus the standard
  extras - minus whatever is already set, so every supported field is one
  click away. (An "always show every row" variant was tried and reverted the
  same day: nine dashes on a sparse card read as noise.)
- **Profile saves stopped eating fields**: `setProfile` deleted any profile
  field absent from the payload, so a partial save (e.g. a Settings > You form
  that failed to preload) silently wiped stored values - the "phone vanished
  from the owner card" bug. It now touches only submitted keys; clearing takes
  an explicit empty string, the Settings form submits every input (empties
  included), and it refuses to save at all if the profile never loaded.
- Card writes now pass through `normalizeFieldValue()` in
  `src/shared/field-types.js` - the same canonicalization the CSV import
  applies (trim everything, "f"/"woman" -> "Female", truthy flags -> "yes",
  non-affirmative flag values clear) - and the import's `normGender` was
  replaced by the shared `normalizeGender`, so a hand-typed value and an
  imported one can never drift apart. Validation was already shared
  (`validateField` runs on card commits and inline adds alike).

## 2026-08-03 - Balloon layout toggle for the ego view

- A "Balloon" toggle joins "Fade links" in the canvas bar: a deterministic
  radial-tree (fractal-style) alternative to the FA2 force layout. BFS from
  the centre; each branch owns a wedge of its parent's proportional to its
  leaf count; rings grow per depth (and further when a crowded wedge needs
  room, capped so one huge family cannot fling a ring to infinity); contacts
  unreachable from the centre share one outermost ring. Non-tree cross-ties
  render normally (Fade links composes). Chosen over a seventh top-level view:
  it overlaps Reach/Orbit conceptually, so it is a layout preference
  (`orbit-layout-mode` in localStorage), not a destination. Pure math lives in
  `graph-geometry.mjs` (`balloonLayout`) with unit tests
  (`test/balloon-layout.test.js`); synchronous placement is O(V+E) under the
  1200-node ego cap, so the worker-only guardrail (about force simulation)
  is not implicated.
- Both toggles are icon-only buttons (inline SVG symbols `ico-fade`,
  `ico-balloon`, same stroke language as the view tabs) with `aria-label` +
  tooltip carrying the words; the balloon toggle shows only in the Graph
  canvas view (`setCanvasView`), since it has no meaning in the deterministic
  Mesh/Orbit/Reach/Cluster/Tree layouts.

## 2026-08-03 - Ego layout: leaves ride the rim, not the simulation

- FA2 gives a degree-1 contact almost no attraction, so repulsion scattered
  leaves INTO the core - they read as woven through the hub ring instead of
  hanging off their person. The layout worker now simulates only the connected
  core and derives every leaf's position per tick: a fan around its sole
  parent, aimed away from the graph's centre, radius grown so siblings never
  touch; a parent at the centre (usually "you") rings its leaves full-circle.
  1-1 pairs stay simulated (neither side is "the parent"). Also shrinks the
  simulated node count, so the layout settles faster at scale. Amends the
  GRAPH_CANVAS layout behavior; tunables (`LEAF_GAP`, `LEAF_MAX_ARC`) live at
  the top of `src/renderer/layout-worker.js` beside the iteration counts.

## 2026-08-03 - Admin data review (Settings > Admin)

- A new tab runs an on-demand health scan over the whole database:
  **structure** (dangling/self-loop/non-canonical edges, kin metadata on
  non-family ties, orphaned interaction/tag/search rows, broken owner pointer),
  **relationships** (family without kin, kin-vs-gender conflicts, businesses
  with genders or family ties, ambiguous vendor edges, deceased with
  reminders), **quality** (malformed emails/phones/dates via the shared
  validators, junk names, unmapped addresses, pending dedup candidates), and
  **graph shape** (isolated contacts, islands unreachable from you).
- Engine in `src/main/health/engine.js`; three IPC channels (`health:scan`,
  `health:setStatus`, `health:fix`) added to registry/preload/types and
  documented in INTERFACE_CONTRACT.md. Fixes are a whitelist of idempotent,
  transactional repairs no more powerful than existing public channels; the
  main graph rehydrates after each (the dedup pattern). Everything else is a
  deep link (open the card, the dedup queue, the profile) - the tool never
  guesses at destructive corrections.
- Findings carry a stable fingerprint (check + anchor), so triage
  (ignored/deferred, stored in `app_meta`) survives reruns; a rerun replaces
  the card deck, counts what disappeared as "resolved since last run", and
  prunes triage for findings that no longer exist - an ignored issue that
  recurs later comes back as open. `KIN_ROLES` moved to
  `src/shared/relationships.js` (renderer re-exports it) so the kin-gender
  check shares the renderer's exact term sets. Covered by `test/health.test.js`.
- **Amended same day**: kin entries keyed by a NON-endpoint id (leftovers from
  merges/imports that predate id remapping - dedup and archive import both
  remap now) were being attributed to whoever holds that id today, producing a
  false kin-gender conflict against an unrelated contact. The kin checks now
  only trust endpoint keys; a stray key is its own `kin-stray-key` finding with
  a `clear-stray-kin` fix that drops only the unreadable entries.
- **Also amended**: the tab is labeled "Review" (id stays `admin`, so the
  remembered-tab preference carries over); the last run's full deck is
  persisted in the run summary and a new `health:last` channel replays it
  (triage re-merged) when the tab opens, so the screen is only empty before
  the first ever review; and any finding anchored to a contact carries an
  "Open contact" jump, fix or no fix. Edge- and group-anchored findings also
  carry `focusIds` and a "Show on graph" jump (the existing `showOnGraph`
  focus-set), so "does this tie really exist?" is answerable in one click.

## 2026-08-03 - Tree labels and expanders clear the node's painted extent

- Tree names and the +/− expanders were offset from the node's bare radius,
  but the "you" node paints to r+13 (gold halo + sparkles), so the owner's
  name was drawn through the sparkles and crowded by the ↓ expander. Both now
  anchor on `nodeHaloRadius()` - the same painted-extent rule the Graph view's
  labels already follow. Non-owner nodes shift by ~1px; the owner's name sits
  just below the halo with the ↓ expander below the label row, and the ↑ and
  sibling buttons clear the sparkle orbit.

## 2026-08-03 - Tie-to-centre badge only where it adds information

- The small tie-type dot on centre-adjacent nodes is suppressed whenever the
  disc fill already carries that exact colour (relationship fill mode). It
  still draws where the fill encodes something else: org and community fills,
  the owner's gold, the deceased memorial disc. Rule is a colour comparison
  (`relColor !== color`), so it self-maintains across modes and palettes.

## 2026-08-03 - Sparse views label every node

- Sigma's `labelRenderedSizeThreshold` (7px) hides names on small degree-1
  contacts even in a near-empty drill-down where every name fits; overlap is
  handled separately by sigma's label grid. At or under `LABEL_ALL_MAX_NODES`
  (40) the size gate drops to 0 and the grid alone decides; larger views keep
  the gate so 95 labels don't carpet the canvas. Applied on every view rebuild
  (ego, mesh, orbit, reach, cluster); the tree draws its own labels and is
  unaffected.

## 2026-08-03 - Dominant-type ties break by closeness; drill-downs name their subject

- `dominantRelColor()` broke count ties by legend order, where friend precedes
  family - so a contact with one family and one friend tie read friend-coloured
  whenever no tie-to-centre rescued it (including as the centre of their own
  drill-down). Ties now break by a shared closeness precedence
  (`CLOSENESS_ORDER` in `src/shared/relationships.js`: family, friend,
  colleague, acquaintance, introduced, vendor) - still deterministic, no
  flicker, and a daughter reads family everywhere. Pinned in
  `test/relationships.test.js`.
- Contact drill-downs now show whose network you are in next to "Back to
  Home", reusing the `graph-nav-focus` chip cluster drill-downs already used.

## 2026-08-03 - Relationship fill: the tie to the centre outranks the dominant type

- A daughter with one family tie (to you) and one friend tie (elsewhere)
  painted friend-coloured in your own view: the fill used the contact's
  globally dominant type, and a 1-1 tie broke by legend order, where friend
  precedes family. `nodeColor()`'s relationship branch now prefers the
  `relColor` tag (the tie to the current centre) that the view already records
  for centre-adjacent nodes - the same precedence `relationshipTint()` always
  used for the deceased half-disc - falling back to the dominant type only
  when the view has no centre or the contact isn't adjacent to it. Fills are
  re-tinted after the view's edges are wired, since relColor doesn't exist yet
  at addNode time.

## 2026-08-02 - Cluster view: a business is an organization bubble

- The hybrid clustering only made org bubbles from the `org` field, so an
  org-less vendor dissolved into a personal Louvain community (and could even
  become its hub label). A business contact now becomes its own org-kind
  bubble named by the contact, or joins the company cluster already carrying
  its name; the cluster legend's person/organization toggle therefore covers
  vendors, and org bridges wire lone business bubbles like any company.
  Louvain groups stay company-less AND business-less by construction.

## 2026-08-02 - Business is derived from ties; centre keeps its fill; fade everywhere

- **Derived business.** The business flag alone missed every vendor created
  before the flag existed (a vendor-tied contact still showed a gender picker
  and no ring). The snapshot now derives it: a contact is a business when the
  field says so OR all its ties are business types - with two person
  tiebreakers, since a vendor edge is undirected and both endpoints look alike:
  the owner is always a person, and a recorded gender means person (safe
  because import/merge/card strip gender from every business). The card mirrors
  the same rule, replacing the gender row with the business marker; for
  derived-only businesses the "Not a business" undo is replaced by an
  "all ties are vendor" hint (there is no flag to clear). Covered in
  `test/relationships.test.js`.
- **Centred contact keeps its palette fill.** `nodeColor()` no longer swaps the
  drill-down centre to the theme-white disc (it read as "scheme not applied");
  focus is a thin theme-colored halo drawn outside the ring instead. The owner
  keeps the gold treatment.
- **Fade links now works in Cluster and Tree.** The cluster meta-edge reducer
  returned before the fade branch, and the tree draws its connectors on the
  overlay, so both ignored the toggle. Meta-edges now dim like ordinary edges
  (tie-type isolation stays full-strength - it means "light these up"), and
  tree connectors dim while the hover lineage highlight and couple hearts stay
  lit so tracing still works faded.

## 2026-08-02 - Business contacts: no gender anywhere, vendor-hued ring

- Amends the vendor entry below: a business previously drew only the building
  glyph (no ring), which made vendors read as second-class next to ringed
  people. They now wear a ring in the vendor color (`EDGE_COLORS.vendor`, so it
  follows the active palette) with the same geometry and hover behavior as the
  gender ring, glyph on top; the background gap ring keeps it legible even when
  the fill underneath is the vendor hue itself.
- **Gender is now stripped at every write path**, not just hidden: the card
  already deleted it when the business flag turns on and the import wizard
  omits it for vendor rows; the importer now also drops it on insert AND on
  merge (a source file can carry both), and a dedup merge across the flag
  (person + vendor) deletes it too - business wins. Covered by new cases in
  `test/ingest.test.js` and `test/dedup.test.js`.

## 2026-08-02 - Node fill defaults to "color by relationship" and persists

- The disc fill followed "Color by organization" by default, and a contact with
  no company gets the neutral "no organization" slate - so on a personal
  network (few orgs recorded) nearly every disc rendered gray, and switching
  palettes visibly changed edges and rings but not the nodes. The default is
  now **relationship** (fills match the legend, which is also how the palette
  review specimens were judged), and the chosen mode persists in localStorage
  (`orbit-color-mode`) instead of resetting to org each launch. Org and
  community modes are unchanged and stay one ⌘K command away. Amends the
  GRAPH_CANVAS "Node color by group" row, which named org as the default.

## 2026-08-02 - Settings reorganized into tabs

- The two-column settings page grew past what side-by-side scanning holds
  (profile, palettes, location, encryption, backups, data, updates, danger
  zone), so it is now five tabs grouped by concern: **You**, **Appearance**,
  **Privacy & Security** (encryption + the online-maps opt-out + telemetry),
  **Data & Backups** (counts, export/import, backups, danger zone), **About**.
  Amends APP_SHELL_UX §3's settings sketch; the section list is unchanged, only
  the container.
- Full ARIA tabs pattern (roving tabindex, arrows/Home/End move and activate);
  the last-viewed tab persists in localStorage (`orbit-settings-tab`) so
  repeated trips to one area cost one click. Rejected: an in-page sidebar nav
  (heavier for five groups) and accordions (hide state, poor keyboard shape).

## 2026-08-02 - `vendor` ties and business contacts (a contact that isn't a person)

- **The ask**: capture businesses (a broadband provider, a plumber) and the
  things you keep about them - a support number - without pretending they have a
  gender or a family.
- **Two orthogonal pieces, both additive.** The *tie* is a new relationship type
  `vendor`; the *contact* carries a `business` flag. Neither needs a migration:
  `edges.type` is free text in SQLite and `contacts.fields` is JSON.
- **One list, both processes.** The type list moved out of four private copies
  (renderer `colors.js`, `find.js`, `explore/service.js`, and the import-review
  validator in `ipc/registry.js` - which would have *rejected* a vendor row) into
  `src/shared/relationships.js`, next to `field-types.js`. `test/relationships.test.js`
  pins the palette, the list and the validator together.
- **Colour**: vendor is teal `#2f7f8f`. Teal is the one hue the personal types
  can't use, because a fill near cyan fuses with the male ring - and a business
  never draws a ring, so the slot is free exactly here.
- **`business` is a boolean field** (`fields.business`, like `deceased`), so it
  is editable from the card's "+ Add field", set automatically for vendor rows in
  the import wizard, and carried to the renderer on the graph snapshot. Effects:
  the card replaces the Gender row with a "business" marker (with a way back),
  the node drops its gender ring for the organization glyph already used by
  cluster bubbles, the import wizard stops demanding a gender for those rows, and
  the gender legend leaves businesses alone when a gender is filtered off (they
  are not the thing being filtered) while an isolate still hides them (it means
  "show only these people").
- **Glyph contrast** is picked from the disc's own lightness: the node fill can
  be an org hue, the vendor teal, or the pale centre fill, and a fixed white
  glyph disappeared on the last of those.
- **Deliberately not done** (say the word): a directed vendor edge with an
  arrowhead (kept undirected, like colleague); a first-class "support number"
  field (a custom field already covers it); business-aware dedup blocking;
  excluding businesses from the contact count and Insights.

## 2026-08-02 - Selectable color palettes (presets + custom) in Settings

- **What**: the graph's relationship colors and gender rings are now a user
  preference. Settings > Appearance offers Dusk (the shipped default) plus five
  presets picked in the August 2026 palette review (Ember Coast, Crayon Box,
  Jewel Pop, Retro Heat, Terracotta Sage) and a custom palette editing all six
  relationship colors and both rings.
- **Where the presets live**: `src/shared/palettes.js` (CJS, like
  `relationships.js`) so tests can `require()` them; source hexes were
  pixel-sampled from the reference pages and minimally adapted; every adapted
  value notes its source. `test/palette.test.js` holds each preset to the same
  rules as the default: full type coverage, no personal fill fusing into its
  ring (the `relationships.test.js` rule), and canvas-contrast floors (default
  3.0:1 on both grounds; presets 2.4 night / 1.4 day, their blurbs disclose the
  energy-for-day-contrast trade).
- **How switching works**: `EDGE_COLORS` and the new `GENDER_COLORS` in
  `colors.js` stay live objects every consumer reads by reference;
  `applyPalette()` retints them in place and `GraphView.repaintPalette()`
  refreshes what baked them in (edge colors, node fills, the memoised
  relationship tints) plus the legend. The choice persists in localStorage
  (`orbit-palette`, `orbit-palette-custom`) beside the theme - it is a
  per-device UI preference, so it deliberately does NOT touch the DB, IPC
  surface, or `INTERFACE_CONTRACT.md`. Rejected: piping it through app_meta +
  IPC; that would buy export/restore round-tripping of a cosmetic setting at
  the cost of a contract change.
- The colors.js `EDGE_COLORS` literal remains the Dusk values (tests pin the
  default from source); `test/palette.test.js` asserts literal and preset can
  never drift apart.
- **Explicit apply** (amended same day): selection no longer applies a palette.
  Every row carries an Apply button, the active palette is badged, and the
  custom editor saves without switching - its edits only repaint live when
  Custom is already the applied palette. Rationale: a palette switch retints
  the whole canvas; that is a commit, not a browse, and mis-clicks were
  one keystroke from restyling the graph.

## 2026-08-02 - Nothing paints over a node; the gender legend filters

- **Rule**: the overlay canvas sits above sigma's node layer, so anything it
  draws can cover a contact. Nodes now own their space and every decoration
  clears it: `nodeHaloRadius()` reports a node's painted extent (gender ring, or
  the owner's halo plus its orbiting sparkles) and labels, hover cards, couple
  hearts and the ring/lane guides are all offset or clipped against it. The
  visible defect was the "you" node: its name started under the gold halo, and a
  couple heart sat on its rim.
- **Couple hearts** move from the bond's midpoint (which lands inside the bigger
  node whenever the partners differ in size, and can land on an unrelated node
  the bond crosses) to the free gap between the two rims, shrinking to fit and
  vetted against every visible node via a small viewport hash
  (`src/renderer/graph-geometry.mjs`, covered by `test/graph-overlay.test.js`).
  A bond with no clear spot gets no heart: the coloured line still marks the
  pair. Extracting the geometry into a `.mjs` follows `map-geometry.mjs` - it
  keeps the placement rule testable outside the DOM.
- **Ring/lane guides** (Orbit, Reach, Tree) share the Tree's even-odd clip
  through `clipOutNodes()`, so guide circles and their chips read as background
  behind contacts. Skipped above `OVERLAY_MAX_NODES`, where the per-node overlay
  is off anyway.
- **Gender legend** gains the relationship legend's grammar: hover (or focus) a
  gender to isolate it, click to filter it out, click again to restore. "You"
  and the current centre always stay so the view keeps its anchor. It works in
  every view that draws contacts as themselves, Tree included (`treeShown()`
  drops connectors, names and expanders for anyone filtered out). Cluster is the
  one exception: a bubble is a mixed group, so there is no ring to filter on and
  the legend is hidden there rather than left inert.
- **Relationship palette** ("Dusk") moves off the muted mid-tones onto five deep
  hues at one shared chroma level, held in a luminance band that clears both
  canvases. Two of the five are fixed by a constraint that only appears once the
  colours became node *fills*: they are drawn inside the neon gender rings, so
  family must stay off magenta (`#ff2d95`) and colleague off cyan (`#00c2ff`) or
  the ring fuses into its own fill. Family is therefore brick and colleague
  indigo. Picked from five candidate palettes rendered under both rings on both
  canvases; the rejected ones were more saturated (busy at 95 nodes), colour-
  vision-first (Okabe-Ito, kept in reserve), and pastel (fails the light canvas).
- **Node fill** gains a third mode next to organization (default) and community:
  **colour by relationship**, filling each disc with the contact's dominant
  relationship type in the full graph (view-independent, so a contact keeps its
  hue everywhere; neutral grey when they have no ties). The type was previously
  legible only from the lines and the ego badge.
- **Deceased** contacts render as a split disc - one half the relationship
  colour (their tie to the centre when there is one, else their dominant type),
  the other the existing white - instead of a flat white fill, so a memorial
  still carries its relationship at a glance.

## 2026-07-27 - Undirected edges are stored canonically (source_id <= target_id)

- **Root cause of duplicate relationship rows.** An undirected tie (family /
  friend / colleague / acquaintance) is symmetric, but the edge PK is
  `(source_id, target_id, type)`, which only blocks the *exact* direction. Every
  write path (`edges.create`, archive import, dedup/merge re-point) used the
  endpoint order it happened to have, so the reverse of an existing tie could
  land as a *second* row (A->B and B->A). This surfaced as duplicate lines in the
  detailed CSV export and double-counted edges in the (multi)graph. The
  sample seeder already stored canonically (`Math.min/Math.max`); the other paths
  did not.
- **Fix.** A shared `canonicalEndpoints(source, target, directed)` in
  `db/edges.js` orders undirected ties as `source_id <= target_id`; applied in
  `edges.create` (so the reverse now collides with the PK and is rejected as a
  CONFLICT), archive import, and the dedup merge re-point. Directed ties (e.g.
  `introduced`) keep their direction. Kin metadata is keyed by contact id, so
  reordering endpoints never affects it. Migration `0008` collapses any legacy
  reverse-duplicate to one canonical row (preserving kin metadata) and flips
  lone non-canonical rows. The export-side dedupe added earlier is now a
  belt-and-suspenders safety net.

## 2026-07-27 - Import Resolve step: per-record duplicate decisions

- **The vCard/CSV import wizard gained a Resolve step** between Review and
  Import. A read-only `import:match` channel ranks existing-contact candidates
  per incoming record (email/phone/name/fuzzy, with reasons, a confidence score,
  and the candidate's connections for context) and flags in-file duplicates.
  Complements the two existing matchers (exact-equality at commit time in
  `importer.js`; live-vs-live ranking in `dedup/engine.js`) by ranking incoming
  rows against the live graph.
- **The user is master of every record.** Matching is advisory; smart
  pre-selection proposes a decision but never acts. Two modes (persisted):
  all-at-once batch table, or one-at-a-time cards. Each record carries a
  `decision` (`ignore`/`new`/`merge` into a chosen contact) on `import:records`
  that overrides the global `onDuplicate` policy. Archives keep the single global
  policy (per-record resolution of a whole archive is impractical).
- **Results write-back.** After import the user may save an annotated CSV
  (`orbit_status`) via `import:writeResults`, always through a save dialog
  (defaults to the source path so overwriting is deliberate). Re-import reads
  `orbit_status` back and pre-selects previously-imported records to ignore and
  previously-ignored ones to reconsider. Match tunables live in `config.dedup`.

## 2026-07-26 - Family tree view, Anchor, and load-bearing expanders

- **A generational family-tree canvas mode (`tree`) joins the view set**
  (`ego`/`mesh`/`orbit`/`reach`/`cluster`). It reads kinship edges into
  generational lanes rooted on the owner, with couple bonds, sibling bars, and
  parent-to-children buses drawn on an overlay behind the node circles. Node
  size is held constant (matching the graph view) and zoom-in is capped so a
  couple keeps a fixed on-screen gap. Renderer-local, no new IPC channel.
  Specified in `GRAPH_CANVAS_REQUIREMENTS.md` sec 7.
- **Anchor re-roots the tree on any pair.** A top-left combobox lists pairs as
  `[Level n] X - Y` relative to you and presents the selected pair's extended
  family (siblings, children, grandchildren, parents, grandparents); "Default"
  resets to you.
- **Expanders are shown only when load-bearing.** A directional expand/collapse
  button appears only when toggling it would actually add or remove a node, so
  a fully-expanded tree is not littered with dead buttons. A couple's children
  expansion lives on both partners and toggles as a unit.
- **Hover highlight has Default (vertical lineage) and Extended (collateral kin)
  modes**, persisted per user.
- Lane and column spacing were tightened after the first pass read as too airy.
  The tree-specific layout tunables stay renderer-local (`graph-view.js`),
  consistent with the precedent that per-view layout constants live next to the
  view rather than in `config.js`.

## 2026-07-22 - Graph position pinning removed

- The session-only Pin Position action added little beyond persisted node drag
  and made the connection menu less focused. It has been removed completely;
  layout updates apply normally and dragged full-network positions still save.

## 2026-07-22 - Detailed maps enabled by default

- A missing `location.online` preference now means enabled. Zoomed Geomap views
  therefore use detailed CARTO/OpenStreetMap tiles without requiring a trip to
  Settings. An explicit off choice remains persistent and falls back to the
  bundled country-outline map and city list. Map and geocoder traffic remains
  main-process-only; the renderer CSP still has `connect-src 'none'`.

## 2026-07-22 - Persisted column movement is the table-view standard

- **Explore headers have distinct move, sort, and resize targets. Every data
  column sorts through the main-process Explore service.** Drag the
  handle to place a column before or after another visible column; Alt+Left or
  Alt+Right provides the keyboard equivalent. The selection cell and Name stay
  anchored so row identity remains visible while scrolling.
- **Order persists independently of visibility and width** in local settings.
  Hidden columns retain their relative position when shown again, and stored
  order self-heals when the product adds or removes a column.
- **Future configurable table views follow this interaction contract** rather
  than inventing view-specific column behavior.

## 2026-07-21 - Orbit identity finalized (fresh start, pre-Orbit data retired)

- **The npm package name is `orbit`.** In development this drives
  `app.getName()`, so user data lives under
  `~/Library/Application Support/orbit/` and the safeStorage keychain identity
  is `orbit`. Packaged builds display `Orbit` from `productName`. There was
  intentionally no data migration: this was a deliberate clean start, with the
  superseded local data retained separately as a recovery snapshot.
- **The archive identity is Orbit-specific:** extension `.orbit`, header magic
  `ORBIT1`, and document format id `orbit-archive`. The fresh start meant there
  were no pre-existing archives requiring compatibility.
- **The DB filename remains `contacts.db`** because it names the contact store,
  not the product. The repository directory is `orbit-graph`; the `main.js`
  note about keychain-bound identity still applies.

## 2026-07-21 - Geomap: Web Mercator, opt-in OSM tiles, 50m offline base

- **Reprojected the Geomap to Web Mercator** (was equirectangular). One shared
  pan/zoom model; the zoom floor is "world covers the pane" and pan is clamped to
  the world edges, so the map always fills the pane (no more tiny floating map).
  Wheel/trackpad zoom is linear in the scroll delta and anchors on the cursor.
- **Offline base bumped 110m -> 50m** country vectors (finer coastlines/borders),
  still fully bundled, zero network.
- **Online tile preference**: when "Online maps & location search" is on *and* the
  device is online, the Geomap draws OpenStreetMap raster tiles. This is remote
  content, so it is deliberate and gated: **tiles are fetched in the main
  process** (`src/main/maptiles.js`, new `map:tile` IPC channel gated on the same
  `location.online` meta flag) and handed to the renderer as `data:` URLs. The
  **renderer keeps `connect-src 'none'`** - it never touches the network. Tiles
  are cached on disk under `userData/tile-cache`. Falls back to the 50m vector
  map instantly when offline or opted out. Amends the "no remote content"
  guardrail the same way opt-in Photon geocoding already did: main-process fetch,
  user control, renderer stays sandboxed. (The 2026-07-22 decision above later
  changed the unset/default state from off to on.)
- **Deceased glow is now steady** (no pulse), consistent across Graph, Network,
  and Geomap - a quiet memorial halo rather than an animated one.

## 2026-07-21 - Quick "add a connection" dropdown (right-click + card button)

- **Right-click a node** (or 2-finger click) opens a small dropdown of the five
  relationship types (colour-dotted like the legend). Sigma's `rightClickNode`
  drives it; the browser context menu is suppressed on the canvas.
- **Same dropdown as a card button** ("Add connection ▾") between Link and
  Delete, anchored to the currently-open contact.
- Picking a type creates a `New <type>` contact + an edge of that type to the
  anchor, refreshes, and opens the new node's card **already in rename mode**
  (`startRename`) - the user types the name and every field auto-saves (the card
  has always saved per-field, no Save button). The breadcrumb relationship
  editor is pre-set to the chosen type (with the kin sub-picker for family).
- Menu logic (`showConnectionMenu`/`addConnectionTo`) is shared by both entry
  points. `pushNav()` first, so Back returns to where you were.
- Also: sidebar nav icons enlarged in the expanded state (18px).

## 2026-07-20 - Start screen on relaunch, owner-edge fix, golden owner, split Settings

- **Owner connects only to their inner circle**: the sample previously let the
  owner (Sam) pick up ~10 random edges and let strangers link to him, so "who's
  connected to me" showed noise. The random-edge pass now skips the owner
  entirely (as source and target) - Sam's only edges are the curated family.
- **Golden sparkling owner node**: drawn in the overlay canvas - a glowing gold
  ring (canvas shadow) plus orbiting twinkling glints, animated by a rAF loop
  that runs only while the owner node is in view (and the overlay is enabled).
- **Settings split into two independently-scrolling columns**: left = You +
  About, right = Encryption / Backups / Data / Danger zone, with a hairline
  divider. Each column scrolls on its own.
- **Start screen on relaunch of sample data**: if the last session was sample
  data, launch opens the landing screen (Continue exploring / Switch size /
  Start my own network) instead of silently dropping into the sample graph, so
  the choice is explicit. `#empty-state` now has a fresh block and a sample
  block; `landingActive` gates it and any view switch dismisses it.
- **"Exit exploring"** added to the sample banner - returns to the start screen
  without clearing data. Banner's dismiss is now a compact ✕.

## 2026-07-20 - Owner becomes an inner-circle graph node (supersedes profile-singleton)

- Reverses the "owner is a profile singleton, not a node" decision below - but in
  the controlled way that avoided the supernode problem: the owner is a **real
  contact** connected **only to the people you explicitly link** (your inner
  circle), never to the whole network. So "who's directly connected to me" is
  just the owner's ego view, and degree stays small (no FA2/centrality damage).
- **Model**: `app_meta.owner.contactId` points at the owner contact. `meta`'s
  `getProfile`/`setProfile` are now contact-backed (create/update + star the
  owner, preserve non-profile fields like notes); `OwnerProfile` projects the
  contact's name + fields. `getOwnerContactId` exposes the id.
- **Graph**: the store tags the owner node `isOwner` (read from app_meta at
  hydrate); it renders gold, hovers as "Name (you)", and **Home now centres on
  the owner** when set (falls back to the most-connected hub otherwise).
- **Guardrails**: `contacts:softDelete` refuses the owner (edit in Settings
  instead); `data:clearAll` already wipes contacts + app_meta, so a reset clears
  the owner too. `profile:set` rehydrates the graph so a new owner node appears.
- **Sample**: Sam Rivera is the owner contact (starred), wired to his immediate
  family (mother/father/sister/brother/grandmother) with kin roles, plus the
  extended family interlinked. Loading a sample and going Home lands on Sam.
- **Follow-up**: if the owner contact is merged away in dedup, the pointer
  dangles (getProfile → {}, Home falls back to hub). Acceptable for now; guard
  dedup later.

## 2026-07-20 - Drill-down navigation history (on-canvas Back)

- The single-slot `backAction` (only ever used to return from a Find/Explore
  "show on graph") is replaced by a **navigation stack** (`navStack` +
  `pushNav`/`popNav`/`resetNav`/`snapshotLocation`). Drilling into a node
  (graph `onSelect`, card `onNavigate`) pushes the current place first, so the
  on-canvas `#graph-back` button walks back up the whole chain
  (contact → contact → … → Home/Full), one step per click. Esc mirrors it.
- Top-level view switches (Home, Full network, Explore, Find, Insights,
  Settings, `g g`) **reset** the stack - a fresh start - which keeps a clean
  invariant: reset-locations only ever sit at the bottom of a chain, contacts
  stack on top.
- Opening a contact from **Find/Insights** now switches into the graph and
  focuses (previously it left you in the list view with the Back button on the
  hidden canvas, so "Back to Find" was effectively dead); the list view is
  pushed so Back returns to it.

## 2026-07-20 - Sample datasets + sample-mode reset flow, owner onboarding

- **Two sample presets**: `config.sample.small` (100) and `.large` (5,000).
  `data:seedSample` takes a `dataset` ("small"|"large"); presets seed a
  **simulated owner** (`app_meta` `owner.profile`) plus a curated **family
  cluster** (the first contacts) wired with `family` edges carrying
  `metadata.kin` roles (wife/husband, mother/father, sister/brother,
  son/daughter, ...), so the kinship feature ships visible in the sample. The
  family ties are inserted before the random-edge pass so their kin metadata
  isn't clobbered by an `OR IGNORE`'d random family edge.
- **Sample flag**: seeding sets `app_meta` `sample.dataset`; `data:sampleStatus`
  reads it. Every launch, if set, a **persistent top banner** offers: keep
  exploring, **switch size** (small↔large, reseed), or **start my own network**.
- **"Start my own network"**: `confirmModal` → `data:clearAll` (which now also
  wipes `app_meta`, so the simulated owner + flag are gone) → **owner
  onboarding** modal (`ownerOnboarding()`, the profile singleton, skippable) →
  empty, ready app.
- **Empty-state redesign**: primary "Set up my network" (owner onboarding);
  samples are the secondary "just exploring" path (100 / 5,000). Stale "Import
  arrives in M2" copy removed (import already exists). Owner onboarding is a
  reusable modal, so the first-run pitch (`#onboarding`) reverts to a pure
  welcome; Settings → You remains the canonical profile editor.

## 2026-07-20 - Owner ("you") is a profile singleton, not a graph node

- The app is an **egocentric CRM wrapped around a sociocentric graph**: cadence,
  interactions, and "needs attention" are all relative to the owner, yet graph
  edges are contact-to-contact. The owner was implicit everywhere and modelled
  nowhere. The kinship feature made the gap visible ("Lucia is *your* sister").
- **Decision: model the owner as app-level metadata, NOT a vertex.** A self-node
  genuinely connected to the network would be a degree-N supernode that wrecks
  FA2 layout and dominates betweenness/centrality (owner is trivially most
  central), and self-as-contact leaks edge cases into dedup/delete/export. The
  graph stays a network of *others*; the owner is the implicit ego/lens.
- **Storage**: migration `0007_app_meta.sql` adds a generic key/value
  `app_meta` table; `src/main/db/meta.js` stores the owner under `owner.profile`
  as JSON (`OwnerProfile`: name, gender, email, phone, company, role). New IPC:
  `profile:get` / `profile:set`.
- **Seeding**: an *optional* (skippable) "About you" step on the first-run
  onboarding screen, with the canonical always-editable home in Settings → You.
  No hard blocking dialog - the app doesn't require a profile to run.
- **Deferred**: if we ever want the owner *visible* in the graph, do it as a
  toggleable render-time overlay linked only to explicitly-marked inner-circle
  people - never persisted edges to the whole network.

## 2026-07-20 - Relationship editing model + hover-label fix

- **Connections list is read-only** again (per feedback): shows the relationship
  as a small colored label, click navigates. No more inline dropdowns there.
- **Relationship editing moved to a breadcrumb model**: opening a contact *from*
  another (clicking a connection, or a graph node while focused elsewhere)
  shows an editable "Relationship to ‹the one you came from›" dropdown at the
  top of the card, backed by `edges:update`. selectContact now takes
  `{ from, fromName }`.
- **Tooltip phrasing** made sensible: "introduced by ‹name›" (not "introduced
  of"), and a `relationshipPhrase()` map for the rest.
- **Hover-label fix**: sigma's default node-hover draws the label on a hardcoded
  white box (invisible with light label text in dark mode). Overrode
  `defaultDrawNodeHover` with a themed box + readable text (both themes).

## 2026-07-20 - Settings: Clear all data

- **Clear all data** (Settings → Danger zone): `data:clearAll` empties every
  data table (`src/main/db/maintenance.js` - deleting contacts cascades derived
  rows; tags/merge_log/saved_searches cleared explicitly; VACUUM after) for a
  fresh start. Guarded: a safety `VACUUM INTO` backup is taken first (so
  Restore latest backup can undo it), and the UI requires typing CLEAR in a
  `confirmDangerModal` before the button enables. Graph/centrality/explore
  caches refresh to the empty state.

## 2026-07-20 - Acquaintance type, relationship in tooltip + editable

- **New "acquaintance" relationship type** added (resolves the taxonomy oddity:
  a weak-tie/strength label alongside colleague/friend/family and the
  provenance-y "introduced"). Sourced from one place - `EDGE_COLORS`/
  `EDGE_TYPES` in colors.js - now consumed by the legend, relationship picker,
  Find options, Explore facet universe, and the sample generator.
- **Relationship in the hover card**: neighbours show "colleague of <center>"
  etc. (view nodes carry relType, set in buildView).
- **Editable relationship per connection**: the contact card's Connections list
  now shows each edge's type as a colored dropdown; changing it calls the new
  `edges:update` (delete + re-insert, PK-safe, preserves direction), backed by
  `edges:list`. Node overlay ring/badges unchanged.
- **Find saved-queries overflow**: the inline dropdown caps at 10 with a
  "Browse all N…" entry that opens a searchable picker (with delete).

## 2026-07-20 - Node ring/badge overlay + misc UX

- **Gender ring**: a colored ring is drawn around each node (pink=Female,
  blue=Male) via an overlay `<canvas>` synced to sigma's afterRender, using
  getNodeDisplayData + graphToViewport + scaleSize. Gated to <=2500 rendered
  nodes (rings are unreadable in a dense full-graph anyway); ego views always
  show them. gender now rides on GraphNode/store/snapshot.
- **Relationship hint**: in ego view, each neighbor gets a small badge in its
  relationship-to-center color (colleague/family/introduced/friend) - computed
  in buildView from the edge to the center. Legend gained a ring key; hover card
  shows gender.
- Contact card: **Connections moved to the last section**.
- **Insights** removed from the top-bar tabs (Graph | Explore | Find only);
  still reachable from the sidebar and palette.

## 2026-07-20 - Find (query builder) + Insights page

- **Find**: a top-bar view (Graph | Explore | Find | Insights) that builds
  structured queries - rows of [field][operator][value] across every field
  (standard + custom), combined with ALL/ANY. `find:query` evaluates against
  the in-memory ExploreService index (same rows Explore uses; ~ms). Operators
  are typed (text/number/date/list/bool/enum). Results table + "Show on graph".
  Queries save as named `kind='find'` rows in saved_searches (migration 0006
  added the `kind` column; palette/Explore searches are `kind='text'`),
  reloadable from the Saved dropdown.
- **Insights** moved from a modal to a content-pane page with much more:
  stat tiles (contacts/connections/avg degree/hubs/isolated/with-cadence/
  overdue/no-email), needs-attention, top connectors, recently added, and
  distribution bars for org/role/gender/relationship/tags - plus an interactive
  **"Break down by…"** selector (`insights:breakdown`) to extract a distribution
  over any dimension on demand. Back-nav returns to Find/Insights when you open
  a person from them.

## 2026-07-20 - Gender standard field

- **Gender** is now a standard, always-shown Details field with a fixed
  Male/Female picker (blank clears). Added to the sample generator so future
  seeds carry it. A dev/demo one-shot at boot (`ORBIT_ASSIGN_GENDER=1`) assigned a
  random Male/Female to the existing sample contacts - idempotent (skips any
  that already have one). Demo data only.

## 2026-07-20 - Panel fit, phone split, tooltips, back nav

- **Contact panel** widened to 380px with `overflow-x: hidden`; inline editors
  stack vertically (label, full-width control, right-aligned ✓/✕/🗑) so nothing
  clips the panel regardless of field width.
- **Phone input** is now three parts: a country selector whose options are full
  country names (so you type the name to search - "united k…" jumps to United
  Kingdom), plus separate **area code** and **number** boxes. NANP (+1) numbers
  auto-split 3 + rest on load; stored canonical as `+<dial><area><number>`.
- **Collapsed sidebar** icons show a native tooltip (title) with the label +
  shortcut.
- **Back navigation**: a "← Back to …" button appears on the graph when you
  arrived by drilling in - Explore's "Show on graph" returns to the same
  filtered Explore, and Insights → a person returns to Insights. Esc also
  triggers Back. Top-level nav (Home / Full network / Explore) clears it.

## 2026-07-20 - Inline field editing + themed canvas

- **Inline (click-to-edit) contact card**: the card is a read-only simple view;
  clicking any value (name, a field, notes, tags) turns that item into an
  in-place editor with ✓ apply / ✕ cancel (and 🗑 remove for fields). Each edit
  saves only its own field via a `fields` patch; Enter applies, Esc cancels.
  Replaces the whole-card edit mode + Save/Cancel. The typed-control abstraction
  (email/date/url/phone/notes-textarea/datalist) is now module-level and shared
  by inline editors and the add-field affordance.
- **Themed graph canvas**: the light/dark toggle now repaints the constellation
  too (`--graph-bg` + a `graphTheme()` palette for labels, dim, center, edges,
  path highlight; `graphView.applyTheme()` on toggle). Earlier the canvas was
  deliberately fixed dark, which made the toggle look inert since the canvas is
  most of the view - corrected per feedback.

## 2026-07-20 - Theme, gender, phone input

- **Light/dark theme** toggle in the top bar, persisted. All chrome surfaces
  are CSS variables now (added semantic --hover/--active/--active-border/--bar);
  the graph canvas deliberately stays dark in both themes (--graph-bg), matching
  the design language ("the graph is the one luminous element").
- **Gender** as a select-or-type field (datalist of presets ∪ existing values,
  still free-text) exposed via explore:fieldValues.
- **Phone input**: country dropdown (flag emoji from ISO code + dial code) plus
  a national-number field, in `src/shared/countries.js`. Stores canonical
  `+<dial><national>`, parses existing values by longest-dial-code match,
  remembers the last-used country. Retyping a field key to "phone" swaps the
  plain input for this widget live (the edit form now uses a control
  abstraction so composite inputs slot in beside plain ones).

## 2026-07-20 - Explore table + smart edit form (UX pass)

- **Resizable columns**: per-column widths dragged via header grips, persisted
  to localStorage; the grid template is a CSS var applied to head + every row.
- **Sortable columns**: click a header to sort, click again to flip direction
  (backend gained a `dir` param; each sort key has a natural direction).
- **Facet-aware columns**: Email/Phone/Relationship columns appear automatically
  when their facet is active (selecting "Has phone" reveals the Phone column).
- **Facet overflow**: org/tag groups collapse to the top 8 with an inline
  "Show all N" that reveals a *searchable* scroll list - chose inline expand +
  search over a popup so you keep the results in view while narrowing.
- **Star has Unstar**: binary bulk actions offer both directions.
- **Bigger collapsed sidebar**: 58px rail, 22px icons.
- **Smart edit form** (`src/shared/field-types.js`, shared CJS): field keys
  infer input type - email/tel/url get native inputs and keyboards, dates get a
  native picker, company/role get select-or-type datalists sourced from a new
  `explore:fieldValues` channel (distinct existing values). Values validate on
  blur and block save with inline errors.

## 2026-07-20 - Explore: content-pane faceted people-search

The modal "list view" felt unconventional, so it became a first-class
content-pane view (top-bar Graph ⇄ Explore switch), Folk/Attio/Clay-style:

- **`ExploreService`** (main, in-memory): assembles one row per live contact
  with everything the facets need (org/role/tags/degree/last-interaction/
  starred/cadence/overdue/dormant/edge-types), cached and rebuilt only on
  `markDirty()` - wired into every write handler alongside the centrality
  cache. First query builds the index (~126ms at 7k, ~9ms every query after);
  no per-keystroke DB scan.
- **Facet model**: OR within a group, AND across groups; each facet's counts
  are computed as if its own group weren't applied, so you always see what
  adding another value yields (standard faceted-search behavior).
- **Query bar ⇄ facets two-way sync**: operators typed in the bar
  (`org: tag: type: has:email near: hops:`) merge into the same filter state
  the facet checkboxes drive; the near:/hops: graph operator resolves via BFS
  over the in-memory graph.
- **Result-set as a verb**: bulk star / tag / set-cadence / delete (undo-first)
  and **"Show on graph"** (focuses the graph to the matched subgraph via
  `graphView.focusSet`) operate on the selection, or the whole matched set when
  nothing is selected. Segments rail: built-in smart lists (Needs attention,
  Starred, Dormant connectors, Missing email) + your saved searches; "Save as
  segment" persists the current filters as a saved search.
- The virtualized table (40px rows) shows name/org/last-contact/degree/tags
  with overdue pills and star marks. Opening a row from Explore keeps the table
  and shows the card beside it (doesn't yank you to the graph).
- **Deferred**: subset export (needs an `ids` param on the archive/GraphML
  channels) - dropped the button rather than ship a dead end.

## 2026-07-20 - Traditional chrome: native menu + sidebar

- **Native application menu** (`src/main/menu.js`): File (new/quick add,
  import, exports, backup), Edit (standard roles so clipboard works), View
  (all surfaces, ⌘, for Settings, zoom/fullscreen; reload/devtools dev-only),
  Window, Help. App-specific items forward command ids over the `app:menu`
  event channel; one renderer-side router (`runCommand`) serves the menu, the
  sidebar, and the palette alike.
- **Sidebar rail**: Graph / Full network / List / Insights (with an amber
  needs-attention badge) / Import / Export / Duplicates / Trash / Settings /
  Shortcuts. Collapses to icons under 1060px. The palette stays the fast path;
  the sidebar is the discoverable one.
- **Hard-won constraint: never app.setName() on an existing profile.** macOS
  safeStorage derives its Keychain entry from the app name, so renaming
  orphans the encrypted DB key (and the dev menu-bar still says "Electron"
  regardless; packaging fixes that via productName). Cross-profile/device
  migration is exactly what the export/import archive is for. Dev keeps the
  package-name profile; packaged builds start their own.

## 2026-07-20 - Relationship-intelligence UX layer

Category-informed enhancements (Clay/Dex/Cloze/Monica patterns), local-only:

- **Keep-in-touch cadence** (migration 0005: `cadence_days`, `starred`):
  per-contact "stay in touch every N days" set on the card; patching
  `cadenceDays: 0` clears it. `insights:summary` computes overdue (cadence
  blown) and dormant (connected but untouched for `config.insights.dormantDays`)
  lists plus org breakdown and top connectors - surfaced in the Insights panel
  and as "attention" rows in the palette's empty state.
- **Hover mini-cards** on graph nodes: org/role, recency ("last touch 12d
  ago"), degree, mutual count with the focused contact. Snapshot now carries
  `lastInteractionAt` (one GROUP BY, merged main-side) so hover needs no IPC.
- **Intro chains**: the card shows "via Bo ← Alice" by walking inbound
  `introduced` edges (≤3 hops) in the renderer's graph.
- **Quick add** (`src/shared/quick-add.js`, CJS so tests and the bundle share
  it): "met Sarah Kim, PM at Initech, via Bo Novak, #conf" parsed with
  deterministic comma-segment heuristics - predictable beats clever for a
  capture box. Creates contact + tags + introduced edge (exact name match
  only; near-misses are reported, never guessed) + a "quick add" interaction.
- **Cheap wins**: starred contacts pinned in the palette empty state, `?`
  shortcuts overlay, and a backup trust strip in the top bar ("backed up 4m
  ago ✓", refreshed every 5 minutes).
- **Deferred**: photos/avatars, light theme, right-click menus, focus
  back/forward history, community auto-labels, edge-weight-by-strength.

## 2026-07-20 - Need/Nice tier build-out

- **List view**: custom virtualization (fixed 32px rows, translated window)
  rather than a library; sortable columns, text filter, shift-range
  multi-select, bulk tag/delete (undo-first, capped by config.limits.bulkMax).
- **Purge & auto-purge (migration-free)**: `contacts:purge` is the app's ONLY
  hard delete, trashed-rows-only, confirmed in the UI; boot auto-purges trash
  older than `config.trash.autoPurgeDays` (30). Cascades ride the existing
  FK ON DELETE CASCADE (derived data only, per the guardrail).
- **Saved searches** (migration 0004): name-keyed upsert; the palette's empty
  state lists them (SEARCH §9) and any non-empty query offers "Save search".
  The palette also now surfaces `didYouMean` (computed since M4, previously
  never shown) and a scope-to-focus toggle filtering results to the current
  ego network client-side.
- **Settings** reads one `backup:status` diagnostics channel;
  `backup:restoreLatest` verifies the newest snapshot, snapshots the current
  state first (chosen target is captured before, so no self-restore loop),
  swaps the file and relaunches.
- **PNG export** composes sigma's canvas layers in the renderer and ships
  base64 over IPC; main verifies the PNG magic bytes and only writes
  dialog-granted paths. GraphML is built main-side from the snapshot.
- Onboarding is a one-time overlay gated by localStorage.
- **Deliberately NOT built**: minimap and path animation (cost/benefit), and
  spellfix1 (the JS Jaro-Winkler + Damerau-Levenshtein scan already covers
  typo recall well under budget; revisit only if 20k-scale latency demands it).

## 2026-07-20 - Post-build review pass (fixes)

A completeness/correctness audit after the M1..M5 build-out found and fixed:

- **Archive import made atomic**: contacts + edges + interactions now commit
  in one outer transaction (inner ones become savepoints); no partial import
  on failure.
- **Search correlation hardened**: the SearchService keys in-flight queries by
  a service-internal token, not the renderer's requestId (palette and the
  relationship picker keep independent counters, so ids can collide). The
  renderer requestId is echoed back for stale-discard. Worker exit also fails
  pending queries instead of hanging them.
- **Destroyed-window guards**: `runtime.window` nulls on close; layout ticks
  and second-instance focus check `isDestroyed()` (closing the window on macOS
  mid-layout previously crashed the app via uncaughtException).
- **Dialog-granted paths only**: import/export channels reject any file path
  the user did not pick through a main-process dialog this session
  (`grantedPaths`), so a compromised renderer cannot read or write arbitrary
  files through ingest channels.
- **Betweenness cache invalidation** extended to contact create/soft-delete/
  restore (node count and incident edges change the metric).
- **Louvain guard** for edge-less graphs (it throws otherwise); drag-end no
  longer swallows the next node click.

## 2026-07-20 - M1..M5 build-out (v0 feature-complete)

- **Contract grew to 31 channels** (tags, dialogs, import preview/file, layout
  start/stop/savePositions, dedup candidates/merge/undo, seedSample). The
  three-way drift guard (registry / preload / types) covers all of them.
- **Migrations 0002/0003**: `layout_positions` (persisted full-graph layout,
  derived data, cascade ok) and `merge_log` (journaled, undoable merges).
- **Search typo recall** uses a fuzzy name scan (Jaro-Winkler + Damerau-
  Levenshtein) merged in whenever FTS recall is thin, rather than spellfix1;
  did-you-mean is the best fuzzy name when recall is empty. spellfix1 remains
  a candidate for M6 if scan latency ever matters at 20k (currently ~ms).
- **Graph operators** (`near:`, `hops:`) resolve via SQL BFS inside the search
  worker instead of asking the main-process graphology instance, keeping the
  worker self-contained on its read-only connection.
- **Archive format**: JSON header line + NDJSON records; passphrase mode is
  scrypt -> AES-256-GCM over the whole payload, fail-closed on tamper/wrong
  passphrase. Merged/skipped contacts never copy interactions (no duplicate
  history).
- **Merge undo** restores from a JSON snapshot in `merge_log` (primary fields,
  secondary row/edges/tags, created edges, moved interaction ids) rather than
  a generic event log - simpler, and scoped exactly to what merge touches.
- **sigma reserves the edge attribute `type`** for its render program; the
  domain relationship type lives in `edgeType` on rendered view edges.
- Full-graph layout runs in the MAIN-side worker streaming
  `graph:layout:tick`; ego layouts stay renderer-side. Dragged positions
  persist per node via `graph:savePositions` (full mode only).

## 2026-07-19 - Foundation reconciliation

**Data layer extracted from main.js.** `src/main/db/index.js` owns the keyed
SQLCipher open, self-heal, backups, and close; `src/main/keys.js` owns the
keychain key via `safeStorage`. `main.js` is a thin orchestrator. The ad-hoc
`ensureSchema()` was deleted: the migration runner is the only schema authority.

**IPC registry.** All channels live in one table (`src/main/ipc/registry.js`)
with per-channel validators. Sandboxed preloads cannot share a module with the
main process, so the preload channel list stays literal and
`test/ipc-contract.test.js` asserts registry, preload, and `IpcContract` in
`types.d.ts` declare identical channels. `IpcError` crosses the boundary
serialized into the Error message behind an `IPCERR:` marker (Electron strips
custom error properties); the preload bridge re-hydrates it.

**Watch mode without a dev server.** `npm run dev:watch` runs
`vite build --watch` beside Electron; the main process watches `dist/renderer`
and reloads the window on change (`config.dev.reloadDebounceMs`), and
`scripts/dev-watch.js` restarts Electron when `src/main` or `src/shared`
change. Full page reload rather than HMR is the accepted trade-off for keeping
`connect-src 'none'` identical in dev and production.

**Vite for the renderer.** sigma.js v3 is ESM and the renderer is sandboxed
with `script-src 'self'`; a bundler is mandatory. No dev server: dev and prod
both load the built output via `loadFile`, so `connect-src 'none'` holds
everywhere. Renderer deps (sigma) are devDependencies; the package ships
`dist/renderer` plus `src/main` + `src/shared` only.

**Native module ABI strategy.** The working tree always targets Electron's
embedded Node ABI. `postinstall` force-rebuilds the encrypted SQLite addon for
the pinned stable Electron release, then opens a real in-memory database as an
ABI check. Tests, migrations, fixture generation, and source smoke checks run
through `scripts/electron-node.js`; none of them rewrites the native binary for
standalone Node. This prevents a successful test run from making the desktop
app fail on its next launch.

**Types are enforced, not advisory.** `tsc --noEmit --checkJs` runs in CI
(`npm run typecheck`) against `types.d.ts`, including the renderer
(`window.api` is typed via a `RendererApi` global augmentation).

**CSP single-source pragmatics.** The meta tag in `index.html` is the enforcing
copy; `config.security.csp` is the authoritative value; a test asserts they are
identical. (Header injection via webRequest is unreliable for `file://`.)

**Validation is strict.** Unknown payload keys are rejected, not stripped, so
contract drift surfaces at the boundary. Bounds live in `config.limits`.
`contacts:update` accepts only `name` and `fields` in the patch.

**Soft-delete removes the search projection row.** Trashed contacts leave the
FTS index immediately (row deleted, triggers clear the mirrors) and are
re-projected on restore. This is how "deleted contacts never appear in search"
is enforced structurally rather than by remembering a WHERE clause.

**Backup before import.** When `import:archive` is implemented (M2), it must
take a `VACUUM INTO` snapshot first, same as migrations. Recorded in the
registry stub.

**Fixture realism.** 20k contacts now produce ~190k edges clustered into
social circles of 40 (80% in-circle, 20% long-range), with orgs aligned to
circles, tags, and notes. Community detection, layout, and centrality tests
exercise structure instead of uniform noise.

## 2026-07-19 - UI vertical slice

Shipped ahead of strict milestone order (user decision): app shell + Cmd/Ctrl+K
palette + contact card + ego graph, so every later milestone lands somewhere
visible. Notable mechanics:

- `search:query` runs in a worker_threads worker (`src/main/workers/`) with its
  own read-only keyed connection; the pipeline lives in `src/main/search/engine.js`
  (pure, Node-testable). Slice scope: FTS prefix + trigram recall, AND-then-OR
  forgiving fallback, Jaro-Winkler name re-rank, exact/prefix boosts. Recency &
  centrality signals, operators, and did-you-mean remain M4/M5.
- ForceAtlas2 runs in a renderer web worker bundled by Vite as a same-origin
  chunk (`layout-worker.js`), so the strict CSP holds (no blob: workers). The
  main-side layout worker with persisted positions (full-graph mode) is still
  the M3 plan.
- `data:seedSample` channel + `src/main/db/sample.js` (shared with the fixture
  script) power the first-run "Load sample network" action. Dev builds also
  honor `ORBIT_DEV_SEED=<n>` to pre-seed an empty DB at boot.
- The renderer bundles `src/main/config.js` (CJS) via Vite `commonjsOptions` so
  tunables stay single-source. Typecheck is split: `tsconfig.json` (main, CJS)
  and `tsconfig.renderer.json` (ESM + DOM).
- Unpackaged builds forward renderer console messages into the main log.

## UX direction (decided, lands with M3/M4)

**Ego-first graph.** The app opens on search, not on a 20k-node hairball.
Selecting a contact renders their 1-2 hop neighborhood with expand affordances;
full-graph mode is an explicit action.

**One command palette.** Search and app commands share a single Cmd/Ctrl+K
surface; the palette is the app's front door.

**Undo-first deletes.** No confirm dialogs: soft-delete immediately, offer Undo
in a toast, keep the trash view as the safety net.

**First-run experience.** Welcome screen with vCard/CSV import CTA and an
optional sample network (reusing the fixture generator), plus a status footer
showing last-backup time and DB health.
