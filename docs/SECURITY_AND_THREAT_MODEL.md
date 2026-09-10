# Security & Threat Model

**Status:** Requirements. Cross-cutting; asserted from M0 (hardening) onward.
Amended 2026-09-10 for the service model (see `DECISIONS.md`).

## 1. What we're protecting

A user's entire personal/professional social graph: names, contact details,
relationships, private notes. This is sensitive precisely because it's
aggregated: the edges are as revealing as the nodes. The security posture treats
the whole database as confidential.

## 2. Threat model

In scope:

- **Device theft / loss.** Someone with the powered-off (or locked) machine should not be able to read the graph. → Encryption at rest (SQLCipher); key in the OS credential store, not in the repo or a plaintext file.
- **Casual local access.** Another user on the same machine shouldn't read the DB by opening the file, and shouldn't read it by talking to the service on loopback either. → Same encryption; credential-store access is user-scoped; the service requires a session token only this user can read (§5).
- **Other web pages in the same browser.** A page on any site can send requests to `127.0.0.1:7779`. → Host, Origin and `Sec-Fetch-Site` checks reject cross-origin writes; no CORS headers, so responses are unreadable cross-origin; the session cookie is `SameSite=Lax`, so it never accompanies a cross-site POST.
- **Malicious or buggy page content.** A rendering bug or injected content must not reach the filesystem or DB. → The page is untrusted: strict CSP (meta and header), every RPC payload validated in the service, file paths honored only when the service minted them.
- **Corrupt or hostile import archive.** A crafted archive must not corrupt the DB or execute anything. → Checksums, schema-version checks, streamed parsing, fail-closed decryption.

Out of scope (v1, stated so it's a decision not an omission):

- A privileged attacker with the machine unlocked and the user's browser session (they already have the user's session).
- Memory forensics / cold-boot attacks.
- Network adversaries: the service binds loopback only and its outbound requests are limited to map tiles and location searches; the page cannot connect anywhere but the service.
- Supply-chain integrity of dependencies beyond lockfile pinning.

## 3. Encryption at rest

- SQLCipher via `better-sqlite3-multiple-ciphers`, AES-256, whole-file. The FTS index and every table live inside the encrypted file: **no plaintext index or sidecar on disk** (see the guardrail in `CLAUDE.md`).
- WAL sidecars are also encrypted; never disable this to "make backups easier."
- Import uploads and export files pass through `<home>/uploads` and `<home>/exports` in plaintext, exactly as the user's own chosen file did on the desktop. An export slot is deleted as its download finishes; an upload slot after `config.server.uploadTtlMs`; all slots at boot. Both directories are mode 700, files 600.

## 4. Key management

- A random 256-bit DB key is generated on first run and stored in the OS credential store through the tool the OS ships: `security` on macOS (login keychain; commands go over stdin so the key never appears in a process listing), `secret-tool` on Linux (Secret Service), PowerShell DPAPI on Windows (`CurrentUser` scope; the wrapped blob lives in `<home>/dbkey.bin`).
- The service reads the key at boot to unlock the DB. The key is never written to disk in plaintext and never logged. There is no environment-variable or file fallback: if no store is reachable the service refuses to start and says how to fix it.
- The credential-store account is derived from the data home, so two homes on one machine never share a key.
- **Consequence, by design:** the key is device-bound. It does not travel. Moving to a new device uses export/import (`EXPORT_IMPORT_REQUIREMENTS.md`), whose archive uses a *separate, user-chosen passphrase*, never the store key, precisely so it's portable. The former Electron build's database is not readable by the service for the same reason; migrate with an archive.

## 5. Service and page hardening

- The service binds `127.0.0.1` only; the address is not configurable.
- **Session.** A random 256-bit token lives in `<home>/session-token` (0600, re-asserted on every boot; `bin/orbit reset-session` rotates it). `bin/orbit open` opens `http://localhost:<port>/?token=…`; the service exchanges it once for an `HttpOnly; SameSite=Lax` cookie and redirects. Lax rather than Strict so the Add to Orbit bookmarklet, a top-level GET to `/add` from another site, carries the session; Lax still withholds the cookie on cross-site POSTs and subresources, and every write is a POST behind the Origin and `Sec-Fetch-Site` guards. The bookmarklet itself carries only the port, never the token. Every request except `GET /api/health` needs the cookie (or a `Bearer` header, used by the CLI's doctor). A browser without a session gets a locked page that explains `bin/orbit open` and nothing else: no assets, no data, no version.
- **Guards before routing.** Host must be loopback (`config.server.localHosts`); non-GET requests with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are refused.
- **Strict CSP**, identical in the `index.html` meta tag and the response header, asserted equal to `config.security.csp` by test: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`. Plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`.
- Every RPC payload is validated in the service before use; invalid → `IpcError { VALIDATION }`. Unknown channels are 404. Bodies are capped (`config.server.bodyMaxBytes`, `config.limits.importMaxBytes`).
- **Files.** Import and export channels only honor paths the service minted this session (an upload it received or an export slot it handed out); anything else is `VALIDATION`. Downloads serve only granted export slots, once. Static serving resolves under `dist/renderer` and refuses traversal.

## 6. Privacy posture

- No telemetry, no crash reporting, no update feed. The service makes no network request of its own except the user-disableable map tiles and location search, which disclose the viewed map area or typed query to their providers; both are off with one switch in Settings.
- No contact graph, names, relationships, or notes leave the device except through user-initiated export.
- Logs never contain contact PII: the access log records method, path, status and duration, never bodies or query strings; search query strings are not logged with content.

## 7. Acceptance criteria

1. With the service stopped, the on-disk DB and all sidecars are unreadable without the store key (inspect: no plaintext names/emails in the file).
2. No plaintext search index or sidecar exists anywhere on disk; the only plaintext contact data is a live import/export slot, and none survives a restart.
3. Without the session cookie, `/` is the locked page and every `/api/*` route except `/api/health` is 401; a wrong or malformed `?token=` is 403 (`test/server-app.test.js`).
4. A request with a non-loopback `Host`, or a write with a foreign `Origin` or `Sec-Fetch-Site: cross-site`, is 403 before any handler runs.
5. An invalid or oversized RPC payload is rejected with `VALIDATION` (or 413) and never reaches the data layer.
6. A tampered or wrong-passphrase import archive fails closed with no partial write.
7. Default install connects only for map tiles and location search when those are used; disabling "Online maps & location search" makes it fully offline.
