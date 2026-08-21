# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-21

### Added

- **Extension platform v1 — the headline of this release.** The TUI is now
  extensible: a third-party Cordis plugin can contribute chrome (header
  badge, dock items, footer segments), widgets above/below the editor,
  slash commands, themes, settings rows, autocomplete providers,
  keybindings, transcript/tool renderers, managed overlays, and even
  replace the editor itself — without touching TUI internals. Plugins
  import only `@xmoon76/dsh-pi-tui/extensions`, feature-detect
  capabilities (API version 1), and are fully lifecycle-owned: plugin
  unload/HMR removes exactly that plugin's contributions, and a stale
  surface can never be mutated after disposal. The built-in version badge
  and turn/step counters now dogfood the same public API
  (`@xmoon76/dsh-pi-tui/builtins`). The author guide lives in
  `docs/extension-api.md`.
- `/login` can now add a provider the deployment has never configured. The
  credential picker merges the llm configurable-provider directory (every
  installed pi-ai catalog route plus hand-declared profiles) with the
  settings section, groups rows by configured / available / custom, and
  offers an `[ Add New Platform ]` action that runs a guided wizard — route,
  wire protocol, base URL, display name and API key — probes the endpoint
  for its advertised models (falling back to hand entry), and persists the
  profile through `settings.mutate` plus the credential. `/login <route>`
  for a brand-new route starts the same wizard with the route pre-filled.
  Catalog routes stay one-step: `/login anthropic` still just asks for the
  key. The footer model row and welcome card refresh when the provider
  topology, the llm-pi-ai/llm-deepseek settings, or any credential changes
  (including external `settings.yaml` / `.credentials.yaml` edits).
- **Real-plugin validation (Phase 5).** The tier selection is proven by
  real consumers in `packages/dsh-pi-tui/examples/plugins/`, gated by
  `scripts/examples-plugin-smoke.mjs` against the packed tarball: a
  **production-class vim modal editor** (insert/normal modes, h/j/k/l,
  word movement, x/d/c, i/a/o, undo/redo, yank/paste, multi-line,
  cursor sync, submit integration — all through semantic
  `EditorInputEvent`s, never raw bytes; the Advanced editor SDK is
  sufficient, no Unstable usage), a **questionnaire form** (the Phase-4
  imperative UI broker: select → free text → confirm → notify) and an
  **interactive shell** (the Unstable raw seam: exclusive raw ownership
  + a raw-rendering low-level mount; `exit` or the Host emergency
  fail-safe returns). The authoring decision tree lives in
  `docs/plugin-authoring.md`; the API gap process and the Stable
  promotion review are recorded in `examples/README.md`.
- **Pi capability parity (Phase 4).** The ADVANCED tier gains the
  high-value Pi-style capabilities: the **imperative UI broker**
  (`advanced.ui.select/confirm/input/notify` — promise-based prompts built
  on the Host's own picker/question/notify infrastructure, caller-fiber
  cancellation, surface-disposal settlement), **custom interactive UI**
  (`advanced.ui.custom` — a factory-built interactive component mounted
  by the Host, resolving with the result reported through the public
  `AdvancedCustomHost` facade, never a private TUI object), and the
  **host-state facade** (`advanced.host` — theme query/select, title
  override, working-indicator override, tool-expansion preference). The
  Pi capability matrix (`docs/extension-capability-matrix.md`) records
  the tier mapping as a roadmap reference. Packed acceptance: the new
  `phase4-plugin` fixture + `scripts/phase4-plugin-smoke.mjs` gate.
