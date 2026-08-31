# dsh-pi-tui

[简体中文](README.md) | English

[![npm](https://img.shields.io/npm/v/@xmoon76/dsh-pi-tui.svg)](https://www.npmjs.com/package/@xmoon76/dsh-pi-tui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Pi-style terminal frontend for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-pi-tui` is installed as an independent dsh bundle inside a profile. It provides terminal interaction for streaming conversations, tool calls, session management, subagents, history search, shell commands, approvals, and settings. Models, tools, Sessions, permissions, Skills, Plan, Goal, and Subagent runtime behavior are still provided by DeepSeek Harness.

```sh
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui
dsh --profile pi-tui
```

![dsh-pi-tui](docs/dsh-pi-tui.png)

## Features

### Conversation and tools

* Streaming Markdown output
* Collapsible Thinking blocks
* Tool Call cards with running / success / failure state
* Collapsible Tool / System details
* Full-text Transcript search
* Folding for long Session history
* Context, token, model, and runtime status
* Approval and `ask_user_question` dialogs
* Plan Review
* Todo / Goal status
* Human-readable terminal window titles
* Bounded long-session windows with stable paging and live-follow position
* No duplicate ghost Tool Cards after compaction / pruning

`Ctrl+O` controls Tool and System details — and in fullscreen Focus it bulk-expands the recent Thought roots or collapses them all. `Alt+T` controls Thinking separately.

### Focus Mode

`/focus` groups the current turn's Thinking, Tool Calls, and intermediate replies into a live Thought block.

The full process can still be expanded when needed. In fullscreen Focus, Thought roots can be expanded/collapsed in bulk or opened with an individual card click, and the viewport survives switches and resizes. Disabling Focus restores the normal Transcript projection. Focus only changes presentation; it does not modify Session events.

### Sessions

Supports persisted DSH Sessions, including:

* Creating and resuming Sessions
* Session switching
* Renaming
* Forking
* Rewind
* Session lineage
* Transcript export

Use:

```text
/sessions
/fork
/rewind
```

When the Agent is idle and the editor is empty, pressing `Esc` twice quickly also opens Rewind.

Rewind creates a new Child Session from a selected historical User Turn and restores that Prompt into the editor. The original Session is left unchanged.

### Input history

`Ctrl+R` opens input history search.

Three scopes are available:

* Current session
* Current directory
* All directories

History results include the Prompt, working directory, timestamp, and Session information. Selecting an entry restores it to the editor without submitting it.

Regular `↑` / `↓` history recall is still available for recent input.

### Subagents and background tasks

`/tasks` opens the task browser for the current Session.

Subagents are shown using their complete lineage, including nested descendants:

```text
main
├─ subagent A
│  └─ subagent B
└─ subagent C
```

The browser distinguishes:

* `continuable`
* `one-shot`
* running / inactive
* nested descendants
* background Jobs

Completed one-shot Subagents remain available for persisted Transcript inspection.

A direct `continuable` Child can be opened in an interactive viewer and sent follow-up messages directly. The Child has its own Transcript, Draft, and runtime state, without modifying the main Session input.

Deeper nested Subagents are read-only by default.

### Shell

The editor supports two Shell modes:

```text
! git status
```

Runs a local command and submits its output into the current Session.

```text
!! git status
```

Runs the command locally only. Its output is not added to model context.

`!` / `!!` are editor modes rather than plain text prefixes. The prompt and completion behavior switch together with the active mode.

Shell cards show a bounded output preview by default. `Ctrl+O` expands the retained output — except in fullscreen Focus, where Ctrl+O owns the Thought roots and the shell cards keep their folded state.

### File references and images

Typing `@` opens workspace file search and completion:

```text
@src/index.ts
@"path with spaces/file.ts"
```

`/image <path>` also completes files and directories; paths with spaces, quotes, or Windows separators preserve the input dialect, and directories can be expanded further.

Resolvable relative paths are canonicalized before submission.

Clipboard images can be added with `Ctrl+V` and persisted through the DSH Attachment service.

### Models and runtime settings

The TUI uses DSH model and settings services.

Common entry points:

```text
/model
/settings
/login
/permission
/plan
/goal
/compact
/footer
/statusline
```

Model selection, Reasoning Effort, permission presets, Plan, and Goal all keep the corresponding DSH runtime semantics.

The `Icon style` option in `/settings` switches the TUI's structural icons:
`Emoji` (default, colorful), `Symbols` (compact single-cell terminal
symbols), or `Minimal` (decorative icons hidden; only status/interaction
markers remain). Switching applies immediately and persists.

Slash Commands registered by other plugins through `ctx.commands` are discovered automatically.

### Footer customization

The status line is a **composable surface** — no plugin or shell needed
for the common cases.

`/settings` → Status line (or the `footer` key in the `dsh-pi-tui`
settings document) selects the preset:

| Value | Meaning |
|---|---|
| `default` (legacy `full`) | the classic two-row footer (status + stats) |
| `compact` | the status row only (stats line hidden) |
| `custom` | a versioned `footerLayout` (see below) |
| `command` | a user-configured command renders the status surface (see below) |

The first three values are selectable in the `/settings` panel; `command`
is NOT in the panel — it can only be enabled through the USER-layer
settings document (`footer: "command"` + `footerCommand`). The `/settings`
Status line row offers exactly `default / compact / custom`.

`/footer` is a hierarchical interactive configurator: pick a row first
(Row Selector), then edit that row's items — `↑/↓` walks every item of
the row in order (Left/Right are visual grouping only), `←/→` moves an
item across sides, `Space` removes it, `A` opens a searchable Add Picker
(filtered by label / id / description, with the highlighted item's
description below), `M` enters Move Mode to reorder, and `Enter` opens
the Item Editor (Style candidates previewed with the item's real render;
semantic tones; Advanced edits prefix / suffix / importance with a
one-keystroke Reset). The preview is composed by the real footer engine
and — with the contextual help — pinned to the top of the panel; it never
scrolls away at any terminal size. `S` on the Row Selector saves
(persisted); `Esc` walks back page by page and closes on the first page
without touching the active layout. With dirty changes, `Esc` first offers
Save & Exit, Discard & Exit, or Keep Editing; saving waits for the settings
write to succeed. Usable before any session exists.

The Add Picker also offers `+ Create Custom Text` for user-defined static text items. Their text, default semantic tone, display name, and deletion are editable; definitions are read and persisted only from the USER layer. The definition tone is separate from the placement Tone, and the item can otherwise be shown/hidden, moved, and reordered like any other footer item.

`footerLayout` is a nested settings object (schemaVersion 1, 1–2 rows,
left/right zones, a separator, finite formatters, semantic tones,
prefix/suffix, importance). The `/footer` configurator builds it
interactively; the YAML shape is:

```yaml
footer: custom
footerLayout:
  schemaVersion: 1
  rows:
    - left:
        - id: agent-preset
          format: compact
        - id: model
        - id: project
        - id: context
          format: full
        - id: cache-hit
        - id: token-usage
          format: io
        - id: performance
          format: speed
        - id: version
          format: tui
      right:
        - id: focus-mode
      separator:
        text: " │ "
        tone: textDim
```

Builtin format choices are finite and use the existing `format` field (no
second style schema): Model `badge` / `plain` / `compact`; Permission preset
`badge` / `plain` / `compact`; Plan state `badge` / `plain`; Working directory
`short` / `basename` / `full`; Git branch `plain` / `label`; Context `bar` /
`percent` / `full`; Token usage `io` / `total` / `compact`; Cache hit `full` /
`compact`; Performance `full` / `speed` / `latency` measures average time
to first token; Turns/steps `both` / `turns` / `steps`; Version keeps `tui` / `dsh` /
`both`. Omitting `format` continues to use each item's legacy default.

Builtin item ids: `agent-preset`, `model`, `reasoning`,
`permission-preset`, `sandbox-mode`, `approval-policy`, `plan-state`,
`focus-mode`, `focused-seat`, `view-scope`, `cwd`, `project`,
`git-branch`, `run-state`, `queue`, `tasks`, `agents`, `todo`,
`context`, `cache-hit`, `token-usage`, `performance`, `turns-steps`,
`stats-line`, `version`, `ext:*` (the legacy extension segments).
An invalid `footerLayout` warns once and falls back to the default — the
TUI always starts.

`footer: command` hands the Status Surface to a user-configured command
(Claude/Kimi style): the current status snapshot is serialized to JSON on
the command's stdin (schemaVersion 1 — no secrets, no credentials, no
prompts), and the command's stdout (sanitized: SGR colors and OSC 8
hyperlinks only) renders the status surface. The Host's instruction
surface (e.g. the Ctrl+C exit hint) always survives on top.

