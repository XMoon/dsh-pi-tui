# dsh-pi-tui

English | [简体中文](README.md)

[![npm](https://img.shields.io/npm/v/@xmoon76/dsh-pi-tui.svg)](https://www.npmjs.com/package/@xmoon76/dsh-pi-tui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A terminal frontend for DeepSeek Harness. One Host, with TUI, Web and ACP clients accessing the same Agent Session.**

**Direct** remains the default, ready-to-use mode. Starting in **0.5.7**, Linux/macOS users can explicitly choose a **Daemon**: an independent local Host retains sessions and ongoing work as terminal Clients disconnect and reconnect. Other TUIs, the official Web frontend and an opt-in local ACP client can access sessions belonging to that same Host.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) remains the authority for the Agent Loop, models, tools, persistence, permissions and concurrent writes. `dsh-pi-tui` is a third-party frontend, not a second Agent Runtime.

![dsh-pi-tui](docs/dsh-pi-tui.png)

![Direct TUI and a daemon Host shared by TUI, Web and ACP clients](docs/dsh-pi-tui-shared-session.svg)

> **Shared Sessions, not shared terminal screens.** Multiple TUI clients can view the same Session; Web and ACP use the Host's official Session/Agent capabilities. Prompt admission, approvals, cancellation and writes remain subject to Host permission and concurrency rules. ACP permits at most one ACP View per Session at a time (without limiting TUI Views), and ACP v1 is a bounded protocol subset. Daemon access is **local, same-OS-user** functionality, not a public TCP remote service.

## Install into a DSH profile

### Stable / latest

**0.5.7 is the current stable release (npm `@latest`).** The recommended DSH pairing is **0.2.2-rc.5**. Install DeepSeek Harness first, then the TUI bundle into the `pi-tui` profile:

~~~sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.2-rc.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@latest
dsh --profile pi-tui
~~~

### Exact version pairing (0.5.7)

**0.5.7 requires Node.js ≥24.9.0 and DSH ≥0.2.2-rc.3. DSH 0.2.2-rc.5 is recommended** (the exact qualification target for this release). For a reproducible installation, pin both package versions:

~~~sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@0.2.2-rc.5
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@0.5.7
dsh --profile pi-tui
~~~

| TUI | DSH | Status |
|---|---|---|
| `0.5.7` | `>=0.2.2-rc.3`; recommended `0.2.2-rc.5` | **Current latest** |
| `0.5.6` | `0.2.2-rc.1` | Previous release |

**Upgrade precaution:** Before changing the DSH Runtime, finish in-flight Turns/Jobs, stop the previous Host and back up Profiles, Sessions and required data. Cross-DSH schema downgrade in place is not guaranteed. Do not pair 0.5.7 with rc.2 or earlier. See the [compatibility guide](docs/guides/dsh-compatibility.md) for historical pairs and recovery.

### Next / npm line (validation)

The TUI `@next` channel and DSH `@alpha` channel are independent moving pointers. Verify their actual published versions and peer/engine ranges before combining them:

~~~sh
npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty @deepseek-ai/dsh@alpha
dsh plugin --profile pi-tui -- add @xmoon76/dsh-pi-tui@next
dsh --profile pi-tui
~~~

## Features

### Two modes, one DSH Session authority

| | Direct (default) | Daemon (opt-in from 0.5.7) |
|---|---|---|
| Launch | `dsh --profile pi-tui` | `DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui` |
| Process | TUI and Host in one process | Independent Host; TUI is a detachable Client |
| Frontends | Current in-process terminal surface | Multiple TUIs + official Web + optional local ACP on one Host/Session |
| Exit | Ends the Direct application | Normally detaches only the Client; does not stop Host |
| Service | No separate management | Optional Linux systemd --user / macOS LaunchAgent |

You can also save `Daemon` under `/settings → General → Backend` for the **next cold launch**. `DSH_PI_TUI_BACKEND` overrides that preference for one launch without saving it. Selecting a backend does not hot-migrate a Host. Installing an OS user service is optional, not a prerequisite. Sessions and Agents remain Host-owned.

### Agents, tasks and sessions

- **Agent and tools:** streamed Markdown, Thinking / Tool / Context disclosure, approvals and Questions, model/reasoning-effort selection, Plan, Goal and Todo.
- **Sessions and workspaces:** `/sessions`, `/new`, `/resume`, `/fork`, `/rewind`, `--session` and `--continue`; browse by workspace and preview before resuming.
- **Team / Subagent / Job:** toggle Root Agent Team in `/model`; `/tasks` displays Work/Team, nested Subagents and Jobs. Subagents are expanded by default; retained Job history is optionally disclosed.
- **Input and shell:** `@file` completion, image and file attachments, `Ctrl+V` image paste, `!` / `!!` Host Shell, external editor, customizable Footer.
- **Reading and search:** `/display` Full / Focus / Compact, Transcript View / Full search, folding, `Ctrl+R` prompt history. Current Session recall spans working-directory changes.
- **Settings and plugins:** Provider authorization/credentials, approvals, MCP management, Web Search/Fetch, Plugin Manager, dynamic Extension Settings and Client-local `./tui` plugin loading.
- **Images and delivery:** terminal-gated image/static SVG/charts, `/view-image`, `/deliverables`, `/export`; Kitty, SIXEL and supported iTerm2 paths.
- **Optional experimental renderer:** `DSH_PI_TUI_RENDERER=tsp` enables a subset of Tern TSP native Transcript/Work Hub interactions; it does not replace every PiTui Settings/Plugins surface.

### Useful commands and default keys

| Command / key | Use |
|---|---|
| `/sessions` · `/resume` · `/new` | Find or start sessions |
| `/model` · `/tasks` · `/plan` · `/goal` | Models, jobs and Agent modes |
| `/settings` · `/plugins` · `/keybindings` | Configuration and extensions |
| `/display` · `/export` · `/deliverables` | Reading and exporting |
| `Ctrl+F` · `Ctrl+Shift+F` | Rendered-view / available Session-history search |
| `Ctrl+R` · `Ctrl+G` | Prompt history / external editor |
| `Ctrl+O` · `Alt+T` | Tool/Context and Thinking disclosure |
| `Ctrl+C` · `Ctrl+D` | Cancel while busy, or follow idle exit confirmation |
| `!` · `!!` | Host Shell with / without Session persistence |

These are default mappings and common entries; `/keybindings` shows the **effective** keys after customizations. Type `/` to search and select commands and available Skills; use `/skill <name> [args]` to invoke a Skill explicitly (including when a same-named command would otherwise win), while bare `/skill` only prints its usage. `/transcript` currently uses the official Direct Markdown export; `/export` creates a separate ZIP archive saved on the Client filesystem. `PI_IMAGE_PROTOCOL=none` disables pixel previews, not attachments.

## Daemon quick start (Linux / macOS)

A system service is not required to start a standalone Host. Try one launch:

~~~sh
DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui
~~~

The usual Daemon TUI `/exit` / `/quit` **detaches the Client, not the Host**. When the current Session is working, the TUI offers explicit exit choices. Management commands operate only on the selected Profile:

~~~sh
dsh --profile pi-tui daemon status
dsh --profile pi-tui daemon logs --lines 200
dsh --profile pi-tui daemon start
dsh --profile pi-tui daemon stop
dsh --profile pi-tui daemon restart
dsh --profile pi-tui daemon install
dsh --profile pi-tui daemon uninstall
~~~

`daemon install` only creates/verifies the optional Profile-scoped OS user service definition; it does **not** start, enable or migrate the Host. `daemon stop` and `restart` can interrupt in-flight Turns/Jobs across connected Clients. A manager reporting “running” is not proof of authenticated Host readiness.

Within the **same DSH Runtime and Profile**, update the installed TUI bundle through official plugin management. The old Host may continue serving existing work; explicitly run `daemon restart` when you want its static code replaced (with an interruption). Same-Profile older service definitions do not require a routine uninstall first. **Changing DSH Runtime** is not a hot upgrade; stop, back up and cold start a supported pair. See the [Daemon guide](docs/guides/daemon.md).

## Web, ACP and other clients share the Host Session

The **official Web frontend** and optional local ACP listener use the same Daemon Host and its official Session/Agent authority. The Web frontend is default-off and can be enabled on a running Host:

~~~sh
dsh --profile pi-tui web enable
dsh --profile pi-tui web url
dsh --profile pi-tui web status
~~~

Also available: `web disable` / `web open`. The commands do **not** start a Host or create a Session. The `web url` output contains an authentication token: handle it as a secret. The official Web page lets users select sessions held by that Host.

**ACP v1** is a default-off, same-user local Unix-socket interface. `/acp` in a Daemon TUI inspects/toggles the live listener; `/settings → General → Start ACP automatically` controls the next cold Host start. Headless clients can discover a positively verified `acp` status/socket via `daemon status`. ACP supports a bounded `initialize` / `session/new|resume|prompt|cancel|close` subset plus negotiated image input; it does not implement `session/list`, `session/load` or MCP Server configuration over ACP. One ACP connection has at most one Session View and each Session at most one ACP View, with no such restriction on TUI Views. An executable [ACP SDK example and connection procedure](docs/guides/daemon.md#local-acp-v1-sdk-client-example) is in the Daemon guide.

When launched inside [Herdr](https://github.com/herdrdev/herdr), the TUI can report Agent status and provide Profile-pinned recovery commands for durable Sessions where the Herdr Client supports them.

## Settings, extensions and development

`/settings` is the shared fullscreen Settings workspace; `/plugins`, `/footer` and `/keybindings` open its relevant pages. `/keybindings conflicts` opens the same Keyboard shortcuts page directly in its Conflicts view; when the settings document cannot be read or that page cannot open, the command returns an error carrying the current runtime conflict records. Host configuration writes use official authoritative readback; a package enabled in the Host is not necessarily an ACTIVE `./tui` extension in the current Client.

Public extensions have **Stable / Advanced / Unstable** tiers: see the [authoring guide](docs/extensions/authoring.md), [Stable API](docs/extensions/stable.md) and [tier contract](docs/extensions/tiers.md). Version 0.5.7 adds Client-local `./tui` loading and per-package persisted settings, but **does not deliver Forge or a Plugin Marketplace**.

For development:

~~~sh
mise install --locked
mise run setup
mise run build
mise run typecheck
~~~

Read [AGENTS.md](AGENTS.md), the [development guide](docs/guides/development.md) and [documentation index](docs/README.md). The [release checklist](docs/guides/releasing.md) owns full release verification.

## Changelog and license

- [中文 CHANGELOG](CHANGELOG.md) / [English CHANGELOG](CHANGELOG.en.md)
- [MIT License](LICENSE)
