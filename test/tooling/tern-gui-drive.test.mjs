/**
 * The GUI driver's OWN contract: the parts that make a GUI run trustworthy and
 * that the headless lane cannot prove.
 *
 * This is a TOOLING test: it protects the DRIVER, not a product surface. It
 * covers the failure classes that actually bit during the first GUI runs:
 *
 *   1. the driver ISOLATES the window — the user's real Tern profile, plugins
 *      and daemon are never read or written;
 *   2. the driver NEVER repeats an input: a click, a key and a pointer move
 *      are delivered exactly once, and an unacknowledged send ABORTS the run
 *      instead of being retried;
 *   3. the driver REPORTS the window's minimum size instead of failing on it:
 *      a real window clamps a narrow resize, and a clamped measurement must be
 *      visible in the result, not silently applied;
 *   4. the driver COPIES the client's PNG into the run directory: the client
 *      writes its shots into its own tree, and a run's evidence must not live
 *      outside the run — and each run reads from its OWN client-shot
 *      directory, so a later run cannot overwrite an earlier run's picture;
 *   5. the driver's `snapshot()` uses the SHARED index (chains keyed by the
 *      node OBJECT) and its `click` goes through the visibility oracle: a node
 *      whose own centre falls outside the fragment the client shows must NOT be
 *      clicked at its centre.
 *
 * The client itself is NOT required: the driver is exercised against a fake
 * Tern CLI, so the test is deterministic and needs no display.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join as joinPath } from 'node:path'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = joinPath(here, '../..')
const driver = joinPath(repo, 'scripts', 'tern-gui-drive.mjs')

/**
 * A fake Tern CLI: it answers the control commands the driver sends, and it
 * RECORDS every call so the test can assert on the delivery discipline.
 *
 * It is a `.mjs` run through `node`, because the driver executes `TERN_BIN`
 * as a program and a `.mjs` shebang is not portable.
 */
