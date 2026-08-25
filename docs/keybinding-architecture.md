# Keybinding architecture

The user-orchestrable keybinding design (implementation plan:
`temp/20260825/dsh-pi-tui-keybinding-customization-implementation-plan-2026-08-24.md`).
This doc records the decisions and the contracts that must not be broken;
the code is the reference for the line-by-line behavior.

## The pipeline

```text
Physical Key
    ↓
Semantic Action ID
    ↓
Context-aware resolver
    ↓
Host handler
```

The plan's core claim: the Host app layer used to treat physical keys as
its architecture interface (`matchesKey(data, 'ctrl+o')` scattered across
`tui-app.ts`). The migration replaces that with a stable action inventory
(`app.*`), a context-aware effective keymap, and a semantic dispatcher —
so a future user override only touches the keymap, never a business
handler.

## The modules (`src/keybindings/`)

| Module | Role |
|---|---|
| `types.ts` | The contract types: `AppKeybindingId`, `KeybindingScope`, `AppKeybindingDefinition`, `KeybindingContext`, `EffectiveBindingRule`, `KeybindingResolution`, `KeymapSnapshot`, `KeybindingConflict`, `LeaderConfig`/`LeaderBinding` |
| `definitions.ts` | The SINGLE action table (`APP_KEYBINDINGS`): default keys, description, category, scope, configurable flag. Every default key MUST match the pre-migration behavior (M0 gate) |
| `context.ts` | `deriveKeybindingContext`: the resolver's context, built in ONE place per surface. `editorEmpty` is a LAZY getter — the live editor is only read when a rule predicate needs it (the input path must not add a draft read per keystroke) |
| `effective-keymap.ts` | The rule compiler + resolver: builtin (100) / composition (100) / user (200) / plugin (10) priorities; conflict detection; `includeScopes` (the HOST keymap resolves the non-capturing scopes only) |
| `conflicts.ts` | The conflict model: same key + overlapping scope + same priority. Capturing scopes (question/approval/overlay/search/viewer/tasks) are mutually exclusive surfaces — they never conflict with non-capturing scopes or each other |
| `config.ts` | The user settings parser: string / array / `false` / `<leader>X`; unknown action, invalid key, plain-printable-to-host-action and terminal-unreliable (Ctrl+J/M) diagnostics; fail-soft |
| `manager.ts` | The stateful facade: user config, safe mode, plugin rules, leader machine, diagnostics, snapshot |
| `action-dispatcher.ts` | The semantic action → host method router (`AppActionHost`). The dispatcher NEVER re-implements business state |
| `leader.ts` | The M6 leader state machine: pending prefix, timeout, ambiguous prefix, cancel, paste/typing isolation |
| `hints.ts` | `formatKeyId` / `formatKeyList` — the ONE place that turns a KeyId into the human label the UI renders |
| `component-keymap.ts` | The read-only focused-component keymap (QuestionFlow, TaskBrowserPanel) |

## The input ladder (what must not be broken)

The `InputRouter` (input-router.ts) keeps its protocol/capture/focus
precedence — the keymap is consulted ONLY when the ladder allows
keybinding resolution. The plan is explicit: **do not delete the
InputRouter**. The host ladder in `handleInputCore` is:

```text
terminal protocol replies / press-filtering
  ↓
active question / editor-seat capturing flow
  ↓
active approval
  ↓
read-only viewer guard
  ↓
active overlay (search owns its keys)
  ↓
leader sequence machine (M6, only when a leader key is configured)
  ↓
host semantic action resolution (the effective keymap)
  ↓
focused editor / pi-tui editor action
  ↓
non-capturing plugin keybindings
```

**Fixed overlay-key precedence.** While a capturing overlay is open its
NON-CONFIGURABLE keys (search close/next/previous, question/tasks flow
keys) win by precedence — a configurable action (e.g. the search toggle)
remapped to one of those keys is ECLIPSED inside the overlay (the
binding still works outside it). The config parser warns on such a
collision (`FIXED_OVERLAY_KEYS`); the overlay never resolves the
configurable action first (plan §3.3).

