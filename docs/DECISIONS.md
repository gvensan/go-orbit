# Decisions Log

Deliberate amendments to the original scaffold assumptions, per the CLAUDE.md
rule that assumptions change deliberately, not by drift. Newest first.

## 2026-07-22 - Persisted column movement is the table-view standard

- **Explore headers have distinct move, sort, and resize targets.** Drag the
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
- **Opt-in online tiles**: when "Online maps & location search" is on *and* the
  device is online, the Geomap draws OpenStreetMap raster tiles. This is remote
  content, so it is deliberate and gated: **tiles are fetched in the main
  process** (`src/main/maptiles.js`, new `map:tile` IPC channel gated on the same
  `location.online` meta flag) and handed to the renderer as `data:` URLs. The
  **renderer keeps `connect-src 'none'`** - it never touches the network. Tiles
  are cached on disk under `userData/tile-cache`. Falls back to the 50m vector
  map instantly when offline or opted out. Amends the "no remote content"
  guardrail the same way opt-in Photon geocoding already did: main-process fetch,
  explicit consent, renderer stays sandboxed.
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
- **Pin/unpin** (double-click) is session-scoped: pinned nodes are skipped by
  layout ticks; their dragged positions persist through the existing
  savePositions path. Onboarding is a one-time overlay gated by localStorage.
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

**Native module ABI strategy.** No postinstall rebuild. `npm test`,
`npm run migrate`, and scripts run on the Node ABI; `npm run dev` and
`npm run build` rebuild for Electron via pre-hooks (`rebuild:electron`).
Switching costs one prebuilt-binary download. CI's test job therefore runs on
plain Node; the build job's smoke test switches back explicitly.

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
