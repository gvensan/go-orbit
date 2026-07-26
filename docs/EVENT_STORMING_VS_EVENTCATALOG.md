# Event Storming Workshop vs EventCatalog: Assessment and Roadmap

A comparative analysis of our Event Storming Workshop product and EventCatalog's
Event Storming-related capabilities, a critical review of external feedback
received on the same comparison, and a prioritized set of recommendations aimed
at making our product the best facilitated Event Storming tool available:
method-faithful, easy to use, with clear phases and sticky semantics, and a
credible path from discovery to event architecture.

Sources: EventCatalog public docs and blog (Studio, Miro App, v4, eventstorm-to-catalog),
our published documentation (gvensan.github.io/solace-event-storming-docs), and the
shared third-party feedback. All key claims below were independently verified against
the primary sources on 2026-07-24.

---

## 1. Executive summary

**The one-line distinction holds up: EventCatalog starts from architecture; we
start from discovery.**

- EventCatalog is an architecture catalog with design surfaces bolted on. Its
  Event Storming story is "bring the catalog to a Miro board, propose changes,
  return them to the catalog." It has no workshop runtime: no phases, no
  facilitation, no moderation, no voting, no replay. Verified: the Studio docs
  and Miro App announcement document none of these.
- Our product is a workshop operating system with an architecture exit ramp.
  It owns the method (eight sticky types, causal grammar, five phases,
  moderation, voting, replay, board review) and compiles the result into
  Solace Event Portal JSON.
- The two products are complementary today and will remain so unless one of us
  builds the other's core, which neither should.

**Where we win today:** method fidelity, facilitation, moderation, event-sourced
history, workshop-time quality review, progressive enrichment, deterministic
Event Portal export.

**Where EventCatalog wins today:** starting from existing architecture,
persistent resource identity, existing-vs-proposed distinction, post-workshop
governance, ecosystem breadth (AsyncAPI/OpenAPI/Git), AI grounded in a living
catalog.

**The strategic insight:** the received feedback is largely correct about the
gaps but its priority ordering pulls us onto EventCatalog's home turf. Our
stated goal is to be the best Event Storming tool, not the best catalog. The
right move is to adopt the feedback's correctness foundation and brownfield
import, double down on workshop excellence (where no one competes with us),
and treat catalog-lifecycle features as adapters, not core.

---

## 2. EventCatalog: essence, goals, capabilities

### 2.1 What it is

EventCatalog is an open-source-rooted architecture documentation product for
event-driven systems. Its core artifact is a versioned catalog of domains,
services, messages (events, commands, queries), channels, schemas, ownership,
flows, and diagrams, stored as MDX files in Git.

Its Event Storming story spans three pieces plus one experiment:

| Piece | Role |
| --- | --- |
| EventCatalog Core | The durable catalog: store, version, govern, navigate |
| EventCatalog Studio | Visual modeling canvas with architecture-aware nodes |
| Miro App (v2) | Catalog resources on a Miro board for collaborative design |
| eventstorm-to-catalog | Experimental: photo of a physical wall to catalog via Claude + MCP |

### 2.2 Goals

The product thesis: teams discover designs on whiteboards, then lose
information translating them into schemas, docs, and tasks. EventCatalog
closes that loss by (a) modeling with real primitives instead of generic
boxes, and (b) round-tripping designs to a governed catalog. Its philosophy
statement: architecture primitives (domains, messages, services) outlast
tools, so design in those primitives directly.

### 2.3 Verified capabilities

- **Architecture-aware nodes** (Studio): service, event, command, query,
  external system, data, view, actor, notes. Event Storming-inspired colors.
  Smart connectors that label themselves from endpoint types.
- **Docs on the canvas** (Studio): narrative documentation attached to designs,
  with `@` references to canvas resources.
- **Comments and review** (Studio): threads, replies, resolution. Roles are
  admin/editor/viewer, not workshop roles.
- **Catalog import to Miro**: services, events, commands, queries, channels,
  data stores, with versions, owners, summaries, and relationships intact.
  A service can be dragged in with its full dependency graph.
- **Existing vs proposed**: draft resources are visually distinct from imported
  catalog resources. A board becomes an architecture change proposal.
