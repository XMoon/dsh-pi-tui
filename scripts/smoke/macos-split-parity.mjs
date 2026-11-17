#!/usr/bin/env node
/**
 * macOS split-process parity smoke (PR-2 / MAC-03 + MAC-04).
 *
 * Installs the candidate tarball into ONE isolated `pi-tui` profile (the shared
 * `createSplitSmokeProfile` owner), then drives the REAL public
 * `dsh --profile pi-tui` selector inside a private macOS `tmux` server:
 *
 *   A01 the public daemon selector paints a real TUI over one detached Host
 *       and one foreground Client; Direct still paints without a Client/Host.
 *   A02 two cold Clients converge on ONE Host instance with distinct Client
 *       OS PIDs.
 *   A05/A06 Client A exits without stopping the Host/B or a committed turn;
 *       another Client opens the SAME durable Session.
 *   A14 the Client launch directory becomes the Host Workspace through the
 *       Host-owned authenticated object observation and the official
 *       Workspace Controller; the durable Session header carries that cwd.
 *   A16 a renamed+recreated launch path is `unverified`: no Session log is
 *       created and the surface stays unselected.
 *   A20 the workspace-object route refuses an unauthenticated request.
 *   no-TTY the public daemon selector fails closed before any Host side effect.
 *
 * Every wait is a bounded condition wait on a real fact (published registry,
 * painted tmux frame, durable zstd Session log, process table). The tmux server
 * is private (`-L dsh-macos-pr2-<random>`), the profile is installed outside the
 * checkout, and cleanup only signals processes whose command line names THIS
 * run's work root. A cleanup that cannot be proven is reported `NOT_QUIESCED`.
 *
 * Usage: node scripts/smoke/macos-split-parity.mjs [path-to-candidate.tgz]
 *        pnpm smoke:macos-split -- [path-to-candidate.tgz]
 *
 * `SPLIT_PROCESS_SMOKE_KEEP=1` preserves the work root and prints its path;
 * `SPLIT_PROCESS_TRACE` is not accepted: the report is the evidence.
 *
 * @module smoke/macos-split-parity
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { inspectSplitCandidate, createSplitSmokeProfile } from '../lib/split-smoke-profile.mjs'
import { SplitSmokeAssertionError } from '../lib/split-smoke-diagnostics.mjs'
import { hostSessionEvents, hostSessionLogCount, hostSessionHeader } from '../lib/split-smoke-sessions.mjs'

const KEEP = process.env.SPLIT_PROCESS_SMOKE_KEEP === '1'
const TMUX_SOCKET = `dsh-macos-pr2-${randomUUID().slice(0, 8)}`

/** Bounded waits: every one names the real fact it observes. */
const TIMEOUTS = {
  install: 10 * 60_000,
  mount: 120_000,
  paint: 120_000,
  process: 60_000,
  turn: 120_000,
  exit: 45_000,
  negativeWindow: 30_000,
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** Bounded poll on one real observable fact. */
async function waitFor(probe, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`${label}: the observed fact did not settle before the deadline`)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

// ── private tmux server ─────────────────────────────────────────────────────

function tmux(args, label, options = {}) {
  const result = spawnSync('tmux', ['-L', TMUX_SOCKET, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 20_000,
  })
  if (result.error !== undefined) {
    throw new SplitSmokeAssertionError(`${label}: tmux could not run: ${result.error.message}`)
  }
  if (result.status !== 0 && options.allowMissing !== true) {
    throw new SplitSmokeAssertionError(
      `${label}: tmux ${args[0]} exited ${String(result.status)}: ${(result.stderr ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-700)}`,
    )
  }
  return result
}

function tmuxCapture(session, label) {
  return tmux(['capture-pane', '-p', '-t', session], label).stdout
}

function tmuxSessionExists(session) {
  const result = tmux(['has-session', '-t', session], `has-session ${session}`, { allowMissing: true })
  return result.status === 0
}

/** Send one named tmux key (Escape, Enter, ...) without literal text. */
function sendKey(session, key, label) {
  tmux(['send-keys', '-t', session, key], `${label} ${key}`)
}

function sendKeys(session, data, label) {
  tmux(['send-keys', '-t', session, '-l', data], `${label} literal`)
  tmux(['send-keys', '-t', session, 'Enter'], `${label} enter`)
}

async function waitPainted(session, label) {
  let lastFrame = ''
  try {
    return await waitFor(() => {
      if (!tmuxSessionExists(session)) throw new SplitSmokeAssertionError(`${label}: the tmux session exited before painting`)
      lastFrame = tmuxCapture(session, `${label} capture`)
      const dead = tmux(['display-message', '-p', '-t', session, '#{pane_dead}'], `${label} pane state`, { allowMissing: true })
      if (dead.status === 0 && dead.stdout.trim() === '1') {
        throw new SplitSmokeAssertionError(`${label}: the pane exited before painting; last frame: ${lastFrame.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1600)}`)
      }
      return /[╭╮╰╯│─]/u.test(lastFrame) ? lastFrame : undefined
    }, label, TIMEOUTS.paint)
  } catch (error) {
    if (error instanceof SplitSmokeAssertionError && lastFrame !== '') {
      throw new SplitSmokeAssertionError(`${error.message}; last frame: ${lastFrame.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1600)}`)
    }
    throw error
  }
}

async function waitFrameText(session, needle, label, timeoutMs = TIMEOUTS.mount) {
  let lastFrame = ''
  try {
    return await waitFor(() => {
      if (!tmuxSessionExists(session)) throw new SplitSmokeAssertionError(`${label}: the tmux session exited while waiting for ${JSON.stringify(needle)}`)
      lastFrame = tmuxCapture(session, `${label} capture`)
      return lastFrame.includes(needle) ? lastFrame : undefined
    }, label, timeoutMs)
  } catch (error) {
    if (error instanceof SplitSmokeAssertionError && lastFrame !== '') {
      throw new SplitSmokeAssertionError(`${error.message}; last painted frame: ${lastFrame.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1600)}`)
    }
    throw error
  }
}

/** The real TUI paints its composer placeholder only after the surface is
 *  mounted and able to accept input; typing before this loses the keystrokes. */
async function waitComposer(session, label) {
  return await waitFrameText(session, 'type a message', `${label} composer ready`, TIMEOUTS.mount)
}

// ── isolated installation ───────────────────────────────────────────────────

/** The offline Host LLM route must load from the ACTUAL public Host profile
 *  (`spawnHostCandidate` deliberately strips the internal extra-patch channel). */
function ensureProfileStubLlm(profileDir, surfaceLlm) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let stock = ''
  try { stock = readFileSync(patchPath, 'utf8') } catch { /* absent */ }
  if (stock.includes('m4b2s-stub-llm')) return
  const rows = [
    '- insert:',
    '    - id: m4b2s-stub-llm',
    `      name: 'file://${surfaceLlm.stubPath}'`,
    '      inject: [llm]',
    '- id: agent-default-model',
    '  config:',
    '    provider: stub',
    '    model: stub',
    '',
  ].join('\n')
  const noEmpty = stock.split('\n').filter(line => line.trim() !== '[]').join('\n')
  writeFileSync(patchPath, `${noEmpty.replace(/\s*$/u, '')}\n${rows}`, { mode: 0o600 })
}

