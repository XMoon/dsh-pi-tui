#!/usr/bin/env node
/**
 * Real-GUI Tern driver: run a UI under test inside a REAL Tern GUI WINDOW and
 * drive it with a REAL pointer.
 *
 * The headless driver (`scripts/tern-pane-drive.mjs`) drives `tern serve`, a
 * HEADLESS session. This one opens a real window (`tern --control EP`) on a
 * real display, which is the only way to answer the questions the headless
 * control channel cannot:
 *
 *   - HOVER — the headless channel has no way to move a pointer;
 *   - the client's own DARK THEME and its real font stack;
 *   - the NATIVE OS WINDOW (the chrome, the title bar, the real display);
 *   - the ACCESSIBILITY TREE, i.e. what a screen reader actually reads.
 *
 * The GUI is a DIFFERENT CLIENT MODE, so a claim made here is at the
 * `REAL_TERN_GUI` evidence tier and does not automatically cover the headless
 * lane. The handle mirrors the headless driver's closely enough that the
 * same subject and the same assertions can be reused.
 *
 * ISOLATION: the window runs with `TERN_CONFIG_DIR` and `TERN_DAEMON_SOCKET`
 * pointed INSIDE THE RUN DIRECTORY, so the user's real Tern profile, plugins
 * and daemon are never read or written.
 *
 *   node scripts/tern-gui-drive.mjs <flow.mjs> [--out <dir>]
 *
 * env: DISPLAY=<x>      the display to open the window on (default :0)
 *      TERN_BIN=<path>  the Tern CLI (default: tern on PATH)
 *
 * See `docs/guides/tern-gui-testing.md` for the lane's procedure and its
 * evidence rules.
 * @module scripts/tern-gui-drive
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { index, visiblePoint } from './tern-pane-geometry.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

function usage(exitCode) {
  console.log('Drive a UI under test inside a REAL Tern GUI window.')
  console.log('')
  console.log('  node temp/omp-tsp-verify/tools/tern-gui-drive.mjs <flow.mjs> [--out <dir>]')
  console.log('')
  console.log('  env: DISPLAY=<x>      the display to open the window on')
  console.log('       TERN_BIN=<path>   the Tern CLI (default: tern on PATH)')
  process.exit(exitCode)
}

/** One GUI run's own directory: the window's config, its socket and its logs. */
function createRunDirectory(requested) {
  if (requested === undefined) {
    const parent = join(repo, 'temp')
    mkdirSync(parent, { recursive: true })
    return mkdtempSync(join(parent, 'tern-gui-'))
  }
  const target = resolve(requested)
  try {
    mkdirSync(target)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`${target} already exists; --out must name a directory this run creates`)
    }
    throw error
  }
  return target
}

