# dsh-pi-tui Tern GUI-window debugging

> **This guide owns the REAL GUI WINDOW lane.** The headless lane is owned by
> [`tern-pane-testing.md`](./tern-pane-testing.md); the terminal lane by
> [`tmux-testing.md`](./tmux-testing.md). This one owns the third mode: a
> **real Tern GUI window on a real display**, with the native OS chrome, the
> real font stack, a real pointer and the client's own accessibility tree.
>
> It is the lane that answers the questions **no headless run can answer**:
> hover, the dark theme, the native window, and what a screen reader sees.

## When to use it, and when not

| Question | Headless (`tern serve`) | **GUI (this guide)** |
|---|---|---|
| Does the node tree carry the right nodes? | ✅ the cheapest lane | ✅ |
| Does a click reach the handler exactly once? | ✅ via the control channel | ✅ via a **real pointer** |
| **What does HOVER paint?** | ❌ **the control channel has no hover** | ✅ **this lane** |
| **What does the DARK theme look like?** | ❌ | ✅ **this lane** |
| **What does the real OS window look like?** | ❌ | ✅ **this lane** |
| **What does a SCREEN READER see?** | ❌ | ✅ **this lane** (`a11y`) |
| Is the layout right at a given size? | ✅ | ✅ (but slower to set up) |
| Is the *program's* logic right? | ✅ prefer the headless lane | ❌ |

**Prefer the headless lane for logic and this lane for pixels, hover, theme and
accessibility.** The GUI lane needs a display and a window; the headless lane
needs nothing but the Tern CLI.

## What you need

- **A display.** On WSLg, `DISPLAY=:0` is already there and the geometry is
  real (`xdotool getdisplaygeometry` reports it). On a headless box, use
  `Xvfb` — but note that a virtual display is still a real X server, so
  hover/theme/a11y all work; only the OS window chrome is synthetic.
- **The Tern CLI** on `PATH` (or `TERN_BIN` pointing at it). The window is
  started by the CLI itself: `tern --control <socket>`.
- **An isolated Tern profile.** The window MUST run with its own
  `TERN_CONFIG_DIR` and `TERN_DAEMON_SOCKET`, or it will read and write the
  user's real Tern settings, plugins and daemon. The driver does this for you.
- **A subject that renders a TSP surface.** A TSP surface is what a **program
  inside a pane** renders: the GUI window is a terminal multiplexer, so the
  subject has to run *in a pane*, not in the window's chrome.

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
| The native picker's action bar is exposed to a screen reader as `Button` roles **with accessible names** | ❌ | ✅ |
| A **hover** is a **computed-style** change, not a class change | ❌ | ✅ |

The hover is the case that changes how a check must be written: the client's
node tree exposes **no hover class**, so a GUI check that watches the class
list would report "no hover state" and be **wrong**. The hover is visible in
the computed style (`dump`): the primary action's background changes from
`rgb(59,59,59)` to `rgb(101,101,101)` under the pointer.

## The two drivers

| | Headless driver | **GUI driver** |
|---|---|---|
| Command | `node scripts/tern-pane-drive.mjs <flow.mjs>` | `node scripts/tern-gui-drive.mjs <flow.mjs>` |
| Client | `tern serve --control EP` (headless) | `tern --control EP` (a real window) |
| Run directory | `temp/tern-pane-XXXXXX` | `temp/tern-gui-XXXXXX` |
| Subject start | `./launch.sh` typed into the server's cwd | the client's `run` world command, into the **focused pane** |
| Screenshots | `shots/serve/<id>.png` in the run directory | the client writes them into its own `target/shots/tern/live/` — the driver **copies** them into `<run>/shots/` |
| Hover | ❌ none | ✅ `move X Y` |
| Theme | ❌ | ✅ `theme dark <name>` |
| Accessibility tree | ❌ | ✅ `a11y` |

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

  // The pointer, the click, the hover, the theme, the a11y tree.
  const snap = h.snapshot()
  const target = snap.nodes.find((n) => n.tag === 'button')
  await h.hover(snap.chains, target)   // a REAL pointer move
  await h.click(snap.chains, target)   // a REAL pointer click
  h.ctl('theme', 'dark', 'titanium')  // the CLIENT's own theme
  const a11y = h.ctl('a11y')           // what a screen reader sees
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
**positive control** for a real input:

- read the run directory from `TERN_PANE_DIR`;
- record what actually arrived in `events.jsonl` there;
- exit on F10.

## The GUI handle

| Member | Does |
|---|---|
| `ctl(...)` | a control command (`tree`, `stats`, `dump`, `a11y`, `system`, `pick`, `layers`, `perf`, `resize`, `theme`, `shot`, …) |
| `send(...)` | a command delivered **once** and never retried (`click`, `key`, `move`, `run`) |
| `snapshot()` | the client's real node tree, indexed (`{nodes, chains}`) |
| `vis` / `texts` / `has` / `classNodes` / `descendantsText` | tree queries |
| `key` / `resize` / `click` / `clickAt` / `hover` | real input |
| `capture(name, note)` | the node tree + a PNG + the layout under one id |
| `check(label, ok, detail)` / `measure(label, detail)` | an assertion / a measurement |
| `finish(extra)` | the ledger, and the process exit code |

## The GUI-specific commands

These are the ones that make the lane worth its extra setup.

| Command | What it gives the headless lane cannot |
|---|---|
| `move X Y` | **the real pointer**, without clicking. `stats.pointer` follows it. This is the ONLY way to get a hover. |
| `resize` | the window's **content** size. A REAL WINDOW HAS A MINIMUM SIZE: the client clamps a narrow request (measured: **720px** wide on this build), so a 400px pane is not reachable in the GUI. The driver **reports** the clamp (`{requested, viewport, clamped}`) instead of failing on it — a clamped measurement must be visible, not silently applied. |
| `click X Y` | a real pointer click on the window. The reply names the element that took the focus. |
| `theme dark <name>` / `theme light` | the **client's own** appearance. The theme names come from `ctl state` (`theme_dark`). |
| `a11y` | the **accessibility tree**: every node's role, name, bounds and actions. This is what a screen reader reads. |
| `dump` | every element's path, box and **computed style** (background, color, radius, font). The hover state lives HERE, not in the class list. |
| `system` | the window's own info: the title, the displays, the dialogs, the file associations, the input-monitor state. |
| `pick X Y` | what is really at a point. |
| `layers` | the last frame's compositing layers in paint order. |
| `perf on\|off\|reset\|mark\|since` | the client's own frame timing. |
| `state` | the window's own state JSON (tabs, panes, focus, the theme). |

## Rules that keep the evidence honest

- **A hover is a COMPUTED STYLE, not a class.** The client's tree exposes no
  hover class: the class stays the same before and after the pointer moves.
  The hover shows up in `dump` (the background changes). **A GUI hover check
  that watches the class list is a false negative** — measure the computed
  style.
- **A DISABLED control is not readable.** The client's own disabled picker
  action is a grey pill whose **label is invisible**; the reason survives only
  in the `title` attribute. A GUI capture that shows "the button is there" is
  not evidence that the user can read it.
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
  its own theme, its own font stack, its own window. A claim made in the GUI
  is at the `REAL_TERN_GUI` tier, and it does not automatically cover the
  headless lane.

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

## Scripts

The lane's own pieces:

| Piece | What it is |
|---|---|
| `scripts/tern-gui-drive.mjs` | the GUI driver (the window, the control channel, the real input, the run directory) |
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
