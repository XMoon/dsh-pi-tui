# dsh-pi-tui Tern GUI-window debugging

> **This guide owns the REAL GUI WINDOW lane.** The headless lane is owned by
> [`tern-pane-testing.md`](./tern-pane-testing.md); the terminal lane by
> [`tmux-testing.md`](./tmux-testing.md). This one owns the third mode: a
> **real Tern GUI window on a real display**, with the native OS chrome, the
> real font stack and the client's own pointer/a11y state, driven through the
> control endpoint.
>
> It is the lane that answers the questions **only a real window can answer**:
> the native OS chrome, the desktop font stack and the window's real rendering.
> Its input is `CONTROL_INJECTED_INPUT`, not OS physical input; the `a11y` tree
> is the client's tree, not an OS screen-reader bridge. Physical input and an
> OS accessibility bridge require a separate operator-driven run
> (`OS_INPUT_VERIFIED`); otherwise record them `NOT_VERIFIED`.

## When to use it, and when not

| Question | Headless (`tern serve`) | **GUI (this guide)** |
|---|---|---|
| Does the node tree carry the right nodes? | ✅ the cheapest lane | ✅ |
| Does a click reach the handler exactly once? | ✅ via the control channel | ✅ via a **control-injected** pointer click |
| **What does HOVER paint?** | ✅ `move`/`hover` + `dump` (the headless driver has no helper) | ✅ a **control-injected** pointer move on the real window |
| **What does the DARK theme look like?** | ✅ `appearance dark` + `shot` (`theme dark <name>` picks the slot's theme) | ✅ `plugins run appearance:dark` (once, via `send`; or Preferences › Appearance › Dark) + `shot`; the harness `appearance` is a no-op in a live window |
| **What does the real OS window look like?** | ❌ | ✅ **this lane** |
| **What does the client `a11y` tree contain?** | ✅ the `a11y` tree | ✅ the same tree on the real window |
| **Does an OS screen reader read it?** | ❌ `NOT_VERIFIED` | ❌ `NOT_VERIFIED` (client tree only) |
| **Does the OS physical input path verify?** | ❌ `NOT_VERIFIED` | ❌ `NOT_VERIFIED` (control-injected only) |
| Is the layout right at a given size? | ✅ | ✅ (but slower to set up) |
| Is the *program's* logic right? | ✅ prefer the headless lane | ❌ |

**Prefer the headless lane for logic and for the client's own state — including
`move`/`hover`, the headless `appearance` switch and the `a11y` tree. Use this
lane for the real window and its live-window Appearance switch: the native OS
chrome, the desktop font stack and the client's rendering. The pointer/key input
is still `CONTROL_INJECTED_INPUT`; physical input and an OS screen reader remain
`NOT_VERIFIED`.** The GUI lane needs a display and a window; the headless lane
needs nothing but the Tern CLI.

## What you need

- **A display.** On WSLg, `DISPLAY=:0` is already there and the geometry is
  real (`xdotool getdisplaygeometry` reports it). On a headless box, use
  `Xvfb`. The client's control channel drives hover, the headless `appearance`
  switch and the `a11y` tree without any display (that is the headless lane);
  this lane needs the display for the real window, the desktop font stack and
  the native OS chrome. The driver's input stays control-injected; physical
  input devices and an OS screen reader are not exercised.
- **The Tern CLI** on `PATH` (or `TERN_BIN` pointing at it). The window is
  started by the CLI itself: `tern --control <socket>`.
- **An isolated Tern profile.** The window MUST run with its own
  `TERN_CONFIG_DIR` and `TERN_DAEMON_SOCKET`, or it will read and write the
  user's real Tern settings, plugins and daemon. The driver does this for you.
- **A subject that renders a TSP surface.** A TSP surface is what a **program
  inside a pane** renders: the GUI window is a terminal multiplexer, so the
  subject has to run *in a pane*, not in the window's chrome.

## Evidence tier

A GUI run is `REAL_TERN_GUI` for the window and its rendering, plus
`CONTROL_INJECTED_INPUT` for the pointer/key events. It is **not**
`OS_INPUT_VERIFIED`: the driver sends `click`, `key` and `move` through
`tern ctl`, not through an OS input device, and `a11y` reads the client's tree,
not an OS screen-reader bridge. Claim physical input or an OS accessibility
bridge only from a separate operator-driven run; otherwise record both
`NOT_VERIFIED`.

## What the GUI lane measured

The lane's first real run (client `tern 0.9.5 (2863c37)`, a WSLg X display at
1600×1000) produced these durable facts, each confirmed in BOTH lanes:

| Fact | Headless | GUI |
|---|---|---|
| The client's native picker action bar is a real `<button>` with a filled pill (`pk-btn primary`) | ✅ | ✅ |
| An OMP-style `row(role:'omp.btn')` paints as **blue accent text on a `div`** — a link, not a button | ✅ | ✅ |
| An `el('button')` paints as **plain text** with no chrome | ✅ | ✅ |
| The client does **not** enforce `disabled` on an `el` button: the click fires | ✅ | ✅ |
| A **disabled** picker action's label is **invisible** (the reason survives only in `title`) | ✅ | ✅ |

## The two drivers

| | Headless driver | **GUI driver** |
|---|---|---|
| Command | `node scripts/tern-pane-drive.mjs <flow.mjs>` | `node scripts/tern-gui-drive.mjs <flow.mjs>` |
| Client | `tern serve --control EP` (headless) | `tern --control EP` (a real window) |
| Run directory | `temp/tern-pane-XXXXXX` | `temp/tern-gui-XXXXXX` |
| Subject start | `./launch.sh` typed into the server's cwd | the client's `run` world command, into the **focused pane** |
| Screenshots | `shots/serve/<id>.png` in the run directory | the client writes them into its own `target/shots/tern/live/` — the driver **copies** them into `<run>/shots/` |
| Hover | ❌ no helper (the client accepts `move`/`hover`; send them) | ✅ `move X Y` (control-injected) |
| Appearance | ✅ `appearance`/`theme` via `send` | ✅ `plugins run appearance:dark\|light` (via `send`) + `theme` |
| Accessibility tree | ✅ bare `a11y` via `ctl` | ✅ `a11y` (client tree; no OS reader) |
| Input path | control channel | control channel (`send`); no OS input device |

The GUI driver is a **research-lane driver**: it is not part of `pnpm test` and
not in CI, because it needs a display. Its own contract is covered by
`test/tooling/tern-gui-drive.test.mjs`, which drives it against a fake Tern CLI
and needs no display.

## The flow and the subject

The shape is the same as the headless lane, with three differences.

```js
export default async function (h) {
  // The window is real: check the display before anything else.
  const system = h.ctl('system')
  h.check('the window is a real native window', (system.displays ?? []).length > 0,
    JSON.stringify(system.displays))

  await h.resize(1280, 800)
  const booted = await h.launch(subject, { ready: 'ready' })
  h.check('the subject boots in the GUI window', booted)
  if (!booted) return

  // The pointer, the click, the appearance, the a11y tree.
  const snap = h.snapshot()
  const target = snap.nodes.find((n) => n.tag === 'button')
  await h.hover(snap.chains, target)   // a control-injected pointer move
  await h.click(snap.chains, target)   // a control-injected pointer click
  const state = h.ctl('state')
  h.ctl('theme', 'dark', state.theme_dark)      // optional: the named dark theme
  h.send('plugins', 'run', 'appearance:dark')   // an ACTION: send once; `appearance dark` is a no-op here
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark')
  const a11y = h.ctl('a11y')                    // the client tree, not an OS reader
}
```

### The subject: it runs IN A PANE

The subject is the ordinary TSP subject: `connect()`, `session.open()`,
`surface.render()`. The only difference is **where it runs**.

The GUI window's `run` command **types a command line into the focused pane**,
so the subject must be started as a **one-token path** — a wrapper script, not
a command with arguments:

```bash
#!/bin/bash
export TERN_PANE_DIR=/path/to/run/dir
export TERN_CONFIG_DIR=/path/to/run/dir/config
export TERN_DAEMON_SOCKET=/path/to/run/dir/daemon.sock
export DISPLAY=:0
cd "$REPO" || exit 1
exec node --import tsx/esm "$REPO/scripts/…-subject.mts" 2>> "$PANE_DIR/subject.err"
```

`tern ctl … run <command>` takes **exactly one token**: a spaced absolute path
is refused (`expected run <command>`), and a quoted one is accepted but starts
nothing. The wrapper script sidesteps both.

### The subject's own contract

Unchanged from the headless lane, and it is what makes the subject's record the
**positive control** for the control-injected input:

- read the run directory from `TERN_PANE_DIR`;
- record what actually arrived in `events.jsonl` there;
- exit on F10.

## The GUI handle

| Member | Does |
|---|---|
| `ctl(...)` | a read or an idempotent set (`tree`, `stats`, `dump`, `a11y`, `system`, `pick`, `layers`, `perf`, `resize`, `theme`, `prefs`, `shot`, …). It retries, so do not send an action through it. |
| `send(...)` | a command delivered **once** and never retried: `click`, `key`, `move`, `run`, and actions such as `plugins run appearance:dark` |
| `snapshot()` | the client's real node tree, indexed (`{nodes, chains}`) |
| `vis` / `texts` / `has` / `classNodes` / `descendantsText` | tree queries |
| `key` / `resize` / `click` / `clickAt` / `hover` | control-injected input (no OS input device) |
| `splitPane(direction)` | splits the focused pane through the client's OWN `tern split`, run **inside** the window's pane against the run's private daemon; returns the client's pane list, and REFUSES to continue when the split moved the focus |
| `capture(name, note)` | the node tree + a PNG + the layout under one id |
| `check(label, ok, detail)` / `measure(label, detail)` | an assertion / a measurement |
| `finish(extra)` | the ledger, and the process exit code |

## The control commands this driver wraps

These are the client's own control and harness commands, not GUI-only
features: the headless client accepts the same control/harness family, and the
headless driver wraps a smaller subset. The GUI driver adds the REAL WINDOW:
control-injected pointer/key input, the window's real content size, the native
OS integration and the client's `a11y` tree. It does not add an OS input device
or an OS screen reader.

| Command | What the GUI driver adds |
|---|---|
| `move X Y` | **the client's pointer state**, moved through the control endpoint; not an OS input device. `stats.pointer` follows it. (The headless client also accepts `move` and `hover`; a headless flow sends them with `send`.) |
| `resize` | the window's **content** size. A REAL WINDOW HAS A MINIMUM SIZE: the client clamps a narrow request (measured: **720px** wide on this build), so a 400px pane is not reachable in the GUI. The driver **reports** the clamp (`{requested, viewport, clamped}`) instead of failing on it — a clamped measurement must be visible, not silently applied. |
| `click X Y` | a control-injected pointer click on the window. The reply names the element that took the focus; no OS input device is involved. |
| `appearance dark\|light` | the **headless** switch (the simulated system appearance). A live window accepts it but keeps its saved Appearance setting; it is not the GUI switch. |
| `plugins run appearance:dark\|light` | the **live-window** switch: the `appearance:dark`/`appearance:light` key action, the same setting the Preferences Appearance radio drives. Send it once with `send`; it is an action, not a retryable read. It saves the Appearance setting; prove `state.theme === 'dark'`. |
| `prefs appearance` / `prefs search dark` | the manual Appearance page: the Appearance radio (System / Light / Dark). A control-injected click on Dark/Light switches the window and saves it. |
| `theme [dark\|light] "<name>"` | a **named theme for an appearance**; a single argument is always a name, even `dark` or `light`. The names come from `ctl state` (`theme_dark`/`theme_light`). `theme dark <name>` alone does not switch a light client. |
| `a11y` | the client's accessibility tree; the headless client exposes the same tree. It is not an OS screen-reader bridge. |
| `dump` | every element's path, box and **computed style** (background, color, radius, font). The hover state lives HERE, not in the class list; the headless client reports the same computed style. |
| `system` | the window's own info: the title, the displays, the dialogs, the file associations, the input-monitor state. This queries the real OS integration; headless `system` is simulated. |
| `pick X Y` | what is really at a point; also available headless. |
| `layers` | the last frame's compositing layers in paint order; also available headless. |
| `perf` | the client's own frame timing: a BARE `perf` is the summary (frames, `idleFrames`, `drawnShare`, and the `cpu`/`thread`/`app`/`update` percentiles). `perf on\|off` toggles the collection, `perf mark` marks a point and `perf since` reports the frames after it (it needs a mark first). |
| `state` | the window's own state JSON: tabs, panes, focus, and the resolved appearance (`theme`) plus the named slots (`theme_dark`/`theme_light`). |

## Rules that keep the evidence honest