- **Unstable extension tier (Phase 3).** `@xmoon76/dsh-pi-tui/extensions/unstable`
  is now a usable tier (`UNSTABLE_API_LEVEL = 1`) with NO compatibility
  guarantee: **raw input interception** (`unstable.input.raw` —
  observe/consume/rewrite of RAW terminal chunks BEFORE the Host decodes
  anything, exclusive raw ownership with explicit conflict errors,
  fail-open on throwing handlers, each chunk passes the chain at most
  once), the **Host emergency fail-safe** (triple-Esc within 1.5s
  releases every raw capture and closes every unstable mount — detected
  before the captures, so it cannot be rewritten or consumed by a
  plugin), and the **low-level surface seam** (`unstable.surface.handle`
  — requestRender/geometry/mountComponent for raw-rendering components;
  never exposes TuiApp/screens/terminal). The facade is
  `unstable(service)` — the Stable service interface is untouched. All
  resources stay caller-fiber-owned and surface-generation-scoped;
  failures ride the shared health ledger. Author guide:
  `docs/extension-unstable.md`. Packed acceptance: the new `unstable-plugin`
  fixture + `scripts/unstable-plugin-smoke.mjs` gate.
- **Advanced extension tier (Phase 2).** `@xmoon76/dsh-pi-tui/extensions/advanced`
  is now a usable tier (`ADVANCED_API_LEVEL = 1`) with three capabilities,
  all still Host-mediated (never raw terminal bytes, never private
  screens): **normalized input capture** (`advanced.input.capture` —
  observe/capture/exclusive modes, deterministic priority ordering,
  explicit exclusive-conflict errors, fail-open on throwing handlers),
  **focused interactive surfaces** (`advanced.ui.interactive` — interactive
  managed overlays hosting plugin-owned interactive components with
  Host-compiled rendering, normalized input, focus/blur, resize
  recompilation and fullscreen migration), and **advanced editor control**
  (`advanced.editor.control` — get/set/cursor/insert/paste/focus through
  the host's editor seat). The facade is `advanced(service)` — the Stable
  service interface is untouched. All resources stay caller-fiber-owned
  and surface-generation-scoped; failures ride the shared health ledger.
  Author guide: `docs/extension-advanced.md`. Packed acceptance: the new
  `advanced-plugin` fixture + `scripts/advanced-plugin-smoke.mjs` gate.
- **Tiered extension surface.** The public extension SDK now ships three tiers:
  the stable `@xmoon76/dsh-pi-tui/extensions` entry keeps its compatibility
  contract, and the new `extensions/advanced` (experimental; minor releases may
  break) and `extensions/unstable` (NO compatibility guarantee) entries carry
  tier metadata plus the reserved capability namespaces (`advanced.` / `unstable.`).
  All tiers share ONE extension runtime (caller-fiber ownership, surface lifecycle,
  invalidation). The vim fixture no longer doubles as a production-Stable-API
  proof; full modal editors move to the advanced/unstable roadmap.
- **dsh 0.1.0-rc.8 adaptation.** The dependency baseline moves to rc.8
  (every `@deepseek-ai/*` peer and dev dependency), the `commands.execute`
  calls pass the rc.8 image-array argument, and the bundled agent presets
  align with rc.8: the `minimal` preset gains its Windows/PowerShell twin
  shell rows (bash gates off win32, the pwsh pair gates on), and the
  `codex`/`claude-code` subagent rows migrate from `enableRunInBackground`
  to `backgroundMode: one-shot` (the spawn/fork rows keep `continuable`).
- **`@dir/` mention completion reopens after Tab (kimi parity).**
  Tab-accepting a directory (`@src` → `@src/`) immediately re-shows the
  dropdown at its children instead of waiting for another Tab, and Esc
  closes the dropdown without re-triggering it. Implemented consumer-side
  in a new `TuiEditor` host subclass — the vendored fork stays pristine.
- **`/sessions` and `/resume` categorize the session list.** The default
  view hides subagent sessions (the resume surface is for humans); Tab
  cycles Main / All / Subagents while the picker is open (the live search
  query carries across the switch), and the All view indents subagents
  under their parent session (`└─` tree). Direct `/resume <subagent-id>`
  still matches any session.
- **Faster session-title loading.** The picker's title reads are
  progressive — the first 20 rows land immediately, then 50-row batches
  refresh behind them — and a local cache
  (`$DSH_HOME/cache/pi-tui-session-titles.json`, 0600) serves titles whose
  session logs are unchanged, so the expensive full-log title scans only
  run for genuinely new or changed sessions.
- **Context-compaction progress and results.** While a compaction runs the
  working row shows `Working... · Compacting context…` (a single Esc
  cancels it — pi parity); on settle a `Context compacted` /
  `Compaction failed` notice fires and the transcript gains an expandable
  compaction card (title + `Compacted N history items (~M tokens)` + the
  summary body — web CompactionItem parity). Resuming mid-compaction
  restores the in-flight state.
- **`/model` dismisses after applying an effort.** Picking an effort (or
  Default) closes the whole model overlay in one step (web ModelSelect
  parity); Esc still walks back level by level, and models without effort
  options keep the panel open.
- **The footer wraps on narrow terminals.** The host status line is no
  longer hard-truncated to the terminal width: it wraps across rows
  (bounded — ≤3 host rows + ≤1 stats row, the tail cut with `…`), so the
  model, cwd, branch, context bar and turn/step counters survive on
  phone-narrow screens. The `/settings footer` density semantics are
  unchanged.
- **Fullscreen drag-copy drops the emoji-column indent.** Copied
  transcript lines no longer carry the bullet column's padding spaces
  (`❯ ` / `🐋  ` / `🐳  ` continuation indent) when the selection starts
  at the line head; content indents of 4+ spaces (code blocks) survive,
  and mid-line selections are untouched.

### Changed

- **A TUI surface now has an explicit lifetime.** One surface GENERATION
  survives `start()`/`stop()`, fullscreen toggles and the external-editor
  round-trip; only a final `dispose()` bumps it, and after disposal every
  interactive capability is a benign no-op (approvals settle cancelled,
  question flows settle rejected, in-flight work applies nothing). This is
  the foundation the extension platform's stale-handle contract builds on.
- The `/preset` picker's English name for the `code` preset is now
  `PTC mode`, following the upstream dsh 0.1.0-rc.7 rename (the preset id
  is unchanged, so existing compositions keep working).
- **Ctrl+C and Esc follow pi's editor semantics.** A first Ctrl+C clears
  a non-empty editor (recording the time); a second Ctrl+C within 500ms on
  the now-empty editor exits. Esc closes an open autocomplete dropdown
  (previously the app-level handler swallowed it, so the dropdown could
  not be dismissed), and while the agent is busy a single Esc stops the
  current activity — turn, tool run or compaction — with partial content
  staying on screen (idle keeps the double-Esc cancel). The working row's
  label is now `Working...`.

### Security

- **Plugin text can no longer inject terminal control sequences.** Plugin
  text was the one channel that reached the terminal verbatim; C0
  controls, 8-bit CSI, C1 controls and complete ESC-led sequences
  (CSI/OSC/DCS/PM/APC) are now stripped at the public boundary before
  rendering, in both plain and markdown views. The host's own styling is
  the only ANSI in the output.

### Fixed

- **The host can never be shadowed or stalled by a plugin.** Plugin
  commands are validated against the authoritative host catalog (exact and
  near-synonym collisions are rejected, including the special-cased
  `/plan`); reserved host lifecycle keys cannot be claimed by keybindings;
  a plugin keybinding only fires when the focused editor declines the key;
  and a throwing renderer or callback is isolated to its own contribution,
  recorded in the `/status` health rows, and never escapes the render or
  input path.
- **Editor replacement is safe.** While a plugin editor occupies the seat
  it receives real input through its `handleInput` channel and Enter
  submits through the host path; a display-only editor (no input hook)
  never silently routes typing into the hidden host editor; handoff is
  atomic (a throwing create/transfer/compile keeps the current editor
  working); and every capability captured by a stale editor becomes inert
  after handoff or disposal.
- **Narrow terminals stay intact.** Horizontal stacks render side by side,
  frames clamp to the host budget with cell-exact ANSI/CJK padding, and
  one- or two-cell-wide frames abdicate safely instead of overflowing.
- A settled `ask_user_question` card no longer shows the raw
  `{"answers":[…]}` JSON: it renders an answered-count summary
  (`2/3 answered`, skipped questions excluded), and a cancelled or aborted
  flow shows the structured error identity (`UserQuestionError:
  ASK_CANCELLED` / `ASK_ABORTED`) instead of an empty or JSON body — web
  AskQuestionRow parity.

## [0.1.8] - 2026-08-18

### Changed

- The question dialog's back/skip verbs are now the arrow keys: `→` moves on
  (an unanswered question is marked skipped, an answered one keeps its
  draft), `←` goes back to the previous question, and the review page uses
  `↑↓` to choose Submit/Cancel with `←` to return to the questions. The
  letter keys (`s` skip, `b` back) are gone — left/right now match the
  direction of travel.

### Fixed

- Arrow/Esc/Tab now work in the question card and the task browser on
  terminals that answer the Kitty keyboard-protocol query (zellij, WezTerm,
  Windows Terminal, kitty): these components compared raw legacy sequences
  (`\x1b[A`, `\x1b`, `\t`), so on CSI-u terminals every such key arrived
  as `\x1b[1;1B` / `\x1b[27;1u` / `\x1b[9;1u` and was silently dropped —
  the question card and task browser froze for arrows/Esc/Tab while letters
  and Enter kept working. Key matching now routes through `matchesKey`
  (legacy + CSI-u + modifyOtherKeys, including the super-modifier bit 128
  zellij reports).
- Skill slash commands (`/name` and `/skill <name>`) no longer swallow the
  user's arguments: the per-skill wrapper discarded `invocation.rawInput`
  and injected only a hand-rolled body card, so `/glab open issue 123`
  reached the model as the bare skill instructions with the request lost.
  Invocation now follows web parity — the user's original line (with any
  `/name args`) ships as a plain user message, and the loaded body follows
  as injected instructions context using the official `<skill_content>`
  rendering and `skill-invocation` source (rendered by the host's
  dsh-tool-skill pre-step listener when its loader tool is visible; the TUI
  injects it itself only as a fallback for compositions without the host
  loader, so the body is never duplicated).

