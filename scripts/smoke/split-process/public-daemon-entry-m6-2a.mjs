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

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

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

  return result
}