- **Dependency navigation**: expand graphs, highlight connections, follow flows.
  Answers "who publishes this, who consumes it, what breaks if it changes."
- **Two display modes**: compact Post-its for abstraction, rich app cards for
  metadata. Same board, two zoom levels of meaning.
- **Git lifecycle**: Studio files export to Git, PR review, versioning, restore.
- **Governance** (Core): architecture change detection, schema-change
  notifications, deprecation checks, CI failure actions.
- **AI grounded in the catalog**: generation and cross-referencing consult the
  existing architecture, not just the current board.

### 2.4 Verified gaps (workshop dimension)

No documented support for: facilitator-led phases, phase instructions,
timeboxing, participant/observer links, submission moderation, voting, pivotal
event selection, boundary approval, glossary governance, method-specific
quality checks, session replay, event-sourced undo/audit, presenter-controlled
views, or workshop AI moderation. The method and the facilitation are
delegated to Miro and to the human facilitator.

Also verified: the board-to-catalog return path is AI-mediated (export JSON,
feed to an agent with EventCatalog Skills), not a deterministic compiler. And
eventstorm-to-catalog is explicitly experimental ("work in progress", "you may
find small issues").

**Essence:** EventCatalog is a catalog that visits workshops. It is not a
workshop tool.

---

## 3. Our product: essence, goals, capabilities

### 3.1 What it is

A dedicated Event Storming workshop environment: "from a wall of stickies to
an Event Portal design." It runs the workshop itself (participants, phases,
facilitation, moderation, voting, replay) and translates the outcome into a
Solace Event Portal import file.

### 3.2 The method model (verified from our docs)

**Eight sticky types with canonical colors:**

| Type | Color | Meaning |
| --- | --- | --- |
| Domain event | Orange | A fact that is now true (past tense) |
| Command | Blue | Imperative request to the domain |
| Actor | Yellow | Person or role issuing commands |
| Policy | Lilac | Automated reaction ("whenever X then Y") |
| Aggregate | Yellow | The thing the event happened to |
| External system | Pink | Outside world / third party |
| Read model | Green | Information view for decisions |
| Hotspot | Red | Unresolved disagreement or question |

**Grammar:** Actor issues Command causes Event triggers Policy issues Command.
Commands do not emit events; the handling system does. Hotspots are excluded
from flow wiring. Two relationship mechanisms are kept distinct: attributes
(classification and ownership) versus links (causality). Publish/subscribe is
derived from explicit attributes and links, never from board position.

**Five phases:** Concept alignment, Use-case framing, Storming, Event
architecture, Build planning. Transitions are signal-based, not clock-based.
Phases act as an agenda with nudges; voting is the one hard gate.

**Method fidelity is documented honestly:** phases 1-3 are canonical
Brandolini (color vocabulary, events-first past tense, chaos before structure,
left-to-right timeline, timers prompt but never enforce). Deliberate digital
deviations are stated with rationale (uniform sticky size, opt-in typed links,
replayable log, derived views). Phases 4-5 are an explicit extension: "an
event-driven architecture workshop built on top of Event Storming."

### 3.3 Runtime capabilities

- Facilitator controls: open/moderated participation, phase transitions,
  timers, briefing cards, presenter mode, participant and observer links,
  auto-layout, finalization, export, replay, archival.
- Moderation tray: participant submissions accepted, edited, rejected, or
  explained. AI proposals go through the same tray, never bypassing humans.
- Event-sourced board: append-only log, replay with captions, late-joiner
  convergence, per-sticky history, compensating changes, conflict-aware
  undo/redo.
- Board Review: deterministic checks (grammar structure, orphans, unwired
  policies, duplicates, empty contexts, missing pivotal events; Event Portal
  readiness; topic antipatterns) plus optional AI checks (missing steps,
  naming, contradictions). Unified triage register (addressed / deferred /
  not an issue) with CSV export. AI link suggestions render as amber ghost
  wires requiring explicit acceptance.
- Progressive enrichment: architecture fields (topic path, resolved preview,
  QoS, owning team, schema sketch) stay hidden until the architecture phase.
