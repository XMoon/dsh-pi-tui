# dsh-pi-tui

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

Run `dsh --profile tui` for a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`).

> **Status: scaffolding + P0 spike.** The vendored fork and the bundle skeleton are in place and verified; session wiring (input → session events, approvals, commands) is the next milestone.

## Layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork (kimi-code commit b6144f9, v0.84.2),
                    rescoped to @dsh-pi-tui/pi-tui. The five local fixes from the fork
                    (CJK wrap guard, width clamps, overwide truncation, negative-width
                    guards, per-frame processed-line reuse) are preserved; native/
                    prebuilds are deliberately not vendored (graceful fallback).
packages/tui-app/   The dsh bundle: @dsh-pi-tui/tui-app. cordis.patch.yml inserts the
                    startup row (dsh --profile tui flags) and the runner row (TUI glue).
```

## Prerequisites

- Node >= 22.19 (`^22.19.0 || >=24`, same range as dsh). Running from source needs
  Node with native TypeScript support (>= 23.6) or the tsx ESM hook
  (`node --import tsx/esm`, how dsh's own source launch works) — the exports point
  at `.ts` sources until a build step is added.
- A DeepSeek Harness installation with profiles support.

## Install into a dsh profile

```sh
# create/init the profile (dsh-base is the default first layer)
dsh plugin --profile tui -- add @dsh-pi-tui/tui-app@file:/path/to/dsh-pi-tui/packages/tui-app
# or, from a published registry version:
dsh plugin --profile tui -- add @dsh-pi-tui/tui-app

# run it
dsh --profile tui
```

`dsh plugin` reconciles `dsh.profile.bundles` from installed state: any dependency
whose manifest declares `dsh.bundle` joins the layer stack automatically.

## Development

```sh
pnpm install
pnpm test         # pi-tui's own suite (node --test) + tui-app headless tests
pnpm typecheck
```

Tests drive the UI through `@xterm/headless` (see `packages/tui-app/test/virtual-terminal.ts`),
so rendering and input routing are verified without a TTY or a model connection.

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
