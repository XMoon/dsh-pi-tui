#!/usr/bin/env node
/**
 * Real-pane Tern driver: run a UI under test inside a real, headless Tern pane
 * and drive it with REAL pointer clicks and REAL keys.
 *
 *   node scripts/tern-pane-drive.mjs <flow.mjs> [--out <dir>]
 *
 * The flow module default-exports `async (harness) => { ... }`. It mounts its
 * own subject with `harness.launch`, drives it, and records what it observed;
 * every byte of the UI under test and every predicate about it belongs to that
 * flow. This script owns the parts that are the same for every check — the
 * `tern serve` control socket, the real input channel, the node-tree snapshots,
 * the captures, the run directory and the ledger — and nothing about `/model`,
 * a preset or any other surface.
 *
 * Two rules hold for every flow:
 *   - a node's own rect is NOT a visibility proof. The client clips at an
 *     overflow edge, so use `containedXY`/`visibleSpan` (see
 *     `scripts/tern-pane-geometry.mjs`) instead of comparing boxes by hand;
 *   - a claim is either an ASSERTION (`harness.check`, it can fail) or a
 *     MEASUREMENT (`harness.measure`, informational). A path the client does not
 *     render is a measurement, never a pass, and no assertion substitutes for
 *     another one.
 *
 * This driver is NOT part of `pnpm test` or CI: it needs the external Tern CLI
 * and it takes minutes. See `docs/tern-pane-harness.md`.
 *
 * env: TERN_BIN=<path>       the Tern CLI to drive (default: `tern` on PATH)
 *      TERN_PANE_OUT=<path>  artifact directory (default: <repo>/temp/tern-pane)
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { index, rect, visiblePoint } from './tern-pane-geometry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

function usage(exitCode) {
  console.log('Drive a UI under test inside a real, headless Tern pane.')
  console.log('')
  console.log('  node scripts/tern-pane-drive.mjs <flow.mjs> [--out <dir>]')
  console.log('')
  console.log('  <flow.mjs>            module default-exporting `async (harness) => {}`')
  console.log('  --out <dir>           artifact directory (default: <repo>/temp/tern-pane)')
  console.log('  TERN_BIN=<path>       Tern CLI to drive (default: `tern` on PATH)')
  console.log('  TERN_PANE_OUT=<path>  same as --out')
  process.exit(exitCode)
}

/**
 * The harness handle a flow receives: the control channel, real input, the real
 * node tree, captures, the subject launcher and the result ledger. It resolves
 * only once the server answers, so a flow's first command can not be lost to a
 * server that has not opened its socket yet.
 */