- Exports: .board.json (full log), .xlsx workbook (11 sheets), .ep.json
  (Event Portal import), architecture SVG, review CSV, SVG snapshots,
  session replay, optional AI synthesis.

### 3.4 Verified gaps

- **No import formats of any kind.** Confirmed in our own reference docs: no
  Event Portal import, no catalog import, no photo import. Every workshop is
  greenfield.
- **No persistent resource identity** beyond the workshop sticky.
- **No existing/proposed/modified state model.**
- **Single-target export** (Event Portal JSON; no AsyncAPI, no EventCatalog,
  no neutral model).
- **Lifecycle ends at export.** No drift detection, no implementation
  tracking, no reconciliation with later reality.
- **Cross-board identity undefined**, and this is already live risk because
  use-case framing explicitly spawns one board per journey.

**Essence:** a workshop that produces an architecture. The mirror image of
EventCatalog.

---

## 4. Head-to-head

| Dimension | EventCatalog | Our product | Edge |
| --- | --- | --- | --- |
| Primary center | Catalog and design lifecycle | Workshop and architecture generation | different games |
| Starting point | Existing architecture | Blank wall | EC for brownfield, us for discovery |
| Method fidelity | ES-inspired colors, no method constructs | Full grammar, phases, documented deviations | **us, decisively** |
| Facilitation | None (delegated to Miro) | First-class runtime | **us, decisively** |
| Moderation and voting | None | Tray, votes, gates | **us** |
| History | Files + Git | Event-sourced replay and audit | **us** |
| Quality checks | Catalog governance, post hoc | Method-aware, workshop-time | **us** (different layer) |
| Existing architecture import | Core capability | Absent | **EC, decisively** |
| Existing vs proposed | Draft distinction on board | Absent | **EC** |
| Resource identity | Named, versioned, owned | Sticky-scoped | **EC** |
| Dependency/impact analysis | Real-graph navigation | Causal links within workshop only | **EC** |
| Board-to-output path | AI-mediated, non-deterministic | Deterministic compiler to EP JSON | **us** |
| Output breadth | MDX, Git, diagrams, multi-standard direction | EP JSON + workbook + SVG | **EC** |
| Post-workshop lifecycle | Strong (governance, drift, CI) | Ends at export | **EC** |
| AI grounding | Living catalog | Current board only | **EC** |
| Physical-wall bridge | Experimental photo-to-catalog | None | EC (weakly) |

Reading of the board: we own the workshop column outright; EventCatalog owns
the lifecycle column outright. Neither is close to taking the other's column.
The contested middle is "what happens the moment the workshop ends," and that
is exactly where the roadmap below aims.

---

## 5. Review of the shared feedback

### 5.1 Overall verdict

High quality, well sourced, and fair. I verified its load-bearing claims
against both products' documentation and found no factual errors:

- Correct that EventCatalog documents no workshop-runtime features.
- Correct that our docs describe no import path (our own reference page
  confirms it).
- Correct that the Miro App's existing-vs-proposed draft distinction is real
  and is the single most valuable idea to borrow.
- Correct that EventCatalog's return path is AI-mediated rather than a
  deterministic compiler (and worth noting: ours IS deterministic, which is an
  underappreciated advantage the feedback does not dwell on).
- Correct and valuable throughout section 10 (mapping determinism): aggregate
  is not automatically a service, policy is not automatically a subscription,
  command is not always a service entry point, topic taxonomy and QoS must be
  policy packs, schema normalization needs provenance and human acceptance.

### 5.2 Where I would reweight it

**1. Its priority ladder drifts onto EventCatalog's turf.** Priorities 2 and 3
(Git-friendly snapshots, EventCatalog/AsyncAPI adapters, CI governance, drift
detection, catalog-grounded AI) describe becoming a lightweight EventCatalog.
Given the stated goal (best Event Storming tool, ease of use, method
alignment, clear phases and sticky types), those are adapter opportunities,
not identity. The change-set idea is the part worth keeping even standalone:
a workshop that emits a reviewable architecture change set is more valuable
than one that emits a static export, regardless of what consumes it.

