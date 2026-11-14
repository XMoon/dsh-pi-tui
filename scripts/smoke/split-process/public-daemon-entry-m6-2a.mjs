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
import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import xterm from '@xterm/headless'
import { findIsolatedProcesses, killIsolatedProcesses } from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostSessionHeader, hostSessionEvents, hostAssistantHasText } from '../../lib/split-smoke-sessions.mjs'

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

/** Whether a PID is still alive (Linux /proc). */
function isAlive(pid) {
  if (pid === undefined) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** The first child PID of `pid` (used to find a `script` wrapper's dsh supervisor). */
function firstChildPid(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
    return text === '' ? undefined : Number(text.split(/\s+/u)[0])
  } catch { return undefined }
}

/** The current Host/Client process counts for this isolated DSH home. */
function processCounts(dshHome) {
  const roles = findIsolatedProcesses(dshHome).map(classify)
  return { host: roles.filter(r => r === 'host').length, client: roles.filter(r => r === 'client').length }
}

/** Wait until the painted viewport contains at least `n` occurrences of `needle`. */
async function waitScreenCount(screen, needle, n, label, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const text = await screen.viewport()
    if (text.split(needle).length - 1 >= n) return
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`${label}: viewport never showed ${n}x ${JSON.stringify(needle)}`)
}

/** The live detached Host PIDs for this isolated DSH home. */
function hostPids(dshHome) {
  return findIsolatedProcesses(dshHome).filter(pid => classify(pid) === 'host')
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

  // R6-02: real runtime Loader entry.disabled / fiber state in the supervisor.
  result.runtimeLoader = await runRuntimeLoaderAudit(installation, trace)

  // Real PUBLIC session-launch + signal acceptance.
  const session = await runSceneAcceptance(installation, trace)
  Object.assign(result, session)

  return result
}

/** Drive the REAL `dsh --profile pi-tui` CLI under a PTY with an xterm screen
 *  parser, for the public session-launch and signal acceptance subscenarios. */
