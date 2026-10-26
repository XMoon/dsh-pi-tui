# Transcript display disclosure contract

This document defines the display foundation shared by the Direct and Remote
presentation paths. It is a Client-local presentation contract: the Host owns
session facts, while the TUI owns how those facts are disclosed.

## One projection and one authority

The transcript has one semantic projection. `DisplayState.preset` is the sole
writable display authority:

```text
DisplayPreset = focus | compact | full
```

Focus behavior is derived from `preset === 'focus'`; there is no second writable
`focusModeEnabled` state. The persisted `displayPreset` field is canonical.
The legacy `focusMode` field remains only as a migration input and is preserved
during whole-document settings writes.

There is no second transcript data model: Compact is a projection over the same
`TranscriptFolder` rows, sharing one renderer, one measurement path, one
search index, and one viewport owner. Manual disclosure owners (expanded Work
spans, Context clusters, tool cards, Thinking) remain separate from preset
defaults; changing a preset never invents a `lastNonFocusPreset` or transfers
manual disclosure ownership.

**Untrusted-text invariant.** Full, Compact and expanded Focus share ONE safe
**display** projection: every externally sourced message/tool/context string is
projected immediately before its `Text`/`Markdown`/preview/width sink, so a raw
terminal control can never reach the TTY in any preset. The canonical
transcript message stays the authority — the projection never mutates
`TranscriptMessage`, its classification, its chronology or its Work/Context
membership (see `terminal-output.md`).

## Layered defaults

| Preset | Turn layer | Process layer | Focus behavioral policy | Availability |
|---|---|---|---|---|
| Focus | collapsed | collapsed | enabled | available |
| Compact | open | collapsed | disabled | available |
| Full | open | expanded | disabled | available |

The policy table is pure foundation data. DisplayPreset decides the DEFAULT
only; a manual Work/cluster/tool disclosure is never written back into the
preset.

## Semantic classes

`src/domain/transcript/semantics.ts` classifies source messages without
inspecting display text:

- `conversation`: user and assistant messages, including intermediate and final replies;
- `process`: thinking, ordinary tool activity, and retries;
- `attention`: turn errors, interruption cards, and max-token notices;
- `context`: injected context, workflows, compaction, and window summaries;
- `control`: session-level slash commands — a real `kind: 'command'` node
  with no model turn, never Work/Activity/Action input.

Synthetic rows carry source-derived origins (`llm-retry`, `turn-max-tokens`,
`turn-error`, and `turn-interrupted`) so the projection never infers meaning
from wording; the `command` origin belongs to the REAL `kind: 'command'`
control node, not a synthetic Tool.

## Canonical transcript structure

The semantic segmentation is computed once, preset-neutrally, in
`src/tui/transcript/structure.ts`:

```text
raw TranscriptMessage[]
        │
        ▼
projectTranscriptStructure()
        │
        ├── Message
        ├── Work span        (maximal contiguous same-turn Process run,
        │                      carrying foldable Snapshot Context parts)
        └── Context cluster  (raw-adjacent same-turn ambient Context run)
```

- `src/tui/transcript/structure.ts` never reads the preset, the surface, Ctrl+O,
  mouse, search state, expanded owners, default depth, Focus root, viewport or
  render width. It answers only where the raw chronology forms a Work span, a
  Context cluster or a standalone row.
- `isTranscriptWorkMember()` is the single Process membership authority; the live
  Preparing ownership consumes the SAME predicate, so a settled surfaced
  interaction (question / Plan review) closes the trailing run everywhere.
  A same-turn `form:'snapshot'` Context row or a proven Working `tool-jobs`
  Notice may be CARRIED by a Work span, but carriage is the separate display
  predicate `isFoldableWorkContext()` (`isFoldableSnapshotContext()` for
  Snapshots; source-form + the durable same-turn next-step claim flag for
  `tool-jobs`). It never becomes Process, never changes this predicate, and
  never enters Action/timing aggregates.
- `clusterAdjacentAmbientContext()` remains the single cluster membership
  authority, computed from raw adjacency before any row is hidden. A
  snapshot-only cluster can be nested inside a Work span as one structural
  part; a mixed `instructions`/`catalog` + `snapshot` cluster stays an
  indivisible Work boundary.
- Work `owner`/`members` and cluster `owner`/`members` always reference the
  original `TranscriptMessage` objects, so presentation caches compare
  identity/order (never a synthetic hash or a content-derived owner). A Work
  span's `parts` keep the same rows grouped for materialization (single message
  rows and nested snapshot-only clusters), and `owner` remains `members[0]` —
  which may be a Snapshot object even though the span still requires at least
  one real Process row.
- The projector is a single forward pass plus the linear clustering pass (O(n)).
  Snapshot rows seen before the first Process of a same-turn run wait in a
  call-local pending buffer: they join that Work when the Process arrives, or
  materialize as their original Context row/cluster when a hard boundary or the
  window end arrives first. The buffer is never long-lived state and never
  creates a Process-free Work span.
