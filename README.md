# dsh-pi-tui

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

Run `dsh --profile pi-tui` for a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`).

> **Status: working.** The TUI covers the main session loop — input → session events,
> approvals, commands, session switching and full-text search — plus presets, skills,
> model/settings menus, and slash commands. Rendering and input routing are verified
> by headless tests (`@xterm/headless`) with no TTY or model connection needed.

## Layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork (kimi-code commit b6144f9, v0.84.2),
                    rescoped to @xmoon76/pi-tui. The five local fixes from the fork
                    (CJK wrap guard, width clamps, overwide truncation, negative-width
                    guards, per-frame processed-line reuse) are preserved; native/
                    prebuilds are deliberately not vendored (graceful fallback).
packages/tui-app/   The dsh bundle: @xmoon76/tui-app. cordis.patch.yml inserts the
                    startup row (dsh --profile pi-tui flags) and the runner row (TUI glue).
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

The published package ships prebuilt (`@xmoon76/tui-app` pulls in
`@xmoon76/pi-tui` automatically):

```sh
# install the bundle into the pi-tui profile (creates the profile if needed)
dsh plugin --profile pi-tui -- add @xmoon76/tui-app

# run it
dsh --profile pi-tui
```

Any dependency whose manifest declares `dsh.bundle` joins the profile's layer
stack automatically — no manual `cordis.patch.yml` wiring.

### Option B — from source

Build artifacts are not committed (`dist/` for pi-tui, `lib/` for tui-app are
gitignored and the package `exports` point at the built files), so build before
installing from a clone:

```sh
git clone https://github.com/XMoon/dsh-pi-tui
cd dsh-pi-tui
pnpm install
pnpm build        # pi-tui tsdown (dist/) + tui-app tsc (lib/)
dsh plugin --profile pi-tui -- add @xmoon76/tui-app@file:$PWD/packages/tui-app
```

### Verify the install

```sh
dsh plugin --profile pi-tui -- list          # both @xmoon76 packages present
dsh --profile pi-tui                         # TUI starts instead of the web GUI
```

### Update / uninstall

```sh
# registry installs:
dsh plugin --profile pi-tui -- update @xmoon76/tui-app
# or rebuild + re-add for file: installs:
pnpm build && dsh plugin --profile pi-tui -- add @xmoon76/tui-app@file:$PWD/packages/tui-app

dsh plugin --profile pi-tui -- remove @xmoon76/tui-app
```

## Development

```sh
pnpm install
pnpm build        # pi-tui tsdown (dist/) + tui-app tsc (lib/)
pnpm test         # pi-tui's own suite (node --test) + tui-app headless tests
pnpm typecheck
```

Tests drive the UI through `@xterm/headless` (see `packages/tui-app/test/virtual-terminal.ts`),
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
- `/preset`, `/model`, `/settings`, `/export`, `/fork`, `/subagents` — see
  `dsh --profile pi-tui`'s command autocomplete (`/` + Tab).

## Verified in the P0 spike

- Vendored pi-tui: 960/960 tests pass under Node 26 (`node --test`).
- `TuiApp` renders, accepts editor input, and handles Ctrl+C on a headless xterm.
- The whole import chain (pi-tui, tui-app, `@deepseek-ai/dsh-cmdline`, commander)
  loads under the tsx ESM hook — the dsh source-launch contract.
- Native modifier-key addons are optional: on Linux the loader returns `undefined`
  without attempting a load, and the non-TTY stdin path is guarded.

## License

MIT. `packages/pi-tui` retains its upstream MIT license and authorship
(Copyright (c) 2025 Mario Zechner; Moonshot AI fork).
