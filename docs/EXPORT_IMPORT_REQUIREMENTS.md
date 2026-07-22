# Export / Import — Requirements

**Status:** Ready for implementation. Milestone M2.
**Why it's load-bearing:** with sync out of scope, export/import is simultaneously
the device-migration path, the disaster-recovery floor, and the user-owned
portable backup. It must be lossless and forward-compatible.

## 1. Goal

A user can export their entire graph to a single file they control, carry it to a
new device, and import it into a fresh install with the graph reproduced exactly
— contacts, edges, interactions, tags. Round-trip fidelity is the contract.

## 2. Archive format

A single file: a gzip-compressed tar (`.orbit`) containing NDJSON streams plus
a manifest. NDJSON (one JSON object per line) so export/import stream without
holding the whole graph in memory, and so a single corrupt line loses one record,
not the file.

```
archive.orbit  (gzip tar)
├── manifest.json        # schema version, counts, checksum, created_at, encryption
├── contacts.ndjson      # one Contact per line (fields inline)
├── edges.ndjson         # one Edge per line
├── interactions.ndjson  # one Interaction per line
└── tags.ndjson          # tags + contact_tags associations
```

`manifest.json`:

```json
{
  "format": "orbit-archive",
  "schemaVersion": 1,
  "appVersion": "1.0.0",
  "createdAt": 1730000000000,
  "counts": { "contacts": 20000, "edges": 200000, "interactions": 8000, "tags": 40 },
  "sha256": "<hash of the concatenated ndjson streams>",
  "encryption": { "scheme": "none" }
}
```

## 3. Encryption (optional, user-chosen)

The at-rest DB key lives in the OS keychain and dies with the device, so it must
**not** encrypt the archive — otherwise the archive can't be opened on the new
device. Instead, when the user sets a passphrase:

- Derive a key with a memory-hard KDF (Argon2id; scrypt acceptable) from the passphrase + a random salt stored in the manifest.
- Encrypt the ndjson payload with AES-256-GCM; store the IV and auth tag in the manifest.
- `manifest.json` itself (minus secrets) stays cleartext so the importer can read the version and prompt for the passphrase.

Without a passphrase the archive is unencrypted and portable as-is — the user's
explicit choice, surfaced clearly in the export UI.

## 4. Export

1. Open a read transaction (consistent snapshot).
2. Stream each table to its ndjson entry; compute the running SHA-256.
3. Write the manifest (counts + checksum + encryption params).
4. Optionally encrypt, then gzip+tar to the destination.
5. Verify: reopen the archive, check the checksum, before reporting success.

Export never blocks the UI; run it off the main thread for large graphs.

## 5. Import

1. Read `manifest.json`; reject unknown `format`.
2. **Version handling:** if `schemaVersion` < current, run the archive through the same forward migrations before import; if >, refuse with a clear "export is from a newer version — update the app" message. Never silently drop unknown fields.
3. If encrypted, prompt for the passphrase; fail closed on wrong passphrase (GCM auth tag mismatch).
4. Verify the checksum before writing anything.
5. Stream records into a transaction. Contacts pass through **dedup-on-import** (see `DEDUP_MERGE_REQUIREMENTS.md`) per the chosen `onDuplicate` policy: `skip` | `merge` | `keepBoth`.
6. Rebuild the search projection and reindex FTS after import.
7. Return an `ImportReport` (imported, merged, skipped, duplicatesFound).

## 6. Dedup on import

Re-importing onto a device that already has data will otherwise manufacture
duplicates. Import must run every incoming contact through the same match logic
as in-app dedup. Default policy `merge`: matched contacts union their fields and
re-point edges; unmatched contacts insert fresh. The user picks the policy in the
import wizard.

## 7. Non-goals

No partial/selective export in v1 (whole graph only), no cross-format import
beyond vCard/CSV (which are separate ingest paths, not the archive), no cloud
destinations.

## 8. Acceptance criteria

1. **Round-trip:** export → import into an empty install reproduces contacts, edges, interactions, and tags exactly (counts and content).
2. **Encrypted round-trip:** passphrase export → import with the same passphrase succeeds; a wrong passphrase fails closed with no partial write.
3. **Checksum:** a tampered archive is rejected before any DB write.
4. **Older version:** an archive one schema version behind imports via migration.
5. **Newer version:** an archive from a newer schema is refused with a clear message.
6. **Dedup:** importing an archive into a populated DB with `merge` produces no duplicate contacts and preserves all edges.
7. **Streaming:** a 20k-contact archive imports without loading the whole file into memory.