```yaml
footer: command
footerCommand:
  schemaVersion: 1
  command: "~/.config/dsh/statusline.sh"
  timeoutMs: 300        # default 300, max 1000
  refreshIntervalMs: 1000  # min 1000
  maxRows: 1            # 1..2
```

**Security:** the command is executed ONLY when it lives in the USER
layer of your settings document. A repository/project-supplied
`footerCommand` is never executed — command mode is disabled and the
native layout applies. The command refreshes periodically according to
`refreshIntervalMs` and renders at most two rows; failures (empty output,
non-zero exit, timeout) fall back to the native layout automatically.

### Extension footer items

Plugins can contribute **configurable footer items** through the Stable
extension API (`@xmoon76/dsh-pi-tui/extensions`): register a
`FooterItemContribution` on the `chrome.footer.item` slot — a label and a
plain-data `segment` (styled spans; the host strips any terminal control
sequence, plugins never style the terminal). Users show/hide, reorder and
zone-place the item in `/footer` exactly like a builtin item. Feature-detect
the `slot.chrome.footer.item` capability before registering (it is
advertised before any surface exists). The item's config identity is the
canonical key `ext:<owner>/<id>` where the owner is the plugin's stable
name — **stable across HMR**: a layout referencing an unloaded plugin's
item keeps the reference and recovers automatically when the plugin
reloads. An npm-scoped plugin name (`@scope/name`) is legal: its `/` is
percent-encoded via `encodeURIComponent` in the key
(`ext:%40scope%2Fname/<id>`); the id itself must
not contain `/`. The legacy `chrome.footer.status` slot is unchanged: its
segments aggregate into the single `ext:*` item. Full author guide:
[docs/extension-api.md](docs/extension-api.md).

