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
| `config.ts` | The user settings parser: string / array / `false` / `<leader>X`; unknown action, invalid key, plain-printable-to-host-action and the SHARED legacy-terminal collision inventory (Ctrl+[ / Ctrl+J/M / Ctrl+I/H / Ctrl+_/-) diagnostics; fail-soft |
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

1. **One canonical physical-key identity.** Every key spelling collapses
   onto ONE canonical KeyId (`esc`→`escape`, `return`→`enter`, modifier
   order → `ctrl`→`shift`→`alt`→`super`, and every base LOWERCASED —
   including single characters: `A`→`a`, `ctrl+A`→`ctrl+a`) at every rule
   entry point (builtin defaults, user keys, leader prefix/completions,
   composition, plugin rules, the fixed-overlay/terminal-unreliable
   inventories, rule ids and conflict grouping). Aliases and CASING can
   never bypass conflict detection, leader-prefix collision or dedup
   (convergence §1/§4.1; the fork's runtime parser lowercases, so
   `ctrl+A` and `ctrl+a` are one physical key).
2. **Declared / effective / shadowed / conflicted are distinct states.**
   The effective keymap compiles declared rules, DEDUPES same-action
   same-canonical-key declarations, DEACTIVATES same-priority conflicts
   (with a diagnostic), and SHADOWS lower-priority rules on an
   overlapping key — but only UNCONDITIONAL higher rules shadow in the
   read model: a CONDITIONAL top trigger (a context predicate exists)
   advertises BOTH its claim and the lower rule's fallback, because the
   fallback genuinely fires in the contexts where the predicate fails
   (round-9 finding: the read model must never hide a key that fires).
   Only EFFECTIVE rules feed `resolve`, `keysFor`, `keyHint`,
   `hostResolves` and `snapshot` — and they all project from the SAME
   visible-rule set (a working user override never leaves the replaced
   builtin advertised anywhere), with no fabricated builtin fallback
   (convergence §2/§4.3/§4.4).
3. **Editor-owned submit lives in the unified rule model — winner-aware.**
   `app.input.submit` is `hostResolved: false` — the fork editor's submit
   path owns paste-burst suppression and the backslash-newline workaround.
   Editor-owned rules PARTICIPATE in the winner selection on equal
   footing with host/plugin rules (round 9 finding: the resolver used to
   skip editor rules BEFORE picking a winner, so `submit: ctrl+s`
   steered at runtime while the read model advertised submit). The
   resolution carries the winner's OWNER and the caller routes execution
   by it: 'host'/'plugin' → the host dispatcher, 'editor' → the fork
   editor (its `tui.input.submit` is synced by `onEditorSubmitSync`).
   `hostResolves` is winner-based — an editor-owned winner is never
   host-reserved, so the key reaches the fork editor. User remaps/`false`
   sync into the fork editor's binding, conflict and shadow apply,
   fail-soft (a dead override restores the builtin Enter unless `false`)
   is evaluated on the EFFECTIVE rules — never the raw config, and a
   leader sequence NEVER clears the direct keys (`submit:
   ['ctrl+z', '<leader>s']` keeps BOTH triggers; only a truly leader-only
   override removes Enter) (convergence §3/§4.5).
4. **The viewer guard is action-based.** `viewerParentLockedKey` resolves
   the key through the effective keymap and blocks
   `VIEWER_BLOCKED_PARENT_ACTIONS` (which includes `app.agent.interrupt`)
   — a user remap of a parent action stays blocked automatically,
   direct and leader triggers alike. The guard never maintains a
   physical key list.
5. **Semantic interrupt ≠ physical Escape.** `app.agent.interrupt` on the
   physical Escape key runs the editor-owned Escape seams (autocomplete
   pass-through, replacement-editor Esc, shell-mode exit — with the busy
   cancel keeping Host priority over all of them) then the semantic
   core; a REMAPPED interrupt key goes straight to the semantic core
   (`handleInterruptAction` — single/double-action policy, rewind) and
   never inherits the physical-Escape seams (convergence §5/§4.8). The
   viewer's fixed Esc close stays independent.
6. **A declined host action reaches the remainder — once.** When the
   host dispatcher returns false (GENUINE feature absence, e.g.
   `pasteMedia` with no handler), the key must reach the editor/plugin
   remainder and is never re-reserved by the same host rule
   (convergence §6/§4.9). HOST-GUARDED NO-OPS (empty queue, no history
   source) are NOT declines: the host owns the key and consumes it.
7. **Conflicts are deactivated, never last-write-wins.** A conflict
   (same canonical key + overlapping scope + same priority) disables
   BOTH rules with a diagnostic; every other rule keeps working
   (fail-soft). If the highest tier is fully conflict-deactivated, the
   next DECLARED tier survives — never a fabricated builtin.
8. **Safe mode** (`DSH_PI_TUI_SAFE_KEYBINDINGS=1`) ignores user overrides
   and keeps the builtin defaults; plugin keybindings still load.
9. **The leader is opt-in and availability-aware.** No leader key is
   configured by default. Esc (any alias) can never be a completion
   (it is the pending-cancel contract — parser-rejected); a leader with
   zero EFFECTIVE completions has no machine; a completion dispatches
   only when the action's context predicate holds (`canActivate` — the
   ↓ tasks affordance is not bypassable); the viewer parent-action guard
   blocks leader completions like direct keys. A leader-PREFIX key that
   collides with an active host or editor-owned key is fail-soft
   disabled with a diagnostic (convergence §4/§4.6/§4.7).
