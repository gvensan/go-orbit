/**
 * Shared domain + IPC contract types for Orbit.
 *
 * This file is the authoritative boundary between the main process, the
 * renderer, and the workers. Both sides import these shapes. In JS files,
 * reference them with JSDoc: `/** @type {import('../shared/types').Contact} *​/`.
 *
 * Every IPC channel below has a request payload and a response shape. The main
 * process validates the payload against these before acting. See
 * docs/INTERFACE_CONTRACT.md for the prose contract and error semantics.
 */

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Unix epoch milliseconds. */
export type Timestamp = number;

export interface Contact {
  id: number;
  name: string;
  /** Flexible per-contact attributes (email, phone, company, role, custom). */
  fields: ContactFields;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Null when live; set when soft-deleted. */
  deletedAt: Timestamp | null;
  /** Populated by contacts:get (not by list, for weight). */
  tags?: string[];
  /** Favorite: pinned in the palette's empty state. */
  starred?: boolean;
  /** "Stay in touch every N days"; null = no cadence. Patch 0 to clear. */
  cadenceDays?: number | null;
}

export interface ContactFields {
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  notes?: string;
  [key: string]: string | undefined; // custom fields
}

/**
 * The exact patch shape contacts:update accepts. Anything else is rejected by
 * validation (strict: unknown keys fail, they are not stripped).
 */
export interface ContactPatch {
  name?: string;
  fields?: ContactFields;
  starred?: boolean;
  /** "Stay in touch every N days"; 0 clears the cadence. */
  cadenceDays?: number;
}

export type EdgeType = "colleague" | "family" | "introduced" | "friend" | string;

export interface Edge {
  sourceId: number;
  targetId: number;
  type: EdgeType;
  directed: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface Interaction {
  id: number;
  contactId: number;
  occurredAt: Timestamp;
  kind?: string; // call | email | meeting | note ...
  note?: string;
}

export interface Tag {
  id: number;
  name: string;
}

/**
 * The owner ("you") - the implicit ego the CRM is built around. Stored as an
 * app_meta singleton, NOT a graph node. All fields optional; a fresh install
 * has an empty profile until the user fills it in (onboarding or Settings).
 */
export interface OwnerProfile {
  name?: string;
  gender?: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
}

// ---------------------------------------------------------------------------
// Graph model (renderer / worker view)
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: number;
  name: string;
  org?: number | string;
  role?: string;
  gender?: string;
  location?: string;
  place?: string;
  /** "lat,lon" captured when the location was entered (for the Geomap). */
  geo?: string;
  /** Resolution granularity: house, street, postcode, district, city, etc. */
  locationPrecision?: string;
  /** Resolver used for the stored coordinates. */
  locationSource?: string;
  deceased?: boolean;
  starred?: boolean;
  /** True for the owner ("you") node - the centre of your network. */
  isOwner?: boolean;
  /** Most recent interaction, for hover cards and recency cues. */
  lastInteractionAt?: Timestamp | null;
  degree: number;
  /** Layout position, when computed/cached. */
  x?: number;
  y?: number;
  /** Louvain community, when computed. */
  community?: number;
}

export interface GraphLink {
  source: number;
  target: number;
  type: EdgeType;
  directed: boolean;
  metadata?: Record<string, unknown>;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  links: GraphLink[];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  /**
   * Raw user text. Operators (org:, tag:, type:, has:email, near:, hops:)
   * are embedded here and parsed by the search engine - there is no separate
   * structured-filters payload.
   */
  text: string;
  /** Monotonic id for cancellation; results with a stale id are discarded. */
  requestId: number;
  limit?: number;
}

export interface SearchResult {
  contactId: number;
  name: string;
  org?: string;
  role?: string;
  degree: number;
  score: number;
  /** Character ranges to highlight, per field. */
  highlights?: { field: string; ranges: [number, number][] }[];
}

export interface SearchResponse {
  requestId: number;
  results: SearchResult[];
  /** Present when recall was empty; phonetic suggestion. */
  didYouMean?: string;
}

// ---------------------------------------------------------------------------
// Graph queries
// ---------------------------------------------------------------------------

