// search/engine.js - the query pipeline, pure and Electron-free so it tests
// under plain Node and runs identically inside the search worker.
//
// SEARCH_REQUIREMENTS §5/§7/§8: FTS5 prefix recall with per-field BM25 weights
// (AND, then forgiving OR), trigram recall for mid-word fragments, a
// last-resort fuzzy name scan (Jaro-Winkler + Damerau-Levenshtein) for typo
// recall, operators (org: tag: type: has:email near: hops:), recency and
// degree boosts, and a did-you-mean suggestion when recall is empty.
// All weights live in config.search.

const config = require("../config");

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/** Tokenize free text; strip FTS metacharacters. */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((t) => t.replace(/["'*^:()[\]{}]/g, ""))
    .filter(Boolean)
    .slice(0, 8);
}

/** FTS5 MATCH string: every token as a prefix phrase, implicit AND. */
function ftsQuery(tokens) {
  return tokens.map((t) => `"${t}"*`).join(" ");
}

// Jaro-Winkler similarity, 0..1. Standard formulation, prefix scale 0.1.
function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const matchA = new Array(la).fill(false);
  const matchB = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(lb - 1, i + window);
    for (let j = from; j <= to; j++) {
      if (!matchB[j] && a[i] === b[j]) {
        matchA[i] = matchB[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!matchA[i]) continue;
    while (!matchB[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro =
    (matches / la + matches / lb + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, la, lb) && a[i] === b[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Damerau-Levenshtein distance (optimal string alignment variant). */
function damerauLevenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  let prev2 = null;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const row = [i];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prev2[j - 2] + cost);
      }
      row.push(val);
    }
    prev2 = prev;
    prev = row;
  }
  return prev[lb];
}

/** Token similarity: best of Jaro-Winkler and normalized edit distance. */
function tokenSimilarity(a, b) {
  const jw = jaroWinkler(a, b);
  const dl = 1 - damerauLevenshtein(a, b) / Math.max(a.length, b.length);
  return Math.max(jw, dl);
}

/** Best per-query-token similarity over name tokens, order-independent. */
function nameSimilarity(queryTokens, name) {
  const nameTokens = name.toLowerCase().split(/\s+/).filter(Boolean);
  if (!queryTokens.length || !nameTokens.length) return 0;
  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const n of nameTokens) best = Math.max(best, tokenSimilarity(q, n));
    total += best;
  }
  return total / queryTokens.length;
}

// ---------------------------------------------------------------------------
// Operator parsing: `org:Globex tag:vip type:introduced has:email
// near:"Alice Chen" hops:2` mixed freely with fuzzy text.
// ---------------------------------------------------------------------------

const OPERATOR_RE = /\b(org|tag|type|has|near|hops):("([^"]*)"|(\S+))/gi;

/**
 * @param {string} text
 * @returns {{ tokens: string[], filters: { org?: string, tags: string[],
 *   edgeType?: string, hasEmail?: boolean, near?: string, hops: number } }}
 */
