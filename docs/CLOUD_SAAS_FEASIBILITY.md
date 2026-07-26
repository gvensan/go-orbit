# Cloud SaaS Feasibility - Zero-Knowledge B2C Multi-Tenant Orbit

**Status:** Feasibility study / discussion. Not a commitment, not a spec. Frames
options and trade-offs for turning the local-first desktop app into a hosted,
multi-account service **without giving up encryption, privacy, or security**.

**Decision inputs (given):**
- Audience: **B2C**. Each account is one person with their own private graph. No
  team workspaces or intra-tenant sharing in the first phase.
- Non-negotiable: **retain the distinct aspects** - encrypted at rest, private,
  secure. In practice this means **zero-knowledge (end-to-end encrypted) sync**:
  the server stores and relays only ciphertext and cannot read the graph.

Read alongside `SECURITY_AND_THREAT_MODEL.md` (the posture we must preserve),
`INTERFACE_CONTRACT.md` (the seam we reuse), and `EXPORT_IMPORT_REQUIREMENTS.md`
(the passphrase-encrypted archive, which is the seed of the key model here).

---

## 1. The one-line verdict

Feasible, and a better fit than most apps because **Orbit already does all of its
work on the client**. Search, force layout, and betweenness centrality run in the
renderer and worker threads today. The cloud does not need to read the data to
add value: it needs to sync it, back it up, and gate accounts. That is exactly
the shape a zero-knowledge service can support. The cost is concentrated in three
hard places: **key management, sync conflict handling, and account recovery.**

---

## 2. Guiding principles (extends the guardrails in CLAUDE.md)

1. **The server is a dumb, blind relay.** It never holds a key that can decrypt
   user data. Everything it stores about the graph is ciphertext plus unavoidable
   metadata (sizes, counts, timestamps).
2. **The client stays smart.** All decryption, search indexing, graph layout, and
   analytics remain client-side. This is already true and must not regress.
3. **No plaintext graph on any disk we do not control, ever** - the existing
   guardrail, extended to the server: no plaintext, no plaintext index, no
   plaintext sidecar, on the client *or* the backend.
4. **Encryption keys derive from the user, not the device.** Today the key is a
   random device-bound keychain value. To sync, it must travel to other devices
   under the user's control, and never to us.
5. **Lose the passphrase, lose the data.** Zero-knowledge means we cannot reset
   it for them. This is a feature and a support/UX cost; it is stated here as a
   decision, not discovered later.

---

## 3. Architecture at a glance

```
   Device A (Electron)          Device B (Web / Electron)
  +-------------------+        +-------------------+
  | renderer (sigma)  |        | renderer (sigma)  |   <- unchanged: search,
  | search + layout   |        | search + layout   |      layout, betweenness
  | + betweenness     |        | + betweenness     |      all run locally
  +---------+---------+        +---------+---------+
            |  local data layer (behind the IPC contract)
  +---------v---------+        +---------v---------+
  | encrypted store   |        | encrypted store   |   Electron: SQLCipher
  | + SyncEngine      |        | + SyncEngine      |   Web: SQLite WASM / OPFS
  +---------+---------+        +---------+---------+
            |   ciphertext ops / blobs only
            +------------+  +-------------+
                         v  v
                 +------------------+
                 |  Sync Relay      |   authenticates accounts, stores + relays
                 |  (blind backend) |   ciphertext, enforces per-tenant isolation,
                 +--------+---------+   quotas, billing, device roster
                          |
                 +--------v---------+
                 | ciphertext store |   Postgres+RLS or DB-per-tenant (libSQL)
                 | wrapped keys     |   holds encrypted DEK, never the DEK
                 +------------------+
```

The renderer and workers do not change in kind. The `main` process's role (data
access) is refactored behind the existing IPC channel contract so the same
contract is served by a **local data layer + SyncEngine** instead of raw
SQLite-in-main. That contract (`INTERFACE_CONTRACT.md`, `ipc/registry.js`) is the
single seam that makes this tractable.

---

## 4. What the blind server can and cannot do

