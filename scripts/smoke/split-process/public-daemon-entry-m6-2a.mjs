/**
 * M6-2A public-entry: the REAL installed `dsh --profile pi-tui` CLI selects the
 * daemon backend and launches one foreground Client against a local Host, then
 * exits cleanly; an illegal public backend value fails closed with no Host.
 *
 * This drives the PUBLIC CLI entry (never the internal `local-client.mjs`
 * harness), so it is the L6 evidence the internal split cases cannot give. A
 * `script -qefc` wrapper allocates the interactive PTY the daemon backend
 * requires; the isolated profile + DSH anchor come from the shared packed
 * installation.
 *
 * @module split-process/public-daemon-entry-m6-2a
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

import xterm from '@xterm/headless'
import { findIsolatedProcesses, killIsolatedProcesses } from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Classify one isolated process by its cmdline: 'host', 'client' or undefined. */
function classify(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return undefined
  }
  if (cmdline.includes('local-host.mjs')) return 'host'
  if (cmdline.includes('local-client.mjs')) return 'client'
  return undefined
}

/** The real `dsh` supervisor PID (the CLI process, not the Host/Client). */
function findSupervisorPid(dshHome) {
  const marker = `DSH_HOME=${dshHome}`
  let entries
  try { entries = readdirSync('/proc') } catch { return undefined }
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue
    let cmdline
    let environ
    try { cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8'); environ = readFileSync(`/proc/${name}/environ`, 'utf8') } catch { continue }
    if (!environ.split('\0').includes(marker)) continue
    if (!cmdline.includes('dsh/lib/bin.js')) continue
    if (cmdline.includes('local-host.mjs') || cmdline.includes('local-client.mjs')) continue
    return Number(name)
  }
  return undefined
}