export interface EgoQuery { contactId: number; depth: number; }
export interface PathQuery { fromId: number; toId: number; }
export interface PathResult { path: number[]; hops: number; found: boolean; }
export interface CentralityQuery { metric: "degree" | "betweenness"; }

// ---------------------------------------------------------------------------
// Backup / export
// ---------------------------------------------------------------------------

export interface BackupResult { path: string; createdAt: Timestamp; ok: boolean; }

export interface UpdateStatus {
  supported: boolean;
  currentVersion: string;
  phase: "disabled" | "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "blocked" | "error";
  availableVersion: string | null;
  error: string | null;
}

/** Settings/diagnostics snapshot. */
export interface AppStatus {
  appVersion: string;
  dbPath: string;
  dbSizeBytes: number;
  encrypted: boolean;
  contacts: number;
  edges: number;
  trashed: number;
  backupDir: string;
  backupCount: number;
  backupKeep: number;
  backupIntervalMin: number;
  lastBackupAt: Timestamp | null;
  autoPurgeDays: number;
  logPath: string;
}

/** One retained backup, for the restore picker. */
export interface BackupInfo {
  name: string;
  takenAt: Timestamp;
  sizeBytes: number;
  contacts: number | null;
  ok: boolean;
  kind: "auto" | "pre-migration";
}

/** Local network intelligence: stats + who needs attention. */
export interface InsightsSummary {
  contacts: number;
  edges: number;
  orgs: { org: string; count: number }[];
  connectors: { id: number; name: string; degree: number }[];
  /** Cadence set and blown: sorted most-overdue first. */
  overdue: { id: number; name: string; cadenceDays: number; lastAt: Timestamp | null; overdueDays: number }[];
  /** Well-connected but untouched for insights.dormantDays. */
  dormant: { id: number; name: string; degree: number; lastAt: Timestamp | null }[];
}

// ---------------------------------------------------------------------------
// Explore (faceted people-search)
// ---------------------------------------------------------------------------

export interface ExploreFilters {
  orgs?: string[];
  tags?: string[];
  edgeTypes?: EdgeType[];
  /** starred | overdue | dormant | hasEmail | hasPhone */
  status?: string[];
  /** hub | connected | peripheral | isolated */
  degreeBuckets?: string[];
}

export type ExploreSort =
  | "name" | "nickname" | "gender" | "birthday" | "deceased"
  | "email" | "phone" | "org" | "role"
  | "location" | "city" | "county" | "state" | "postcode" | "country"
  | "relationship" | "kin" | "degree" | "tags"
  | "notes" | "recent" | "overdue" | "lastKind" | "lastNote"
  | "interactionCount" | "cadenceDays" | "starred"
  | "website" | "linkedin" | "id" | "createdAt" | "updatedAt";

export interface ExploreQuery {
  text?: string;
  filters?: ExploreFilters;
  sort?: ExploreSort;
  dir?: "asc" | "desc";
  limit?: number;
  scope?: "all" | "family" | "friends";
}

export interface ExploreRow {
  id: number;
  name: string;
  org?: string;
  role?: string;
  email?: string;
  phone?: string;
  gender?: string;
  /** Freeform location field (falls back to the structured place). */
  location?: string;
  /** Kin role, preferring the edge to the owner ("you"), e.g. "brother". */
  kin?: string;
  types: EdgeType[];
  degree: number;
  lastAt: Timestamp | null;
  starred: boolean;
  overdue: boolean;
  cadenceDays: number | null;
  tags: string[];
  notes?: string;
  address?: string;
  birthday?: string;
  nickname?: string;
  deceased: boolean;
  website?: string;
  linkedin?: string;
  place?: string;
  geo?: string;
  locationPrecision?: string;
  locationSource?: string;
  locationName?: string;
  houseNumber?: string;
  street?: string;
  postcode?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  countryCode?: string;
  osmType?: string;
  osmId?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastKind?: string;
  lastNote?: string;
  interactionCount: number;
  isOwner: boolean;
  familyDepth: number;
  familyParentId: number | null;
  dormant: boolean;
}