## Common keys

| Key           | Action                                              |
| ------------- | --------------------------------------------------- |
| `Enter`       | Submit input                                        |
| `Ctrl+Enter`  | Queue the draft while the agent is busy (the opposite of Enter while busy) |
| `Shift+Enter` | Insert newline                                      |
| `Esc`         | Cancel current interaction / interrupt running work |
| `Esc Esc`     | Open Rewind while idle                              |
| `Ctrl+C`      | Interrupt / clear current input                     |
| `Ctrl+D`      | Quit the TUI (like `/exit`)                         |
| `Ctrl+S`      | Steer queued messages and the draft into the running turn |
| `Ctrl+T`      | Toggle the todo panel                               |
| `Ctrl+R`      | Search input history                                |
| `Ctrl+F`      | Search Transcript                                   |
| `Ctrl+End`    | Jump to the latest Transcript output in fullscreen  |
| `Ctrl+O`      | Expand / collapse Tool and System details; in fullscreen Focus, bulk-toggle the Thought roots |
| `Alt+T`       | Expand / collapse Thinking                          |
| `Ctrl+G`      | Edit current input in `$VISUAL`/`$EDITOR`           |
| `Ctrl+V`      | Paste image                                         |
| `Tab`         | Autocomplete slash commands and file paths          |
| `@`           | File completion                                     |
| `!`           | Enter Shell mode                                    |
| `!!`          | Enter local-only Shell mode                         |

Use `/help` inside the TUI for the current command and keybinding list. The table above shows the defaults; after customization, `/help` and `/keybindings` show the effective keys.

### Customizing keybindings

Host shortcuts are semantic actions (`app.*`) resolved through a
context-aware keymap — the UI (footer hints, `/help`, `/keybindings`)
always shows the EFFECTIVE keys, so a remap updates every hint. Configure
them in the `dsh-pi-tui` settings namespace; apply with `/keybindings
reload` (explicit — a settings edit takes effect after the reload, no
restart):

```yaml
dsh-pi-tui:
  keybindings:
    app.input.steer: ctrl+s          # one key
    app.permission.cycle: [shift+tab, ctrl+shift+p]   # several keys
    app.history.search: ctrl+r
    app.transcript.toggleThinking: false   # disable the action's keys
    leader: ctrl+x                    # M6: leader sequences
    bindings:
      app.tasks.open: <leader>t
```

- A plain printable key can never be bound to a Host action (it would
  swallow typing); a bad entry is a warning, never a startup failure
  (fail-soft).