10. **Reserved-but-unimplemented actions are not bindable.** The
    session/model actions (`app.session.*`, `app.model.open`) are
    `configurable: false` + `availability: 'reserved'`: the parser
    rejects any user binding with a diagnostic — never a bindable no-op
    key (convergence §7).
11. **The static gate** (`scripts/check-host-keybindings.mts`, wired into
    `verify:prepush`) forbids NEW hard-coded chord labels in user-facing
    strings across ALL quote styles (single/double/backtick, either
    casing) and new `matchesKey(data, 'ctrl+…'/'alt+…'/'shift+…')`
    chords in `src/tui-app.ts`, with a documented allowlist for the
    sanctioned seams (read-only viewer guard, Ctrl+C exit-chord
    discriminator, approval dialog keys, replacement-editor Enter seams,
    the effective-submit Shift+Enter exclusion).

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
leader sequence (requires `leader`). The validation pipeline is
**grammar → canonicalize → policy → store** (round-9 finding): every
policy check (printable, lifecycle collisions, editor-owned constraints)
runs on the CANONICAL key, so an uppercase spelling (`SPACE`, `ctrl+A`)
can never bypass the typing guard or the collision sets. A plain
printable key can never be bound to a Host action (it would swallow
typing), and `app.input.submit` can never be bound to a key the fork
editor consumes BEFORE its submit check (tab/backspace/Ctrl+A/E/U/K/W/
Y/C/D/Home/End/word-moves/undo/copy — the editor would consume it first,
so the binding could never fire; rejected like Shift+Enter, other
actions are unaffected). Hot reload: the runner watches the settings
document and rebuilds the keymap without a restart.

**Conditional affordances are ADDITIVE, never replaced.** A composition
rule (the empty-editor `↓` task-browser affordance → `app.tasks.open`)
stays live alongside a user binding of the same action: binding
`app.tasks.open: ctrl+x` ADDS another trigger — `↓` (with an empty
editor + active tasks) still opens the browser. Only `false` disables
the affordance along with every other key of the action. The README
uses "override" loosely; the effective semantics are: *a user binding
adds a trigger for that semantic action; `false` removes them all*.

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
  key-level reservation AND the runtime ACTION whitelist — a Stable
  plugin registers only the public `TuiAction` set; the Host-private
  `app.*` actions are never plugin-bindable, round-12 finding).
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

## Revision history and convergence

The branch went through an extended external review chain
(openai-codex / gpt-5.6-luna) on the PR #34 diff: review rounds fixed
per-key rule ids, printable/space leader rejection, the monotonic keymap
revision, leader fall-through, search-toggle effective keys, the
`dsh-pi-tui` settings namespace, `app.input.submit` real remapping
(editor sync + cross-instance isolation + safe mode + leader-only/
conflict fail-soft), action-driven host reservation, leader-prefix
collision, host/plugin rule layering, the fixed viewer Esc close, the
armed exit-chord copy, and the effective read-model (no fabricated
fallback, no dead leader advertisement). The final round was accepted.
This doc records the CONTRACT, not the review log. The convergence pass
then re-derived the architecture from first principles and is what the
current code implements:

**Canonical physical identity.** `esc`/`escape`, `return`/`enter` and
modifier order collapse to ONE key identity at every rule entry point
(`src/keybindings/key-identity.ts`) — aliases can never bypass conflict,
leader collision or dedup.

**Single effective rule model.** The keymap compiles `declared` rules,
dedupes same-action canonical keys, deactivates same-priority conflicts,
and shadows lower-priority overlapping rules. Only `effective` rules
feed the resolver, the host reservation, the editor submit sync, the
leader availability check and the read model — `runtime == /help ==
/keybindings == footer` by construction. No fabricated builtin
fallback; a guard no-op stays host-owned; a genuinely declined host
action (pasteMedia with no handler) falls through to the editor/plugin
remainder exactly once.

**Editor-owned submit as a first-class rule.** `app.input.submit` keeps
the fork editor's execution semantics while participating in the unified
model (canonical identity, dedupe, conflict, shadow, fail-soft, read
model) via its owner/effective state.

**Leader availability.** Escape completions are parser-rejected;
zero-effective leaders create no machine; completions obey the action's
context predicate (`canActivate`); direct/leader/remap are blocked in
viewers alike.

**Semantic interrupt ≠ physical Escape.** Only the physical Escape key
owns the editor Escape seams; a remapped interrupt goes straight to the
semantic core. The fixed viewer close stays independent.

**Reserved actions.** Unimplemented session/model actions are
`configurable: false` + `availability: 'reserved'` — never bindable
no-ops.