- **A LIVE WINDOW'S APPEARANCE IS A SAVED SETTING.** The harness `appearance`
  command is the HEADLESS switch: a live window accepts it, returns `{ok:true}`,
  and keeps the saved Appearance setting. The live switch is the
  `appearance:dark` key action (`plugins run appearance:dark`,
  `appearance:light`, sent once with `send`) or the Preferences › Appearance
  radio. Both save the setting; prove the switch with `state.theme === 'dark'`
  and `dump.header.theme === 'dark'`, never the reply.
- **A hover is a COMPUTED STYLE, not a class.** The client's tree exposes no
  hover class: the class stays the same before and after the pointer moves.
  The hover shows up in `dump` (the background changes). **A hover check that
  watches the class list is a false negative** — measure the computed style.
  The headless client reports the same computed-style change; this lane adds
  the real window, while the pointer move itself is control-injected.
- **A DISABLED control is not readable.** The client's own disabled picker
  action is a grey pill whose **label is invisible**; the reason survives only
  in the `title` attribute. A GUI capture that shows "the button is there" is
  not evidence that the user can read it.
- **VECTOR TEXT IS NOT A TEXT NODE.** A drawn graph (a Mermaid diagram, an SVG)
  paints its labels as vector content: the client's tree exposes the graphic's
  CHROME (`mermaid - graph`, `Source`, `Copy`, `Open`) and the graphic's
  element, but **not** the text inside it. The PNG is the evidence for the
  drawn content; the tree is the evidence for the chrome and the box.
- **THE SNAPSHOT MUST USE THE SHARED INDEX.** `snapshot()` returns
  `index(ctl('tree').tree ?? [])` — chains keyed by the NODE OBJECT, exactly as
  the headless driver returns them. A driver that keys chains by an id STRING
  makes `visiblePoint(chains, node)` find no chain, treat the node as having no
  sized ancestor, and report a CLIPPED node as clickable.
- **A NODE AND ITS CHAINS COME FROM ONE SNAPSHOT.** Because the index keys by
  node identity, `h.click(h.snapshot().chains, nodeFromAnEarlierSnapshot)`
  cannot resolve the node. The oracle now FAILS CLOSED with
  `this node is not part of the snapshot these chains index` instead of
  degrading to an empty ancestor list, so the bug surfaces on the first run
  rather than as a silently unclipped click.
- **A CLICK ONLY LANDS ON WHAT IS IN VIEW.** A surface that scrolls (a
  transcript, a long list) lays out its off-screen controls with real boxes,
  and a click on one lands on whatever covers it. The flow must address a
  control whose box is inside the viewport.
- **THE CLIENT VIRTUALIZES A LONG SURFACE.** At 500 rows the client's node
  count is IDENTICAL to 100 rows, and the visible window is the TAIL. A flat
  node counter is the client's virtualization, not lost content: prove the
  content by looking at WHICH rows are rendered.
- **A REAL click is still ONE click.** Deliver it with `send` (never retried)
  and prove it with the subject's own record, not with a redraw.
- **The window is a MULTIPLEXER.** A TSP surface is what a program **inside a
  pane** renders. A subject that starts outside a pane never connects.
- **Isolate the profile.** The window must run with its own `TERN_CONFIG_DIR`
  and `TERN_DAEMON_SOCKET`; otherwise the run writes the user's real Tern
  settings and plugins.
- **The GUI's `shot` writes to the CLIENT's own directory**
  (`target/shots/tern/live/<id>.png`), not to the run directory. Copy the
  artifacts into the run directory, or the evidence is lost with the tree.
- **A GUI run is not a headless run.** The GUI is a **different client mode**:
  the same control commands, but the window adds the native chrome, the desktop
  font stack and the client's `a11y` tree. Its appearance is a SAVED SETTING:
  the harness `appearance` command is not the live switch. Its evidence tier is
  `REAL_TERN_GUI` + `CONTROL_INJECTED_INPUT`, not `OS_INPUT_VERIFIED`; it does
  not automatically cover the headless lane, OS physical input or an OS screen
  reader.

## The trap list (every item hit in real testing)

1. **`run` takes ONE token.** A spaced path is refused; a quoted one starts
   nothing. Use a wrapper script.
2. **A subject that is not in a pane never connects.** The symptom is a
   subject that boots and then paints nothing.
3. **A region root must be a `ui.col`**, or the client paints an empty region.
4. **A native `picker` or `prefs` must be in the `layer` region.** In `main`
   the client lays the sheet out at a huge negative Y: the nodes are in the
   tree and the pixels are not.
