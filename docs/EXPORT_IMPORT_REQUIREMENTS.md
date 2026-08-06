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
re-point edges; unmatched contacts insert fresh. For archives the user picks a
single global policy in the import wizard.

### 6a. Resolve step (vCard/CSV) - per-record decisions

For vCard/CSV imports (not archives), the wizard adds a **Resolve** step after
Review. It calls the read-only `import:match` channel to rank existing-contact
candidates for each incoming record (email 1.0 / phone 0.95 / same name+company /
fuzzy name, each with a reason, a confidence score, and a few of the candidate's
current connections for context), and also flags incoming-vs-incoming duplicates.

The guiding principle is **the user is master of every record**: match hints are
advisory, and nothing is written until the user confirms. Two modes (persisted):

- **All at once (batch):** a table with a per-row status chip (New / Possible
  match / Likely duplicate / Duplicate in file) and a per-row decision control,
  plus bulk actions (merge strong matches, all as new, ignore all matches) and a
  filter.
- **One at a time:** a card per record with the ranked candidates (reasons +
  connections) as selectable options, plus "import as new", "ignore", and a
  manual link to any existing contact by search.

Each record's decision (`ignore` / `new` / `merge` into a chosen contact) rides
on `import:records` and **overrides** the global policy. Smart pre-selection
proposes the likely decision (strong match → merge; otherwise new) but never
acts on its own. The report includes an `ignored` count.

**Consider/ignore is a per-row toggle** (a switch), the single ignore control,
present on Review rows, Resolve batch rows, and one-at-a-time cards. It lets the
user triage the whole list and mark only the records to process this session; a
considered record's decision is then just new-vs-merge. Ignored rows dim, skip
name-required validation (ignore junk instead of fixing it), and import as
`ignore` (so a record with no name is allowed only when ignored). The Review step
shows a live tally: for consideration / complete / need attention / ignored.

Triage controls sit at the header: a **Consider-all switch** (one click marks
every record considered or ignored; ignoring all keeps the rows visible so the
user can re-enable individual ones) and, above the header, a **Show/Hide ignored
(N)** button (ignored rows are hidden by default) plus, when re-importing a
results file, a **Hide/Show imported (N)** button that hides rows already
imported in a prior run (`orbit_status`). Import is **opt-in**: every row starts
NOT considered ("Consider all" begins clearly off), all rows are shown so the
user can mark the ones to import, and only marked rows are written - so populating
a few rows never silently imports the rest. Continuing with nothing marked is
blocked. A **name search** filters the Review and Resolve lists. Pagination is
**height-adaptive**: the row count per page is fitted to the modal's available
space (and re-measured on resize/maximize) so the list never scrolls.

### 6b. Results write-back

After a vCard/CSV import, the user may save an **annotated results file** (CSV
with an `orbit_status` column: `imported` / `merged` / `ignored`, plus a date)
via `import:writeResults`. It is always user-initiated through a save dialog that
defaults to the source path (CSV) so overwriting is a deliberate choice, never
silent. On a later re-import, `orbit_status` is read back (preserved through
parsing even when unmapped) and shown as a per-row badge. A **Save and reload**
button on the report closes the loop: it saves the results file and reopens the
wizard straight on it with the already-imported rows hidden, so the user can work
through the remaining records in another pass.

## 7. Non-goals

No partial/selective export in v1 (whole graph only), no cross-format import
beyond vCard/CSV (which are separate ingest paths, not the archive), no cloud
destinations.

A **contacts CSV export** (`export:csv`) exists as a separate outbound path,
mirroring the CSV ingest path: it writes a contacts sheet and, when
`includeDetails` is set, relationship detail rows. It is a convenience export,
not the portable `.orbit` archive, and carries no passphrase encryption, so it
is a plaintext file the user chooses to write outside the encrypted store.

Every exported CSV is written **UTF-8 with a BOM** so Excel (notably on Windows)
renders non-ASCII names correctly, and each cell is run through a
**spreadsheet-formula-injection guard**: a value beginning with `= + - @` (or a
control char) is prefixed with a single quote so Excel/Sheets treat it as literal
text - this also stops `+`-leading international phone numbers being shown as
`#NAME?` formula errors. `parseCSV` strips the BOM, and the importer strips the
guard quote, so a round-trip through our own import is lossless. The detailed
(`includeDetails`) file collapses duplicate relationship rows and, since
undirected ties are now stored canonically, no longer repeats a reciprocal tie.

## 8. Acceptance criteria

1. **Round-trip:** export → import into an empty install reproduces contacts, edges, interactions, and tags exactly (counts and content).
2. **Encrypted round-trip:** passphrase export → import with the same passphrase succeeds; a wrong passphrase fails closed with no partial write.
3. **Checksum:** a tampered archive is rejected before any DB write.
4. **Older version:** an archive one schema version behind imports via migration.
5. **Newer version:** an archive from a newer schema is refused with a clear message.
6. **Dedup:** importing an archive into a populated DB with `merge` produces no duplicate contacts and preserves all edges.
7. **Streaming:** a 20k-contact archive imports without loading the whole file into memory.