**2. "Let the architect confirm every mapping" needs a UX guardrail.** The
softening of deterministic mappings (section 10) is conceptually right, but
implemented naively it injects decision fatigue into a live workshop. The
right pattern is opinionated defaults with escape hatches: keep today's
one-click path (aggregate becomes a service candidate, policy becomes a
subscription candidate), pre-select the default, and surface an override
affordance in the architecture phase and in Board Review. Ease of use is a
stated goal; do not trade it for theoretical correctness.

**3. It undervalues our deterministic compiler.** EventCatalog's board-to-
catalog path runs through an LLM agent. Ours is a deterministic export with
explicit semantics. For enterprise trust ("what exactly will be created in
Event Portal?"), determinism is a headline feature. Market it as one.

**4. Cross-board identity is nearer-term than the feedback implies.** It files
this under "needed once import exists." But our own phase model already spawns
one board per journey today, so two boards can already disagree about the same
event. This belongs in the correctness foundation, not in a later phase.

### 5.3 What the feedback missed entirely

These are my additions, aligned with the stated goal:

**1. Workshop levels (Brandolini's three formats).** Classic Event Storming is
three distinct workshop types: Big Picture, Process Level, and Design Level,
each with its own sticky palette and rigor. Our five phases blend them into
one linear journey. Making the level explicit (as workshop templates with
level-appropriate palettes: Big Picture has no aggregates, Design Level opens
read models and aggregates) would deliver exactly the "clear definition and
separation of phases, sticky types" the goal statement asks for, and no
competitor has it.

**2. Timeline mechanics are the soul of the method and can go deeper.** We
have pivotal marks and left-to-right ordering. Missing or underdeveloped:
swimlanes for parallel narratives, explicit chronology tools (drag a pivotal
event and its segment moves), and "walk the wall" as a facilitation feature.
Our replay is 90% of a walk-the-wall storytelling mode: add narrative
stepping (pivotal event to pivotal event, with the facilitator narrating)
and it becomes the room's shared readback ritual.

**3. The physical-wall bridge.** EventCatalog's photo-to-catalog experiment
proves demand for digitizing real walls, but their version bypasses humans.
We have the exact right receiving mechanism already built: the moderation
tray. Photo of a physical wall, AI proposes typed stickies with positions,
every one lands in the tray for facilitator accept/edit/reject. Same
pipeline works for pasted meeting notes or transcripts. This is a fast,
differentiated win that uses existing plumbing and beats their experiment on
the human-control axis where we are already strongest.

**4. Facilitation analytics.** Nobody in this market instruments the workshop
itself: participation balance per contributor, sticky velocity per phase,
hotspot burn-down, vote concentration, timebox adherence. A facilitator
debrief panel ("three people produced 80% of the stickies; the payment
segment generated most hotspots") makes facilitators the product's champions
and produces artifacts they can show sponsors.

**5. Ubiquitous-language enforcement.** We have a glossary and a Board Review.
Connect them: lint sticky names against glossary terms, flag synonyms and
drift ("'Client' on 4 stickies, 'Customer' in glossary"), offer one-click
renames. Cheap, method-aligned, and invisible in EventCatalog's model.

**6. Participant ease-of-use as a measured budget.** The feedback compares
capabilities, never onboarding friction. For a workshop tool the metric that
decides adoption is time-from-link-to-first-sticky for a non-technical
participant. Set a budget (under 60 seconds, no account, no tutorial), audit
against it, and treat regressions as bugs.

---

## 6. Recommendations

Four tracks. A is the identity; B is the foundation; C is the biggest borrowed
capability; D is reach. B before C is a hard dependency; A runs in parallel.

### Track A: Workshop excellence (our moat; the stated goal)

| # | Item | Notes |
| --- | --- | --- |
| A1 | Workshop level templates: Big Picture / Process / Design, with level-gated sticky palettes | Directly delivers "clear phases and sticky types"; unique in market |
| A2 | Timeline depth: swimlanes, segment-aware pivotal events, chronology tools | The method's soul; strengthens phase 3 |
| A3 | Walk-the-wall mode: narrative replay stepping by pivotal events, presenter-driven | Builds on existing replay + presenter mode |
| A4 | Photo and transcript import into the moderation tray | Fast differentiator; reuses tray + AI plumbing; beats EC's experiment on human control |
| A5 | Facilitator analytics and debrief panel | Participation balance, hotspot burn-down, phase timing |
| A6 | Glossary lint in Board Review (ubiquitous language) | Synonym/drift detection, one-click rename |
| A7 | Participant onboarding budget: link to first sticky in under 60s, measured | Ease-of-use as a tracked metric, not a vibe |

### Track B: Correctness foundation (adopt feedback P0, plus one addition)

| # | Item | Notes |
| --- | --- | --- |
| B1 | Technology-neutral canonical domain model between the event log and any export | Log -> canonical model -> proposal model -> adapters |
| B2 | Persistent resource identity (sticky id + canonical id + source + version + status) | Names are not identity |
| B3 | Resource states: baseline / proposed / modified / deprecated / conflicted / accepted / rejected | Prerequisite for C |
| B4 | Configurable rule packs: topic taxonomy, QoS derivation (consequence questionnaire), mapping policies | Defaults stay one-click; overrides are opt-in |
| B5 | Cross-board identity rules (same concept, same name different context, renames, canonical vs copy) | Moved up from the feedback's later phase: multi-board is already live |
| B6 | Soften deterministic mappings via "candidate" semantics with pre-selected defaults | Feedback section 10, with the decision-fatigue guardrail |
| B7 | Schema provenance: keep sketch + generated schema + generator version + approval | Never silently replace input |

### Track C: Brownfield (adopt feedback P1; the biggest borrowed capability)

| # | Item | Notes |
| --- | --- | --- |
| C1 | Import Event Portal resources (domains, applications, events, schemas, owners) | The single largest gap vs EventCatalog |
| C2 | Three start modes: greenfield / brownfield / discovery-only with later reconcile | |
| C3 | Visual distinction existing vs proposed vs modified on the board | The Miro App's best idea, done natively |
| C4 | Architecture change-set report: added / changed / removed / deprecated / conflicted, human-readable | Turns export into a reviewable proposal |
| C5 | Impact hints from imported reality ("this event has 6 consumers today") | |
| C6 | Architecture-grounded AI: consult the imported baseline before proposing ("CustomerUpdated exists; reuse, version, or new?") | Through the moderation tray, as always |

### Track D: Ecosystem reach (feedback P2/P3, demoted to adapters)

| # | Item | Notes |
| --- | --- | --- |
| D1 | AsyncAPI export adapter | First, not EventCatalog: open standard, widens market beyond Solace |
| D2 | Normalized snapshot export for Git diff/PR review (alongside the full log) | Two artifacts: log for replay, snapshot for review |
| D3 | EventCatalog export adapter | Complementary posture: we discover, they govern |
| D4 | Board Review rules runnable in CI against exported snapshots | Governance as a byproduct, not a pivot |
| D5 | Implementation-status tracking and drift detection | Only if pulled by real customers; otherwise EC's job |

### Sequencing

1. **Now:** B1-B3 (foundation) in parallel with A4 and A6 (fast visible wins).
2. **Next:** A1-A3 (method depth) and B4-B7, then C1-C4.
3. **Later:** A5, A7 hardening, C5-C6, D1-D2.
4. **Opportunistic:** D3-D5, driven by customer pull.

### What NOT to do

- Do not rebuild a generic architecture canvas (Studio/Miro already exist).
- Do not chase catalog governance as core identity; ship change sets and let
  catalogs govern.
- Do not let mapping configurability erode the one-click default path.
- Do not adopt an AI-mediated export path; deterministic compilation is a
  trust feature. AI proposes, humans accept, the compiler is exact.

---

## 7. Positioning north star

> **The facilitated Event Storming system.** It runs the room, preserves every
> decision, keeps the method honest, and compiles the accepted domain model
> into a reviewable event-architecture change set, deterministically, for
> Event Portal first and any catalog or standard second.

Against EventCatalog specifically: not a competitor to the catalog, a superior
front end to any catalog. Their weakest documented layer (the workshop) is our
whole product; our weakest layer (lifecycle) is their whole product. Win the
workshop so decisively that "how do we get architecture out of a workshop"
has only one answer, then meet every catalog at the boundary with a clean,
deterministic change set.
