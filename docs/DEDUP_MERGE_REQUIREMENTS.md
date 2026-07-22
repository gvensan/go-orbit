# Deduplication & Merge — Requirements

**Status:** Ready for implementation. Milestone M5 (used earlier by import in M2).
**Why it's hard:** identity resolution is the messiest logic in any contact app.
Getting it wrong either buries the user in duplicates or silently destroys data.
The rule of thumb throughout: **never auto-merge silently; always keep an undo.**

## 1. Goal

Detect when two contacts are the same person and let the user merge them without
losing any field, edge, or interaction. Run the same logic on manual dedup and
on import.

## 2. Match signals

Two tiers, because not all evidence is equal:

- **Strong (near-certain identity):** normalized email equality; normalized phone equality (E.164). A strong match alone justifies proposing a merge.
- **Weak (needs corroboration):** high name similarity (Jaro-Winkler ≥ 0.9, diacritic- and case-folded) combined with same company or a shared edge. Weak signals never auto-confirm; they surface as candidates.

Normalization: lowercase and trim email; strip formatting and country-code
variants from phone into E.164; fold diacritics and collapse whitespace in names.

## 3. Blocking (candidate generation)

Comparing all pairs is O(n²) — 20k contacts is 200M pairs. Block first: group
candidates by cheap keys and only compare within a block.

- Block on normalized email domain, normalized phone prefix, and a name key (e.g. metaphone of surname + first initial).
- Compare only within blocks; a pair must share at least one block to be considered.
- This turns the problem near-linear and keeps dedup interactive.

## 4. Scoring & thresholds

Each candidate pair gets a score from weighted signals (email/phone exact = high,
name similarity + company = medium). Two thresholds, both in `config.js`:

- **auto-suggest threshold:** above it, the pair appears in the review queue as a suggested merge.
- **strong threshold:** email/phone exact — pre-selected in the UI but still user-confirmed.

Nothing merges without a user action, except import with an explicit `merge`
policy the user chose up front.

## 5. Merge semantics

When the user confirms a merge of B into A (A survives):

- **Fields:** union. On conflict (both have a different non-empty value for a key), keep A's, retain B's in a `mergedFrom` history blob — never discard.
- **Edges:** re-point every edge touching B to A (`UPDATE edges SET source_id=A WHERE source_id=B`, same for target), then dedupe resulting parallel edges by `(source,target,type)`; keep the earliest `created_at`.
- **Interactions:** re-point all of B's interactions to A.
- **Tags:** union.
- **Tombstone:** B is soft-deleted with a pointer to A, not hard-deleted, so the merge is reversible.
- Rebuild the search projection for A.

The entire merge runs in one transaction.

## 6. Undo

Every merge writes a merge-log entry capturing what moved (edges re-pointed,
fields overwritten, B's tombstone). Undo replays it in reverse within the undo
window: restore B, move its edges/interactions/tags back, revert A's overwritten
fields. Undo is a first-class action, not a "restore from backup."

## 7. UX

A dedicated review queue: candidate pairs sorted by score, each showing a
field-by-field diff with the winning value selectable per field. Bulk-accept
strong matches; review weak ones individually. Merge is one confirm; undo is one
click while it's in the recent-merges list. Full flow in `APP_SHELL_UX.md`.

## 8. Non-goals

No ML/embedding-based identity resolution in v1, no cross-contact automatic
household grouping, no third-party enrichment to resolve identity.

## 9. Acceptance criteria

1. **Blocking:** candidate generation on a 20k fixture completes interactively (no full O(n²) scan).
2. **Strong match:** two contacts with the same email surface as a suggested merge.
3. **Weak match:** same name + same company surfaces as a candidate but is not pre-confirmed.
4. **Edge preservation:** merging two contacts re-points all edges with zero edge loss and no parallel duplicates.
5. **Interaction preservation:** merged contact retains both parties' interaction history.
6. **Field safety:** a conflicting field keeps the survivor's value and retains the other in history — never silently dropped.
7. **Undo:** undoing a merge restores the second contact, its edges, interactions, and the survivor's original fields.
8. **Import parity:** import with `merge` produces identical results to manually merging the same pairs.