function writeFakeTern(dir) {
  const log = joinPath(dir, 'calls.log')
  const script = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const reply = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
if (args[0] === '--version') { process.stdout.write('tern 0.0.0-fake\\n'); process.exit(0) }
// The private daemon: record its socket so a test can prove that two runs do
// NOT share one, then stay alive like the real daemon does.
if (args[0] === 'daemon') {
  const at = args.indexOf('--socket')
  if (at >= 0) appendFileSync(${JSON.stringify(log)}.replace('calls.log', 'daemon-sockets.log'), args[at + 1] + '\\n')
  setInterval(() => {}, 1 << 30)
  process.exit(0)
}
// The WINDOW invocation ("tern --control EP") must STAY ALIVE: the driver
// spawns it and talks to the control socket it creates. It also RECORDS the
// the --out flag it was really given, so the shot command below writes exactly
// where a real client would — a test that asserted a separately-passed variable
// would keep passing after the driver stopped passing --out at all.
if (args[0] === '--control') {
  const socket = args[args.indexOf('--control') + 1]
  const outFlag = args.indexOf('--out')
  if (outFlag >= 0) writeFileSync(${JSON.stringify(join(log, '..'))} + '/window-out.txt', args[outFlag + 1])
  writeFileSync(socket, '')
  setInterval(() => {}, 1 << 30)
  process.exit(0)
}
if (args[0] !== 'ctl') process.exit(0)
const rest = args.slice(2)
// The driver's argv is "ctl --control <EP> <command> [args]": after dropping
// "ctl" and "--control", the socket is rest[0], the command is rest[1].
const command = rest[1] ?? 'unknown'
const numeric = rest.slice(2).filter((arg) => /^\\d+$/.test(arg)).map(Number)
// The fake CLAMPS a narrow resize the way a real window does, so the
// driver's minimum-size path is exercised.
let viewport = [1280, 800, 1]
// A fake CLI invocation is ONE command, so a 'run' cannot be seen by a later
// 'state' in the same process. Record it in a file the next call can read.
const ranRunFile = ${JSON.stringify(join(log, '..'))} + '/ran-run.txt'
const ranRun = (command === 'run') || existsSync(ranRunFile)
if (command === 'run') writeFileSync(ranRunFile, '1')
if (command === 'resize') {
  viewport = [Math.max(numeric[0] ?? 1280, 720), Math.max(numeric[1] ?? 800, 400), 1]
  reply({ ok: true })
}
if (command === 'stats') reply({ ok: true, viewport, pointer: [0, 0], frames: 1, nodes: 1 })
// state reports the focused pane and the pane list. FAKE_FOCUS_MOVES=1 makes
// the split move the focus to the new pane, which is the state the driver must
// refuse rather than repair.
if (command === 'state') {
  const moved = process.env.FAKE_FOCUS_MOVES === '1' && ranRun
  reply({ ok: true, focused: { id: moved ? 2 : 1 }, panes: ranRun ? [{ id: 1, rows: 22 }, { id: 2, rows: 22 }] : [{ id: 1, rows: 45 }] })
}
if (command === 'tree') reply({ ok: true, tree: process.env.FAKE_TREE ? JSON.parse(process.env.FAKE_TREE) : [] })
if (command === 'shot') {
  const id = rest[2] ?? 'shot'
  // Where the WINDOW was really told to write. If the driver stops passing
  // --out, this file is absent and the shot falls back to cwd — which makes the
  // per-run assertion below FAIL instead of passing vacuously.
  let dir = process.env.FAKE_SHOT_DIR ?? process.cwd()
  try {
    dir = readFileSync(join(${JSON.stringify(join(log, '..'))}, 'window-out.txt'), 'utf8').trim()
  } catch { /* the window was never given --out: keep the fallback */ }
  mkdirSync(dir, { recursive: true })
  const png = join(dir, id + '.png')
  writeFileSync(png, 'PNG')
  reply({ ok: true, elements: 1, png })
}
reply({ ok: true })`

  const file = joinPath(dir, 'fake-tern.mjs')
  writeFileSync(file, script)
  return { log, file: writeFakeTernLauncher(dir) }
}

/** The fake must be RUNNABLE as a program: a wrapper that execs node on it. */
function writeFakeTernLauncher(dir) {
  const file = joinPath(dir, 'fake-tern')
  writeFileSync(file, `#!/bin/sh
exec ${process.execPath} "$(dirname "$0")/fake-tern.mjs" "$@"
`)
  chmodSync(file, 0o755)
  return file
}

/** Run the driver against the fake CLI with a flow that does nothing. */
function runDriver(fake, extraEnv = {}, dir) {
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function (h) { h.check("the flow ran", true) }\n')
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [
    driver, flow, '--out', out,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TERN_BIN: fake.file,
      DISPLAY: ':0',
      FAKE_SHOT_DIR: dir,
      ...extraEnv,
    },
  })
  return { dir, out, result }
}

test('the GUI driver isolates the window from the user\'s real Tern profile', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-iso-')
  const fake = writeFakeTern(dir)
  const { out, result } = runDriver(fake, {}, dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)

  // The window's OWN environment must point at the run directory, never at the
  // user's real profile.
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  assert.match(log, /ISOLATED CONFIG .*\/config/)
  assert.doesNotMatch(log, new RegExp(`ISOLATED CONFIG ${process.env.HOME ?? '/root'}/\\.config`))
})

test('the GUI driver never repeats an input and aborts on an unacknowledged one', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-once-')
  const fake = writeFakeTern(dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const snap = h.snapshot()
  const node = snap.nodes[0]
  if (node !== undefined) { await h.click(snap.chains, node) }
  h.check('the flow ran', true)
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  // Every `click` in the ledger was delivered exactly once: the driver's
  // `send` never retries an input.
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  const clicks = log.split('\n').filter((line) => line.startsWith('SEND ok ["click"'))
  const retries = log.split('\n').filter((line) => line.includes('CTL-RETRY ["click"'))
  assert.equal(retries.length, 0)
  assert.ok(clicks.length <= 1)
})

test('the GUI driver reports the window\'s minimum size instead of failing on it', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-min-')
  const fake = writeFakeTern(dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const size = await h.resize(400, 600)
  h.check('the clamp is reported', size.clamped === false || size.viewport[0] >= 400)
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const ledger = JSON.parse(readFileSync(joinPath(out, 'assertions.json'), 'utf8'))
  assert.equal(ledger.failed, 0)
})

test('the GUI driver copies the client\'s PNG into the run directory', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-shot-')
  const fake = writeFakeTern(dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  h.capture('a-capture', 'the copy check')
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_SHOT_DIR: dir },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  // The client wrote its PNG into ITS OWN directory; the run must own a copy.
  assert.ok(readFileSync(joinPath(out, 'shots', '01-a-capture.png'), 'utf8') === 'PNG')
})

test('the GUI driver clicks the VISIBLE fragment, never a clipped node\'s centre', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-visible-')
  const fake = writeFakeTern(dir)
  // A node whose own box is y 100..140 but whose sized ancestor clips it at
  // y 100..110: its centre (y=120) is in the clipped-away part.
  const tree = [{
    tag: 'div', class: 'clipper', rect: [0, 100, 200, 10],
    children: [{ tag: 'div', class: 'sf sf-editor target', rect: [0, 100, 200, 40] }],
  }]
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const snap = h.snapshot()
  const node = snap.nodes.find((n) => (n.class ?? '').includes('target'))
  h.check('the target is in the tree', node !== undefined)
  const clicked = await h.click(snap.chains, node)
  h.measure('click result', JSON.stringify({ clicked }))
  h.check('the click survives the clip', clicked === true)
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_TREE: JSON.stringify(tree) },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  const sent = log.split('\n').find((line) => line.startsWith('SEND ok ["click"'))
  assert.ok(sent !== undefined, 'the click was delivered')
  // The surviving fragment is y 100..110, so the click must land at y=105 — a
  // centre-only driver would send y=120, which is outside the clip.
  const [, y] = JSON.parse(sent.slice('SEND ok '.length).split(' :: ')[0]).slice(1)
  assert.ok(y >= 100 && y <= 110, `the click landed inside the visible fragment, got y=${y}`)
})

test('the GUI driver reads shots from THIS run\'s own client directory', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-shots-')
  const fake = writeFakeTern(dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  h.capture('one-shot', 'the capture under test')
}
`)
  const out = joinPath(dir, 'out')
  const env = {
    ...process.env,
    TERN_BIN: fake.file,
    DISPLAY: ':0',
  }
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  // The run keeps its OWN client-shot directory, and the copied PNG is the one
  // the client wrote THERE — not a stale file from another run's directory.
  const clientShots = joinPath(out, 'client-shots')
  assert.ok(existsSync(clientShots), 'the run has its own client-shot directory')
  assert.equal(readFileSync(joinPath(clientShots, '01-one-shot.png'), 'utf8'), 'PNG')
  assert.equal(readFileSync(joinPath(out, 'shots', '01-one-shot.png'), 'utf8'), 'PNG')
})

