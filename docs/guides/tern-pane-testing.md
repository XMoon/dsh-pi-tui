# dsh-pi-tui Tern real-pane harness

## When to use it, and when not

**Headless tests are the default** (`test/`, `@xterm/headless` drives real
rendering and input routing) and must cover every feature change.

**This harness is only for what headless cannot cover:**

| Scenario | Why the real client is needed |
|---|---|
| Layout, wrapping and clipping | Tern lays the native nodes out and clips them at an overflow edge; headless asserts our bytes, not the client's boxes |
| Real event shapes | The SDK's `action` / `select` / `strip` shapes are produced by the client, not by our presenter |
| Visual appearance | Whether a panel is readable at a given width/font is a property of the rendered PNG |

It is a **complement, not a replacement**: when a real-pane run surfaces a
problem, add the regression to the headless suite.

It is **not part of `pnpm test` and not in CI** — it needs an external Tern CLI
and it takes minutes. Run it deliberately, for acceptance evidence.

## What you need

- **A Tern CLI, provided by the operator.** This repository does not ship or
  install it. `TERN_BIN=<path>` selects a specific binary, otherwise `tern` must
  be on `PATH`. The driver runs `tern --version` first and refuses to continue
  without it, and records that version line in `assertions.json`, so every run's
  evidence says which client produced it.
- **`pnpm install`** — the locked `@stencil-hq/tern` devDependency (the SDK your
  subject renders through) and `tsx`.
- **`pnpm build` only if your subject imports the bundled `@xmoon76/pi-tui`**
  (`packages/pi-tui/dist` is a build input). A subject that imports `src/**`
  through `tsx` needs no build.
- The launch goes through a generated bash script, so this runs on Linux/macOS,
  not on Windows.

## The pieces

| Piece | Owns |
|---|---|
| `scripts/tern-pane-drive.mjs` | The driver: `tern serve` lifecycle, the control channel, real input, the node tree, captures, the run directory and the result ledger |
| `scripts/tern-pane-geometry.mjs` | The visibility oracle: boxes, clipping ancestors, the visible click point. Pure, covered by `test/tooling/tern-pane-geometry.test.mjs` |
| `scripts/tern-pane-instrument.mjs` | The two remaining rules: which commands may be repeated, and how a path is quoted into the generated launcher. Pure, covered by `test/tooling/tern-pane-instrument.test.mjs` |
| `scripts/tern-pane-smoke.mjs` + `-smoke-subject.mts` | The committed smoke: the worked example, and the check that the driver still works end to end |
| Your **flow** module | What to drive and what to assert. It receives the harness handle |
| Your **subject** `.mts` | The UI under test, mounted in a real pane by `harness.launch` |

```sh
node scripts/tern-pane-drive.mjs <flow.mjs> [--out <dir>]
```

Artifacts land in a **fresh** directory of their own under `<repo>/temp/`
(gitignored), named `tern-pane-XXXXXX`; `--out` or `TERN_PANE_OUT` names one
instead.

**Every run creates its own directory and deletes nothing.**

- By default the driver makes a new unique directory, so two runs never share one.
- `--out <dir>` names the directory *this* run creates: it must not exist yet, the
  parent must exist, and an existing path is refused (a missing parent is not
  filled in for you).
- The evidence — `assertions.json`, `run.log`, the node trees, the PNGs, the flow
  and subject copies — is **kept** after the run, on success and on failure alike.
  The driver never removes a run directory, and there is no `--force`, `--reuse`,
  `--clean` or takeover mode.
- Cleaning up old `temp/tern-pane-*` directories is the operator's call. They are
  not collected automatically: the disk space is the price of keeping the evidence.

```sh
mkdir -p /tmp/not-ours && touch /tmp/not-ours/keep.txt
node scripts/tern-pane-drive.mjs scripts/tern-pane-smoke.mjs --out /tmp/not-ours
# refuses, exits non-zero, and leaves keep.txt untouched
```

## Run the committed smoke first

`scripts/tern-pane-smoke.mjs` is the worked example and the end-to-end check of
the instrument itself: it resizes, launches `scripts/tern-pane-smoke-subject.mts`
in a real pane, sends a REAL pointer click and a REAL key, reads the subject's own
record back, measures the viewport and captures a PNG. Run it before trusting your
own flow:

```sh
node scripts/tern-pane-drive.mjs scripts/tern-pane-smoke.mjs
```

## A flow and its subject

The flow decides everything; read `scripts/tern-pane-smoke.mjs` for the full
shape. The essentials:

```js
export default async function (h) {
  await h.resize(400, 600)                                  // verified against stats.viewport
  const booted = await h.launch(join(h.repo, 'scripts', 'tern-pane-smoke-subject.mts'), { ready: 'pane-smoke ready' })
  h.check('the subject boots inside a real Tern pane', booted)

  const snap = h.snapshot()
  const button = snap.nodes.find((node) => node.tag === 'button' && h.descendantsText(node).includes('Pick'))
  h.check('a REAL pointer click on the visible fragment runs the handler',
    await h.click(snap.chains, button) && h.has(h.snapshot(), 'clicks=1'))

  await h.key('a', 700)
  h.capture('smoke-400x600', 'after one real click and one real key')
}
```

The subject is any program that mounts into a real pane through the SDK's
`connect()` and `surface.render`; the driver only runs it with `tsx` and waits for
the ready text you name. Follow the three conventions of `-smoke-subject.mts`: read the
run directory from `process.env.TERN_PANE_DIR`, record what actually happened there
so the flow can read it back as its positive control, and exit on F10.

The subject owns its own artifacts (in the smoke, its event record).

## The harness handle

| Member | Does |
|---|---|
| `snapshot()` | The REAL node tree, indexed: `{ nodes, chains }`. `chains` maps a node to its ancestor chain |
| `vis` / `texts` / `has` / `textNode` / `classNodes` / `descendantsText` | Tree queries |
| `waitFor(text)` | Poll until text appears (subject readiness) |
| `launch(subject, { ready })` | Start the subject and wait for its ready text |
| `ready` | Whether the control server answered; the driver refuses to run a flow without it |
| `key` / `resize` / `css` / `clickAt` / `click` | Real input to the pane |
| `capture(name, note)` | Node-tree dump + PNG + layout under one id |
| `shot(id)` | Raw `shot` reply |
| `ctl(...)` | A read or an idempotent set (`tree`, `stats`, `pick`, bare `a11y`, `perf since`, `shot`, `resize`, `css`); anything else is refused here — send it with `send` |
| `send(...)` | Any command, delivered exactly ONCE and never retried: `click`, `key`, `run`, `a11y <action>`, `perf on\|off\|reset\|mark` |
| `check(label, ok, detail)` / `measure(label, detail)` | Record an assertion / a measurement |
| `finish(extra)` | Write `assertions.json`, print the summary, return the exit code |
| `log` / `sleep` / `root` / `repo` | Run log, delay, run directory, repo root |

## Artifacts

| Path (under the run directory) | What |
|---|---|
| `run.log` | The command line, the Tern version, every control command with its outcome (`CTL ok` / `SEND ok` / `CTL-RETRY` / `CTL-FAIL`), every assertion, measurement and capture, in order |
| `assertions.json` | The ledger plus the Tern version and flow path; `failed` counts assertions only |
| `flow.<ext>` / `subject.<ext>` | Copies of the flow and of the subject this run used |
| `<id>.tree.json` | The node tree at capture time |
| `shots/serve/<id>.png` | The rendered pane — the human check |
| `shots/serve/<id>.layout.json` | Element paths, boxes and computed geometry for that frame |
| `launch.sh` / `subject.err` | How the subject was started, and its stderr |

## Rules that keep the evidence honest

- **An assertion can fail; a measurement cannot.** `check` is for claims the run
  must prove. A path the client does not render is a `measure` — never a pass —
  and a measurement is never allowed to substitute for an assertion.
- **A node's rect is not a visibility proof.** The client clips at an overflow
  edge, so a line that is present in the tree can be unreadable on screen. Use
  `containedXY` (both axes) or `containedX`/`visibleSpan` from
  `scripts/tern-pane-geometry.mjs`, and remember that clipping comes from
  ancestors: nest the measured node inside the box that clips it. A line that
  fits horizontally and falls past its region's bottom is the case that has
  produced a wrong "readable" claim before.
- **The oracle treats every sized ancestor as a clip — a deliberate, measured
  over-approximation.** Clipping really is style-driven, so a child can legally
  overflow an ancestor: on the eight real `/model` acceptance dumps, 200 of 10027
  ancestor relations had a child outside a sized ancestor (all of them the client's
  own window chrome, e.g. a `tn-pip-g` at x=-11 inside a parent at x=3). None of the
  80 real click targets was over-refused: the only two that fail full containment are
  genuinely clipped by the list scroller (22px of a 36px row survives) and still get
  a click point inside that fragment. The approximation errs towards refusing a
  click, which a flow reports as a failed assertion, never towards a false pass. If a
  flow must drive an intentionally overflowing child, identify the real clip from
  `ctl('layers')`, which reports `clip` per layer, instead of relaxing the oracle.