function parseQuery(text) {
  const filters = { tags: [], hops: 1 };
  const free = text.replace(OPERATOR_RE, (_m, op, _q, quoted, bare) => {
    const value = (quoted ?? bare ?? "").toLowerCase();
    if (op === "org") filters.org = value;
    else if (op === "tag") filters.tags.push(value);
    else if (op === "type") filters.edgeType = value;
    else if (op === "has" && value === "email") filters.hasEmail = true;
    else if (op === "near") filters.near = value;
    else if (op === "hops") filters.hops = Math.max(1, Math.min(config.search.hopsMax, parseInt(value, 10) || 1));
    return " ";
  });
  return { tokens: tokenize(free), filters };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function prepareStatements(db) {
  const S = config.search;
  const w = S.fieldWeights;
  // contacts_fts column order: name, email, phone, company, role, tags, notes
  const weights = [w.name, w.email, w.phone, w.company, w.role, w.tags, w.notes].join(", ");
  const CANDIDATE_COLS = "s.id, s.name, s.company, s.role, s.email, s.tags";
  return {
    db, // BFS needs chunked ad-hoc IN queries
    fts: db.prepare(
      `SELECT ${CANDIDATE_COLS}, bm25(contacts_fts, ${weights}) AS rank
         FROM contacts_fts f
         JOIN contacts_search s ON s.id = f.rowid
         JOIN contacts c ON c.id = s.id AND c.deleted_at IS NULL
        WHERE contacts_fts MATCH ?
        ORDER BY rank
        LIMIT ?`
    ),
    trigram: db.prepare(
      `SELECT ${CANDIDATE_COLS}, bm25(contacts_trigram) AS rank
         FROM contacts_trigram f
         JOIN contacts_search s ON s.id = f.rowid
         JOIN contacts c ON c.id = s.id AND c.deleted_at IS NULL
        WHERE contacts_trigram MATCH ?
        ORDER BY rank
        LIMIT ?`
    ),
    all: db.prepare(
      `SELECT ${CANDIDATE_COLS}, 0 AS rank
         FROM contacts_search s
         JOIN contacts c ON c.id = s.id AND c.deleted_at IS NULL`
    ),
    byName: db.prepare(
      `SELECT s.id FROM contacts_search s
         JOIN contacts c ON c.id = s.id AND c.deleted_at IS NULL
        WHERE lower(s.name) = ? LIMIT 1`
    ),
    degree: db.prepare(
      `SELECT COUNT(*) AS d
         FROM edges e
         JOIN contacts s ON s.id = e.source_id AND s.deleted_at IS NULL
         JOIN contacts t ON t.id = e.target_id AND t.deleted_at IS NULL
        WHERE e.source_id = @id OR e.target_id = @id`
    ),
    lastInteraction: db.prepare(
      "SELECT MAX(occurred_at) AS at FROM interactions WHERE contact_id = ?"
    ),
    hasEdgeType: db.prepare(
      "SELECT 1 FROM edges WHERE (source_id = @id OR target_id = @id) AND type = @type LIMIT 1"
    ),
  };
}

/** Breadth-first neighborhood via SQL, chunked IN lists. Includes the center. */
function bfsIds(db, startId, hops) {
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let d = 0; d < hops && frontier.length; d++) {
    const next = [];
    for (let i = 0; i < frontier.length; i += 400) {
      const chunk = frontier.slice(i, i + 400);
      const marks = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT e.source_id AS s, e.target_id AS t
             FROM edges e
             JOIN contacts a ON a.id = e.source_id AND a.deleted_at IS NULL
             JOIN contacts b ON b.id = e.target_id AND b.deleted_at IS NULL
            WHERE e.source_id IN (${marks}) OR e.target_id IN (${marks})`
        )
        .all(...chunk, ...chunk);
      for (const r of rows) {
        for (const id of [r.s, r.t]) {
          if (!seen.has(id)) {
            seen.add(id);
            next.push(id);
          }
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function applyFilters(stmts, candidates, filters) {
  let out = candidates;
  if (filters.org) out = out.filter((c) => (c.company || "").toLowerCase().includes(filters.org));
  if (filters.tags.length) {
    out = out.filter((c) => {
      const tags = (c.tags || "").toLowerCase().split(/\s+/);
      return filters.tags.every((t) => tags.includes(t));
    });
  }
  if (filters.hasEmail) out = out.filter((c) => (c.email || "").length > 0);
  if (filters.edgeType) {
    out = out.filter((c) => stmts.hasEdgeType.get({ id: c.id, type: filters.edgeType }));
  }
  if (filters.near) {
    const anchor = stmts.byName.get(filters.near);
    if (!anchor) return []; // unknown anchor: empty, did-you-mean may fire
    const hood = bfsIds(stmts.db, anchor.id, filters.hops);
    out = out.filter((c) => hood.has(c.id));
  }
  return out;
}

/**
 * @param {ReturnType<typeof prepareStatements>} stmts
 * @param {{ text: string, requestId: number, limit?: number }} query
 * @returns {import('../../shared/types').SearchResponse}
 */
function search(stmts, query) {
  const S = config.search;
  const limit = Math.min(query.limit ?? S.limit, 200);
  const { tokens, filters } = parseQuery(query.text);
  const hasFilters =
    filters.org || filters.tags.length || filters.hasEmail || filters.edgeType || filters.near;
  if (!tokens.length && !hasFilters) return { requestId: query.requestId, results: [] };

  // ---- Stage 1: candidate recall ----
  let candidates = [];
  if (tokens.length) {
    candidates = stmts.fts.all(ftsQuery(tokens), S.candidateK);
    if (!candidates.length && tokens.length > 1) {
      candidates = stmts.fts.all(tokens.map((t) => `"${t}"*`).join(" OR "), S.candidateK);
    }
    if (!candidates.length) {
      const tri = tokens.filter((t) => t.length >= 3);
      if (tri.length) {
        candidates = stmts.trigram.all(tri.map((t) => `"${t}"`).join(" "), S.candidateK);
      }
    }
    if (candidates.length < 20) {
      // Fuzzy name scan (typo recall: "Jhon Smyth" -> "John Smith"). Runs
      // whenever exact recall is thin, merged so partial matches from FTS
      // don't crowd out close-but-misspelled names.
      const have = new Set(candidates.map((c) => c.id));
      const worstRank = candidates.length ? Math.max(...candidates.map((c) => c.rank)) : 0;
      for (const c of stmts.all.all()) {
        if (have.has(c.id)) continue;
        if (nameSimilarity(tokens, c.name) >= S.fuzzyScanMin) {
          candidates.push({ ...c, rank: worstRank, scanned: true }); // no BM25 signal
          if (candidates.length >= S.candidateK) break;
        }
      }
    }
  } else {
    candidates = stmts.all.all(); // pure operator query, e.g. near:"Alice" hops:2
  }

  candidates = applyFilters(stmts, candidates, filters);

  // ---- Empty: offer a phonetic-ish suggestion ----
  if (!candidates.length) {
    let didYouMean;
    if (tokens.length) {
      let best = null, bestScore = 0;
      for (const c of stmts.all.all()) {
        const s = nameSimilarity(tokens, c.name);
        if (s > bestScore) { bestScore = s; best = c.name; }
      }
      if (best && bestScore >= S.didYouMeanMin) didYouMean = best;
    }
    return { requestId: query.requestId, results: [], didYouMean };
  }

  // ---- Stage 2: re-rank ----
  const now = Date.now();
  const halfLifeMs = S.recencyHalfLifeDays * 86400000;
  const fromFts = candidates.filter((c) => !c.scanned);
  const best = fromFts.length ? Math.min(...fromFts.map((c) => c.rank)) : 0;
  const worst = fromFts.length ? Math.max(...fromFts.map((c) => c.rank)) : 0;
  const span = worst - best;
  const queryText = tokens.join(" ");

  const enriched = candidates.map((c) => {
    const degree = stmts.degree.get({ id: c.id }).d;
    return { c, degree };
  });
  const maxDeg = Math.max(1, ...enriched.map((e) => e.degree));

  const scored = enriched.map(({ c, degree }) => {
    // FTS-recalled candidates keep their BM25 signal (1.0 when the set is a
    // single hit); fuzzy-scanned ones rely on name similarity alone.
    const bm25Norm = !tokens.length || c.scanned ? 0 : span === 0 ? 1 : (worst - c.rank) / span;
    // Company joins the similarity so "acme john" prefers John @ Acme.
    const nameSim = tokens.length
      ? nameSimilarity(tokens, c.company ? `${c.name} ${c.company}` : c.name)
      : 0;
    const lastAt = stmts.lastInteraction.get(c.id)?.at;
    const recency = lastAt ? Math.pow(0.5, (now - lastAt) / halfLifeMs) : 0;
    const degreeNorm = Math.log(1 + degree) / Math.log(1 + maxDeg);
    let score =
      S.rerank.wBm25 * bm25Norm +
      S.rerank.wName * nameSim +
      S.rerank.wRecency * recency +
      S.rerank.wDegree * degreeNorm;
    const nameLower = c.name.toLowerCase();
    if (queryText) {
      if (nameLower === queryText) score += S.exactBoost;
      else if (nameLower.startsWith(queryText)) score += S.prefixBoost;
    }
    return { c, degree, score };
  });
  scored.sort((x, y) => y.score - x.score);

  const results = scored.slice(0, limit).map(({ c, degree, score }) => ({
    contactId: c.id,
    name: c.name,
    org: c.company || undefined,
    role: c.role || undefined,
    degree,
    score: Math.min(1, Math.max(0, score)),
  }));
  return { requestId: query.requestId, results };
}

module.exports = {
  search,
  prepareStatements,
  parseQuery,
  tokenize,
  jaroWinkler,
  damerauLevenshtein,
  nameSimilarity,
};
