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
- Ctrl+O owns the Compact Work-span bulk (any open span → collapse all, else
  expand the recent spans); Alt+T still owns Thinking detail.

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
  brightness, and reuses the long-message disclosure geometry for a long body.
  The semantic class stays Context — presentation is reused, semantics are not
  rewritten to `user`.
- A recall names its structured labels; no summary is invented when metadata is
  absent.

### Ambient clustering

`clusterAdjacentAmbientContext` groups only rows that are same-turn,
raw-adjacent, surfaced Context, and ambient form; two or more such rows become
one cluster. Clustering is computed from RAW chronology before any Process
hiding, so a Process row between two Context rows never merges them. A notice,
relay, recall, unknown Context, Conversation, Attention, workflow, compaction,
window summary or turn boundary ends the run. Clusters exist in every preset
and default collapsed; expanding one re-emits every member as an ordinary
Context row, and member payload disclosure stays independent. The cluster
summary is built from structured labels/forms only (duplicate labels compress
to `label ×N` for display; the transcript is never deduplicated or reordered).

### Disclosure chronology

- Collapsed Focus surfaces user/steer rows and surfaced Context in raw relative
  order before the Thought.
- An opening ambient burst (the initial user plus the immediately following
  surfaced Context rows) stays above the Thought in both Focus states; a
  mid-turn Context row/cluster returns to its chronological position when the
  Thought is expanded.
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

## Scope

PR3/F4 Core makes Compact a real opt-in preset. It deliberately does not:

- convert Focus expanded globally into Compact semantics (F5);
- make Full equal to Compact plus expanded Process (F5);
- change the default preset for new users (F7);
- introduce a second search/render/viewport path or a second transcript store.
