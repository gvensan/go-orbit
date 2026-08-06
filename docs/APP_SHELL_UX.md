# App Shell & UX — Requirements

**Status:** Ready for implementation. Spans M1–M6.
**Why this exists:** the search and graph specs go deep on two surfaces. This
covers the other 60% of the app — the screens a coding agent would otherwise
invent inconsistently — plus the shared design system, keyboard model, and the
error/empty states that are cross-cutting.

## 1. Design language

Carry the graph prototype's identity through the whole app so it reads as one
product, not a feature stapled to a CRUD form.

- **Surface:** deep ink-navy canvas (`#0a0f1c` / panels `#070b16`), slate text, the graph as the luminous centerpiece. The network is a constellation; the UI around it stays quiet and dark so nodes glow.
- **Type:** a clean grotesk for UI, a monospace utility face for data readouts, counts, IDs, and keyboard hints. Data feels instrument-like.
- **Accents:** org/cluster colors and the four edge-type hues are the palette. No competing brand accent.
- **Restraint:** the graph is the one loud element. Every other surface is disciplined — spacing, hairlines, and type do the work.

## 2. Information architecture

```
App
├── Command palette (Cmd/Ctrl-K)   — global, overlays any screen (SEARCH spec)
├── Graph view (home)              — the constellation (GRAPH spec)
├── Contact detail / edit          — a single person: fields, edges, timeline
├── List / table view              — sortable, filterable flat view
├── Import wizard                  — vCard/CSV + archive; dedup step
├── Dedup review queue             — candidate pairs, field diffs (DEDUP spec)
├── Trash / recently deleted       — soft-deleted contacts, restore/purge
├── Settings                       — encryption, backups, export, update, about
└── First-run onboarding           — key setup + optional first import
```

Home is the graph. The palette is reachable everywhere and is the primary
navigation; the list view is the fallback for browsing and bulk actions.

## 3. Screen specs (the ones no other doc covers)

**Contact detail / edit.** Left: identity (name, org, role, avatar-initials),
editable flexible fields with add-field. Center: the contact's ego-network
(mini graph, reuses the renderer). Right: interaction timeline (add note/call/
meeting) and tags. Actions: edit, add relationship, merge, soft-delete. Edits
are optimistic with save-on-blur; deletes route to Trash, never hard-delete.

**List / table view.** Virtualized rows (20k must scroll smoothly), every data column sortable
columns, the same filter facets as search (org, tag, edge type, has-email).
Multi-select for bulk tag / export-subset (subset export is Nice-tier) / delete.
Every user-configurable data table follows the Explore column model: visibility,
width, and order are persisted locally; headers expose separate controls for
sorting, drag-to-move, and resizing; keyboard users move a focused column with
Alt+Left/Right. Structural columns such as selection and the primary Name field
remain anchored while the other columns can move around them.

**Import wizard.** Step 1 pick source (vCard, CSV, `.orbit` archive). Step 2
column mapping for CSV. Step 3 dedup policy (`skip`/`merge`/`keepBoth`). Step 4
preview counts + run with progress. Ends on a report (imported/merged/skipped).

**Dedup review queue.** Candidate pairs sorted by score; each row a field-by-
field diff with per-field winner selection; bulk-accept strong matches; per-pair
review for weak ones. Recent merges list with one-click undo.

**Trash.** Soft-deleted contacts with deletion date; restore or purge (purge is
a real delete, confirmed). Auto-purge after N days, surfaced clearly.