## [0.1.7] - 2026-08-18

### Fixed

- A user-loaded skill (`/skill <name>` or a per-skill slash command like
  `/opip-ip-query`) now actually runs: the loaded body was delivered with
  `agent.inject()`, which queues for the next pre-step WITHOUT waking the
  driver — with an idle agent the skill content just sat in the queue pane
  until some unrelated input woke the turn. The load now delivers like the
  `/queue` steer action: a running agent takes it at the next step boundary,
  an idle agent starts a fresh turn with it (web parity — the web surface
  submits the `/name` prompt as a plain follow-up/steer and the host's
  pre-step listener injects the body).
- The subagent transcript viewer no longer freezes the main transcript:
  while viewing a child session, main-agent events were being dropped, so
  the main transcript stopped updating (subagent cards stuck at
  `[running]`) and the working indicator never turned off. Main-session
  events now keep routing to the main folder while the viewer is open. The
  viewer also pops back to the main transcript automatically when the
  viewed child's result lands (matched by the delegation's description),
  and the view anchors to the latest content on return (fullscreen
  scrolls to end; the regular surface forces a clean full repaint).

## [0.1.6] - 2026-08-18

### Added

- Open-time session lock: opening a session (`--session`, `/resume`,
  `/sessions`) refuses when another live dsh process already holds it — an
  `owner.lock` file next to the session log records the owner's pid and
  `/proc` starttime; a crashed owner's stale lock is taken over automatically.
  This closes the corruption path where a second opener's resume made the
  persistence layer synthesize interrupted-turn closers into the shared log
  while the first process kept appending from its own in-memory seq (the
  write-path guard cannot see that collision — the second opener's memory
  matches the file). The divergence guard remains the backstop for surfaces
  that know nothing about the lock.