**Remapped interrupt is semantic.** Only the physical Escape key runs
the editor Escape seams; a remapped interrupt key goes straight to the
semantic core AND keeps its own consecutive-press idle semantics (its
first press does not disarm its own double-action window; an intervening
non-trigger key does). Shift+Enter can never be bound to submit (the
fork editor's fixed newline key — parser-rejected, aliases included).

**Canonical identity is case-insensitive everywhere.** `canonicalizeKeyId`
lowercases before the alias map (`ESC`→`esc`→`escape`,
`ctrl+RETURN`→`ctrl+enter`), named keys canonicalize to lowercase
(`pageUp`→`pageup`, displayed as `PageUp` — the runtime parser
lowercases, the fork's matchesKey is case-insensitive), config parsing
accepts either named-key casing, and the registry canonicalizes the
plugin NormalizedKey shape at register/storage/lookup (including the
reserved-key check, which runs AFTER canonicalization so `esc`/`return`
registrations are rejected as the reserved `escape`/`enter`).

**Legacy terminal collisions are rejected everywhere.** `ctrl+[` (Esc),
`ctrl+j`/`ctrl+m` (Enter), `ctrl+i` (the Tab byte — `matchesKey('\t',
'ctrl+i')` is true, so a Host binding fires on Tab presses on legacy
terminals), `ctrl+h` (the Backspace byte) and `ctrl+_`/`ctrl+-` (ONE
0x1f byte — the fork's rawCtrlChar maps Ctrl+- to the same 31 as
Ctrl+_, so both spellings are rejected, round-16 finding) are rejected
as direct bindings, leader prefixes and leader completions — a binding
indistinguishable from a fixed key on legacy terminals is unsupported,
never a warning.

**Dynamic plugin lifecycle + edge hardening.** Plugin keybinding rules
resync on every registry register/dispose (subscribe), plugin rule ids
are namespaced (`plugin:…`) so they can never deactivate a host rule,
the manager's leaderTimeoutMs is applied, and stop() cancels a pending
leader + clears the interrupt double-action window. The host editor
submits ONLY through the synced `tui.input.submit` binding — a disabled
submit never fires on Enter or LF (LF is a newline).

**The Stable plugin boundary is capability-enforced (round 12).** The
registry REJECTS at registration: (a) any action string outside the
public `TuiAction` set (the runtime whitelist `TUI_ACTIONS` — a
JS/`as any` plugin can never register `app.exit.request` and reach the
Host dispatcher), and (b) plain printable keys (the spacebar and bare
letters never reach the plugin stage — the router keeps them with the
editor's text entry; modified chords stay bindable), and (c) the legacy
C0 collisions — the registry shares the config parser's legacy inventory
(`isLegacyCollisionKeyId`), so `ctrl+i`/`ctrl+h`/`ctrl+_`/`ctrl+-`/
`ctrl+[`/`ctrl+j`/`ctrl+m` registrations are rejected too (on a legacy
terminal the raw byte is Tab/Backspace/0x1f/Esc/Enter — the router's
normalized plugin lookup could never match it; the old "a plugin may
claim Ctrl+J" exception is gone, round-13/16 findings). The owner-aware
dispatcher NEVER routes a plugin-owner winner into the
AppActionDispatcher: only 'host' winners execute Host-private actions,
'editor' winners go to the fork editor, and 'plugin' winners continue to
the Stable plugin remainder (`onExtensionAction`). A leader prefix that
equals a LIVE plugin key disables the leader machine with a diagnostic
(the leader feeds before the plugin stage — never a silent swallow;
same fail-soft as a host-key collision).

**Owner-aware winner selection (round 9).** All owners (host/editor/
plugin) compete in the resolver on equal footing; the resolution carries
the winner's OWNER and the app routes execution by it ('editor' → the
fork editor, never the host dispatcher). `hostResolves` is winner-based,
so `submit: ctrl+s` really submits and NEVER steers, and the read model
agrees (`/keybindings` shows Ctrl+S under submit only). A submit remap
onto a fork-editor pre-submit key (tab/backspace/Ctrl+A/E/U/K/W/Y/C/D/
Home/End/…) is parser-rejected (it could never fire). A leader sequence
never clears the direct submit keys — `submit: ['ctrl+z', '<leader>s']`
keeps both triggers; only a truly leader-only override removes Enter.
The canonical identity lowercases single-character bases too (`ctrl+A`
≡ `ctrl+a` — one key, conflict-detected), and all policy checks run
AFTER canonicalization (`SPACE`/`Space` are printable and rejected).
The read model is ONE projection: `keysFor`/`keyHint`/
`editorSubmitKeysFor`/`snapshot` all render the same visible rules (a
working submit remap never leaves the replaced Enter advertised), and a
CONDITIONAL top claim never permanently hides its context fallback.

Final gates: 2491 bundle tests, 985 fork tests, 11 docs tests,
typecheck (fork + bundle), `check-host-keybindings` gate (all quote
styles, either casing), `git diff --check` — all green. The final
convergence review round was accepted with no findings.