- Any user declaration REPLACES the action's builtin default keys:
  `app.input.steer: ctrl+x` makes Ctrl+X steer and Ctrl+S stop steering;
  a leader-only `app.todo.toggle: <leader>t` makes Leader T the only
  toggle trigger (Ctrl+T stops); `['ctrl+z', '<leader>s']` keeps both
  USER triggers; `false` removes every trigger of the action. Leader
  completions that the effective editor-owned submit key would consume (for
  example, `<leader>enter`) are rejected instead of being advertised as dead
  sequences.
- `DSH_PI_TUI_SAFE_KEYBINDINGS=1` ignores all user overrides (builtin
  defaults only). The whole `/keybindings` editor is read-only while safe mode
  is active, so it cannot save a configuration that is only checked after safe
  mode is disabled.
- In the editor, untouched default bindings that are still effective are
  selectable. `Add shortcut` materializes those surviving defaults plus the new
  key; shadowed definition defaults remain reference-only, and replacing or
  removing one surviving default preserves its siblings. Once an action has a
  user declaration, that declaration still replaces the builtin set as
  described above.
- `/help` remains the key-first, read-only help surface; `/keybindings` is the
  action-first, editable Keyboard Shortcuts Editor: it groups actions by
  category, searches action IDs/descriptions/current keys/default keys, and
  marks customized, conflict, Unbound, Disabled, and fixed states. A standalone Leader key row also configures the global leader key.
- `/settings` has one `Keyboard shortcuts` launcher that opens the same editor
  and persistence controller as `/keybindings`.
- The recorder reads a real terminal key, parses it with `parseKey`, and stores
  the canonical `KeyId`; known dead, typing-swallowing, terminal-ambiguous, and
  conflicting shortcuts are rejected before saving. Ordinary recording cancels
  on `Esc`; the direct Host interrupt recorder uses a short double-press window:
  one `Esc` cancels and two `Esc` press events assign physical Escape. Key
  repeats/releases do not count, and there is no single-letter shortcut;
  physical Escape remains reserved for Host lifecycle paths.
- Conditional affordances are labeled separately in the editor (for example,
  `Down (conditional)` for the empty-editor task browser) instead of appearing
  as ordinary configured shortcuts.
- `/keybindings conflicts` lists conflicts (same key + overlapping scope + same
  priority — never silent last-write-wins); `/keybindings reload` re-reads the
  settings (fail-soft: a bad entry is diagnosed and skipped, a throwing read
  is an error notice — never a crash; the keymap keeps the last-known-good
  configuration); `/keybindings reset` clears the overrides through the
  settings service and rebuilds the running keymap immediately.
- The subagent viewer blocks PARENT actions by action id, so a remapped
  parent shortcut stays blocked inside the viewer.
- Conditional affordances are ADDITIVE: binding `app.tasks.open: ctrl+x`
  ADDS a trigger — the empty-editor `↓` task-browser affordance still
  works; only `false` removes every trigger of an action.


## Installation

### Requirements

* DeepSeek Harness
* Node.js `^22.19.0 || >=24`

The project currently follows the DeepSeek Harness `0.1.1-rc.x` release line.

### npm

Using a dedicated `pi-tui` profile is recommended:

```sh
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui
dsh --profile pi-tui
```

Resume an existing Session:

```sh
dsh --profile pi-tui --session <session-id>
```

The published package already contains the Pi TUI fork required at runtime. No separate internal TUI package needs to be installed.

### Update

```sh
dsh plugin --profile pi-tui -- update @xmoon76/dsh-pi-tui
```

List installed plugins:

```sh
dsh plugin --profile pi-tui -- list
```

Remove:

```sh
dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

## Running from source

```sh
git clone https://github.com/XMoon/dsh-pi-tui
cd dsh-pi-tui

