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

## Layered defaults

| Preset | Turn layer | Process layer | Focus behavioral policy | Availability |
|---|---|---|---|---|
| Focus | collapsed | collapsed | enabled | available |
| Compact | open | collapsed | disabled | available (PR3/F4) |
| Full | open | expanded | disabled | available |

The policy table is pure foundation data. DisplayPreset decides the DEFAULT
only; a manual Work/cluster/tool disclosure is never written back into the
preset.

## Semantic classes

`transcript-semantics.ts` classifies source messages without inspecting display
text:

- `conversation`: user and assistant messages, including intermediate and final replies;
- `process`: thinking, ordinary tool activity, retries, commands, and
  delegation records;
- `attention`: turn errors, interruption cards, and max-token notices;
- `context`: injected context, workflows, compaction, and window summaries.

Synthetic rows carry source-derived origins (`llm-retry`, `turn-max-tokens`,
`command`, `subagent-delegation`, `turn-error`, and `turn-interrupted`) so the
projection never infers meaning from wording.

## Canonical transcript structure

The semantic segmentation is computed once, preset-neutrally, in
`transcript-projection.ts`:

```text
raw TranscriptMessage[]
        │
        ▼
projectTranscriptStructure()
        │
        ├── Message
        ├── Work span        (maximal contiguous same-turn Process run)
        └── Context cluster  (raw-adjacent same-turn ambient Context run)
```

- `transcript-projection.ts` never reads the preset, the surface, Ctrl+O,
  mouse, search state, expanded owners, default depth, Focus root, viewport or
  render width. It answers only where the raw chronology forms a Work span, a
  Context cluster or a standalone row.
- `isTranscriptWorkMember()` is the single Work membership authority; the live
  Preparing ownership consumes the SAME predicate, so a settled surfaced
  interaction (question / Plan review) closes the trailing run everywhere.
- `clusterAdjacentAmbientContext()` remains the single cluster membership
  authority, computed from raw adjacency before any row is hidden.
- Work `owner`/`members` and cluster `owner`/`members` always reference the
  original `TranscriptMessage` objects, so presentation caches compare
  identity/order (never a synthetic hash or a content-derived owner).
- The projector is a single forward pass plus the linear clustering pass (O(n)).
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

- **Compact** (`compact-projection.ts`) is the materialization adapter: a
  collapsed Work span emits its header, an expanded span its members; clusters
  obey the surface capability.
- **Full** emits Work flat (no Work chrome) with the shared cluster
  presentation; its message chronology equals the raw window.
- **Expanded Focus** consumes the same structure for its process tail and
  materializes each canonical Work span as a nested `[focus-root, work]`
  container (F6); its cluster presentation obeys the surface capability exactly
  like Full. It keeps the Focus-specific lead foundation, committed-answer fence
  and final holdback.
  Collapsed Focus keeps its own hoist policy and substitutes the canonical
  cluster identity at its Focus-projected position.

## Compact projection

Compact materializes the canonical Work spans as presentation-only `Work` cards
(`compact-projection.ts`):

```text
raw:      User · Thinking A · Tool A · Assistant A · Thinking B · Tool B · Notice · Tool C · Assistant final
Compact:  User · Work(A)      · Assistant A · Work(B)      · Notice · Work(C) · Assistant final
```

- `Work.members` preserve raw order; `Work.owner` is the first member
  `TranscriptMessage`, the stable disclosure identity.
- Conversation (user, steer, intermediate assistant, final assistant) and
  Attention rows always end the current span and stay visible at their
  chronological position.
- Every surfaced Context presentation is a Work boundary.
- A collapsed `Work` renders `Header`, at most one `Think` row (the latest
  reasoning tail, following it while reasoning streams) and at most one `Tool`
  row (presenter-first semantic display, `focusToolDisplay` fallback). There is
  deliberately **no Message slot**: Assistant intermediate narration is already
  visible outside the span. Absent facts render no placeholder row.
- Counts and previews describe the SPAN, never the whole turn. Span-local
  duration is omitted: durable rows carry no per-row timestamps, and presenting
  the whole-turn Focus duration as a span duration would be wrong.
- Expanding a `Work` span reveals its raw member rows through the existing
  message renderers; Thinking and tool-local detail keep their own orthogonal
  disclosure.
- Disclosure ownership is converged in F6 (see the F6 section below): on the
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
  (`context.ts`); no other layer re-parses the source.
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

### Surfaced interaction evidence (settled question / Plan review)