- **Post-turn replay evidence is transcript evidence, never aggregation
  evidence.** The fold is the ONLY authority that can know a row
  MATERIALIZED after its owning turn's authoritative `turn/end` (the row's
  `turn`/`kind` cannot express it), and it records that fact in a
  presentation-only sidecar (`isPostTurnReplayEvidence`). Provenance is
  strictly "newly created after the turn completed" — NEVER "touched by a
  post-`turn/end` event": a `tool/result` that finds its own pending/running
  card still settles that card normally and leaves it fully legal evidence.
  Such a row stays in the transcript (Full, expanded Focus, search,
  diagnostic), but it is excluded from the settled turn's Process/Action
  aggregates at THREE shared consumers: the Action classifier, Work-span
  membership, and consecutive-read grouping (a synthesized group card would
  otherwise launder the provenance back into an aggregate). A replay row is a
  grouping BOUNDARY, so a late read can never merge with a legal one; the
  stateful folder and the exported `groupConsecutiveReads` mirror share the
  one `isGroupableRead` predicate.
  **The fence requires an OWNING turn, and it covers only rows that carry
  one.** A `tool/call` card or an orphan `tool/result` materialized after its
  own turn's `turn/end` is replay evidence. The two producers whose events
  carry NO turn are never marked, because neither can be late for a turn:
  - `command/done` follows a SESSION-level lifecycle (DSH opens no model turn
    for a command — "no turn is opened for it"), so "the merely-current turn is
    completed" is the NORMAL state for the user's idle `/compact`-style
    command, not replay provenance. The card carries the settlement
    `currentTurn` purely as a display PLACEMENT (the fold records only the
    command's name), and that placement is irrelevant to aggregation because a
    command is excluded unconditionally — there is no owning turn to be late
    for, and no owner is derived or reused. The Focus PROJECTION additionally
    treats a command row as a turn-less BOUNDARY (its own authority,
    `focusProjectionTurnOf`), so a standalone command keeps its real chronology
    — after the Thought and the held-back final — and never mints an empty
    Thought for a turn whose only row is a command.
  - `subagent/descriptor` is a single log-only event appended once inside the
    establishing child's initial turn (before its first request); a cold replay
    lands it at that same logged position, so it is original evidence of that
    turn rather than a late arrival.
- **A command row is standalone session-level evidence.** DSH appends
  `command/run` / `command/done` as direct log-only events and explicitly opens
  no model turn for them ("no turn wraps them"); the settled result renders
  outside model history. The transcript therefore keeps the command card as its
  own row — never a Work/Activity member (it SPLITS the surrounding Process
  run), never an Action candidate or ActionStats input, and never a
  replay-fence candidate (there is no owning turn to be late for). In collapsed
  Focus it stays VISIBLE as standalone evidence rather than being hidden as
  process. Its `turn` field is a legacy display-placement artifact only; a real
  `TranscriptCommandMessage` (upstream `CommandNode` convergence) retires it in
  later work, and any correlation with a domain event must use the explicit
  `sourceEventSeq` rather than the placement turn. A `subagent/descriptor` is
  likewise NOT Process evidence, for a different reason: it is the CHILD
  session's identity record (version / mode / provider / label), which a
  continuable child logs BEFORE its first `turn/start` (upstream asserts
  `descriptorIndex < turnStartIndex`) — so it owns no model turn to belong to,
  and it never joins a Work span, an Action or ActionStats. The parent's own
  genuine `tool/call name=subagent` is the delegation evidence.
- **Focus occurrence identity ≠ Focus disclosure identity.** One turn can
  materialize SEVERAL Thought runs (a turn-less window entry splits it), each
  with its own hidden rows, Action winner and component. The presentation
  occurrence identity is therefore the run's first `TranscriptMessage`
  (`FocusProjectedBlock.owner`, the same owner pattern Work/cluster use),
  while the SEMANTIC disclosure identity — Ctrl+O, click ownership,
  `focusExpandedTurns`, `containerPath` — stays the turn number.

Compact, Full and expanded Focus all materialize this structure:

- **Compact** (`src/tui/transcript/compact-projection.ts`) is the materialization
  adapter: a
  collapsed Work span emits its header, an expanded span its members; clusters
  obey the surface capability.
- **Full** emits Work flat (no Work chrome) with the shared cluster
  presentation; its message chronology equals the raw window.
- **Expanded Focus** consumes the same structure for its process tail and
  materializes each canonical Work span as a nested `[focus-root, work]`
  container; its cluster presentation obeys the surface capability exactly
  like Full. It keeps the Focus-specific lead foundation, committed-answer fence
  and final holdback.
  Collapsed Focus keeps its own hoist policy and substitutes the canonical
  cluster identity at its Focus-projected position.

### Presentation owner map

The renderer-neutral presentation core is split from the PiTui mechanics without changing product semantics. The canonical direction is
`PiTui mechanics -> tui/transcript/** -> semantic transcript facts`, enforced by
the `tui-transcript-imports-renderer-mechanics` architecture rule:

| Fact / algorithm | Owner |
|---|---|
| canonical Work/Context structure (`projectTranscriptStructure`, member indexes) | `src/tui/transcript/structure.ts` |
| container-owner vocabulary and equality | `src/tui/transcript/container-owner.ts` |
| Context presentation kind + ambient clustering | `src/tui/transcript/context-structure.ts` |
| structured Context cluster summary | `src/tui/transcript/context-summary.ts` |
| Action source classifier, chronology winner, action stats | `src/tui/transcript/process-summary.ts` |
| renderer-neutral Activity/Work summary | `src/tui/transcript/work-summary.ts` |
| Compact materialization | `src/tui/transcript/compact-projection.ts` |
| Focus projection and holdback/ordering policy | `src/tui/transcript/focus-projection.ts` |
| narrow Work/Context search-reveal resolution | `src/tui/transcript/reveal.ts` |
| PiTui Focus card + header/body formatters | `src/tui/components/transcript/focus-activity.ts` |
| PiTui Activity card | `src/tui/components/transcript/compact-work.ts` |
| PiTui compact slot/Preparing/action presentation + cache signatures | `src/tui/components/transcript/compact-process-preview.ts` |
| PiTui Context cluster header and standalone Context rows | `src/tui/components/transcript/{context-cluster,context-row}.ts` |
| rendered-row search geometry/highlight | `src/tui/components/transcript/search-presentation.ts` |
| final-Assistant qualification (shared by Focus and visuals) | `src/domain/transcript/final-assistant.ts` |
| published-visual placement + shared-definition context | `src/domain/visual/placement.ts`, `src/domain/visual/presentation.ts` |
| PiTui ordered Assistant visual body + definition-prefix Markdown | `src/tui/components/transcript/{visual-assistant-body,shared-definitions-markdown}.ts` |

`tui/transcript/**` imports no PiTui, Tern, `TuiApp`, theme/icons, renderer
registry or concrete TUI component; it reads the semantic owners from
`src/domain/transcript/**` instead of the `src/transcript.ts` facade. The
Context semantic authority (`contextFormOf` / `isAmbientContext`) lives in
`src/domain/transcript/context-semantics.ts`; search overlay state lives in
`src/app/surface/search-overlay.ts`, interaction rendering in
`src/tui/interaction/transcript-search.ts`, and search semantics in
`src/domain/transcript/search.ts`.

## Compact projection

Compact materializes the canonical Work spans as presentation-only `Work` cards
(`src/tui/transcript/compact-projection.ts`):

```text
raw:      User · Thinking A · Tool A · Assistant A · Thinking B · Tool B · Notice · Tool C · Assistant final
Compact:  User · Work(A)      · Assistant A · Work(B)      · Notice · Work(C) · Assistant final
```

- `Work.members` preserve raw order; `Work.owner` is the first member
  `TranscriptMessage`, the stable disclosure identity. `Work.parts` keep the
  same raw sequence grouped for materialization: single rows plus a nested
  `context-cluster` for a raw-adjacent snapshot-only run.
- Conversation (user, steer, intermediate assistant, final assistant) and
  Attention rows always end the current span and stay visible at their
  chronological position.
- Every surfaced Context presentation is a Work boundary **except a foldable
  Snapshot or a proven Working `tool-jobs` Notice** (Owner decision):
  a `form:'snapshot'` singleton, a snapshot-only raw-adjacent cluster, or a
  `tool-jobs`/`notice` row with the durable same-turn `next-step` claim flag is
  carried by the same-turn Work instead of splitting it. A mixed
  `instructions`/`catalog` + `snapshot` cluster, an unqualified/foreign
  `notice`, `relay`, `recall` and every unknown form remain boundaries. The
  carried Context keeps its own row/cluster disclosure inside the expanded
  Work; a collapsed Work shows neither its header nor its body. Context never
  contributes an Action, ActionStats entry or wall-clock timing to the span.
- A collapsed `Work` renders `Header`, at most one `Think` row (the latest
  reasoning tail, following it while reasoning streams) and at most one `Tool`
  row (presenter-first semantic display, `focusToolDisplay` fallback). There is
  deliberately **no Message slot**: Assistant intermediate narration is already
  visible outside the span. Absent facts render no placeholder row.
- **Historical compaction:** only the LIVE / Preparing / TRUE
  latest Work of the current window keeps those previews. A settled historical
  span collapses to its header only, and a historical span whose only evidence
  is Thinking renders the presentation-only identity `Thought <duration>`
  instead of a semantically empty `Activity` (still the same
  `TranscriptWorkSpan`; never a semantic class, stat or persisted state — and
  the latest think-only span stays `Activity` so the identity never flips
  while streaming). `Thought` means NO Action evidence at all: an orphan tool
  result owns the collapsed `Action:` diagnostic while counting zero actions,
  so such a span keeps the `Activity` identity (header-only, preview hidden).
  This policy is COMPACT-ONLY: expanded Focus materializes the same canonical
  spans through the same component path, and its nested Work keeps the
  original header + Think/Action contract (`Thought` never appears outside
  Compact). The "true latest" test is the window authority
  (`transcriptWindow.hasNewer !== true` AND the span is the projected tail):
  a history page's last Work is that page's tail, not the global latest. The
  policy bit (`showPreview`) joins the Compact Work component-cache signature,
  so the latest → historical transition repaints even when the span's own
  summary is unchanged, in both window-paging directions.
  Compact current work is observable; historical work is scannable; detail
  remains available on demand.
- Counts and previews describe the SPAN, never the whole turn. The header
  duration is the span's OWN wall clock from its members' timing evidence;
  it is omitted only when no member carries a `TranscriptTiming` sidecar
  (unknown is omitted, never `0s`) — never faked or stretched from the
  whole-turn Focus duration.
- Expanding a `Work` span reveals its raw member rows through the existing
  message renderers; Thinking and tool-local detail keep their own orthogonal
  disclosure.
- Disclosure ownership is converged (see the sections below): on the
  regular surface the shared `Ctrl+O` transcript-detail master owns Compact
  Work, Context clusters, ordinary folds and long/pending-user folds whenever
  the effective `app.transcript.toggleExpand` key exists. Fullscreen Compact
  keeps the Work-span bulk and fullscreen Focus keeps the Thought-root bulk,
  with the mouse owning the local folds there. Every collapsed representation is
  capability-gated: a fold with no operable owner is not presented collapsed at
  all — the row renders in full and advertises no hint. Alt+T still owns
  Thinking detail, independently of all of them: on a regular surface without an
  effective `app.transcript.toggleThinking` key the Thinking body fails open
  (full body, no hint), while fullscreen keeps its mouse per-card owner.
- Members of an OPEN Work run follow the same surface contract: regular
  full-reveals them, fullscreen keeps the per-card click (`(click to expand)`),
  and a hidden member revealed by search is promoted to a manual Work owner when
  the search closes.
- **Live Preparing and the Activity disclosure.** Live Preparing enters
  Activity presentation only while a still-open canonical trailing
  `TranscriptWorkSpan` exists (the collapsed `Action:` slot, or an inserted
  preview row after the durable members). A Preparing call belonging to a NEW
  run with no durable Process member yet has NO Work disclosure owner: it fails
  open as ordinary live Preparing rows — no `▸ Activity` chrome, no pseudo
  `Action:` summary, no ephemeral owner state. The Activity disclosure appears
  only after the first durable Process member lands and the canonical WorkSpan
  forms.
- The capability is applied where the renderer BUILDS the disclosure, so no
  hidden-row count, marker or search geometry is ever produced for a fold that
  cannot be operated.

## Surfaced Context

Injected context is the semantic class `context`; `context: true` on a folded
system row is the surfaced authority. The producer-declared
`MessageSource.form` (retained at fold time as presentation-only provenance)
decides HOW the row is presented:

```text
Surfaced Context
├─ ambient   instructions | catalog | snapshot -> adjacent raw rows may cluster
├─ notice    standalone producer account (summary at normal brightness)
├─ relay     standalone Agent message (sender + body visible)
├─ recall    standalone Session recall (structured labels)
└─ unknown   standalone generic Context injection (fail open)
```

- `contextPresentation(source)` is the single parser of raw context sources
  (`context.ts`); no other layer re-parses the source. The fold may add the
  presentation-only `sameTurnNextStep` flag from its durable inbox claim chain;
  that flag never rewrites the parsed source facts.
- Unknown or absent forms are never coerced into the ambient role.
- A notice shows its producer-authored `summary` below the header at normal
  brightness, wrapped naturally at render time. The TUI never invents a
  head/first-row summary, and never truncates the summary to one physical row.
- A relay names its `senderSessionId`, shows its body by default at normal
  brightness, and reuses the long-message disclosure geometry verbatim (the
  same threshold plus head rows + overflow marker + tail rows) for a long body,
  so another Agent's concluding lines stay visible while collapsed. The
  semantic class stays Context — presentation is reused, semantics are not
  rewritten to `user`.
- A recall names its structured labels; no summary is invented when metadata is
  absent.
- **Card-internal header→body layout.** A standalone Context card's HEADER sits
  at the transcript left edge like every other container chrome; the card's OWN
  body is subordinate to it and indented 2 cells — the notice summary and its
  expanded payload, the relay body and its long-message overflow marker, and the
  recall payload. The body wraps/truncates at the reduced content budget BEFORE
  the indent is applied, so the lead can never push a row past the terminal
  (below 3 columns it is dropped rather than overflowing). This is the card's own
  hierarchy, the same relationship the Tool card's payload inset expresses; the
  outer container flattening and `containerPath` semantics are unaffected.
  **Wide-grapheme artifacts are suppressed per LOGICAL line:** the fork cannot
  split a wide grapheme, so a content-bearing line at content width 1 comes
  back as a zero-width row beside the over-wide one — that zero-width row is an
  artifact and is dropped (otherwise it becomes a pure-indent ghost row and
  shifts the relay's threshold / head-tail / hidden-row math). A blank or
  whitespace-only logical line keeps its established blank-row contract; a
  blanket `visibleWidth(row) === 0` filter is deliberately NOT used because it
  would delete genuinely blank source lines.

### Ambient clustering

`clusterAdjacentAmbientContext` groups only rows that are same-turn,
raw-adjacent, surfaced Context, and ambient form; two or more such rows become
one cluster. Clustering is computed from RAW chronology before any Process
hiding, so a Process row between two Context rows never merges them. A notice,
relay, recall, unknown Context, Conversation, Attention, workflow, compaction,
window summary or turn boundary ends the run.

Clustering is SEMANTIC and identical on every preset and surface: the cluster
owner, the search reveal/promotion owner, the viewport identity and the
raw-adjacency rule all stay cluster-based. Only the DISCLOSURE PRESENTATION is
surface-dependent:

- **regular**: the members are presented directly (flat) — the surface has no
  manual cluster disclosure owner yet, so a collapsed header would be a dead
  end. The semantic cluster still groups the rows for search and promotion.
- **fullscreen**: the cluster defaults collapsed (`▸ 📎 Context · N injections`
  plus the structured summary) and is click-expandable; expanding re-emits every
  member as an ordinary Context row, and member payload disclosure stays
  independent.

The cluster header composes two registry-resolved semantics: the section
disclosure state marker (`▸`/`▾`, which survives every icon style) and the
Context identity icon (`context-generic` — `📎` under emoji, `⋅` under symbols,
hidden under minimal). Each part carries its separator only when its glyph
exists (`iconLead`), so `minimal` reads `▸ Context · N injections` with no
dangling space. The Work header deliberately keeps its bare section marker: it
is a presentation container with no separate business identity.

The cluster summary is built from structured labels/forms only (duplicate labels
compress to `label ×N` for display; the transcript is never deduplicated or
reordered).

### Snapshot Context follows Work

`form:'snapshot'` is the ONE ambient Context form whose disclosure belongs to
the surrounding turn work. The producer-declared `form` stays the authority; the
structure layer answers only the display question "may this row be carried by
the same-turn Work?":

- `isFoldableSnapshotContext()` = surfaced Context + `contextFormOf() ===
  'snapshot'` + (no raw-adjacent ambient cluster, or a cluster whose members are
  ALL snapshots). It never changes `isTranscriptWorkMember()`, the Action
  classifier, the durable message union or the Session facts.
- A foldable Snapshot (singleton or snapshot-only cluster) no longer ends a
  same-turn Process run. It can appear at the start, middle or end of the Work;
  a snapshot-only raw-adjacent run becomes ONE nested Context cluster part of
  the span.
- A **mixed cluster** (`instructions`/`catalog` + `snapshot` in one
  raw-adjacent ambient run) stays one indivisible Work boundary. Neither the
  cluster nor the Work may tear it apart. `notice`/`relay`/`recall`, unknown
  forms, Conversation, Attention, commands, compaction and turn boundaries keep
  their existing boundary semantics.
- A Work requires at least one real Process row: Snapshot-only segments keep
  their original Context row/cluster presentation and never mint a zero-action
  Activity, even when a live Preparing call is waiting.
- The carried Snapshot stays Context: it contributes no Action, no ActionStats
  entry and no span timing; the collapsed header and the Focus Action slot never
  count it. Its payload and its own long-message disclosure stay reachable.
- Preset behavior: **Full** keeps the raw chronology with the same Context
  header/body and no Activity chrome; **Compact** folds it under the Activity
  header and restores its Context row/cluster disclosure when the Work opens;
  **Focus collapsed** hides it inside the real Thought (also for a
  Snapshot-only turn with a Thought owner) and **Focus expanded** restores it
  exactly once in raw order. Without a real activity owner every Snapshot row
  fails open instead of disappearing.
- Disclosure/search ancestry is outer-to-inner
  `[focus-root?, work, context-cluster]`; a search hit inside a nested snapshot
  cluster opens both ancestors temporarily and an ordinary dismiss promotes
  both. Ctrl+O/mouse work exactly like any other Work/cluster owner, and a
  fail-open surface renders the rows flat without a dead header.
- No new preset, persisted field, state store, Host behavior or classifier
  authority is introduced: this is a presentation-only refinement of the
  existing Owner-accepted three-preset contract.

### Working `tool-jobs` Notice follows Work

One non-Snapshot Context row has the same narrow carriage: a producer-declared
`kind:'tool-jobs'` / `form:'notice'` completion Notice that the agent inbox
delivered through **`next-step` during the same still-working turn**. This is
a deliberately narrow exception, never a generic notice rule:

- Qualification requires ALL of: surfaced Context + `sourceKind ===
  'tool-jobs'` + `form === 'notice'` + the fold's presentation-only
  `contextPresentation.sameTurnNextStep` flag. That flag is derived by the
  `TranscriptFolder` from the durable `agent/inbox/spliced` insert/claim
  identity chain (the same message id inserted into `next-step`, claimed, then
  materialized as `user/message` in the SAME turn) — never from
  `Agent.status`, the summary/header text, the TUI Working indicator or visual
  adjacency.
- A `next-turn` idle wakeup, a next-step message claimed in a DIFFERENT turn,
  a foreign/legacy log, a missing claim, or any other producer (including
  `subagent-settled`, relay/recall/unknown and future producers) keeps the
  existing independent Context behavior: the notice explains why the agent was
  woken and must stay visible.
- The qualified Notice is carried by the same-turn Work exactly like a
  Snapshot singleton (it can appear at the start, middle or end; it never joins
  `ContextCluster`, which still accepts only raw-adjacent ambient rows). A Work
  still requires at least one real Process row; a Process-free segment keeps
  the original Notice card and never mints an Activity.
- It stays Context: no Action, ActionStats or span timing contribution. Its
  own Notice card header/summary/body disclosure and search reachability are
  preserved.
- Preset behavior matches the Snapshot carriage: Full keeps the raw chronology
  and card; Compact folds it under the Activity and restores the card when the
  Work opens; Focus collapsed hides a qualified mid-turn Notice inside the
  real Thought (the opening user guard still applies: a Notice before the first
  non-steer user, and every `next-turn` wakeup, stays foundation), and expanded
  Focus restores it once in raw order. An unqualified Notice keeps the existing
  pre/post-Thought rule.
- The durable claim flag is presentation-only (`sameTurnNextStep` on
  `TranscriptContextPresentation`); it is never written back to the Session
  source, message, model input or Host/Remote wire. Search/click/Ctrl+O,
  nested ancestry and capability fail-open are the same as Snapshot carriage.

### Surfaced interaction evidence (settled question / Plan review)

A SETTLED surfaced-interaction tool card is not ordinary Process work: it is
human-interaction evidence (the user's own decision), so it is surfaced
independently of the Work/Thought. The authoritative set is exactly
`ask_user_question` (the user's answers) and `exit_plan_mode` (the Plan review
/ approval result). The decision is source/tool identity only
(`kind === 'tool'`, a name in that set, `status !== 'running'`) — never the
display title, the result wording, whether a modal opened, whether the tool
required an approval, or how rich the card looks; and never a fifth semantic
class:

- Compact: the card is a Work BOUNDARY and renders standalone in raw
  chronology (`Work A · Interaction · Work B`); it is never a span member, so
  it contributes no tool count or latest-meaningful-Tool preview — running or
  settled.
- Focus collapsed: the card is hoisted out of the Thought like a user/steer or
  surfaced-context row, in raw relative order and without crossing the
  committed-answer/user ordering fence.
- Focus expanded: the card returns to its exact raw position.
- Full: unchanged chronology.
- The card's OWN disclosure is independent of the Focus root: a root
  collapse/expand never changes it. Fullscreen Focus keeps the mouse-owned
  per-card disclosure (collapsed by default; a click toggles only the card) and
  the card is exempt from the root-collapse secondary reset. Regular Focus has
  no per-card owner independent of the root — Ctrl+O drives BOTH the root and
  the tool-detail master — so the card fails open/full there and advertises no
  fold hint (never a Ctrl+O affordance that would actually drive the root);
  unchanged.
- A RUNNING interaction is untouched: the QuestionFlow / plan-mode approval
  panel owns it and no duplicate settled-style card is surfaced.
- Search never opens or promotes the Thought root for a card that is already
  fully visible: on regular Focus (fail-open) the target needs no deeper reveal,
  so `searchTargetTurn()` reports none and an Esc dismiss cannot promote the
  root into manual expansion. Fullscreen Focus keeps the deeper reveal for its
  collapsed, mouse-owned card.
- The turn's tool count, tool-type stats and Tool slot exclude these tools, so
  a `Tool A · Interaction · Tool B` turn still previews a real tool.
- Partial/skipped/cancelled/errored question cards stay surfaced; the collapsed
  card shows the `N/M answered` summary derived from the producer's answers
  JSON, and the expanded card the structured `● id → answer` /
  `○ id — skipped` rows, never raw JSON. The Plan review card keeps its
  existing plan-body presentation.
- Everything else stays ordinary Process — including `todo_write`, the goal
  tools, `send_message` / `interrupt_agent` / subagent controls, workflow /
  schedule / cordis tools, and `bash` / `edit` / `write` / `read` / search /
  `run_code`. A tool having a rich card, or having required a permission
  approval, does NOT make it interaction evidence; approval is an execution
  gate, not a durable transcript interaction identity.

### Disclosure chronology

- Collapsed Focus surfaces user/steer rows and causal Context in raw relative
  order before the Thought.
- An opening ambient burst (the initial user plus the immediately following
  surfaced Context rows) stays above the Thought in both Focus states; a
  mid-turn Context row/cluster returns to its chronological position when the
  Thought is expanded. **Exception:** a foldable Context row
  (Snapshot or proven Working `tool-jobs` Notice) after the initial user stops
  the foundation boundary and follows the Thought instead (hidden while
  collapsed, restored once in raw order when expanded); a mixed
  `instructions`/`catalog` + `snapshot` cluster keeps the foundation position as
  one indivisible unit. A Context row that truly precedes the initial user is
  never moved across that user.
- Collapsed Focus also hides a foldable Snapshot-only turn (and a proven Working
  `tool-jobs` Notice with a Thought owner) inside its real Thought; both remain
  recoverable there. Without an activity owner the rows fail open.
- **Userless (next-turn wakeup) turns:** there is no initial user to anchor the
  foundation. The leading run of NON-foldable Context — the wakeup Notice and
  any `instructions`/`catalog` — is the foundation; the first foldable Snapshot
  or proven Working `tool-jobs` Notice starts Thought content. The wakeup cause
  therefore stays visible while later internal Snapshot / next-step notices
  fold, and expanded Focus restores them once in raw order.
- Collapsed Focus distinguishes CAUSAL INPUT from MID-TURN PROCESS FEEDBACK by
  the producer-declared `form` and raw position, never by source kind: a
  mid-turn `form:'notice'` (a background job or subagent settling while the
  Agent already works) renders AFTER the Thought as a visible post-Thought row
  (visible process feedback, never hidden inside
  the collapsed Thought and never a candidate for its Action slot); a notice
  inside the turn's opening foundation (the `thoughtLeadBoundary()` area) stays
  BEFORE the Thought because it explains why the turn started; a mid-turn relay
  stays visible because it is external Agent-authored input. **v2 exception:** a
  `tool-jobs` Notice with the durable same-turn `next-step` claim flag follows
  the Thought instead (hidden while collapsed, restored once in raw order);
  `next-turn` wakeups and every unqualified/foreign notice keep this existing
  post-Thought or foundation rule. Expanded Focus restores every notice at its
  exact raw position. Compact keeps every UNQUALIFIED notice standalone (a
  qualified Working `tool-jobs` Notice folds into its Activity), and Full keeps
  the full chronology for every notice.
- A search hit inside an UNQUALIFIED mid-turn notice needs no Focus-root
  reveal and no special forced-visible path: the row is already visible outside
  the Thought, so ordinary search addresses it like any other surfaced Context
  card. A match inside the folded Notice payload still opens through the row's
  own ordinary message disclosure. A QUALIFIED Working `tool-jobs` Notice
  follows the Work/Thought ancestry instead (the Work/Thought reveal opens it,
  then its own card disclosure shows the payload).
- Full keeps the original transcript chronology, with ambient clusters
  substituted in place.
- Context never enters the Focus Think/Tool/Message slots or the tool counts.

## Persistence migration

Startup resolves canonical data before the first agent composition or TUI frame:

1. any recognized `displayPreset` (`focus|compact|full`) wins over every legacy
   value and is never rewritten;
2. an invalid canonical value resolves to Full and is canonicalized;
3. when canonical data is absent, legacy `focusMode: on` maps to Focus;
4. every other absent-canonical legacy value maps to Full.

A required canonicalization write is detached and best-effort. It writes only
`displayPreset`, preserves unrelated settings and user footer definitions, and
does not mutate `focusMode`. A failed write leaves the live state in effect and
can retry on a later boot.

## Commands and settings

`/display` is the canonical local/sessionless control:

```text
/display          -> status
/display status   -> status
/display full     -> Full
/display focus    -> Focus
/display compact  -> Compact
```

`/focus` remains a stateless compatibility adapter:

```text
/focus on       -> Focus
/focus off      -> Full
/focus toggle   -> Focus unless already Focus, otherwise Full
/focus status   -> on only when the preset is Focus
```

The settings row is `display-preset` with `full`, `compact` and `focus` values.
The canonical Footer item is `display-preset` and always shows the active
preset; the historical `focus-mode` item remains for custom-layout compatibility
and renders only when the canonical preset is Focus.

## Direct and Remote parity

Display semantics are Client-local and must not become a second wire protocol.
Direct and Remote readers consume the same semantic projection and the same
canonical display-preset vocabulary. The presentation-read shadow additionally
compares the deterministic default Compact projection at both readers. Remote
parity options may select the client-local preset, but they do not create
Host-owned display state or a Remote-only disclosure behavior.

## Disclosure ownership and search reveal

The Work / Context-cluster / surfaced-interaction boundaries are computed once
by the preset-neutral canonical structure; Compact (Process collapsed), Full
(Process expanded, flat) and expanded Focus all materialize that same structure.
State storage stays owner-specific, while owner resolution, capability, ancestry
and reveal routing are shared. The following are permanent must-nots:

- Do not change the default preset as a side effect of another feature.
- Do not introduce a second search/render/viewport path or a second transcript
  store.
- Do not add a Work identity icon or a Compact narration prompt without an
  Owner-accepted product decision.

### Neutral container ownership

`src/tui/transcript/container-owner.ts` owns the ONE container-owner vocabulary
(`focus-root` by turn; `work` / `context-cluster` by canonical first-member
object identity). Row ancestry is generated by the projection that produced the
row — never reconstructed from screen geometry. The generic nearest-container
rule resolves a trailing blank spacer to the DEEPEST container the row and the
next VISIBLE row share: an internal Work spacer collapses that Work, a spacer
between nested Work and a Thought-only row collapses the Thought, a cluster
spacer collapses the cluster, and a boundary/global blank is inert. Concrete
local targets (the long-user bubble as a whole — collapsed or expanded, its
BODY is the hit surface — PTC sub-call, Workflow, attachment,
secondary card) always win before the container fallback.

### Regular-surface disclosure ownership

The regular surface has no mouse, so `app.transcript.toggleExpand` (Ctrl+O) is
its ONE operable disclosure action. When that key exists:

- regular Compact Work is collapsed by default and the common transcript-detail
  master expands the recent Work spans, Context clusters, ordinary folds and
  long/pending user folds;
- regular Context clusters collapse behind a real keyboard-owned header;
- regular Full keeps Process flat but collapses Context clusters;
- regular expanded Focus full-reveals the Work nested in an expanded Thought.

When the key is unavailable (remapped away/disabled) every one of those folds
fails open: no collapsed header, marker or `(ctrl+o to expand)` hint is ever
rendered for an inoperable owner.

**Delivered files** (an assistant tail with more files than the folded limit)
are their own message-local family, converged onto the same contract: the
regular transcript-detail master and fullscreen Full's generic master own the
capped tail while the effective `app.transcript.toggleExpand` key exists; every
other surface — fullscreen Compact, fullscreen Focus, or any surface without the
key — fails the tail open (all files visible), because no operable owner exists
there. A search reveal only opens the tail when the matched file is beyond the
folded limit AND the tail is not already expanded; an ordinary dismiss promotes
the durable override only on a master-owned surface and only for a genuinely
hidden match.

### Nested Focus Work

Expanded Focus materializes each canonical Work span as a nested container
(`[focus-root, work]`). Its structural parts keep a snapshot-only Context
cluster as `[focus-root, work, context-cluster]`, with the cluster's own
disclosure inside the open Work. Fullscreen defaults Work collapsed with a
mouse-owned header and search may reveal it temporarily; regular Focus opens it
whenever the owning Thought is effectively expanded (the historical full-reveal
contract). An explicit root collapse returns that turn's manual Work owners to
the Compact default ("reopen compact"); a temporary surface/search-only hiding
never clears manual Work state. Root bulk Collapse All clears the Work owners of
every collapsed root.

### Search reveal path

Search reveal is a container PATH, not a Compact-only one-owner resolution. The
path is composed from the current preset/surface capability, `searchTargetTurn()`,
canonical Work membership and canonical cluster membership. Navigation opens
every hidden node temporarily without writing manual state; an ordinary dismiss
promotes every currently necessary node atomically; an explicit collapse revokes
the temporary reveal so the owner cannot instantly reopen. A flat/fail-open
container mints no reveal node.

## Hardening guarantees

These guarantees hold under bad input, long sessions and rapid live updates:

- **Malformed / legacy Context.** A restored or foreign log may record a
  `null`/missing/non-object `source`, an unknown or non-string `form`, an
  invalid `summary`/`senderSessionId`, or malformed `changes`/`references`
  arrays. The fold reads the source kind through the single parser
  (`contextPresentation`) and degrades such rows to a standalone generic Context
  row: never a crash, never a fabricated summary/sender/label, never an invented
  ambient role. A legacy `session-reference` keeps its recall role with or
  without a declared form.
- **Large-history scaling.** `projectCompact`, `clusterAdjacentAmbientContext`
  and the cluster summary stay linear. The transcript presentation memoizes the
  active search reveal owner per projection (keyed on the target, preset,
  surface and window identities), so a projection resolves it a small constant
  number of times rather than re-projecting the whole transcript per row; the
  parser's distinct-label dedup uses a Set for the same reason.
- **Streaming / Preparing.** One live Preparing call belongs to the turn's
  still-open trailing Process run; once a Conversation / Context / Attention /
  turn boundary closes it, the call belongs to an ephemeral pending Process
  run that never moves backward, never duplicates a durable Tool, leaves no
  ghost row on cancel, and leaves no stale owner across a session, preset or
  surface switch. A pending Process run is presentation-fail-open until a
  durable WorkSpan exists: it renders as ordinary Preparing rows and never
  mints Activity disclosure chrome.
- **Search / disclosure.** A flat/fail-open container never mints an inoperable
  owner; a surface switch during search re-checks the capability; a topology
  mutation re-resolves the current container path instead of a stale identity;
  and an UNQUALIFIED mid-turn notice is already visible outside the collapsed
  Thought, so search reaches it through the ordinary row/message disclosure
  paths. A proven Working `tool-jobs` Notice is hidden with the Work/Thought
  and resolves through that ancestor path instead.
- **Width / grapheme.** Every transcript row family (Work, pending Preparing rows,
  Context cluster, notice, relay, recall) obeys the framebuffer width contract
  at the current width for ASCII, CJK, emoji, combining marks, ZWJ emoji and
  ANSI-colored text; the notice summary keeps its natural wrap.
- **Windowing.** A window clusters and folds only the rows it contains: no
  off-window member is invented, the window-summary marker ends a run, and a
  page/window change is a new disclosure epoch that prunes every Compact
  Work/cluster owner the new window no longer projects. Object identity alone
  cannot expire such an owner — the folder returns the SAME message objects when
  a page is revisited — so an A→B→A round-trip never resurrects a dropped
  expansion (a search jump keeps the same window and its owners).


## Tool cards and folded previews

Every card renders through the Web parity render intents in
`src/tui/transcript/tool-presentation.ts` (`webCardLines`,
`genericRawInputLines`, `resultTextLines`, `foldedCallPreview`,
`summarizeToolArgs`, `askAnswersLines`, `goalResultLines`,
`FOLDED_JSON_RESULT_TOOLS`, `TUI_TOOL_TITLES`):

- Web search/fetch results keep their structured source/answer views.
- Object `rawInput` uses one-line shapes (todo checklist, terminal target,
  session-event `session_id · seq`); pretty JSON is only for unknown objects.
- Plan/content blocks and generic `resultText` semantics are unchanged.
- Folded previews add query/URL/skill and `todo 2/3 done`.
- `ask_user_question`: the folded row is `— N/M answered` (never raw
  `{"answers":…`); expanded keeps the summary and adds one line per answer
  (`● <id> → <selected|custom>`, `○ <id> — skipped`). Unparseable/mismatched
  JSON falls back to the generic preview; cancelled/aborted keep the
  error-identity branch.
- Goal tools (`get_goal`/`create_goal`/`update_goal`): headers Read/Create/Update
  Goal; the args summary shows the objective (create) or action (update),
  nothing for get; the folded summary is
  `phase active · revision N · N/M rounds` or `no goal set`; expanded field
  lines show objective, phase/revision, rounds, blocked reason and activation.
  Lenient `{"goal":…}` parsing; undefined falls back to generic.
- JSON-result families (`schedule_*`, `cordis_inspect_*`, `ralph`): the expanded
  body stays VERBATIM; the folded preview shows a parsed summary or drops the
  preview row — never raw JSON. Failed calls never take the summary branch.
  Agent-team tools are excluded by name because they collide with subagent tool
  names.

Must-not: render raw JSON or raw model-facing XML on a folded row; beautify an
expanded generic JSON body; mutate `TranscriptMessage` or model bytes; let an
unknown tool lose the generic path.

Proof: `test/domain/rendering.test.ts` ("web search result views render sources and the
answer", "folded JSON-result cards show the summary, never the raw JSON",
"settled ask_user_question cards show the answered count", "goal cards without
a goal say no goal set").

## Assistant-owned published visuals

A published visual is Assistant-owned presentation evidence only through the
`present_visual` authority over the exact Session log. The final-answer
projection consumes the SAME final-Assistant qualification as Focus
(`src/domain/transcript/final-assistant.ts`): only a completed or max-tokens
turn's structural latest step, with renderable content, may own a visual.
Publication refs from a different turn, a window outside the answer, or a
replaced/forged receipt never enter the row.

`src/domain/visual/placement.ts` owns the ONE placement projection. The
Assistant's original `ContentBlock` text is the sole coordinate authority:
strict `[dsh-visual-sv1_…]: <#>` top-level definitions are consumed as source
spans, the renderer receives a single ordered `text | visual` sequence with
explicit empty boundaries, and unconsumed published refs are appended to the
answer body in first-publication order before the delivered-files tail. Ordinary
link definitions of a continuous Markdown text run are re-supplied only as a
display-only prefix so cross-segment references keep their real href; that
prefix never enters the Session, search corpus, `/transcript` export or model
bytes. The plan never reads render width, focus state, a tool card or a client
canvas.

One eligible Assistant remains one transcript row, one component-cache entry and
one disclosure owner. Its body may mix Markdown, `ChartBody`, `SvgThumbnail` and
the existing non-text blocks under the single original Agent bullet; the
visual-projection revision is part of the row's cache identity. Full, Compact,
Focus and expanded Focus all render that same row. A marker's text is hidden
from the display surface but remains readable raw source; search authority stays
the raw message corpus, and a display-only suppression is allowed only for a
message-corpus match whose hidden marker paints no occurrence (a
delivered-file target keeps its anchor even when its folded preview is closed).

Renderer ownership: an installed Assistant extension renderer keeps its
existing whole-card ownership. The ordered Host visual body applies only when
the Host renders the Assistant; an extension-owned card is never bypassed for a
published visual, never overlaid with a second figure card, and never given a
different renderer snapshot. The Stable Extension API is unchanged. When the
extension chain abdicates or no renderer is selected, the Host path paints the
published visuals normally. Future extension support for published visuals
requires a separately planned explicit capability, not an implicit visual-body
change.

## Long user messages

A text-only durable user message over 10 rendered visual rows collapses to head
4 + one marker + tail 3, decided at the CURRENT width and re-decided on resize.
The canonical text is untouched. Disclosure uses the existing
`expandedOverride`; the owner is surface-adaptive (regular Ctrl+O
recent-user boundary/search, fullscreen click/compact marker, Focus
click/search only). No fold is rendered without an operable key. Pending
steering-lane messages fold under the same geometry with a stable `rpc:`/`id:`
key and always-visible status.

Authority: `TuiApp` (`USER_MESSAGE_HEAD_ROWS = 4`, `USER_MESSAGE_TAIL_ROWS = 3`,
`UserBubbleComponent`, `expandedOverride`).

Must-not: rewrite/search-index/export the persisted text, add a second
user-specific state map, add a dedicated collapse row, or let a plugin-owned
user renderer own Host disclosure state.

Proof: `test/extension/long-user-disclosure.test.ts` ("exactly the row threshold stays
full; one more row compacts", "compaction never mutates the canonical message
text").

## `TOOL_NOT_STARTED`

A synthetic `tool/result` with `error.code === TOOL_NOT_STARTED` renders as a
standalone attention diagnostic ("Tool request not started", expanded recovery
guidance). The requested name is recovered from the durable assistant tool-call
block fenced by call id + turn + step. It has `callCount = 0` and is not Work,
Action or stats input; the Host-owned renderer bypasses presenter/plugin paths.
Markdown export states the fact, never invents a tool heading.

`TOOL_OUTCOME_UNKNOWN` keeps normal Tool-card semantics. Do not synthesize a
`tool/call` or classify the diagnostic as an orphan Action.

Authority: `src/domain/transcript/folder.ts`,
`src/client/artifact/transcript-markdown.ts`.
Proof: `test/client/session-v4-tool-result.test.ts`.

## Fullscreen jump and scroll intent

`↓ Latest` is a viewport affordance whose click is the Host
`onTranscriptJumpLatest` semantic action (global latest, not the current history
window). Expanding a Thought honors scroll intent (follow only if already
following and running); collapsing anchors the header. Nearest-owner click
routing is image hit (info control / body) > secondary > outer Thought >
ordinary message. The regular surface never installs an ANSI scrollback
anchor; search jumps keep their own policy.

Authority: `TuiAltScreen` affordance + `TuiApp` disclosure/viewport transaction.
Must-not: use the fork's local `scrollToBottom` as the claimed path, derive
ownership from geometry, or add a second viewport map.
Proof: `test/app/focus-ui.test.ts`, `test/domain/rendering.test.ts`.

## Single mounted transcript batch

`rebuildMessages()` is the only place that creates a transcript batch; it
publishes the batch it mounts, and the row-map refresh only re-measures those
component instances. A zero-height block keeps its component in the batch but is
never wrapped in a gutter, so it has no mounted row — the identity invariant is
over the batch's components.

Must-not: project a second, unmounted batch for row-map refresh, or
dispose/replace the mounted component from the refresh
("row-map refresh must not dispose the mounted component").

Proof: `test/tui/focus-mounted-batch-refresh.test.ts`.

## Fullscreen geometry-epoch snapshot reuse

`TuiApp.fullscreenRowsDirty` gates the fullscreen snapshot rebuild. It is raised
ONLY by `updateTranscriptGeometry()`, `refreshMessageRows()`, the async
image-settle seam, or a terminal resize. Any future path that changes rendered
transcript geometry must reach one of those row-map writers or raise the flag;
otherwise it paints with a stale row map and stale press/release fence
identities. Pure scroll frames must reuse the committed row snapshot and must
not remeasure.

Proof: `test/client/fullscreen-scroll-geometry-epoch.test.ts`.

## Transcript images: occurrence identity, fold control and the viewer

An image in the transcript is a CLIENT-LOCAL presentation of a durable
attachment. The attachment ref is content addressed and may be shared; the
transcript OCCURRENCE is the pair **(message object, source image ordinal)**.
The ordinal is the image block's rank among ALL image blocks of that message
(an open opaque assistant image block reserves a rank even though it has no
bytes yet; a Tool result counts its own result image blocks). The same
attachment shown in two messages, or twice in one message, is therefore two
independent occurrences with independent fold state.

- **One occurrence record.** Every Host image creation point goes through
  `TuiApp.imageThumbnail()`: the thumbnail, its derived occurrence record and
  the message's render-order candidate list are written together. The
  occurrence carries the IMMUTABLE presentation scope sampled at construction;
  the viewer reads through exactly that value, never a re-resolved current
  subject. A second read service, a second byte cache, or an
  attachment-id-only occurrence identity is forbidden.
- **The info row is identity; the control is the fold.** The thumbnail's first
  rendered row is always the info bar. On the fullscreen surface a Host
  thumbnail that owns a collapse ref paints a 3-cell ASCII `[-]` / `[+]`
  control at the RIGHT EDGE of that row; only that span toggles the occurrence
  body (via the existing `collapsedOccurrences` owner and structural
  rebuild+anchor). Every other column of the info row is inert — clicking the
  metadata never folds or opens anything. Regular mode paints no control.
- **The body opens the read-only viewer.** A visible body row is the
  occurrence's viewer target; the fold control and the viewer target are
  distinct semantic hits (`attachment:collapse:…` / `attachment:view:…`) and the
  press/release fence re-proves owner, row, action and column span against the
  last-painted frame. A loading / unsupported / collapsed image has no body
  hit; `ImageThumbnail` never fabricates one. During a blocking Question or
  Approval only the read-only info-control fold stays inspection-safe; the
  body's viewer action is never reachable from the modal plane.
- **Tool cards keep their disclosure.** A Tool card's image body opens the
  viewer and does not fold the card; the card's other rows keep the existing
  card/container disclosure priority. Folded/hidden Tool images produce no hit
  and no picker candidate.
- **The viewer is a leased fullscreen workspace, not an overlay.** The pinned
  renderer cannot composite an overlay row over a BASE line that already
  contains an inline image (`compositeTuiLine` keeps the base line), so a framed
  overlay would drop the viewer's rows behind transcript images and cannot
  reliably paint the image itself. `/view-image` and a fullscreen body click
  therefore lease the SAME temporary physical screen the Settings/Job
  workspaces use (mutually exclusive with them), with two internal states: the
  mounted-window image LIST (`SearchablePicker`, no full-text search) and the
  VIEWER (`ImageViewerPanel`). Enter moves list → viewer, `Esc back` returns to
  the same list/selection, a second Esc closes the workspace; a directly
  opened viewer advertises `Esc close`. The return surface is stopped with
  `preserveScreen` and restored untouched: opening/closing never rebuilds,
  scrolls, collapses or expands the transcript.
- **Fitted pixels, one loader.** The viewer renders the occurrence through the
  ONE existing `ImageLoader` (`(scope, attachmentId)`; one subscription, one
  idempotent unsubscribe). Its `Image` is sized from the live terminal grant
  (`maxWidthCells` / `maxHeightCells` from the workspace's own base rows), never
  from the thumbnail's `40×12` limits. States are distinguishable: `Loading…`,
  `Read failed: <sanitized reason>`, `Preview unavailable` (no protocol, an
  empty payload, an unsupported MIME, or a protocol this surface does not
  support), each with the real name/dimensions/media type/bytes. The viewer is
  read-only: no zoom, pan, export, edit, OCR, transcoding or second byte cache.
- **Kitty JPEG/WebP thumbnails derive a bounded PNG.** Kitty places PNG
  payloads only, so a READY JPEG/WebP source (never a GIF) is projected through
  ONE Client-local asynchronous PNG derivative: first page only, EXIF
  orientation applied, fitted inside 768×768 without enlargement, at most
  20 MiB of source and 4 MiB of derived PNG, decoded with a 25,000,000-pixel
  ceiling. The derivative is a read-only projection cached inside the SAME
  `ImageLoader` presentation scope that authorized the source read: 16 READY
  entries / 32 MiB of accounted base64 per scope, at most two conversions per
  loader, a waiting queue capped at 32 items (an over-capacity request
  degrades to a bounded busy message), and the same per-id/global
  invalidation epochs retire the cache, failures and queued/running jobs.
  The 32 MiB figure accounts the cache, not process RSS: a currently painted
  occurrence holds the SAME base64 string in its own `Image`, and it drops
  that local reference as soon as the occurrence repaints without pixels
  (collapse, narrow/unsupported surface, capability loss, pending/error) or
  is disposed; an evicted entry is re-derived on a later visible render. A
  queued conversion whose SOURCE read was evicted is dropped without
  recording a failure (the conversion task itself never re-downloads), so
  the next visible render reads the attachment again and may request a
  fresh conversion instead of inheriting a sticky error.
  Conversion never runs synchronously in `render()`. The info row and the
  viewer target always keep the ORIGINAL ref (name, dimensions, media type,
  bytes); only the painted body consumes the derived PNG and its derived
  dimensions. Idle/loading/failed preview states
  paint informational rows only (a bounded `Preview unavailable`), a collapsed
  occurrence starts no conversion, and a body hit exists only when that frame
  actually emitted the Kitty placement. PNG, iTerm2 (original OSC 1337) and GIF
  (text fallback) keep their existing paths. The Viewer does NOT gain non-PNG
  pixels: a JPEG/WebP body click opens the same attachment and still shows
  `Preview unavailable`.
- **Pickers are a mounted-window snapshot.** `/view-image` candidates come from
  the SAME mounted transcript batch (message order then render order) and only
  from occurrences the Host actually rendered. `/view-image` is a PiTui-local,
  sessionless/local command (registered only where a PiTui surface exists); no
  image → the exact notice `No images in the current transcript window`, never
  a read. A candidate selected after the mounted window changed is refused with
  `the image left the current transcript window` and the workspace closes; a
  stale scope is never authorized against the replacement session.
- **Protocol scope (PR2).** The leased AltScreen renders real pixels through the
  Kitty protocol only. The pinned AltScreen disables the iTerm2 image
  capability and its cursor-up framing is outside the fork's ANSI width layer,
  so the iTerm2 workspace shows the metadata plus `Preview unavailable`; native
  iTerm2 workspace pixels are deferred to separate renderer/protocol work.
  Transcript thumbnails keep their per-surface capability behavior; on Kitty
  their JPEG/WebP bodies use the bounded derivative above, while the Viewer
  stays PNG-only.

Authority: `TuiApp` (occurrence projection, last-painted hit classifier, leased
image workspace), `ImageThumbnail` (info/control/body geometry),
`ImageViewerPanel` (read-only fitted render), `ImageLoader` (scoped reads and
bounded preview derivatives), `src/client/media/image/kitty-thumbnail.ts` (the
only native JPEG/WebP → PNG decoder),
`src/tui/commands/artifacts.ts` + `src/domain/command/policy.ts` (`/view-image`).

Must-not: derive occurrences from message text, filenames or attachment ids
alone; scan off-window history or the draft store for candidates; re-resolve
the scope on click; re-read/patch an image through a second loader/cache;
rebuild or scroll the transcript to open the viewer; paint the viewer as a
horizontal overlay over image base lines; add hover/zoom/export affordances.

Proof: `test/client/image-collapse.test.ts`,
`test/client/kitty-thumbnail.test.ts`,
`test/client/image-loader.test.ts`,
`test/client/image-thumbnail.test.ts`,
`test/client/image-transcript.test.ts`,
`test/client/transcript-image-viewer.test.ts`,
`test/client/transcript-image-viewer-tui.test.ts`,
`test/app/view-image-command.test.ts`,
`test/client/fullscreen-scroll-geometry-epoch.test.ts`.

## Display-order and read-grouping convergence

The durable fold appends rows in EVENT order, while the live lane materializes a
row when its content first becomes visible. For a step whose first visible
assistant text precedes a later tool call of the same step, the two folds can
otherwise disagree (`Work[c1] → Assistant → Work[c2]` live vs
`Work[c1,c2] → Assistant` cold); raw-adjacent settled reads are merged into one
`N files` card before any display rule can split them.

The convergence contract:

- Compare logical identity across folds (kind + a stable logical key such as the
  tool callId or assistant text), never raw object references.
- A display-order move requires proven materialization evidence about that
  exact step/row; without it, the conservative reachability guard refuses the
  move (for example across a sibling step's Conversation) rather than guessing.
- Work membership follows the proven display order; an aggregated read group's
  representative and result follow the same order.
- The same rules apply to Compact, Full and Focus; do not add a second
  display-order fold or re-sort by liveness.

Proof: `test/tui/transcript-display-order-convergence.test.ts`.
