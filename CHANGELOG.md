# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Home/End keys` are now configurable in `/settings`.** Two habits
  exist for Home/End in fullscreen: some expect them to move within the
  input, others expect them to scroll the conversation. The new
  `Home/End keys` row picks the behavior — `Input` (Home/End move within
  the input, Ctrl+Home/End scroll the conversation) or `Viewport`
  (default; Home/End scroll the conversation, Ctrl+Home/End move within
  the input). The choice applies immediately and persists across
  restarts; existing behavior is unchanged by default.
- **`@`-file mentions reach the model as absolute paths.** The editor
  keeps the concise relative form you typed (`@src/foo.ts`), but at
  submit time every mention that resolves to a real file is canonicalized
  to the full path (`@/home/…/src/foo.ts`), so the model never has to
  guess which workspace the file lives in. Relative, `./`, `../`, `~`
  and quoted (`@"dir with spaces/f.ts"`) forms are supported; a mention
  that does not resolve (a typo, or a non-path `@` word) is sent verbatim.
  Email addresses and `pkg@1.0.0`-style text are never touched.
- **The task browser filters by row type.** Pressing Tab in `/tasks` (or
  the ↓/Ctrl+J trigger) cycles `All → subagent → bash → pwsh → …`; the
  header shows the active scope (`[bash]`) and the counts follow it. The
  cursor also lands on the first *running* subagent when the browser
  opens, instead of staying stuck on the first job while the subagent
  catalog loads in the background.
- **Pi-style conversation rewind: `Esc Esc` (or `/rewind`) forks the
  conversation from an earlier user turn.** With an empty editor and the
  agent idle, a fast second Esc opens a picker of the session's completed
  user prompts (newest first, one row per turn, searchable). Choosing one
  creates a new child session whose history ends right before that turn
  (`parentSession` + `seedLength` recorded), swaps to it, and restores the
  selected prompt into the editor for editing — nothing is sent
  automatically. The original session is never modified, truncated or
  deleted and stays reachable through `/sessions`, whose picker now renders
  the full lineage tree in BOTH scopes — fork children, rewind branches and
  subagents hang under their parent with a `└─` prefix (in the
  Current-directory scope, a branch whose parent lives in another workspace
  is shown as a depth-1 orphan, never lost). Rewind is a conversation
  operation only: workspace and external side effects are never reverted,
  historic image attachments are not re-staged (the picker marks
  multimodal prompts and the restore warns), and a busy single Esc still
  cancels — only an idle empty-editor double-Esc opens the picker.
- **`/fork` and `/rewind` share one fork chain.** Both create their child
  session through the same code path (recorded-preset resolution →
  composition → agent creation with `parentSession`/`seedLength`), so
  preset, provider/model and cwd inheritance can never drift between the
  two surfaces; `/fork` now uses the live session's cwd instead of the
  launch-time value.

### Changed

- **Esc never destroys your queue again.** Interrupting the agent (one
  Esc while busy, double-Esc while idle) now preserves queued input — the
  same `keepInbox` semantics as the web Stop button. The pending queue is
  parked while the current turn aborts instead of being cleared outright;
  dsh currently parks the queue after an interrupt (auto-continuing it
  needs an upstream dsh capability, tracked in the code).
- **`/sessions` scopes by directory.** The Main/Subagents/All tabs are
  gone: the picker opens on `Current directory` (sessions in the
  workspace you are in) and Tab switches to `All directories` (every main
  session, grouped by its workspace — no cap). Subagent sessions are no
  longer a picker category; `/tasks` and the subagent viewers own that
  surface.
- **The question review page is a pure review.** The final Submit/Cancel
  two-choice row is gone: Enter submits the whole batch, Esc cancels, `←`
  returns to the last question to edit. No focus, no arrows — just the
  keys you would expect.

### Fixed

