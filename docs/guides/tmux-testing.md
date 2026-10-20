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
  repo — `pnpm build` takes effect immediately). **In a WORKTREE that profile
  still points at the main checkout**, so it paints the main checkout's build,
  not the worktree's: for worktree verification create a throwaway profile that
  LINKS the worktree instead — `DSH_HOME=<worktree>/temp/dsh-wt` with
  `profiles/<name>/package.json` declaring
  `"@xmoon76/dsh-pi-tui": "link:<worktree>"`, a
  `node_modules/@xmoon76/dsh-pi-tui -> <worktree>` symlink, and a
  `dsh.profile.bundles` list that includes `@deepseek-ai/dsh-base` (without it
  the TUI never mounts and the pane only shows the loader warnings), then
  `env -u NO_COLOR DSH_HOME=<worktree>/temp/dsh-wt dsh --profile <name>`. No
  `pnpm pack` is needed for this.
- **This machine's shell exports `NO_COLOR=1`**: the theme autodetect's
  opt-out guard skips detection, so wrap launches with `env -u NO_COLOR`.
- Model end-to-end needs credentials available in the disposable `DSH_HOME`.
  Never inspect or display credential contents; copy files from a real profile
  into the isolated test home only when the user explicitly authorizes those
  exact inputs.

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

# send a command (two steps: the delay only waits for the prompt to be ready)
tmux send-keys -t demo -l "/settings"
sleep 0.4
tmux send-keys -t demo Enter

tmux kill-session -t demo 2>/dev/null              # cleanup
```

## Task Quick terminal check

Use this only after the corresponding headless interaction/geometry tests pass. Follow **Environment prep**: use a fresh disposable worktree-local `DSH_HOME` with a test profile that links the worktree build; never reuse an isolated home containing old sessions. For a model-backed run, the authorized source inputs are `$HOME/.dsh/.credentials.yaml` and `$HOME/.dsh/profiles/pi-tui-dev/cordis.patch.yml`; copy only after explicit authorization for those exact files, preserving mode `0600` for credentials. Do not copy the whole profile or `sessions/`, `storages/` and `user-history/`; configure test-only options in the isolated home as needed. Never read or print copied contents. Save evidence under a private worktree `temp/` directory and report the artifact paths/status in the PR review record, not as a durable pass claim in this procedure.

1. Start a bounded background task using the existing real-model procedure below (for example, `sleep 20 && echo slow-done`, with `run_in_background=true`). Capture a plain and ANSI pane before opening Quick. The Main view must keep Quick hidden and preserve the Footer badge.
2. Use a **non-empty** multi-line draft with the cursor on its final visual line. Send one effective `Down`; capture the frame and verify the physical order `Editor → widgetsBelow (if any) → complete Footer → Quick-owned divider (if spare) → Quick identity/items`. The Footer must keep every prior row. Send `Esc`, capture again, and verify the draft/cursor return and no stale Quick rule or blank reservation remains.
3. Repeat in the real Fullscreen profile. Count the actual painted Quick rows (including divider/identity) rather than inferring a grant from window size. Exercise same-task-row SGR press/release, then negative clicks on the divider, identity/header and Footer badge; use a release on a different row and a resize-before-release as stale-intent negatives. A wheel over Quick may move only its window; a wheel over Footer/Transcript must not be intercepted by hidden Quick.
4. Check Todo/Dock hit geometry at **actual** Quick heights 0, 1 and 5 when the size/task/widget configuration can produce them. Keep Footer and Editor intact; Fullscreen must retain a visible Transcript row. The ordinary Main Root keeps its historical flowing-document/widget grant: at 80×8 its Transcript may be outside the current viewport, but Quick must not make that worse or reduce the grant. Do not call a case “height 1” or “height 5” unless those exact physical rows are visible. Click the Todo/Dock row and a neighboring non-target row in each case.
5. For a parked Question, first capture the actual Quick height (0/1/5), then activate the Question through its normal owner. Wait for Quick to retire and the new Question frame to paint at Quick height 0 before clicking an option; verify the option and an outside-frame negative control. This is a **height-transition** witness (1→0 / 5→0), not Quick and Question coexisting. Do not force a forbidden focus state to create a same-frame test.
6. At minimum capture Main and Fullscreen at 80×24, short 80×10/80×9/80×8 frames, and 44×20 with CJK/soft-wrapped input. Also vary Footer full/compact/custom and public below-widget occupancy when the environment permits. At 80×8 Main, record the accepted flowing-root exception: the Transcript may be outside the viewport while hidden/denied Quick preserves the historical widget grant, and it must reappear when the viewport grows; the matching Fullscreen case must retain a visible Transcript row. Save both `tmux capture-pane -p` and `tmux capture-pane -e -p` before/active/after frames; record unsupported/unrun items as `NOT_RUN`, and never substitute `VirtualTerminal` output for this real-terminal evidence.

## Theme color verification

Convert the ANSI capture to HTML and inspect colors in a browser:

```sh
node scripts/tmux/ansi2html.mjs /tmp/pane.ansi /tmp/pane.html "stage name"
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
restart): `bash scripts/tmux/tui-demo.sh`; artifacts land in the script's
private `/tmp/tui-demo.XXXXXX/` (`.txt` plain + `.html` colored).

