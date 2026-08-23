# dsh-pi-tui tmux manual testing

## When to use tmux, and when to use headless

**Use headless tests for routine development and regression**
(`test/`, `@xterm/headless` drives real rendering and
input routing): fast, deterministic, no TTY or model dependency, CI-runnable.
Feature changes must be covered by headless tests first.

**tmux testing is only for what headless cannot cover**:

| Scenario | Why tmux is needed |
|---|---|
| Theme / color appearance | The palette's actual look and before/after switching (headless can assert color values, not "does it look good") |
| Real dsh end-to-end | Model sessions, `ctx.jobs` background tasks, preset combinations, tool-job completion notifications, real subagent behavior |
| Interaction "feel" | Keyboard rhythm, modal stacking, ghost-overlay timing/focus issues (hard to catch headless) |

Rule: tmux is a **complement**, not a replacement for headless; when a
problem surfaces in tmux, add the regression test to headless.

## Environment prep

- tmux is required; `dsh --profile pi-tui-dev` (link dependency on this
  repo — `pnpm build` takes effect immediately).
- **This machine's shell exports `NO_COLOR=1`**: the theme autodetect's
  opt-out guard skips detection, so wrap launches with `env -u NO_COLOR`.
- Model end-to-end needs working credentials for the agent-default-model in
  `~/.dsh/settings.yaml` (opencode-go/deepseek-v4-flash are configured here).

## Basic flow

```sh
tmux kill-session -t demo 2>/dev/null
tmux new-session -d -s demo -x 110 -y 34            # big enough to read

# launch (note: send-keys -l for the string, sleep, THEN Enter)
tmux send-keys -t demo -l "env -u NO_COLOR dsh --profile pi-tui-dev"
sleep 0.3
tmux send-keys -t demo Enter
sleep 5                                            # wait for startup

# capture: plain text and ANSI-colored copies
tmux capture-pane -t demo -p > /tmp/pane.txt
tmux capture-pane -t demo -e -p > /tmp/pane.ansi

# send a command: same two-step rhythm (see the PasteBurst trap)
tmux send-keys -t demo -l "/settings"
sleep 0.4
tmux send-keys -t demo Enter

tmux kill-session -t demo 2>/dev/null              # cleanup
```

## Theme color verification

Convert the ANSI capture to HTML and inspect colors in a browser:

```sh
node docs/tmux/ansi2html.mjs /tmp/pane.ansi /tmp/pane.html "stage name"
```

Palette reference values (dark / light):

| token | dark | light |
|---|---|---|
| border | `#5A5A5A` | `#737373` |
| textDim | `#888888` | `#454545` |
| textMuted | `#6B6B6B` | `#5F5F5F` |
| success | `#4EC87E` | `#0E7A38` |

Detection-chain verification: launch with `COLORFGBG='15;0'` (dark) /
`'0;15'` (light) and check the automatic switch; in `/settings` the Theme
row cycles `auto → dark → light` (move the cursor down from Default
permission to the Theme row first). After switching, wait **≥1.5s before
capturing** — panels repaint as input is processed, an early capture shows
the old value.

Full theme demo (dark launch → light autodetect → UI switch → persisted
restart): `bash docs/tmux/tui-demo.sh`; artifacts land in the script's
private `/tmp/tui-demo.XXXXXX/` (`.txt` plain + `.html` colored).

## Real model end-to-end (background tasks, subagents, guard)

1. Launch the TUI and send a message to create a session (the first message
   triggers deferred session creation; `Reply with exactly: pong` verifies
   connectivity first).
2. **Background bash job**: have the model run
   `Run this in the background: sleep 20 && echo slow-done. Use the bash tool with run_in_background=true, do not wait.`
   Verify: the dock's `⏳ bash-1 · …` row, the footer's
   `[N tasks running · ↓ view]` badge, `↓` opening the task browser while
   running, Enter showing the output viewer, and the completion notification
   being handled by the model.
3. **Subagent viewing — mode-aware**: `/tasks` → the subagent rows must
   read `subagent · <label> · continuable` / `· one-shot` (mode is part of
   the label; a long label truncates, the mode never does). Enter on a
   **continuable** child opens the INTERACTIVE viewer:
   - the header shows `[viewing subagent · continuable]`, the empty editor
     shows the `Message <label>… — Enter send · Esc back` placeholder, and
     your main-session draft is preserved;
   - type a follow-up (paced `send-keys -l`, sleep, Enter — trap 1) and
     press Enter: the draft clears, a `sent to <label> — queued for the
     next turn` notice appears, and the child's own transcript shows the
     user message from its real session events (never a fake row); while
     the child is running, its current turn is NOT interrupted;
   - Ctrl+S / Ctrl+Enter inside the viewer must be inert (no parent steer,
     no parent queue); Esc returns to the main session with the main draft
     exactly restored; re-entering the same child restores the child's
     unsent draft.
   Enter a **one-shot** child: the viewer is read-only (`viewing subagent:
   … — one-shot · read-only · Esc returns`; typing + Enter must be
   intercepted, with the draft preserved); Esc returns.
4. Finish with `/exit` to run the flush flow, then `tmux kill-session`.

## Plain-exit and input-history verification