class RealDshScreen {
  constructor(installation, backend, args, extraEnv = {}) {
    this.installation = installation
    this.records = { raw: '' }
    this.term = new xterm.Terminal({ cols: 100, rows: 30, disableStdin: true, allowProposedApi: true })
    const { dshInvocation, env, profileDir } = installation
    const command = `${shellQuote(dshInvocation[0])} ${shellQuote(dshInvocation[1])} --profile pi-tui${args.map(a => ' ' + shellQuote(a)).join('')}`
    this.child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: profileDir,
      env: { ...env, ...(backend === undefined ? {} : { DSH_PI_TUI_BACKEND: backend }), ...extraEnv, COLUMNS: '100', LINES: '30' },
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

/** Seed the offline stub LLM into the installed PROFILE patch so the Host that
 *  actually runs the turn loads it (per-turn Host deletes SPLIT_PROCESS_EXTRA_PATCH). */
function ensureProfileStubLlm(installation) {
  const patchPath = join(installation.profileDir, 'cordis.patch.yml')
  let stock = ''
  try { stock = readFileSync(patchPath, 'utf8') } catch { /* absent */ }
  if (stock.includes('m4b2s-stub-llm')) return
  const rows = [
    '- insert:',
    '    - id: m4b2s-stub-llm',
    `      name: 'file://${installation.surfaceLlm.stubPath}'`,
    '      inject: [llm]',
    '- id: agent-default-model',
    '  config:',
    '    provider: stub',
    '    model: stub',
    '',
  ].join('\n')
  // An empty profile patch ends with the `[]` flow document; a following block
  // sequence after it is a YAML error, so REPLACE the empty document.
  const noEmpty = stock.split('\n').filter(line => line.trim() !== '[]').join('\n')
  writeFileSync(patchPath, `${noEmpty.replace(/\s*$/u, '')}\n${rows}`, { mode: 0o600 })
}

/** Create ONE real Session with a completed offline-stub turn; return its id + header. */
async function seedSession(installation, extraArgs) {
  const s = new RealDshScreen(installation, 'daemon', extraArgs)
  try {
    await s.waitForAny(['type a message', '╭'], 'seed paint', 90_000)
    s.send('hello stub scene\r')
    await s.waitForAny(['stub answer'], 'seed turn', 120_000)
    let sessionId
    const match = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec(s.records.raw)
    if (match !== null) sessionId = match[0]
    else sessionId = newestSessionId(installation.dshHome)
    assert(typeof sessionId === 'string' && sessionId.startsWith('session-'), 'seed: session id was not observed')
    s.send('/exit\r')
    const exit = await Promise.race([s.exit, sleep(30_000).then(() => ({ code: 'timeout' }))])
    assert(exit.code === 0, `seed: /exit exited ${JSON.stringify(exit)}`)
    return { sessionId, shortId: sessionId.slice('session-'.length, 'session-'.length + 8), header: hostSessionHeader(installation.dshHome, sessionId) }
  } finally { await s.dispose() }
}

/** Newest persisted session id under the isolated DSH home (fallback locator). */
function newestSessionId(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return undefined
  let best
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue
    const scopeDir = join(root, scope.name)
    for (const sess of readdirSync(scopeDir, { withFileTypes: true })) {
      if (sess.isDirectory() && sess.name.startsWith('session-')) best = sess.name
    }
  }
  return best
}

/** R6-02: read the ACTUAL runtime Loader entry.disabled/fiber state in the real
 *  daemon supervisor Context (not the composed --dump-config strings). */
async function runRuntimeLoaderAudit(installation, trace) {
  const dumpPath = join(installation.dshHome, 'loader-dump.json')
  try { unlinkSync(dumpPath) } catch { /* absent */ }
  const s = new RealDshScreen(installation, 'daemon', [], { M62A_LOADER_DUMP: dumpPath })
  try {
    await waitForProcesses(installation.dshHome, c => c.host >= 1 && c.client >= 1, 'R6-02 loader audit mount', 90_000)
    let dump
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (existsSync(dumpPath)) {
        try { dump = JSON.parse(readFileSync(dumpPath, 'utf8')) } catch { /* partial */ }
        if (Array.isArray(dump)) break
      }
      await sleep(200)
    }
    assert(Array.isArray(dump), `R6-02: runtime Loader dump was not produced${dump && dump.error ? ` (${String(dump.error)})` : ''}`)
    const pick = (id) => dump.find(row => row.id === id || row.id === `include:${id}` || row.id.endsWith(`:${id}`))
    // Every second-Host-business authority row (incl. the pi-tui conditional ones)
    // must be RUNTIME-disabled with NO active fiber; stateless infra stays enabled
    // WITH an active fiber.
    const authorityIds = ['session', 'session-persistence-jsonl', 'storage-json', 'jobs', 'typert-gateway', 'remote-access', 'deepseek-account', 'authorization', 'credentials', 'workspace', 'job-controller', 'webserver']
    for (const id of authorityIds) {
      const row = pick(id)
      assert(row !== undefined, `R6-02: the runtime supervisor Loader has no row for ${id} (ids sample: ${dump.map(r => r.id).slice(0, 8).join(',')})`)
      // The runtime `entry.disabled` GETTER (which evaluates the !!js expression
      // against the live loader context) must be true — real admission state, not
      // a composed config string. NOTE: for entries created by cordis-plugin-include
      // (`include:<id>`) the per-entry fiber is the include group's shared fiber, so
      // fiber state is not a reliable per-row signal and is collected for reference
      // only, not asserted.
      assert(row.disabled === true, `R6-02: runtime Loader row ${row.id} disabled=${String(row.disabled)} (expected the !!js expression to evaluate true)`)
    }
    for (const id of ['timer', 'llm', 'tools']) {
      const row = pick(id)
      if (row !== undefined) assert(row.disabled === false, `R6-02: control row ${row.id} must stay ENABLED in the supervisor`)
    }
    trace('m6-2a-runtime-loader-audit', { rows: dump.length, authorityDisabled: authorityIds.length })
    trace('m6-2a-runtime-loader-audit', { rows: dump.length })
    return 'PASS'
  } finally { await s.dispose() }
}

