// registry.js - the single table every IPC channel lives in.
//
// One entry per channel: { validate, handle }. registerIpc() wraps each entry
// with sender verification, payload validation, and IpcError encoding, then
// registers it on ipcMain. The channel list here, the preload bridge, and
// IpcContract in types.d.ts are asserted equal by test/ipc-contract.test.js,
// so the three cannot drift apart.
//
// Write handlers keep the in-memory GraphStore in sync with SQLite.

const fs = require("fs");
const config = require("../config");
const contacts = require("../db/contacts");
const edges = require("../db/edges");
const interactions = require("../db/interactions");
const tags = require("../db/tags");
const searches = require("../db/searches");
const meta = require("../db/meta");
const { searchCities } = require("../geocode");
const { fetchTile } = require("../maptiles");
const { CITY_COORDS } = require("../../shared/cities");
const path = require("path");
const { takeBackup, listBackups, snapshotInfo } = require("../db");
const { buildGraphML } = require("../ingest/graphml");
const { seedSample } = require("../db/sample");
const dedup = require("../dedup/engine");
const { clearAll } = require("../db/maintenance");
const { parseVCard } = require("../ingest/vcard");
const { parseCSV, suggestMapping, rowsToContacts } = require("../ingest/csv");
const { importContacts } = require("../ingest/importer");
const { exportArchive, importArchive, readArchive, MAGIC } = require("../ingest/archive");
const { AppError, toTransportError } = require("./errors");
const v = require("./validate");

/**
 * The renderer is untrusted: file paths are only honored when the user picked
 * them through a main-process dialog this session (ctx.grantedPaths). Blocks a
 * compromised renderer from reading or writing arbitrary files via import and
 * export channels.
 */
function requireGranted(ctx, p) {
  if (!ctx.grantedPaths || !ctx.grantedPaths.has(p)) {
    throw new AppError("VALIDATION", "Choose the file through the file dialog first.");
  }
  return p;
}

function detectImportKind(srcPath) {
  const lower = srcPath.toLowerCase();
  if (lower.endsWith(".vcf") || lower.endsWith(".vcard")) return "vcard";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".orbit")) return "archive";
  throw new AppError("VALIDATION", "Unsupported file type. Use .vcf, .csv, or .orbit.");
}

function readImportFile(srcPath) {
  let stat;
  try {
    stat = fs.statSync(srcPath);
  } catch {
    throw new AppError("NOT_FOUND", "That file does not exist.");
  }
  if (stat.size > config.limits.importMaxBytes) {
    throw new AppError("VALIDATION", "File is too large to import.");
  }
  return fs.readFileSync(srcPath, "utf8");
}

function parseForImport(srcPath, kind, mapping) {
  if (kind === "vcard") return parseVCard(readImportFile(srcPath));
  const { headers, rows } = parseCSV(readImportFile(srcPath));
  return rowsToContacts(headers, rows, mapping ?? suggestMapping(headers));
}

const patchShape = v.obj({
  name: v.opt((x, n) => v.str(x, n, { min: 1, max: config.limits.nameMax })),
  fields: v.opt(v.fields),
  starred: v.opt(v.bool),
  cadenceDays: v.opt((x, n) => v.int(x, n, { min: 0, max: 3650 })), // 0 clears
});

const metric = (x, name) =>
  x === "degree" || x === "betweenness" ? x : v.fail(`${name} must be "degree" or "betweenness".`);

/** Invalidate derived caches after any write that changes the data. */
function dirty(ctx) {
  if (ctx.centrality) ctx.centrality.bump();
  if (ctx.explore) ctx.explore.markDirty();
}

const strList = (max) => v.arr((x, n) => v.str(x, n, { min: 1, max: 80 }), { max });
const exploreFilters = v.obj({
  orgs: v.opt(strList(50)),
  tags: v.opt(strList(50)),
  edgeTypes: v.opt(strList(20)),
  status: v.opt(strList(10)),
  degreeBuckets: v.opt(strList(10)),
});
const exploreSort = (x, n) =>
  ["name", "org", "degree", "recent", "overdue"].includes(x) ? x : v.fail(`${n} must be name|org|degree|recent|overdue.`);
const exploreScope = (x, n) => ["all", "family", "friends"].includes(x) ? x : v.fail(`${n} must be all|family|friends.`);