- Plain `exit` (exact trimmed word) quits the TUI before session creation or
  the busy-Enter gate; `/exit` is unchanged.
- `/login` and `/logout` resolve credential targets: deepseek official plus
  every llm-pi-ai route's `apiKeyEnv` (picker, route/first-word matching,
  env-var verbatim with uppercasing, unknown → options list).
- Per-cwd input history stored as JSONL under
  `$DSH_HOME/user-history/<md5(cwd)>.jsonl` (kimi-code pattern): append-only,
  consecutive-repeat skip, 100-entry cap, corrupt-line tolerance, boot seed,
  and a crash-safe one-time migration from the legacy settings key.
- Goal line between the todo panel and the queue pane (display-only, rendered
  while a goal is set).
- Inline skill autocomplete in the editor (`/` after whitespace or on later
  lines triggers; Enter applies `data.inlineSkill`-marked completions without
  submitting) — from the vendored fork sync to kimi-code 44a6c70e6.
- Web-parity tool cards: `card:'web'` result views (answer + source list for
  a search, URL + HTTP status for a fetch), per-tool one-line shapes for
  object rawInput (todo_write checklist, terminal session target, session
  event seq) instead of pretty JSON, and content-block rendering for plan
  review cards in both pending and completed states.
- Task browser panel with status dots, aligned columns, and live ticking:
  the ↓/Ctrl+J and `/tasks` lists render job state (running/stopping/
  completed/failed), elapsed time updating every second, and group headers
  with live counts — web JobListAction parity.

