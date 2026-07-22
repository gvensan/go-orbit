# Search Capability — Requirements & Build Handoff

**Component:** Orbit (Electron desktop CRM with connection graphs)
**Feature:** Friendly, fast, typo-tolerant search
**Status:** Ready for implementation
**Audience:** Claude Code
**Scale target:** 20,000 contacts, ~200,000 edges, single-device

---

## 1. Goal

Search is the primary way a user navigates a 20k-contact graph. Typing anything — a partial name, a misspelling, a company, a phone fragment, a relationship — should surface the right person in under a keystroke's worth of latency. The bar is not "returns matches." The bar is *forgiving*: it tolerates typos, ignores diacritics and word order, understands identifiers, and ranks by what the user most likely meant.

Success is measured by three properties: **fast** (P95 keystroke-to-result < 50 ms at full scale), **forgiving** (typos, phonetics, partials, order-independence all resolve), and **contextual** (results carry enough graph context to disambiguate, and search can query the graph itself, not just contact fields).

## 2. Intent

Make search the command surface of the app. A single global palette (Cmd/Ctrl-K) is the fastest path to any person, any relationship, any saved view — keyboard-first, instant, cancellable. Search should feel like it read the user's mind, which in practice means good candidate recall plus a ranking model tuned to human intent (exact beats prefix beats fuzzy; a recent, well-connected contact outranks a stale leaf node).

## 3. Scope & non-goals

**In scope:** local full-text search over contacts and their fields; fuzzy/typo-tolerant matching; phonetic "did you mean"; structured filters and operators; graph-aware queries (neighborhood, introduced-by, degrees-of-separation); ranked results with match highlighting; a keyboard-driven command palette.

**Out of scope (v1):** cloud/server search, cross-device search, semantic/vector search, and voice. Semantic search over notes is listed as a Nice-to-have for a later pass.

## 4. Architecture context (already decided)

The search subsystem plugs into an existing stack. Do not re-decide these:

- **Runtime:** Electron, single-device, offline-first. `contextIsolation` on, `nodeIntegration` off, sandboxed renderer, whitelisted+validated IPC.
- **Store:** SQLite via `better-sqlite3-multiple-ciphers` (SQLCipher, AES-256). WAL mode. Tables `contacts(id, name, fields JSON)` and `edges(source_id, target_id, type, directed, metadata)`. Soft-delete via `deleted_at`.
- **Graph layer:** a `graphology` instance hydrated in-memory from `contacts`/`edges` at boot. Available for graph-aware queries.
- **Lifecycle:** ordered boot, self-healing DB open, versioned migrations (`PRAGMA user_version`), automatic backups (`VACUUM INTO`).

The search index lives **inside the encrypted DB**, so there is no plaintext index on disk — a hard requirement.

## 5. Search stack

Two-stage retrieval: fast candidate recall in SQLite, then a fuzzy re-rank in JS.

- **Stage 1 — candidate recall (SQLite FTS5).** An external-content FTS5 table over the searchable projection of each contact. `unicode61` tokenizer with `remove_diacritics 2` for accent-insensitivity; prefix queries (`term*`) for type-ahead; BM25 (`bm25()`) with per-column weights as the base relevance signal. A companion `trigram`-tokenized FTS5 table provides substring/LIKE-style recall for mid-word matches. Together they narrow 20k → a top-K candidate set (K ≈ 200).
- **Stage 2 — fuzzy re-rank (JS).** Over the K candidates only, apply a typo-tolerant scorer: Jaro-Winkler on name tokens plus Damerau-Levenshtein for edit distance, combined with the Stage-1 BM25 score, field weights, and signal boosts (recency, centrality). Cheap because it runs on hundreds of rows, not 20k.
- **Stage 3 — did-you-mean (optional, Need tier).** SQLite `spellfix1` (edit-distance + phonetic vocabulary) supplies a suggestion when candidate recall is empty. Build note: `spellfix1` is a loadable extension; confirm it loads under the multiple-ciphers build, else fall back to a JS phonetic (double-metaphone) index.