## Real model end-to-end (background tasks, subagents, guard)

1. Launch the TUI and send a message to create a session (the first message
   triggers deferred session creation; `Reply with exactly: pong` verifies
   connectivity first).
2. **Background bash job**: have the model run
   `Run this in the background: sleep 20 && echo slow-done. Use the bash tool with run_in_background=true, do not wait.`
   Verify: the dock's semantic `❯ bash-1 · …` row, the footer's
   `[N tasks running · ↓ view]` badge, `↓` entering focused Task Quick while
   running, Enter showing the output viewer, and the completion notification
   being handled by the model.
3. **Subagent viewing — mode-aware**: `/tasks` → the subagent rows must
   read `subagent · <label> · continuable` / `· one-shot` (mode is part of
   the label; a long label truncates, the mode never does). Enter on a
   **continuable** child opens the INTERACTIVE viewer:
   - the header keeps the MAIN session title and the subject bar under it
     shows the child identity (`‹ back  <label>  ● running  <provider/model>`),
     the empty editor shows the `Message <label>… — Enter send · Esc back`
     placeholder, and your main-session draft is preserved;
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
   (see `docs/architecture/input-history.md`). Verify the file exists:
   `ls $DSH_HOME/user-history/` (md5(cwd) filenames).
3. **Legacy migration**: use an isolated pre-upgrade history fixture; never seed or inspect a live profile. Verify the migrated JSONL output through the regression test.

Note: whether the model registers a subagent in the jobs registry depends on
it passing `run_in_background: true` (both local runs took the continuable
path). Since the task browser now merges RUNNING one-shot children too, a
foreground delegation (`run_in_background: false`) shows as a `🤖` dock row
and arms the badge while it works, even without any job record; the
background-one-shot double row (job row + child row) is expected, see
domain/task/browser.ts.

## Completion notifications and terminal focus

The TUI enables terminal focus reporting (`CSI ? 1004`) at mount for the
completion notification policy: the main agent's settlement notifies only
while the terminal is UNFOCUSED (default `mode=unfocused`; `mode=always`
notifies regardless, `mode=off` disables — `/settings → Notifications`).

Manual acceptance under tmux:

1. `tmux set -g focus-events on` — tmux must FORWARD focus events to the
   pane (the option is off by default on some tmux versions; zellij and
   other multiplexers have their own toggle). Without forwarding, the
   tracker stays `focused` (the safe default — **no false notifications**,
   but also no unfocused notifications; use `mode=always` for such
   environments).
2. Run a long turn, then switch to another pane/window BEFORE it settles.
   Expected: exactly ONE notification when the main agent finally goes
   idle (never mid-turn, never per `turn/end`, never for subagents).
3. Run a turn while KEEPING the TUI focused. Expected: silent.
4. Queue a follow-up mid-turn and switch away: still exactly one
   notification at the final settle, nothing at the intermediate turn
   boundary.

## Trap list (every item hit in real testing)

1. **A batched Enter must submit**: `send-keys 'text' Enter` is a valid way
   to send a command and must submit the draft — the per-character paste
   heuristic that used to turn that trailing Enter into a newline is retired
   (DIVERGENCES.md X038), so verify a rapid typed/pasted burst followed by
   Enter submits exactly once. The two-step `send-keys -l 'text'` →
   `sleep 0.3+` → `send-keys Enter` rhythm used above is still the reliable
   way to drive the CLI, but its pacing only waits for the prompt/UI to be
   ready.
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
 7. **Theme demo isolation**: `scripts/tmux/tui-demo.sh` creates a fresh
    worktree-linked `DSH_HOME`, persists theme changes through the UI, and
    keeps captures plus the temporary profile in a private output directory.
    It never reads or writes the real profile; the script owns tmux cleanup.
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
 11. **Recheck the disposable profile before each capture**: prior test state
     can persist across launches and change theme, Footer density or Fullscreen.
     Use a fresh isolated home or reset options through the UI before retesting.
12. **tmux does not forward focus events by default on all versions**: the
    completion notification's `mode=unfocused` silently never fires when
    the multiplexer eats the focus reports. Either `set -g focus-events
    on` (tmux 2.9+) or use `mode=always` — the TUI never guesses, so an
    environment without forwarding under-notifies by design (safe
    default).
13. **The inline TUI leaves the launch echo on screen** (no alternate
    screen): a scripted pane capture sees BOTH the TUI frame and the echoed
    launch command, so a "mounted" matcher must discriminate three states
    that all contain the session id — the echoed `--session <id>` launch
    line, the welcome card's padded label row (`session  <id>`, two
    spaces), and the post-exit `To resume this session: … --session <id>`
    banner. Route the id through a shell variable so the echo carries the
    variable NAME, not the value: `TUI_E2E_SESSION=<id> && dsh … --session
    $TUI_E2E_SESSION` (see `scripts/e2e-ownership.sh` `launch_tui`).