/** The composed Loader roster the REAL dsh builds for the daemon backend. */
function dumpDaemonComposedRoster(installation) {
  const { dshInvocation, env, profileDir } = installation
  const result = spawnSync(dshInvocation[0], [...dshInvocation.slice(1), '--profile', 'pi-tui', '--dump-config'], {
    cwd: profileDir,
    env: { ...env, DSH_PI_TUI_BACKEND: 'daemon' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/** Assert one row carries the daemon-disable in the composed roster. */
function assertRosterDaemonDisabled(roster, id) {
  const at = roster.indexOf(`- id: ${id}\n`)
  assert(at !== -1, `CR-01 roster: row ${id} is missing from the composed roster`)
  const block = roster.slice(at, roster.indexOf('\n- id: ', at + 1) === -1 ? undefined : roster.indexOf('\n- id: ', at + 1))
  assert(/disabled: !!js ctx\.get\('tuiDaemonStartup'\)/u.test(block), `CR-01 roster: ${id} is not daemon-disabled`)
}

/** Assert one infrastructure row is NOT patched with the daemon-disable. */
function assertRosterNotPatched(roster, id) {
  const at = roster.indexOf(`- id: ${id}\n`)
  if (at === -1) return
  const end = roster.indexOf('\n- id: ', at + 1)
  const block = roster.slice(at, end === -1 ? undefined : end)
  assert(!block.includes('tuiDaemonStartup'), `CR-01 roster: infra row ${id} must stay unpatched`)
}

/** Poll the isolated DSH_HOME process table until `predicate` is satisfied. */
async function waitForProcesses(dshHome, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const roles = findIsolatedProcesses(dshHome).map(classify)
    const counts = { host: roles.filter(role => role === 'host').length, client: roles.filter(role => role === 'client').length }
    if (predicate(counts)) return counts
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`public-entry daemon: ${label} did not settle before the deadline`)
}

/** Spawn the real `dsh` CLI under a PTY with one backend selection. */
function spawnDsh(dshInvocation, profileDir, env, backend) {
  const command = `${shellQuote(dshInvocation[0])} ${shellQuote(dshInvocation[1])} --profile pi-tui`
  const child = spawn('script', ['-qefc', command, '/dev/null'], {
    cwd: profileDir,
    env: { ...env, DSH_PI_TUI_BACKEND: backend, COLUMNS: '100', LINES: '30' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  const output = { raw: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output.raw += chunk })
  child.stderr.on('data', chunk => { output.raw += chunk })
  const exit = new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, exit, output }
}

/** Wait until the accumulated PTY output paints a TUI frame (a box border). */
async function waitForPaint(output, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (/[╭╮╰╯│─]/u.test(output.raw)) return
    await sleep(100)
  }
  const tailText = output.raw.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1800)
  throw new SplitSmokeAssertionError(`public-entry daemon: ${label} never painted a TUI frame; output tail: ${tailText}`)
}

/** The cleanup: reap the CLI process group and any isolated Host/Client. */
async function reap(child, dshHome) {
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  await sleep(200)
  killIsolatedProcesses(dshHome)
}

export async function runPublicDaemonEntry({ installation, trace }) {
  const { dshInvocation, env, dshHome, profileDir } = installation
  const result = { status: 'PASS', publicEntryDaemon: 'REAL_PUBLIC_DAEMON_L6', negativeFailsClosed: false }

  // ── positive: the daemon backend launches ONE Client against ONE Host ──
  const positive = spawnDsh(dshInvocation, profileDir, env, 'daemon')
  try {
    let counts
    try {
      counts = await waitForProcesses(
        dshHome,
        c => c.host >= 1 && c.client >= 1,
        'one Host + one Client',
        90_000,
      )
    } catch (error) {
      // Surface the daemon launch's own output so a real failure (a fail-closed
      // reason, a loader error, a Client startup line) is diagnosable instead of
      // a bare timeout.
      const tailText = positive.output.raw.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1600)
      throw new SplitSmokeAssertionError(`public-entry daemon: no Host/Client settled; output tail: ${tailText}`)
    }
    assert(counts.host === 1, `public-entry daemon: expected exactly one Host, saw ${counts.host}`)
    assert(counts.client === 1, `public-entry daemon: expected exactly one Client, saw ${counts.client}`)
    await waitForPaint(positive.output, 'the daemon Client', 120_000)
    trace('m6-2a-public-daemon-mounted', { host: counts.host, client: counts.client })
    // Exit the real TUI through the ordinary /exit key path.
    positive.child.stdin.write('/exit\r')
    const exit = await Promise.race([positive.exit, sleep(60_000).then(() => ({ code: 'timeout', signal: null }))])
    assert(exit.code === 0, `public-entry daemon: /exit exited ${JSON.stringify(exit)}`)
  } finally {
    await reap(positive.child, dshHome)
  }
  // The Client must be gone; the detached Host may remain (it is Host authority).
  await waitForProcesses(dshHome, c => c.client === 0, 'the Client to exit', 30_000)

  // ── negative: an illegal public backend value fails closed, no Host ────
  const negative = spawnDsh(dshInvocation, profileDir, env, 'wire-local')
  try {
    const exit = await Promise.race([negative.exit, sleep(45_000).then(() => ({ code: 'timeout', signal: null }))])
    assert(exit.code !== 0 && exit.code !== 'timeout',
      `public-entry daemon: an illegal backend must exit nonzero, saw ${JSON.stringify(exit)}`)
    assert(/invalid-backend|DSH_PI_TUI_BACKEND/u.test(negative.output.raw),
      'public-entry daemon: the illegal backend error was not reported')
    const counts = { host: 0, client: 0 }
    for (const pid of findIsolatedProcesses(dshHome)) {
      const role = classify(pid)
      if (role !== undefined) counts[role] += 1
    }
    assert(counts.host === 0 && counts.client === 0,
      `public-entry daemon: an illegal backend started a Host/Client (${JSON.stringify(counts)})`)
    result.negativeFailsClosed = true
    trace('m6-2a-public-daemon-illegal-backend', { exitCode: exit.code })
  } finally {
    await reap(negative.child, dshHome)
  }

  // CR-01: the REAL dsh --dump-config composed Loader roster must show every
  // second-Host-business authority row daemon-disabled, and stateless infra not.
  {
    const roster = dumpDaemonComposedRoster(installation)
    for (const id of ['session', 'session-persistence-jsonl', 'storage-json', 'jobs', 'typert-gateway', 'remote-access', 'deepseek-account', 'authorization', 'credentials']) {
      assertRosterDaemonDisabled(roster, id)
    }
    for (const id of ['timer', 'llm', 'tools', 'typert']) assertRosterNotPatched(roster, id)
    result.composedRoster = 'AUDITED'
    trace('m6-2a-composed-roster', { authorityDisabled: 9 })
  }

  // Real PUBLIC session-launch + signal acceptance (A08 reject, A12 signal).
  const session = await runSessionAcceptance(installation, trace)
  Object.assign(result, session)

  return result
}

/** Drive the REAL `dsh --profile pi-tui` CLI under a PTY with an xterm screen
 *  parser, for the public session-launch and signal acceptance subscenarios. */
class RealDshScreen {
  constructor(installation, backend, args) {
    this.installation = installation
    this.records = { raw: '' }
    this.term = new xterm.Terminal({ cols: 100, rows: 30, disableStdin: true, allowProposedApi: true })
    const { dshInvocation, env, profileDir } = installation
    const command = `${shellQuote(dshInvocation[0])} ${shellQuote(dshInvocation[1])} --profile pi-tui${args.map(a => ' ' + shellQuote(a)).join('')}`
    this.child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: profileDir,
      env: { ...env, DSH_PI_TUI_BACKEND: backend, COLUMNS: '100', LINES: '30' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    const onData = chunk => { this.records.raw += chunk; this.term.write(chunk) }
    this.child.stdout.on('data', onData)
    this.child.stderr.on('data', onData)
    this.exited = false
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => { this.exited = true; resolve({ code, signal }) }))
  }
  async viewport() {
    await new Promise(resolve => this.term.write('', resolve))
    const buffer = this.term.buffer.active
    const lines = []
    for (let i = 0; i < this.term.rows; i += 1) { const line = buffer.getLine(buffer.viewportY + i); lines.push(line === undefined ? '' : line.translateToString(true)) }
    return lines.join('\n')
  }
  async waitForAny(needles, label, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const screen = await this.viewport()
      if (needles.some(n => screen.includes(n))) return
      if (this.exited) throw new SplitSmokeAssertionError(`${label}: exited before painting any of ${JSON.stringify(needles)}; raw tail: ${this.records.raw.replace(/[\u0000-\u001f]/gu,' ').slice(-600)}`)
      await sleep(80)
    }
    throw new SplitSmokeAssertionError(`${label}: timed out waiting for any of ${JSON.stringify(needles)}; raw tail: ${this.records.raw.replace(/[\u0000-\u001f]/gu,' ').slice(-600)}`)
  }
  send(data) { this.child.stdin.write(data) }
  async dispose() {
    try { process.kill(-this.child.pid, 'SIGTERM') } catch { /* gone */ }
    await Promise.race([this.exit, sleep(4000)])
    killIsolatedProcesses(this.installation.dshHome)
    await Promise.race([this.exit, sleep(3000)])
  }
}