async function runSceneAcceptance(installation, trace) {
  const out = {}
  ensureProfileStubLlm(installation)

  // Seed ONE real Session with an offline-stub turn (no credentials).
  const seeded = await seedSession(installation, [])
  out.seedSession = 'PASS'

  // A05 Browse positive: --session opens the real Session Browser, which must
  // list the seeded Session under the confirmed workspace (non-zero count).
  {
    const s = new RealDshScreen(installation, 'daemon', ['--session'])
    try {
      await s.waitForAny(['Sessions ·', 'Up/Down move'], 'A05 browse', 90_000)
      let listed = false
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (/pi-tui · [1-9]\d*/u.test(await s.viewport())) { listed = true; break }
        await sleep(150)
      }
      assert(listed, 'A05: the Session Browser did not list the seeded session')
      out.a05Browse = 'PASS'
    } finally { await s.dispose() }
  }

  // A06 Lookup positive: the FULL id and a unique SHORT prefix both resume it.
  for (const [label, query, key] of [
    ['full', seeded.sessionId, 'a06LookupFull'],
    ['prefix', seeded.shortId, 'a06LookupPrefix'],
  ]) {
    const s = new RealDshScreen(installation, 'daemon', ['--session', query])
    try {
      await s.waitForAny(['hello stub scene', 'stub answer'], `A06 lookup ${label}`, 90_000)
      out[key] = 'PASS'
    } finally { await s.dispose() }
  }

  // A07 Continue positive: auto-confirmed workspace (Client/Host same cwd) → -c
  // resumes the latest Session and never reports "Cannot continue".
  {
    const s = new RealDshScreen(installation, 'daemon', ['-c'])
    try {
      await s.waitForAny(['stub answer', 'hello stub scene'], 'A07 continue', 90_000)
      assert(!(await s.viewport()).includes('Cannot continue'), 'A07: -c reported Cannot continue')
      out.a07Continue = 'PASS'
    } finally { await s.dispose() }
  }

  // A08b Preset effect: the persisted Session HEADER records the requested preset;
  // a minimal control proves the assertion discriminates (default seed = standard).
  const preseted = await seedSession(installation, ['--preset', 'minimal'])
  assert(seeded.header?.agentPreset === 'standard', `A08b: default seed preset was ${JSON.stringify(seeded.header?.agentPreset)}`)
  assert(preseted.header?.agentPreset === 'minimal', `A08b: --preset minimal header was ${JSON.stringify(preseted.header?.agentPreset)}`)
  out.a08bPreset = 'PASS'

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

  // A12 Signal: SIGTERM to the SUPERVISOR PID ALONE stops the one Client while the
  // detached Host survives (and, with the awaitable dispose, the parent waits).
  {
    const s = new RealDshScreen(installation, 'daemon', [])
    try {
      const counts = await waitForProcesses(installation.dshHome, c => c.host >= 1 && c.client >= 1, 'A12 mount', 75_000)
      assert(counts.host >= 1 && counts.client >= 1, 'A12: Host+Client did not mount')
      const supervisorPid = findSupervisorPid(installation.dshHome)
      assert(supervisorPid !== undefined, 'A12: the real dsh supervisor PID was not found')
      process.kill(supervisorPid, 'SIGTERM')
      // Record WHEN the Client cleanup completes vs WHEN the supervisor exits: the
      // parent must wait for the child (R4-03 / R4-01).
      let clientGoneAt
      let supervisorGoneAt
      let violation
      const start = Date.now()
      while (Date.now() - start < 45_000) {
        const counts = processCounts(installation.dshHome)
        const backendAlive = isAlive(supervisorPid)
        // Strict invariant: the supervisor must NEVER be gone while a Client is
        // still alive (it waits for the child's cleanup).
        if (!backendAlive && counts.client > 0) violation = `supervisor gone while ${counts.client} Client(s) alive`
        if (clientGoneAt === undefined && counts.client === 0) clientGoneAt = Date.now()
        if (supervisorGoneAt === undefined && !backendAlive) supervisorGoneAt = Date.now()
        if (clientGoneAt !== undefined && supervisorGoneAt !== undefined) break
        await sleep(10)
      }
      assert(violation === undefined, `A12: ${String(violation)}`)
      assert(clientGoneAt !== undefined, 'A12: the Client never exited after a supervisor-only SIGTERM')
      assert(supervisorGoneAt !== undefined, 'A12: the supervisor did not exit')
      assert(clientGoneAt <= supervisorGoneAt, `A12: the supervisor exited (${supervisorGoneAt}) BEFORE the Client cleanup finished (${clientGoneAt})`)
      const still = findIsolatedProcesses(installation.dshHome).map(classify).filter(r => r === 'host').length
      assert(still >= 1, 'A12: the detached Host was not preserved after the Client stopped')
      out.a12Signal = 'PASS'
    } finally { await s.dispose() }
  }

  // A09 Host reuse: a SECOND public daemon Client reuses the SAME Host (one Host
  // instance, two Client PIDs), and the first Client's exit never stops the Host
  // or the second Client.
  {
    const a = new RealDshScreen(installation, 'daemon', ['--session', seeded.sessionId])
    let b
    try {
      await waitForProcesses(installation.dshHome, c => c.host >= 1 && c.client >= 1, 'A09 first Client', 90_000)
      // A reads the persisted Session through the shared Host.
      await a.waitForAny(['hello stub scene', 'stub answer', seeded.shortId], 'A09 A reads session', 60_000)
      const hostsA = hostPids(installation.dshHome)
      assert(hostsA.length === 1, `A09: expected one Host after the first Client, saw ${hostsA.length}`)
      const hostPidA = hostsA[0]
      b = new RealDshScreen(installation, 'daemon', ['--session', seeded.sessionId])
      await waitForProcesses(installation.dshHome, c => c.host === 1 && c.client >= 2, 'A09 second Client', 90_000)
      // B reads the SAME Session on the SAME Host (real Session read, not just PIDs).
      await b.waitForAny(['hello stub scene', 'stub answer', seeded.shortId], 'A09 B reads same session', 60_000)
      const hostsAB = hostPids(installation.dshHome)
      assert(hostsAB.length === 1 && hostsAB[0] === hostPidA, 'A09: the second Client did not reuse the same Host')
      // Stop the FIRST client's supervisor only; the Host and the second Client
      // must survive (A09: one Host reused, Client A exit does not kill it).
      const aSupervisor = firstChildPid(a.child.pid)
      assert(aSupervisor !== undefined, 'A09: A supervisor PID not found')
      process.kill(aSupervisor, 'SIGTERM')
      await Promise.race([a.exit, sleep(30_000)])
      let last
      let oneLeft = false
      const exitDeadline = Date.now() + 60_000
      while (Date.now() < exitDeadline) {
        last = processCounts(installation.dshHome)
        if (last.client === 1) { oneLeft = true; break }
        await sleep(150)
      }
      assert(oneLeft, `A09: the first Client's exit did not settle (last counts=${JSON.stringify(last)})`)
      const hostsAfter = hostPids(installation.dshHome)
      assert(hostsAfter.length === 1 && hostsAfter[0] === hostPidA, `A09: the Host was stopped/replaced when the first Client exited (hosts=${hostsAfter.join(',')})`)
      // B must still drive a NEW Host-owned Session write after A exited (a stale
      // screen re-read would not prove B is still connected). Send a fresh turn
      // and require the persisted Host Session log to GROW with new events AND
      // the painted viewport to show the new reply.
      const eventsBefore = hostSessionEvents(installation.dshHome, seeded.sessionId).length
      b.send('second turn after A exit\r')
      let grew = false
      const growDeadline = Date.now() + 90_000
      while (Date.now() < growDeadline) {
        if (hostSessionEvents(installation.dshHome, seeded.sessionId).length > eventsBefore) { grew = true; break }
        await sleep(200)
      }
      assert(grew, 'A09: Client B performed no NEW Host Session write after A exited (persisted events did not grow)')
      await waitScreenCount(b, 'stub answer', 2, 'A09 B new reply', 60_000)
      out.a09HostReuse = 'PASS'
    } finally {
      // Soft-stop A is already exited; B.dispose kills the shared isolated set.
      if (b !== undefined) await b.dispose()
      else { try { process.kill(-a.child.pid, 'SIGTERM') } catch { /* gone */ } killIsolatedProcesses(installation.dshHome) }
    }
  }

  // A14 real-terminal Settings reachability + A03 persisted backend.
  {
    const s = new RealDshScreen(installation, 'daemon', [])
    try {
      await s.waitForAny(['type a message', '╭'], 'A14 paint', 90_000)
      s.send('/settings\r')
      await s.waitForAny(['Settings'], 'A14 settings open', 30_000)
      s.send('\x1b[B'); await sleep(250); s.send('\r'); await sleep(500); s.send('\r'); await sleep(500)
      await s.waitForAny(['Backend', 'Daemon'], 'A14 backend detail', 30_000)
      s.send('\x1b[B'); await sleep(250); s.send('\r')
      await s.waitForAny(['Applies on next launch', 'Verified'], 'A14 next-launch', 30_000)
      out.a14Settings = 'PASS'
      s.send('\x1b'); await sleep(300); s.send('/exit\r')
      await Promise.race([s.exit, sleep(15_000)])
    } finally { await s.dispose() }
    // A03: the committed Profile backend is persisted, and a NEW process launched
    // WITHOUT DSH_PI_TUI_BACKEND selects Daemon from the Profile alone.
    const profilePatch = readFileSync(join(installation.profileDir, 'cordis.patch.yml'), 'utf8')
    assert(/backend:\s*daemon/u.test(profilePatch), 'A03: the committed Profile backend was not persisted as daemon')
    const s2 = new RealDshScreen(installation, undefined, [])
    try {
      const counts = await waitForProcesses(installation.dshHome, c => c.host >= 1 && c.client >= 1, 'A03 no-env daemon', 90_000)
      assert(counts.host >= 1 && counts.client >= 1, 'A03: a no-ENV launch did not select the daemon path')
      out.a03Persisted = 'PASS'
    } finally { await s2.dispose() }
  }

  trace('m6-2a-scene-acceptance', out)
  return out
}