- **Session transitions are now a single-writer transaction.** `/new`,
  `/fork`, `/rewind` and `/sessions` switches all run through one unified
  transaction (`transitionTo`, ordered in `src/transition.ts`): the OLD
  agent is QUIESCED first (`whenIdle` — a transition while the agent is
  busy now waits for the current activity instead of aborting it), its
  final flush runs with the old lock still held, the child is
  created/resumed next, the commit (old-lock release, new-lock acquire,
  live replacement, generation bump) is a synchronous critical section,
  and the old-handle teardown after it is best-effort. Three consequences
  close the review blockers: (1) two transitions can never interleave —
  a stale-identity check can no longer pass and then yield across an
  await while a concurrent transition lands and later gets overwritten;
  (2) once the child is created it is never "rolled back" — `dispose()`
  stops an agent but never deletes a persisted session, so a failed
  flush after the create could no longer leave a durable ghost branch;
  (3) the old session's open lock is only released after the old agent
  has quiesced — a cancelled RUNNING turn appends its closure events in
  finally blocks, and releasing the lock earlier would let another dsh
  process resume the session while those closures are still being
  written (the two-writers seq collision the lock exists to prevent).
  Writes are fenced while the transition is in flight: `whenIdle()` is an
  instant, not a freeze, so every submission path (plain submit, busy-Enter
  steer, Ctrl+S, the command fallback, the `!` shell submit AND the
  per-skill slash invocations) refuses to write the old agent during
  quiesce → commit — the draft or the skill invocation line is restored
  and the user is told a session transition is in progress.
  The open-lock holder is multi-slot (`src/open-locks.ts`): a switch
  acquires the TARGET while still holding the OLD lock, and the old lock
  is released only inside the synchronous COMMIT — a refused or failed
  switch leaves the current session live WITH its lock (the old
  release-first order opened a vacuum window where another process could
  take the old session mid-switch, and a failed re-acquire then left two
  processes holding one session).
  Failures happen only BEFORE the create: a stale rewind selection
  never creates a child at all, and a failed quiesce/flush/create leaves
  the current session untouched. `/new` and `/fork` dispose nothing "on
  failure" anymore — there is nothing to dispose, because nothing was
  published. The fork cwd is captured from the source session before the
  first await (parent=A cwd=B mixes are impossible).
- **The double-Esc rewind chord is now truly consecutive.** Any real key
  press between the two Esc presses disarms the window — `Esc → Left →
  Esc` no longer opens the rewind picker (Kitty release/repeat events
  still never count as presses).

- **Fullscreen drag selection and `/copy` no longer fake a successful
  copy.** A bare OSC 52 write silently left the system clipboard
  untouched under tmux (`set-clipboard external`), SSH chains without
  passthrough, and terminals that restrict OSC 52 (VTE, Terminal.app) —
  while the UI flashed `Copied!`. Both paths now share one clipboard
  policy: `tmux load-buffer -w -` when inside tmux, then the platform
  helper (`pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`), then a
  TTY-gated OSC 52 best-effort fallback (inside tmux the sequence rides a
  DCS passthrough). Failures report `Copy failed` / `failed to copy last
  assistant message` instead of a false success.
- **The `Press Ctrl+C again to exit` hint now lives in the footer for
  exactly the exit window.** The old transcript notify lingered ~8s while
  the 1500ms exit window was already dead, advertising an actionable
  state that no longer existed. The hint now shares one timer with the
  exit window — it appears on the first Ctrl+C (even with text in the
  editor, and in the compact footer preset) and disappears the moment
  the window expires or the app exits.
- **A settled background job card keeps its command.** The expanded tool
  card for a finished background bash/pwsh now shows `$ command` above
  `started background job …` — the call and its result are two stages,
  never substitutes.
- **`@dir` completion no longer depends on a trailing slash.** fd's plain
  output does not guarantee a trailing `/` on directories, so `@src<Tab>`
  could complete to a file-style value with a trailing space and the next
  Tab could never descend into `src/`. Directory type is now resolved
  from the filesystem (symlinks included), so `@src<Tab>` → `@src/` and
  Tab keeps descending.
- **The packed SDK declarations no longer leak internals.** The
  compaction-settle test seam (`settleCompactionSurface`) took the full
  `TuiApp` class, which dragged the whole surface implementation — the
  renderer/editor registries, presentation and transcript internals,
  image modules and vendored pi-tui types — into the published `.d.mts`
  files, tripping the tarball declaration-leak gate. The seam now takes a
  minimal structural surface (the three phase/busy/working setters), so
  `dist/` declarations stay limited to the public runner surface.