/**
 * @param {{ db: any, graph: import('../graph/store').GraphStore, backupDir: string, key: string,
 *           search: import('../search/service').SearchService,
 *           layout: import('../graph/layout-service').LayoutService,
 *           centrality: import('../graph/centrality-service').CentralityService,
 *           explore: import('../explore/service').ExploreService,
 *           sendLayoutTick: (positions: Record<number, {x: number, y: number}>) => void,
 *           dialog: { openFile: (p: any) => any, saveFile: (p: any) => any },
 *           grantedPaths: Set<string>, dbPath: string, appVersion: string, logPath: string,
 *           restoreLatestAndRelaunch: () => any,
 *           restoreSnapshotAndRelaunch: (file: string) => any }} ctx
 */
function buildRegistry(ctx) {
  return {
    "contacts:list": {
      validate: v.obj({ includeDeleted: v.opt(v.bool) }),
      handle: (p) => contacts.list(ctx.db, p),
    },
    "contacts:get": {
      validate: v.obj({ id: v.req(v.id) }),
      handle: (p) => {
        const c = contacts.get(ctx.db, p.id);
        return c ? { ...c, tags: tags.forContact(ctx.db, c.id) } : null;
      },
    },
    "contacts:create": {
      validate: v.obj({
        name: v.req((x, n) => v.str(x, n, { min: 1, max: config.limits.nameMax })),
        fields: v.opt(v.fields),
      }),
      handle: (p) => {
        const c = contacts.create(ctx.db, p);
        ctx.graph.addContact(c);
        dirty(ctx);
        return c;
      },
    },
    "contacts:update": {
      validate: v.obj({ id: v.req(v.id), patch: v.req((x) => patchShape(x)) }),
      handle: (p) => {
        const c = contacts.update(ctx.db, p);
        ctx.graph.updateContact(c);
        ctx.explore?.markDirty(); // starred/cadence feed Explore facets
        return c;
      },
    },
    "contacts:softDelete": {
      validate: v.obj({ id: v.req(v.id) }),
      handle: (p) => {
        if (p.id === meta.getOwnerContactId(ctx.db)) {
          throw new AppError("VALIDATION", "That's you - the owner contact can't be deleted. Edit it in Settings instead.");
        }
        const r = contacts.softDelete(ctx.db, p.id);
        ctx.graph.removeContact(p.id); // drops incident edges too
        dirty(ctx);
        return r;
      },
    },
    "contacts:purge": {
      validate: v.obj({ id: v.req(v.id) }),
      handle: (p) => contacts.purge(ctx.db, p.id), // trashed-only; UI confirms
    },
    "contacts:restore": {
      validate: v.obj({ id: v.req(v.id) }),
      handle: (p) => {
        const c = contacts.restore(ctx.db, p.id);
        ctx.graph.addContact(c);
        for (const e of edges.listFor(ctx.db, c.id)) {
          if (ctx.graph.hasNode(e.sourceId) && ctx.graph.hasNode(e.targetId)) {
            ctx.graph.addEdge(e);
          }
        }
        dirty(ctx);
        return c;
      },
    },

    "edges:create": {
      validate: v.obj({
        sourceId: v.req(v.id),
        targetId: v.req(v.id),
        type: v.req((x, n) => v.str(x, n, { min: 1, max: config.limits.edgeTypeMax })),
        directed: v.req(v.bool),
        metadata: v.opt(v.metadata),
      }),
      handle: (p) => {
        const e = edges.create(ctx.db, p);
        ctx.graph.addEdge(e);
        dirty(ctx);
        return e;
      },
    },
    "edges:delete": {
      validate: v.obj({
        sourceId: v.req(v.id),
        targetId: v.req(v.id),
        type: v.req((x, n) => v.str(x, n, { min: 1, max: config.limits.edgeTypeMax })),
      }),
      handle: (p) => {
        const r = edges.remove(ctx.db, p);
        ctx.graph.removeEdge(p);
        dirty(ctx);
        return r;
      },
    },
    "edges:list": {
      validate: v.obj({ contactId: v.req(v.id) }),
      handle: (p) => edges.listFor(ctx.db, p.contactId),
    },
    "edges:update": {
      validate: v.obj({
        sourceId: v.req(v.id),
        targetId: v.req(v.id),
        type: v.req((x, n) => v.str(x, n, { min: 1, max: config.limits.edgeTypeMax })),
        newType: v.opt((x, n) => v.str(x, n, { min: 1, max: config.limits.edgeTypeMax })),
        metadata: v.opt(v.metadata),
      }),
      handle: (p) => {
        const e = edges.changeType(ctx.db, p);
        ctx.graph.removeEdge({ sourceId: p.sourceId, targetId: p.targetId, type: p.type });
        ctx.graph.addEdge(e);
        dirty(ctx);
        return e;
      },
    },

    // The owner ("you") - an app_meta singleton, not a graph node.
    "profile:get": {
      validate: v.obj({}),
      handle: () => meta.getProfile(ctx.db),
    },
    "profile:set": {
      validate: v.obj({
        name: v.opt((x, n) => v.str(x, n, { max: 200 })),
        gender: v.opt((x, n) => v.str(x, n, { max: 60 })),
        email: v.opt((x, n) => v.str(x, n, { max: 320 })),
        phone: v.opt((x, n) => v.str(x, n, { max: 60 })),
        company: v.opt((x, n) => v.str(x, n, { max: 200 })),
        role: v.opt((x, n) => v.str(x, n, { max: 200 })),
      }),
      handle: (p) => {
        const profile = meta.setProfile(ctx.db, p); // creates/updates the owner contact
        ctx.graph.hydrate(ctx.db); // the owner node may be new
        dirty(ctx);
        return profile;
      },
    },
    // Point "you" at an existing contact (import/restore where you're already in
    // the data). Re-hydrates so the owner node picks up its gold styling.
    "profile:setOwner": {
      validate: v.obj({ contactId: v.req(v.id) }),
      handle: (p) => {
        const profile = meta.setOwnerContact(ctx.db, p.contactId);
        ctx.graph.hydrate(ctx.db);
        dirty(ctx);
        return profile;
      },
    },

    // Location autocomplete: opt-in online city search (main-process fetch only).
    "location:search": {
      validate: v.obj({ query: v.req((x, n) => v.str(x, n, { min: 1, max: 500 })) }),
      handle: async (p) => {
        if (meta.get(ctx.db, "location.online") !== "1") return []; // gated on the opt-in
        return searchCities(p.query);
      },
    },
    "location:online": {
      validate: v.obj({}),
      handle: () => ({ enabled: meta.get(ctx.db, "location.online") === "1" }),
    },
    // Online map tiles (OpenStreetMap), gated on the same opt-in. Fetched in the
    // main process, returned as a data: URL; null when off/offline so the
    // renderer falls back to its bundled vector map.
    "map:tile": {
      validate: v.obj({
        z: v.req((x, n) => v.int(x, n, { min: 0, max: config.map.maxZoom })),
        x: v.req((x, n) => v.int(x, n, { min: 0, max: (1 << config.map.maxZoom) - 1 })),
        y: v.req((x, n) => v.int(x, n, { min: 0, max: (1 << config.map.maxZoom) - 1 })),
        theme: v.opt((x, n) => v.str(x, n, { max: 8 })),
        layer: v.opt((x, n) => x === "base" || x === "labels" ? x : v.fail(`${n} must be base|labels`)),
      }),
      handle: async (p) => {
        if (meta.get(ctx.db, "location.online") !== "1") return { dataUrl: null };
        const r = await fetchTile(p.z, p.x, p.y, p.theme === "light" ? "light" : "dark", p.layer);
        return { dataUrl: r ? r.dataUrl : null };
      },
    },
    "location:setOnline": {
      validate: v.obj({ enabled: v.req(v.bool) }),
      handle: (p) => {
        meta.set(ctx.db, "location.online", p.enabled ? "1" : "0");
        return { enabled: p.enabled };
      },
    },
    // Backfill coordinates for existing contacts that have a location but no geo:
    // bundled city coords first (offline), then the online geocoder for the rest
    // when it's enabled (throttled + capped).
    "location:backfill": {
      validate: v.obj({}),
      handle: async () => {
        const rows = ctx.db.prepare("SELECT id, fields FROM contacts WHERE deleted_at IS NULL").all();
        const upd = ctx.db.prepare("UPDATE contacts SET fields = ?, updated_at = ? WHERE id = ?");
        let updated = 0;
        const pending = [];
        // Offline pass (bundled city coords) commits as one transaction; the
        // online pass below stays incremental because each row awaits a fetch.
        ctx.db.transaction(() => {
          for (const r of rows) {
            const f = r.fields ? JSON.parse(r.fields) : {};
            if (!f.location || f.geo) continue;
            const c = CITY_COORDS[f.location];
            if (c) {
              f.geo = `${c[0]},${c[1]}`;
              f.place = f.location;
              f.locationPrecision = "city";
              f.locationSource = "offline-city";
              upd.run(JSON.stringify(f), Date.now(), r.id); updated++;
            }
            else pending.push({ id: r.id, f });
          }
        })();
        if (meta.get(ctx.db, "location.online") === "1") {
          for (const p of pending.slice(0, 40)) {
            const results = await searchCities(p.f.location);
            if (results[0]) {
              const hit = results[0];
              p.f.geo = `${hit.lat},${hit.lon}`;
              p.f.place = hit.place;
              p.f.locationPrecision = hit.precision;
              p.f.locationSource = hit.source;
              p.f.locationResolved = JSON.stringify({ v: 1, components: hit.components, osm: hit.osm });
              upd.run(JSON.stringify(p.f), Date.now(), p.id); updated++;
            }
            await new Promise((res) => setTimeout(res, 200)); // be polite to the geocoder
          }
        }
        if (updated) { ctx.graph.hydrate(ctx.db); dirty(ctx); }
        return { updated };
      },
    },

    "interactions:list": {
      validate: v.obj({ contactId: v.req(v.id) }),
      handle: (p) => interactions.list(ctx.db, p),
    },
    "interactions:add": {
      validate: v.obj({
        contactId: v.req(v.id),
        occurredAt: v.req((x, n) => v.int(x, n, { min: 0, max: 9999999999999 })),
        kind: v.opt((x, n) => v.str(x, n, { max: 64 })),
        note: v.opt((x, n) => v.str(x, n, { max: config.limits.noteMax })),
      }),
      handle: (p) => {
        const r = interactions.add(ctx.db, p);
        ctx.explore?.markDirty(); // recency drives overdue/dormant facets
        return r;
      },
    },

    "graph:snapshot": {
      validate: v.obj({}),
      handle: () => {
        const snap = ctx.graph.snapshot();
        const rows = ctx.db.prepare("SELECT contact_id, x, y FROM layout_positions").all();
        const pos = new Map(rows.map((r) => [r.contact_id, r]));
        const lastRows = ctx.db
          .prepare("SELECT contact_id, MAX(occurred_at) AS at FROM interactions GROUP BY contact_id")
          .all();
        const last = new Map(lastRows.map((r) => [r.contact_id, r.at]));
        for (const n of snap.nodes) {
          const p = pos.get(n.id);
          if (p) { n.x = p.x; n.y = p.y; }
          n.lastInteractionAt = last.get(n.id) ?? null;
        }
        return snap;
      },
    },
    "graph:ego": {
      validate: v.obj({
        contactId: v.req(v.id),
        depth: v.req((x, n) => v.int(x, n, { min: 0, max: config.graph.egoDepthMax })),
      }),
      handle: (p) => ctx.graph.ego(p.contactId, p.depth),
    },
    "graph:path": {
      validate: v.obj({ fromId: v.req(v.id), toId: v.req(v.id) }),
      handle: (p) => ctx.graph.path(p.fromId, p.toId),
    },
    "graph:centrality": {
      validate: v.obj({ metric: v.req(metric) }),
      handle: (p) => {
        if (p.metric === "degree") return ctx.graph.degreeCentrality();
        // Betweenness is O(V*E): worker-only, on-demand, cached.
        return ctx.centrality.betweenness();
      },
    },
    "graph:layoutStart": {
      validate: v.obj({}),
      handle: () => ctx.layout.start(ctx.graph, ctx.sendLayoutTick),
    },
    "graph:layoutStop": {
      validate: v.obj({}),
      handle: () => ctx.layout.stop(),
    },
    "graph:savePositions": {
      validate: v.obj({ positions: v.req(v.positions) }),
      handle: (p) => {
        ctx.layout.persist(p.positions);
        return { ok: true };
      },
    },

    "tags:list": {
      validate: v.obj({}),
      handle: () => tags.list(ctx.db),
    },
    "contacts:setTags": {
      validate: v.obj({
        id: v.req(v.id),
        tags: v.req(v.arr((x, n) => v.str(x, n, { min: 1, max: 60 }), { max: 100 })),
      }),
      handle: (p) => {
        const r = tags.setForContact(ctx.db, p);
        ctx.explore?.markDirty(); // tags are an Explore facet
        return r;
      },
    },

    "search:query": {
      validate: v.obj({
        text: v.req((x, n) => v.str(x, n, { max: 500 })),
        requestId: v.req((x, n) => v.int(x, n, { min: 0 })),
        limit: v.opt((x, n) => v.int(x, n, { min: 1, max: 200 })),
      }),
      handle: (p) => ctx.search.query(p),
    },

    "backup:now": {
      validate: v.obj({}),
      handle: () => {
        const p = takeBackup(ctx.db, ctx.backupDir, { key: ctx.key });
        return { path: p, createdAt: Date.now(), ok: true };
      },
    },
    "backup:status": {
      validate: v.obj({}),
      handle: () => {
        const counts = ctx.db
          .prepare(
            `SELECT
               SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
               SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed
             FROM contacts`
          )
          .get();
        const edgeCount = ctx.db
          .prepare(
            `SELECT COUNT(*) c FROM edges e
               JOIN contacts a ON a.id = e.source_id AND a.deleted_at IS NULL
               JOIN contacts b ON b.id = e.target_id AND b.deleted_at IS NULL`
          )
          .get().c;
        const backups = listBackups(ctx.backupDir);
        let dbSizeBytes = 0;
        let lastBackupAt = null;
        try {
          dbSizeBytes = fs.statSync(ctx.dbPath).size;
        } catch {}
        if (backups.length) {
          try {
            lastBackupAt = Math.round(fs.statSync(backups[0]).mtimeMs);
          } catch {}
        }
        return {
          appVersion: ctx.appVersion,
          dbPath: ctx.dbPath,
          dbSizeBytes,
          encrypted: true,
          contacts: counts.live ?? 0,
          edges: edgeCount,
          trashed: counts.trashed ?? 0,
          backupDir: ctx.backupDir,
          backupCount: backups.length,
          backupKeep: config.backup.keep,
          backupIntervalMin: Math.round(config.backup.intervalMs / 60000),
          lastBackupAt,
          autoPurgeDays: config.trash.autoPurgeDays,
          logPath: ctx.logPath,
        };
      },
    },
    // Backups for the restore picker, newest first, each with the details needed
    // to choose confidently: when it was taken, how many contacts it holds,
    // whether it opens cleanly, and whether it's an automatic vs pre-update one.
    "backup:list": {
      validate: v.obj({}),
      handle: () => {
        return listBackups(ctx.backupDir).map((f) => {
          const base = path.basename(f);
          let sizeBytes = 0, mtimeMs = 0;
          try { const st = fs.statSync(f); sizeBytes = st.size; mtimeMs = Math.round(st.mtimeMs); } catch {}
          const m = base.match(/-(\d{13})-\d+\.db$/); // contacts-<ms>-<seq>.db
          const info = snapshotInfo(f, ctx.key);
          return {
            name: base,
            takenAt: m ? Number(m[1]) : mtimeMs,
            sizeBytes,
            contacts: info.contacts,
            ok: info.ok,
            kind: base.startsWith("pre-migration") ? "pre-migration" : "auto",
          };
        });
      },
    },
    "backup:restoreLatest": {
      validate: v.obj({}),
      handle: () => ctx.restoreLatestAndRelaunch(),
    },
    // Restore a specific snapshot chosen in the picker. The name must be a bare
    // filename living in the backups dir (no path traversal).
    "backup:restore": {
      validate: v.obj({ name: v.req((x, n) => v.str(x, n, { min: 1, max: 200 })) }),
      handle: (p) => {
        if (path.basename(p.name) !== p.name) throw new AppError("VALIDATION", "Invalid backup name.");
        const file = path.join(ctx.backupDir, p.name);
        if (!fs.existsSync(file)) throw new AppError("NOT_FOUND", "That backup no longer exists.");
        return ctx.restoreSnapshotAndRelaunch(file);
      },
    },
    "backup:delete": {
      validate: v.obj({ name: v.req((x, n) => v.str(x, n, { min: 1, max: 200 })) }),
      handle: (p) => {
        if (path.basename(p.name) !== p.name || !p.name.endsWith(".db")) {
          throw new AppError("VALIDATION", "Invalid backup name.");
        }
        const file = path.join(ctx.backupDir, p.name);
        if (!fs.existsSync(file)) throw new AppError("NOT_FOUND", "That backup no longer exists.");
        fs.unlinkSync(file);
        return { name: p.name, deleted: true };
      },
    },
    "data:clearAll": {
      validate: v.obj({}),
      handle: () => {
        // Safety net first: a verified snapshot so a mistaken wipe is
        // recoverable via Restore latest backup.
        takeBackup(ctx.db, ctx.backupDir, { key: ctx.key });
        const r = clearAll(ctx.db);
        ctx.graph.hydrate(ctx.db);
        ctx.centrality?.bump();
        ctx.explore?.markDirty();
        return r;
      },
    },

    "insights:summary": {
      validate: v.obj({}),
      handle: () => {
        const I = config.insights;
        const now = Date.now();
        const last = new Map(
          ctx.db
            .prepare("SELECT contact_id, MAX(occurred_at) AS at FROM interactions GROUP BY contact_id")
            .all()
            .map((r) => [r.contact_id, r.at])
        );
        const live = ctx.db
          .prepare("SELECT id, name, fields, cadence_days FROM contacts WHERE deleted_at IS NULL")
          .all();

        const orgCounts = new Map();
        for (const c of live) {
          const org = c.fields ? JSON.parse(c.fields).company : undefined;
          if (org) orgCounts.set(org, (orgCounts.get(org) ?? 0) + 1);
        }
        const orgs = [...orgCounts.entries()]
          .map(([org, count]) => ({ org, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, I.orgsLimit);

        const degrees = ctx.graph.degreeCentrality();
        const connectors = live
          .map((c) => ({ id: c.id, name: c.name, degree: degrees[c.id] ?? 0 }))
          .sort((a, b) => b.degree - a.degree)
          .slice(0, I.connectorsLimit);

        const overdue = live
          .filter((c) => c.cadence_days != null)
          .map((c) => {
            const lastAt = last.get(c.id) ?? null;
            const dueAt = (lastAt ?? 0) + c.cadence_days * 86400000;
            return {
              id: c.id, name: c.name, cadenceDays: c.cadence_days, lastAt,
              overdueDays: Math.floor((now - dueAt) / 86400000),
            };
          })
          .filter((c) => c.overdueDays > 0)
          .sort((a, b) => b.overdueDays - a.overdueDays)
          .slice(0, I.overdueLimit);

        const dormantCutoff = now - I.dormantDays * 86400000;
        const dormant = live
          .map((c) => ({ id: c.id, name: c.name, degree: degrees[c.id] ?? 0, lastAt: last.get(c.id) ?? null }))
          .filter((c) => c.degree > 0 && (c.lastAt == null || c.lastAt < dormantCutoff))
          .sort((a, b) => b.degree - a.degree)
          .slice(0, I.dormantLimit);

        return {
          contacts: live.length,
          edges: ctx.graph.size,
          orgs, connectors, overdue, dormant,
        };
      },
    },

    "explore:query": {
      validate: v.obj({
        text: v.opt((x, n) => v.str(x, n, { max: 500 })),
        filters: v.opt((x) => exploreFilters(x)),
        sort: v.opt(exploreSort),
        scope: v.opt(exploreScope),
        dir: v.opt((x, n) => (x === "asc" || x === "desc" ? x : v.fail(`${n} must be asc|desc.`))),
        limit: v.opt((x, n) => v.int(x, n, { min: 1, max: config.explore.resultLimit })),
      }),
      handle: (p) => ctx.explore.query(p),
    },
    "explore:fieldValues": {
      validate: v.obj({}),
      handle: () => ctx.explore.fieldValues(),
    },

    "find:query": {
      validate: v.obj({
        match: v.opt((x, n) => (x === "all" || x === "any" ? x : v.fail(`${n} must be all|any.`))),
        conditions: v.opt(v.arr((c, n) => {
          if (!v.isPlainObject(c)) v.fail(`${n} must be an object.`);
          return {
            field: v.req((x, nn) => v.str(x, nn, { min: 1, max: 64 }))(c.field, `${n}.field`),
            op: v.req((x, nn) => v.str(x, nn, { min: 1, max: 24 }))(c.op, `${n}.op`),
            value: c.value,
          };
        }, { max: 30 })),
        sort: v.opt(exploreSort),
        dir: v.opt((x, n) => (x === "asc" || x === "desc" ? x : v.fail(`${n} must be asc|desc.`))),
        limit: v.opt((x, n) => v.int(x, n, { min: 1, max: config.explore.resultLimit })),
      }),
      handle: (p) => ctx.explore.find(p),
    },

    "insights:extended": {
      validate: v.obj({}),
      handle: () => ctx.explore.extendedInsights(),
    },
    "insights:breakdown": {
      validate: v.obj({ dimension: v.req((x, n) => v.str(x, n, { min: 1, max: 24 })) }),
      handle: (p) => ctx.explore.breakdown(p.dimension),
    },

    "searches:list": {
      validate: v.obj({ kind: v.opt((x, n) => (x === "text" || x === "find" ? x : v.fail(`${n} must be text|find.`))) }),
      handle: (p) => searches.list(ctx.db, p),
    },
    "searches:save": {
      validate: v.obj({
        name: v.req((x, n) => v.str(x, n, { min: 1, max: 80 })),
        query: v.req((x, n) => v.str(x, n, { min: 1, max: 8000 })), // Find queries are JSON
        kind: v.opt((x, n) => (x === "text" || x === "find" ? x : v.fail(`${n} must be text|find.`))),
      }),
      handle: (p) => searches.save(ctx.db, p),
    },
    "searches:delete": {
      validate: v.obj({ id: v.req(v.id) }),
      handle: (p) => searches.remove(ctx.db, p.id),
    },

    "export:graphml": {
      validate: v.obj({ destPath: v.req((x, n) => v.str(x, n, { min: 1, max: 4096 })) }),
      handle: (p) => {
        requireGranted(ctx, p.destPath);
        fs.writeFileSync(p.destPath, buildGraphML(ctx.graph.snapshot()));
        return { path: p.destPath, ok: true };
      },
    },
    "export:image": {
      validate: v.obj({
        destPath: v.req((x, n) => v.str(x, n, { min: 1, max: 4096 })),
        pngBase64: v.req((x, n) =>
          v.str(x, n, { min: 1, max: Math.ceil((config.limits.imageMaxBytes * 4) / 3) + 8 })
        ),
      }),
      handle: (p) => {
        requireGranted(ctx, p.destPath);
        const buf = Buffer.from(p.pngBase64, "base64");
        // PNG magic guard: refuse to write arbitrary renderer-supplied bytes.
        if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
          throw new AppError("VALIDATION", "Payload is not a PNG.");
        }
        fs.writeFileSync(p.destPath, buf);
        return { path: p.destPath, ok: true };
      },
    },
    "export:archive": {
      validate: v.obj({
        destPath: v.req((x, n) => v.str(x, n, { min: 1, max: 4096 })),
        passphrase: v.opt((x, n) => v.str(x, n, { max: 1024 })),
      }),
      handle: (p) => {
        requireGranted(ctx, p.destPath);
        const r = exportArchive(ctx.db, p);
        return { path: r.path, ok: r.ok };
      },
    },
    "import:archive": {
      validate: v.obj({
        srcPath: v.req((x, n) => v.str(x, n, { min: 1, max: 4096 })),
        passphrase: v.opt((x, n) => v.str(x, n, { max: 1024 })),
        onDuplicate: v.req((x, n) =>
          ["skip", "merge", "keepBoth"].includes(x) ? x : v.fail(`${n} must be skip|merge|keepBoth.`)
        ),
      }),
      handle: (p) => {
        requireGranted(ctx, p.srcPath);
        // Guardrail: snapshot BEFORE importing, same as migrations. Import is
        // the other bulk write that can trash a good DB.
        takeBackup(ctx.db, ctx.backupDir, { key: ctx.key });
        const report = importArchive(ctx.db, p);
        ctx.graph.hydrate(ctx.db);
        dirty(ctx);
        return report;
      },
    },
    "import:preview": {
      validate: v.obj({
        srcPath: v.req((x, n) => v.str(x, n, { min: 1, max: 4096 })),
        passphrase: v.opt((x, n) => v.str(x, n, { max: 1024 })),
      }),
      handle: (p) => {
        requireGranted(ctx, p.srcPath);
        const kind = detectImportKind(p.srcPath);
        if (kind === "archive") {
          const raw = readImportFile(p.srcPath);
          const header = JSON.parse(raw.slice(0, raw.indexOf("\n")));
          if (header.magic !== MAGIC) throw new AppError("VALIDATION", "Not an Orbit archive.");
          if (header.encrypted && !p.passphrase) {
            return { kind, count: header.counts?.contacts ?? 0, sample: [], encrypted: true };
          }
          const { records } = readArchive(p.srcPath, p.passphrase);
          return {
            kind,
            count: records.contacts.length,
            sample: records.contacts.slice(0, 5).map((c) => ({ name: c.name, fields: c.fields })),
            encrypted: !!header.encrypted,
          };
        }
        if (kind === "csv") {
          const { headers, rows } = parseCSV(readImportFile(p.srcPath));
          const mapping = suggestMapping(headers);
          const parsed = rowsToContacts(headers, rows, mapping);
          return {
            kind, count: parsed.length, headers, suggestedMapping: mapping,
            sample: parsed.slice(0, 5).map((c) => ({ name: c.name, fields: c.fields })),
          };
        }
        const cards = parseVCard(readImportFile(p.srcPath));
        return {
          kind, count: cards.length,
          sample: cards.slice(0, 5).map((c) => ({ name: c.name, fields: c.fields })),
        };
      },
    },
    "import:file": {
      validate: v.obj({
        srcPath: v.req((x, n) => v.str(x, n, { min: 1, max: 4096 })),
        kind: v.req((x, n) => (x === "vcard" || x === "csv" ? x : v.fail(`${n} must be vcard|csv.`))),
        mapping: v.opt(v.metadata),
        onDuplicate: v.req((x, n) =>
          ["skip", "merge", "keepBoth"].includes(x) ? x : v.fail(`${n} must be skip|merge|keepBoth.`)
        ),
      }),
      handle: (p) => {
        requireGranted(ctx, p.srcPath);
        takeBackup(ctx.db, ctx.backupDir, { key: ctx.key }); // snapshot before bulk write
        const parsed = parseForImport(p.srcPath, p.kind, p.mapping);
        const r = importContacts(ctx.db, parsed, { onDuplicate: p.onDuplicate });
        ctx.graph.hydrate(ctx.db);
        dirty(ctx);
        return {
          imported: r.imported, merged: r.merged, skipped: r.skipped,
          duplicatesFound: r.duplicatesFound, schemaVersion: 1,
        };
      },
    },

    "dialog:openFile": {
      validate: v.obj({ filters: v.opt(v.dialogFilters) }),
      handle: (p) => ctx.dialog.openFile(p),
    },
    "dialog:saveFile": {
      validate: v.obj({
        defaultName: v.opt((x, n) => v.str(x, n, { max: 255 })),
        filters: v.opt(v.dialogFilters),
      }),
      handle: (p) => ctx.dialog.saveFile(p),
    },

    "dedup:candidates": {
      validate: v.obj({}),
      handle: () => ({ pairs: dedup.candidates(ctx.db) }),
    },
    "dedup:merge": {
      validate: v.obj({ primaryId: v.req(v.id), secondaryId: v.req(v.id) }),
      handle: (p) => {
        const r = dedup.merge(ctx.db, p);
        ctx.graph.hydrate(ctx.db); // merge touches too much to patch in place
        dirty(ctx);
        return r;
      },
    },
    "dedup:undo": {
      validate: v.obj({ mergeId: v.req(v.id) }),
      handle: (p) => {
        const r = dedup.undo(ctx.db, p);
        ctx.graph.hydrate(ctx.db);
        dirty(ctx);
        return r;
      },
    },

    "data:seedSample": {
      validate: v.obj({
        contacts: v.opt((x, n) => v.int(x, n, { min: 1, max: config.sample.maxContacts })),
        dataset: v.opt((x, n) => v.str(x, n, { max: 20 })),
      }),
      handle: (p) => {
        // dataset "small"/"large" map to preset sizes and seed a simulated owner
        // + family; a bare seed (palette) keeps the legacy default size.
        const preset = p.dataset === "small" ? config.sample.small
          : p.dataset === "large" ? config.sample.large : null;
        const count = preset ?? p.contacts;
        const r = seedSample(ctx.db, { count, withOwnerFamily: p.dataset != null });
        // Flag the DB as sample data so every launch can offer to switch/reset.
        meta.set(ctx.db, "sample.dataset", p.dataset ?? "custom");
        ctx.graph.hydrate(ctx.db); // bulk write: rebuild rather than replay
        dirty(ctx);
        return { ...r, dataset: p.dataset ?? "custom" };
      },
    },
    "data:sampleStatus": {
      validate: v.obj({}),
      handle: () => ({ dataset: meta.get(ctx.db, "sample.dataset") }),
    },
  };
}

/**
 * @param {Electron.IpcMain} ipcMain
 * @param {Parameters<typeof buildRegistry>[0]} ctx
 * @returns {string[]} registered channel names
 */
function registerIpc(
  ipcMain,
  ctx,
  /** @type {{ isTrustedSender: (wc: unknown) => boolean, log?: (m: string, err?: unknown) => void }} */
  { isTrustedSender, log = () => {} }
) {
  const registry = buildRegistry(ctx);
  for (const [channel, def] of Object.entries(registry)) {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        if (!isTrustedSender(event.sender)) {
          throw new AppError("VALIDATION", "Untrusted IPC sender.");
        }
        return def.handle(def.validate(payload ?? {}));
      } catch (err) {
        const { transportError, correlationId } = toTransportError(channel, err);
        if (correlationId) log(`[ipc] ${channel} INTERNAL ref=${correlationId}`, err);
        throw transportError;
      }
    });
  }
  return Object.keys(registry);
}

module.exports = { buildRegistry, registerIpc };