**Settings.** Six tabs, one per concern; the last-viewed tab is remembered.
*Review*: an on-demand data review - structural, relationship, quality, and
graph-shape checks rendered as severity-ranked cards, each with a safe one-click
fix where one exists, a deep link to the offending record otherwise, and
per-finding triage (ignore/defer) keyed on a stable fingerprint so it survives
reruns; a rerun replaces the deck and reports what resolved since last time.
The last run's deck persists and is shown (triage re-merged) whenever the tab
opens, so the screen is only empty before the first ever review.
*You*: the owner profile the network is built around. *Appearance*: the graph
color palette picker (Dusk default plus five named presets and a custom palette
covering the six relationship colors and both gender rings; each palette has an
explicit Apply button and the active one is badged - browsing and editing
change nothing until applied; a per-device preference stored beside the theme,
never in the database). *Privacy &
Security*: encryption status, the online maps/location-search opt-out, the
telemetry statement. *Data & Backups*: contact/connection counts and trash
policy, export archive (with the passphrase option) and contacts CSV export,
import, backup status + back-up-now + restore-from-backup, and the clear-all
danger zone. *About*: version, update check/install, log file location.

**First-run onboarding.** Explain local-first + encryption in one screen,
generate and store the DB key in the OS keychain, then offer an optional first
import. No account, no cloud prompts.

## 4. Keyboard model

Keyboard-first; the mouse is always optional.

| Key | Action |
|---|---|
| Cmd/Ctrl-K | Open command palette |
| Esc | Close palette / clear graph selection / cancel |
| ↑ / ↓ | Move through results or list rows |
| Enter | Open selected contact |
| Cmd/Ctrl-N | New contact |
| Cmd/Ctrl-F | Focus search within current view |
| Cmd/Ctrl-E | Export archive |
| G then G | Go to graph home |
| Del | Soft-delete selected (with undo toast) |

Every interactive element has a visible focus ring; tab order is logical.

## 5. Empty & error states (cross-cutting)

Empty states direct, never decorate. Errors explain what happened and the next
action, in the interface's voice — no apologies, no raw stack traces. Map the
`IpcError` codes (`INTERFACE_CONTRACT.md §4`):

| Situation | What the user sees |
|---|---|
| No contacts yet | "No contacts yet — import a vCard or CSV, or add one." + primary action |
| Search, zero results | "No matches for X. Did you mean *Y*?" (phonetic suggestion) |
| DB corrupt on boot | "We found a problem and restored your last good backup from <time>." — reassuring, factual |
| Migration failed | "Update couldn't finish; your data was rolled back safely. Retry or contact support." |
| Keychain unavailable | "Can't reach your system keychain, so the database can't be unlocked. <OS-specific fix>." |
| Import version too new | "This export is from a newer version. Update the app to import it." |
| `LOCKED` | "Busy finishing a backup — one moment." (transient, auto-retries) |

## 6. Accessibility & responsiveness

- Responsive down to `minWidth`/`minHeight`; the two-column layouts collapse to one column below the breakpoint; the graph reflows (constant node size), never uniform-zoom.
- Respect `prefers-reduced-motion`: disable graph settle animation and path animations.
- Color is never the only signal — pair edge-type color with the legend and, on selection, labels.
- Keyboard operable end-to-end; visible focus; sufficient contrast on the dark surface.
- **Hover help is `title`.** Set a plain `title` on any control that is not
  self-explanatory (icon-only buttons, mode toggles, anything whose effect is
  wider than its label, and any value the column may clip). `tooltip.js` picks
  it up automatically, moves it out of the OS's reach, and draws it in the app's
  type after `config.tooltip.showDelayMs`; it also shows on keyboard focus, so a
  tooltip is not a mouse-only affordance. Never add a second tooltip mechanism,
  and never rely on `title` alone to name a control - icon-only buttons still
  need an `aria-label`. Tooltips say what the control does and what it will
  affect ("acts on the 12 selected contacts"), never just restate the label.

## 7. Acceptance criteria

1. Every screen in §2 is reachable by keyboard alone.
2. List view scrolls 20k rows smoothly (virtualized).
3. Soft-deleted contacts appear only in Trash and are restorable; purge is confirmed.
4. Import wizard completes vCard, CSV, and `.orbit` with a dedup step and a final report.
5. Each `IpcError` code renders its mapped state from §5, never a raw error.
6. `prefers-reduced-motion` disables graph/path animation.
7. Below the min window breakpoint, layouts collapse to one column without overlap.