**Execution model.** Search runs on a **read-only SQLite connection in a `utilityProcess`/worker**, not the main thread. WAL mode allows concurrent reads during writes, so search never blocks or is blocked by edits. Queries are debounced (~120 ms) and **cancellable**: each carries a monotonic id; stale results are discarded so rapid typing never flashes wrong answers.

**Recommended dependencies:** `better-sqlite3-multiple-ciphers`, `graphology`, a small string-distance lib (or hand-rolled Jaro-Winkler + Damerau-Levenshtein), optional `spellfix1`.

## 6. Data model additions

```sql
-- Searchable projection kept in sync with contacts via triggers.
CREATE VIRTUAL TABLE contacts_fts USING fts5(
  name, email, phone, company, role, tags, notes,
  content='contacts_search',            -- flattened view/table below
  content_rowid='id',
  tokenize = "unicode61 remove_diacritics 2"
);

-- Substring / mid-word recall.
CREATE VIRTUAL TABLE contacts_trigram USING fts5(
  name, company, email,
  content='contacts_search', content_rowid='id',
  tokenize = 'trigram'
);

-- Flattened projection: extract JSON fields to columns for indexing.
CREATE TABLE contacts_search (
  id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  name TEXT, email TEXT, phone TEXT, company TEXT, role TEXT, tags TEXT, notes TEXT
);
```

Triggers on `contacts` INSERT/UPDATE/DELETE rebuild the matching `contacts_search` row (via `json_extract`) and mirror into both FTS tables. All queries must filter `deleted_at IS NULL`. Provide an idempotent full-reindex routine for migrations and recovery.

## 7. Feature requirements

### Must-have

| Feature | Detail |
|---|---|
| Global command palette | Cmd/Ctrl-K opens instant search from anywhere; Esc closes |
| Instant type-ahead | Debounced, streaming results as the user types |
| Fielded FTS + prefix | Name + email + phone + company + role + tags + notes; prefix matching |
| Diacritic-insensitive | "muller" matches "Müller"; normalized on both index and query |
| Typo-tolerant ranking | Two-stage fuzzy re-rank (Jaro-Winkler + Damerau-Levenshtein) |
| Word-order independence | "acme john" matches "John @ Acme Corp" |
| Ranked results + highlight | Field-weighted ranking; matched substrings highlighted in results |
| Result context | Each result shows name, org, role, degree — enough to disambiguate |
| Full keyboard nav | Arrow keys, Enter to open, Esc to dismiss — mouse optional |
| Cancellation | Stale queries discarded; no flicker of wrong results |

### Need-to-have

| Feature | Detail |
|---|---|
| Phonetic "did you mean" | `spellfix1` (or double-metaphone) suggestion on empty/low recall |
| Filters & facets | Chips for org, tag, edge type, has-email, etc. |
| Operator syntax | `org:Globex tag:vip type:introduced` inline operators |
| Graph-aware queries | `near:<contact>`, `hops:2`, `introduced-by:<contact>` resolved via graphology |
| Signal boosting | Rank boost by interaction recency and centrality/degree |
| Search within focus | Scope search to the currently focused ego-network |
| Saved searches / smart lists | Persist a query as a named, re-runnable view |
| Guided empty states | "No matches — did you mean X?" with actionable suggestions |

### Nice-to-have

| Feature | Detail |
|---|---|
| Natural-language queries | "designers at Globex I haven't talked to in 6 months" |
| Search history | Recent queries, quick re-run |
| Notes/timeline fuzzy search | Extend fuzzy matching into interaction notes |
| Click-through learning | Boost frequently-selected results per query |
| Semantic search | Local embeddings (e.g. `sqlite-vec`) for "find similar" |

## 8. Ranking model

Final score is a weighted sum, normalized to [0,1]:

```
score = w_bm25   * bm25_norm
      + w_name   * jaroWinkler(query_tokens, name_tokens)
      + w_recent * recencyDecay(last_interaction)
      + w_degree * degreeNorm(centrality)
      + exact_prefix_boost
      - typo_penalty(edit_distance)
```