5. **`ui.list` takes `item` CHILDREN.** The SDK's `ListProps` has no `items`
   prop, so `ui.list({items:[…]})` **silently renders nothing**.
6. **A `pk-row grp` is a group header**, not a row: clicking it does nothing.
7. **Clicking the ALREADY highlighted row is an `activate`**, not a `select`.
8. **The client does not enforce `disabled` on an `el` button.** Neither the
   SDK's prop nor `attrs.disabled` suppresses the click: the PROGRAM must
   refuse the write.
9. **A `missing` image is a FIXTURE signal, not a client limitation.** A
   truncated PNG (a corrupt `idat`) is reported as a missing image; a
   correctly generated one paints.
10. **The GUI's `shot` does not land in the run directory.** The client writes
    its PNG into its own tree; the driver copies it in.
11. **A REAL WINDOW HAS A MINIMUM SIZE.** The client clamps a narrow resize
    (measured: 720px wide on this build), so the GUI lane cannot reach the
    400px pane the headless lane uses. **A narrow-width question is a
    headless question.**
12. **`perf since` NEEDS A `perf mark` FIRST.** A bare `perf` is the summary;
    `perf since` without a mark is refused.
13. **AN SVG IS NOT THEMED BY THE CLIENT.** A drawn SVG keeps its OWN colours:
    its hardcoded background stays in the client's dark theme. Only the
    client's own widgets (`chart`, `picker`, `tool`) follow the theme.
