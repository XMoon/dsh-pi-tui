# dsh-pi-tui

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

Run `dsh --profile pi-tui` for a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`).

> **Status: scaffolding + P0 spike.** The vendored fork and the bundle skeleton are in place and verified; session wiring (input → session events, approvals, commands) is the next milestone.

## Layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork (kimi-code commit b6144f9, v0.84.2),
                    rescoped to @dsh-pi-tui/pi-tui. The five local fixes from the fork
                    (CJK wrap guard, width clamps, overwide truncation, negative-width
                    guards, per-frame processed-line reuse) are preserved; native/
                    prebuilds are deliberately not vendored (graceful fallback).
packages/tui-app/   The dsh bundle: @dsh-pi-tui/tui-app. cordis.patch.yml inserts the
                    startup row (dsh --profile pi-tui flags) and the runner row (TUI glue).
```

## Prerequisites

- Node >= 22.19 (`^22.19.0 || >=24`, same range as dsh). Running from source needs
  Node with native TypeScript support (>= 23.6) or the tsx ESM hook
  (`node --import tsx/esm`, how dsh's own source launch works).
- A DeepSeek Harness installation with profiles support.

## Install into a dsh profile

Build artifacts are not committed (`dist/` for pi-tui, `lib/` for tui-app are
gitignored — the package `exports` point at the built files), so build before
installing from a clone:

```sh
pnpm install
pnpm build        # pi-tui tsdown (dist/) + tui-app tsc (lib/)
```

Then create/init the profile and add the bundle (dsh-base is the default
first layer):

```sh
dsh plugin --profile pi-tui -- add @dsh-pi-tui/tui-app@file:/path/to/dsh-pi-tui/packages/tui-app
# or, from a published registry version (ships prebuilt):
dsh plugin --profile pi-tui -- add @dsh-pi-tui/tui-app

# run it
dsh --profile pi-tui
```

`dsh plugin` reconciles `dsh.profile.bundles` from installed state: any dependency
whose manifest declares `dsh.bundle` joins the layer stack automatically.

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