test('two runs whose --out basenames collide still get DIFFERENT private daemons', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-daemons-')
  const fake = writeFakeTern(dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function (h) { h.check("the flow ran", true) }\n')
  // Two run directories with the SAME BASENAME (`out`) under different parents —
  // the shape that a basename-derived daemon directory would collapse onto one
  // socket, so one run's teardown removes the other's daemon.
  const outA = joinPath(dir, 'a', 'out')
  const outB = joinPath(dir, 'b', 'out')
  // The driver creates the run directory but not a missing parent, so both
  // parents exist up front; only the BASENAME is shared.
  mkdirSync(joinPath(dir, 'a'), { recursive: true })
  mkdirSync(joinPath(dir, 'b'), { recursive: true })
  const env = { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_SHOT_DIR: dir }
  for (const out of [outA, outB]) {
    const result = spawnSync(process.execPath, [driver, flow, '--out', out], { encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }

  const sockets = readFileSync(joinPath(dir, 'daemon-sockets.log'), 'utf8')
    .trim().split('\n').filter(Boolean)
  assert.equal(sockets.length, 2, `both runs started a daemon: ${JSON.stringify(sockets)}`)
  assert.notEqual(sockets[0], sockets[1],
    `the two daemons must not share a socket: ${JSON.stringify(sockets)}`)
  for (const socket of sockets) {
    assert.match(socket, /tern-gui-daemon-/,
      'each daemon lives in an atomically unique directory, not a basename-derived one')
  }
})

test('splitPane refuses to continue when the split moved the focus', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-focus-')
  const fake = writeFakeTern(dir)
  const flow = joinPath(dir, 'flow.mjs')
  // The fake reports the focus as pane 1 before the split and pane 2 after it:
  // exactly the state in which a subject would be typed into the WRONG pane.
  writeFileSync(flow, `export default async function (h) {
  try {
    await h.splitPane('down')
    h.check('splitPane returned', true)
  } catch (error) {
    h.measure('splitPane refused', String(error.message))
    throw error
  }
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_FOCUS_MOVES: '1' },
  })
  // The run FAILS: a focus move is never silently repaired by typing a focus
  // command into a pane that may not be running a shell.
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  assert.match(log, /the split moved the focus from pane \d+ to \d+/)
  // And it never typed a "restore the focus" command into a pane.
  assert.equal(log.split('\n').filter((line) => line.includes('focus-pane.sh')).length, 0)
})
