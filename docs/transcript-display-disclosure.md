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
The legacy `focusMode` field remains only as a migration input during PR2 and is
preserved during whole-document settings writes.

The current projection keeps Full and Focus behavior unchanged. Existing manual
disclosure owners (for example, expanded turns and tool cards) remain separate
from preset defaults; changing a preset does not invent a `lastNonFocusPreset`
or transfer manual disclosure ownership.

## Layered defaults

| Preset | Turn layer | Process layer | Focus behavioral policy | PR2 availability |
|---|---|---|---|---|
| Focus | collapsed | collapsed | enabled | available |
| Compact | open | collapsed | disabled | reserved |
| Full | open | expanded | disabled | available |

The policy table is pure foundation data. PR2 does not render or activate
Compact. A request for Compact is rejected without changing state or writing
persistence.

## Semantic classes

`transcript-semantics.ts` classifies source messages without inspecting display
text:

- `conversation`: user and assistant messages, including intermediate and final replies;
- `process`: thinking, ordinary tool activity, retries, commands, and
  delegation records;
- `attention`: turn errors, interruption cards, and max-token notices;
- `context`: injected context, workflows, compaction, and window summaries.

Synthetic rows carry source-derived origins (`llm-retry`, `turn-max-tokens`,
`command`, `subagent-delegation`, `turn-error`, and `turn-interrupted`) so a
future disclosure projection does not infer meaning from wording.

## Persistence migration

Startup resolves canonical data before the first agent composition or TUI frame:

1. recognized `displayPreset: focus|full` wins over every legacy value;
2. `displayPreset: compact` resolves to Full and is canonicalized;
3. an invalid canonical value resolves to Full and is canonicalized;
4. when canonical data is absent, legacy `focusMode: on` maps to Focus;
5. every other absent-canonical legacy value maps to Full.

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
/display compact  -> unavailable in this build
```

`/focus` remains a stateless compatibility adapter:

```text
/focus on       -> Focus
/focus off      -> Full
/focus toggle   -> Focus unless already Focus, otherwise Full
/focus status   -> on only when the preset is Focus
```

The settings row is `display-preset` with only `full` and `focus` values. The
footer item keeps its historical `focus-mode` id for custom-layout
compatibility, but it renders only when the canonical preset is Focus.

## Direct and Remote parity

Display semantics are Client-local and must not become a second wire protocol.
Direct and Remote readers consume the same semantic projection and the same
canonical display-preset vocabulary. Remote parity options may select the
client-local preset, but they do not create Host-owned display state or a
Remote-only disclosure behavior.
