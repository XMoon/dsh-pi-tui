# dsh-pi-tui

English | [简体中文](README.zh-CN.md)

Release history: [CHANGELOG.md](CHANGELOG.md) · [简体中文更新日志](CHANGELOG.zh-CN.md)

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

Run `dsh --profile pi-tui` for a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`).

> **Status: working.** The TUI covers the main session loop — input → session events,
> approvals, commands, session switching and full-text search — plus presets, skills,
> model/settings menus, and slash commands. Rendering and input routing are verified
> by headless tests (`@xterm/headless`) with no TTY or model connection needed.

## Screenshot

![dsh-pi-tui running in a terminal](https://raw.githubusercontent.com/XMoon/dsh-pi-tui/main/docs/dsh-pi-tui.png)

## Layout

The full repository layout lives in [AGENTS.md](AGENTS.md) (the contributor
operating manual). In one line: the **repository root is the published
`@xmoon76/dsh-pi-tui` bundle** (the only published package — its manifest
declares `dsh.bundle.patch` and the `exports` point at the built `dist/`),
and `packages/pi-tui/` is the vendored `@moonshot-ai/pi-tui` fork (rescoped
to `@xmoon76/pi-tui`, private, never published — its divergence ledger lives
in `packages/pi-tui/AGENTS.md`), bundled into the root package's build
output.

## Prerequisites

- A DeepSeek Harness installation with profiles support (`dsh` on your `PATH`).
- Node >= 22.19 (`^22.19.0 || >=24`, same range as dsh). Running from source
  needs Node with native TypeScript support (>= 23.6) or the tsx ESM hook
  (`node --import tsx/esm`, how dsh's own source launch works).
- [pnpm](https://pnpm.io) only when installing from source.

## Install

`dsh plugin` runs pnpm inside the target profile's directory, so the usual
pnpm verbs (`add`, `remove`, `update`, `list`) all work.

### Option A — from the npm registry (recommended)

The published package is self-contained: the vendored pi-tui fork is bundled
into its build output, so `@xmoon76/dsh-pi-tui` is the only package you install
(`@xmoon76/pi-tui` stays private in this repo, like kimi-code keeps
`@moonshot-ai/pi-tui` private):

```sh
# install the bundle into the pi-tui profile (creates the profile if needed)
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui

# run it
dsh --profile pi-tui
```

Any dependency whose manifest declares `dsh.bundle` joins the profile's layer
stack automatically — no manual `cordis.patch.yml` wiring.

### Option B — from source

Build artifacts are not committed (`dist/` for both packages is gitignored and
the package `exports` point at the built files), so build before installing
from a clone:

```sh
git clone https://github.com/XMoon/dsh-pi-tui
cd dsh-pi-tui
pnpm install
pnpm build        # pi-tui tsdown (packages/pi-tui/dist/) + root tsdown (dist/, bundles pi-tui)

# file: — the bundle is copied into the profile at add time; rebuild + re-add
# to refresh (see "Update / uninstall" below)
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD

# link: — a live symlink instead; `pnpm build` output is picked up directly
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@link:$PWD
```

### Verify the install

```sh
dsh plugin --profile pi-tui -- list          # @xmoon76/dsh-pi-tui present
dsh --profile pi-tui                         # TUI starts instead of the web GUI
```

### Update / uninstall

```sh
# registry installs:
dsh plugin --profile pi-tui -- update @xmoon76/dsh-pi-tui
# file: source installs copy at add time — rebuild + re-add to refresh
# (link: installs track the repo live and need only `pnpm build`):
pnpm build && dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD

dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

## Development

```sh
pnpm install
pnpm build        # pi-tui tsdown (packages/pi-tui/dist/) + root tsdown (dist/, bundles pi-tui)
pnpm test         # pi-tui's own suite (node --test) + dsh-pi-tui headless tests
pnpm typecheck
node --expose-gc scripts/bench.mts   # performance baseline (optional)
```

Tests drive the UI through `@xterm/headless` (see `test/virtual-terminal.ts`),
so rendering and input routing are verified without a TTY or a model connection.

### Development history (dogfooding)

This project started development on the browser surface (`dsh --profile web`) and
switched to building itself with itself: since August 15 2026, all fixes and
features are developed inside this TUI, the same way this README and the
codebase are maintained. The dev loop runs on a dedicated `pi-tui-dev` profile
installed with Option B's `link:` specifier
(`dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD`)
— a live symlink, so `pnpm build` is picked up without re-adding — while the
`pi-tui` profile stays on the published registry package for real use.

