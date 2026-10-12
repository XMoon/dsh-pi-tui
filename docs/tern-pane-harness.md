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
| `scripts/tern-pane-geometry.mjs` | The visibility oracle: boxes, clipping ancestors, the visible click point. Pure, so it is covered headlessly by `test/tern-pane-geometry.test.mjs` |
| Your **flow** module | What to drive and what to assert. It receives the harness handle |
| Your **subject** `.mts` | The UI under test, mounted in a real pane by `harness.launch` |

```sh
node scripts/tern-pane-drive.mjs <flow.mjs> [--out <dir>]
```

Artifacts land in `<repo>/temp/tern-pane` by default (gitignored); `--out` or
`TERN_PANE_OUT` moves them. **The run directory is wiped at start** — never point
`--out` at something you want to keep.

## A flow and its subject

`temp/pane-check/flow.mjs` — the flow decides everything:

```js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export default async function (h) {
  await h.resize(400, 600)
  const booted = await h.launch(join(h.repo, 'temp', 'pane-check', 'subject.mts'), { ready: 'pane-check ready' })
  h.check('the subject boots inside a real Tern pane', booted)

  let snap = h.snapshot()
  const button = snap.nodes.find((n) => n.tag === 'button' && h.descendantsText(n).includes('Pick'))
  h.check('the Pick button is in the tree', button !== undefined)
  if (button === undefined) return

  const clicked = await h.click(snap.chains, button)
  h.check('a REAL pointer click runs the handler', clicked && h.has(h.snapshot(), 'picks=1'),
    h.texts(h.snapshot()).join(' | '))

  h.measure('viewport', JSON.stringify(h.ctl('stats').viewport ?? null))
  h.capture('pane-check', 'after one real click')
}
```

`temp/pane-check/subject.mts` — any program that mounts into a real pane. The
SDK routes a click to `html.button({ onClick })` for you:

```ts
import { connect, html, ui } from '@stencil-hq/tern'

const session = await connect({ app: 'pane-check', timeout: 2000 })
if (!session) throw new Error('run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'check' })

let picks = 0
const render = () => surface.render({
  main: ui.col({ key: 'main' },
    ui.text('pane-check ready'),
    ui.text(`picks=${picks}`),
    html.button({ onClick: () => { picks += 1; render() } }, 'Pick'),
  ),
})
render()
for await (const input of session) {
  if (input.type === 'key' && input.key.name === 'f10') break
}
await surface.close({ keep: false })
await session.close()
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
| `ctl(...)` | Any other control command (`stats`, `pick`, `dump`, `quit`, …) |
| `check(label, ok, detail)` / `measure(label, detail)` | Record an assertion / a measurement |
| `finish(extra)` | Write `assertions.json`, print the summary, return the exit code |
| `log` / `sleep` / `root` / `repo` | Run log, delay, run directory, repo root |

## Artifacts

| Path (under the run directory) | What |
|---|---|
| `run.log` | The command line, the Tern version, every `tern` exchange, assertion, measurement and capture, in order |
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
- **Click the fragment the client shows, on BOTH axes.** `harness.click(chains,
  node)` clicks the centre of the surviving fragment and returns `false` when
  less than 4px of it survive on either axis. A node's own centre can fall inside
  the clipped-away part — above or below the region — and land on whatever covers
  it, or be off screen entirely while the node still has width.
- **A command that did not run fails the run.** Commands sent before the server
  listens are dropped, so the handle resolves only after the server answers, and
  that cannot silently skip your first `resize`. A command that still fails logs
  `CTL-FAIL` and throws: a failed `tree` would otherwise read as an empty tree,
  and an empty tree makes "the control is absent" or "nothing was written" pass
  vacuously.
- **`shot` is software rendering at the client's scale.** A 400x600 viewport
  produces an 800x1200 PNG (scale 2); compare geometry from `layout.json` or the
  tree, not from pixel offsets in the PNG.
- **Say which state a lane ran against.** A run is evidence for the tree it ran
  on; an edit after it invalidates it.

## Limits

- It drives a subject **you** mount; it is not the real `dsh` application
  end-to-end. Writes are whatever your subject does at the seam it was given, so
  "nothing wrote" means nothing reached that seam.
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
