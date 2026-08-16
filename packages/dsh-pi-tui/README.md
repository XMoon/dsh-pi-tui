# @xmoon76/dsh-pi-tui

A third-party TUI mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui).

This package is the `dsh.bundle` layer that makes `dsh --profile pi-tui` run a terminal UI instead of the browser GUI (`dsh --profile web`) or one-shot mode (`dsh --profile headless`). The vendored pi-tui fork (`@xmoon76/pi-tui`, with its local rendering fixes — the divergence ledger lives in the repo at `packages/pi-tui/AGENTS.md`) is bundled inside this package's build output — you only ever install this one package.

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

## ⚠️ One surface per session

**Upstream limitation (a known dsh issue this TUI cannot fix):** dsh's session persistence has no cross-process coordination — each process numbers events from its own in-memory log length (`seq = log.length`) and appends to the same session file. When two processes hold the **same active session** at the same time (TUI + web GUI, two TUIs, TUI + any third-party plugin), one side's resume writes a `session/end-seed` marker and the other side's next append collides on the same seq — **the log corrupts and the session becomes unreadable** (`corrupt session log: seq gap in committed region`).

Therefore:

- **Do not open the same active session in two surfaces at once** (TUI, web GUI, or any other plugin);
- To switch surfaces, close the session in the current one first, then open it in the other;
- This TUI ships a **divergence guard**: before each message send it checks whether another process has written the session file, and **blocks the send with a warning** when it has (pressing Enter again force-sends at your own risk — it may corrupt the log);
- If a session is already corrupted, fix it with the [session repair script](#session-repair) below (close every process holding the session first).

## Diagnostic log

The TUI writes its own diagnostics to stderr and a log file (`ctx.logger` is invisible in this process — no exporter):

- Default file: `$DSH_HOME/logs/pi-tui-<pid>.log` (default `~/.dsh/logs/`);
- Line format: `[tui] <ISO time> <level> <message> k=v ...`;
- Default level `info`: key lifecycle events only (boot/resume/switch/exit, divergence-guard warnings, errors); `debug` additionally logs every guard check before a send.

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

## Session repair

**Background:** when a session log is corrupted (duplicate or missing seqs) dsh can no longer read that session. This repository ships a standalone repair script, `scripts/repair-session.mjs`: it locates the session file, diagnoses the damage, and repairs it — renumbering seqs (duplicates), truncating at the first missing/unparsable event (which cannot be recreated), or re-framing the log when the frame layout is wrong (dsh requires the first zstd frame to be exactly the header line; a whole-log single frame is structurally valid zstd but rejected by every dsh reader). It **always backs up the original before writing** and verifies the result with the same scans the reader performs (frame layout + event contiguity).

**Dependency:** resolves `@deepseek-ai/dsh-session` from the dsh installation (auto-detected through the `dsh` launcher on PATH, or `--dsh-dir <path>`).

**Repair one session (dry run by default; `--yes` writes):**

```sh
# Close every process holding the session first (TUI / web / plugins)!
node scripts/repair-session.mjs session-ab79200b-0e36-4a62-a7a6-3ac620c05f1d          # diagnose + repair plan (no write)
node scripts/repair-session.mjs session-ab79200b-0e36-4a62-a7a6-3ac620c05f1d --yes    # apply the repair
```

The original file is backed up to `session.jsonl.zstd.bak-<timestamp>` before writing (a failed backup aborts the write); the report prints the backup path.

**Read-only scan of all sessions, listing damaged ids:**

```sh
node scripts/repair-session.mjs --scan
```

Prints one `CORRUPT <id>: <reason>` per damaged session; `no damaged sessions found` when everything is healthy.

**Other options:** `--dsh-home <path>` sets the sessions root (default `$DSH_HOME` or `~/.dsh`); `--help` shows usage.

## Development

Source and tests live in the [dsh-pi-tui repository](https://github.com/XMoon/dsh-pi-tui) (`packages/dsh-pi-tui/`); headless tests drive the UI through `@xterm/headless` with no TTY or model connection.

## License

MIT. The bundled pi-tui fork retains its upstream MIT license and authorship
(Copyright (c) 2025 Mario Zechner; Moonshot AI fork).