14. **A WINDOW DOES NOT START A SESSION DAEMON.** `TERN_CONFIG_DIR` isolates
    the profile, but the window still attaches to the daemon already running
    for the user — so a `tern split` issued from a flow lands on the
    OPERATOR'S window (`@focused` is the pane they are working in) while the
    run's own control endpoint still reports one pane. MEASURED: `tern split
    @focused down` with no launch argument reports success and creates
    nothing; with a launch command it works, but only against the daemon whose
    pane it runs in. The driver therefore starts a PRIVATE daemon per run,
    points the window and every `ctl` at it, and runs `tern split` from INSIDE
    the window's pane (`splitPane`).
15. **THE DAEMON'S SOCKET NEEDS A PRIVATE, SHORT, UNIQUE PATH.** Its directory
    must be `0700` (`the socket needs a private directory`), and the socket path
    must stay under `SUN_LEN` (~107 bytes) — a run directory under `temp/` is long
    enough to trip `path must be shorter than SUN_LEN`. It must also be created
    ATOMICALLY: two runs whose `--out` basenames collide (`.tmp/a/out` and
    `.tmp/b/out`) would otherwise share one socket, and one run's teardown would
    remove the other's daemon. The driver therefore keeps it in the system temp
    dir under an atomically created unique name, the same way it creates the run
    directory itself.
16. **SPLIT AN EMPTY PANE, THEN LAUNCH.** Splitting a pane that already runs a
    live TSP subject silently produces no second pane; splitting an empty one
    works. The driver's `splitPane` is therefore called BEFORE `launch`.
    MEASURED: the client keeps the ORIGINAL pane focused after the split, so the
    focus needs no repair — and it must not be "repaired" by typing a focus
    command into a pane, because the new pane runs the keep-open placeholder, not
    a shell. `splitPane` ASSERTS the focus did not move and throws otherwise.
17. **`run` IS AN INPUT, NOT A REPEATABLE COMMAND.** `ctl('run', …)` TYPES a
    command line into the focused pane, so a retry would split/launch a second
    time. Both `launch` and `splitPane` deliver it with `send` (once, aborting an
    unacknowledged reply); success is decided by the ready marker or the pane
    list, never by the `run` reply.
18. **THE SHOT DIRECTORY IS SHARED ACROSS RUNS BY DEFAULT.** The client writes
    its PNG into its own tree and reuses the file names, so a later run
    overwrites an earlier run's picture while that run's ledger still names
    it. The driver passes `--out <run>/client-shots` so every run copies from
    its own directory.
19. **A GUI `click` AND `hover` NEED THE VISIBILITY ORACLE.** The driver's `click` uses
    `visiblePoint` from `tern-pane-geometry.mjs`: a node's own centre can fall
    outside the fragment the client shows (a short pane pushes the dock's
    editor past the pane's bottom edge), and clicking there lands on whatever
    covers it. `hover` uses the SAME oracle and returns `undefined` for a node
    that survives nothing: `stats.pointer` echoes any coordinate it was given, so
    `moved: true` never proved the pointer was over the target.
20. **A CAPTURE WITHOUT ITS PNG IS NOT A CAPTURE.** `capture()` throws when the
    client acknowledges the `shot` but no PNG lands in THIS run's
    `<run>/client-shots`. Silently returning an id would let a flow pass on
    evidence that does not exist, and falling back to a shared directory would
    make the picture's origin unknowable (a same-named stale file can sit there).
21. **`exit` HOOKS DO NOT RUN ON A DEFAULT SIGNAL EXIT, AND `kill()` IS NOT THE
    TEARDOWN.** A process killed with `SIGTERM` never runs its
    `process.on('exit')` hooks, and `child.kill()` only REQUESTS a signal: it
    says nothing about whether the private daemon, the window or the socket
    directory are gone. The driver installs ONE idempotent `SIGINT`/`SIGTERM`
    teardown that sends the stop request and WAITS for BOTH direct children to
    reach their ChildProcess `close`, then drops this run's socket directory,
    and only then re-raises the signal — removing this driver's OWN handlers by
    identity, because with a handler still installed `process.kill(self,
    signal)` simply re-enters it and the process lives on. A child that has not
    reached `close` within the bounded deadline is REPORTED and this run's
    socket directory is KEPT: an exit hook must never delete a directory a
    surviving child may still be using. The exit hooks are the last-resort
    fallback for an exit path the driver does not own.
22. **`theme` SELECTS A NAMED THEME, NOT THE APPEARANCE.** `theme dark <name>`
    changes the dark slot only; on a light client the resolved appearance stays
    light, and `theme dark` (one word) is a theme NAME, not the switch. In a
    headless run send `appearance dark`; in a live window send
    `plugins run appearance:dark` once with `send` (it is an action), prove
    `state.theme === 'dark'`, then capture.
    See [`tern-pane-testing.md`](./tern-pane-testing.md#appearance-and-theme).
23. **`appearance dark` IS A NO-OP IN A LIVE WINDOW.** The harness command
    returns `{ok:true}` but `state.theme` and `dump.header.theme` stay at the
    saved Appearance setting, and no visible element's computed style changes.
    The live switch is the `appearance:dark` key action (`plugins run
    appearance:dark`, `appearance:light`, sent once with `send`) or the
    Preferences › Appearance › Dark/Light radio. The action saves the setting;
    prove `state.theme`, never the reply.
24. **A `dump` WITH PREFERENCES OPEN CAN FAIL.** A `dump` issued while the
    Appearance search page was open was rejected (the driver exhausted its
    retries), and closing the sheet restored it. Read `state.theme` while the
    sheet is open, and take `dump`/`shot` after `prefs close`.

## Scripts

The lane's own pieces:

| Piece | What it is |
|---|---|
| `scripts/tern-gui-drive.mjs` | the GUI driver (the window, the control channel, the control-injected input, the run directory) |
| `scripts/tern-gui-smoke.mjs` | the committed smoke flow — the worked example, and the end-to-end check of the lane |
| `scripts/tern-gui-smoke-subject.mts` | the smoke subject (the GUI twin of `tern-pane-smoke-subject.mts`) |
| `test/tooling/tern-gui-drive.test.mjs` | the driver's own contract: isolation, one-input-once, the size clamp, the PNG copy — against a fake CLI, so it needs **no display** |

```sh
# the lane's positive control
DISPLAY=:0 node scripts/tern-gui-drive.mjs scripts/tern-gui-smoke.mjs

# the driver's own tests (no display needed)
node --test test/tooling/tern-gui-drive.test.mjs
```

The run's artifacts land in `temp/tern-gui-XXXXXX/`: `assertions.json`,
`run.log`, the subject's `events.jsonl`, the node trees, and the copied PNGs.

## Related

- [`tern-pane-testing.md`](./tern-pane-testing.md) — the headless real-pane
  harness, and the evidence rules that apply to both lanes.
- [`tmux-testing.md`](./tmux-testing.md) — the terminal/TTY lane.
- [`../tsp/foundation.md`](../tsp/foundation.md) — the TSP ownership contract
  and the evidence tiers.
