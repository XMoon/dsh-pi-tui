# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/XMoon/dsh-pi-tui/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/XMoon/dsh-pi-tui/releases/tag/v0.1.0