### Changed

- Background-subagent settlement notices (continuable subagent-settled and
  tool-jobs one-shot completions) leave the queue pane — the task browser is
  their surface; failures notify once per message id.
- Editor-area chrome: the todo summary moves into the dock strip (single dim
  info line, no border rule); per-task/per-subagent detail lines are dropped
  from the dock (footer badges + ↓/Ctrl+J browser only); the goal slot leaves
  the footer; panel borders indent one cell per side.
- Vendored fork synced to kimi-code 44a6c70e6; the two new upstream
  divergences are registered in `packages/pi-tui/AGENTS.md`.

### Fixed

- Question dialog arrow keys scroll at the scrollport edges, so walking the
  cursor into the options can never strand the question overview off-screen
  on small terminals.
- `todo_write` with an array `rawInput` renders as a checklist, not a pretty
  JSON dump.
- Session repair strips the trailing empty zstd frame that
  `zstdCompressSync` can emit, so repaired logs stay valid for every reader.
- Session-lock hardening from review rounds: lease leak on takeover paths,
  swap-failure repair gaps (re-take checks, ordering), and probe fixes — the
  swap-repair logic is extracted into a pure headless-tested function.

### Removed

- Dead `@deepseek-ai/dsh-session-query` peer dependency (the picker types it
  structurally and reads the service off the live context).
- Scaffold-era `vitest.config.ts` from `packages/pi-tui` (node --test is the
  suite).

## [0.1.5] - 2026-08-17

### Added

- Surface catalog coordinator with resume prefetch; standing-scope cold-skill
  reads on deferred start; sessionless preset/reload refreshes.
- Unified question page scrollport (question + detail + every option with its
  description + free-text row), with expand (`e` / fullscreen click) and
  scroll-position preservation across tab changes; `e` reveals cut option
  descriptions on small screens.

### Changed

- Question panel scrollport, expand, and fullscreen clicks; the hint fit loop
  reserves `esc cancel`.
- Review hardening: single-point skill adapter, incomplete-observation guard
  (last-good retention), preset-identity exactness, and settle ordering.

## [0.1.4] - 2026-08-16

### Added

- Busy-Enter setting — Enter steers while the agent is running (web
  `busyEnter` parity); Ctrl+Enter always forces queue mode; skill commands
  steer too, only LOCAL commands execute.
- `!` shell submits command + output to the session; `!!` stays local.
- Subagent viewer covering the editor with a read-only viewer bar.
- Task browser merges continuable subagents with the jobs registry; opens
  with a children-only session.
- `/rename` alias of `/title` — no-arg regenerates and overwrites the session
  title.

### Changed

- Question dialogs live in the editor seat (kimi's `mountEditorReplacement`
  pattern) instead of a centered overlay; wide question dialogs and N-more
  truncation markers.
- Transcript markdown reflows on resize; bash commands and approval hints
  stay visible.
- Docs reorganized into an indexed documentation set (AGENTS.md + `docs/`).

### Fixed

- `/preset` — sessionless roster, English copy, one-Enter picker.
- Theme autodetect in fullscreen mode + stale/late-result races; CI clears
  `NO_COLOR`/`FORCE_COLOR`/`CI` in autodetect tests.

## [0.1.3] - 2026-08-16

### Added