## Extensions (early, stabilizing)

Since `0.2.0` the bundle ships a small, versioned extension surface so a
third-party Cordis plugin can contribute chrome without touching the TUI
internals. It is **early and stabilizing**: the capabilities below are the
current set; the API version (`1`) is bumped only on breaking changes, and
plugins must **feature-detect** capabilities instead of parsing the package
version.

All extension plugins remain standard DeepSeek Harness / Cordis plugins using
`name`, `inject`, and `apply(ctx)` against the single `piTuiExtensions`
service; the tiers are capability facades over that one service, not separate
plugin systems or runtimes.

The extension surface ships three tiers: a plugin imports ONLY the
public entry — never the stable entry's internals (`TuiApp`,
`TuiMainScreen`, `TuiAltScreen`) nor repository-relative paths.

| Tier | Entry | Contract |
|---|---|---|
| Stable | `@xmoon76/dsh-pi-tui/extensions` | compatibility-oriented; additive-first; existing semantics never silently change; removal requires a planned breaking change |
| Advanced | `@xmoon76/dsh-pi-tui/extensions/advanced` | experimental; minor releases may break; a migration note is required; no long-term shims |
| Unstable | `@xmoon76/dsh-pi-tui/extensions/unstable` | NO compatibility guarantee; implementation may change anytime |

All tiers reuse the SAME shared extension runtime: caller-fiber ownership,
surface lifecycle, invalidation, capability discovery. Do not fork a second
ownership/lifecycle model per tier. The tiers have grown since Phase 1:

- **Advanced** (`ADVANCED_API_LEVEL = 1`, Phase 2 + Phase 4): normalized
  input capture, focused interactive surfaces (interactive managed
  overlays), advanced editor control, the imperative UI broker
  (select/confirm/input/notify), custom interactive UI and the host-state
  facade (theme/title/working/tools-expanded) — still Host-mediated,
  never raw terminal bytes. Author guide: `docs/extension-advanced.md`;
  Pi capability reference: `docs/extension-capability-matrix.md`.
- **Unstable** (`UNSTABLE_API_LEVEL = 1`, Phase 3): raw input
  interception (observe/consume/rewrite, exclusive raw ownership), the
  Host emergency fail-safe (triple-Esc), and a selected low-level surface
  seam — NO compatibility guarantee; a broken plugin can disrupt Host
  behavior. Author guide: `docs/extension-unstable.md`.
- **Real-plugin validation (Phase 5):** the tier selection is proven by
  real consumers in `examples/plugins/` — a
  production-class vim modal editor (Advanced editor SDK), a
  questionnaire form (Advanced imperative UI broker) and an interactive
  shell (Unstable raw seam). The "which tier should I use?" decision
  tree: `docs/plugin-authoring.md`.

A plugin imports only the public entry:

```ts
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'my-plugin'
export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService
  if (!service.api().capabilities.has('slot.chrome.header.badge')) return
  service.register<{ text: string; tone?: 'info' | 'warning' | 'error' | 'success' }>(
    'chrome.header.badge',
    { id: 'my-badge', order: 100, description: 'A header badge from my plugin.' },
    { text: 'my-badge', tone: 'info' },
  )
}
```

Current extension points (v1):

| Slot | Semantics | Contribution |
|---|---|---|
| `chrome.header.badge` | list | a short `[badge]` after the host title |
| `input.dock.item` | list | a dock line above the todo panel |
| `chrome.footer.status` | list | a footer segment (host owns width/truncation) |
| `input.widget.above` / `input.widget.below` | list | a bounded widget around the editor (M4 component kit) |

Contributions are **plain data**, not render functions: a plugin supplies
`HeaderBadge` / `DockItem` / `FooterSegment` / `InputWidget` values (text +
semantic tone spans, or a structured `ExtensionView` tree for widgets) and
the host owns rendering, ANSI compilation, width budgets and truncation.
There is deliberately no `render(context)` callback in v1 — plugins never
hold a rendering context, so a contribution can never capture or mutate
host internals.

Since `0.2.0` the widget slots (`input.widget.above` / `input.widget.below`)
accept a bounded component kit: `ExtensionView` is a structured view tree
(`text` / `markdown` / `spacer` / `stack` / `frame` / `rows` views with
semantic style tokens) that the host compiles into private components. A
plugin can add helper rows above or below the editor — for example a status
widget or a quick-reference line — without touching the root layout, the
editor, or focus. The host owns the row budgets: under height pressure the
lowest-importance widgets collapse first, and the editor always survives.