function startSession({ name, cwd, installation, backend, args = [], dshHome = installation.dshHome }) {
  const { dshInvocation, env } = installation
  const command = [
    'env',
    '-u',
    'NO_COLOR',
    `DSH_HOME=${dshHome}`,
    ...(backend === undefined ? [] : [`DSH_PI_TUI_BACKEND=${backend}`]),
    ...Object.entries(env)
      .filter(([key]) => key !== 'DSH_HOME' && key !== 'DSH_PI_TUI_BACKEND' && key !== 'NO_COLOR')
      .map(([key, value]) => `${key}=${String(value)}`),
    dshInvocation[0],
    ...dshInvocation.slice(1),
    '--profile',
    'pi-tui',
    ...args,
  ].map(shellQuote).join(' ')
  tmux(['new-session', '-d', '-s', name, '-x', '110', '-y', '34', '-c', cwd, command], `new-session ${name}`)
  return name
}

// ── process table (macOS `ps`, no /proc) ────────────────────────────────────

function processTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined || result.status !== 0) {
    throw new SplitSmokeAssertionError(`process table: ps failed: ${result.error?.message ?? result.stderr ?? ''}`)
  }
  const rows = []
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

function ownedProcessRows(workRoot) {
  return processTable().filter(row => row.command.includes(workRoot))
}

function roleOf(row) {
  if (row.command.includes('local-host.mjs')) return 'host'
  if (row.command.includes('local-client.mjs')) return 'client'
  if (row.command.includes(['dsh', 'lib', 'bin.js'].join('/'))) return 'supervisor'
  return undefined
}