pnpm install
pnpm build
```

Install using `file:`:

```sh
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD
```

`file:` copies the current build output at install time. After changing source, rebuild and add the package again.

For continuous development, use `link:`:

```sh
dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD
dsh --profile pi-tui-dev
```

After that, rebuilding is enough:

```sh
pnpm build
```

The development profile continues to point at the working tree.

## DeepSeek Harness integration

`dsh-pi-tui` implements the terminal interaction layer only.

The following capabilities are provided by DeepSeek Harness:

* Agent Loop
* LLM / Provider
* Session Persistence
* Tools
* Skills
* Approval
* Permission Presets
* Plan Mode
* Goal
* Jobs
* Subagents
* Credentials
* Settings

The TUI therefore does not maintain a separate model configuration, Session format, or Agent Runtime.

It can coexist with other DSH surfaces using the same runtime data:

```sh
dsh --profile web
dsh --profile headless
dsh --profile pi-tui
```

## Extension API

In addition to being used as a TUI, `dsh-pi-tui` exposes versioned Extension APIs for other Cordis / DSH plugins that need to extend terminal interaction.

Three public entries are currently available:

| Entry                                     | Use                             | Stability |
| ----------------------------------------- | ------------------------------- | --------- |
| `@xmoon76/dsh-pi-tui/extensions`          | General extensions              | Stable    |
| `@xmoon76/dsh-pi-tui/extensions/advanced` | Deeper interaction capabilities | Advanced  |
| `@xmoon76/dsh-pi-tui/extensions/unstable` | Low-level capabilities          | Unstable  |

Extension points include:

* Header / Footer
* Input Widget
* Slash Command
* Theme
* Setting
* Autocomplete
* Keybinding
* Message Renderer
* Tool Renderer
* Overlay
* Interactive UI
* Editor Control
* Replacement Editor

Plugins depend only on public entries and do not need to import internal types such as `TuiApp` or `TuiMainScreen`.

Minimal example:

```ts
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type PiTuiExtensionService,
} from '@xmoon76/dsh-pi-tui/extensions'

export const name = 'my-plugin'
export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(
    PI_TUI_EXTENSIONS_SERVICE,
  ) as PiTuiExtensionService

  if (!service.api().capabilities.has('slot.chrome.header.badge')) {
    return
  }

  service.register(
    'chrome.header.badge',
    {
      id: 'my-badge',
      order: 100,
    },
    {
      text: 'my-plugin',
      tone: 'info',
    },
  )
}
```

Documentation:

* [Extension API](docs/extension-api.md)
* [Extension tiers](docs/extension-tiers.md)
* [Advanced API](docs/extension-advanced.md)
* [Unstable API](docs/extension-unstable.md)
* [Plugin authoring](docs/plugin-authoring.md)
* [Capability matrix](docs/extension-capability-matrix.md)

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

The test suite covers the Pi TUI fork, host / surface behavior, and Extension API fixtures and smoke tests.

Terminal rendering and input routing are tested extensively with `@xterm/headless`, so most UI tests do not require a real TTY or a live model connection.

Performance baseline:

```sh
node --expose-gc scripts/bench.mts
```

The project is also developed against a dedicated `pi-tui-dev` profile:

```sh
dsh plugin --profile pi-tui-dev -- add @xmoon76/dsh-pi-tui@link:$PWD
dsh --profile pi-tui-dev
```

## Repository layout

The repository root is the npm package published as `@xmoon76/dsh-pi-tui`.

The Pi TUI fork lives under:

```text
packages/pi-tui/
```

It is an internal build dependency bundled with the root package and does not need to be installed separately by users.

Upstream provenance, version information, and local divergence are tracked in:

```text
packages/pi-tui/package.json
packages/pi-tui/AGENTS.md
```

Contributor-oriented repository structure and development rules are documented in [AGENTS.md](AGENTS.md).

## Documentation

| Document                                               | Content                           |
| ------------------------------------------------------ | --------------------------------- |
| [docs/README.md](docs/README.md)                       | Documentation index               |
| [docs/architecture.md](docs/architecture.md)           | Architecture and module ownership |
| [docs/input-history.md](docs/input-history.md)         | Input history                     |
| [docs/surface-decisions.md](docs/surface-decisions.md) | TUI interaction decisions         |
| [docs/concurrency.md](docs/concurrency.md)             | Session concurrency               |
| [docs/failure-model.md](docs/failure-model.md)         | Async failure / cancellation      |
| [docs/perf-baseline.md](docs/perf-baseline.md)         | Performance baseline              |
| [docs/local-development.md](docs/local-development.md) | Local development and worktree policy |
| [docs/extension-api.md](docs/extension-api.md)         | Extension API                     |
| [AGENTS.md](AGENTS.md)                                 | Contributor operating manual      |

## Changelog

简体中文:

[CHANGELOG.md](CHANGELOG.md)

English:

[CHANGELOG.en.md](CHANGELOG.en.md)

## License

[MIT](LICENSE)