```ts
service.register<InputWidget>('input.widget.below', {
  id: 'my-widget',
  order: 100,
}, {
  view: {
    kind: 'text',
    spans: [{ text: 'my-plugin ready', tone: 'success' }],
  },
})
```

Since M5 the extension surface also covers registries (plan §10):

- `registerCommand(contribution)` — slash-command OWNERSHIP metadata
  (`execution: 'local' | 'submission'`): a plugin-declared local command
  always executes directly (never steered by the busy-Enter preference);
  a submission command flows through the session policy. Actual execution
  stays in the host's commands service; `/name args...` keeps
  `rawInput` verbatim. Name conflicts are reported, never guessed.
- `registerTheme(contribution)` — a named semantic palette selectable
  from the /settings theme picker; the owner's unload falls back to the
  built-in palette (a selected plugin theme never dangles).
- `registerSetting(contribution)` — a settings row appended to the
  /settings panel (label + current value + choices + optional rejection);
  the host owns the panel.
- `registerAutocomplete(contribution)` — an autocomplete provider
  consulted after the host's own provider returns null (deterministic
  order, per-provider isolation, latest-only commit).
- `registerKeybinding(contribution)` — normalized-key → semantic-action
  binding, routed by the host's InputRouter (M6). A plugin declares a key
  with the public `NormalizedKey` shape (key + ctrl/alt/shift/super) and
  a semantic action from the host's list (`submit-draft`, `queue-draft`,
  `steer-draft`, `cancel-activity`, `open-search`, `toggle-fullscreen`,
  `cycle-permission`). The host normalizes ALL terminal input (Kitty
  CSI-u, modifyOtherKeys, legacy sequences) — a plugin never sees raw
  escape data. Reserved host lifecycle keys (Ctrl+C/D/S/F/O/T/G/J,
  Ctrl+Enter, Enter, Esc) cannot be claimed; plain printable keys never
  fire a binding (typing always wins); bindings are non-capturing and
  fire LAST in the precedence ladder (after questions, approvals,
  overlays and the editor). The action executes through the host's own
  paths — submission/session safety is never bypassed.
- `registerMessageRenderer(contribution)` — a TRANSCRIPT message renderer
  (M7, chain slot): receives a semantic `MessagePresentationSnapshot`
  (immutable; never the mutable message or the container) and returns an
  `ExtensionView` or `undefined` (abdicate → the next renderer → the host
  fallback). Kind-scoped renderers apply to one message kind.
- `registerToolRenderer(contribution)` — a TOOL card renderer (M7, keyed
  slot): presents the card for ONE tool name from a
  `ToolPresentationSnapshot` (callId, toolName, status, arguments,
  result, expanded); the winner (lowest priority) abdicates to the next
  renderer, then the host fallback. A priority tie on the same tool name
  is an explicit error.
  Renderers never stall the transcript: a throwing renderer is isolated
  and the chain continues, and the message cache embeds the renderer
  identity + registry revision, so an HMR/unload rebuilds exactly the
  affected components.
- `showOverlay(view, options)` — a MANAGED overlay lease (M8): the plugin
  supplies an `ExtensionView` + sizing hints; the host mounts it through
  its overlay broker (modal stacking, focus, fullscreen migration). The
  returned lease is generation-scoped (the surface's final dispose closes
  every still-owned lease), close() is idempotent, and hide()/show()
  toggle visibility without closing. A plugin can never mount a raw
  component or steal focus — the host owns the terminal and the overlay
  stack.
The [extension API v1 author guide](docs/extension-api.md) records the
import rules, the full surface table, the lifecycle/render contracts, the
M11 deprecation policy and the stability contract.

The M10 acceptance fixture (plan §15): the repo ships a vim-mode fixture
(`test/fixtures/vim-plugin/`) that validates the editor-extension seam — the
packed public SDK is consumable by a third-party Cordis plugin, its
replacement editor receives SEMANTIC `EditorInputEvent`s (never raw terminal
bytes), and editor `create()`/`dispose()` work — importing ONLY
`@xmoon76/dsh-pi-tui/extensions`. It is NOT a production Vim and NOT a
Stable-API completeness proof: modal-mode behavior (insert/normal) is not
part of the Stable contract, and the other public surfaces (commands,
themes, settings, autocomplete, keybindings, renderers, overlays, widgets)
have their own dedicated tests. Its CI gate forbids `@xmoon76/pi-tui`,
`src/tui-app` and repository-relative internal paths: if a STABLE plugin
ever needs a private import, the SDK is missing a capability (there is no
`unsafeGetTuiApp()` escape hatch).