function ownedRoles(workRoot) {
  const rows = ownedProcessRows(workRoot)
  return {
    rows,
    hosts: rows.filter(row => roleOf(row) === 'host'),
    clients: rows.filter(row => roleOf(row) === 'client'),
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function descendantsOf(rootPid) {
  const rows = processTable()
  const children = new Map()
  for (const row of rows) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    for (const child of children.get(pid) ?? []) {
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

function panePid(session) {
  const out = tmux(['list-panes', '-t', session, '-F', '#{pane_pid}'], `pane pid ${session}`).stdout.trim()
  const pid = Number(out.split('\n')[0])
  assert(Number.isSafeInteger(pid) && pid > 0, `pane pid ${session}: tmux returned ${JSON.stringify(out)}`)
  return pid
}

async function waitClientOfSession(session, workRoot, label) {
  const root = panePid(session)
  return await waitFor(() => {
    const row = descendantsOf(root).find(candidate => roleOf(candidate) === 'client')
    return row === undefined ? undefined : row
  }, `${label}: one real Client process below the pane`, TIMEOUTS.process)
}

// ── registry / sessions ─────────────────────────────────────────────────────

function scopeDir(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return undefined
  const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  return entries.length === 0 ? undefined : join(root, entries[0].name)
}

function readRegistry(dshHome) {
  const dir = scopeDir(dshHome)
  if (dir === undefined) return undefined
  const path = join(dir, 'instance.json')
  if (!existsSync(path)) return undefined
  try {
    return { path, record: JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return undefined
  }
}

async function waitRegistry(dshHome, label) {
  return await waitFor(() => {
    const registry = readRegistry(dshHome)
    return registry === undefined ? undefined : registry
  }, label, TIMEOUTS.process)
}

function sessionDirs(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const result = []
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue
    const scopeDirPath = join(root, scope.name)
    for (const session of readdirSync(scopeDirPath, { withFileTypes: true })) {
      if (session.isDirectory() && session.name.startsWith('session-')) {
        result.push({ sessionId: session.name, dir: join(scopeDirPath, session.name) })
      }
    }
  }
  return result
}

function sessionHasText(dshHome, sessionId, needle) {
  const events = hostSessionEvents(dshHome, sessionId)
  if (events === undefined) return false
  return events.some(event => JSON.stringify(event).includes(needle))
}

async function waitSessionWithText(dshHome, needle, label) {
  return await waitFor(() => {
    for (const session of sessionDirs(dshHome)) {
      if (sessionHasText(dshHome, session.sessionId, needle)) return session
    }
    return undefined
  }, label, TIMEOUTS.turn)
}

// ── the scene ───────────────────────────────────────────────────────────────

async function runScene({ installation, workRoot, report }) {
  const { dshHome, profileDir, dshInvocation, env, surfaceLlm } = installation
  ensureProfileStubLlm(profileDir, surfaceLlm)
  const projectA = join(workRoot, 'project-a')
  const projectB = join(workRoot, 'project-b')
  const projectRename = join(workRoot, 'project-rename')
  for (const dir of [projectA, projectB, projectRename]) mkdirSync(dir, { recursive: true })

  const sessions = new Set()
  const start = (options) => {
    const name = `pr2-${options.name}-${randomUUID().slice(0, 6)}`
    sessions.add(name)
    return startSession({ ...options, name })
  }

  // ── A01/A02: two SIMULTANEOUS cold public daemon Clients ─────────────────
  // Both start before any Host registry exists, so both race the Host seat
  // from a genuinely cold state. Exactly one Host may survive and both Clients
  // must converge on its instance.
  const a = start({ name: 'a', cwd: projectA, installation, backend: 'daemon' })
  const b = start({ name: 'b', cwd: projectB, installation, backend: 'daemon' })
  await Promise.all([
    waitPainted(a, 'A01 daemon Client A'),
    waitPainted(b, 'A02 daemon Client B'),
  ])
  await Promise.all([
    waitComposer(a, 'A01 Client A composer'),
    waitComposer(b, 'A02 Client B composer'),
  ])
  const registryA = await waitRegistry(dshHome, 'A01 Host registry')
  report.globalSeatDir = join(homedir(), '.dsh-pi-tui', 'run', registryA.record.scopeId)
  assert(registryA.record.schema === 2, `A01: the macOS Host must publish schema 2, saw ${String(registryA.record.schema)}`)
  assert(typeof registryA.record.hostKernelIdentity?.uniqueId === 'string', 'A01: the Host registry has no Darwin kernel identity')
  const clientA = await waitClientOfSession(a, workRoot, 'A01 Client A')
  const clientB = await waitClientOfSession(b, workRoot, 'A02 Client B')
  assert(alive(registryA.record.hostPid), 'A01: the published Host PID is not alive')
  assert(clientA.pid !== registryA.record.hostPid, 'A01: the Client PID equals the Host PID')
  assert(clientA.pid !== clientB.pid, 'A02: the two Clients report the same OS PID')
  await waitFor(() => {
    const liveHosts = ownedRoles(workRoot).hosts.filter(row => alive(row.pid))
    return liveHosts.length === 1 ? liveHosts : undefined
  }, 'A02 exactly one live Host after the simultaneous cold race', TIMEOUTS.process)
  await waitFor(() => {
    const registry = readRegistry(dshHome)
    return registry !== undefined && registry.record.instanceId === registryA.record.instanceId ? registry : undefined
  }, 'A02 both cold Clients attach to the SAME Host instance', TIMEOUTS.process)
  report.rows.push({ id: 'A01', status: 'PASS', hostPid: registryA.record.hostPid, clientPid: clientA.pid })
  report.rows.push({
    id: 'A02',
    status: 'PASS',
    simultaneousCold: true,
    hostPid: registryA.record.hostPid,
    clientAPid: clientA.pid,
    clientBPid: clientB.pid,
  })
  report.identity = {
    instanceId: registryA.record.instanceId,
    hostPid: registryA.record.hostPid,
    hostUniqueId: registryA.record.hostKernelIdentity.uniqueId,
    clientAPid: clientA.pid,
  }

  // ── RFL-005: a second DSH home aliasing the SAME canonical profile cannot
  // start a second Host. The Host seat is under the real account home, keyed
  // only by the canonical-profile scope id; the second home has its own
  // registry directory (and therefore no cross-home discovery) but no seat.
  const foreignHome = join(workRoot, 'foreign-dsh-home')
  mkdirSync(join(foreignHome, 'profiles'), { recursive: true, mode: 0o700 })
  symlinkSync(profileDir, join(foreignHome, 'profiles', 'pi-tui'))
  const foreign = start({
    name: 'rfl005-alias',
    cwd: projectA,
    installation,
    backend: 'daemon',
    dshHome: foreignHome,
  })
  const foreignClient = await waitClientOfSession(foreign, workRoot, 'RFL-005 foreign-home Client')
  // The foreign Client attempts its own Host candidate. That candidate loses
  // the account-home seat, so no registry ever appears in this home and the
  // Client's ordinary wait must end in a refusal, not attach across homes.
  let lastForeignFrame = ''
  try {
    await waitFor(() => {
      if (!tmuxSessionExists(foreign)) return true
      lastForeignFrame = tmuxCapture(foreign, 'RFL-005 foreign-home capture')
      if (lastForeignFrame.includes('type a message')) {
        throw new SplitSmokeAssertionError('RFL-005: the foreign home ATTACHED to a Host instead of being refused')
      }
      return undefined
    }, 'RFL-005 foreign-home Client is refused instead of attaching', 90_000)
  } catch (error) {
    const foreignRegistry = readRegistry(foreignHome)
    const liveHosts = ownedRoles(workRoot).hosts.filter(row => alive(row.pid)).map(row => row.pid)
    throw new SplitSmokeAssertionError(`${error instanceof Error ? error.message : String(error)}; foreign frame: ${lastForeignFrame.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1200)}; foreign registry: ${JSON.stringify(foreignRegistry?.record ?? null)}; live hosts: ${JSON.stringify(liveHosts)}; foreign pid alive: ${String(alive(foreignClient.pid))}`)
  }
  assert(readRegistry(foreignHome) === undefined,
    'RFL-005: the second DSH home published a Host registry')
  const liveHostsAfterAlias = ownedRoles(workRoot).hosts.filter(row => alive(row.pid))
  assert(liveHostsAfterAlias.length === 1,
    `RFL-005: expected exactly one live Host after the second-home launch, saw ${String(liveHostsAfterAlias.length)}`)
  assert(alive(registryA.record.hostPid), 'RFL-005: the first Host died when the second home launched')
  const globalSeatDir = join(homedir(), '.dsh-pi-tui', 'run', registryA.record.scopeId)
  const globalSeatFile = join(globalSeatDir, `seat-host-${registryA.record.scopeId}.lock`)
  assert(existsSync(globalSeatFile), 'RFL-005: the live Host seat is not under the real account home')
  assert((statSync(globalSeatDir).mode & 0o077) === 0, 'RFL-005: the global Host seat directory must be private 0700')
  assert((statSync(globalSeatFile).mode & 0o777) === 0o600, 'RFL-005: the global Host seat file must be 0600')
  assert(!existsSync(join(dshHome, 'run', 'dsh-pi-tui', registryA.record.scopeId, `seat-host-${registryA.record.scopeId}.lock`)),
    'RFL-005: the Host seat must not live under its own DSH_HOME')
  report.rfl005 = {
    secondHome: foreignHome,
    secondHomeClientPid: foreignClient.pid,
    secondHomeRegistry: false,
    liveHosts: liveHostsAfterAlias.length,
    seatRoot: 'account-home',
    seatFileMode: '0600',
    seatDirectoryMode: '0700',
  }
  // A real accepted turn over the offline Host LLM route, then the durable
  // Session sink (the official Host writer) proves the auto Workspace create.
  await waitComposer(a, 'A14')
  sendKeys(a, 'hello macos pr2 scene', 'A14 prompt')
  await waitFrameText(a, 'stub answer', 'A14 Host turn answer', TIMEOUTS.turn)
  const session = await waitSessionWithText(dshHome, 'hello macos pr2 scene', 'A14 durable Session log')
  const header = hostSessionHeader(dshHome, session.sessionId)
  assert(header !== undefined, 'A14: the durable Session has no header')
  assert(realpathSync(header.cwd) === realpathSync(projectA),
    `A14: the durable Session cwd ${JSON.stringify(header.cwd)} is not the Client launch directory ${JSON.stringify(projectA)}`)
  report.rows.push({
    id: 'A14',
    status: 'PASS',
    sessionId: session.sessionId,
    headerCwd: header.cwd,
    workspaceAuto: 'HOST_OBJECT_PROOF_ACCEPTED',
  })
  report.session = { sessionId: session.sessionId, headerCwd: header.cwd, durableLogCount: hostSessionLogCount(dshHome) }

  // ── A13: Client B owns its OWN launch workspace and Session ──────────────
  // A and B share one Host, but each Client's workspace proof is its own launch
  // object. B's prompt must create a distinct Session whose durable cwd is
  // projectB, while A's Session stays on projectA.
  await waitComposer(b, 'A13 Client B composer')
  sendKeys(b, 'hello from client b', 'A13 Client B prompt')
  await waitFrameText(b, 'stub answer', 'A13 Client B Host turn answer', TIMEOUTS.turn)
  const sessionB = await waitSessionWithText(dshHome, 'hello from client b', 'A13 durable Session B')
  const headerB = hostSessionHeader(dshHome, sessionB.sessionId)
  assert(headerB !== undefined, 'A13: Client B durable Session has no header')
  assert(sessionB.sessionId !== session.sessionId, 'A13: both Clients created the SAME Session')
  assert(realpathSync(headerB.cwd) === realpathSync(projectB),
    `A13: Client B Session cwd ${JSON.stringify(headerB.cwd)} is not its launch directory ${JSON.stringify(projectB)}`)
  report.rows.push({
    id: 'A13',
    status: 'PASS',
    clientBPid: clientB.pid,
    sessionId: sessionB.sessionId,
    headerCwd: headerB.cwd,
  })

  // ── A06/A09: a third Client opens the SAME durable Session ──────────────
  const c = start({ name: 'c', cwd: projectA, installation, backend: 'daemon', args: ['--session', session.sessionId] })
  await waitPainted(c, 'A06 resume Client C')
  await waitFrameText(c, 'hello macos pr2 scene', 'A06 resumed Session transcript', TIMEOUTS.mount)
  const clientC = await waitClientOfSession(c, workRoot, 'A06 Client C')
  assert(clientC.pid !== clientA.pid && clientC.pid !== clientB.pid, 'A06: the resume Client reused another Client PID')
  // ONE submitted prompt through the OFFICIAL Host writer must produce exactly
  // ONE durable user message for this Session, even though two live Clients
  // hold a surface on it.
  const writerText = 'single writer authority check'
  sendKeys(c, writerText, 'A06 single-writer prompt')
  // The resumed transcript already contains an older "stub answer"; wait for
  // THIS prompt rather than reusing that old frame text, then make sure the
  // Enter reached the composer before observing the durable writer result.
  await waitFrameText(c, writerText, 'A06 prompt reached the resumed composer', TIMEOUTS.mount)
  sendKey(c, 'Enter', 'A06 submit resumed prompt')
  await waitSessionWithText(dshHome, writerText, 'A06 durable user message from the resumed Client')
  const durableAfterC = hostSessionEvents(dshHome, session.sessionId)
  assert(durableAfterC !== undefined, 'A06: the resumed Session log is not readable')
  const writerMessages = durableAfterC.filter(event =>
    event.type === 'user/message' && JSON.stringify(event).includes(writerText))
  assert(writerMessages.length === 1,
    `A06: one submitted prompt must produce ONE durable user message, saw ${String(writerMessages.length)}`)
  sendKeys(c, '/exit', 'A06 exit C')
  await waitFor(() => (!tmuxSessionExists(c) ? true : undefined), 'A06 Client C exits', TIMEOUTS.exit)
  report.rows.push({
    id: 'A06',
    status: 'PASS',
    resumedSessionId: session.sessionId,
    clientCPid: clientC.pid,
    singleWriterUserMessages: writerMessages.length,
  })

  // ── A09: public `-c` and unique short-id lookup both resolve the Session ──
  const continued = start({ name: 'a09-continue', cwd: projectA, installation, backend: 'daemon', args: ['-c'] })
  await waitPainted(continued, 'A09 continue Client')
  await waitFrameText(continued, 'single writer authority check', 'A09 -c resumed the confirmed workspace Session', TIMEOUTS.mount)
  const continueClient = await waitClientOfSession(continued, workRoot, 'A09 continue Client')
  sendKeys(continued, '/exit', 'A09 exit continue Client')
  await waitFor(() => (!tmuxSessionExists(continued) ? true : undefined), 'A09 continue Client exits', TIMEOUTS.exit)
  const shortPrefix = session.sessionId.slice(0, 12)
  const lookup = start({ name: 'a09-lookup', cwd: projectA, installation, backend: 'daemon', args: ['--session', shortPrefix] })
  await waitPainted(lookup, 'A09 lookup Client')
  await waitFrameText(lookup, 'hello macos pr2 scene', 'A09 unique short-id lookup resumed the Session', TIMEOUTS.mount)
  const lookupClient = await waitClientOfSession(lookup, workRoot, 'A09 lookup Client')
  sendKeys(lookup, '/exit', 'A09 exit lookup Client')
  await waitFor(() => (!tmuxSessionExists(lookup) ? true : undefined), 'A09 lookup Client exits', TIMEOUTS.exit)
  report.rows.push({
    id: 'A09',
    status: 'PASS',
    continueClientPid: continueClient.pid,
    lookupClientPid: lookupClient.pid,
    shortPrefix,
    sessionId: session.sessionId,
  })

  // ── B03: SIGTERM cancels an in-flight authenticated startup wait ─────────
  // Freeze the Host so a fresh Client's official /connect cannot complete; the
  // Client must observe its startup signal and exit promptly, not sit on the
  // request until its route/transport timeout.
  assert(alive(registryA.record.hostPid), 'B03: the Host is not alive before the cancellation probe')
  process.kill(registryA.record.hostPid, 'SIGSTOP')
  let b03ClientPid
  let b03Session
  try {
    b03Session = start({ name: 'b03-sigterm', cwd: projectA, installation, backend: 'daemon' })
    b03ClientPid = (await waitClientOfSession(b03Session, workRoot, 'B03 Client')).pid
    // Let the Client reach its authenticated Host wait (the Host is frozen).
    await sleep(1_000)
    assert(alive(b03ClientPid), 'B03: the Client exited before the cancellation probe')
    const startedAt = Date.now()
    process.kill(b03ClientPid, 'SIGTERM')
    await waitFor(() => (!alive(b03ClientPid) ? true : undefined),
      'B03 Client stops while its Host startup wait is in flight', 5_000)
    const exitMs = Date.now() - startedAt
    assert(exitMs < 5_000, `B03: SIGTERM took ${String(exitMs)}ms; the in-flight startup wait was not cancelled`)
    report.rows.push({ id: 'B03', status: 'PASS', phase: 'authenticated-startup-wait', exitMs })
  } finally {
    process.kill(registryA.record.hostPid, 'SIGCONT')
    if (b03Session !== undefined && tmuxSessionExists(b03Session)) {
      tmux(['kill-session', '-t', b03Session], 'B03 remove cancelled Client session', { allowMissing: true })
    }
  }
  await waitFor(() => (alive(registryA.record.hostPid) ? true : undefined),
    'B03 Host resumes after the cancellation probe', TIMEOUTS.process)
  assert(readRegistry(dshHome)?.record.instanceId === registryA.record.instanceId,
    'B03: the Host identity changed during the cancellation probe')

  // ── A20: the workspace-object route refuses an unauthenticated request ──
  const origin = registryA.record.origin
  const routeResponse = await fetch(`${origin}/api/pi-tui.workspace-object`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: registryA.record.instanceId, path: projectA }),
  })
  const routeBytes = await routeResponse.text()
  assert(routeResponse.status === 401 || routeResponse.status === 403,
    `A20: the unauthenticated workspace-object request answered HTTP ${String(routeResponse.status)}`)
  assert(!/"device"|"inode"/u.test(routeBytes), 'A20: the refused route leaked a directory object')
  report.rows.push({ id: 'A20', status: 'PASS', unauthenticatedStatus: routeResponse.status })

  // ── A16: a renamed+recreated launch path is unverified ──────────────────
  const d = start({ name: 'd', cwd: projectRename, installation, backend: 'daemon' })
  await waitPainted(d, 'A16 Client D')
  await waitComposer(d, 'A16')
  renameSync(projectRename, `${projectRename}.old`)
  mkdirSync(projectRename)
  const logsBefore = hostSessionLogCount(dshHome)
  sendKeys(d, 'renamed workspace must not create a session', 'A16 prompt')
  // The revoked automatic proof routes the surface to the EXISTING Workspace
  // Browser and creates nothing. The recreated path may already own a Workspace
  // record from the pre-rename mount-time proposal; the refusal sink under test
  // is that the new inode never receives a Session and the surface is
  // unselected (no auto proposal survives the rename).
  let lastA16Frame = ''
  let browser
  try {
    browser = await waitFor(() => {
      if (!tmuxSessionExists(d)) throw new SplitSmokeAssertionError('A16: the tmux session exited instead of opening the Workspace Browser')
      lastA16Frame = tmuxCapture(d, 'A16 Workspace Browser capture')
      return lastA16Frame.includes('Sessions') && lastA16Frame.includes('Add directory') ? lastA16Frame : undefined
    }, 'A16 unselected Workspace Browser', TIMEOUTS.negativeWindow)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${error instanceof Error ? error.message : String(error)}; last painted frame: ${lastA16Frame.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1600)}`)
  }
  if (browser.includes('project-rename')) {
    assert(/project-rename · 0/u.test(browser),
      `A16: the recreated launch path received a Session: ${browser.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1200)}`)
  }
  await sleep(1_000)
  assert(hostSessionLogCount(dshHome) === logsBefore,
    `A16: the renamed launch path created a Session (${String(logsBefore)} -> ${String(hostSessionLogCount(dshHome))})`)
  const leakedPrompt = sessionDirs(dshHome).find(session => sessionHasText(dshHome, session.sessionId, 'renamed workspace must not create a session'))
  assert(leakedPrompt === undefined, `A16: the refused prompt reached a durable Session (${String(leakedPrompt?.sessionId)})`)
  // Teardown of the negative scene: its evidence is already settled, so this
  // uses the Client's ordinary SIGTERM stop path instead of typing into an
  // overlay-closed editor. A05 owns the real `/exit` contract.
  const clientD = await waitClientOfSession(d, workRoot, 'A16 Client D')
  try { process.kill(clientD.pid, 'SIGTERM') } catch { /* already gone */ }
  await waitFor(() => (!tmuxSessionExists(d) ? true : undefined), 'A16 Client D exits', TIMEOUTS.exit)
  report.rows.push({ id: 'A16', status: 'PASS', durableSessionLogs: logsBefore, surface: 'workspace-browser-unselected' })

  // ── A05: Client A exits; the Host and B survive ─────────────────────────
  sendKeys(a, '/exit', 'A05 exit A')
  await waitFor(() => (!tmuxSessionExists(a) ? true : undefined), 'A05 Client A exits', TIMEOUTS.exit)
  await waitFor(() => (!alive(clientA.pid) ? true : undefined), 'A05 Client A process is gone', TIMEOUTS.process)
  assert(tmuxSessionExists(b), 'A05: Client B exited with Client A')
  assert(alive(registryA.record.hostPid), 'A05: the Host exited with the last-interacted Client')
  const rolesAfterA = ownedRoles(workRoot)
  assert(rolesAfterA.hosts.filter(row => alive(row.pid)).length === 1, 'A05: the Host instance disappeared')
  assert(rolesAfterA.clients.filter(row => alive(row.pid)).length === 1,
    `A05: expected only Client B to remain, saw ${String(rolesAfterA.clients.length)}`)
  const durableAfterA = hostSessionEvents(dshHome, session.sessionId)
  assert(durableAfterA !== undefined && durableAfterA.some(event => JSON.stringify(event).includes('stub answer')),
    'A05: the committed turn was lost when Client A exited')
  report.rows.push({ id: 'A05', status: 'PASS', hostPid: registryA.record.hostPid, remainingClientPid: clientB.pid })

  // ── Direct default stays client-local ───────────────────────────────────
  const beforeDirect = ownedRoles(workRoot).clients.filter(row => alive(row.pid)).length
  const direct = start({ name: 'direct', cwd: projectA, installation, backend: undefined })
  await waitPainted(direct, 'C03 Direct TUI')
  assert(ownedRoles(workRoot).clients.filter(row => alive(row.pid)).length === beforeDirect,
    'C03: the Direct backend started a split Client')
  assert(alive(registryA.record.hostPid), 'C03: the Direct launch disturbed the running Host')
  sendKeys(direct, '/exit', 'C03 exit Direct')
  await waitFor(() => (!tmuxSessionExists(direct) ? true : undefined), 'C03 Direct exits', TIMEOUTS.exit)
  report.rows.push({ id: 'C03', status: 'PASS', directClientCount: beforeDirect })

  // ── no-TTY: fail closed before any Host side effect ─────────────────────
  const beforeNoTty = ownedRoles(workRoot)
  const noTty = spawnSync(dshInvocation[0], [...dshInvocation.slice(1), '--profile', 'pi-tui'], {
    cwd: profileDir,
    env: { ...env, DSH_PI_TUI_BACKEND: 'daemon', NO_COLOR: '1' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  const noTtyText = `${noTty.stdout ?? ''}${noTty.stderr ?? ''}`
  assert(noTty.status !== 0, `A01 no-TTY: the daemon selector exited ${String(noTty.status)}`)
  assert(/no-interactive-tty|interactive terminal/u.test(noTtyText), 'A01 no-TTY: the refusal reason was not reported')
  const afterNoTty = ownedRoles(workRoot)
  assert(afterNoTty.hosts.length === beforeNoTty.hosts.length && afterNoTty.clients.length === beforeNoTty.clients.length,
    'A01 no-TTY: the refused launch created Host/Client side effects')
  report.rows.push({ id: 'A01-NOTTY', status: 'PASS', exitCode: noTty.status })

  // Clean exit of the still-live Client B; the detached Host may remain (Host
  // authority) and is reclaimed by the scene cleanup below.
  sendKeys(b, '/exit', 'A05 exit B')
  await waitFor(() => (!tmuxSessionExists(b) ? true : undefined), 'A05 Client B exits', TIMEOUTS.exit)
  await waitFor(() => (!alive(clientB.pid) ? true : undefined), 'A05 Client B process is gone', TIMEOUTS.process)
  assert(alive(registryA.record.hostPid), 'A05: the Host exited when its last Client exited')
  report.rows.push({ id: 'A05-B', status: 'PASS', hostSurvivedLastClient: true })
  return { hostPid: registryA.record.hostPid }
}

// ── cleanup ────────────────────────────────────────────────────────────────

async function cleanup({ workRoot, installation, hostPid, report }) {
  const errors = []
  // 1. The private tmux server (only this run's sessions).
  if (TMUX_SOCKET !== '') {
    const kill = tmux(['kill-server'], 'cleanup tmux server', { allowMissing: true })
    if (kill.status !== 0 && !/no server running|no sessions|error connecting/u.test(`${kill.stderr ?? ''}`)) {
      errors.push(`tmux kill-server exited ${String(kill.status)}`)
    }
  }
  // 2. Only processes whose command line names THIS work root: the published
  //    Host first (SIGTERM is its own owner), then any surviving Clients.
  const owned = ownedProcessRows(workRoot).filter(row => roleOf(row) !== undefined)
  const targets = [
    ...(typeof hostPid === 'number' ? [{ pid: hostPid, command: 'published Host' }] : []),
    ...owned.filter(row => alive(row.pid)).map(row => ({ pid: row.pid, command: row.command })),
  ]
  for (const target of targets) {
    try { process.kill(target.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (targets.every(target => !alive(target.pid))) break
    await sleep(120)
  }
  for (const target of targets) {
    if (!alive(target.pid)) continue
    try { process.kill(target.pid, 'SIGKILL') } catch { /* gone */ }
  }
  await sleep(250)
  const survivors = targets.filter(target => alive(target.pid))
  if (survivors.length > 0) {
    report.notQuiesced = { survivors: survivors.map(target => target.pid), workRoot }
    errors.push(`NOT_QUIESCED: ${String(survivors.length)} owned process(es) survived cleanup`)
    return errors
  }
  // The Host seat under the real account home is the smoke's own scope; after
  // every owned process is gone it is safe to remove this run's directory.
  if (typeof report.globalSeatDir === 'string') {
    const seatDir = report.globalSeatDir
    if (dirname(seatDir) !== join(homedir(), '.dsh-pi-tui', 'run')) {
      errors.push(`refusing to remove an unexpected global seat directory: ${seatDir}`)
    } else {
      try { rmSync(seatDir, { recursive: true, force: true }) } catch (error) {
        errors.push(`global seat directory removal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  // 3. Remove the private work root only after every owned process is gone.
  if (!KEEP) {
    try { rmSync(workRoot, { recursive: true, force: true }) } catch (error) {
      errors.push(`work root removal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    report.keptWorkRoot = workRoot
  }
  return errors
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(explicitPath) {
  if (process.platform !== 'darwin') {
    throw new SplitSmokeAssertionError('smoke:macos-split is a macOS-only lane; this host is ' + process.platform)
  }
  const candidate = inspectSplitCandidate(explicitPath)
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-macos-pr2-'))
  const report = {
    lane: 'macos-split-parity',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    candidate: {
      path: resolve(candidate.tarball),
      sha256: sha256File(candidate.tarball),
      version: candidate.manifest.version,
      dshPin: candidate.targetDshVersion,
    },
    rows: [],
  }
  let installation
  let hostPid
  let failures = []
  try {
    installation = createSplitSmokeProfile({
      tarball: candidate.tarball,
      targetDshVersion: candidate.targetDshVersion,
      workDir: workRoot,
    })
    report.isolatedProfile = {
      dshHome: installation.dshHome,
      profileDir: installation.profileDir,
      dshVersion: candidate.targetDshVersion,
    }
    const scene = await runScene({ installation, workRoot, report })
    hostPid = scene.hostPid
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'
    report.error = error instanceof Error ? error.message : String(error)
    failures.push(report.error)
  } finally {
    if (installation !== undefined) {
      const cleanupErrors = await cleanup({ workRoot, installation, hostPid, report })
      failures = [...failures, ...cleanupErrors]
      report.cleanup = cleanupErrors.length === 0 ? 'QUIESCED' : 'FAILED'
    } else if (!KEEP) {
      try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* setup never completed */ }
    }
  }
  // The report is the lane's evidence. A caller may name a private directory
  // (this repository's qualification uses its own `temp/`); otherwise the file
  // stays in a fresh private OS temp directory. No product verdict depends on
  // the evidence write.
  const evidenceDir = process.env.MACOS_SPLIT_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'dsh-macos-pr2-evidence-'))
  try {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    const evidencePath = join(evidenceDir, `macos-split-parity-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
    writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    report.evidencePath = evidencePath
  } catch (error) {
    report.evidenceWriteError = error instanceof Error ? error.message : String(error)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (failures.length > 0) throw new SplitSmokeAssertionError(`macos-split-parity failed: ${failures.join('; ')}`)
  process.stderr.write('MACOS_SPLIT_PARITY: PASS\n')
}

try {
  const explicit = process.argv[2]
  await main(explicit)
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  process.stderr.write(`MACOS_SPLIT_PARITY: FAIL: ${message}\n`)
  process.exitCode = 1
}