export interface FacetValue { value: string; label?: string; count: number; }

export interface ExploreResponse {
  total: number;
  results: ExploreRow[];
  /** Ids of the full matched set (capped), for graph focus and bulk actions. */
  matchedIds: number[];
  facets: {
    status: FacetValue[];
    orgs: FacetValue[];
    tags: FacetValue[];
    edgeTypes: FacetValue[];
    degrees: FacetValue[];
  };
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  /** 'text' = palette/Explore free text; 'find' = structured Find JSON. */
  kind: "text" | "find";
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Find (structured query builder)
// ---------------------------------------------------------------------------

export interface FindCondition {
  field: string;
  op: string;
  value?: string | number | boolean | (string | number)[];
}

export interface FindQuery {
  match?: "all" | "any";
  conditions?: FindCondition[];
  sort?: ExploreSort;
  dir?: "asc" | "desc";
  limit?: number;
}

export interface BreakdownResponse {
  dimension: string;
  values: FacetValue[];
  unset: number;
  total: number;
}

export interface InsightsExtended {
  contacts: number;
  edges: number;
  connectors: { id: number; name: string; degree: number }[];
  overdue: { id: number; name: string; cadenceDays: number; lastAt: Timestamp | null; overdueDays: number }[];
  dormant: { id: number; name: string; degree: number; lastAt: Timestamp | null }[];
  recentlyAdded: { id: number; name: string; org?: string; createdAt: Timestamp }[];
  orgs: FacetValue[];
  roles: FacetValue[];
  gender: FacetValue[];
  tags: FacetValue[];
  edgeTypes: FacetValue[];
  cadence: { withCadence: number; overdue: number; total: number };
  connectivity: { isolated: number; hubs: number; avgDegree: number };
  missing: { email: number; phone: number };
}

export interface ExportOptions {
  destPath: string;
  /** When set, the archive is encrypted with a key derived from this. */
  passphrase?: string;
}

export interface ImportOptions {
  srcPath: string;
  passphrase?: string;
  /** How to handle contacts that match existing ones. */
  onDuplicate: "skip" | "merge" | "keepBoth";
}

export interface ImportReport {
  imported: number;
  merged: number;
  skipped: number;
  duplicatesFound: number;
  schemaVersion: number;
}

/** What the import wizard shows before committing. */
export interface ImportPreview {
  kind: "vcard" | "csv" | "archive";
  count: number;
  /** CSV only. */
  headers?: string[];
  suggestedMapping?: Record<string, string>;
  /** First few parsed contacts (name + fields). */
  sample: { name: string; fields: ContactFields }[];
  /** Archive only: needs a passphrase to open. */
  encrypted?: boolean;
}

// ---------------------------------------------------------------------------
// Dedup / merge
// ---------------------------------------------------------------------------

export interface DedupPairSide {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
}

export interface DedupPair {
  aId: number;
  bId: number;
  a: DedupPairSide;
  b: DedupPairSide;
  score: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// IPC channel map — channel name → { request, response }
// ---------------------------------------------------------------------------

export interface IpcContract {
  "contacts:list": { request: { includeDeleted?: boolean }; response: Contact[] };
  "contacts:get": { request: { id: number }; response: Contact | null };
  "contacts:create": { request: { name: string; fields?: ContactFields }; response: Contact };
  "contacts:update": { request: { id: number; patch: ContactPatch }; response: Contact };
  "contacts:softDelete": { request: { id: number }; response: { id: number; deletedAt: Timestamp } };
  "contacts:restore": { request: { id: number }; response: Contact };
  /** Hard-delete from Trash only; the UI confirms first. */
  "contacts:purge": { request: { id: number }; response: { id: number; purged: boolean } };

