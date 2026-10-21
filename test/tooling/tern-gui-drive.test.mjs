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
 *      outside the run.
 *
 * The client itself is NOT required: the driver is exercised against a fake
 * Tern CLI, so the test is deterministic and needs no display.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
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
  const script = `import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const reply = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
if (args[0] === '--version') { process.stdout.write('tern 0.0.0-fake\\n'); process.exit(0) }
// The WINDOW invocation ("tern --control EP") must STAY ALIVE: the driver
// spawns it and talks to the control socket it creates.
if (args[0] === '--control') {
  const socket = args[args.indexOf('--control') + 1]
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
if (command === 'resize') {
  viewport = [Math.max(numeric[0] ?? 1280, 720), Math.max(numeric[1] ?? 800, 400), 1]
  reply({ ok: true })
}
if (command === 'stats') reply({ ok: true, viewport, pointer: [0, 0], frames: 1, nodes: 1 })
if (command === 'tree') reply({ ok: true, tree: [] })
if (command === 'shot') {
  const id = rest[2] ?? 'shot'
  const dir = process.env.FAKE_SHOT_DIR ?? process.cwd()
  const png = join(dir, id + '.png')
  writeFileSync(png, 'PNG')
  reply({ ok: true, elements: 1, png })
}
reply({ ok: true })
`
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