14. **zsh does not word-split `${VAR:+--flag $VAR}`**: the composed flag
    arrives as ONE argv element and commander reports `error: unknown
    option '--session <id>'`. An `env VAR=x cmd ${VAR:+…}` prefix does not
    help either — the shell expands before `env` runs, so the variable is
    still unset. Use a separate assignment statement plus a bare `$VAR`
    reference (safe for single-token ids).
15. **npm and pnpm name the running dsh process differently**: an
    npm-installed `.bin/dsh` is a shim script, so the process reads
    `node …/node_modules/.bin/dsh …`; a pnpm symlink reads
    `node …/@deepseek-ai/dsh/lib/bin.js …`. A pgrep anchor that only
    accepts one layout silently finds no PID, the scripted `kill -9` kills
    nothing, and every later case cascades with `SessionAlreadyOwnedError`
    (hit for real in the ownership E2E). Anchor both:
    `pgrep -f "^node .*(dsh/lib/bin\.js|\.bin/dsh) --profile <name>"`.
16. **`pkill -f` can match the driver's own command line**: a cleanup
    pattern that literally appears in your own shell command (the script
    path, or the pattern text itself) kills your own run with SIGTERM and
    looks like a mystery abort. Kill by recorded PID, or use the bracket
    trick (`e2e-ownershi[p]`) so the pattern does not match its own text.

## Scripts

- `scripts/tmux/ansi2html.mjs` — ANSI capture → colored HTML
  (`node … <in> <out> [title]`), tested by `test/tmux/ansi2html.test.mjs`.
- `scripts/tmux/tui-demo.sh` — full theme demo (dark → light COLORFGBG
  detection → UI switch → persisted-theme restart → settings restore), tested
  by `test/tmux/tui-demo.test.mjs`.


## Focus replay harness

Replay rerun (headless artifact; Focus ON, fullscreen ON, every outer Thought
root expanded, Thinking detail at default compact, `followingEnd=true`, and
production flush `coalesced` — `perevent` is not production-faithful):

```sh
REPLAY_SOURCE=session REPLAY_SESSION=<v3.jsonl> REPLAY_TURN=<n> \
  REPLAY_HISTORY=<turns> REPLAY_CADENCE=wallclock \
  node --import tsx/esm scripts/focus-replay-probe.mts
```

Whole-turn shape adds `REPLAY_TURN_MODE=interleaved` (requires
`REPLAY_SOURCE=session`). Real terminal: `REPLAY_TERMINAL=1 REPLAY_LOG=<file>`.
The screen oracle runs only over a headless `REPLAY_SYNC=on` artifact:

```sh
node scripts/focus-screen-holes.mjs <artifact.json> [--dump]
```

- A real-terminal artifact has no xterm screens and `REPLAY_SYNC=off` strips
  `?2026` markers, so the oracle must report `usable:false` and exit non-zero
  rather than print a vacuous `holes=0`.
- `osculationRuns` / `answerDisappearancePaints` are marker-based (the marker
  also occurs in the streaming reasoning tail), so the screen oracle is
  authoritative for actual visibility. The busy glyph animates on wall-clock and
  is masked out of comparison hashes. The automated Thought-expansion phase is
  precondition work; the oracle reports shifts, not holes. A terminal buffer
  read after each frame cannot see compositor tearing.
- Acceptance: repeat the timing-sensitive run and require
  `liveBlockMissingPaints = 0` and zero `contentHeight` single-frame drops ≥ 10
  rows in EVERY run, with artifacts `usable` and `metrics.paintDetail: true`
  (paint detail off records those metrics as `null`). `abaAlternations` is a
  diagnostic, not a gate. The deterministic in-tree guard is
  `test/tui/focus-mounted-batch-refresh.test.ts`.
- Never use `perevent` for conclusions or treat a non-qualified run as evidence;
  never read a masked glyph difference as a regression; never report multiplexer
  pane-buffer evidence as physical-compositor proof.

## Visual measurement method

`vt.getViewport()` carries NO SGR, so a colour claim can only come from cell
read-back (`getCellFgRgb`/`getCellBgRgb`), never from the viewport string. The
reverse token map is ambiguous by construction (`textMuted` == `diffGutter`,
`textDim` == `diffMeta`, `success` == `diffAdded`, `error` == `diffRemoved`,
`warning` == `borderFocus`), so a measured hex identifies a VALUE only — confirm
the token at the source line that paints it.

Reproducible visual acceptance:

- Build first (`packages/pi-tui/dist` is an input).
- Drive the real composition at the frozen matrix
  (`200×50, 120×40, 100×40, 80×24, 80×10, 72×24, 44×20` plus one CJK case),
  dark/light/custom palettes, `iconStyle` symbols/minimal, and include a LIVE
  resize path.
- Real-TTY evidence uses `tmux capture-pane -e` on an isolated `DSH_HOME`/
  throwaway profile linking the worktree (never the real `pi-tui` profile) and
  decodes per-cell ink from the pane.
- Report only states actually run: an unrun size/claim is `NOT_RUN`, never PASS.
  Owner visual acceptance is independent of CI/headless.