- `registerEditor(contribution)` — the EDITOR SDK (M9, plan §14):
  single-winner by priority (a tie is an explicit error); the winner
  occupies the editor seat through the host's ATOMIC handoff (create →
  transfer draft/cursor → mount → focus → dispose old). A creation throw
  keeps the current editor working; winner unload restores the next
  winner / the host default editor WITH the draft preserved. The plugin
  editor receives an `EditorHost` (surfaceId, generation, getSnapshot,
  replaceText, dispatch of semantic actions submit/queue-submit/steer/
  open-external-editor, subscribe, invalidate) — but the host still owns
  busy-Enter, Ctrl+Enter, local-command classification, paste protection,
  approval/question capture, session guard/lock, external editor and
  exit: a plugin editor can never bypass those.

Lifecycle is host-owned: registrations are disposed when the plugin's Cordis
fiber unloads (HMR, disable), regular and fullscreen both refresh, and
`handle.invalidate()/replace()` re-render through the active screen. The
`@xmoon76/dsh-pi-tui/builtins` entry is the Loader-only first-party
contributor (version badge, turn/step counters, todo-summary dock item) —
not a stable third-party SDK. Raw terminal access, pre-host input
interception and full input ownership are NOT part of the Stable tier (see
the Advanced/Unstable roadmap).

## Slash commands (selection)

- `/sessions [query]` — open the session picker: search-as-you-type over
  session ids, titles, and workspaces, rows grouped by workspace with live
  `filtered/total` counts, and titles loaded in the background as they are
  read. Enter switches to the selected session.
- `/search <query>` — full-text search over persisted session logs, then
  switch to a hit.
- `/title [title]` — with an argument, set the current session's title
  (pins it against automatic generation; titles appear in the `/sessions`
  picker); **without an argument, regenerate the title from the
  conversation — this overwrites the current title, including one you
  pinned earlier** (`/rename` is an alias).
- `/tasks` — the merged task browser: background jobs AND subagents in one
  searchable list (type to filter rows by kind/label/status — `subagent`,
  `bash`, `failed`…). `Enter` opens the detail (child transcript for a
  subagent, status viewer for a job), `i` interrupts the selected subagent.
  `/subagents` is an alias.
- `/yolo` — switch to `danger-full-access` (alias of `/permission danger-full-access`).
- `/status` — show the current session's stats and identity (turn counts,
  token usage, workspace, installed dsh version).
- `/preset`, `/model`, `/settings`, `/export`, `/fork` — see
  `dsh --profile pi-tui`'s command autocomplete (`/` + Tab).

## Keybindings (selection)

- `Ctrl+F` — toggle transcript search (the `/search <query>` overlay; a
  second press closes it).
- `Shift+Tab` — cycle the permission preset (read-only → workspace-write →
  danger-full-access); the footer's mode slot badges every preset
  (`[workspace-write]` / `[read-only]` / `[custom]`, with `[yolo]` flagging
  the no-approval mode).
- `Ctrl+S` — steer: with queued messages, sends the whole queue (plus the
  draft, if any) into the running turn at once; otherwise sends the draft
  alone. An idle agent starts a fresh turn with everything.
- `Alt+↑` — dequeue: pull every queued message back into the editor draft.
- `Ctrl+T` — toggle the full todo list (in fullscreen, clicking the panel
  expands it to the full list and back); the dock above the editor always
  shows the todo summary and background tasks, and queued input renders
  between them.
- `@` — file/folder mentions in the editor: `@` + Tab completes files from the
  whole workspace (fd-backed when `fd` is on PATH, with a built-in recursive
  fallback otherwise). The literal `@path` is submitted and the model reads
  the file itself. With background work running, an empty editor's `↓` opens
  the same merged task browser as `/tasks`:
  - **subagent rows** (live continuable children) — `Enter` opens the child's
    transcript read-only (`Esc` returns); `i` interrupts the selected child.
    They never register jobs records, so this browser is their only glanceable
    home.
  - **job rows** (bash and one-shot subagent jobs) — `Enter` shows the status
    viewer only: a bash job's output read cursor belongs to the model's
    `job_output`, and a one-shot subagent job record carries no child session
    id, so a subagent job's transcript is reached through `/tasks` by picking
    the child by its label.
  The footer badge shows `[N tasks running · M agents · ↓ view]` while any
  background work is live. The queue pane above the editor shows pending
  input: user messages as `❯` rows, everything else (job notices, subagent
  reports, injected instructions) as `⏳` notices that fold into a
  `+N more` line beyond five — and disappear once the agent has received
  them.

