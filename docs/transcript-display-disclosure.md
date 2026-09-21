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

## Compact projection

Compact folds **contiguous Process runs**, never whole turns, into
presentation-only `Work` spans (`compact-projection.ts`):

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
- Under Compact, Ctrl+O owns the **Work spans only**. Every other message-level
  fold is decided by a disclosure CAPABILITY, not by a key that happens to
  exist: on the regular surface (no mouse, Ctrl+O reserved for Work) a fold with
  no operable owner is not presented collapsed at all — the row renders in full
  and advertises no hint. On fullscreen the mouse owns those folds
  (`(click to expand)`). Alt+T still owns Thinking detail, independently of both.
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
  collapse/expand neither collapses nor expands it (it stays a normal
  tool-card secondary for render/click semantics but is exempt from the
  root-collapse secondary reset), and it reuses the existing tool-card
  disclosure owner (fullscreen click; regular fail-open/full when no operable
  owner exists — no F6 work).
- A RUNNING interaction is untouched: the QuestionFlow / plan-mode approval
  panel owns it and no duplicate settled-style card is surfaced.
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

PR3/F4 Core makes Compact a real opt-in preset. It deliberately does not:

- convert Focus expanded globally into Compact semantics (F5);
- make Full equal to Compact plus expanded Process (F5);
- change the default preset for new users (F7);
- introduce a second search/render/viewport path or a second transcript store.

F4 only guarantees that no INOPERABLE disclosure is rendered; it does not
converge keyboard disclosure ownership. The following are explicit follow-ups,
not silent gaps:

- **TODO(F6) — regular-surface disclosure ownership.** Regular Compact reserves
  Ctrl+O for the Work spans, so non-Work folds (long user, pending user, tool,
  system/compaction, standalone surfaced Context) currently render in full
  instead of collapsed. F6 must assign those folds a real regular-surface owner
  and then restore a collapsed presentation.
- **TODO(F6) — regular-surface cluster disclosure.** Ambient clusters are
  semantic on every surface but presented flat (expanded) on the regular surface
  because no manual cluster owner exists there yet. F6 assigns that owner and
  returns the regular default to collapsed.
- **TODO(F5) — Focus expanded / Full convergence.** Focus expanded is not
  globally Compact, and Full is not yet Compact plus expanded Process.

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
- **Search / disclosure.** A flat regular cluster never mints an inoperable
  owner; a surface switch during search re-checks the capability; a topology
  mutation re-resolves the current container instead of a stale identity; and a
  hidden mid-turn notice is reachable through the temporary reveal above.
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
