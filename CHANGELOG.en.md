# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0-alpha.2] - 2026-09-03

### Installation and version pairing

For this prerelease, install the matching DSH first and then add the TUI bundle
into a profile:

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
```

Users who must keep DSH `0.1.1-rc.2` should use `@xmoon76/dsh-pi-tui@0.3`;
users on the DSH `0.1.2-alpha.2`/`alpha.3` baseline should pin
`@xmoon76/dsh-pi-tui@0.4.0-alpha.1`. The complete matrix and update/remove
commands are in the README's Installation section.

### Added

- **Task Center.** `/tasks` is rebuilt as a three-layer task surface: footer
  badge → Quick Tasks (footer down, Active scope) → the full Task Center
  (`/tasks`, All scope). An explicit search mode treats printable keys as
  query text only — they can never fire destructive actions, and Esc exits
  search before closing the panel. `Stop` (`S` → `Y` confirmed) replaces the
  old bare-`i` interrupt and is re-validated at dispatch time against the
  session fence and the Agent registry. The footer badge shows separate
  running/total agent and job counts plus unacknowledged failure attention;
  opening either surface acknowledges only the failure rows actually visible.
- **Terminal completion notification.** When the main agent settles while the
  terminal is not focused, a system notification fires (OSC 9 / OSC 777 /
  bell, chosen by the terminal environment). It triggers only on a true
  settle — never on retries, compaction, queued continuations or subagent
  ends. `/settings` gains `Completion notification` mode (Unfocused / Always
  / Off) and method (Auto / OSC 9 / OSC 777 / Bell) rows.
- **`/settings` gains Subagent model selection.** The toggle and the
  "Subagent allowed models" route picker read and write the official
  `subagent-model-selection` settings section directly (default off;
  enabling requires at least one route; sampled at NEW session composition,
  never rewriting a running session).
- **Tool-card action payloads are first-class.** Compact tool cards show the
  action payload directly, expanded payloads keep their blank lines, and
  narrow/zero-width rows are handled explicitly.

### Improved

- **`/sessions` and `/resume` are faster and cancellable.** The picker opens
  input-first (Enter while loading can never resume); each session gets one
  combined projection read (live rows read the in-memory snapshot, cold rows
  read the durable cache, and only genuine cache misses run a bounded
  observe); progressive enrichment is cancellable — closing, quitting or
  re-opening aborts the scan; `/resume <arg>` shares the same lifecycle.
- **Paste handling is more reliable.** A large paste followed by `Ctrl+G`
  no longer loses content in the external editor (`$EDITOR` sees the
  expanded text); outbound drafts (steer / submit / queue / subagent
  submission) expand paste markers uniformly instead of leaking literal
  markers onto the wire.
- **The editor submit binding is independent.** A dedicated
  `tui.editor.submit` binding (Editor-only) means question free-text and
  search boxes are no longer submitted by `submit: ctrl+x`-style configs.

### Fixed

- **Surfaces keep their state across terminal resizes.** The queue pane,
  todo panel, history-search overlay and approval dialog rebuild from raw
  state at the live geometry without losing component state, focus or
  overlay semantics.
- **The diff view no longer shows unprovable line numbers.** When the DSH
  FileDiff contract carries no hunk anchors, the gutter is hidden — absolute
  line numbers are never guessed.
- **The Focus expanded view keeps the initial user prompt before the
  Thought.** Injected system rows no longer push the first user message
  below the Thought.
- **The builtin todo summary returns after the panel closes.** With an
  extension host attached, closing the panel no longer leaves the dock's
  todo summary permanently empty.
- **Stability hardening.** The process slot is held until the final dispose
  and editor-mount/component disposal is hardened, reducing races on exit
  and HMR.

### Compatibility

- **The minimum DSH is raised to `>=0.1.2-alpha.4`** (from
  `>=0.1.2-alpha.2`). Runtimes below alpha.4 get a startup notice:
  alpha.2/alpha.3 fall back to `@xmoon76/dsh-pi-tui@0.4.0-alpha.1`, older
  runtimes fall back to 0.3.
- Development/test dependencies and the Source Mode pin move to
  `dsh-v0.1.2-alpha.5`; the published peer floor stays `>=0.1.2-alpha.4`.

> **Known limitation:** the production default backend remains Direct; remote
> attach is not supported yet.

## [0.4.0-alpha.1] - 2026-09-01

### Installation and version pairing

```sh
npm install -g @deepseek-ai/dsh@0.1.2-alpha.3
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
```

Users who must keep DSH `0.1.1-rc.2` should use `@xmoon76/dsh-pi-tui@0.3`.

### Added

- **Footer custom command items.** The `/footer` Add picker gains
  `+ Create Custom Command` — items with a refresh interval, timeout and
  semantic tone. Commands activate only from the USER-layer trusted source
  (project configuration can never supply or activate a command), and the
  render path never spawns.
- **`/model` selection is persisted per live Agent.** Each live Agent owns
  its own selection reference; the footer and `/model` follow the current
  Agent, with latest-wins fencing between the global default and
  session-local choices.
- **The Focus expanded view preserves user steer chronology.** The initial
  user stays before the Thought and later steers/users return to their
  actual chronological position; the compact Message becomes the third
  process slot (Think → Tool → Message) showing the newest up to three rows.
- **The fullscreen mouse-wheel step is configurable.** `/settings` gains a
  `Mouse wheel lines` row (1/2/3/5/8, default 1).
- **Todo panel interaction polish.** With five or fewer items the panel is a
  two-state summary ↔ list; rapid consecutive clicks coalesce into one
  gesture instead of flashing the panel away.
- **Long-session search is a stable indexed projection.** Fullscreen search
  uses stable item identities over a single corpus; a query iterates only
  the entries dirtied since the last run, and jumps anchor by the stable
  turn.
- **Status-line and `/status` context readings are unified and
  deduplicated.** Ordinary refreshes read the cache; `/status` forces one
  measurement into the cache, so the panel and footer can no longer
  disagree.

### Fixed

- Explicit cold resume shows startup progress before the TUI mounts
  (`Resuming session…` / `Preparing conversation…`) instead of a blank
  terminal that reads as a hang.
- Search overlay Next/Prev no longer skip newly arrived matches.
- A live tail append refreshes the whole read group, so search jumps never
  anchor a stale window.
- An instantly-exiting footer command child no longer crashes the TUI
  (EPIPE swallowed).

### Migration notes

- **0.4.0-alpha.1 moves to DeepSeek Harness 0.1.2.** The declared support
  range is `>=0.1.2-alpha.2`; users keeping DSH 0.1.1 should pin
  `@xmoon76/dsh-pi-tui@0.3`.
- Agent preset identity is roster-aware; an omitted legacy `code` default
  falls back to `ptc` when the roster proves `code` is absent.
- Upstream alpha caveat: DSH 0.1.2-alpha.1 still has an upstream
  subagent-dispose caveat.

## [0.3.6] - 2026-08-31

### Added

- `@` mentions and `/image` arguments share one file-completion engine
  (path parsing, ranking, quoting, directory continuation).
- Long sessions use a bounded transcript window (overlapping paging,
  `Ctrl+End` back to the latest, preserved window anchors).
- Submission has immediate feedback and an observable latency timeline
  (`Submitting…` / `Queued…`).

### Changed

- `/footer` saving is discoverable and transactional (Save changes / Unsaved
  states, Esc confirmation).
- Session writes use a fail-closed ownership model (owner lock +
  single-writer boundary).

### Fixed

- Async completion results always repaint the active screen.
- The footer honors the real available budget on narrow terminals, fullscreen
  changes and command surfaces.
- Transcript window changes, search and live follow no longer lose viewport
  anchors.

> **Known limitation:** the production default backend remains Direct; remote
> attach is not supported while M2–M8 are unfinished.

## [0.3.5] - 2026-08-28

### Added

- **The `/footer` configurator is redesigned as a hierarchical status-line
  editor.** Row Selector → Edit Row → Item Editor; `A` opens a searchable
  Add Picker; the preview and help are a fixed shell; the save key moves to
  `S`.
- **Footer supports user-defined static text items.** `+ Create Custom
  Text`, read only from the USER settings layer.
- **Builtin footer items expose meaningful finite styles.** Model /
  Permission / Working directory / Context / Token usage / Performance /
  Turns gain distinguishable variants.
- **Plugin theme selections are SOURCE-QUALIFIED
  (`plugin:<owner>/<id>`).** Plugin and file themes no longer share a bare
  name namespace; an unloaded plugin degrades deterministically to the
  built-in dark palette.
- **An `Icon style` setting** switches between Emoji, Symbols and Minimal
  structural icon palettes, applied immediately.
- **Keybindings are user-orchestrable.** Semantic actions resolved through a
  context-aware keymap; `/keybindings` shows the effective table,
  `conflicts` lists conflicts, `reload` re-reads, `reset` clears; `<leader>X`
  multi-key bindings; `DSH_PI_TUI_SAFE_KEYBINDINGS=1` ignores all overrides.
- **The `/help` and `/settings` key copy is key-neutral.** It never claims a
  physical key that a remap could make stale.
- **A trusted command status line (Claude/Kimi style).** `footer: command`
  hands the status surface to a user-configured command (JSON snapshot on
  stdin, stdout rendered, periodic refresh, fallback to the native layout on
  failure); only a USER-layer `footerCommand` is ever executed.

### Changed

- The footer is a composable, user-configurable surface (`custom` preset +
  versioned `footerLayout`).
- Plugins can contribute configurable footer items (`chrome.footer.item`
  slot).
- The question flow and task browser route keys through semantic component
  actions.

### Fixed

- Empty input no longer manufactures a message or a side effect (Enter /
  Ctrl+Enter / Ctrl+S are silent no-ops).
- Editor ↑/↓ history is projected onto the active session.
- Terminal window titles are human-readable (`dsh · <title>`, sanitized
  against ANSI/OSC).
- Ghost Tool Cards after compaction/prune are gone.

## [0.3.4] - 2026-08-25

### Added

- **Ctrl+R searches your input history.** A modal panel filters live; `Tab`
  cycles Current session / Current directory / All directories; bounded
  recent-first scanning (5000-line global budget); paged continuation;
  `Enter` puts the selection back into the editor for editing.
- **`/tasks` shows the full subagent lineage as a tree.** Depth indentation
  with `├─` connectors in stable pre-order; nested descendants are read-only.
- **The selected row's long label marquees** instead of truncating.

### Changed

- **Thinking blocks are disclosure, not visibility.** `Alt+T` is the one
  bulk owner; `Ctrl+O` owns only tool/system/compaction detail.
- **`!` / `!!` shell lines are a first-class editor mode.** The prompt
  itself becomes `!`/`!!`; pasting `!git status` lands as mode + command.
- **Local shell cards preview instead of flooding the screen.** A running
  card collapses to the newest 5 lines, a settled card to at most 20;
  `Alt+K` quick-dismisses settled cards.

### Fixed

- A startup-time TDZ (footer command lifecycle slots declared too late).
- Ctrl+V image paste works again on Linux Wayland/X11 (forced buffer
  encoding).
- Task overlays no longer draw a black mask beside the border.

## [0.3.3] - 2026-08-24

### Added

- **Continuable subagent viewers are interactive.** A live conversation
  surface with the child's own draft, FIFO delivery, and failed deliveries
  merged back into the draft; one-shot children stay read-only.
- **The task browser shows the subagent mode** (`continuable` / `one-shot`).
- **Focus Mode** folds a running turn's intermediate activity into a live
  Thought block; clicking expands it and streaming continues into the open
  region.
- **`Home/End keys` are configurable in `/settings`** (Input / Viewport).
- **`@`-file mentions reach the model as absolute paths.**
- **The task browser filters by row type** (Tab cycles All → subagent →
  bash → pwsh).
- **Pi-style rewind: `Esc Esc` (or `/rewind`)** forks the conversation from
  an earlier user turn; the original session is never modified.
- **`/fork` and `/rewind` share one fork chain.**

### Changed

- Esc never destroys your queue again (keepInbox semantics).
- `/sessions` scopes by directory (Current directory / All directories).
- The question review page is a pure review (Enter submits, Esc cancels,
  `←` returns).

### Fixed

- Session transitions are a single-writer transaction: a switch waits for
  the current activity, failures leave no half-created branch, and two
  processes can never write one session.
- The double-Esc rewind chord is truly consecutive.
- Fullscreen drag selection and `/copy` no longer fake a successful copy
  (tmux / platform helpers / OSC 52 fallback).
- The `Press Ctrl+C again to exit` hint lives in the footer for exactly the
  exit window.
- A settled background job card keeps its command.
- `@dir` completion no longer depends on a trailing slash.

## [0.3.2] - 2026-08-22

### Added

- **User input renders as a brand-blue bubble** with a matching `❯` prompt
  (overridable palette token).
- **`/image <path>` completes paths.**
- **Mixed image messages keep an inline `🖼️` placeholder.**
- **Fullscreen: click an attachment to collapse/expand the picture** (with a
  constant identity line).

### Fixed

- Injected context rows never leak their XML envelopes when expanded.
- The image summary marker `🖼️` (U+FE0F) no longer overlaps the filename.
- Write / skill / read_image cards fold their content, never the raw XML
  envelope.

## [0.3.1] - 2026-08-21

### Changed

- A startup gate explains an unsupported harness (detected version, minimum
  version, upgrade command).
- The `/login` surface separates the two credential planes in its copy.

## [0.3.0] - 2026-08-21

### Added

- **Provider-native sign-in.** `/login` understands the two credential
  planes: the API-key path and OAuth / device-code native login; secret
  prompts render masked.
- **`/logout` clears both credential planes.**

### Changed

- **Minimum compatible DeepSeek Harness is `dsh-v0.1.1-rc.1` or later** (no
  longer 0.1.0-rc.8).
- The header version badge shows the dsh version first, then the `tui-`
  version.

### Security

- Authorization secrets are never printed, logged, put in input history,
  written to the transcript, or shown in `/status`.

## [0.2.2] - 2026-08-21

### Added

- **Merged task browser as the single background surface.** `/tasks` opens
  one searchable list over jobs AND subagents; `/subagents` became an alias.
- **Alias registration for TUI commands** (`/quit`, `/resume`, `/rename`,
  `/subagents`).
- **Subagent-family tool cards show their model.**
- **`!` / `!!` shell lines complete like a real shell** (command names,
  `$VAR`, git subcommands).
- **Local shell sandbox preference.** User-typed commands bypass the dsh
  sandbox by default.
- **Question cards show their answers; goal cards are readable.** Folded
  previews never leak raw JSON.
- **Fullscreen todo dock click.**

### Changed

- Queue pane notice classification (user rows `❯` / notice rows `⏳`).
- Ctrl+J is no longer a host keybinding.
- `!` / `!!` run in the session workspace.

### Removed

- **`/queue` command removed outright.** The queue pane is the single queue
  surface.

### Fixed

- Alt+↑ dequeue only pulls the user's own messages back.
- The double-Ctrl+C exit chord is visible and forgiving (1.5s window +
  hint).
- Folded cards never leak raw JSON.

## [0.2.1] - 2026-08-21

### Changed

- The repository root is now the published package (no behavior change for
  npm consumers).

## [0.2.0] - 2026-08-21

### Added

- **Extension platform v1.** A third-party Cordis plugin can contribute
  chrome, widgets, slash commands, themes, settings rows, autocomplete,
  keybindings, renderers, overlays, and even replace the editor; plugins
  import only `@xmoon76/dsh-pi-tui/extensions` and are fully
  lifecycle-owned.
- **Tiered extension surface.** Stable `extensions` + `advanced`
  (experimental) + `unstable` (no compatibility guarantee).
- **`/login` can add a provider the deployment has never configured** (a
  guided wizard + endpoint model probing).
- **Real-plugin validation.** A vim modal editor, a questionnaire form and
  an interactive shell example.
- **`@dir/` mention completion reopens after Tab.**
- **`/sessions` and `/resume` categorize the session list** (Main / All /
  Subagents).
- **Faster session-title loading** (progressive batches + local cache).
- **Context-compaction progress and results** (notices + an expandable
  compaction card).
- **`/model` dismisses after applying an effort.**
- **The footer wraps on narrow terminals.**

### Changed

- A TUI surface has an explicit lifetime (generation / dispose).
- Ctrl+C and Esc follow pi's editor semantics.

### Security

- Plugin text can no longer inject terminal control sequences.

### Fixed

- The host can never be shadowed or stalled by a plugin.
- Editor replacement is safe (atomic handoff, stale handles become inert).
- Narrow terminals stay intact.

## [0.1.8] - 2026-08-18

### Changed

- The question dialog's back/skip verbs are now the arrow keys (`→` / `←` /
  `↑↓`).

### Fixed

- Arrow/Esc/Tab work again on Kitty-keyboard-protocol terminals (zellij,
  WezTerm, Windows Terminal, kitty).
- Skill slash commands no longer swallow the user's arguments.

## [0.1.7] - 2026-08-18

### Fixed

- A user-loaded skill now actually runs (an idle agent starts a fresh turn
  with it).
- The subagent transcript viewer no longer freezes the main transcript.

## [0.1.6] - 2026-08-18

### Added

- Open-time session lock (a second live process is refused; a crashed
  owner's stale lock is taken over automatically).
- Plain `exit` quits the TUI.
- `/login` and `/logout` resolve credential targets.
- Per-cwd input history stored as JSONL.
- Inline skill autocomplete in the editor.
- Web-parity tool cards (web results, todo checklists, plan review).
- Task browser panel (status dots, live ticking).

### Changed

- Background-subagent settlement notices leave the queue pane.
- Editor-area chrome (todo summary moves into the dock strip).

### Fixed

- Question dialog arrow keys scroll at the scrollport edges.
- Session repair strips the trailing empty zstd frame.

### Removed

- Dead `@deepseek-ai/dsh-session-query` peer dependency.

## [0.1.5] - 2026-08-17

### Added

- Surface catalog coordinator (resume prefetch, cold-skill reads).
- Unified question page scrollport (expand, scroll-position preservation).

## [0.1.4] - 2026-08-16

### Added

- Busy-Enter setting (Enter steers while the agent is running).
- `!` shell submits command + output to the session; `!!` stays local.
- Subagent viewer covering the editor with a read-only viewer bar.
- Task browser merges continuable subagents with the jobs registry.
- `/rename` alias of `/title`.

### Changed

- Question dialogs live in the editor seat.
- Transcript markdown reflows on resize.

## [0.1.3] - 2026-08-16

### Added

- Background jobs get their own surface (queue notices, footer badge, task
  browser, output viewer).
- Theme detection chain and diff tokens.
- `@` file mentions.
- `/quit` as a native alias of `/exit`.

### Changed

- Multi-row tool cards with command/diff previews.
- Performance: window projection, cross-turn read groups, message component
  cache.

### Fixed

- Question flows serialize FIFO.
- Repair-session (torn zstd tail safety, fsynced backup).
- Local-shell output is bounded.

## [0.1.2] - 2026-08-15

### Added

- Queued-input pane and `/queue` management; Ctrl+S steers the whole queue.
- `ask_user_question` rebuilt as a navigable flow with review.
- Session creation deferred until the first user message.
- `/yolo` alias; permission mode badge.
- Real LCS diff rendering for edit/write tool cards.

### Fixed

- Notify survives repaints.
- Slash-command autocomplete no longer lags a keystroke.

## [0.1.1] - 2026-08-15

### Fixed

- `@deepseek-ai/*` declared as peerDependencies (no duplicate copies in the
  profile).

## [0.1.0] - 2026-08-15

### Added

- First public release: `@xmoon76/dsh-pi-tui`, a TUI surface for DeepSeek
  Harness profiles (`dsh --profile pi-tui`), built on a vendored pi-tui
  fork and bundled as a single self-contained package.
- Transcript engine (windowing, incremental folding, web-parity tool
  cards).
- Approval dialogs and permission modes; a complete slash-command set.
- Fullscreen layout, Ctrl+F transcript search, theme system.
- Single-package release model.

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.0-alpha.2...HEAD
[0.4.0-alpha.2]: https://github.com/XMoon/dsh-pi-tui/compare/next-v0.4.0-alpha.1...next-v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.6...next-v0.4.0-alpha.1
[0.3.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.2.0...v0.2.1
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