  "edges:create": { request: Omit<Edge, "createdAt">; response: Edge };
  "edges:delete": { request: { sourceId: number; targetId: number; type: EdgeType }; response: { ok: boolean } };
  "edges:list": { request: { contactId: number }; response: Edge[] };
  "edges:update": { request: { sourceId: number; targetId: number; type: EdgeType; newType?: EdgeType; metadata?: Record<string, unknown> }; response: Edge };
  "profile:get": { request: {}; response: OwnerProfile };
  "profile:set": { request: OwnerProfile; response: OwnerProfile };
  "profile:setOwner": { request: { contactId: number }; response: OwnerProfile };
  "location:search": { request: { query: string }; response: { label: string; lat: number; lon: number; place: string; precision: string; source: string; components: Record<string, string>; osm?: { type?: string; id?: number } }[] };
  "location:online": { request: {}; response: { enabled: boolean } };
  "location:setOnline": { request: { enabled: boolean }; response: { enabled: boolean } };
  "location:backfill": { request: {}; response: { updated: number } };
  "map:tile": { request: { z: number; x: number; y: number; theme?: "light" | "dark"; layer?: "base" | "labels" }; response: { dataUrl: string | null } };

  "interactions:list": { request: { contactId: number }; response: Interaction[] };
  "interactions:add": { request: Omit<Interaction, "id">; response: Interaction };

  "graph:snapshot": { request: {}; response: GraphSnapshot };
  "graph:ego": { request: EgoQuery; response: number[] };
  "graph:path": { request: PathQuery; response: PathResult };
  "graph:centrality": { request: CentralityQuery; response: Record<number, number> };

  "tags:list": { request: {}; response: Tag[] };
  "contacts:setTags": { request: { id: number; tags: string[] }; response: { contact: Contact; tags: string[] } };

  "search:query": { request: SearchQuery; response: SearchResponse };

  "backup:now": { request: {}; response: BackupResult };
  "update:status": { request: {}; response: UpdateStatus };
  "update:check": { request: {}; response: UpdateStatus };
  "backup:status": { request: {}; response: AppStatus };
  /** Wipe ALL data for a fresh start (a safety backup is taken first). */
  "data:clearAll": { request: {}; response: { contacts: number } };
  /** Restore the newest verified snapshot, then relaunch the app. */
  "backup:list": { request: {}; response: BackupInfo[] };
  "backup:restoreLatest": { request: {}; response: { ok: boolean; restoredFrom: string } };
  "backup:restore": { request: { name: string }; response: { ok: boolean; restoredFrom: string } };
  "backup:delete": { request: { name: string }; response: { name: string; deleted: boolean } };

  "insights:summary": { request: {}; response: InsightsSummary };

  "explore:query": { request: ExploreQuery; response: ExploreResponse };
  /** Distinct existing values for common fields (edit-form autocomplete). */
  "explore:fieldValues": { request: {}; response: Record<string, string[]> };

  "find:query": { request: FindQuery; response: ExploreResponse };

  "insights:extended": { request: {}; response: InsightsExtended };
  "insights:breakdown": { request: { dimension: string }; response: BreakdownResponse };

  "searches:list": { request: { kind?: "text" | "find" }; response: SavedSearch[] };
  "searches:save": { request: { name: string; query: string; kind?: "text" | "find" }; response: SavedSearch };
  "searches:delete": { request: { id: number }; response: { ok: boolean } };

  "export:graphml": { request: { destPath: string }; response: { path: string; ok: boolean } };
  /** PNG bytes come from the renderer's canvas; main writes the granted path. */
  "export:image": { request: { destPath: string; pngBase64: string }; response: { path: string; ok: boolean } };
  "export:archive": { request: ExportOptions; response: { path: string; ok: boolean } };
  "import:archive": { request: ImportOptions; response: ImportReport };

  "import:preview": { request: { srcPath: string; passphrase?: string }; response: ImportPreview };
  "import:file": {
    request: {
      srcPath: string;
      kind: "vcard" | "csv";
      mapping?: Record<string, string>;
      onDuplicate: "skip" | "merge" | "keepBoth";
    };
    response: ImportReport;
  };

  "dialog:openFile": {
    request: { filters?: { name: string; extensions: string[] }[] };
    response: { path: string | null };
  };
  "dialog:saveFile": {
    request: { defaultName?: string; filters?: { name: string; extensions: string[] }[] };
    response: { path: string | null };
  };