## [0.3.2] - 2026-08-22

### Added

- **User input renders as a brand-blue bubble; the input box carries a
  matching `❯` prompt.** The user's own words in the transcript now paint
  the whole row with the role bubble background (dsh-web
  `--dsw-specific-bubble` parity — `#2C2C2F` dark / `#E4EDFD` light) and
  lead it with a DeepSeek brand-blue `❯` (`#679EFE` dark / `#4177E6`
  light) instead of kimi's amber, so real user input reads as a floating
  block and never blends into tool cards, context rows or thinking. The
  queue pane and the editor prompt use the same brand-blue `❯`: one marker
  for the user's own input everywhere. The bubble background is an
  optional palette token (`roleUserBg`) custom themes can override.
- **`/image <path>` completes paths.** Typing an argument after `/image`
  now suggests files and directories of the session workspace as you type,
  Tab completes them (including an empty argument, which previously did
  nothing), and Tab-accepting a directory immediately lists its children —
  the same directory-walk UX the `@` mention and `!` shell lines already
  had. `~`, absolute and relative forms are all supported; the completion
  rides the fork's own `getArgumentCompletions` extension point, so no
  vendored code changed.
- **Mixed image messages keep an inline `🖼️` placeholder in their text —
  the transcript bubble included.** A user message like `check [image] done`
  now reads `check 🖼️ shot.png done` in the bubble itself (with the
  thumbnails following as attachment rows), never as text-only with the
  picture silently moved to its own row: the transcript search can find it
  by image name, and hosts without image rendering still show where the
  image was. A marker boundary always carries one separating space, so a
  draft without a space before the placeholder never glues the marker to
  the text.
- **Fullscreen: click an attachment to collapse the picture back to its
  info bar, click again to expand.** On image-capable terminals every
  thumbnail now leads with a CONSTANT identity line
  (`🖼️ shot.png · 1490×1284 · 392.2 KiB`) — you always know which image
  it is — and the picture itself renders below it. A click on the
  attachment (info bar or image) collapses just that image's rows; a
  second click expands them again. Every attachment OCCURRENCE collapses
  independently — the same image attached twice in one transcript folds
  per position, never together — the toggle is session-scoped (a session
  switch re-expands), and collapsing a kitty image erases its tile through
  the fork's existing diff machinery — no vendored code changed. Regular
  (non-fullscreen) mode stays mouse-free by design.

### Fixed