async function createHarness({ ternBin, root, socket = 'tern.sock' }) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'shots'), { recursive: true })
  const endpoint = join(root, socket)
  const log = (line) => appendFileSync(join(root, 'run.log'), `${line}\n`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // The control protocol is one command line, one JSON reply line. A reply that
  // is missing or `ok:false` is retried: the server answers `ok:false` while the
  // subject is still booting its first frame.
  function ctlOnce(...args) {
    const sent = spawnSync(ternBin, ['ctl', '--control', endpoint, ...args.map(String)], { encoding: 'utf8', timeout: 60_000 })
    if (sent.status !== 0) return undefined
    try {
      return JSON.parse(sent.stdout)
    } catch {
      return undefined
    }
  }
  function ctl(...args) {
    for (let i = 0; i < 6; i += 1) {
      const reply = ctlOnce(...args)
      if (reply !== undefined && reply.ok !== false) return reply
      log(`CTL-RETRY ${JSON.stringify(args)} :: ${JSON.stringify(reply ?? null)}`)
      spawnSync('sleep', ['0.4'])
    }
    log(`CTL-FAIL ${JSON.stringify(args)}`)
    // A control command that did not run makes every later observation a guess:
    // a failed `tree` reads as an empty tree, and an empty tree makes "the control
    // is absent" / "nothing was written" pass VACUOUSLY. The instrument fails
    // closed instead of reporting that as a green run.
    throw new Error(`tern ctl ${args.join(' ')} failed`)
  }

  const serve = spawn(ternBin, ['serve', '--control', endpoint, '--out', join(root, 'shots')], { stdio: ['ignore', 'pipe', 'pipe'] })
  serve.stdout.on('data', (d) => log(`serve.out ${String(d).trim()}`))
  serve.stderr.on('data', (d) => log(`serve.err ${String(d).trim()}`))
  const stopServe = () => serve.kill('SIGKILL')
  process.on('exit', stopServe)

  const results = []
  let step = 0
  const check = (label, ok, detail = '') => {
    results.push({ label, ok: ok === true, detail: String(detail).slice(0, 400) })
    log(`ASSERT ${ok === true ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` :: ${detail}`}`)
  }
  const measure = (label, detail = '') => {
    results.push({ label, ok: true, informational: true, detail: String(detail).slice(0, 400) })
    log(`MEASURE ${label}${detail === '' ? '' : ` :: ${detail}`}`)
  }

  // ------------------------------------------------------------------- tree
  const vis = (node) => rect(node)[2] > 0 || rect(node)[3] > 0
  const texts = (snapshot) => snapshot.nodes.filter(vis).map((node) => String(node.text ?? '')).filter(Boolean)
  const has = (snapshot, text) => texts(snapshot).some((line) => line.includes(text))
  const textNode = (snapshot, text) => snapshot.nodes.find((node) => vis(node) && String(node.text ?? '') === text)
  const classNodes = (snapshot, name) =>
    snapshot.nodes.filter((node) => vis(node) && (node.class ?? '').split(' ').includes(name))
  const descendantsText = (node) => {
    const out = []
    const walk = (n) => {
      out.push(String(n.text ?? ''))
      for (const child of n.children ?? []) walk(child)
    }
    walk(node)
    return out.filter(Boolean).join('')
  }

  const snapshot = () => index(ctl('tree').tree ?? [])
  /** Poll the real tree until `text` shows up (the subject finished booting). */
  async function waitFor(text, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (has(snapshot(), text)) return true
      await sleep(intervalMs)
    }
    return false
  }

  // ------------------------------------------------------------- real input
  const key = async (name, settleMs = 400) => {
    ctl('key', name)
    await sleep(settleMs)
  }
  const resize = async (width, height, settleMs = 700) => {
    ctl('resize', width, height)
    await sleep(settleMs)
  }
  const css = async (name, file, settleMs = 500) => {
    ctl('css', name, file)
    await sleep(settleMs)
  }
  const clickAt = async (x, y, settleMs = 900) => {
    ctl('click', x, y)
    await sleep(settleMs)
  }
  /**
   * Click the fragment the client actually shows, not the node's own centre:
   * clicking a clipped node's centre lands on whatever covers it. Returns false
   * when less than `minSpan` pixels survive — report that as a measurement, not
   * as a pass.
   */
  const click = async (chains, node, settleMs = 900, minSpan = 4) => {
    const point = visiblePoint(chains, node, minSpan)
    if (point === undefined) return false
    await clickAt(point.x, point.y, settleMs)
    return true
  }

  // -------------------------------------------------------------- artifacts
  const shot = (id) => ctl('shot', id)
  /** Node-tree dump + PNG + layout under one id; the PNG is the human check. */
  function capture(name, note = '') {
    step += 1
    const id = `${String(step).padStart(2, '0')}-${name}`
    writeFileSync(join(root, `${id}.tree.json`), JSON.stringify(ctl('tree'), null, 1))
    const reply = shot(id)
    log(`SHOT ${id} :: ${note} :: elements=${reply.elements}`)
    return id
  }

  // ---------------------------------------------------------- subject launch
  /**
   * Start the subject (a `.mts` that mounts the UI under test in a real pane)
   * and wait for its ready marker. The launch goes through a shell script so the
   * subject inherits the run directory (`TERN_PANE_DIR`) and its stderr lands in
   * the run.
   */
  async function launch(subject, { ready, readyTimeoutMs = 20_000 } = {}) {
    // Keep a copy of the subject with the run: the artifacts must be auditable
    // without the machine that produced them.
    copyFileSync(subject, join(root, `subject${extname(subject)}`))
    writeFileSync(join(root, 'launch.sh'), `#!/bin/bash
export TERN_PANE_DIR=${root}
cd ${repo}
exec node --import tsx/esm ${subject} 2>> ${root}/subject.err
`, { mode: 0o755 })
    ctl('run', join(root, 'launch.sh'))
    return ready === undefined ? true : waitFor(ready, { timeoutMs: readyTimeoutMs })
  }

  /** Write the ledger and print it; the return value is the process exit code. */
  function finish(extra = {}) {
    const failed = results.filter((result) => !result.ok)
    const informational = results.filter((result) => result.informational === true).length
    writeFileSync(join(root, 'assertions.json'), JSON.stringify({
      total: results.length, failed: failed.length, informational, ...extra, results,
    }, null, 1))
    log(`SUMMARY total=${results.length} failed=${failed.length} measured=${informational}`)
    console.log(`artifacts: ${root}`)
    console.log(`total=${results.length} failed=${failed.length} measured=${informational}`)
    for (const failure of failed) console.log(`FAIL ${failure.label} :: ${failure.detail}`)
    return failed.length === 0 ? 0 : 1
  }

  /**
   * The server owns the socket and opens it a moment after the process starts: a
   * command sent before that is DROPPED, which would leave a flow measuring the
   * default viewport while believing it resized. Gate on the server answering.
   */
  async function readyForCommands(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const reply = ctlOnce('stats')
      if (reply !== undefined && reply.ok !== false) return true
      await sleep(250)
    }
    return false
  }

  return {
    ctl, log, sleep, root, results, repo, ready: await readyForCommands(),
    check, measure, finish,
    snapshot, waitFor, vis, texts, has, textNode, classNodes, descendantsText,
    key, resize, css, click, clickAt, shot, capture,
    launch,
    // Teardown must not mask an earlier failure with one of its own.
    quit: () => { ctlOnce('quit') },
    stopServe,
  }
}