async function createHarness({ ternBin, root, display }) {
  const socket = join(root, 'gui.sock')
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(root, 'shots'), { recursive: true })
  // The run's OWN session daemon. MEASURED: a window does not start one — it
  // attaches to the daemon already running for this user, so without this every
  // `tern split` lands on the OPERATOR'S window (`@focused` is the pane they
  // work in). The socket's directory must be 0700, or the daemon refuses to
  // start ("the socket needs a private directory").
  // MEASURED: a Unix socket path must stay under SUN_LEN (~107 bytes), and a
  // run directory under `temp/` easily exceeds it. The daemon's directory
  // therefore lives in the system temp dir — and it is ATOMICALLY UNIQUE, the
  // same way the run directory itself is: two runs whose `--out` basenames
  // collide must never share a socket, or one run's teardown removes the
  // other's daemon.
  const daemonDir = mkdtempSync(join(tmpdir(), 'tern-gui-daemon-'))
  chmodSync(daemonDir, 0o700)
  const daemonSocket = join(daemonDir, 'daemon.sock')
  // The window's env: the run's own config AND daemon, so nothing it does can
  // reach another session's panes.
  const windowEnv = {
    ...process.env,
    DISPLAY: display,
    TERN_CONFIG_DIR: configDir,
    TERN_DAEMON_SOCKET: daemonSocket,
  }
  const daemon = spawn(ternBin, ['daemon', '--socket', daemonSocket], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
    env: { ...process.env, DISPLAY: display, TERN_CONFIG_DIR: configDir },
  })
  daemon.stdout.on('data', (d) => log(`daemon.out ${String(d).trim()}`))
  daemon.stderr.on('data', (d) => log(`daemon.err ${String(d).trim()}`))
  const stopDaemon = () => {
    daemon.kill('SIGKILL')
    rmSync(daemonDir, { recursive: true, force: true })
  }
  process.on('exit', stopDaemon)
  // The window itself: spawned HERE, after its private daemon exists, so it
  // attaches to THIS run's daemon instead of the operator's.
  // The client writes its own PNGs into a directory of ITS choice and reuses the
  // file names across runs, so a later run would silently overwrite an earlier
  // run's picture while that run's ledger still names it. Each run therefore gets
  // its own client-side shot directory.
  const windowShots = join(root, 'client-shots')
  mkdirSync(windowShots, { recursive: true })
  const window = spawn(ternBin, ['--control', socket, '--out', windowShots], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
    env: windowEnv,
  })
  const stopWindow = () => window.kill('SIGKILL')
  process.on('exit', stopWindow)
  window.stdout.on('data', (d) => log(`window.out ${String(d).trim()}`))
  window.stderr.on('data', (d) => log(`window.err ${String(d).trim()}`))
  // Every control command talks to the window; the CLI commands a flow issues
  // (`tern split`) need the SAME daemon env, or they resolve `@focused` against
  // whichever daemon they happen to find.
  const cliEnv = { ...windowEnv, DISPLAY: display }
  const log = (line) => appendFileSync(join(root, 'run.log'), `${line}\n`)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** One control command, delivered EXACTLY once (a click must not repeat). */
  function ctlOnce(...args) {
    const sent = spawnSync(ternBin, ['ctl', '--control', socket, ...args.map(String)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DISPLAY: display },
    })
    if (sent.status !== 0) return undefined
    try {
      return JSON.parse(sent.stdout)
    } catch {
      return undefined
    }
  }
  /** A read or an idempotent set: a lost reply costs nothing, so it may retry. */
  function ctl(...args) {
    for (let i = 0; i < 6; i += 1) {
      const reply = ctlOnce(...args)
      if (reply !== undefined && reply.ok !== false) {
        log(`CTL ok ${JSON.stringify(args)}`)
        return reply
      }
      log(`CTL-RETRY ${JSON.stringify(args)} :: ${JSON.stringify(reply ?? null)}`)
      spawnSync('sleep', ['0.4'])
    }
    log(`CTL-FAIL ${JSON.stringify(args)}`)
    throw new Error(`tern ctl ${args.join(' ')} failed`)
  }
  /** A command whose repetition would be observable: delivered ONCE. */
  function send(...args) {
    const reply = ctlOnce(...args)
    if (reply === undefined || reply.ok === false) {
      log(`CTL-FAIL ${JSON.stringify(args)} :: not retried, a repeat would be a second input`)
      throw new Error(`tern ctl ${args.join(' ')} failed`)
    }
    log(`SEND ok ${JSON.stringify(args)}`)
    return reply
  }

  const results = []
  const check = (label, ok, detail = '') => {
    results.push({ label, ok: ok === true, detail: String(detail).slice(0, 400) })
    log(`ASSERT ${ok === true ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` :: ${detail}`}`)
  }
  const measure = (label, detail = '') => {
    results.push({ label, ok: true, informational: true, detail: String(detail).slice(0, 400) })
    log(`MEASURE ${label}${detail === '' ? '' : ` :: ${detail}`}`)
  }

  // ------------------------------------------------------------------- tree
  const vis = (node) => node.rect[2] > 0 || node.rect[3] > 0
  const texts = (snapshot) => snapshot.nodes.filter(vis).map((n) => String(n.text ?? '')).filter(Boolean)
  const has = (snapshot, text) => texts(snapshot).some((line) => line.includes(text))
  const classNodes = (snapshot, name) =>
    snapshot.nodes.filter((n) => vis(n) && (n.class ?? '').split(' ').includes(name))
  const descendantsText = (node) => {
    const out = []
    const walk = (n) => {
      out.push(String(n.text ?? ''))
      for (const child of n.children ?? []) walk(child)
    }
    walk(node)
    return out.filter(Boolean).join('')
  }
  /** Index the client's tree the way the headless driver's `index` does. */
  // The shared index: chains keyed by the NODE OBJECT, exactly as the headless
  // driver and every oracle expect. A per-driver chain shape makes
  // `visiblePoint(chains, node)` find no chain, treat the node as having no sized
  // ancestor, and report a clipped node as clickable.
  const snapshot = () => index(ctl('tree').tree ?? [])

  // -------------------------------------------------------------- real input
  const key = async (name, settleMs = 500) => {
    send('key', name)
    await sleep(settleMs)
  }
  /**
   * Resize the window's CONTENT and verify it took.
   *
   * A REAL WINDOW HAS A MINIMUM SIZE: the client clamps a narrow request to
   * its own minimum (measured: 720px wide on this build), so a request below
   * it does NOT take effect. The clamp is reported rather than hidden: the
   * returned viewport is what the measurement applies to, and a flow that
   * needs a narrower pane must use the HEADLESS lane.
   */
  const resize = async (width, height, settleMs = 900) => {
    ctl('resize', width, height)
    await sleep(settleMs)
    const viewport = ctl('stats').viewport ?? []
    const clamped = viewport[0] !== width || viewport[1] !== height
    if (clamped) {
      log(`RESIZE-CLAMPED requested=${width}x${height} actual=${viewport[0]}x${viewport[1]}`)
    }
    return { requested: [width, height], viewport, clamped }
  }
  const clickAt = async (x, y, settleMs = 900) => {
    send('click', x, y)
    await sleep(settleMs)
  }
  /**
   * Click the fragment the client shows, on BOTH axes: the client's own
   * geometry is in the tree, and a node's own centre can fall in a clipped
   * region. The GUI's own `pick` command answers what is really at a point.
   */
  const click = async (chains, node, settleMs = 900, minSpan = 4) => {
    // The node's own centre can fall outside the fragment the client shows (a
    // short pane pushes the dock's editor past the pane's bottom edge), so click
    // the centre of the SURVIVING fragment and report when nothing survives.
    const point = visiblePoint(chains, node, minSpan)
    if (point === undefined) return false
    await clickAt(point.x, point.y, settleMs)
    return true
  }
  /** Move the REAL pointer over a node WITHOUT clicking: the hover the
   *  headless control channel cannot deliver. The GUI's `move X Y` moves the
   *  real pointer and the client's own `stats.pointer` follows it. */
  const hover = async (chains, node, settleMs = 700) => {
    const rect = node.rect ?? [0, 0, 0, 0]
    const x = Math.round(rect[0] + rect[2] / 2)
    const y = Math.round(rect[1] + rect[3] / 2)
    send('move', x, y)
    await sleep(settleMs)
    const pointer = ctl('stats').pointer ?? []
    return { moved: pointer[0] === x && pointer[1] === y, at: pointer }
  }

  // ------------------------------------------------------------- artifacts
  const shot = (id) => ctl('shot', id)
  let step = 0
  /**
   * Capture the node tree, the PNG and the layout under one id.
   *
   * The GUI's `shot` writes the PNG into the CLIENT's own directory
   * (`target/shots/tern/live/<id>.png`), NOT into the run directory, so the
   * file is COPIED here: a run's evidence must not live outside the run.
   */
  function capture(name, note = '') {
    step += 1
    const id = `${String(step).padStart(2, '0')}-${name}`
    writeFileSync(join(root, `${id}.tree.json`), JSON.stringify(ctl('tree'), null, 1))
    const reply = shot(id)
    const produced = reply.png ?? reply.path
    if (produced !== undefined && produced !== null) {
      // The client reports the path it wrote; resolve it against this run's own
      // client-shot directory first, then the repository root (older builds).
      const absolute = existsSync(produced) ? produced
        : existsSync(join(windowShots, basename(produced))) ? join(windowShots, basename(produced))
        : join(repo, produced)
      if (existsSync(absolute)) {
        mkdirSync(join(root, 'shots'), { recursive: true })
        copyFileSync(absolute, join(root, 'shots', `${id}.png`))
      }
    }
    log(`SHOT ${id} :: ${note} :: elements=${reply.elements} :: png=${produced ?? 'none'}`)
    return id
  }

  // ---------------------------------------------------------- subject launch
  /**
   * The GUI window is a real terminal multiplexer: a TSP surface is what a
   * PROGRAM INSIDE A PANE renders. The subject is therefore started by the
   * client's own `run` world command, which types a one-token path into the
   * focused pane. The subject's own `connect()` then finds the pane's tty.
   */
  async function launch(subject, { ready, readyTimeoutMs = 30_000 } = {}) {
    copyFileSync(subject, join(root, `subject${extname(subject)}`))
    const launcher = join(root, 'launch.sh')
    writeFileSync(launcher, `#!/bin/bash
export TERN_PANE_DIR=${JSON.stringify(root)}
export TERN_CONFIG_DIR=${JSON.stringify(configDir)}
export TERN_DAEMON_SOCKET=${JSON.stringify(daemonSocket)}
export DISPLAY=${JSON.stringify(display)}
cd ${JSON.stringify(repo)} || exit 1
exec node --import tsx/esm ${JSON.stringify(subject)} 2>> ${JSON.stringify(join(root, 'subject.err'))}
`, { mode: 0o755 })
    // `run` takes ONE path-shaped token, and it TYPES that line into the
    // focused pane: a retry would start a SECOND subject. Deliver it once and
    // let an unacknowledged send abort the run; whether the subject actually
    // booted is decided by the ready marker below, never by the `run` reply.
    send('run', launcher)
    if (ready === undefined) return true
    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (has(snapshot(), ready)) return true
      await sleep(250)
    }
    return false
  }

  function finish(extra = {}) {
    const failed = results.filter((r) => !r.ok)
    const informational = results.filter((r) => r.informational === true).length
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
   * Split the focused pane, the ONLY way that reaches THIS window: the command
   * runs inside the window's own pane (where `TERN_PANE` names it) against the
   * run's own daemon. MEASURED: `tern split` from outside always resolves
   * `@focused` against whatever daemon the caller's env names, which is how a
   * run ends up splitting the operator's window.
   *
   * The split must happen while the pane is EMPTY: splitting a pane that already
   * runs a live TSP subject silently produces no second pane.
   *
   * MEASURED: the client keeps the ORIGINAL pane focused after the split
   * (`focus left|right|up|down` would move it). This function therefore never
   * "restores" the focus — a `run` that typed a focus command would be delivered
   * to whichever pane holds the focus, and the new pane is running the keep-open
   * placeholder, not a shell. It ASSERTS the invariant instead, and fails the run
   * when it does not hold, so a subject can never be launched into the wrong pane.
   */
  async function splitPane(direction = 'down', keepOpen = 'sleep 180') {
    const before = ctl('state')?.focused?.id
    if (before === undefined) throw new Error('the window reports no focused pane before the split')
    const script = join(root, `split-${direction}.sh`)
    writeFileSync(script, `#!/bin/bash
export TERN_DAEMON_SOCKET=${JSON.stringify(daemonSocket)}
exec ${JSON.stringify(ternBin)} split @focused ${direction} -- ${keepOpen}
`, { mode: 0o755 })
    // A `run` TYPES a command line into the focused pane, so it must never be
    // retried: a repeat would split a second time. `send` delivers it once and
    // aborts the run when the reply is lost.
    send('run', script)
    await sleep(2500)
    const panes = ctl('state')?.panes ?? []
    const after = ctl('state')?.focused?.id
    if (panes.length !== 2) {
      throw new Error(`the split produced ${panes.length} pane(s), expected 2: ${JSON.stringify(panes)}`)
    }
    if (after !== before) {
      // Never "recover" by typing a focus command: the panes may not be running
      // a shell, so that input would be lost or land in the wrong place. The
      // window's own `focus` command is the only supported route, and the
      // invariant is asserted rather than repaired silently.
      throw new Error(`the split moved the focus from pane ${before} to ${after}; `
        + `refusing to launch a subject into an unverified pane`)
    }
    return panes
  }

  return {
    ctl, send, log, sleep, root, results, repo, check, measure, finish,
    snapshot, vis, texts, has, classNodes, descendantsText,
    key, resize, click, clickAt, hover, shot, capture, launch,
    splitPane, cliEnv,
    quit: () => { ctlOnce('quit') },
    stopWindow,
    stopDaemon,
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
    outFlag = argv[++i]
    if (outFlag === undefined) usage(2)
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

const ternBin = process.env.TERN_BIN ?? 'tern'
const probed = spawnSync(ternBin, ['--version'], { encoding: 'utf8' })
if (probed.status !== 0) {
  console.error(`${ternBin} --version failed`)
  process.exit(2)
}
const ternVersion = String(probed.stdout).trim()

const display = process.env.DISPLAY ?? ':0'
const root = createRunDirectory(outFlag)
const socket = join(root, 'gui.sock')
const configDir = join(root, 'config')
mkdirSync(configDir, { recursive: true })

const windowLog = (line) => appendFileSync(join(root, 'run.log'), `${line}\n`)

const harness = await createHarness({ ternBin, root, display })
harness.log(`TERN ${ternBin} :: ${ternVersion}`)
harness.log(`DISPLAY ${display}`)
harness.log(`ISOLATED CONFIG ${configDir}`)
harness.log(`FLOW ${flowPath}`)
copyFileSync(flowPath, join(root, `flow${extname(flowPath)}`))

// Wait for the control endpoint to answer: a command sent before the window
// listens is DROPPED.
let ready = false
for (let i = 0; i < 60 && !ready; i += 1) {
  const reply = spawnSync(ternBin, ['ctl', '--control', socket, 'stats'], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, DISPLAY: display },
  })
  if (reply.status === 0) {
    try {
      if (JSON.parse(reply.stdout).ok !== false) ready = true
    } catch { /* not a JSON reply yet */ }
  }
  if (!ready) await new Promise((r) => setTimeout(r, 500))
}
if (!ready) {
  console.error(`the GUI window's control socket never answered (${root})`)
  harness.stopWindow()
  harness.stopDaemon()
  process.exit(2)
}
harness.log('the GUI window answered the control socket')

try {
  const flow = await import(pathToFileURL(flowPath).href)
  if (typeof flow.default !== 'function') {
    console.error(`flow must default-export a function: ${flowPath}`)
    process.exit(2)
  }
  await flow.default(harness)
} catch (error) {
  harness.log(`FLOW-ERROR ${error?.stack ?? error}`)
  harness.check('the flow ran to completion', false, String(error?.message ?? error))
} finally {
  harness.quit()
  harness.stopWindow()
  harness.stopDaemon()
}
process.exit(harness.finish({ tern: ternVersion, flow: flowPath, mode: 'GUI', display }))