1. **Plain `exit` quits**: with an EMPTY editor, type `exit` (paced
   `send-keys -l 'exit'`, sleep, Enter — see trap 1). The TUI must quit to
   the shell with the `To resume this session: …` hint. `exit` only quits
   when the draft is EXACTLY `exit`: a non-empty draft (e.g. a recalled
   entry still in the editor) makes it a normal message — clear the editor
   first. Any other wording (`exit!`, `Exit`) still submits to the model.
2. **Fresh-window ↑ recall**: submit a message, quit, relaunch in the same
   directory, press ↑ once — the editor must recall the MOST RECENT
   submission (newest first). The first cut of this feature recalled the
   OLDEST entry because the JSONL file is oldest-first while TuiApp's
   recall API takes newest-first — the runner must reverse before seeding
   (see `docs/input-history.md`). Verify the file exists:
   `ls $DSH_HOME/user-history/` (md5(cwd) filenames).
3. **Migration**: with legacy history in `~/.dsh/settings.yaml`, the first
   boot writes the entries to the JSONL file and removes the `history` key
   from the settings document — `grep history ~/.dsh/settings.yaml` must
   come up empty afterwards.

Note: whether the model registers a subagent in the jobs registry depends on
it passing `run_in_background: true` (both local runs took the continuable
path). Since the task browser now merges RUNNING one-shot children too, a
foreground delegation (`run_in_background: false`) shows as a `🤖` dock row
and arms the badge while it works, even without any job record; the
background-one-shot double row (job row + child row) is expected, see
tasks-browser.ts.

## Trap list (every item hit in real testing)

1. **PasteBurst turns Enter into a newline**: `send-keys 'text' Enter`
   delivers a batch fast enough for the editor's paste heuristic (≥8 plain
   chars within 8ms) to treat it as a paste and suppress Enter for 120ms.
   Always `send-keys -l 'text'` → `sleep 0.3+` → `send-keys Enter`.
2. **zsh treats `;` as a command separator**: `COLORFGBG=15;0 dsh …` runs
   `0`. Quote the env value (`COLORFGBG='15;0' dsh …`) and mind nested quotes
   in scripts (wrap the whole thing in double quotes).
3. **`NO_COLOR=1` skips theme detection**: this machine's shell exports it;
   use `env -u NO_COLOR` when demoing the detection chain. The same env
   poison applies to HEADLESS theme tests — they must explicitly reset
   `process.env.NO_COLOR = ''` (or run with `CI=true`, which also forces
   non-interactive pnpm) or the theme branch silently never executes.
4. **Panels repaint as input is processed**: capturing right after changing a
   setting shows the old value; wait ≥1.5s.
5. **Model behavior is uncontrollable**: sandbox approval popups and
   ask_user_question dialogs interrupt a demo's key sequence — capture to
   confirm the state and continue; answer `n` to reject approvals and finish
   questions before the next step.
6. **Ghost overlay (fixed, still watch for it)**: if a `/subagents` action
   leaves input being eaten by a SettingsList search box, an overlay is
   still open (current versions close it automatically); clear with Esc.
7. **The demo writes `~/.dsh/settings.yaml`** (theme/permission) — restore
   afterwards (`theme: auto`, `defaultPreset: workspace-write`).
   `docs/tmux/tui-demo.sh` now byte-backups settings.yaml before launch and
   `cmp`-verifies it (refuses to run if the backup fails); cleanup hangs only
   on the EXIT trap (idempotent), INT/TERM handlers explicitly `exit
   130/143` so EXIT runs once; every run uses private output/backup dirs and
   holds a process lock on the settings file before backing up (concurrent
   instances fail closed); the tmux session name carries a PID + random
   suffix and the script kills only its own session — do not replace the
   restore with "write auto at the end".
8. **Never manually kill leftover dsh processes**: the
   `dsh --profile pi-tui-dev` process may be the one hosting your own
   session — killing it kills the session you are running in (hit for real
   while cleaning up "leftovers"). Only clean the script's own tmux session
   (`tmux kill-session -t <name>`); the script's traps own its resources,
   process-level cleanup is the user's job.
9. **Raw PTYs answer no terminal queries**: driving the full TUI in a bare
   PTY (not tmux, no terminal emulator in front) leaves OSC 11 (background
   color) and DA (capability) queries unanswered, so theme autodetect
   times out (800ms) and never fires, and capability-dependent paths never
   run. Use tmux or `demo.ts` for real-terminal runs —
   both answer the queries.
10. **A crash can leave a DA2 reply in the pty**: if the TUI dies before
    answering its own `\x1b[>c` DA2 query, the terminal's `\x1b[>1;2;4c`
    response can remain in the pty and render as garbage shell input on the
    next command. After a crash, start the next run in a FRESH
    session/window, not the same pane.
11. **Before debugging a rendered symptom, check `~/.dsh/settings.yaml` for
    leftover TUI settings**: values toggled during an earlier test matrix
    persist across launches and silently change appearance/behavior — hit
    for real with `footer: compact` (hides the stats line) and
    `fullscreen: on` (freezes the TUI under a pipe/tee with no interactive
    TTY). Reset them (`theme: auto`, `defaultPreset: workspace-write`,
    fullscreen off) before re-testing in a different launch environment.

## Scripts

- `docs/tmux/ansi2html.mjs` — ANSI capture → colored HTML
  (`node … <in> <out> [title]`).
- `docs/tmux/tui-demo.sh` — full theme demo (dark → light COLORFGBG
  detection → UI switch → persisted-theme restart → settings restore).