Field weights for BM25 (highest → lowest): name > email/phone (identifiers) > tags > company/role > notes. Exact match and prefix match receive explicit boosts so a literal name always tops fuzzy near-matches. Weights must be centralized constants, tunable without touching query logic.

## 9. UX behavior

- Palette opens focused; results appear within the debounce window; top result is pre-selected and openable with Enter.
- Matched characters are highlighted in each result row.
- Operators and free text mix freely: `John org:Globex` = fuzzy "John" AND org filter.
- Empty query shows recent/saved searches, not a blank pane.
- Zero results shows a phonetic suggestion and the active filters (so the user sees *why* it's empty).
- Every interaction is reachable by keyboard; the mouse is never required.

## 10. Performance targets

- Keystroke → first result: **P95 < 50 ms** at 20k contacts.
- Debounce: ~120 ms; queries cancellable mid-flight.
- Incremental index update (per contact edit): O(1), trigger-driven, imperceptible.
- Full reindex (migration/recovery): < 2 s at full scale.
- Search must not block the main process (runs on a worker connection).

## 11. Security & privacy

- Index resides inside the SQLCipher-encrypted DB; no plaintext search index on disk.
- Search worker uses a **read-only** connection; it cannot mutate data.
- IPC search channel validates payload shape and rejects anything else.
- Query strings are never logged with PII in production logs.

## 12. Acceptance criteria

Each must pass as an automated test:

1. **Typo:** query "Jhon Smyth" returns "John Smith" in the top 3.
2. **Prefix:** query "joh" returns all Johns, ranked by signal.
3. **Diacritics:** "muller" matches "Müller"; "munchen" matches "München".
4. **Word order:** "acme john" finds "John @ Acme Corp".
5. **Identifier:** a partial email or phone fragment finds the contact.
6. **Graph op:** "near:Alice hops:2" returns Alice's 2-hop neighborhood, text-filterable.
7. **Performance:** P95 latency < 50 ms over a 20k-contact fixture.
8. **Keyboard-only:** full flow operable with no mouse.
9. **Cancellation:** rapid consecutive queries never render a stale result set.
10. **Soft-delete:** `deleted_at` contacts never appear in results.
11. **Encryption:** search functions against a SQLCipher DB; no plaintext index file exists.

## 13. Build plan (phased)

- **Phase 0 — Index foundation.** `contacts_search` projection, FTS5 + trigram tables, sync triggers, idempotent reindex, migration bumping `user_version` with a pre-migration backup.
- **Phase 1 — Query pipeline.** Read-only worker connection; two-stage retrieval (FTS candidate recall → JS fuzzy re-rank); cancellable IPC `search:query`; ranking model with centralized weights.
- **Phase 2 — Command palette UI.** Cmd/Ctrl-K palette, debounced input, streaming results, match highlighting, full keyboard nav, empty/zero states.
- **Phase 3 — Structured & graph queries.** Operator parsing, filter chips, graph-aware operators via graphology, scope-to-focus.
- **Phase 4 — Forgiveness & memory.** `spellfix1` did-you-mean, recency/centrality boosts, saved searches.
- **Phase 5 — Verification.** Acceptance-test suite (§12) plus a perf harness on a 20k fixture, wired into CI.

## 14. Handoff notes for Claude Code

- Assume an existing repo with the `main.js` lifecycle orchestrator, `contacts`/`edges` schema, graphology hydration, SQLCipher, and the migration runner already present. Extend, don't duplicate.
- Match the existing language and conventions of the repo (JS/TS). Keep `contextIsolation` on; expose search only through a validated preload bridge.
- Centralize all tunables (field weights, boosts, K, debounce) in one config module.
- Ship each phase behind passing tests from §12 where applicable; Phase 5 formalizes the full suite.
- Confirm `spellfix1` loads under `better-sqlite3-multiple-ciphers` early in Phase 4; if not, implement the double-metaphone fallback rather than blocking the feature.
- Deliverables per phase: migration(s), worker + IPC handler, UI component, tests. Provide a short README section documenting the query syntax and operators for end-user help.