**Can:**
- Authenticate accounts and manage devices/sessions.
- Store and relay encrypted operations (or snapshots) between a user's devices.
- Store **wrapped** key material (a Data Encryption Key sealed by the user's key).
- Enforce per-tenant isolation, quotas, and rate limits on ciphertext.
- Encrypted off-device backup and point-in-time restore.
- Billing, licensing, content-free push ("you have changes"), abuse controls.

**Cannot (by design, and this is the point):**
- Search, filter, or rank contacts.
- Deduplicate or suggest merges across the corpus.
- Compute centrality, clusters, or any graph analytics.
- Enrich (calendar/email/social) or render anything server-side.
- Help support staff inspect a user's data, ever.

Everything in the "cannot" list already lives on the client, so we lose nothing
we have today. We only forgo *future* server-side features that would require
reading the data. That is the deliberate trade for keeping the privacy promise.

---

## 5. Key management and account model (the crux)

This is where most of the design risk sits. Proposed hierarchy (standard
envelope-encryption, as used by password managers):

```
passphrase --Argon2id--> Master Unlock Key (MUK)   [never leaves device]
random 256-bit           Data Encryption Key (DEK)  [never leaves device in clear]
DEK sealed by MUK   -->   Wrapped DEK               [stored on server, opaque]
graph data sealed by DEK  Ciphertext                [stored/synced, opaque]
```

- The **DEK** encrypts the actual graph. It is generated client-side once.
- The **MUK** is derived from the user passphrase with a memory-hard KDF
  (Argon2id) and wraps the DEK. The server stores only the *wrapped* DEK.
- **New device onboarding:** authenticate, enter passphrase, derive MUK, fetch
  wrapped DEK, unwrap, done. Alternatively device-to-device transfer (QR / X25519
  key exchange, Signal-style) so the passphrase is not retyped.
- **Second factor / high-entropy secret:** optionally combine the passphrase with
  a randomly generated "Secret Key" held only on enrolled devices (the 1Password
  model), so a weak passphrase alone cannot be brute-forced server-side.
- **Recovery:** offer a one-time recovery code at signup (a second wrapping of the
  DEK under a high-entropy code the user stores offline). Without it, lost
  passphrase = unrecoverable data. Be explicit in the UX. There is no
  zero-knowledge design that avoids this trade.

Reuse note: the export archive already encrypts with a **separate user-chosen
passphrase, never the keychain key** (`SECURITY_AND_THREAT_MODEL.md` sec 4,
`EXPORT_IMPORT_REQUIREMENTS.md`). That passphrase-based sealing is conceptually
the same primitive as the MUK/DEK wrap, so the crypto discipline already exists
in the codebase.

Crypto primitives: libsodium (XChaCha20-Poly1305 AEAD, Argon2id, X25519) on
Electron; WebCrypto / a vetted WASM libsodium in the browser. **Do not hand-roll.
Get a third-party crypto review before any public launch.**

---

## 6. Sync model - two options

### Option A: Encrypted snapshot / blob sync (pragmatic, phase 1)
Sync the whole encrypted DB (or coarse encrypted chunks) with last-writer-wins at
the file level.
- **Pros:** simplest to build; reuses the existing single-file model and the
  `VACUUM INTO` backup machinery; good enough for "one person, one device at a
  time, occasional switch."
- **Cons:** concurrent edits on two devices clobber each other (LWW loses data);
  large re-uploads; no fine-grained history.

### Option B: Encrypted operation log with CRDT-friendly merge (durable, phase 2+)
Every mutation (contact create/update, edge add/remove, tag, interaction) becomes
an encrypted, append-only op the server relays. Clients merge deterministically.
- **Pros:** true offline-first, concurrent multi-device editing, natural history,
  small deltas.
- **Cons:** more engineering; needs a conflict model (see sec 7); ops are opaque
  to the server so it cannot compact by content (only by count/age).

**Recommendation:** ship Option A first to validate demand and the key model, then
move to Option B once multi-device concurrency actually bites. The data model
changes in sec 7 should be laid down early so Option A does not paint us into a
corner.

### The turnkey-sync caveat (important, non-obvious)
Popular local-first sync engines (ElectricSQL, PowerSync, Turso sync, and to a
degree Yjs/Automerge server providers) assume the **server can read rows** to do
partial replication, filtering, or server-side conflict resolution. That is
fundamentally **incompatible with zero-knowledge**. Under E2E the server must
treat payloads as opaque blobs, which means we build a **custom (thin) relay** or
use these engines only as a dumb transport with client-side crypto layered on
top. Budget for "mostly custom sync," not "adopt a product."

---

## 7. Data model changes

The current schema is already unusually sync-ready:
- **Soft-delete (`deleted_at`)** is exactly the tombstone a CRDT needs; hard
  cascades are already forbidden by guardrail.
- **Journaled, undoable merges (`merge_log`, 0003)** are an op-log in spirit.
- Stable integer PKs, `updated_at` on contacts, timestamps everywhere.

Additions needed:
- A **per-row logical clock** (Lamport/HLC) or version vector for merge ordering.
- Globally-unique IDs. Local `INTEGER PRIMARY KEY` collides across devices; move
  to ULID/UUIDv7 (or a device-prefixed id) for anything created offline.
- An **op-log table** (encrypted op, actor/device, clock) for Option B.
- A **sync cursor / checkpoint** per device.
- Field-level merge policy for `contacts.fields` JSON (LWW-per-field is usually
  enough for a personal CRM; edges are add/remove sets, which merge cleanly).

The FTS/trigram search projection and index (0001) stay **client-only** and are
rebuilt locally after sync. They are never synced and never leave the device -
this preserves the "no plaintext index on disk we do not control" guarantee.

---

## 8. What carries over from today's codebase

| Piece | Fate |
|---|---|
| Renderer (sigma.js, graphology, search UI, tree view) | Reused nearly as-is; becomes the web client too |
| Search engine + worker, layout (FA2) worker, betweenness worker | Reused; stay client-side; **zero server compute cost** |
| IPC channel contract (`ipc/registry.js`, `types.d.ts`) | Reused as the internal API seam; transport swaps under it |
| SQLite schema + repos | Reused; add sync columns and global IDs |
| SQLCipher whole-file encryption (Electron) | Reused on desktop; key derivation changes from device-bound to user-derived |
| `VACUUM INTO` backup + verify | Reused for encrypted off-device backup |
| Passphrase-encrypted export archive | The key-wrapping model generalizes from it |
| Single-instance "one writer" lock | Becomes a per-device concern; cross-device concurrency handled by the SyncEngine, not a lock |

The refactor that unlocks everything: **extract the data layer behind the IPC
contract** so the renderer talks to an interface, not to Electron main directly.
Then "Electron main + SQLCipher" and "browser + SQLite WASM + SyncEngine" are two
implementations of the same contract.

---

## 9. Web client considerations

To offer browser access (a core SaaS expectation) while staying zero-knowledge:
- **Local store in the browser:** SQLite compiled to WASM (wa-sqlite) over OPFS,
  or an encrypted store over IndexedDB. Data is encrypted with the DEK before it
  touches OPFS/IndexedDB.
- **Crypto in the browser:** WebCrypto for AEAD; a vetted WASM Argon2id for the
  KDF (WebCrypto lacks Argon2).
- **Performance reality check at target scale (20k contacts / ~200k edges):**
  decrypting and indexing the whole graph on load, plus FA2 layout and on-demand
  betweenness, is heavy for a browser tab. Expect to need: incremental/lazy
  decryption, IndexedDB/OPFS caching of the decrypted-then-reindexed state within
  the session, and keeping betweenness on-demand + cached (already the design).
  This is the single biggest technical unknown for the web client and should be
  spiked early with a realistic fixture (we already generate a 20k/190k fixture).
- Electron desktop remains the "full power" client; web can start read-mostly or
  capped at smaller graphs if the spike shows limits.

---

## 10. Multi-tenancy and infrastructure

Because the payloads are ciphertext, tenant isolation protects *ciphertext plus
metadata*, which lowers (does not remove) breach severity.
- **Isolation:** either Postgres with `tenant_id` on every row and Row-Level
  Security, or **database-per-tenant on libSQL/Turso** (cleaner per-user export,
  delete, and backup; closer to the current one-file-per-user mental model).
  Recommend DB-per-tenant for the strongest isolation and simplest "delete my
  account = drop the database" story.
- **Backend:** a thin service (Node or Go). It is mostly auth, an append/fetch
  API for encrypted ops or blobs, quota accounting, and billing webhooks. Small.
- **Auth:** account identity via passkeys (WebAuthn) and/or email + passphrase.
  Keep **account auth separate from data keys** - authenticating proves who may
  sync which tenant; it never yields the DEK.
- **Standing ops:** backups, DR, rate limiting, abuse handling, status/on-call.
  Real but modest for a blind relay.

---

## 11. Metadata leakage (be honest)

Zero-knowledge protects *content*, not *shape*. The server can still infer:
- Approximate graph size (op count / blob size), growth over time.
- Edit frequency and timing (activity patterns), device count, IP/geo, user agent.

Mitigations if this matters: size bucketing / padding of encrypted payloads,
batching ops on a jittered schedule, minimizing retained connection logs. Document
what we can and cannot hide so the privacy claim is precise, not marketing.

---

## 12. Compliance and legal posture

- A relationship CRM stores personal data about **third parties who did not sign
  up**. Hosting it makes us a processor for that data. Zero-knowledge is the
  strongest possible posture here: **data minimization by construction** - we
  cannot read, disclose, or mine it, which answers most GDPR/CCPA concerns
  directly and shrinks breach impact to ciphertext.
- Still required: a DPA, clear ToS/privacy policy, a lawful mechanism for
  data-subject requests (which, under E2E, largely route to the account holder who
  controls the key, since we cannot act on the content ourselves), breach
  notification process, and a data-residency answer (DB-per-tenant helps).
- Lean into it: "we mathematically cannot read your network" is a genuine, rare
  market differentiator, not a compliance checkbox.

---

## 13. Pros and cons of this specific path

**Pros**
- Preserves and *sharpens* the identity: privacy becomes a provable feature.
- Reuses the renderer, workers, schema, and IPC contract; no server-side compute.
- Unlocks multi-device, web access, off-device encrypted backup, recurring revenue.
- Strong, defensible compliance story.

**Cons / costs**
- Key management, sync conflict handling, and recovery are genuinely hard and
  security-critical; crypto mistakes are severe and need an external audit.
- No account recovery without a stored recovery code; higher support burden.
- No server-side features ever (search, dedup, analytics, enrichment) - by design.
- Browser performance at 20k/200k is an open risk for the web client.
- "Mostly custom sync" because turnkey engines assume readable rows.
- Standing infra, security, and on-call obligations that a desktop app does not have.

---

## 14. Phased roadmap

- **Phase 0 - Decouple.** Extract the data layer behind the IPC contract; add
  global IDs and a logical clock to the schema; ship a no-op SyncEngine. No user
  visible change. De-risks everything downstream.
- **Phase 1 - Accounts + key model + snapshot sync.** Zero-knowledge key
  hierarchy (MUK/DEK/wrapped DEK, recovery code), account service, encrypted
  blob sync (Option A), device onboarding. Desktop clients only. Multi-device for
  one user.
- **Phase 2 - Op-log/CRDT sync.** Concurrent multi-device editing, conflict
  resolution, encrypted history/backup with point-in-time restore.
- **Phase 3 - Web client.** SQLite WASM + WebCrypto sharing the existing renderer;
  after a performance spike proves the 20k/200k path.
- **Phase 4 - Commercialization.** Billing, plans/quotas, device management,
  polished recovery UX. (Optional, hard under E2E: selective sharing of a subgraph
  via per-item keys.)

---

## 15. Effort sizing (rough, order-of-magnitude)

| Workstream | Size | Notes |
|---|---|---|
| Phase 0 decouple + schema (global IDs, clock) | M | Mostly internal refactor; well-contained by the IPC seam |
| Zero-knowledge key hierarchy + recovery | L | Small code, high care; needs external review |
| Account/sync backend (blind relay) | M | Auth + append/fetch + quotas + billing |
| Snapshot sync client (Option A) | M | Reuses backup machinery |
| Op-log / CRDT sync (Option B) | L-XL | The real engineering; conflict model + history |
| Web client (WASM SQLite + crypto + perf) | L | Perf spike gates scope |
| Compliance, DPA, audit, ops setup | M | Non-code but on the critical path to launch |

(S/M/L/XL, not calendar estimates. The two L/XL items - key model and durable
sync - dominate risk.)

---

## 16. Open questions to resolve before committing

1. **Recovery stance:** recovery code only (max privacy) vs. an optional weaker
   recovery? This shapes signup UX and support load.
2. **Concurrency need:** how often do real users edit on two devices at once? If
   rarely, snapshot sync may suffice for a long time and defer Option B.
3. **Web client scope:** full graph in-browser at 20k/200k, or a capped/read-mostly
   web tier while Electron stays the power client? Decide with a spike.
4. **Isolation model:** DB-per-tenant (recommended) vs. Postgres RLS - cost vs.
   isolation and per-user delete/export simplicity.
5. **Passkeys vs. passphrase** as the primary factor, and whether to add a
   high-entropy Secret Key against weak passphrases.
6. **Audit budget and timing:** external crypto review is a launch gate, not a
   nice-to-have.

---

## 17. Recommendation

Proceed, but sequence to de-risk. **Do Phase 0 (decouple behind the IPC contract,
add global IDs + a clock) regardless** - it is low-risk, improves the codebase
even if cloud never ships, and is the prerequisite for everything else. Then
build the zero-knowledge key model and snapshot sync (Phase 1) as a thin,
auditable slice and validate with real multi-device users before investing in
CRDT sync and a web client. Keep the server blind at every step; the moment we
add a feature that needs to read the data, we have quietly become a different,
less differentiated product than the one this document is about.