A SETTLED surfaced-interaction tool card is not ordinary Process work: it is
human-interaction evidence (the user's own decision), so it is surfaced
independently of the Work/Thought. The authoritative PR4 set is exactly
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
  unchanged by F6.
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
  Thought is expanded.
- Collapsed Focus distinguishes CAUSAL INPUT from MID-TURN PROCESS FEEDBACK by
  the producer-declared `form` and raw position, never by source kind: a
  mid-turn `form:'notice'` (a background job or subagent settling while the
  Agent already works) is hidden inside the collapsed Thought and restored at
  its exact raw position when the Thought opens; a notice inside the turn's
  opening foundation (the `thoughtLeadBoundary()` area) stays visible because it
  explains why the turn started; a mid-turn relay stays visible because it is
  external Agent-authored input. Compact keeps every notice standalone and Full
  keeps full chronology.
- A hidden mid-turn notice is reachable by search through a presentation-only
  temporary reveal (`projectFocus` `forcedVisible`): it surfaces that row without
  opening the Thought and without writing a manual owner, so an ordinary dismiss
  restores the collapsed view with no residue.
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

## Scope and follow-ups

PR3/F4 Core made Compact a real opt-in preset. PR5/F5 completed **projection
convergence**: the Work / Context-cluster / surfaced-interaction boundaries are
computed once by the preset-neutral canonical structure, and Compact (Process
collapsed), Full (Process expanded, flat) and expanded Focus all materialize
that same structure. PR6/F6 completes **disclosure/search/viewport
convergence**: state storage stays owner-specific, but owner resolution,
capability, ancestry and reveal routing are shared. F6 does NOT:

- change the default preset for new users (F7);
- introduce a second search/render/viewport path or a second transcript store;
- add a Work identity icon or a Compact narration prompt (post-F6 review).

### Neutral container ownership (F6)

`src/transcript-disclosure.ts` owns the ONE container-owner vocabulary
(`focus-root` by turn; `work` / `context-cluster` by canonical first-member
object identity). Row ancestry is generated by the projection that produced the
row — never reconstructed from screen geometry. The generic nearest-container
rule resolves a trailing blank spacer to the DEEPEST container the row and the
next VISIBLE row share: an internal Work spacer collapses that Work, a spacer
between nested Work and a Thought-only row collapses the Thought, a cluster
spacer collapses the cluster, and a boundary/global blank is inert. Concrete
row targets (long-user control, PTC sub-call, Workflow, attachment, secondary
card) always win before the container fallback.

### Regular-surface disclosure ownership (F6)

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

### Nested Focus Work (F6)

Expanded Focus materializes each canonical Work span as a nested container
(`[focus-root, work]`). Fullscreen defaults it collapsed with a mouse-owned
header and search may reveal it temporarily; regular Focus opens it whenever the
owning Thought is effectively expanded (the historical full-reveal contract).
An explicit root collapse returns that turn's manual Work owners to the Compact
default ("reopen compact"); a temporary surface/search-only hiding never clears
manual Work state. Root bulk Collapse All clears the Work owners of every
collapsed root.

### Search reveal path (F6)

Search reveal is a container PATH, not a Compact-only one-owner resolution. The
path is composed from the current preset/surface capability, `searchTargetTurn()`,
canonical Work membership and canonical cluster membership. Navigation opens
every hidden node temporarily without writing manual state; an ordinary dismiss
promotes every currently necessary node atomically; an explicit collapse revokes
the temporary reveal so the owner cannot instantly reopen. A flat/fail-open
container mints no reveal node.

### Remaining roadmap

```text
Post-F6 Compact UX / identity review
├ Work semantic identity icon?
└ progress-update-oriented Compact narration guidance?
```

Neither is implemented in F6. PR7/F7 (Compact default rollout) remains the next
phase.


## PR4/F4 hardening guarantees

PR4 adds no new preset or disclosure owner; it proves the shipped F4 behavior
under bad input, long sessions and rapid live updates:

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
  turn boundary closes it, the call is an ephemeral pending Work that never
  moves backward, never duplicates a durable Tool, leaves no ghost card on
  cancel, and leaves no stale owner across a session, preset or surface switch.
- **Search / disclosure.** A flat/fail-open container never mints an inoperable
  owner; a surface switch during search re-checks the capability; a topology
  mutation re-resolves the current container path instead of a stale identity;
  and a hidden mid-turn notice is reachable through the temporary reveal above.
- **Width / grapheme.** Every F4 row family (Work, pending Work, Context cluster,
  notice, relay, recall) obeys the framebuffer width contract at the current
  width for ASCII, CJK, emoji, combining marks, ZWJ emoji and ANSI-colored text;
  the notice summary keeps its natural wrap.
- **Windowing.** A window clusters and folds only the rows it contains: no
  off-window member is invented, the window-summary marker ends a run, and a
  page/window change is a new disclosure epoch that prunes every Compact
  Work/cluster owner the new window no longer projects. Object identity alone
  cannot expire such an owner — the folder returns the SAME message objects when
  a page is revisited — so an A→B→A round-trip never resurrects a dropped
  expansion (a search jump keeps the same window and its owners).