// ------------------------------------------------------------------ argv
const positional = []
let outFlag
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--help' || arg === '-h') usage(0)
  if (arg === '--out') {
    outFlag = argv[i + 1]
    if (outFlag === undefined) usage(2)
    i += 1
    continue
  }
  positional.push(arg)
}
if (positional.length !== 1) usage(2)
const flowPath = resolve(process.cwd(), positional[0])
if (!existsSync(flowPath)) {
  console.error(`flow not found: ${flowPath}`)
  process.exit(2)
}

// ------------------------------------------------------- the Tern CLI boundary
const ternBin = process.env.TERN_BIN ?? 'tern'
// The CLI is an external binary this repository does not ship: fail here, with
// the reason, instead of as a storm of CTL-FAIL retries against nothing.
const probed = spawnSync(ternBin, ['--version'], { encoding: 'utf8' })
if (probed.status !== 0) {
  console.error(`${ternBin} --version failed; put the Tern CLI on PATH or point TERN_BIN at it`)
  process.exit(2)
}
const ternVersion = String(probed.stdout).trim()

const out = outFlag ?? process.env.TERN_PANE_OUT
const root = out === undefined ? join(repo, 'temp', 'tern-pane') : isAbsolute(out) ? out : resolve(process.cwd(), out)
const flow = await import(pathToFileURL(flowPath).href)
if (typeof flow.default !== 'function') {
  console.error(`flow must default-export a function: ${flowPath}`)
  process.exit(2)
}

const harness = await createHarness({ ternBin, root })
harness.log(`TERN ${ternBin} :: ${ternVersion}`)
harness.log(`ARGV ${process.argv.slice(2).join(' ')}`)
harness.log(`FLOW ${flowPath}`)
// Keep the flow with the run so the artifacts can be audited and re-run later.
copyFileSync(flowPath, join(root, `flow${extname(flowPath)}`))
if (!harness.ready) {
  console.error(`the Tern serve control socket never answered (${root})`)
  harness.stopServe()
  process.exit(2)
}
try {
  await flow.default(harness)
} finally {
  harness.quit()
  harness.stopServe()
}
process.exit(harness.finish({ tern: ternVersion, flow: flowPath }))
