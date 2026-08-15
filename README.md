# dsh-pi-tui

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

Run `dsh --profile pi-tui` for a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`).

> **Status: working.** The TUI covers the main session loop — input → session events,
> approvals, commands, session switching and full-text search — plus presets, skills,
> model/settings menus, and slash commands. Rendering and input routing are verified
> by headless tests (`@xterm/headless`) with no TTY or model connection needed.

## Screenshot

![dsh-pi-tui running in a terminal](https://raw.githubusercontent.com/XMoon/dsh-pi-tui/main/docs/dsh-pi-tui.png)

## Layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork, rescoped to @xmoon76/pi-tui.
                    The exact upstream version and commit live in ONE place:
                    packages/pi-tui/package.json `repository.note` (kept in
                    sync on every re-vendor). The local divergence fixes and
                    their guarding tests are listed in packages/pi-tui/AGENTS.md;
                    native/ prebuilds are deliberately not vendored (graceful
                    fallback).
packages/dsh-pi-tui/   The dsh bundle: @xmoon76/dsh-pi-tui (the only published
                    package). cordis.patch.yml inserts the startup row
                    (dsh --profile pi-tui flags) and the runner row (TUI glue).
                    tsdown bundles the pi-tui fork into dist/, so the tarball
                    is self-contained.
```

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
pnpm build        # pi-tui tsdown (dist/) + dsh-pi-tui tsdown (dist/, bundles pi-tui)
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD/packages/dsh-pi-tui
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
# or rebuild + re-add for file: installs:
pnpm build && dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@file:$PWD/packages/dsh-pi-tui

dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

## Development

```sh
pnpm install
pnpm build        # pi-tui tsdown (dist/) + dsh-pi-tui tsdown (dist/, bundles pi-tui)
pnpm test         # pi-tui's own suite (node --test) + dsh-pi-tui headless tests
pnpm typecheck
node --expose-gc packages/dsh-pi-tui/scripts/bench.mts   # performance baseline (optional)
```

Tests drive the UI through `@xterm/headless` (see `packages/dsh-pi-tui/test/virtual-terminal.ts`),
so rendering and input routing are verified without a TTY or a model connection.

## Slash commands (selection)

- `/sessions [query]` — open the session picker: search-as-you-type over
  session ids, titles, and workspaces, rows grouped by workspace with live
  `filtered/total` counts, and titles loaded in the background as they are
  read. Enter switches to the selected session.
- `/search <query>` — full-text search over persisted session logs, then
  switch to a hit.
- `/title [title]` — show or set the current session's title (titles appear
  in the `/sessions` picker).
- `/yolo` — switch to `danger-full-access` (alias of `/permission danger-full-access`).
- `/queue` — per-item queue management: edit, delete, steer one, or insert a
  message into the agent's inbox (the queue pane above the editor shows
  pending messages; `Ctrl+S` steers them all at once, `Alt+↑` pulls them all
  back into the editor).
- `/preset`, `/model`, `/settings`, `/export`, `/fork`, `/subagents` — see
  `dsh --profile pi-tui`'s command autocomplete (`/` + Tab).

## Keybindings (selection)

- `Shift+Tab` — cycle the permission preset (read-only → workspace-write →
  danger-full-access); the footer's mode slot badges every preset
  (`[workspace-write]` / `[read-only]` / `[custom]`, with `[yolo]` flagging
  the no-approval mode).
- `Ctrl+S` — steer: with queued messages, sends the whole queue (plus the
  draft, if any) into the running turn at once; otherwise sends the draft
  alone. An idle agent starts a fresh turn with everything.
- `Alt+↑` — dequeue: pull every queued message back into the editor draft.
- `Ctrl+T` — toggle the full todo list; the dock above the editor always shows
  the goal, todo summary, background tasks, and queued input.

## Session lifecycle

Opening the TUI with no `--session` creates **no session at all**: the first
user message (text, slash command, `Ctrl+S` steer, or `!!` shell) starts it
lazily. `--session <id>` still resumes immediately, and a local `!` command
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

## Safety & operational notes

- **One surface per session.** dsh has no cross-process session coordination:
  a session open in TWO dsh processes (TUI + web, or two TUIs) can corrupt its
  log. The TUI detects the other writer and blocks the send; the SAME action
  pressed again (Enter for a submit, Ctrl+S for a steer, unchanged draft)
  forces through — an edited draft, a swapped key, a new file revision, or a
  session switch invalidates the force. Never run two surfaces on one session.
- **Session repair.** `node_modules/@xmoon76/dsh-pi-tui/scripts/repair-session.mjs`
  repairs corrupted logs (`--scan` lists damage read-only; `--yes` applies with
  a mandatory backup). A torn (truncated) tail is truncated at the last
  complete frame and reported with exact byte accounting; references to a
  duplicated seq are never auto-resolved — the repair refuses and asks for
  `--duplicate-reference=first|last|segment`. Repaired logs are re-verified
  with the dsh reader's own layout checks before the backup is considered
  redundant.
- **Exit.** `/exit` flushes the session with a 10s hard timeout: a hung
  provider cannot trap the TUI. If the flush fails or times out, the terminal
  prints a warning (the tail may not be persisted) and the process still exits.
- **Performance.** `scripts/bench.mts` (non-default) measures ingest,
  projection, cold/warm rebuilds, streaming frames, theme switches, and heap;
  the saved baseline lives in `docs/perf-baseline.md`. Unchanged transcript
  messages reuse their rendered components, so the warm per-frame rebuild
  does not grow with history.

## License

MIT. `packages/pi-tui` retains its upstream MIT license and authorship
(Copyright (c) 2025 Mario Zechner; Moonshot AI fork).