- **Click the fragment the client shows, on BOTH axes.** `harness.click(chains,
  node)` clicks the centre of the surviving fragment and returns `false` when
  less than 4px of it survive on either axis. A node's own centre can fall inside
  the clipped-away part — above or below the region — and land on whatever covers
  it, or be off screen entirely while the node still has width.
- **A command that did not run fails the run.** Commands sent before the server
  listens are dropped, so the handle resolves only after the server answers, and
  that cannot silently skip your first `resize` — which is also verified against
  `stats.viewport` afterwards, because every box is measured against it. A command
  that still fails logs `CTL-FAIL` and throws: a failed `tree` would otherwise read
  as an empty tree, and an empty tree makes "the control is absent" or "nothing was
  written" pass vacuously. A flow that throws is recorded as a failed
  `the flow ran to completion` and still writes the ledger, so a red run is as
  auditable as a green one.
- **A real input is delivered exactly once.** `click`, `key` and the subject
  launch are never retried — a repeat would be a SECOND real input while the run
  still claimed "exactly one", so an unacknowledged send aborts the run instead.
  Reads and idempotent sets may be retried, because a lost reply costs nothing.
  The split is on the WHOLE command shape, not the name: a bare `a11y` reads the
  accessibility tree, while `a11y click`/`a11y increment` act, and
  `perf on|off|reset|mark` restarts the collection. Read the subject's own record
  back when you claim a count: it is the positive control that the input arrived.
- **The launcher is one path-shaped token.** `run` takes exactly one argument and
  resolves it against the SERVER's cwd, so the driver starts `tern serve` inside
  the run directory and sends `./launch.sh`. Measured against the real client: a
  spaced absolute path is refused (`expected run <command>`), and double-quoting
  one is *accepted but starts nothing* — so a run directory containing spaces or
  quotes works only through the relative token. `css` is the opposite: its paths
  are split on whitespace and cannot contain spaces.
- **`shot` is software rendering at the client's scale.** A 400x600 viewport
  produces an 800x1200 PNG (scale 2); compare geometry from `layout.json` or the
  tree, not from pixel offsets in the PNG.
- **Say which state a lane ran against.** A run is evidence for the tree it ran
  on; an edit after it invalidates it.

## Limits

- It drives a subject **you** mount; it is not the real `dsh` application
  end-to-end. Writes are whatever your subject does at the seam it was given, so
  "nothing wrote" means nothing reached that seam.
- The client is a **headless** `tern serve`: it is the real client's rendering and
  control logic, not a mock, but it is not a desktop window. A green run says
  nothing about OS-level input methods, window focus or the fonts a desktop
  session resolves.
- One pane, one subject per run, and one run per directory.
- Run directories are never reclaimed automatically, so a long acceptance session
  accumulates them under `temp/`; deleting them is the operator's decision.
- The run directory keeps a copy of the flow and of the subject it launched, so a
  run can be audited later; any other module they import is not copied.
- Client-side behaviour that no node exposes (physical IME, window chrome,
  theme resolution) is out of scope; see
  [`tmux-testing.md`](./tmux-testing.md) for the terminal-side complement.

## Related

- [`tmux-testing.md`](./tmux-testing.md) — the terminal/TTY complement.
- [`tern-gui-testing.md`](./tern-gui-testing.md) — the real GUI-window lane:
  hover, the client's own theme, the native window and the accessibility tree.
- [`focus-replay-harness.md`](./tmux-testing.md) — the same shape for
  fullscreen frame replay: a probe script plus a pure oracle, documented here.
- [`tsp/overview.md`](../tsp/overview.md) — the TSP integration and product boundary.


## Lane fidelity and evidence rules

- A real-pane claim comes from `tern serve --control` + `tern ctl run|type|key|click|resize|tree|dump|shot|quit` with the production presenter. `ctl key` takes Playwright names; `ctl css` swaps a sheet.
- Irreversible input is delivered exactly ONCE and never retried. A failed `ctl` call fails closed.
- Containment goes through the geometry oracle (ancestor clipping + PNG); a node's own rect is not a visibility proof.
- The lane must reproduce production mount-time side effects; a hand-rolled surface that skipped the stylesheet install produced wrong evidence.
- Test counts are deliberately not recorded (they drift). A green lane/hash is valid only for the tree it names; inherited lanes are declared with why the delta does not touch their inputs.
- Never claim pointer/wheel/PageDown delivery where the control channel does not provide it; record the limitation as `NOT_VERIFIED`.
