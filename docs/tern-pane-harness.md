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
| `scripts/tern-pane-geometry.mjs` | The visibility oracle: boxes, clipping ancestors, the visible click point. Pure, covered by `test/tern-pane-geometry.test.mjs` |
| `scripts/tern-pane-instrument.mjs` | The instrument's own rules: which directory it may wipe, which commands may be repeated, how paths are quoted into the generated script. Pure, covered by `test/tern-pane-instrument.test.mjs` |
| `scripts/tern-pane-smoke.mjs` + `-smoke-subject.mts` | The committed smoke: the worked example, and the check that the driver still works end to end |
| Your **flow** module | What to drive and what to assert. It receives the harness handle |
| Your **subject** `.mts` | The UI under test, mounted in a real pane by `harness.launch` |

```sh
node scripts/tern-pane-drive.mjs <flow.mjs> [--out <dir>]
```

Artifacts land in `<repo>/temp/tern-pane` by default (gitignored); `--out` or
`TERN_PANE_OUT` moves them. **The run directory is wiped at start**, so the driver
only takes over a directory that is absent, empty, or already carries its own
marker (`tern-pane-run.json`). It refuses the repository, its ancestors, the
working directory, home, and any other non-empty directory it does not own —
point `--out` at a fresh or harness-owned path:

```sh
mkdir -p /tmp/not-ours && touch /tmp/not-ours/keep.txt
node scripts/tern-pane-drive.mjs scripts/tern-pane-smoke.mjs --out /tmp/not-ours
# refuses, exits 1, and leaves keep.txt in place
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
the marker you name. Follow the three conventions of `-smoke-subject.mts`: read the
run directory from `process.env.TERN_PANE_DIR`, record what actually happened there
so the flow can read it back as its positive control, and exit on F10.
```

The subject owns its own artifacts (here, nothing; the harness owns the rest).
Write them under `process.env.TERN_PANE_DIR` and the flow can read them back —
that is how the example proves the click really ran the handler, instead of
inferring it from a redraw.

## The harness handle

| Member | Does |
|---|---|
| `snapshot()` | The REAL node tree, indexed: `{ nodes, chains }`. `chains` maps a node to its ancestor chain |
| `vis` / `texts` / `has` / `textNode` / `classNodes` / `descendantsText` | Tree queries |
| `waitFor(text)` | Poll until text appears (subject readiness) |
| `launch(subject, { ready })` | Start the subject and wait for its marker |
| `ready` | Whether the control server answered; the driver refuses to run a flow without it |
| `key` / `resize` / `css` / `clickAt` / `click` | Real input to the pane |
| `capture(name, note)` | Node-tree dump + PNG + layout under one id |
| `shot(id)` | Raw `shot` reply |
| `ctl(...)` | An inspection or idempotent command (`stats`, `pick`, `dump`, …); a real input sent here is refused |
| `check(label, ok, detail)` / `measure(label, detail)` | Record an assertion / a measurement |
| `finish(extra)` | Write `assertions.json`, print the summary, return the exit code |
| `log` / `sleep` / `root` / `repo` | Run log, delay, run directory, repo root |

## Artifacts

| Path (under the run directory) | What |
|---|---|
| `run.log` | The command line, the Tern version, every control command with its outcome (`CTL ok` / `SEND ok` / `CTL-RETRY` / `CTL-FAIL`), every assertion, measurement and capture, in order |
| `assertions.json` | The ledger plus the Tern version and flow path; `failed` counts assertions only |
| `flow.<ext>` / `subject.<ext>` | Copies of the flow and of the subject this run used |
| `tern-pane-run.json` | The ownership marker that makes this directory safe to wipe on the next run |
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
  Reads and idempotent sets (`tree`, `shot`, `resize`, `css`) may be retried,
  because a lost reply costs nothing. Read the subject's own record back when you
  claim a count: it is the positive control that the input really arrived.
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
- One pane, one subject per run.
- The run directory keeps a copy of the flow and of the subject it launched, so a
  run can be audited later; any other module they import is not copied.
- Client-side behaviour that no node exposes (physical IME, window chrome,
  theme resolution) is out of scope; see
  [`tmux-testing.md`](./tmux-testing.md) for the terminal-side complement.

## Related

- [`tmux-testing.md`](./tmux-testing.md) — the terminal/TTY complement.
- [`focus-replay-harness.md`](./focus-replay-harness.md) — the same shape for
  fullscreen frame replay: a probe script plus a pure oracle, documented here.
- [`tern-tsp.md`](./tern-tsp.md) — the TSP integration and its evidence ledger.