  "dedup:candidates": { request: {}; response: { pairs: DedupPair[] } };
  "dedup:merge": {
    request: { primaryId: number; secondaryId: number };
    response: { contact: Contact; mergeId: number };
  };
  "dedup:undo": {
    request: { mergeId: number };
    response: { ok: boolean; primaryId: number; secondaryId: number };
  };

  /** First-run/dev helper: seed a deterministic sample network. */
  "data:seedSample": { request: { contacts?: number; dataset?: string }; response: { contacts: number; edges: number; dataset: string } };
  "data:sampleStatus": { request: {}; response: { dataset: string | null } };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]["request"];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]["response"];

/** Uniform error shape returned (rejected) across every channel. */
export interface IpcError {
  channel: IpcChannel;
  code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "LOCKED" | "INTERNAL";
  message: string;
}

// ---------------------------------------------------------------------------
// Renderer bridge — the shape preload.js exposes as window.api
// ---------------------------------------------------------------------------

type Call<C extends IpcChannel> = (payload: IpcRequest<C>) => Promise<IpcResponse<C>>;

export interface RendererApi {
  contacts: {
    list: Call<"contacts:list">;
    get: Call<"contacts:get">;
    create: Call<"contacts:create">;
    update: Call<"contacts:update">;
    softDelete: Call<"contacts:softDelete">;
    restore: Call<"contacts:restore">;
    purge: Call<"contacts:purge">;
    setTags: Call<"contacts:setTags">;
  };
  edges: {
    create: Call<"edges:create">;
    delete: Call<"edges:delete">;
    list: Call<"edges:list">;
    update: Call<"edges:update">;
  };
  profile: {
    get: Call<"profile:get">;
    set: Call<"profile:set">;
    setOwner: Call<"profile:setOwner">;
  };
  location: {
    search: Call<"location:search">;
    online: Call<"location:online">;
    setOnline: Call<"location:setOnline">;
    backfill: Call<"location:backfill">;
  };
  map: {
    tile: Call<"map:tile">;
  };
  interactions: {
    list: Call<"interactions:list">;
    add: Call<"interactions:add">;
  };
  tags: {
    list: Call<"tags:list">;
  };
  graph: {
    snapshot: Call<"graph:snapshot">;
    ego: Call<"graph:ego">;
    path: Call<"graph:path">;
    centrality: Call<"graph:centrality">;
  };
  search: {
    query: Call<"search:query">;
  };
  app: {
    /** Native menu command ids; returns an unsubscribe fn. */
    onMenu: (cb: (id: string) => void) => () => void;
  };
  updates: {
    status: Call<"update:status">;
    check: Call<"update:check">;
  };
  dedup: {
    candidates: Call<"dedup:candidates">;
    merge: Call<"dedup:merge">;
    undo: Call<"dedup:undo">;
  };
  dialogs: {
    openFile: Call<"dialog:openFile">;
    saveFile: Call<"dialog:saveFile">;
  };
  insights: {
    summary: Call<"insights:summary">;
  };
  explore: {
    query: Call<"explore:query">;
    fieldValues: Call<"explore:fieldValues">;
  };
  find: {
    query: Call<"find:query">;
  };
  insightsExt: {
    extended: Call<"insights:extended">;
    breakdown: Call<"insights:breakdown">;
  };
  searches: {
    list: Call<"searches:list">;
    save: Call<"searches:save">;
    delete: Call<"searches:delete">;
  };
  data: {
    backupNow: Call<"backup:now">;
    backupStatus: Call<"backup:status">;
    backupList: Call<"backup:list">;
    restoreLatest: Call<"backup:restoreLatest">;
    restoreBackup: Call<"backup:restore">;
    deleteBackup: Call<"backup:delete">;
    clearAll: Call<"data:clearAll">;
    exportArchive: Call<"export:archive">;
    exportGraphML: Call<"export:graphml">;
    exportImage: Call<"export:image">;
    importArchive: Call<"import:archive">;
    importPreview: Call<"import:preview">;
    importFile: Call<"import:file">;
    seedSample: Call<"data:seedSample">;
    sampleStatus: Call<"data:sampleStatus">;
  };
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
