# Security & Threat Model

**Status:** Requirements. Cross-cutting; asserted from M0 (hardening) through M6.

## 1. What we're protecting

A user's entire personal/professional social graph — names, contact details,
relationships, private notes. This is sensitive precisely because it's aggregated:
the edges are as revealing as the nodes. The security posture treats the whole
database as confidential.

## 2. Threat model

In scope:

- **Device theft / loss.** Someone with the powered-off (or locked) machine should not be able to read the graph. → Encryption at rest (SQLCipher); key in the OS keychain, not in the app bundle or a plaintext file.
- **Casual local access.** Another user on the same machine shouldn't read the DB by opening the file. → Same encryption; keychain access is user-scoped.
- **Malicious or buggy renderer content.** A rendering bug or injected content must not reach the filesystem or DB. → Renderer is untrusted: contextIsolation, sandbox, no nodeIntegration, strict CSP, validated IPC.
- **Corrupt or hostile import archive.** A crafted archive must not corrupt the DB or execute anything. → Checksums, schema-version checks, streamed parsing, fail-closed decryption.

Out of scope (v1, stated so it's a decision not an omission):

- A privileged attacker with the machine unlocked and the app open (they already have the user's session).
- Memory forensics / cold-boot attacks.
- Network adversaries — main-process requests are limited to signed update checks, map tiles, and location searches; the renderer cannot connect directly.
- Supply-chain integrity of dependencies beyond lockfile pinning.

## 3. Encryption at rest

- SQLCipher via `better-sqlite3-multiple-ciphers`, AES-256, whole-file. The FTS index and every table live inside the encrypted file — **no plaintext index or sidecar on disk** (see the guardrail in `CLAUDE.md`).
- WAL sidecars are also encrypted; never disable this to "make backups easier."

## 4. Key management

- A random 256-bit DB key is generated on first run and stored via Electron `safeStorage` (OS keychain: Keychain on macOS, DPAPI on Windows, libsecret on Linux).
- The app reads the key from the keychain at boot to unlock the DB. The key is never written to disk in plaintext and never logged.
- **Consequence, by design:** the key is device-bound. It does not travel. Moving to a new device uses export/import (`EXPORT_IMPORT_REQUIREMENTS.md`), whose archive uses a *separate, user-chosen passphrase* — never the keychain key — precisely so it's portable.
- Optional user passphrase as a second factor over the keychain key is a Nice-tier addition; if added, derive with a memory-hard KDF and never store the passphrase.

## 5. Renderer hardening

Asserted at window creation (`config.security`):

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Strict CSP: `default-src 'self'`, no remote scripts, `connect-src 'none'` (nothing dials out from the renderer).
- Block navigation to remote origins (`will-navigate` / `setWindowOpenHandler` deny).
- The preload bridge exposes only the typed `window.api`; no raw `ipcRenderer`.
- Every IPC payload is validated in main before use; invalid → `IpcError { VALIDATION }`.

## 6. Privacy posture

- No telemetry by default. Crash reporting is opt-in and PII-scrubbed (`electron-log` local by default; Sentry opt-in).
- No contact graph, names, relationships, or notes leave the device except through user-initiated export. Signed update checks run automatically. Detailed map tiles and location search are enabled by default and disclose the viewed map area or typed location query to their providers; users can disable both in Settings.
- Logs never contain contact PII in production; search query strings are not logged with content.

## 7. Acceptance criteria

1. With the app closed, the on-disk DB and all sidecars are unreadable without the keychain key (inspect: no plaintext names/emails in the file).
2. No plaintext search index or sidecar exists anywhere on disk.
3. The renderer cannot reach Node APIs, the filesystem, or a remote origin (verified by attempted access failing).
4. An invalid or oversized IPC payload is rejected with `VALIDATION` and never reaches the data layer.
5. A tampered or wrong-passphrase import archive fails closed with no partial write.
6. Default install connects only for signed updates and when detailed maps/location search are used; disabling updates and “Online maps & location search” makes it fully offline.