- Background jobs get their own surface: queue notice markers, footer badge,
  task browser, output viewer.
- Theme detection chain (OSC11 → COLORFGBG → dark) and diff tokens.
- `@` file mentions with `fd` detection and a bounded recursive fallback.
- `/quit` as a native alias of `/exit`; slash exits route through the unified
  exit contract.
- Repeatable pack gate: prepack builds + verifies, postpack tarball smoke,
  CI jobs (publish only after the complete matrix).
- Exit flush contract and detached-task entry as testable primitives.

### Changed

- Multi-row tool cards with command/diff previews; question dialog wraps
  instead of truncating.
- Working indicator repaints through a callback; live palette switches
  recolor every surface.
- tmux testing guide with reusable scripts.
- Performance: history-independent window projection; cross-turn read groups
  keep the fast window consistent; message component cache bound and pruned
  to the live transcript; benchmark harness with saved baseline.

### Fixed

- CI publish path (no cwd assumptions on tags); tarball discovery when
  npm/pnpm strip the `@` scope from tgz filenames.
- Review-loop convergence: owned lifecycle with total async boundaries,
  draft merge, per-stream decoders, honest force hints, truncation.
- Question flows serialize FIFO; model-menu late resolves/rejects after Esc
  never apply.
- Old-session async work and state can never leak into a new session.
- Repair-session: torn zstd tail safety, explicit layout scan, fsynced
  backup, ambiguous-ref refusal; segment references resolve to the actual
  same-frame occurrence.
- Local-shell output bounded with truncation markers and 0600 full-output
  files; robust external editor.

## [0.1.2] - 2026-08-15

### Added

- Queued-input pane and `/queue` management; Ctrl+S steers the whole queue;
  insert-before via `inbox.splice`.
- Dequeue shortcut rebound from Ctrl+Q to Alt+Up.
- `ask_user_question` rebuilt as a navigable flow with review.
- Session creation deferred until the first user message.
- Workflow run cards grow member trees; dock strip above the editor.
- `/yolo` alias for `/permission danger-full-access`; permission mode badge
  and Shift+Tab cycling.
- Real LCS diff rendering for edit/write tool cards.
- Resume hint printed on interactive quit (pi parity).
- Sessionless slash commands; cross-process guard + diagnostics.
- Vendored fork synced to upstream v0.84.3; overlay stacking moved to dsh.

### Fixed

- Notify survives repaints and defaults to info; error notices opt in
  explicitly; permission badge lives in the footer.
- Overlay frame borders and stacked-overlay compositing.
- Slash-command autocomplete no longer lags a keystroke.
- Tool-registry scope passes the agent object.
- tok/s and token accounting match the Web's sampled semantics.
- Queue-pane splice race; repaired logs written in the dsh frame layout.

## [0.1.1] - 2026-08-15

### Fixed

- `@deepseek-ai/*` declared as peerDependencies, not dependencies — no
  duplicate copies in the profile (`Cannot read properties of undefined
  (reading prepare)` on the first tool call).

## [0.1.0] - 2026-08-15

### Added

- First public release: `@xmoon76/dsh-pi-tui`, a TUI surface for DeepSeek
  Harness profiles (`dsh --profile pi-tui`), built on a vendored pi-tui fork
  and bundled as a single self-contained package.
- Transcript engine: windowing, incremental folding, pairing, event folds;
  web-parity tool cards, live latest-line thinking, and a whale working
  indicator.
- Approval dialogs and permission modes (`/permission`, danger flag, preview);
  slash commands complete: `/status`, `/sessions`, `/preset`, `/model`,
  `/plan`, `/search`, `/export`, `/subagents`, `/reload`, `/resume`,
  `/skill-<name>`, and a session switcher.
- Fullscreen layout that pins the editor; Ctrl+F transcript search; Ctrl+D
  quits like `/exit`; mouse support in fullscreen (pi parity).
- Theme system: custom palette files, terminal background detection,
  semantic tokens, folding, and context-injection cards labeled by producer.
- Single-package release model: the fork is bundled into the published
  package at build time; the tarball is self-contained.

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/XMoon/dsh-pi-tui/releases/tag/v0.1.0