async function runSessionAcceptance(installation, trace) {
  const out = {}
  // A05/A06/A07 (browse/lookup/continue, POSITIVE and the no-resume NEGATIVE)
  // and A08b preset-effect need a PRE-SEEDED Host Workspace+Session scene the
  // isolated packed profile does not provide; they stay NOT_VERIFIED with that
  // blocker (not asserted here to avoid a false positive).
  // A08a --session + -c is early-rejected (nonzero, no TUI).
  {
    const s = new RealDshScreen(installation, 'daemon', ['--session', '-c'])
    try {
      const exit = await Promise.race([s.exit, sleep(30_000).then(() => ({ code: 'timeout' }))])
      assert(exit.code !== 0 && exit.code !== 'timeout', `A08 reject: expected nonzero, saw ${JSON.stringify(exit)}`)
      assert(/mutually exclusive/u.test(s.records.raw), 'A08 reject: the mutually-exclusive reason was not reported')
      out.a08Reject = 'PASS'
    } finally { await s.dispose() }
  }
  // A12 Signal: SIGTERM to the SUPERVISOR PID ALONE (not the process group) must
  // stop the ONE Client through the Coordinator while the detached Host survives.
  {
    const s = new RealDshScreen(installation, 'daemon', [])
    try {
      const counts = await waitForProcesses(installation.dshHome, c => c.host >= 1 && c.client >= 1, 'A12 mount', 75_000)
      assert(counts.host >= 1 && counts.client >= 1, 'A12: Host+Client did not mount')
      const supervisorPid = findSupervisorPid(installation.dshHome)
      assert(supervisorPid !== undefined, 'A12: the real dsh supervisor PID was not found')
      process.kill(supervisorPid, 'SIGTERM')
      const after = await waitForProcesses(installation.dshHome, c => c.client === 0, 'A12 client exit', 40_000)
      assert(after.client === 0, 'A12: the Client did not exit after a supervisor-only SIGTERM')
      const still = findIsolatedProcesses(installation.dshHome).map(classify).filter(r => r === 'host').length
      assert(still >= 1, 'A12: the detached Host was not preserved after the Client stopped')
      out.a12Signal = 'PASS'
    } finally { await s.dispose() }
  }
  trace('m6-2a-session-acceptance', out)
  return out
}
