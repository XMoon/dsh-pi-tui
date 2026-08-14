# @xmoon76/dsh-pi-tui

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

This package is the `dsh.bundle` layer that makes `dsh --profile pi-tui` run a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`). The vendored pi-tui fork (`@xmoon76/pi-tui`, with its five local rendering fixes) is bundled inside this package's build output — you only ever install this one package.

## Install

Prerequisite: a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) installation with profiles support.

```sh
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui
dsh --profile pi-tui
```

`dsh plugin` runs pnpm inside the profile; any dependency whose manifest declares `dsh.bundle` joins the profile's layer stack automatically.

## Verify / update / uninstall

```sh
dsh plugin --profile pi-tui -- list                              # is it installed?
dsh plugin --profile pi-tui -- update @xmoon76/dsh-pi-tui       # registry installs
dsh plugin --profile pi-tui -- remove @xmoon76/dsh-pi-tui
```

## Slash commands (selection)

- `/sessions [query]` — session picker with search-as-you-type, grouping by workspace and live titles
- `/search <query>` — full-text search over persisted session logs
- `/title [title]` — show or set the current session's title
- `/preset`, `/model`, `/settings`, `/export`, `/fork`, `/subagents` — see the command autocomplete (`/` + Tab)

## Development

Source and tests live in the [dsh-pi-tui repository](https://github.com/XMoon/dsh-pi-tui) (`packages/dsh-pi-tui/`); headless tests drive the UI through `@xterm/headless` with no TTY or model connection.

## License

MIT. The bundled pi-tui fork retains its upstream MIT license and authorship
(Copyright (c) 2025 Mario Zechner; Moonshot AI fork).