## Launch options

The TUI's startup row adds `--preset <id>` — the agent preset a fresh
session starts on (falls back to `$DSH_PI_TUI_PRESET`, then the saved
settings default). It exists because `/preset` only applies to a blank (not
yet created) session, so launch-time selection is the other half of choosing
a preset. All other flags are the dsh runner's own (`--session <id>`, …).

## Session lifecycle

Opening the TUI with no `--session` creates **no session at all**: the first
user message (text, slash command, `Ctrl+S` steer, or `!` shell) starts it
lazily. `--session <id>` still resumes immediately, and a local `!!` command
runs without needing a session.

## Verified in the P0 spike

- Vendored pi-tui: the fork's own suite passes under `node --test` (run it as
  the sync gate after every re-vendor; the count is deliberately not copied here —
  `packages/pi-tui/package.json` is the single source of version facts).
- `TuiApp` renders, accepts editor input, and handles Ctrl+C on a headless xterm.
- The whole import chain (pi-tui, tui-app, `@deepseek-ai/dsh-cmdline`, commander)
  loads under the tsx ESM hook — the dsh source-launch contract.
- Native modifier-key addons are optional: on Linux the loader returns `undefined`
  without attempting a load, and the non-TTY stdin path is guarded.

## Diagnostic log

The TUI writes its own diagnostics to stderr and a log file (`ctx.logger` is
invisible in this process — no exporter):

- Default file: `$DSH_HOME/logs/pi-tui-<pid>.log` (default `~/.dsh/logs/`);
- Line format: `[tui] <ISO time> <level> <message> k=v ...`;
- Default level `info`: key lifecycle events only (boot/resume/switch/exit,
  divergence-guard warnings, errors); `debug` additionally logs every guard
  check before a send.

Configuration (environment variables):

| Variable | Meaning | Default |
|---|---|---|
| `DSH_PI_TUI_LOG` | Log file path; `off` disables file logging | `$DSH_HOME/logs/pi-tui-<pid>.log` |
| `DSH_PI_TUI_LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |

Troubleshooting example:

```sh
DSH_PI_TUI_LOG_LEVEL=debug dsh --profile pi-tui
tail -f ~/.dsh/logs/pi-tui-*.log
```

## Safety & operational notes

- **One surface per session.** dsh has no cross-process session coordination:
  a session open in TWO dsh processes (TUI + web, or two TUIs) can corrupt its
  log. The TUI refuses to open a session already held by another live dsh
  process (an `owner.lock` file next to the log, with a pid/starttime probe
  for stale locks left by crashes — so the second surface is stopped at
  OPEN time, not after the damage). For writes, the TUI detects the other
  writer and blocks the send; the SAME action pressed again (Enter for a
  submit, Ctrl+S for a steer, unchanged draft) forces through — an edited
  draft, a swapped key, a new file revision, or a session switch invalidates
  the force. Never run two surfaces on one session (full contract:
  `docs/concurrency.md`).
- **Session repair.** `node_modules/@xmoon76/dsh-pi-tui/scripts/repair-session.mjs`
  repairs corrupted logs (`--scan` lists damage read-only; `--yes` applies with
  a mandatory backup). A torn (truncated) tail is truncated at the last
  complete frame and reported with exact byte accounting; references to a
  duplicated seq are never auto-resolved — the repair refuses and asks for
  `--duplicate-reference=first|last|segment`. Repaired logs are re-verified
  with the dsh reader's own layout checks before the backup is considered
  redundant. (Full repair contract, incl. the frame-layout constraint:
  `docs/repair-session.md`.)
- **Exit.** `/exit` (alias `/quit`) flushes the session with a 10s hard
  timeout: a hung provider cannot trap the TUI. If the flush fails or times
  out, the terminal prints a warning (the tail may not be persisted) and the
  process still exits.
- **Performance.** `scripts/bench.mts` (non-default) measures ingest,
  projection, cold/warm rebuilds, streaming frames, theme switches, and heap;
  the saved baseline lives in `docs/perf-baseline.md`. Unchanged transcript
  messages reuse their rendered components, so the warm per-frame rebuild
  does not grow with history.

## License

MIT. `packages/pi-tui` retains its upstream MIT license and authorship
(Copyright (c) 2025 Mario Zechner; Moonshot AI fork).