## Key decisions

1. **Enter stays with the fork editor.** `app.input.submit` is
   `hostResolved: false`: the builtin Enter rule is NOT compiled into the
   host keymap, because the fork editor's submit path owns paste-burst
   suppression and the backslash-newline workaround. A user-bound
   alternate key for the action still compiles and routes through
   `submitDraft` (which mirrors the Enter path exactly).
2. **The viewer guard is action-based.** `viewerParentLockedKey` resolves
   the key through the effective keymap and blocks
   `VIEWER_BLOCKED_PARENT_ACTIONS` — a user remap of a parent action stays
   blocked automatically. The guard never maintains a physical key list.
3. **The Esc path stays a host method.** `app.agent.interrupt` resolves to
   `handleEscapeKey` (autocomplete/replacement-editor pass-through,
   single/double-Esc, rewind) — a user remap moves the WHOLE path to the
   new key. Same for `app.exit.request` → `handleExitKey` (Ctrl+C keeps
   its clear-then-exit chord; every other bound key exits immediately).
4. **Conflicts are deactivated, never last-write-wins.** A conflict
   (same key + overlapping scope + same priority) disables BOTH rules with
   a diagnostic; every other rule keeps working (fail-soft).
5. **Safe mode** (`DSH_PI_TUI_SAFE_KEYBINDINGS=1`) ignores user overrides
   and keeps the builtin defaults; plugin keybindings still load.
6. **The leader is opt-in.** No leader key is configured by default, so
   the pending-prefix machinery never changes ordinary input. A leader
   sequence is cancelled by: timeout, Esc, a non-matching key (passed
   through), a paste burst (passed through), or a focus transition
   (question/approval/overlay/viewer/fullscreen).
7. **The static gate** (`scripts/check-host-keybindings.mts`, wired into
   `verify:prepush`) forbids NEW `matchesKey(data, 'ctrl+…'/'alt+…'/
   'shift+…')` chords in `src/tui-app.ts`. The allowlist covers the
   sanctioned seams: the read-only viewer guard, the Ctrl+C exit-chord
   discriminator, the approval dialog keys, and the replacement-editor
   Enter seams.

## User configuration

Settings namespace `dsh-pi-tui` (the TUI's own settings section — NOT the `pi-tui` profile name), field `keybindings` (the schema deliberately
does NOT declare the field — schemastery's `z.object` keeps unknown keys,
and the parser owns the validation):

```yaml
dsh-pi-tui:
  keybindings:
    app.input.steer: ctrl+s
    app.permission.cycle: [shift+tab, ctrl+shift+p]
    app.history.search: ctrl+r
    app.transcript.toggleThinking: false
    leader: ctrl+x
    bindings:
      app.tasks.open: <leader>t
```

Semantics: string = one key; array = several; `false` = disable the
action's effective binding; absent = builtin default; `<leader>X` = a
leader sequence (requires `leader`). A plain printable key can never be
bound to a Host action (it would swallow typing). Hot reload: the runner
watches the settings document and rebuilds the keymap without a restart.

## Diagnostics

`/keybindings` shows the effective table (action, keys, scope, source)
grouped by category; `/keybindings conflicts` lists only conflicts;
`/keybindings reload` re-reads the settings document; `/keybindings
reset` clears the user overrides THROUGH the settings service (never a
direct settings.yaml write). `/help` and the footer hints render through
`keyHint`/`keysFor` — a user remap updates every hint automatically.

## Out of scope (first version)

- No VS Code-style `when` expressions (scope is the static contract).
- No arbitrary JS callback bindings.
- No raw terminal bytes to plugins; no plugin preemption of the protocol
  stage; no breaking extension API change (the plugin registry keeps its
  key-level reservation; a plugin binding a protected action to a NEW key
  is additive and allowed).
- The model-menu / history-panel / output-viewer focused components keep
  their component-local keys (the plan's M5 covers QuestionFlow and
  TaskBrowserPanel; the others follow the same pattern later).

## Comment and copy convention (review follow-up)

Host code must not hard-code physical keys in a way that can drift from
the user's live bindings:

- **The single source of truth for DEFAULT keys is `definitions.ts`**
  (plus the `RESERVED_HOST_KEYS` inventory in keybinding-registry.ts).
  `src/tui-app.ts` and `src/index.ts` carry a header note pointing here.
- **User-facing strings derive key labels from the keymap**
  (`keyHint()` / `keysFor()` — e.g. the guard notices and the `/settings`
  row descriptions). A remap updates the copy automatically; a disabled
  action shows a neutral fallback.
- **Comments** may name a key only when the SEMANTICS are key-specific
  (the Ctrl+C clear-then-exit chord, the double-Esc window, the
  read-only viewer's fixed Esc/Ctrl+O policy, the search overlay's fixed
  keys). Every other mention is shorthand for the default binding and
  must not be relied on as the live binding.
- **The static gate** also rejects hard-coded chord labels in
  user-facing string literals (`src/index.ts`, `src/commands.ts`,
  `src/tui-app.ts`), with a documented allowlist for fork editor-level
  keys (Ctrl+Home/End).

## Review chain (2026-08-25, openai-codex / gpt-5.6-luna)

Four review rounds on `feat/keybinding-customization`; the reviewer
accepted at round 4 with no open findings.

- Round 1 (needs-fixes, 7 findings): advanced-capture ordering
  (documented by-design — the pre-migration phase contract placed the
  host ladder before the advanced stage; AGENTS.md decision 13 keeps
  session-safety paths Host-owned), safe mode now disables the leader
  config, conditional-action remaps inherit their predicate and `false`
  disables the composition rule, `false` wins over `<leader>X` bindings,
  leader sequences cannot bypass the viewer parent-action guard, duplicate
  action declarations are a diagnostic (never last-write-wins), CJK
  comments translated.
- Round 2 (needs-fixes, 1 P2): disabled actions are never advertised by
  `keyHint()`/`snapshot()`.
- Round 3 (accepted-with-followups, 1 P2): hints read the EFFECTIVE
  (ambiguity-filtered) leader bindings.
- Round 4 (accepted, none).

The branch was then REBASED onto the current main (M1 migration ports,
shell-editor-mode, thinking-disclosure unify, focus-v2, the
README/CHANGELOG language flip) and re-reviewed:
- Round 5 (needs-fixes): per-key rule ids (a conflict on ONE key of a
  multi-key action now deactivates only that key); printable-leader keys
  rejected.
- Round 6 (needs-fixes): the monotonic keymap revision joins the
  transcript cache identity (a remap refreshes already-rendered fold
  hints; onInvalidate rebuilds messages); the leader machine propagates
  the dispatch result (a declined action falls through, not consumed);
  the configurable search toggle matches EFFECTIVE keys while the fixed
  overlay keys keep their defaults; `space` is printable (rejected as
  leader/direct binding); the settings namespace docs corrected to
  `dsh-pi-tui` (not `pi-tui`); `/keybindings reset` notifies success
  only after the write resolves; hot reload keeps last-known-good;
  definitions.ts joins the gate scan (its `defaultKeys` are the source
  of truth, its description strings must stay key-neutral); the
  config-port documents `keybindings` as raw pass-through extension
  data.
- Round 7 (needs-fixes, 3 P2): the config.ts header example namespace
  corrected to `dsh-pi-tui`; the fixed overlay-key precedence is
  documented and the parser warns on a collision; `/keybindings reset`
  honors the async write outcome.
- Round 8 (needs-fixes): the read-only viewer fold pass-through and the
  search-overlay ownership resolve the EFFECTIVE keymap (a remap of
  `app.transcript.toggleExpand` / `app.transcript.search` stays
  authoritative — the router consults `matchesEffective`); leader-only
  actions appear in the `/keybindings` snapshot with the `leader` flag;
  the changelog namespace examples corrected to `dsh-pi-tui`.

Final gates after the rebase: 2397 bundle tests, 985 fork tests, 11
docs tests, typecheck (fork + bundle), `check-host-keybindings` gate,
`git diff --check` — all green.