- **Injected context rows never leak their XML envelopes when expanded.**
  Loading a skill (the TUI fallback or the host's dsh-tool-skill listener)
  injects the model-facing `<skill_content>` body as a context row, and the
  skill catalog and workspace instructions carry `<system-reminder>` frames
  of their own; expanding such a row (Ctrl+O) used to dump the raw envelope
  into the transcript. Expanded context rows now render the parsed content —
  the skill instructions body, and catalog/workspace text with the wrapper
  and `<available_skills>` marker lines stripped — while the model-facing
  bytes stay untouched, and a malformed skill envelope renders no body at
  all. Folded skill rows gain the `— N lines of instructions` suffix (the
  same one tool cards show), so the fold still says what the model
  received.
- **The image summary marker is `🖼️` (with U+FE0F), so emoji fonts no
  longer overlap the filename.** The marker measures ONE cell in the
  width math while emoji fonts render it TWO wide — the glyph overhang ate
  the space and collided with the name (font-dependent). The variation
  selector forces the 2-cell rendering the measurement expects; the space
  after the emoji stays, in the transcript thumbnail fallback, the queue
  preview and the markdown export alike.
- **Write cards fold their verb, never the raw XML envelope.** The write
  tool's result is an XML confirmation envelope (`<path>…</path> <type>
  …</type> <content>Updated file</content>`); the folded row now shows
  `— Created` / `— Updated` the way read cards show their line summary,
  and the no-presenter fallback renders the verb + path line — the raw
  envelope never leaks into the transcript.
- **Skill and read_image cards fold their envelope content too.** The
  skill tool's `<skill_content>` instruction block and read_image's
  `<path>/<type>image/<content>` envelope never appear in the transcript:
  folded rows show `— N lines of instructions` and the image summary,
  expanded cards render the instruction body (+ decoded skill name) and
  the image summary + path, and image payload blocks render as `[image]`
  instead of dumping base64. A defensive backstop
  (`XML_ENVELOPE_RESULT_TOOLS`) keeps any future envelope tool from
  leaking raw XML tags into folded previews, and malformed envelopes on
  successful calls render nothing instead of the raw text.

## [0.3.1] - 2026-08-21

### Changed

- **A startup gate explains an unsupported harness.** Running on a DeepSeek
  Harness older than `dsh-v0.1.1-rc.1` now prints an actionable message
  (the detected version, the minimum version, and the upgrade command)
  before the loader's own failure — instead of a raw
  `ERR_MODULE_NOT_FOUND` stack for the authorization row the profile
  mounts, which the old harness cannot resolve. The message is generated
  from a declarative compatibility table (`HARNESS_COMPAT`): future
  version constraints are added as table entries, each with its own
  incompatible range, the release line that first imposed it, and its
  guidance.
- **The `/login` surface separates the two credential planes in its
  copy.** Picker groups prefix API-key targets with the `API key ·`
  category (provider sign-in targets keep their own group), the command
  description leads with both verbs ("Sign in with a provider or set an
  API key"), the key-entry question asks you to "Enter" the key, and
  success/logout copy names the plane ("API key X set" / "API key X
  cleared").

## [0.3.0] - 2026-08-21

### Changed

- **Minimum compatible DeepSeek Harness is now `dsh-v0.1.1-rc.1` or later on
  the same compat line** — this release no longer supports `dsh-v0.1.0-rc.8`
  (the split credential events, the dual credential planes and the
  `ctx.authorization` seam it consumes do not exist there).

### Added

- **Provider-native sign-in through the dsh authorization seam.** `/login`
  now understands the two credential planes of DeepSeek Harness
  `dsh-v0.1.1-rc.1`: a route whose profile explicitly names `apiKeyEnv`
  keeps the classic API-key path (even when the same route has a provider
  login flow), while a keyless route with a flow signs in provider-natively
  — OAuth / device-code / interactive API key. Notices (the page to open,
  the device code) stay visible in a durable panel, text/select prompts use
  the existing question and picker surfaces, and **secret prompts render
  masked** (the value stays in the input's memory, stays masked on the
  review page, and never reaches history, logs, the transcript or
  `/status`). A successful sign-in for an unconfigured catalog route
  records a minimal keyless provider profile (never `apiKeyEnv`, so the
  runtime keeps reading the credential record); hand-declared routes still
  go through the add-provider wizard.
- **`/logout` clears both credential planes.** A named-key route unsets
  the reference as before; a keyless route deletes the stored credential
  record and says "signed out locally" — it never claims server-side
  OAuth revocation. The no-argument `/logout` now opens a picker over the
  stored records plus the configured references (presence and kind only;
  secret values never leave the credentials service).

### Changed

- **Compatible with DeepSeek Harness `dsh-v0.1.1-rc.1`.** Every
  `@deepseek-ai/dsh-*` peer and dev range moved from `^0.1.0-rc.8` to
  `^0.1.1-rc.1`, and `@deepseek-ai/dsh-authorization` joined the peer set.
  The old `credentials/updated` event no longer exists upstream; the
  surface now follows `credentials/reference-updated` and
  `credentials/record-updated` (both refresh the footer model row and the
  welcome card).
- **The TUI profile mounts the authorization seam itself.** No dsh bundle
  ships `ctx.authorization`, so `cordis.patch.yml` inserts the service row
  and the runner injects it — llm-pi-ai's provider login flows register
  once it is up.
- The `/login` API-key question and authorization secret prompts are
  masked by default.
- **The header version badge shows the dsh version first, then the TUI
  bundle version under the `tui-` label** — `[dsh-0.1.1-rc.1 ·
  tui-v0.3.0]` — degrading to `[tui-vX.Y.Z]` alone when the installed
  dsh launcher's version cannot be resolved.

### Security

- Authorization secrets are never printed, logged, put in input history,
  written to the session transcript, or shown in `/status`; notice and
  error paths never echo token material.

## [0.2.2] - 2026-08-21

### Added

- **Merged task browser as the single background surface.** `/tasks` now
  opens one searchable list over jobs AND subagents (type to filter by
  kind/label/status — `subagent`, `bash`, `failed`…); `Enter` opens the
  detail (child transcript for a subagent, status viewer for a job) and
  `i` interrupts the selected subagent. `/subagents` became an alias of
  `/tasks`, and the old per-row submenu panel (and its ghost-overlay trap)
  is gone. The ↓/Ctrl+J empty-editor trigger opens the same browser.
- **Alias registration for TUI commands (kimi parity).** `/quit`, `/resume`,
  `/rename` and `/subagents` are aliases of `/exit`, `/sessions`, `/title`
  and `/tasks` — registered with the host commands service, so dispatch,
  the completion catalog (typing `resume` completes `/resume`) and the
  busy-Enter gate all see them, while the command surface lists one
  logical command.
- **Subagent-family tool cards show their model.** A card for
  `subagent`/`subagent_route`/`subagent_router`/`subagent_fork` renders a
  `model · provider` line when the call args carry an explicit override
  (top-level or `agentOptions`); without one, nothing changes (the official
  subagent tool's model lives in config and never renders).
- **`!` / `!!` shell lines complete like a real shell.** Command names come
  from a `compgen -A command` bridge (cached per working directory + PATH
  for 30s), `$VAR` names complete after `$`, and `git` subcommands list
  live with a static fallback for git < 2.18; `!<Tab>` lists the cached
  commands. Paths still complete through the existing fd provider. Design:
  `docs/input-and-card-polish.md` §1.
- **Local shell sandbox preference.** `/settings` → Local shell sandbox:
  user-typed `!`/`!!` commands now run outside the dsh sandbox by default
  (bypass — pi/kimi parity: the sandbox guards the model's autonomous
  commands, not the user's own), with an opt-in `sandbox` mode that
  restores the policy path. §2.
- **Question cards show their answers.** The folded `ask_user_question`
  card previews `N/M answered` (never the raw answers JSON), and the
  expanded card lists every answer (`● id → answer`, skipped questions
  dimmed). §3.
- **Goal cards are readable.** `get_goal`/`create_goal`/`update_goal`
  cards carry named headers (Read/Create/Update Goal), a folded summary
  (`phase active · revision 3 · 2/6 rounds`, `no goal set`) and expanded
  field lines — never the raw goal JSON. §4.
- **Folded previews never leak JSON for schedule, cordis-inspect and
  ralph.** The result-preview row shows a parsed summary (`1 scheduled`,
  `mode plugins`, ralph's friendly first line) or nothing at all — the
  expanded body stays verbatim, aligning with the web. §6.
- **Fullscreen todo dock click.** Clicking the `☑` summary row opens the
  todo panel; clicking the panel cycles compact → full list → back to the
  summary, so the mouse opens and closes the panel without Ctrl+T. The
  task browser's hint row now advertises `i interrupt` while a subagent row
  is selectable.

### Changed

- **Queue pane notice classification (web parity).** Only user-origin
  messages render as steerable `❯` rows; subagent-report relays, injected
  instructions, goal messages and plugin notices render as `⏳` notice
  rows. Notice rows fold beyond five into one `+N more notices pending`
  line (user rows never fold), and claimed notices disappear once the
  agent has received them — no more backlog flood from settled children.
- **Todo panel fullscreen click.** In fullscreen, clicking the todo panel
  expands it to the full list and back (geometry clamped on tiny
  terminals); Ctrl+T still toggles the panel itself.
- **Ctrl+J is no longer a host keybinding.** Legacy terminals send Ctrl+J
  as LF (the editor's Enter), so the task-browser chord was unreliable;
  the browser is reached via ↓ (empty editor) and `/tasks`, and a plugin
  may now bind Ctrl+J itself.
- **`!` / `!!` run in the session workspace.** Shell commands execute in
  the live session's cwd (pi parity) instead of the launch directory, so
  completion and execution agree after a session switch.
- **User-typed `!`/`!!` commands bypass the dsh sandbox by default.** The
  sandbox preference defaults to `bypass` (see the new settings row above);
  set it to `sandbox` to route user commands through the dsh shell
  capability's policy again.

### Removed

- **`/queue` command removed outright.** The per-item management panel
  and its compatibility stub are gone — the queue pane above the editor
  is the single queue surface (`Ctrl+S` steers all, `Alt+↑` pulls queued
  messages back to edit). The name is released from the host-owned
  command catalog: typing `/queue` now steers to the model like any
  unknown `/line`, and a plugin may claim the name from the next release.

### Fixed

- **Alt+↑ dequeue only pulls the user's own messages back.** The filter
  previously matched `source.form === 'notice'`, so subagent-report
  relays, injected instructions and goal messages could land in the
  editor draft as editable user text; the pane classification
  (`isUserQueueInput`) now drives both the pane and the dequeue.
- **The double-Ctrl+C exit chord is now visible and forgiving.** The first
  Ctrl+C on an empty editor silently armed a 500ms exit window with no
  feedback, so a human-paced "double press" (often 0.6–1s apart) silently
  re-armed and never exited — the next Enter then sent an empty draft,
  looking exactly like the chord had broken. The window is now 1.5s and
  the first press shows `Press Ctrl+C again to exit`, so the armed state
  is discoverable and a natural double press exits.
- **Ctrl+C clearing the editor now repaints immediately.** The pi-parity
  first-press clear emptied the draft in memory but never scheduled a new
  frame — the key is consumed at the app level, so the fork's input path
  never reaches the focused editor and its render never fires. In a real
  terminal the old text stayed visible until the next keypress, making the
  clear look dead (and a hasty second Ctrl+C would then exit, per the
  clear-then-exit chord). The Ctrl+S steer and Ctrl+Enter queue chords
  received the same explicit repaint for their draft clears.
- **Folded cards never leak raw JSON.** The `ask_user_question` and goal
  cards now drop the folded result-preview row entirely when the result
  cannot be parsed into a safe summary (and never show a success summary
  for a failed call); schedule, cordis-inspect and ralph previews follow
  the same rule.
- **Question answer counts always match the rendered lines.** A malformed
  answer entry now invalidates the whole set (web `every-isAnswer`
  parity) instead of being counted but not rendered.
- **Failed completion runs are never cached.** A timed-out, aborted or
  failing `compgen` run no longer suppresses `!` completion for the whole
  cache TTL — the next keystroke retries the shell.
- **An opted-in sandbox that the composition cannot provide is surfaced.**
  With the Local shell sandbox preference set to `sandbox` but no shell
  capability in the composition, every `!` run notifies that the command
  executes unsandboxed instead of downgrading silently.
- **Every click while a question is up stays captured.** Clicks outside
  the question frame (including stale geometry after a width resize) no
  longer fall through to the todo panel or transcript expansion behind
  the modal.

## [0.2.1] - 2026-08-21

### Changed

- **The repository root is now the published package.** The
  `@xmoon76/dsh-pi-tui` package root moved from `packages/dsh-pi-tui/` up
  to the repository root; `packages/pi-tui` (the private vendored fork,
  still bundled into `dist/` at build time) is now the only child
  workspace package. There is no behavior change for npm consumers — the
  full 0.2.0 contract is preserved: all eight public exports (including
  `./extensions`, `./extensions/advanced`, `./extensions/unstable` and
  `./builtins`), the six tsdown entries, the seven postpack smokes, and
  the CI exact-artifact publish chain (Node 22/24/26 tarball smoke and
  the vim-plugin-smoke stay publish gates). Source installs now use
  `@file:$PWD` / `@link:$PWD` instead of `@file:$PWD/packages/dsh-pi-tui`,
  and the Chinese README ships with the package.

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

[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/v0.3.2...HEAD
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
