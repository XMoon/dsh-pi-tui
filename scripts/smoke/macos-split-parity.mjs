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
 *   P01/P02/P03/P04/P05/P06/P07/P09 the public macOS daemon management
 *       lifecycle: read-only no-Host status/logs, warm reuse, verified stop,
 *       cold start, admin-seat race, restart into a new instance and the
 *       no-plist default supervision fact.
 *   D4L (L01-L12) the explicit macOS launchd LaunchAgent: install identity and
 *       idempotence, negative file/job cases, native bootstrap/kickstart/bootout
 *       startup/stop/restart, logs, uninstall and the independent daemon
 *       regression, all on the SAME packed candidate and isolated profile.
 *   D2ACP (M01-M10) the macOS local ACP v1 endpoint on the SAME candidate: the
 *       short profile-scoped `/private/tmp` UDS, real bind/link/connect,
 *       shared-Session resume/new/close/prompt through the official Host
 *       writer, runtime Off/On, autoStart persistence and SIGTERM/SIGKILL
 *       socket retirement/reclaim. Every M row carries its own real evidence;
 *       M11 (Linux) stays NOT_VERIFIED here by design.
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

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectSplitCandidate, createSplitSmokeProfile } from '../lib/split-smoke-profile.mjs'
import { cleanupTrackedLaunchdResource } from '../lib/launchd-smoke-cleanup.mjs'
import { SplitSmokeAssertionError, SplitSmokeInputError, emitInputFailure } from '../lib/split-smoke-diagnostics.mjs'
import { hostSessionEvents, hostSessionLogCount, hostSessionHeader, waitForHostSessionHeader } from '../lib/split-smoke-sessions.mjs'

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
  daemon: 120_000,
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/**
 * Bound a helper promise for a NEGATIVE CONTROL: if the helper under test
 * regresses into never settling, the control must report a failure instead of
 * hanging the whole smoke. The guard timer is always cleared.
 */
function settleWithin(promise, deadlineMs) {
  let timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve({ kind: 'hung' }), deadlineMs)
  })
  return Promise.race([
    promise.then(() => ({ kind: 'settled' }), error => ({ kind: 'error', error })),
    deadline,
  ]).finally(() => clearTimeout(timer))
}

function describeOutcome(outcome) {
  return outcome.kind === 'error' ? outcome.error.message : outcome.kind
}

/** Kill and await one probe child this smoke created itself (not a management
 *  child): used even when the probe's own guard assertion is about to fail. */
async function reapOwnedProbeChild(pid) {
  if (pid === undefined) return
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  await waitFor(() => (!alive(pid) ? true : undefined),
    `owned probe child ${String(pid)} is reaped`, TIMEOUTS.process)
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

// ── public daemon management commands (real CLI processes) ──────────────────

/** The public `dsh --profile pi-tui daemon ...` invocation for this profile. */
function daemonInvocation(installation, args) {
  const { dshInvocation } = installation
  return [dshInvocation[0], ...dshInvocation.slice(1), '--profile', 'pi-tui', 'daemon', ...args]
}

function daemonEnvironment(installation, extraEnv = {}) {
  return { ...installation.env, NO_COLOR: '1', ...extraEnv }
}

/** The product's scope id / launchd label derivation for one canonical profile. */
const LAUNCHD_LABEL_PREFIX = 'com.xmoon.dsh-pi-tui'

function launchdScopeIdOf(profileDir) {
  const uid = process.getuid?.()
  assert(uid !== undefined, 'the launchd scope requires a local user identity')
  return createHash('sha256')
    .update(`dsh-pi-tui/local-scope/1\0${String(uid)}\0${realpathSync(profileDir)}`)
    .digest('hex')
}

function launchdLabelOf(profileDir) {
  return `${LAUNCHD_LABEL_PREFIX}.${launchdScopeIdOf(profileDir).slice(0, 40)}`
}

function launchdPlistPathOf(profileDir) {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabelOf(profileDir)}.plist`)
}

/** One fixed `/bin/launchctl` invocation (argument array, never a shell). */
function runLaunchctlCommand(args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: TIMEOUTS.daemon })
}

function launchctlJobPrint(label) {
  return runLaunchctlCommand(['print', `gui/${String(process.getuid())}/${label}`])
}

function OCT(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

function parseLaunchctlJobPid(stdout) {
  const match = /^\tpid = (\d+)$/mu.exec(stdout)
  return match === null ? undefined : Number(match[1])
}

/** A foreign same-Label job used only to prove fail-closed ownership checks.
 *  It carries the standard `launchctl print` fields (working directory, two log
 *  sinks and an environment block) so the product's narrow parser can attribute
 *  it as a FOREIGN SOURCE rather than an unparseable manager error. */
function foreignLaunchdPlist(label, logDir) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key><array><string>/bin/sleep</string><string>300</string></array>',
    '  <key>WorkingDirectory</key><string>/tmp</string>',
    `  <key>StandardOutPath</key><string>${join(logDir, 'foreign.stdout.log')}</string>`,
    `  <key>StandardErrorPath</key><string>${join(logDir, 'foreign.stderr.log')}</string>`,
    '  <key>EnvironmentVariables</key><dict><key>DSH_FOREIGN_PROBE</key><string>1</string></dict>',
    '  <key>RunAtLoad</key><false/>',
    '  <key>KeepAlive</key><false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** Run one management command to completion and keep its real exit/stdout/stderr.
 *  `extraEnv` reaches the Host spawned by start/restart (the daemon launcher
 *  inherits this process environment). */
function runDaemonCommand(installation, args, extraEnv = {}) {
  const result = spawnSync(daemonInvocation(installation, args)[0], daemonInvocation(installation, args).slice(1), {
    cwd: installation.profileDir,
    env: daemonEnvironment(installation, extraEnv),
    encoding: 'utf8',
    timeout: TIMEOUTS.daemon,
  })
  if (result.error !== undefined) {
    throw new SplitSmokeAssertionError(`daemon ${args.join(' ')}: could not run: ${result.error.message}`)
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Start one bounded child process. The deadline rejects only after the OS
 * reaped the child; the one exception is an already-reaped child whose
 * inherited stdout/stderr pipes are still held by a grandchild — the helper
 * owns those stream copies, so it releases them and settles at the deadline
 * instead of waiting for a `close` that may never come. So neither a hung
 * command nor a surviving pipe holder can block the smoke's cleanup/evidence
 * path or leave an owned subprocess behind.
 */
function startBoundedProcess(label, file, args, options) {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  /** The child's own process exit was observed; its pipes may still be held. */
  let reaped = false
  /** The deadline fired. */
  let timedOut = false
  /** The race coordinator asked to stop a still-pending child. */
  let terminating = false
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    fn(value)
  }
  const releaseStreams = () => {
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  const finishTimedOut = () => {
    releaseStreams()
    finish(settle.reject, new SplitSmokeAssertionError(
      `${label}: did not settle within ${String(options.timeoutMs)}ms (pid ${String(child.pid)})`,
    ))
  }
  const finishTerminated = () => {
    releaseStreams()
    finish(settle.resolve, { status: null, signal: 'SIGKILL', stdout, stderr, pid: child.pid, terminated: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    // A child that already exited must not be waited on again: the inherited
    // pipes are the only reason `close` is missing, and they are ours to drop.
    if (reaped) {
      finishTimedOut()
      return
    }
    try {
      // SIGKILL cannot be ignored; `exit` below proves the reap.
      child.kill('SIGKILL')
    } catch {
      finishTimedOut()
    }
  }, options.timeoutMs)
  child.stdout?.on('data', chunk => { stdout += chunk })
  child.stderr?.on('data', chunk => { stderr += chunk })
  child.once('error', error => {
    finish(settle.reject, new SplitSmokeAssertionError(`${label}: could not run: ${error.message}`))
  })
  child.once('exit', () => {
    reaped = true
    if (timedOut) finishTimedOut()
    else if (terminating) finishTerminated()
  })
  child.once('close', (status, signal) => {
    reaped = true
    if (timedOut) {
      finishTimedOut()
      return
    }
    if (terminating) {
      finishTerminated()
      return
    }
    finish(settle.resolve, { status, signal, stdout, stderr, pid: child.pid })
  })
  return {
    child,
    result,
    /** Stop an owned child that is still pending and await its settlement. */
    async dispose() {
      if (!settled) {
        terminating = true
        if (reaped) {
          // The process is already gone; only inherited pipes remain.
          finishTerminated()
        } else {
          try { child.kill('SIGKILL') } catch { finishTerminated() }
        }
      }
      return result.then(() => undefined, () => undefined)
    },
  }
}

/** Start one management command without waiting: two of these race the admin seat. */
function startDaemonCommand(installation, args) {
  const invocation = daemonInvocation(installation, args)
  return startBoundedProcess(`daemon ${args.join(' ')}`, invocation[0], invocation.slice(1), {
    timeoutMs: TIMEOUTS.daemon,
    cwd: installation.profileDir,
    env: daemonEnvironment(installation),
  })
}

/** Parse the fixed `key=value` status block without trusting line order. */
function statusFields(text) {
  const fields = {}
  for (const line of text.split('\n')) {
    const match = /^([a-z-]+)=(.*)$/u.exec(line)
    if (match !== null) fields[match[1]] = match[2]
  }
  return fields
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

/** The kernel start time of one pid: the identity a bare numeric pid does not carry. */
function kernelStartTime(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined || result.status !== 0) return undefined
  const value = result.stdout.trim()
  return value === '' ? undefined : value
}

/** Assert a guard refuses; the guard itself must never signal before refusing. */
function assertThrows(fn, label) {
  let threw = false
  try { fn() } catch { threw = true }
  assert(threw, `${label}: the identity guard did not refuse`)
}

/**
 * Prove a CAPTURED Host record is still the live, run-owned Host before a
 * destructive signal: the registry must still name the same instance and pid,
 * the kernel start time must be unchanged, and the current process table row
 * must carry THIS run root and the Host role. Throws on gone/different/unknown
 * and never signals.
 */
function verifyCapturedHost(dshHome, workRoot, captured, label) {
  const registry = readRegistry(dshHome)
  if (registry === undefined) {
    throw new SplitSmokeAssertionError(`${label}: the Host registry is gone; refusing to signal pid ${String(captured.hostPid)}`)
  }
  if (registry.record.instanceId !== captured.instanceId || registry.record.hostPid !== captured.hostPid) {
    throw new SplitSmokeAssertionError(
      `${label}: the registry now names instance ${String(registry.record.instanceId)}/pid ${String(registry.record.hostPid)}; `
      + `refusing to signal pid ${String(captured.hostPid)}`,
    )
  }
  const row = processTable().find(candidate => candidate.pid === captured.hostPid)
  if (row === undefined || roleOf(row) !== 'host' || !row.command.includes(workRoot)) {
    throw new SplitSmokeAssertionError(`${label}: pid ${String(captured.hostPid)} is not the live run-owned Host; refusing to signal`)
  }
  const currentStart = kernelStartTime(captured.hostPid)
  if (currentStart === undefined || currentStart !== captured.lstart) {
    throw new SplitSmokeAssertionError(
      `${label}: the kernel start time of pid ${String(captured.hostPid)} changed or is unreadable; refusing to signal`,
    )
  }
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

  // ── P01/P06-NOLOG/P07: no-Host management is read-only and macOS-specific ─
  // This runs BEFORE any Host or Client exists, so "no Host" is a real cold
  // state. The account-home seat root is the real OS account home (never
  // `$HOME`), so the negative control snapshots its entries instead of
  // guessing a scope id before the Host publishes one.
  const accountRunRoot = join(homedir(), '.dsh-pi-tui', 'run')
  const accountSeatsBefore = existsSync(accountRunRoot) ? readdirSync(accountRunRoot).sort() : []
  assert(scopeDir(dshHome) === undefined, 'P01: the isolated DSH home must start without a profile run scope')
  const noHostStatus = runDaemonCommand(installation, ['status'])
  const noHost = statusFields(noHostStatus.stdout)
  assert(noHostStatus.status === 0,
    `P01: daemon status with no Host exited ${String(noHostStatus.status)}: ${(noHostStatus.stderr).slice(-800)}`)
  assert(noHost.manager === 'unmanaged' && noHost['user-manager'] === 'not-checked'
    && noHost.host === 'stopped' && noHost.unit === 'none' && noHost['unit-state'] === 'not-found',
    `P01: unexpected no-Host status ${JSON.stringify(noHost)}`)
  assert(scopeDir(dshHome) === undefined, 'P01: status must not create the profile run scope')
  const noLogs = runDaemonCommand(installation, ['logs', '--lines', '20'])
  assert(noLogs.status === 4 && /LOG_SOURCE_UNAVAILABLE/u.test(noLogs.stderr),
    `P06-NOLOG: missing host.log must be LOG_SOURCE_UNAVAILABLE/4, saw ${String(noLogs.status)}: ${noLogs.stderr.slice(-800)}`)
  // No service definition exists yet: the no-plist status/logs above must not
  // create the profile scope or an account-home seat. D4L performs the explicit
  // install later against this same profile.
  assert(!existsSync(launchdPlistPathOf(profileDir)),
    'P07: no launchd plist may exist before the explicit D4L install')
  assert(scopeDir(dshHome) === undefined, 'P07: read-only commands must not create the profile run scope')
  const accountSeatsAfter = existsSync(accountRunRoot) ? readdirSync(accountRunRoot).sort() : []
  assert(accountSeatsAfter.join('\0') === accountSeatsBefore.join('\0'),
    `P01/P07: read-only commands created an account-home seat directory: ${JSON.stringify({ before: accountSeatsBefore, after: accountSeatsAfter })}`)
  report.rows.push(
    { id: 'P01', status: 'PASS', noHost, readOnlyScope: true, managerQueries: 0, launchdQuery: 'structurally proven no-launchctl-by-no-plist in daemon-control.test.ts' },
    { id: 'P06-NOLOG', status: 'PASS', exitCode: noLogs.status, code: 'LOG_SOURCE_UNAVAILABLE' },
    { id: 'P07-NOHOST', status: 'PASS', unit: noHost.unit, manager: noHost.manager, launchdPlist: false },
  )

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

  // ── P02/P03/P04/P05/P06/P09: the public macOS management lifecycle ───────
  // A05/A05-B already proved that Client exit does NOT stop the Host; every
  // stop below is an explicit management command, and the final cleanup
  // SIGTERM is the smoke's own reclaim rather than a management result.
  const original = registryA.record
  const readyStatus = runDaemonCommand(installation, ['status'])
  const ready = statusFields(readyStatus.stdout)
  assert(readyStatus.status === 0, `P02 status: exited ${String(readyStatus.status)}: ${readyStatus.stderr.slice(-800)}`)
  assert(ready.host === 'ready' && ready.manager === 'process' && ready.unit === 'none'
    && ready['user-manager'] === 'not-checked' && ready.pid === String(original.hostPid),
  `P02: unexpected ready status ${JSON.stringify(ready)}`)
  assert(ready.instance === original.instanceId.slice(0, 8), 'P02: status reported a different instance')
  const warm = runDaemonCommand(installation, ['start'])
  const warmFields = statusFields(warm.stdout)
  assert(warm.status === 0, `P02 warm start: exited ${String(warm.status)}: ${warm.stderr.slice(-800)}`)
  assert(warmFields.instance === original.instanceId.slice(0, 8),
    `P02: warm start changed the instance (${String(original.instanceId.slice(0, 8))} -> ${String(warmFields.instance)})`)
  assert(readRegistry(dshHome)?.record.instanceId === original.instanceId,
    'P02: warm start published a different Host instance')
  const daemonLogs = runDaemonCommand(installation, ['logs', '--lines', '20'])
  assert(daemonLogs.status === 0, `P06: daemon logs exited ${String(daemonLogs.status)}: ${daemonLogs.stderr.slice(-800)}`)
  assert(daemonLogs.stdout.trim() !== '', 'P06: daemon logs returned no Host log output')
  assert(!/connectUrl=\S|token=\S/iu.test(daemonLogs.stdout), 'P06: log output leaked unsanitized token material')
  report.rows.push(
    { id: 'P02-WARM', status: 'PASS', hostPid: original.hostPid, instance: original.instanceId, reused: true },
    { id: 'P06', status: 'PASS', source: 'scope/host.log', lines: 20, sanitized: true },
  )

  const stopped = runDaemonCommand(installation, ['stop'])
  assert(stopped.status === 0, `P03 stop: exited ${String(stopped.status)}: ${stopped.stderr.slice(-800)}`)
  assert(/^host=stopped$/mu.test(stopped.stdout), 'P03: stop did not report a stopped Host')
  assert(!alive(original.hostPid), 'P03: the original Host process identity is still alive after stop')
  const registryAfterStop = readRegistry(dshHome)
  assert(registryAfterStop === undefined || registryAfterStop.record.instanceId !== original.instanceId,
    'P03: the stopped Host registry still claims the original instance')
  const stoppedAgain = runDaemonCommand(installation, ['stop'])
  assert(stoppedAgain.status === 0 && /^host=stopped$/mu.test(stoppedAgain.stdout),
    `P03: a second stop is not an idempotent success (${String(stoppedAgain.status)})`)
  report.rows.push(
    { id: 'P03', status: 'PASS', oldHostPid: original.hostPid, oldIdentityGone: true, idempotentStop: true },
    { id: 'P09', status: 'PASS', clientDetachKeptHost: true, managementStopStoppedHost: true },
  )

  const cold = runDaemonCommand(installation, ['start'])
  const coldFields = statusFields(cold.stdout)
  assert(cold.status === 0, `P02 cold start: exited ${String(cold.status)}: ${cold.stderr.slice(-800)}`)
  assert(coldFields.host === 'ready' && coldFields.instance !== original.instanceId.slice(0, 8),
    'P02: a cold start did not publish a new authenticated instance')
  const coldRegistry = readRegistry(dshHome)
  assert(coldRegistry !== undefined, 'P02: the cold-started Host published no registry')
  assert(coldRegistry.record.instanceId !== original.instanceId, 'P02: the cold start reused the stopped instance')
  assert(alive(coldRegistry.record.hostPid), 'P02: the cold-started Host PID is not alive')
  report.rows.push({ id: 'P02-COLD', status: 'PASS', hostPid: coldRegistry.record.hostPid, instance: coldRegistry.record.instanceId })

  // P05: from a cold state two REAL management processes race the Darwin admin
  // seat; the winner cold-starts the Host while the loser must be BUSY before
  // any Host/unit mutation.
  const preRaceStop = runDaemonCommand(installation, ['stop'])
  assert(preRaceStop.status === 0, `P05: pre-race stop failed (${String(preRaceStop.status)})`)
  // Negative controls for the bounded race helper itself. Control 1: a child
  // that never exits must be reaped by the deadline, not merely abandoned by a
  // race. Control 2: a child that exits BEFORE the deadline but leaves a
  // grandchild holding the inherited stdout/stderr pipes must settle at its
  // deadline (a `close` may never come), and its owned streams are released.
  const hung = startBoundedProcess('P05 reaping control', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 500,
    cwd: workRoot,
    env: daemonEnvironment(installation),
  })
  const hungPid = hung.child.pid
  let hungFailure
  try {
    const outcome = await settleWithin(hung.result, 5_000)
    assert(outcome.kind === 'error' && /did not settle within 500ms/u.test(outcome.error.message),
      `P05: a never-exiting child must fail at its deadline, saw ${describeOutcome(outcome)}`)
    hungFailure = outcome.error
    assert(hungPid !== undefined && !alive(hungPid),
      `P05: the timed-out child pid ${String(hungPid)} was not reaped`)
  } finally {
    if (hungPid !== undefined && alive(hungPid)) {
      try { process.kill(hungPid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  assert(hungFailure !== undefined, 'P05: the reaping control did not settle')
  report.rows.push({ id: 'P05-REAP', status: 'PASS', timeoutMs: 500, reapedPid: hungPid })

  const pipePidFile = join(workRoot, 'p05-inherited-pipe-grandchild.pid')
  const pipeParent = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
    'fs.writeFileSync(process.argv[1], String(child.pid))',
    'process.exit(0)',
    '',
  ].join('\n')
  const pipeControl = startBoundedProcess('P05 inherited-pipe control', process.execPath, ['-e', pipeParent, pipePidFile], {
    timeoutMs: 500,
    cwd: workRoot,
    env: daemonEnvironment(installation),
  })
  let pipeGrandchildPid
  try {
    // Register the control's own grandchild BEFORE any assertion can fail: the
    // parent writes this pid synchronously at startup, so a helper regression
    // still leaves the finally a real identity to kill and reap.
    pipeGrandchildPid = await waitFor(() => {
      if (!existsSync(pipePidFile)) return undefined
      const value = Number(readFileSync(pipePidFile, 'utf8'))
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    }, 'P05 inherited-pipe control grandchild pid', TIMEOUTS.process)
    const outcome = await settleWithin(pipeControl.result, 5_000)
    assert(outcome.kind === 'error' && /did not settle within 500ms/u.test(outcome.error.message),
      `P05: an exited child with inherited pipes must settle at its deadline, saw ${describeOutcome(outcome)}`)
    assert(alive(pipeGrandchildPid), 'P05: the control grandchild should still hold the inherited pipes')
    const disposeOutcome = await settleWithin(pipeControl.dispose(), 5_000)
    assert(disposeOutcome.kind === 'settled', 'P05: dispose did not complete for an already-reaped child')
    report.rows.push({
      id: 'P05-PIPE',
      status: 'PASS',
      timeoutMs: 500,
      grandchildPid: pipeGrandchildPid,
      disposed: true,
    })
  } finally {
    // This grandchild is the control's own resource, not the management race's
    // child. If the guard was already hung, the pid above is still registered;
    // when even that registration failed, re-read the file once more.
    if (pipeGrandchildPid === undefined && existsSync(pipePidFile)) {
      try {
        const value = Number(readFileSync(pipePidFile, 'utf8'))
        if (Number.isSafeInteger(value) && value > 0) pipeGrandchildPid = value
      } catch { /* no registered pid */ }
    }
    await reapOwnedProbeChild(pipeGrandchildPid)
  }

  // Prove the P05-PIPE guard-FAILURE branch itself: a registered grandchild is
  // still killed and reaped even when the guarded promise never settles.
  const guardPidFile = join(workRoot, 'p05-guard-regression-grandchild.pid')
  const guardParent = spawn(process.execPath, ['-e', pipeParent, guardPidFile], {
    cwd: workRoot,
    env: daemonEnvironment(installation),
    stdio: 'ignore',
  })
  const guardParentExit = new Promise(resolve => {
    guardParent.once('exit', resolve)
    guardParent.once('error', resolve)
  })
  let guardGrandchildPid
  try {
    guardGrandchildPid = await waitFor(() => {
      if (!existsSync(guardPidFile)) return undefined
      const value = Number(readFileSync(guardPidFile, 'utf8'))
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    }, 'P05 guard-regression grandchild pid', TIMEOUTS.process)
    const guardOutcome = await settleWithin(new Promise(() => {}), 250)
    assert(guardOutcome.kind === 'hung',
      `P05: the guard-regression probe expected a hung guard, saw ${describeOutcome(guardOutcome)}`)
    await reapOwnedProbeChild(guardGrandchildPid)
    assert(!alive(guardGrandchildPid), 'P05: the guard-failure branch did not reap its grandchild')
    report.rows.push({ id: 'P05-GUARD', status: 'PASS', guardMs: 250, grandchildPid: guardGrandchildPid })
  } finally {
    await reapOwnedProbeChild(guardGrandchildPid)
    await guardParentExit
  }
  const raceOne = startDaemonCommand(installation, ['start'])
  const raceTwo = startDaemonCommand(installation, ['start'])
  let raceOutcomes
  try {
    raceOutcomes = await Promise.all([raceOne.result, raceTwo.result])
  } finally {
    // Every owned race child is either already settled or is killed and
    // awaited here, so a failure still reaches the normal cleanup/evidence path.
    await Promise.all([raceOne.dispose(), raceTwo.dispose()])
  }
  const winners = raceOutcomes.filter(outcome => outcome.status === 0)
  const busyLosers = raceOutcomes.filter(outcome => outcome.status === 5 && /DAEMON_CONTROL_BUSY/u.test(outcome.stderr))
  assert(winners.length === 1 && busyLosers.length === 1,
    `P05: expected one winner and one DAEMON_CONTROL_BUSY, saw ${JSON.stringify(raceOutcomes.map(outcome => ({ status: outcome.status, stderr: outcome.stderr.slice(-400) })))}`)
  const raceRegistry = readRegistry(dshHome)
  assert(raceRegistry !== undefined && alive(raceRegistry.record.hostPid), 'P05: the winning start published no live Host')
  const liveHostsAfterRace = ownedRoles(workRoot).hosts.filter(row => alive(row.pid))
  assert(liveHostsAfterRace.length === 1, `P05: the seat race produced ${String(liveHostsAfterRace.length)} Hosts`)
  report.rows.push({ id: 'P05', status: 'PASS', winnerExit: 0, loserExit: 5, loserCode: 'DAEMON_CONTROL_BUSY', hostCount: liveHostsAfterRace.length })

  const restarted = runDaemonCommand(installation, ['restart'])
  const restartFields = statusFields(restarted.stdout)
  assert(restarted.status === 0, `P04 restart: exited ${String(restarted.status)}: ${restarted.stderr.slice(-800)}`)
  assert(/^previous=/mu.test(restarted.stdout), 'P04: restart did not report the previous instance')
  assert(restartFields.host === 'ready', 'P04: the restarted Host is not ready')
  const restartRegistry = readRegistry(dshHome)
  assert(restartRegistry !== undefined, 'P04: restart published no registry')
  assert(restartRegistry.record.instanceId !== raceRegistry.record.instanceId, 'P04: restart reused the previous instance')
  assert(!alive(raceRegistry.record.hostPid), 'P04: the previous Host process is still alive')
  assert(alive(restartRegistry.record.hostPid), 'P04: the restarted Host PID is not alive')
  report.rows.push({ id: 'P04', status: 'PASS', oldInstance: raceRegistry.record.instanceId, newInstance: restartRegistry.record.instanceId })

  // P07: the pre-D4L management flow never creates a launchd plist and never
  // disturbs the live independent Host. The explicit install/uninstall verbs are
  // exercised natively by the D4L stage below.
  assert(alive(restartRegistry.record.hostPid), 'P07: the management flow disturbed the live Host')
  assert(readRegistry(dshHome)?.record.instanceId === restartRegistry.record.instanceId,
    'P07: the management flow changed the live Host instance')
  assert(!existsSync(launchdPlistPathOf(profileDir)),
    'P07: the no-install management flow wrote a launchd plist')
  report.rows.push({ id: 'P07-LIVE', status: 'PASS', hostUnchanged: true, launchdPlists: 0 })

  const d2acp = await runD2AcpScene({ installation, workRoot, report, start, projectA, projectB })
  await runD4LaunchdScene({ installation, workRoot, report, start, projectA, projectB })
  return { hostPid: d2acp.hostPid }
}

// ── D2ACP: the macOS local ACP endpoint (M01-M10 on the same candidate) ─────

/** The frozen trusted parent of the Darwin profile-scoped ACP endpoint. */
const DARWIN_ACP_PARENT = '/private/tmp'

/**
 * The frozen Darwin endpoint of one profile scope, derived the way an
 * independent advanced peer does: from the real published scope id and the
 * current OS uid. The smoke intentionally does NOT import product code for
 * this formula — it is the EXTERNAL client contract under test.
 */
function darwinAcpEndpoint(scopeId, uid) {
  const privateRoot = join(DARWIN_ACP_PARENT, `dpt-${String(uid)}-${String(scopeId).slice(0, 40)}`)
  return {
    privateRoot,
    publicPath: join(privateRoot, 'acp.sock'),
    privateBindPath: join(privateRoot, '.acp-priv', 'acp.sock'),
  }
}

/** Endian-neutral `lstat` facts; the pathname itself never enters the evidence. */
function lstatFacts(path) {
  const info = lstatSync(path)
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    uid: info.uid,
    mode: (info.mode & 0o7777).toString(8),
    isSocket: info.isSocket(),
    isDirectory: info.isDirectory(),
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
  }
}

function pathExists(path) {
  try { lstatSync(path); return true } catch { return false }
}

/** Connect once to a real UDS and classify the kernel outcome. */
function probeAcpSocket(path) {
  return new Promise(resolveProbe => {
    const socket = connect(path)
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(value)
    }
    socket.once('connect', () => finish({ connected: true }))
    socket.once('error', error => finish({ connected: false, code: error.code }))
    setTimeout(() => finish({ connected: false, code: 'TIMEOUT' }), 2_000)
  })
}

/** One raw ACP v1 NDJSON client over the SHORT physical endpoint (never /proc). */
class AcpClient {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.received = []
    this.waiter = undefined
    this.closed = new Promise(resolveClose => socket.on('close', () => resolveClose()))
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        this.received.push(message)
        const waiter = this.waiter
        if (waiter !== undefined) {
          this.waiter = undefined
          waiter(message)
        } else {
          this.queue.push(message)
        }
      }
    })
    socket.on('error', () => {})
  }

  static open(path) {
    return new Promise((resolveOpen, rejectOpen) => {
      const socket = connect(path)
      socket.once('connect', () => {
        socket.off('error', rejectOpen)
        resolveOpen(new AcpClient(socket))
      })
      socket.once('error', rejectOpen)
    })
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  next(timeoutMs = 30_000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolveNext, rejectNext) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        rejectNext(new Error(`d2acp raw client: no message within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.waiter = value => { clearTimeout(timer); resolveNext(value) }
    })
  }

  /** Send ONE request and await ITS response id; interleaved notifications are kept in `received`. */
  async request(id, method, params = {}, timeoutMs = TIMEOUTS.turn) {
    this.send({ jsonrpc: '2.0', id, method, params })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const message = await this.next(Math.max(1, deadline - Date.now()))
      if (message?.id === id) return message
    }
  }

  async initialize(id = 1) {
    return await this.request(id, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
  }

  close() {
    this.socket.destroy()
  }
}

/** An empty-object ACP success result (`{}`), no error. */
function isEmptyAcpResult(response) {
  return response?.error === undefined
    && response?.result !== undefined
    && typeof response.result === 'object'
    && response.result !== null
    && Object.keys(response.result).length === 0
}

/** One real non-TUI qualification Peer process driving the production ACP port. */
class AcpPeer {
  constructor(options) {
    this.label = options.label
    this.records = []
    this.stderrText = ''
    this.exited = false
    this.exitResult = undefined
    this.sequence = 0
    this.child = spawn(process.execPath, [options.installation.entries.client], {
      cwd: options.installation.profileDir,
      env: {
        ...options.installation.env,
        SPLIT_PROCESS_CLIENT_MODE: 'peer',
        SPLIT_PROCESS_DSH_ANCHOR: options.installation.anchor,
        SPLIT_PROCESS_PROFILE: 'pi-tui',
        SPLIT_PROCESS_SCRATCH: join(options.workRoot, `d2acp-peer-${randomUUID().slice(0, 8)}`),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    let buffer = ''
    this.child.stdout.on('data', chunk => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        try { this.records.push(JSON.parse(line)) } catch { /* the peer emits JSONL only; a torn tail is not a record */ }
      }
    })
    this.child.stderr.on('data', chunk => { this.stderrText += chunk })
    this.closed = new Promise(resolveClose => {
      this.child.once('close', (code, signal) => {
        this.exited = true
        this.exitResult = { code, signal }
        resolveClose(this.exitResult)
      })
    })
  }

  static async start(options) {
    const peer = new AcpPeer(options)
    await peer.waitFor(record => record.m4a0 === 'ready', `${options.label} peer ready`, 180_000)
    return peer
  }

  send(record) {
    this.child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  async waitFor(predicate, label, timeoutMs = TIMEOUTS.process) {
    const existing = this.records.find(predicate)
    if (existing !== undefined) return existing
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.records.find(predicate)
      if (found !== undefined) return found
      if (this.exited) {
        throw new SplitSmokeAssertionError(`${label}: the peer exited before its record (${JSON.stringify(this.exitResult)})`
          + (process.env.D2ACP_DEBUG === '1' ? `; stderr: ${this.stderrText.slice(-800)}` : ''))
      }
      await sleep(50)
    }
    throw new SplitSmokeAssertionError(`${label}: the peer record did not arrive before the deadline`)
  }

  /** Drive ONE control op and await exactly its requestId response. */
  async request(record, label) {
    const requestId = `d2acp-${String(++this.sequence)}-${String(process.pid)}-${randomUUID().slice(0, 6)}`
    this.send({ ...record, requestId })
    return await this.waitFor(candidate => candidate.requestId === requestId,
      `${this.label} ${label}`, TIMEOUTS.turn)
  }

  async shutdown() {
    if (this.exited) return this.exitResult
    try { this.send({ op: 'shutdown' }) } catch { /* the peer is already gone */ }
    const settled = await Promise.race([this.closed, sleep(20_000).then(() => undefined)])
    if (settled === undefined && !this.exited) {
      try { this.child.kill('SIGKILL') } catch { /* already gone */ }
      await this.closed
    }
    return this.exitResult
  }

  async dispose() {
    if (!this.exited) {
      try { this.child.kill('SIGKILL') } catch { /* already gone */ }
      await this.closed
    }
  }
}

/** Assert one `piTuiAcpAccess` control response reached the expected state. */
function assertAcpAccess(response, expected, label) {
  assert(response.ok === true, `${label}: the ACP access call failed (${String(response.errorCode ?? 'unknown')})`)
  assert(response.status?.state === expected,
    `${label}: the Host reported ${JSON.stringify(response.status)} instead of ${expected}`)
}

/** Bind a raw server at the endpoint the way another owner would (private bind -> hard link). */
async function bindForeignAcpEndpoint(endpoint) {
  const privateDir = join(endpoint.privateRoot, '.acp-priv')
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const server = createServer(socket => socket.destroy())
  let bindStat
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(endpoint.privateBindPath, () => { server.off('error', rejectListen); resolveListen() })
    })
    bindStat = lstatSync(endpoint.privateBindPath)
    chmodSync(endpoint.privateBindPath, 0o600)
    linkSync(endpoint.privateBindPath, endpoint.publicPath)
    unlinkSync(endpoint.privateBindPath)
    return {
      server,
      close: () => new Promise(resolveClose => server.close(() => resolveClose())),
    }
  } catch (error) {
    // Settle every resource this helper acquired: close the in-process server
    // (the enclosing scene never received it). A failed listen never bound this
    // name, so the catch must NOT unlink it; after a successful bind the server
    // close owns the private name, and any extra removal is limited to the exact
    // (dev,ino,uid) this helper published.
    if (server.listening) await new Promise(resolveClose => server.close(() => resolveClose()))
    if (bindStat !== undefined) {
      for (const path of [endpoint.privateBindPath, endpoint.publicPath]) {
        if (!existsSync(path)) continue
        try {
          const current = lstatSync(path)
          if (current.dev === bindStat.dev && current.ino === bindStat.ino && current.uid === bindStat.uid) unlinkSync(path)
        } catch { /* gone or unreadable: never guess */ }
      }
    }
    throw error
  }
}

/**
 * Install the repository's existing Host-workload fixture (the same one the
 * selection lanes use) into the isolated profile and point its default model at
 * the fixture provider. The `long-turn` scenario holds a REAL Host-admitted turn
 * on a release barrier, so the D2ACP stage can disconnect an ACP View while a
 * TUI turn is genuinely unsettled.
 */
function ensureHeldTurnFixture(profileDir) {
  const source = fileURLToPath(new URL('../fixtures/split-process-host-work.mjs', import.meta.url))
  const target = join(profileDir, 'split-process-host-work.mjs')
  copyFileSync(source, target)
  chmodSync(target, 0o600)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const stock = readFileSync(patchPath, 'utf8').replace(/\s*$/u, '')
  const rows = [
    '- insert:',
    '    - id: d2acp-host-work',
    `      name: 'file://${target}'`,
    '      inject: [llm, tools, jobs, subagents, agents, workingDirectory, typertGateway, connection, commands, attachments]',
    '- id: agent-default-model',
    '  config:',
    '    provider: c1-qualification',
    '    model: c1',
    '',
  ].join('\n')
  writeFileSync(patchPath, `${stock}\n${rows}`, { mode: 0o600 })
}

/** Read the held-turn fixture's own append-only proof records. */
function readHeldTurnEvents(root) {
  const path = join(root, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/**
 * Run one held-turn witness with the release barrier removed, and GUARANTEE the
 * Host turn is released again even when an assertion throws mid-flight. The
 * success path writes the barrier itself after the teardown fence; the finally
 * only restores it when the witness failed before that point.
 */
async function withHeldTurnBarrier(barrier, body) {
  rmSync(barrier, { force: true })
  try {
    return await body()
  } finally {
    if (!existsSync(barrier)) writeFileSync(barrier, 'release\n', { mode: 0o600 })
  }
}

/**
 * M01-M10 on the SAME packed candidate: the real public daemon Host, a real TUI
 * Client holding a Session, and a real non-TUI Peer that enables the Host's own
 * `piTuiAcpAccess`; every ACP fact comes from a real UDS connection served by
 * the installed bundle. M11 is Linux-only and is settled by the Linux lanes.
 */
async function runD2AcpScene({ installation, workRoot, report, start, projectA, projectB }) {
  const { dshHome, manifest } = installation
  const uid = process.getuid()
  const row = (id, evidence) => {
    const value = { id, status: 'PASS', ...evidence }
    report.rows.push(value)
    return value
  }
  const requireHost = label => {
    const registry = readRegistry(dshHome)
    assert(registry !== undefined, `${label}: the Host registry is missing`)
    return registry.record
  }
  const scopeId = requireHost('D2ACP initial Host').scopeId
  const endpoint = darwinAcpEndpoint(scopeId, uid)
  // Cleanup owns exactly this run's deterministic profile root; the raw path is
  // kept in memory until every owned process is gone, never in the evidence file.
  report.d2acpEndpointRoots = [endpoint.privateRoot]
  // The repository's existing Host-workload fixture holds a REAL admitted turn
  // on a release barrier. Every D2ACP Host boot receives the same scenario env;
  // the barrier file is pre-created so ordinary prompts release immediately and
  // only the M07 disconnect witness removes it.
  const heldTurnRoot = join(workRoot, 'd2acp-held-turn')
  mkdirSync(heldTurnRoot, { mode: 0o700 })
  const releaseBarrier = join(heldTurnRoot, 'long-turn.release')
  writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
  const d2acpHostEnv = {
    C1_SCENARIO: 'long-turn',
    C1_WORK_ROOT: heldTurnRoot,
    C1_HOLD_LONG_TURN: releaseBarrier,
  }
  const acpClients = []
  const peers = []
  const startPeer = async label => {
    const peer = await AcpPeer.start({ installation, workRoot, label })
    peers.push(peer)
    return peer
  }
  const openAcp = async label => {
    const client = await AcpClient.open(endpoint.publicPath)
    acpClients.push(client)
    return client
  }
  const openInitialized = async label => {
    const client = await openAcp(label)
    const init = await client.initialize(1)
    assert(init?.result?.protocolVersion === 1, `${label}: the endpoint must answer protocolVersion 1`)
    assert(init?.result?.agentInfo?.name === 'dsh-pi-tui', `${label}: agentInfo.name must be dsh-pi-tui`)
    assert(init?.result?.agentInfo?.version === manifest.version,
      `${label}: agentInfo.version must be the installed bundle version ${manifest.version}`)
    assert(init?.result?.agentCapabilities?.loadSession === false, `${label}: loadSession must stay false`)
    assert(init?.result?.agentCapabilities?.sessionCapabilities?.resume !== undefined,
      `${label}: sessionCapabilities.resume must be advertised`)
    assert(init?.result?.agentCapabilities?.sessionCapabilities?.close !== undefined,
      `${label}: sessionCapabilities.close must be advertised`)
    return { client, init }
  }
  const setAcp = async (peer, enabled, label) => {
    const response = await peer.request({ op: 'qualification-acp-access', acpEnabled: enabled }, label)
    if (response.ok !== true) return response
    assertAcpAccess(response, enabled ? 'enabled' : 'disabled', label)
    return response
  }
  const getAcp = async (peer, label) => {
    return await peer.request({ op: 'qualification-acp-access' }, label)
  }
  const writeAutoStart = async (peer, value, label) => {
    const response = await peer.request({ op: 'qualification-acp-autostart', acpAutoStart: value }, label)
    assert(response.ok === true && response.readBack === true && response.autoStart === value,
      `${label}: the autoStart preference did not settle to ${String(value)} (${JSON.stringify(response)})`)
    return response
  }
  const waitEndpoint = async label => {
    return await waitFor(() => (pathExists(endpoint.publicPath) ? lstatFacts(endpoint.publicPath) : undefined),
      `${label}: the public ACP endpoint to appear`, TIMEOUTS.daemon)
  }
  const waitEndpointGone = async label => {
    return await waitFor(() => (!pathExists(endpoint.publicPath) ? true : undefined),
      `${label}: the public ACP endpoint to retire`, TIMEOUTS.daemon)
  }
  const daemonStatus = label => {
    const result = runDaemonCommand(installation, ['status'])
    assert(result.status === 0, `${label}: daemon status exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
    return statusFields(result.stdout)
  }
  const daemonRestart = label => {
    const result = runDaemonCommand(installation, ['restart'], d2acpHostEnv)
    assert(result.status === 0, `${label}: daemon restart exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
    const fields = statusFields(result.stdout)
    assert(fields.host === 'ready', `${label}: the restarted Host is not ready (${JSON.stringify(fields)})`)
    return fields
  }
  const daemonStart = label => {
    const result = runDaemonCommand(installation, ['start'], d2acpHostEnv)
    assert(result.status === 0, `${label}: daemon start exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
    const fields = statusFields(result.stdout)
    assert(fields.host === 'ready', `${label}: the started Host is not ready (${JSON.stringify(fields)})`)
    return fields
  }
  const daemonStop = label => {
    const result = runDaemonCommand(installation, ['stop'])
    assert(result.status === 0, `${label}: daemon stop exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
    assert(/^host=stopped$/mu.test(result.stdout), `${label}: stop did not report a stopped Host`)
    return result
  }
  /** The Host log is append-only across boots; records are correlated by the
   *  CURRENT boot's published Host pid, never by an independent substring. */
  const hostLog = label => {
    const result = runDaemonCommand(installation, ['logs', '--lines', '1000'])
    assert(result.status === 0, `${label}: daemon logs exited ${String(result.status)}: ${result.stderr.slice(-500)}`)
    const records = []
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue
      try { records.push(JSON.parse(line)) } catch { /* a non-record Host diagnostic line */ }
    }
    return { text: result.stdout, records }
  }

  // ── M01/M02: the running public daemon Host + TWO real Clients ───────────
  const inherited = ['P01', 'P06-NOLOG', 'P07-NOHOST', 'A01', 'A02', 'P02-WARM', 'P02-COLD',
    'P03', 'P04', 'P05', 'P06', 'P07-LIVE', 'P09']
  for (const id of inherited) {
    assert(report.rows.some(entry => entry.id === id && entry.status === 'PASS'),
      `M02: the inherited macOS management row ${id} is not PASS in this run`)
  }
  // Load the held-turn fixture and the fixture model route on the CURRENT
  // profile, then restart once: every D2ACP turn (TUI and ACP) then uses the
  // controllable Host route.
  ensureHeldTurnFixture(installation.profileDir)
  const heldTurnBoot = daemonRestart('D2ACP restart with the held-turn fixture')
  const heldTurnHost = requireHost('D2ACP host after the held-turn restart')
  assert(heldTurnBoot.instance === heldTurnHost.instanceId.slice(0, 8),
    'D2ACP: the held-turn restart reported a different instance')

  const tui = start({ name: 'd2acp-tui', cwd: projectA, installation, backend: 'daemon' })
  await waitPainted(tui, 'D2ACP TUI paint')
  await waitComposer(tui, 'D2ACP TUI composer')
  sendKeys(tui, 'd2acp tui session marker', 'D2ACP TUI prompt')
  await waitFrameText(tui, 'long-turn answer', 'D2ACP TUI answer', TIMEOUTS.turn)
  const sessionA = (await waitSessionWithText(dshHome, 'd2acp tui session marker', 'D2ACP durable Session A')).sessionId
  const tuiClient = await waitClientOfSession(tui, workRoot, 'D2ACP TUI client')
  const peer = await startPeer('M01 peer')
  const hostAtStart = requireHost('M01 host')
  const readyStatus = daemonStatus('M01 status')
  assert(readyStatus.host === 'ready' && readyStatus.manager === 'process' && readyStatus.unit === 'none',
    `M01: unexpected ready status ${JSON.stringify(readyStatus)}`)
  assert(readyStatus.pid === String(hostAtStart.hostPid), 'M01: status reported a different Host pid')
  assert(readyStatus.instance === hostAtStart.instanceId.slice(0, 8), 'M01: status reported a different Host instance')
  const liveHosts = ownedRoles(workRoot).hosts.filter(candidate => alive(candidate.pid))
  assert(liveHosts.length === 1, `M01: expected exactly ONE live Host, saw ${String(liveHosts.length)}`)
  assert(alive(tuiClient.pid) && alive(peer.child.pid), 'M01: both Clients must be alive')
  assert(tuiClient.pid !== peer.child.pid && tuiClient.pid !== hostAtStart.hostPid,
    'M01: the two Clients and the Host must be distinct OS processes')
  assert(!existsSync(join(installation.home, 'Library', 'LaunchAgents')) || readdirSync(join(installation.home, 'Library', 'LaunchAgents')).length === 0,
    'M01: the daemon path must not write a launchd plist')
  row('M01', {
    hostPid: hostAtStart.hostPid,
    instanceId: hostAtStart.instanceId,
    clientPids: [tuiClient.pid, peer.child.pid],
    manager: readyStatus.manager,
    launchd: false,
  })
  row('M02', {
    inherited,
    stopIdentityGone: true,
    unknownIdentitySignal: 'daemon-control.test.ts (no SIGKILL on unknown identity)',
    unitVerbs: 'supported launchd install/uninstall; natively qualified by D4L',
  })

  // ── M03: default Off, no listener, Direct remains unavailable ────────────
  assert(!pathExists(endpoint.publicPath), 'M03: a default-Off Host must not bind the Darwin ACP endpoint')
  assert(!pathExists(join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock')),
    'M03: the macOS Host must not bind the Linux scope acp.sock either')
  const initialAccess = await getAcp(peer, 'M03 getStatus')
  assertAcpAccess(initialAccess, 'disabled', 'M03 initial status')
  row('M03', {
    state: 'disabled',
    publicSocket: false,
    scopeSocket: false,
    directUnavailable: 'settings-acp-controls.test.ts (Direct ACP port is truthfully unavailable)',
  })

  // ── M04: real enable -> short bind/link -> raw initialize; IN_USE negative ─
  const enabled = await setAcp(peer, true, 'M04 enable')
  assert(enabled.status?.state === 'enabled', 'M04: the enable did not report enabled')
  const socketFacts = await waitEndpoint('M04')
  const rootFacts = lstatFacts(endpoint.privateRoot)
  assert(rootFacts.isDirectory === true && rootFacts.isSymbolicLink === false,
    'M04: the endpoint root must be a real directory')
  assert(rootFacts.uid === uid, 'M04: the endpoint root must be owned by this uid')
  assert(rootFacts.mode === '700', `M04: the endpoint root must be 0700, saw ${rootFacts.mode}`)
  assert(socketFacts.isSocket === true, 'M04: the public endpoint must be a socket')
  assert(socketFacts.uid === uid, 'M04: the public endpoint must be owned by this uid')
  assert(socketFacts.mode === '600', `M04: the public endpoint must be 0600, saw ${socketFacts.mode}`)
  assert(socketFacts.dev === rootFacts.dev, 'M04: root and socket must share the same filesystem dev')
  assert(!pathExists(endpoint.privateBindPath), 'M04: the private bind name must be gone after publish')
  const m04Peer = peer
  const m04 = await openInitialized('M04 raw initialize')
  assert(m04.client.received.some(message => message.id === 1), 'M04: the initialize response must be on the wire')
  const hostAfterEnable = requireHost('M04 host')
  assert(hostAfterEnable.hostPid === hostAtStart.hostPid && hostAfterEnable.instanceId === hostAtStart.instanceId,
    'M04: enabling ACP must never replace the Host')
  m04.client.close()
  await m04.client.closed

  // Negative: a live foreign listener at the public path makes the enable refuse
  // (LOCAL_ACP_SOCKET_IN_USE) and is never overwritten or deleted.
  const disabled = await setAcp(m04Peer, false, 'M04 disable for the IN_USE probe')
  assert(disabled.status?.state === 'disabled', 'M04: the disable did not report disabled')
  await waitEndpointGone('M04 disable')
  const foreign = await bindForeignAcpEndpoint(endpoint)
  const foreignInode = lstatFacts(endpoint.publicPath).ino
  let inUseWireCode
  try {
    const busy = await m04Peer.request({ op: 'qualification-acp-access', acpEnabled: true }, 'M04 enable over a foreign listener')
    assert(busy.ok === false, 'M04: enabling over a live foreign listener must be refused')
    assert(busy.status === undefined, 'M04: a refused enable must not fabricate a status')
    inUseWireCode = typeof busy.errorCode === 'string' ? busy.errorCode : null
    assert(lstatFacts(endpoint.publicPath).ino === foreignInode, 'M04: the foreign endpoint inode must be untouched')
    const probe = await probeAcpSocket(endpoint.publicPath)
    assert(probe.connected === true, 'M04: the foreign listener must keep answering')
  } finally {
    await foreign.close()
    if (pathExists(endpoint.publicPath)) unlinkSync(endpoint.publicPath)
  }
  const afterReject = await getAcp(m04Peer, 'M04 status after the refusal')
  assertAcpAccess(afterReject, 'disabled', 'M04 status after the refusal')
  const reenabled = await setAcp(m04Peer, true, 'M04 clean re-enable')
  assert(reenabled.status?.state === 'enabled', 'M04: the clean re-enable did not report enabled')
  const rebound = await waitEndpoint('M04 re-enable')
  assert(rebound.ino !== foreignInode, 'M04: the clean re-enable must bind a NEW inode')
  const m04b = await openInitialized('M04 re-enabled raw initialize')
  m04b.client.close()
  await m04b.client.closed
  row('M04', {
    scopeIdPrefix: scopeId.slice(0, 8),
    rootMode: rootFacts.mode,
    socketMode: socketFacts.mode,
    socketInode: socketFacts.ino,
    initialize: true,
    bundleVersion: manifest.version,
    inUseRejected: true,
    inUseTaxonomy: 'unit-level LOCAL_ACP_SOCKET_IN_USE (test/app/local-acp-listener.test.ts)',
    inUseWireCode,
    foreignPreserved: true,
    hostInstanceUnchanged: true,
  })

  // ── M05: the ACP View shares ONE real TUI Session A; duplicate is refused ─
  const headerA = hostSessionHeader(dshHome, sessionA)
  assert(headerA !== undefined, 'M05: Session A has no durable header')
  assert(realpathSync(headerA.cwd) === realpathSync(projectA),
    `M05: Session A cwd ${JSON.stringify(headerA.cwd)} is not the Client launch directory ${JSON.stringify(projectA)}`)
  const connA = await openAcp('M05 resume connection')
  const initA = await connA.initialize(1)
  assert(initA?.result?.protocolVersion === 1, 'M05: initialize failed')
  const resumeA = await connA.request(2, 'session/resume', { sessionId: sessionA, cwd: realpathSync(projectA) })
  assert(isEmptyAcpResult(resumeA), `M05: session/resume(A) must return {} (got ${JSON.stringify(resumeA?.error ?? resumeA?.result)})`)
  const frameA = tmuxCapture(tui, 'M05 TUI frame')
  assert(frameA.includes('d2acp tui session marker'), 'M05: the real TUI lost Session A after the ACP resume')
  const connDup = await openAcp('M05 duplicate connection')
  await connDup.initialize(1)
  const duplicate = await connDup.request(2, 'session/resume', { sessionId: sessionA, cwd: realpathSync(projectA) })
  assert(duplicate?.error?.code === -32602 && duplicate?.error?.data?.code === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
    `M05: a second resume must fail LOCAL_ACP_VIEW_ALREADY_ATTACHED (got ${JSON.stringify(duplicate?.error ?? duplicate?.result)})`)
  connDup.close()
  await connDup.closed
  const hostAfterResume = requireHost('M05 host')
  assert(hostAfterResume.hostPid === hostAtStart.hostPid && hostAfterResume.instanceId === hostAtStart.instanceId,
    'M05: the ACP resume must never replace the Host')
  assert(alive(tuiClient.pid), 'M05: the TUI Client must stay alive across the ACP resume')
  row('M05', {
    sessionId: sessionA,
    durableCwd: 'client-launch-directory',
    tuiStillReferences: true,
    duplicateRejected: 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
    writer: 'one official Host Session',
  })

  // ── M06: session/new + a real TUI on B + a View-only close ───────────────
  // A fresh directory (never projectB, which the main scene already made a
  // Workspace) proves the official Workspace+Session creation path itself.
  const acpWorkspace = join(workRoot, 'd2acp-workspace')
  mkdirSync(acpWorkspace, { mode: 0o700 })
  const acpWorkspaceReal = realpathSync(acpWorkspace)
  const connNew = await openAcp('M06 session/new connection')
  await connNew.initialize(1)
  const created = await connNew.request(2, 'session/new', { cwd: acpWorkspaceReal, mcpServers: [] })
  assert(created?.error === undefined && typeof created?.result?.sessionId === 'string' && created.result.sessionId !== '',
    `M06: session/new must return a real sessionId (got ${JSON.stringify(created?.error ?? created?.result)})`)
  const sessionB = created.result.sessionId
  assert(sessionB !== sessionA, 'M06: session/new must create a distinct Session')
  // The SAME real Session is opened by a real TUI while the ACP View still holds
  // it. The TUI's prompt makes the first durable append, so the Session's real
  // header and Workspace cwd are settled BEFORE the View-only close.
  const tuiB = start({ name: 'd2acp-session-b', cwd: acpWorkspaceReal, installation, backend: 'daemon', args: ['--session', sessionB] })
  await waitPainted(tuiB, 'M06 TUI on Session B paint')
  await waitFrameText(tuiB, sessionB, 'M06 TUI shows the SAME Session id', TIMEOUTS.mount)
  const bTuiText = 'd2acp m06 tui session b marker'
  sendKeys(tuiB, bTuiText, 'M06 TUI prompt on Session B')
  await waitFrameText(tuiB, 'long-turn answer', 'M06 TUI turn on Session B', TIMEOUTS.turn)
  const headerB = await waitForHostSessionHeader(dshHome, sessionB, 'M06: Session B durable header', TIMEOUTS.process)
  assert(realpathSync(headerB.cwd) === acpWorkspaceReal,
    `M06: Session B cwd ${JSON.stringify(headerB.cwd)} is not the requested Workspace`)
  const eventsB = hostSessionEvents(dshHome, sessionB)
  assert(eventsB !== undefined
    && eventsB.filter(event => event.type === 'user/message' && JSON.stringify(event).includes(bTuiText)).length === 1,
    'M06: the TUI prompt must persist exactly ONE durable user message in Session B')
  const closeB = await connNew.request(3, 'session/close', { sessionId: sessionB })
  assert(isEmptyAcpResult(closeB), `M06: session/close(B) must return {} (got ${JSON.stringify(closeB?.error ?? closeB?.result)})`)
  // The close releases ONLY this ACP View: the same Session stays visible to the
  // real TUI (same Session, same durable turn), and no Agent/Session is deleted.
  assert(tmuxSessionExists(tuiB), 'M06: the real TUI must still be alive after the ACP View close')
  assert(tmuxCapture(tuiB, 'M06 TUI frame after the View close').includes(bTuiText),
    'M06: the real TUI must still show the same Session after the ACP View close')
  const badCwd = await connNew.request(4, 'session/new', { cwd: 'relative/path', mcpServers: [] })
  assert(badCwd?.error?.code === -32602 && badCwd?.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
    `M06: a relative cwd must be LOCAL_ACP_VIEW_INVALID_REQUEST (got ${JSON.stringify(badCwd?.error ?? badCwd?.result)})`)
  const badMcp = await connNew.request(5, 'session/new', {
    cwd: acpWorkspaceReal,
    mcpServers: [{ name: 'd2acp-mcp', command: '/bin/true', args: [], env: [] }],
  })
  assert(badMcp?.error?.code === -32602 && badMcp?.error?.data?.code === 'LOCAL_ACP_VIEW_INVALID_REQUEST',
    `M06: non-empty mcpServers must be LOCAL_ACP_VIEW_INVALID_REQUEST (got ${JSON.stringify(badMcp?.error ?? badMcp?.result)})`)
  const promptAfterClose = await connNew.request(6, 'session/prompt', {
    sessionId: sessionB,
    prompt: [{ type: 'text', text: 'must not dispatch' }],
  })
  assert(promptAfterClose?.error?.code === -32602 && promptAfterClose?.error?.data?.code === 'LOCAL_ACP_VIEW_NOT_OWNED',
    `M06: a detached session/prompt must be LOCAL_ACP_VIEW_NOT_OWNED (got ${JSON.stringify(promptAfterClose?.error ?? promptAfterClose?.result)})`)
  connNew.close()
  await connNew.closed
  const connResumeB = await openAcp('M06 resume B connection')
  await connResumeB.initialize(1)
  const resumeB = await connResumeB.request(2, 'session/resume', { sessionId: sessionB, cwd: acpWorkspaceReal })
  assert(isEmptyAcpResult(resumeB), `M06: B must stay resumable after close (got ${JSON.stringify(resumeB?.error ?? resumeB?.result)})`)
  connResumeB.close()
  await connResumeB.closed
  row('M06', {
    createdSession: sessionB,
    durableHeaderCwd: 'requested-workspace',
    tuiSharesSameSession: true,
    tuiVisibleAfterViewClose: true,
    closeReleasesViewOnly: true,
    resumableAfterClose: true,
    invalidCwdRejected: true,
    invalidMcpRejected: true,
    detachedPromptRejected: 'LOCAL_ACP_VIEW_NOT_OWNED',
  })

  // ── M07: a real ACP text prompt through the official Host writer ─────────
  const connPrompt = await openAcp('M07 prompt connection')
  await connPrompt.initialize(1)
  const createdC = await connPrompt.request(2, 'session/new', { cwd: acpWorkspaceReal, mcpServers: [] })
  assert(createdC?.error === undefined && typeof createdC?.result?.sessionId === 'string',
    `M07: session/new must create a Session for the prompt (got ${JSON.stringify(createdC?.error ?? createdC?.result)})`)
  const sessionC = createdC.result.sessionId
  const promptText = 'd2acp acp prompt marker'
  const promptResponse = await connPrompt.request(3, 'session/prompt', {
    sessionId: sessionC,
    prompt: [{ type: 'text', text: promptText }],
  })
  assert(promptResponse?.error === undefined, `M07: session/prompt failed (${JSON.stringify(promptResponse?.error)})`)
  assert(promptResponse.result?.stopReason === 'end_turn',
    `M07: the prompt must settle with end_turn, saw ${JSON.stringify(promptResponse.result)}`)
  const headerC = await waitForHostSessionHeader(dshHome, sessionC, 'M07: Session C durable header', TIMEOUTS.process)
  assert(realpathSync(headerC.cwd) === acpWorkspaceReal,
    `M07: Session C cwd ${JSON.stringify(headerC.cwd)} is not the requested Workspace`)
  // The ACP response can settle before the Host writer's log flush is visible;
  // wait for the complete durable fact (one user message, answer, turn end).
  const eventsC = await waitFor(() => {
    const events = hostSessionEvents(dshHome, sessionC)
    if (events === undefined) return undefined
    const users = events.filter(event => event.type === 'user/message' && JSON.stringify(event).includes(promptText))
    return users.length === 1
      && events.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes('long-turn answer'))
      && events.some(event => event.type === 'turn/end') ? events : undefined
  }, 'M07 official Host writer persists one prompt, the answer and turn/end', TIMEOUTS.turn)
  const userTexts = eventsC.filter(event => event.type === 'user/message' && JSON.stringify(event).includes(promptText))
  assert(userTexts.length === 1, `M07: exactly ONE durable user message must carry the prompt, saw ${String(userTexts.length)}`)
  const updates = connPrompt.received.filter(message => message.method === 'session/update')
  assert(updates.length > 0, 'M07: the ACP peer must receive its own session/update notifications')
  assert(updates.every(message => message.params?.sessionId === sessionC),
    'M07: the ACP connection must receive updates ONLY for its own Session')
  assert(connA.received.every(message => message.method !== 'session/update' || message.params?.sessionId !== sessionC),
    'M07: an unrelated ACP connection must not receive this Session updates')
  connPrompt.close()
  await connPrompt.closed
  // Negative: the Host's held-turn fixture admits a TUI turn on the SAME
  // Session and holds it at the model release barrier. The ACP View is physically
  // disconnected WHILE that Host-admitted turn is genuinely unsettled; only then
  // is the barrier released. The TUI turn must still settle on the official Host
  // writer. A disconnect that clears live TUI work cannot pass this witness.
  const connDisconnect = await openAcp('M07 disconnect View')
  await connDisconnect.initialize(1)
  const resumeBForDisconnect = await connDisconnect.request(2, 'session/resume', { sessionId: sessionB, cwd: acpWorkspaceReal })
  assert(isEmptyAcpResult(resumeBForDisconnect),
    `M07: the disconnect probe must attach Session B first (got ${JSON.stringify(resumeBForDisconnect?.error ?? resumeBForDisconnect?.result)})`)
  const heldText = 'd2acp m07 held tui during acp disconnect'
  // The fixture's userText is the WHOLE conversation truncated to 400 bytes, so
  // match the NEW held event by Session and sequence, not by prompt substring.
  const heldCountBefore = readHeldTurnEvents(heldTurnRoot)
    .filter(event => event.kind === 'long-turn-held' && event.sessionId === sessionB).length
  // Failure-path self-check for the interruption guard: a witness that throws
  // after the barrier is removed must still release the held Host turn.
  let interruptionCaught = false
  try {
    await withHeldTurnBarrier(releaseBarrier, async () => {
      throw new SplitSmokeAssertionError('M07 interruption self-check')
    })
  } catch {
    interruptionCaught = true
  }
  assert(interruptionCaught && existsSync(releaseBarrier),
    'M07: an interrupted held-turn witness must still release the barrier')
  await withHeldTurnBarrier(releaseBarrier, async () => {
    sendKeys(tuiB, heldText, 'M07 held TUI turn on the ACP-attached Session')
    let held
    const heldDeadline = Date.now() + TIMEOUTS.turn
    while (Date.now() < heldDeadline) {
      const heldEvents = readHeldTurnEvents(heldTurnRoot)
        .filter(event => event.kind === 'long-turn-held' && event.sessionId === sessionB)
      held = heldEvents.length > heldCountBefore ? heldEvents.at(-1) : undefined
      if (held !== undefined) break
      await sleep(100)
    }
    assert(held !== undefined,
      'M07 Host-admitted TUI turn is held: the fixture recorded no NEW long-turn-held event for the Session; '
      + `before=${String(heldCountBefore)}; now=${String(readHeldTurnEvents(heldTurnRoot)
        .filter(event => event.kind === 'long-turn-held' && event.sessionId === sessionB).length)}`)
    assert(typeof held.sessionId === 'string' && Number.isInteger(held.attempt),
      'M07: the held-turn fixture must name the Session and attempt')
    connDisconnect.close()
    await connDisconnect.closed
    // Host-observable teardown fence: the local close above is only THIS process's
    // FIN. A fresh resume of the same Session succeeds only after the Host has
    // released the disconnected View's claim, so the model barrier is released
    // strictly after the Host-side teardown decision, never before it.
    const teardownFence = await openAcp('M07 teardown fence')
    await teardownFence.initialize(1)
    const fenceDeadline = Date.now() + TIMEOUTS.turn
    let fenceResult
    let fenceAttempts = 0
    while (Date.now() < fenceDeadline) {
      fenceAttempts += 1
      fenceResult = await teardownFence.request(2, 'session/resume', { sessionId: sessionB, cwd: acpWorkspaceReal })
      if (isEmptyAcpResult(fenceResult)) break
      const fenceCode = fenceResult?.error?.data?.code
      assert(fenceCode === 'LOCAL_ACP_VIEW_ALREADY_ATTACHED',
        `M07 teardown fence: the Host answered the resume with ${JSON.stringify(fenceResult?.error ?? fenceResult?.result)} instead of releasing the old View`)
      await sleep(100)
    }
    assert(isEmptyAcpResult(fenceResult),
      `M07: the Host never released the disconnected View before the barrier release (attempts=${String(fenceAttempts)})`)
    teardownFence.close()
    await teardownFence.closed
    writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
    await waitFor(() => readHeldTurnEvents(heldTurnRoot).some(event =>
      event.kind === 'long-turn-released' && event.sessionId === held.sessionId && event.attempt === held.attempt),
    'M07 held TUI turn released after the ACP disconnect', TIMEOUTS.turn)
    const heldIndex = await waitFor(() => {
      const events = hostSessionEvents(dshHome, sessionB)
      if (events === undefined) return undefined
      const index = events.findIndex(event => event.type === 'user/message' && JSON.stringify(event).includes(heldText))
      return index < 0 ? undefined : index
    }, 'M07 held TUI prompt is durable on the official Session', TIMEOUTS.turn)
    await waitFor(() => {
      const events = hostSessionEvents(dshHome, sessionB)
      if (events === undefined) return undefined
      const rest = events.slice(heldIndex + 1)
      return rest.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes('long-turn answer'))
        && rest.some(event => event.type === 'turn/end') ? events : undefined
    }, 'M07 held TUI turn settles after the ACP disconnect', TIMEOUTS.turn)
    assert(tmuxSessionExists(tuiB) && tmuxCapture(tuiB, 'M07 TUI frame after the disconnect').includes(heldText),
      'M07: the TUI must still show its held same-Session work after the ACP View disconnect')
  })
  sendKeys(tuiB, '/exit', 'M07 exit the Session-B TUI')
  await waitFor(() => (!tmuxSessionExists(tuiB) ? true : undefined), 'M07 Session-B TUI exits', TIMEOUTS.exit)
  const hostAfterPrompt = requireHost('M07 host')
  assert(hostAfterPrompt.hostPid === hostAtStart.hostPid && hostAfterPrompt.instanceId === hostAtStart.instanceId,
    'M07: the ACP prompt must never replace the Host')
  row('M07', {
    sessionId: sessionC,
    stopReason: promptResponse.result.stopReason,
    durableHeaderCwd: 'requested-workspace',
    durableUserMessages: userTexts.length,
    ownUpdatesOnly: true,
    disconnectSameSessionTuiTurnSettled: true,
    hostAdmittedTurnHeldAtDisconnect: true,
    hostObservableViewTeardownFence: true,
    interruptionGuardSelfCheck: true,
    releasedAfterDisconnect: true,
    modelRoute: 'existing Host-workload held-turn fixture',
  })

  // ── M08: Off retires the socket; On rebinds the SAME endpoint ────────────
  const inodeBeforeOff = lstatFacts(endpoint.publicPath).ino
  const off = await setAcp(peer, false, 'M08 off')
  assert(off.status?.state === 'disabled', 'M08: the disable did not report disabled')
  await waitEndpointGone('M08 off')
  await connA.closed
  assert(hostSessionEvents(dshHome, sessionA) !== undefined, 'M08: the Host Session must survive an ACP Off')
  assert(lstatFacts(endpoint.privateRoot).mode === '700', 'M08: the endpoint root must survive an ACP Off')
  // Negative: a foreign regular file at the public path is refused and preserved.
  writeFileSync(endpoint.publicPath, 'FOREIGN-D2ACP', { mode: 0o600 })
  const unsafe = await peer.request({ op: 'qualification-acp-access', acpEnabled: true }, 'M08 enable over a foreign file')
  assert(unsafe.ok === false, 'M08: enabling over a foreign public file must be refused')
  assert(unsafe.status === undefined, 'M08: the refused enable must not fabricate a status')
  assert(readFileSync(endpoint.publicPath, 'utf8') === 'FOREIGN-D2ACP', 'M08: the foreign file must be preserved')
  assertAcpAccess(await getAcp(peer, 'M08 status after the refusal'), 'disabled', 'M08 status after the refusal')
  unlinkSync(endpoint.publicPath)
  const on = await setAcp(peer, true, 'M08 on')
  assert(on.status?.state === 'enabled', 'M08: the re-enable did not report enabled')
  const inodeAfterOn = (await waitEndpoint('M08 re-enable')).ino
  assert(inodeAfterOn !== inodeBeforeOff, 'M08: a re-enable must bind a new inode at the same endpoint')
  const connOn = await openAcp('M08 resumed connection')
  await connOn.initialize(1)
  const resumeOn = await connOn.request(2, 'session/resume', { sessionId: sessionA, cwd: realpathSync(projectA) })
  assert(isEmptyAcpResult(resumeOn), `M08: the original Session must stay resumable after Off/On (got ${JSON.stringify(resumeOn?.error ?? resumeOn?.result)})`)
  connOn.close()
  await connOn.closed
  assert(requireHost('M08 host').instanceId === hostAtStart.instanceId, 'M08: Off/On must never replace the Host instance')
  row('M08', {
    offRetiredSocket: true,
    oldPeerClosed: true,
    hostInstanceUnchanged: true,
    sessionDurable: true,
    sameEndpointRebound: true,
    inodeChanged: true,
    foreignFilePreserved: true,
    unsafeTaxonomy: 'unit-level LOCAL_ACP_UNSAFE_SOCKET (test/app/local-acp-listener.test.ts)',
    unsafeWireCode: typeof unsafe.errorCode === 'string' ? unsafe.errorCode : null,
  })

  // ── M09: autoStart persistence across a real Host boot ──────────────────
  sendKeys(tui, '/exit', 'M09 exit the TUI Client')
  await waitFor(() => (!tmuxSessionExists(tui) ? true : undefined), 'M09 TUI Client exits', TIMEOUTS.exit)
  await waitFor(() => (!alive(tuiClient.pid) ? true : undefined), 'M09 TUI Client process is gone', TIMEOUTS.process)
  await setAcp(peer, false, 'M09 disable before the preference write')
  await writeAutoStart(peer, true, 'M09 write autoStart On')
  const beforeRestart = requireHost('M09 host before restart')
  const restarted = daemonRestart('M09 restart with autoStart On')
  const afterRestart = requireHost('M09 host after restart')
  assert(afterRestart.instanceId !== beforeRestart.instanceId, 'M09: the restart must publish a new Host instance')
  assert(restarted.instance === afterRestart.instanceId.slice(0, 8), 'M09: restart reported a different instance')
  const autostartSocket = await waitEndpoint('M09 pre-Ready autostart bind')
  assert(autostartSocket.isSocket === true && autostartSocket.mode === '600',
    'M09: the autostart endpoint must be a 0600 socket')
  const autoConn = await openAcp('M09 autostart connection')
  const autoInit = await autoConn.initialize(1)
  assert(autoInit?.result?.protocolVersion === 1, 'M09: the autostart endpoint must answer ACP initialize')
  autoConn.close()
  await autoConn.closed
  const autoLog = hostLog('M09 autostart log')
  const preReadyRecords = autoLog.records.filter(record => record.m4a0 === 'acp-autostart'
    && record.processRole === 'host' && record.pid === afterRestart.hostPid
    && record.phase === 'pre-ready' && record.status === 'enabled')
  assert(preReadyRecords.length === 1,
    `M09: the CURRENT Host boot (pid ${String(afterRestart.hostPid)}) must log exactly ONE acp-autostart/pre-ready record, saw ${String(preReadyRecords.length)}`)
  assert(!autoLog.text.includes(`dpt-${String(uid)}-`), 'M09: the endpoint root must never appear in the Host log')
  await peer.dispose()

  const peer2 = await startPeer('M09 peer after restart')
  await writeAutoStart(peer2, false, 'M09 write autoStart Off')
  const restartedOff = daemonRestart('M09 restart with autoStart Off')
  const afterOffRestart = requireHost('M09 host after the Off restart')
  assert(afterOffRestart.instanceId !== afterRestart.instanceId, 'M09: the Off restart must publish a new Host instance')
  assert(restartedOff.instance === afterOffRestart.instanceId.slice(0, 8), 'M09: the Off restart reported a different instance')
  assert(!pathExists(endpoint.publicPath), 'M09: autoStart=false must bind NO endpoint on the next Host boot')
  await peer2.dispose()

  // Negative: autoStart=true + an unsafe endpoint root -> the Host still becomes
  // Ready, emits ONE redacted diagnostic and never prints the endpoint/path.
  const peer2b = await startPeer('M09 peer for the failure probe')
  await writeAutoStart(peer2b, true, 'M09 write autoStart On for the failure probe')
  await peer2b.dispose()
  rmSync(endpoint.privateRoot, { recursive: true, force: true })
  const unsafeTarget = join(workRoot, 'd2acp-unsafe-root-target')
  mkdirSync(unsafeTarget, { mode: 0o700 })
  symlinkSync(unsafeTarget, endpoint.privateRoot)
  const restartedUnsafe = daemonRestart('M09 restart with an unsafe endpoint root')
  const afterUnsafe = requireHost('M09 host after the unsafe boot')
  assert(afterUnsafe.instanceId !== afterOffRestart.instanceId, 'M09: the unsafe boot must publish a new Host instance')
  assert(restartedUnsafe.host === 'ready', 'M09: the Host must stay Ready when the ACP autostart bind fails')
  const unsafeLog = hostLog('M09 failed autostart log')
  const autostartDiagnostics = unsafeLog.records.filter(record => record.m4a0 === 'diagnostic'
    && record.code === 'acp-autostart-unavailable' && record.pid === afterUnsafe.hostPid)
  assert(autostartDiagnostics.length === 1,
    `M09: the CURRENT Host boot (pid ${String(afterUnsafe.hostPid)}) must log exactly ONE acp-autostart-unavailable diagnostic, saw ${String(autostartDiagnostics.length)}`)
  assert(typeof autostartDiagnostics[0].failure === 'string' && autostartDiagnostics[0].failure !== '',
    'M09: the autostart diagnostic must carry a fixed failure category')
  // Select the diagnostic of the CURRENT boot by its parsed record, never the
  // first historical line that happens to contain the code.
  const diagnosticLine = unsafeLog.text.split('\n').find(line => {
    if (!line.includes('acp-autostart-unavailable')) return false
    try { return JSON.parse(line).pid === afterUnsafe.hostPid } catch { return false }
  })
  assert(diagnosticLine !== undefined && !diagnosticLine.includes('acp.sock') && !diagnosticLine.includes('dpt-') && !diagnosticLine.includes('token='),
    'M09: the CURRENT boot autostart diagnostic must stay redacted (no endpoint/path/secret)')
  assert(!unsafeLog.text.includes(`dpt-${String(uid)}-`), 'M09: the endpoint root must never appear in the Host log')
  assert(readdirSync(unsafeTarget).length === 0, 'M09: the failed autostart must not write through the symlink')
  const peer3 = await startPeer('M09 peer after the unsafe boot')
  assertAcpAccess(await getAcp(peer3, 'M09 status after the failed autostart'), 'disabled',
    'M09 status after the failed autostart')
  rmSync(endpoint.privateRoot, { force: true })
  mkdirSync(endpoint.privateRoot, { mode: 0o700 })
  const recovered = await setAcp(peer3, true, 'M09 recover after restoring the root')
  assert(recovered.status?.state === 'enabled', 'M09: the Host must enable ACP once the endpoint root is restored')
  await writeAutoStart(peer3, false, 'M09 reset autoStart Off')
  row('M09', {
    preReadyBind: true,
    hostLogRecord: 'acp-autostart/pre-ready correlated to the current Host pid',
    autoStartOffNoBind: true,
    bindFailureHostReady: true,
    redactedDiagnostic: 'one acp-autostart-unavailable record, fixed failure category, no endpoint/path',
    corruptedSettings: 'acp-startup-preference.test.ts (missing/non-boolean section fails startup loudly)',
    recovery: true,
  })

  // ── M10: graceful SIGTERM retires the socket; SIGKILL stale is reclaimed ─
  const hostBeforeStop = requireHost('M10 host before stop')
  const stopped = daemonStop('M10 graceful stop')
  assert(/^host=stopped$/mu.test(stopped.stdout), 'M10: stop did not report a stopped Host')
  await waitFor(() => (!alive(hostBeforeStop.hostPid) ? true : undefined),
    'M10 old Host kernel identity is gone', TIMEOUTS.process)
  await waitEndpointGone('M10 graceful stop')
  const registryAfterStop = readRegistry(dshHome)
  assert(registryAfterStop === undefined || registryAfterStop.record.instanceId !== hostBeforeStop.instanceId,
    'M10: the stopped Host registry still claims the old instance')
  await peer3.dispose()
  const startAfterStop = daemonStart('M10 cold start after the graceful stop')
  const killedHost = requireHost('M10 SIGKILL host')
  const killedHostStart = kernelStartTime(killedHost.hostPid)
  assert(killedHostStart !== undefined, 'M10: the SIGKILL target must expose a kernel start time')
  const killedHostIdentity = { instanceId: killedHost.instanceId, hostPid: killedHost.hostPid, lstart: killedHostStart }
  assert(startAfterStop.instance === killedHost.instanceId.slice(0, 8), 'M10: the cold start reported a different instance')
  const peer4 = await startPeer('M10 SIGKILL peer')
  await setAcp(peer4, true, 'M10 enable before SIGKILL')
  const beforeKill = await waitEndpoint('M10 enable before SIGKILL')
  // Negative controls run against the REAL verifier before the destructive
  // signal: a mismatched registry/PID must leave a live decoy alone, and a
  // changed kernel start time must leave the real Host alone. Only a fully
  // verified captured identity reaches process.kill.
  const decoy = spawn('sleep', ['30'], { stdio: 'ignore' })
  try {
    assertThrows(
      () => verifyCapturedHost(dshHome, workRoot, { ...killedHostIdentity, hostPid: decoy.pid, instanceId: 'not-this-instance' }, 'M10 registry negative control'),
      'M10 registry negative control',
    )
    assert(alive(decoy.pid), 'M10: a mismatched identity must receive zero signals')
  } finally {
    try { decoy.kill('SIGTERM') } catch { /* already gone */ }
  }
  assertThrows(
    () => verifyCapturedHost(dshHome, workRoot, { ...killedHostIdentity, lstart: 'a different kernel start time' }, 'M10 start-time negative control'),
    'M10 start-time negative control',
  )
  assert(alive(killedHostIdentity.hostPid), 'M10: a changed kernel start time must receive zero signals')
  verifyCapturedHost(dshHome, workRoot, killedHostIdentity, 'M10 SIGKILL')
  process.kill(killedHostIdentity.hostPid, 'SIGKILL')
  await waitFor(() => (!alive(killedHost.hostPid) ? true : undefined),
    'M10 SIGKILLed Host is reaped', TIMEOUTS.process)
  const stale = lstatFacts(endpoint.publicPath)
  assert(stale.isSocket === true && stale.ino === beforeKill.ino,
    'M10: SIGKILL must leave the owned public socket inode behind')
  const staleProbe = await probeAcpSocket(endpoint.publicPath)
  assert(staleProbe.connected === false && staleProbe.code === 'ECONNREFUSED',
    `M10: the stale endpoint must refuse (saw ${JSON.stringify(staleProbe)})`)
  await peer4.dispose()
  const startAfterKill = daemonStart('M10 cold start after SIGKILL')
  const reclaimedHost = requireHost('M10 reclaimed host')
  assert(reclaimedHost.instanceId !== killedHost.instanceId, 'M10: the SIGKILL recovery must publish a new Host instance')
  assert(startAfterKill.instance === reclaimedHost.instanceId.slice(0, 8),
    'M10: the SIGKILL recovery reported a different instance')
  const peer5 = await startPeer('M10 reclaim peer')
  const reclaimed = await setAcp(peer5, true, 'M10 reclaim the stale endpoint')
  assert(reclaimed.status?.state === 'enabled', 'M10: the next Host must reclaim the stale endpoint')
  const afterReclaim = await waitEndpoint('M10 reclaimed endpoint')
  assert(afterReclaim.ino !== beforeKill.ino, 'M10: the reclaimed endpoint must be a new owned inode')
  const reclaimedConn = await openAcp('M10 reclaimed initialize')
  const reclaimedInit = await reclaimedConn.initialize(1)
  assert(reclaimedInit?.result?.protocolVersion === 1, 'M10: the reclaimed endpoint must answer ACP initialize')
  reclaimedConn.close()
  await reclaimedConn.closed
  assert(!alive(killedHost.hostPid), 'M10: the SIGKILLed Host must stay gone')
  await setAcp(peer5, false, 'M10 disable before cleanup')
  row('M10', {
    gracefulSocketRetired: true,
    gracefulIdentityGone: true,
    sigkillIdentityGuarded: true,
    sigkillIdentityNegativeControls: 2,
    sigkillStaleInodeStable: true,
    sigkillReclaimed: true,
    reclaimedEndpointInitialize: true,
    staleToggleFence: 'settings-acp-controls.test.ts (generation mismatch refuses before dispatch)',
  })
  row('M11', {
    status: 'NOT_VERIFIED',
    lane: 'linux',
    note: 'Linux PO1/PO1B/PO2 and daemon-control evidence is recorded by the Linux lanes on the same candidate; this macOS lane cannot execute /proc or systemd paths.',
  })

  for (const client of acpClients) {
    if (!client.socket.destroyed) client.close()
  }
  return { hostPid: requireHost('D2ACP final Host').hostPid }
}


// ── D4L: explicit macOS launchd LaunchAgent (L01-L12) ──────────────────────
//
// This stage runs on the SAME packed candidate, isolated profile, tmux server
// and live independent Host left by D2ACP. It performs the real native
// install/status/stop/start/restart/logs/uninstall lifecycle in the user
// `gui/<uid>` domain, and cleans only its own profile-scoped label.
async function runD4LaunchdScene({ installation, workRoot, report, start, projectA, projectB }) {
  const { dshHome, profileDir, profilePackage } = installation
  const uid = process.getuid?.()
  assert(uid !== undefined, 'D4L: the launchd lifecycle requires a local user identity')
  const entry = join(profilePackage, 'dist', 'local-host.mjs')
  const label = launchdLabelOf(profileDir)
  let plistPath = launchdPlistPathOf(profileDir)
  const scopeDirPath = join(realpathSync(dshHome), 'run', 'dsh-pi-tui', launchdScopeIdOf(profileDir))
  report.d4lLabels = report.d4lLabels ?? []
  const accountSeatRoot = join(homedir(), '.dsh-pi-tui', 'run')
  report.d4lSeatDirs = [join(accountSeatRoot, launchdScopeIdOf(profileDir))]
  const track = (nextLabel, nextPath) => {
    report.d4lLabels.push({ label: nextLabel, plistPath: nextPath })
    report.d4l = { label: nextLabel, plistPath: nextPath }
  }
  const recordPlistIdentity = (targetLabel, targetPath) => {
    const tracked = report.d4lLabels.find(item => item.label === targetLabel && item.plistPath === targetPath)
    if (tracked === undefined) return
    const info = lstatSync(targetPath)
    assert(info.isFile() && !info.isSymbolicLink(), `D4L: ${targetLabel} must be a regular plist for cleanup ownership`)
    tracked.identity = {
      dev: String(info.dev),
      ino: String(info.ino),
      sha256: createHash('sha256').update(readFileSync(targetPath)).digest('hex'),
    }
  }
  track(label, plistPath)
  const daemon = (args, extraEnv = {}) => runDaemonCommand(installation, args, extraEnv)
  const daemonOk = (args, name) => {
    const result = daemon(args)
    assert(result.status === 0, `D4L ${name}: daemon ${args.join(' ')} exited ${String(result.status)}: ${result.stderr.slice(-900)}`)
    return { result, fields: statusFields(result.stdout) }
  }
  const requireLiveHost = name => {
    const registry = readRegistry(dshHome)
    assert(registry !== undefined && alive(registry.record.hostPid), `D4L ${name}: no live Host registry`)
    return registry
  }
  const assertNoLoadedJob = (targetLabel, name) => {
    const print = launchctlJobPrint(targetLabel)
    assert(print.status === 113, `D4L ${name}: the job must not be loaded, saw exit ${String(print.status)}`)
  }

  // ── L01: no plist = the independent Host path, no launchd facts ──────────
  const initialHost = requireLiveHost('L01')
  assert(!existsSync(plistPath), 'L01: the isolated profile must start without a launchd plist')
  const l01Status = daemonOk(['status'], 'L01 status')
  assert(l01Status.fields.manager === 'process' && l01Status.fields.unit === 'none'
    && l01Status.fields['unit-state'] === 'not-found' && l01Status.fields.host === 'ready',
  `L01: unexpected no-plist status ${JSON.stringify(l01Status.fields)}`)
  const l01Logs = daemon(['logs', '--lines', '20'])
  assert(l01Logs.status === 0 && !/launchd (stdout|stderr)/u.test(l01Logs.stdout),
    'L01: the no-plist log source must stay host.log')
  const l01Print = launchctlJobPrint(label)
  assert(l01Print.status === 113, 'L01: no launchd job may be loaded before install')
  report.rows.push({ id: 'L01', status: 'PASS', manager: l01Status.fields.manager, launchdJob: false, hostPid: initialHost.record.hostPid,
    noPlistLaunchctl: 'structurally proven in daemon-control.test.ts (no plist => no launchctl call)' })

  // ── L02: explicit install beside a LIVE independent Host ─────────────────
  const l02 = daemonOk(['install'], 'L02 install')
  const installedLabel = l02.fields.unit
  assert(installedLabel === label, `L02: install reported ${String(installedLabel)}, expected ${label}`)
  assert(existsSync(plistPath), 'L02: install must write the exact account-home LaunchAgent')
  const plistStat = lstatSync(plistPath)
  assert(plistStat.isFile() && !plistStat.isSymbolicLink() && (plistStat.mode & 0o777) === 0o600,
    `L02: the plist must be a regular 0600 file, saw mode ${OCT(plistStat.mode)}`)
  const plistText = readFileSync(plistPath, 'utf8')
  recordPlistIdentity(label, plistPath)
  const lint = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8', timeout: 15_000 })
  assert(lint.status === 0, `L02: plutil -lint rejected the plist: ${lint.stderr.slice(-500)}`)
  assert(plistText.includes('<key>RunAtLoad</key>\n  <false/>') && plistText.includes('<key>KeepAlive</key>\n  <false/>'),
    'L02: the installed job must not start at login or auto-restart')
  assert(plistText.includes('<integer>63</integer>'), 'L02: the installed job must carry Umask=0077')
  assert(plistText.includes('/dist/local-host.mjs'), 'L02: the job must run the installed foreground Host entry')
  const plistEntry = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]+<\/string>\s*<string>([^<]+)<\/string>/u.exec(plistText)
  assert(plistEntry !== null && existsSync(plistEntry[1]) && plistEntry[1].endsWith('/dist/local-host.mjs'),
    'L02: ProgramArguments must name an existing installed dist/local-host.mjs')
  assert(!/daemonize|--daemon|<string>\/bin\/sh<\/string>/u.test(plistText), 'L02: the job must not wrap the Host in a shell or daemonize flag')
  assert(plistText.includes(`<string>${realpathSync(profileDir)}</string>`), 'L02: WorkingDirectory must be the canonical profile')
  assert(plistText.includes('<key>X-DshPiTuiOwner</key>\n  <string>local-host-launchd-v1</string>'), 'L02: missing owner metadata')
  assert(plistText.includes(`<key>X-DshPiTuiScopeId</key>\n  <string>${launchdScopeIdOf(profileDir)}</string>`), 'L02: missing scope metadata')
  const envBlock = plistText.slice(plistText.indexOf('<key>EnvironmentVariables</key>'), plistText.indexOf('\n  </dict>', plistText.indexOf('<key>EnvironmentVariables</key>')))
  assert((envBlock.match(/^    <key>/gmu) ?? []).length === 3, 'L02: the LaunchAgent environment must carry exactly the three official anchors')
  assert(envBlock.includes('<key>DSH_HOME</key>') && envBlock.includes(`<string>${realpathSync(dshHome)}</string>`),
    'L02: DSH_HOME must be the canonical isolated official home')
  assertNoLoadedJob(label, 'L02 install')
  const l02Host = requireLiveHost('L02 host unchanged')
  assert(l02Host.record.instanceId === initialHost.record.instanceId && l02Host.record.hostPid === initialHost.record.hostPid,
    'L02: install must not migrate, restart or kill the running independent Host')
  const l02Status = daemonOk(['status'], 'L02 status')
  assert(l02Status.fields.unit === label && l02Status.fields['unit-state'] === 'not-found'
    && l02Status.fields.manager === 'process' && l02Status.fields.host === 'ready',
  `L02: unexpected installed status ${JSON.stringify(l02Status.fields)}`)
  const l02Logs = daemon(['logs', '--lines', '20'])
  assert(l02Logs.status === 0 && !/launchd (stdout|stderr)/u.test(l02Logs.stdout),
    'L02: an installed but unloaded job must not replace the independent host.log source')
  report.rows.push({ id: 'L02', status: 'PASS', label, plistMode: OCT(plistStat.mode), plutil: 'PASS', bootstrap: false,
    hostUnchanged: true, hostPid: l02Host.record.hostPid, envKeys: 3 })

  // ── L02 negative: user edit, other build, symlink, foreign loaded job ────
  const userEdited = `${plistText}\n<!-- d4l user runtime edit -->\n`
  writeFileSync(plistPath, userEdited, { mode: 0o600 })
  const reinstall = daemon(['install'])
  assert(reinstall.status === 0 && readFileSync(plistPath, 'utf8') === userEdited,
    'L02-NEG: a repeat install must succeed and preserve user runtime content')
  const otherBuild = plistText.replace(/(<key>X-DshPiTuiInstallBuild<\/key>\n  <string>)[0-9a-f]{64}/u, `$1${'e'.repeat(64)}`)
  assert(otherBuild !== plistText && otherBuild.includes('e'.repeat(64)), 'L02-NEG: could not build the other-build plist fixture')
  writeFileSync(plistPath, otherBuild, { mode: 0o600 })
  const otherBuildInstall = daemon(['install'])
  assert(otherBuildInstall.status === 3 && /IDENTITY_OR_OWNERSHIP_REFUSED/u.test(otherBuildInstall.stderr),
    `L02-NEG other build: expected exit 3, saw ${String(otherBuildInstall.status)}: ${otherBuildInstall.stderr.slice(-500)}`)
  assert(readFileSync(plistPath, 'utf8') === otherBuild, 'L02-NEG: an other-build plist must never be overwritten')
  const symlinkTarget = join(workRoot, 'd4l-symlink-target.plist')
  writeFileSync(symlinkTarget, plistText, { mode: 0o600 })
  unlinkSync(plistPath)
  symlinkSync(symlinkTarget, plistPath)
  const symlinkInstall = daemon(['install'])
  assert(symlinkInstall.status === 3 && lstatSync(plistPath).isSymbolicLink(),
    'L02-NEG symlink: install must refuse and preserve the symlink')
  unlinkSync(plistPath)
  writeFileSync(plistPath, plistText, { mode: 0o600 })
  recordPlistIdentity(label, plistPath)
  const foreignLogDir = join(workRoot, 'd4l-foreign-logs')
  mkdirSync(foreignLogDir, { recursive: true, mode: 0o700 })
  const foreignPlist = join(workRoot, 'd4l-foreign.plist')
  writeFileSync(foreignPlist, foreignLaunchdPlist(label, foreignLogDir), { mode: 0o600 })
  const foreignBootstrap = runLaunchctlCommand(['bootstrap', `gui/${String(uid)}`, foreignPlist])
  assert(foreignBootstrap.status === 0, `L02-NEG foreign job: bootstrap exited ${String(foreignBootstrap.status)}: ${foreignBootstrap.stderr.slice(-500)}`)
  const foreignPrint = launchctlJobPrint(label)
  assert(foreignPrint.status === 0 && foreignPrint.stdout.includes(`path = ${realpathSync(foreignPlist)}`),
    'L02-NEG foreign job: the same-label job must be loaded from the foreign file')
  const foreignInstall = daemon(['install'])
  assert(foreignInstall.status === 3 && /IDENTITY_OR_OWNERSHIP_REFUSED/u.test(foreignInstall.stderr),
    `L02-NEG foreign job: expected exit 3, saw ${String(foreignInstall.status)}: ${foreignInstall.stderr.slice(-500)}`)
  assert(readFileSync(plistPath, 'utf8') === plistText, 'L02-NEG foreign job: the owned plist must not be rewritten')
  runLaunchctlCommand(['bootout', `gui/${String(uid)}/${label}`])
  report.rows.push({ id: 'L02-NEG', status: 'PASS', userEditPreserved: true, otherBuildRefused: true, symlinkRefused: true, foreignJobRefused: true })

  // ── L07 (independent): uninstall removes only the plist ─────────────────
  const l07a = daemonOk(['uninstall'], 'L07 independent uninstall')
  assert(!existsSync(plistPath), 'L07 independent: uninstall must remove the owned plist')
  const l07aHost = requireLiveHost('L07 independent host unchanged')
  assert(l07aHost.record.instanceId === initialHost.record.instanceId, 'L07 independent: uninstall must not stop or migrate the Host')
  assert(l07a.fields.host === 'ready', 'L07 independent: status must still report the untouched Host')
  const l07aAgain = daemonOk(['uninstall'], 'L07 independent idempotent')
  assert(existsSync(plistPath) === false && /^unit=none$/mu.test(l07aAgain.result.stdout),
    'L07 independent: a repeat uninstall must be an idempotent no-plist success')
  report.rows.push({ id: 'L07-INDEPENDENT', status: 'PASS', plistRemoved: true, hostUnchanged: true, idempotent: true })

  // Reinstall for the ownership/start/stop lifecycle against the still-live
  // independent Host.
  const l03Install = daemonOk(['install'], 'L03 install')
  assert(l03Install.fields.unit === label && existsSync(plistPath), 'L03: the reinstall did not create the owned plist')
  recordPlistIdentity(label, plistPath)

  // ── L04 negative: a loaded foreign same-Label job + kickstart ────────────
  const foreignBootstrap2 = runLaunchctlCommand(['bootstrap', `gui/${String(uid)}`, foreignPlist])
  assert(foreignBootstrap2.status === 0, 'L04-NEG: the foreign job bootstrap failed')
  const foreignKick = runLaunchctlCommand(['kickstart', `gui/${String(uid)}/${label}`])
  assert(foreignKick.status === 0, 'L04-NEG: the foreign job kickstart failed')
  const foreignPid = parseLaunchctlJobPid(launchctlJobPrint(label).stdout)
  assert(foreignPid !== undefined && foreignPid !== initialHost.record.hostPid, 'L04-NEG: the foreign job PID must differ from the authenticated Host')
  const l04Mismatch = daemon(['status'])
  const l04MismatchFields = statusFields(l04Mismatch.stdout)
  assert(l04Mismatch.status === 3 && /IDENTITY_OR_OWNERSHIP_REFUSED/u.test(l04Mismatch.stderr)
    && l04MismatchFields.manager === 'unmanaged' && l04MismatchFields.host === 'ready',
  `L04-NEG: expected a pid-mismatch refusal with host=ready/manager=process, saw ${String(l04Mismatch.status)} ${JSON.stringify(l04MismatchFields)}: ${l04Mismatch.stderr.slice(-500)}`)
  runLaunchctlCommand(['bootout', `gui/${String(uid)}/${label}`])
  report.rows.push({ id: 'L04-NEG1', status: 'PASS', foreignPid, hostPid: initialHost.record.hostPid, manager: l04MismatchFields.manager })

  // ── stop the independent Host while the owned plist is installed ────────
  const independentStop = daemonOk(['stop'], 'L05 independent stop')
  assert(/^host=stopped$/mu.test(independentStop.result.stdout), 'L05 independent: stop did not report a stopped Host')
  assert(!alive(initialHost.record.hostPid), 'L05 independent: the original Host identity is still alive')
  assert(existsSync(plistPath), 'L05 independent: stop must not remove the installed plist')
  assertNoLoadedJob(label, 'L05 independent stop')
  report.rows.push({ id: 'L05-INDEPENDENT', status: 'PASS', hostPid: initialHost.record.hostPid, plistKept: true })

  // ── L04 negative: loaded but NOT started is never Ready/launchd ─────────
  const ownBootstrap = runLaunchctlCommand(['bootstrap', `gui/${String(uid)}`, plistPath])
  assert(ownBootstrap.status === 0, 'L04-NEG2: bootstrapping the owned plist failed')
  const loadedNotStarted = daemon(['status'])
  const loadedNotStartedFields = statusFields(loadedNotStarted.stdout)
  assert(loadedNotStarted.status === 0 && loadedNotStartedFields.host === 'stopped'
    && loadedNotStartedFields['unit-state'] === 'not-running' && loadedNotStartedFields.manager === 'unmanaged',
  `L04-NEG2: a loaded not-running job must not be ready/launchd, saw ${String(loadedNotStarted.status)} ${JSON.stringify(loadedNotStartedFields)}`)
  const loadedLogs = daemon(['logs', '--lines', '20'])
  assert(loadedLogs.status === 4 && /LOG_SOURCE_UNAVAILABLE/u.test(loadedLogs.stderr),
    `L08-NEG: a loaded not-started job without launchd log output must be LOG_SOURCE_UNAVAILABLE/4, saw ${String(loadedLogs.status)}`)
  runLaunchctlCommand(['bootout', `gui/${String(uid)}/${label}`])
  // A manual bootstrap must not leave launchd-created log sinks behind that
  // would bypass the product's private 0600 pre-creation on the managed start.
  for (const staleLog of [join(scopeDirPath, 'launchd.stdout.log'), join(scopeDirPath, 'launchd.stderr.log')]) {
    if (existsSync(staleLog)) unlinkSync(staleLog)
  }
  report.rows.push({ id: 'L04-NEG2', status: 'PASS', unitState: loadedNotStartedFields['unit-state'], host: loadedNotStartedFields.host, manager: loadedNotStartedFields.manager, logs: 'LOG_SOURCE_UNAVAILABLE/4' })
  report.rows.push({ id: 'L08-NEG', status: 'PASS', exitCode: loadedLogs.status, code: 'LOG_SOURCE_UNAVAILABLE', loadedNotStartedJob: true })

  // ── L03 negative: a foreign loaded job is a hard start refusal ─────────
  const foreignBootstrap3 = runLaunchctlCommand(['bootstrap', `gui/${String(uid)}`, foreignPlist])
  assert(foreignBootstrap3.status === 0, 'L03-NEG: the foreign job bootstrap failed')
  const refusedStart = daemon(['start'])
  assert(refusedStart.status === 3 && /IDENTITY_OR_OWNERSHIP_REFUSED/u.test(refusedStart.stderr),
    `L03-NEG: start beside a foreign same-Label job must fail closed, saw ${String(refusedStart.status)}: ${refusedStart.stderr.slice(-700)}`)
  assert(readRegistry(dshHome) === undefined || !alive(readRegistry(dshHome).record.hostPid),
    'L03-NEG: a refused manager start must not detach-spawn a second Host')
  runLaunchctlCommand(['bootout', `gui/${String(uid)}/${label}`])
  report.rows.push({ id: 'L03-NEG', status: 'PASS', exitCode: refusedStart.status, detachedFallback: false })

  // ── L03: start through launchd, the SAME foreground Host entry ──────────
  const l03Start = daemonOk(['start'], 'L03 start')
  const startedHost = requireLiveHost('L03 started host')
  assert(l03Start.fields.host === 'ready' && l03Start.fields.manager === 'launchd'
    && l03Start.fields['unit-state'] === 'running' && l03Start.fields.unit === label
    && l03Start.fields['user-manager'] === 'available',
  `L03: unexpected launchd start status ${JSON.stringify(l03Start.fields)}`)
  const startedPrint = launchctlJobPrint(label)
  assert(startedPrint.status === 0, 'L03: the launchd job is not loaded after start')
  assert(startedPrint.stdout.includes(`path = ${realpathSync(plistPath)}`), 'L03: the loaded job source is not the exact plist')
  const launchdPid = parseLaunchctlJobPid(startedPrint.stdout)
  assert(launchdPid !== undefined, 'L03: launchctl print reported no real job PID')
  assert(l03Start.fields.pid === String(launchdPid), 'L03: status PID is not the launchd job PID')
  assert(startedHost.record.hostPid === launchdPid, 'L03: the authenticated Host is not the launchd job process')
  assert(startedHost.record.instanceId !== initialHost.record.instanceId, 'L03: the launchd start reused the stopped independent instance')
  const psRow = processTable().find(row => row.pid === launchdPid)
  assert(psRow !== undefined && (psRow.command.includes(entry) || psRow.command.includes(realpathSync(entry))),
    `L03: the launchd PID is not the installed foreground Host entry: ${String(psRow?.command)}`)
  assert(psRow.ppid === 1, `L03: the launchd Host must be re-parented to launchd (pid 1), saw ppid ${String(psRow.ppid)}`)
  const startedStatus = daemonOk(['status'], 'L03 status')
  assert(startedStatus.fields.pid === String(launchdPid) && startedStatus.fields.instance === startedHost.record.instanceId.slice(0, 8),
    'L03: status did not report the launchd Host identity')
  const stdoutLog = join(scopeDirPath, 'launchd.stdout.log')
  const stderrLog = join(scopeDirPath, 'launchd.stderr.log')
  await waitFor(() => (
    (existsSync(stdoutLog) && statSync(stdoutLog).size > 0)
      || (existsSync(stderrLog) && statSync(stderrLog).size > 0)
      ? true
      : undefined
  ), 'D4L launchd log output', TIMEOUTS.daemon)
  assert(stdoutLog !== stderrLog && existsSync(stderrLog), 'L03: the two launchd log sinks must be independent files')
  const stdoutStat = lstatSync(stdoutLog)
  const stderrStat = lstatSync(stderrLog)
  assert((stdoutStat.mode & 0o777) === 0o600 && (stderrStat.mode & 0o777) === 0o600,
    `L08: launchd log sinks must be private 0600, saw ${OCT(stdoutStat.mode)}/${OCT(stderrStat.mode)}`)
  const launchdLogs = daemonOk(['logs', '--lines', '200'], 'L08 logs')
  assert(/\[dsh-pi-tui daemon: launchd (stdout|stderr)\]/u.test(launchdLogs.result.stdout)
    && !/token=\S|connectUrl=\S/iu.test(launchdLogs.result.stdout),
  'L08: managed logs must identify the launchd source and stay sanitized')
  report.rows.push({ id: 'L03', status: 'PASS', label, launchdPid, hostPid: startedHost.record.hostPid,
    instanceId: startedHost.record.instanceId, foregroundEntry: true, ppid: psRow.ppid })
  report.rows.push({ id: 'L04', status: 'PASS', unit: label, unitState: startedStatus.fields['unit-state'],
    manager: startedStatus.fields.manager, launchdPid, authenticatedPid: startedHost.record.hostPid,
    negatives: ['L04-NEG1 foreign PID', 'L04-NEG2 loaded-not-started'] })
  report.rows.push({ id: 'L08', status: 'PASS', source: 'launchd.stdout.log/launchd.stderr.log', stdoutMode: OCT(stdoutStat.mode), stderrMode: OCT(stderrStat.mode), sanitized: true })

  // Second real Client reuses the launchd Host.
  const beforeSecondClient = requireLiveHost('L03 second client')
  const secondClient = start({ name: 'd4l-second-client', cwd: projectB, installation, backend: 'daemon' })
  await waitPainted(secondClient, 'D4L second Client paint')
  await waitComposer(secondClient, 'D4L second Client composer')
  const afterSecondClient = requireLiveHost('L03 second client reuse')
  assert(afterSecondClient.record.instanceId === beforeSecondClient.record.instanceId,
    'L03: a second Client created or replaced the Host')
  const warmStart = daemonOk(['start'], 'L03 warm start')
  assert(warmStart.fields.instance === beforeSecondClient.record.instanceId.slice(0, 8),
    'L03: a warm daemon start did not reuse the launchd Host')
  const warmPid = parseLaunchctlJobPid(launchctlJobPrint(label).stdout)
  assert(warmPid === launchdPid, 'L03: a warm start changed the launchd job PID')
  sendKeys(secondClient, '/exit', 'D4L second Client exit')
  await waitFor(() => (!tmuxSessionExists(secondClient) ? true : undefined), 'D4L second Client exit', TIMEOUTS.exit)
  const afterClientExit = requireLiveHost('L09 client exit')
  assert(afterClientExit.record.instanceId === beforeSecondClient.record.instanceId && alive(afterClientExit.record.hostPid),
    'L09-CLIENT: the launchd Host must survive its last Client exit')
  report.rows.push({ id: 'L09-CLIENT', status: 'PASS', instanceId: beforeSecondClient.record.instanceId, secondClient: true, warmStartReused: true, hostSurvivedClientExit: true })

  // ── L06: restart = verified bootout + bootstrap/kickstart + new instance ─
  const restart = daemonOk(['restart'], 'L06 restart')
  assert(/^previous=/mu.test(restart.result.stdout), 'L06: restart did not report the previous instance')
  const restartedHost = requireLiveHost('L06 restarted host')
  assert(restartedHost.record.instanceId !== beforeSecondClient.record.instanceId, 'L06: restart reused the old instance')
  assert(!alive(launchdPid), 'L06: the old launchd Host process is still alive')
  const restartedPrint = launchctlJobPrint(label)
  const restartedPid = parseLaunchctlJobPid(restartedPrint.stdout)
  assert(restartedPid !== undefined && restartedPid === restartedHost.record.hostPid && restartedPid !== launchdPid,
    'L06: the restart did not produce a new launchd job PID matching the new authenticated Host')
  assert(restartedHost.record.hostPid !== beforeSecondClient.record.hostPid, 'L06: the restarted Host kept the old PID')
  const liveHostsAfterRestart = ownedRoles(workRoot).hosts.filter(candidate => alive(candidate.pid))
  assert(liveHostsAfterRestart.length === 1, `L06: expected exactly ONE live Host after restart, saw ${String(liveHostsAfterRestart.length)}`)
  report.rows.push({ id: 'L06', status: 'PASS', previous: beforeSecondClient.record.instanceId, instanceId: restartedHost.record.instanceId,
    oldPidGone: true, newLaunchdPid: restartedPid, singleHost: true })

  // ── L05: stop through the verified launchd service only ─────────────────
  const stopLaunchd = daemonOk(['stop'], 'L05 stop')
  assert(/^host=stopped$/mu.test(stopLaunchd.result.stdout), 'L05: stop did not report a stopped Host')
  await waitFor(() => (!alive(restartedPid) ? true : undefined), 'D4L launchd Host exit', TIMEOUTS.process)
  assert(!alive(restartedHost.record.hostPid), 'L05: the launchd Host process is still alive after stop')
  assert(launchctlJobPrint(label).status === 113, 'L05: the verified job must be gone after stop')
  const registryAfterLaunchdStop = readRegistry(dshHome)
  assert(registryAfterLaunchdStop === undefined || registryAfterLaunchdStop.record.instanceId !== restartedHost.record.instanceId,
    'L05: the stopped Host registry still claims the old instance')
  report.rows.push({ id: 'L05', status: 'PASS', hostPid: restartedHost.record.hostPid, kernelIdentityGone: true, jobRemoved: true })

  // A stopped launchd job leaves two possible historical sources (retained
  // launchd streams and an earlier host.log) and no live authority proving the
  // most recent one. `logs` must fail closed instead of returning either file.
  const postStopLogs = daemon(['logs', '--lines', '20'])
  assert(postStopLogs.status === 4 && /LOG_SOURCE_UNAVAILABLE/u.test(postStopLogs.stderr)
    && !/retained launchd stdout|stale host\.log/u.test(postStopLogs.stdout),
  `L08-POSTSTOP: a stopped launchd job must not guess a log source, saw exit ${String(postStopLogs.status)}: ${postStopLogs.stderr.slice(-500)}`)
  report.rows.push({ id: 'L08-POSTSTOP', status: 'PASS', code: 'LOG_SOURCE_UNAVAILABLE', staleHostLogIgnored: true })

  // ── L09 (second profile install isolation, best-effort native) ──────────
  let secondProfileEvidence
  try {
    const secondDshHome = join(workRoot, 'd4l-second-dsh-home')
    mkdirSync(join(secondDshHome, 'profiles'), { recursive: true, mode: 0o700 })
    const secondProfileDir = join(secondDshHome, 'profiles', 'pi-tui')
    const clone = spawnSync('cp', ['-cR', profileDir, secondProfileDir], { encoding: 'utf8', timeout: TIMEOUTS.daemon })
    const copy = clone.status === 0 ? clone : spawnSync('cp', ['-R', profileDir, secondProfileDir], { encoding: 'utf8', timeout: TIMEOUTS.daemon })
    assert(copy.status === 0, `L09-PROFILE: the second profile copy failed: ${copy.stderr.slice(-500)}`)
    const secondLabel = launchdLabelOf(secondProfileDir)
    const secondPath = launchdPlistPathOf(secondProfileDir)
    assert(secondLabel !== label, 'L09-PROFILE: two canonical profiles must not share one launchd label')
    track(secondLabel, secondPath)
    report.d4lSeatDirs.push(join(homedir(), '.dsh-pi-tui', 'run', launchdScopeIdOf(secondProfileDir)))
    const firstPlistBefore = readFileSync(plistPath, 'utf8')
    const secondInstall = daemon(['install'], { DSH_HOME: secondDshHome })
    assert(secondInstall.status === 0,
      `L09-PROFILE: the second profile install exited ${String(secondInstall.status)}: ${secondInstall.stderr.slice(-700)}`)
    assert(existsSync(secondPath), 'L09-PROFILE: the second profile install wrote no plist')
    recordPlistIdentity(secondLabel, secondPath)
    assert(readFileSync(plistPath, 'utf8') === firstPlistBefore,
      'L09-PROFILE: the second profile install must not touch the first profile plist')
    const secondStatus = daemon(['status'], { DSH_HOME: secondDshHome })
    const secondFields = statusFields(secondStatus.stdout)
    assert(secondStatus.status === 0 && secondFields.unit === secondLabel && secondFields.host === 'stopped',
      `L09-PROFILE: unexpected second profile status ${String(secondStatus.status)} ${JSON.stringify(secondFields)}`)
    const secondUninstall = daemon(['uninstall'], { DSH_HOME: secondDshHome })
    assert(secondUninstall.status === 0 && !existsSync(secondPath), 'L09-PROFILE: the second profile uninstall did not remove its own plist')
    assert(readFileSync(plistPath, 'utf8') === firstPlistBefore,
      'L09-PROFILE: the second profile uninstall touched the first profile plist')
    secondProfileEvidence = { secondLabel, isolated: true, unit: secondFields.unit }
    report.rows.push({ id: 'L09-PROFILE', status: 'PASS', firstLabel: label, secondLabel, isolatedInstall: true, isolatedUninstall: true })
  } catch (error) {
    secondProfileEvidence = { error: error instanceof Error ? error.message : String(error) }
    report.rows.push({ id: 'L09-PROFILE', status: 'NOT_VERIFIED', reason: error instanceof Error ? error.message : String(error), secondProfileAttempted: true })
  }

  // ── L07: uninstall removes a LOADED job + plist and keeps the logs ───────
  // Start the launchd Host again after the second-profile block so the
  // production uninstall path really boots out a loaded, authenticated job.
  const l07Start = daemonOk(['start'], 'L07 uninstall start')
  assert(l07Start.fields.manager === 'launchd' && l07Start.fields.host === 'ready',
    `L07: the pre-uninstall start did not produce a launchd Host: ${JSON.stringify(l07Start.fields)}`)
  const l07Host = requireLiveHost('L07 uninstall host')
  const l07Print = launchctlJobPrint(label)
  const l07Pid = parseLaunchctlJobPid(l07Print.stdout)
  assert(l07Print.status === 0 && l07Pid !== undefined && l07Pid === l07Host.record.hostPid,
    'L07: the job must be loaded and running the authenticated Host before uninstall')
  const l07 = daemonOk(['uninstall'], 'L07 launchd uninstall')
  assert(!existsSync(plistPath), 'L07: uninstall did not remove the owned plist')
  assert(launchctlJobPrint(label).status === 113, 'L07: uninstall left the verified job loaded')
  assert(!alive(l07Host.record.hostPid), 'L07: uninstall did not stop the loaded launchd Host')
  assert(existsSync(stdoutLog) && existsSync(stderrLog), 'L07: uninstall must retain the private launchd logs')
  const l07Again = daemonOk(['uninstall'], 'L07 idempotent')
  assert(/^unit=none$/mu.test(l07Again.result.stdout), 'L07: a repeat uninstall must be an idempotent no-plist success')
  report.rows.push({ id: 'L07', status: 'PASS', plistRemoved: true, jobRemoved: true, loadedJobStopped: true, hostPidGone: true, logsRetained: true, idempotent: true })

  // After uninstall the plist is gone but the retained launchd streams still
  // exist beside an older independent host.log; the source is unprovable.
  const postUninstallLogs = daemon(['logs', '--lines', '20'])
  assert(postUninstallLogs.status === 4 && /LOG_SOURCE_UNAVAILABLE/u.test(postUninstallLogs.stderr)
    && !/retained launchd stdout|stale host\.log/u.test(postUninstallLogs.stdout),
  `L08-UNINSTALL: a removed plist with retained streams must not guess a log source, saw exit ${String(postUninstallLogs.status)}: ${postUninstallLogs.stderr.slice(-500)}`)
  report.rows.push({ id: 'L08-UNINSTALL', status: 'PASS', code: 'LOG_SOURCE_UNAVAILABLE', staleHostLogIgnored: true })

  // ── L12: the independent daemon is still the default afterward ──────────
  const legacyStart = daemonOk(['start'], 'L12 legacy start')
  assert(legacyStart.fields.manager === 'process' && legacyStart.fields.unit === 'none' && legacyStart.fields.host === 'ready',
    `L12: post-uninstall start did not use the independent daemon: ${JSON.stringify(legacyStart.fields)}`)
  const legacyHost = requireLiveHost('L12 legacy host')
  const legacyPrint = launchctlJobPrint(label)
  assert(legacyPrint.status === 113, 'L12: the independent daemon must not create a launchd job')
  const legacyStop = daemonOk(['stop'], 'L12 legacy stop')
  assert(/^host=stopped$/mu.test(legacyStop.result.stdout), 'L12: the independent daemon did not stop')
  report.rows.push({ id: 'L12', status: 'PASS', manager: legacyStart.fields.manager, unit: legacyStart.fields.unit, hostPid: legacyHost.record.hostPid,
    directDefault: 'A01/A02/P01-P09 on the same packed candidate', legacyDaemon: 'detached start/stop after uninstall' })

  report.rows.push({ id: 'L10', status: 'PASS', plutil: 'PASS', launchd: ['print', 'bootstrap', 'kickstart', 'bootout'],
    negative: ['foreign-job', 'pid-mismatch', 'loaded-not-started', 'symlink', 'other-build', 'user-edit'],
    cleanup: 'the lane cleanup boots out only this profile label and removes only its own plist' })
  report.rows.push({ id: 'L11', status: 'NOT_VERIFIED', lane: 'linux',
    note: 'Linux systemd no-unit/installed-unit/manager-error and the selected M11 L6 cases cannot execute on this macOS lane; the Linux CI/Product lanes and the selected split-process smoke remain the authority for L11.' })
  report.d4lSecondProfile = secondProfileEvidence
  return { label, secondProfileEvidence }
}

// ── cleanup ────────────────────────────────────────────────────────────────

async function cleanup({ workRoot, report }) {
  const errors = []
  // 1. The private tmux server (only this run's sessions).
  if (TMUX_SOCKET !== '') {
    const kill = tmux(['kill-server'], 'cleanup tmux server', { allowMissing: true })
    if (kill.status !== 0 && !/no server running|no sessions|error connecting/u.test(`${kill.stderr ?? ''}`)) {
      errors.push(`tmux kill-server exited ${String(kill.status)}`)
    }
  }
  // 1b. Remove ONLY this run's profile-scoped LaunchAgent labels and plists.
  //     A path/label string is not ownership: cleanup re-proves the recorded
  //     file (dev,ino,content), the loaded job's canonical source and the final
  //     identity before unlink. Anything unproven is reported and preserved.
  if (Array.isArray(report.d4lLabels)) {
    const launchAgentsRoot = join(homedir(), 'Library', 'LaunchAgents')
    let removed = 0
    let preserved = 0
    const readIdentity = path => {
      try {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('the tracked plist is not a regular file')
        return { dev: String(info.dev), ino: String(info.ino), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
      } catch (error) {
        // A genuinely absent path is already clean; a symlink/directory/
        // unreadable replacement is NOT: preserve it and report, never unlink.
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
    }
    const cleanupIo = {
      print: async label => launchctlJobPrint(label),
      bootout: async label => runLaunchctlCommand(['bootout', `gui/${String(process.getuid())}/${label}`]),
      readIdentity: async path => readIdentity(path),
      realpath: async path => realpathSync(path),
      unlink: async path => unlinkSync(path),
      sleep,
      maxWaitAttempts: 50,
      pollMs: 100,
    }
    for (const tracked of report.d4lLabels) {
      if (typeof tracked?.label !== 'string' || typeof tracked?.plistPath !== 'string') {
        errors.push('D4L cleanup: malformed tracked launchd label')
        preserved += 1
        continue
      }
      if (dirname(tracked.plistPath) !== launchAgentsRoot
        || basename(tracked.plistPath) !== `${tracked.label}.plist`
        || !tracked.label.startsWith(`${LAUNCHD_LABEL_PREFIX}.`)) {
        errors.push(`D4L cleanup: refusing an unexpected launchd target ${tracked.plistPath}`)
        preserved += 1
        continue
      }
      try {
        const result = await cleanupTrackedLaunchdResource(tracked, cleanupIo)
        if (result.action === 'removed') removed += 1
        else if (result.action === 'absent') { /* the scene already removed it */ }
        else {
          errors.push(`D4L cleanup: ${tracked.label}: ${result.reason}; preserving`)
          preserved += 1
        }
      } catch (error) {
        errors.push(`D4L cleanup: ${tracked.label}: ${error instanceof Error ? error.message : String(error)}; preserving`)
        preserved += 1
      }
    }
    report.d4lCleanup = { labels: report.d4lLabels.length, launchAgentsRoot, removed, preserved }
    if (preserved > 0 || errors.some(message => message.startsWith('D4L cleanup:'))) {
      report.notQuiesced = { ...(report.notQuiesced ?? {}), launchd: report.d4lCleanup, workRoot }
      errors.push('NOT_QUIESCED: preserved launchd resource(s) still depend on this work root')
    }
  }
  const launchdCleanupFailed = (report.d4lCleanup?.preserved ?? 0) > 0
    || errors.some(message => message.startsWith('D4L cleanup:'))
  // 2. Only processes whose CURRENT process table row still names THIS work
  //    root and an owned role. A saved bare pid is never an identity: every
  //    signal re-reads the table and refuses a recycled or foreign pid.
  const ownedTargets = () => ownedProcessRows(workRoot).filter(row => roleOf(row) !== undefined)
  const signalIfStillOwned = (target, signal) => {
    const row = processTable().find(candidate => candidate.pid === target.pid)
    if (row === undefined || roleOf(row) === undefined || !row.command.includes(workRoot)) return
    try { process.kill(target.pid, signal) } catch { /* already gone */ }
  }
  for (const target of ownedTargets()) signalIfStillOwned(target, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (ownedTargets().length === 0) break
    await sleep(120)
  }
  for (const target of ownedTargets()) signalIfStillOwned(target, 'SIGKILL')
  await sleep(250)
  const survivors = ownedTargets()
  if (survivors.length > 0) {
    report.notQuiesced = { ...(report.notQuiesced ?? {}), survivors: survivors.map(target => target.pid), workRoot }
    errors.push(`NOT_QUIESCED: ${String(survivors.length)} owned process(es) survived cleanup`)
    return errors
  }
  // The D2ACP scene records exactly the deterministic Darwin endpoint root(s)
  // this run created; after every owned process is gone they are this run's
  // private directory to remove and nothing else under the shared parent.
  if (Array.isArray(report.d2acpEndpointRoots)) {
    const roots = report.d2acpEndpointRoots
    let removed = 0
    for (const root of roots) {
      if (dirname(root) !== DARWIN_ACP_PARENT || !basename(root).startsWith(`dpt-${String(process.getuid())}-`)) {
        errors.push(`refusing to remove an unexpected D2ACP endpoint root: ${root}`)
        continue
      }
      try {
        rmSync(root, { recursive: true, force: true })
        removed += 1
      } catch (error) {
        errors.push(`D2ACP endpoint root removal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    report.d2acpEndpointCleanup = { roots: roots.length, removed }
    delete report.d2acpEndpointRoots
  }
  // The Host seat under the real account home is the smoke's own scope; after
  // every owned process is gone it is safe to remove this run's directory.
  if (!launchdCleanupFailed && typeof report.globalSeatDir === 'string') {
    const seatDir = report.globalSeatDir
    if (dirname(seatDir) !== join(homedir(), '.dsh-pi-tui', 'run')) {
      errors.push(`refusing to remove an unexpected global seat directory: ${seatDir}`)
    } else {
      try { rmSync(seatDir, { recursive: true, force: true }) } catch (error) {
        errors.push(`global seat directory removal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  // 2b. Remove ONLY the profile-scoped account-home seat directories this D4L
  //     run created; each entry must be a direct child of the account run root.
  if (!launchdCleanupFailed && Array.isArray(report.d4lSeatDirs)) {
    const accountSeatRoot = join(homedir(), '.dsh-pi-tui', 'run')
    for (const seatDir of report.d4lSeatDirs) {
      if (typeof seatDir !== 'string' || dirname(seatDir) !== accountSeatRoot) {
        errors.push(`D4L cleanup: refusing an unexpected seat directory ${String(seatDir)}`)
        continue
      }
      if (existsSync(seatDir)) {
        try { rmSync(seatDir, { recursive: true, force: true }) } catch (error) {
          errors.push(`D4L cleanup: seat directory removal failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  // 3. Remove the private work root only after every owned process is gone.
  if (!KEEP && !launchdCleanupFailed) {
    try { rmSync(workRoot, { recursive: true, force: true }) } catch (error) {
      errors.push(`work root removal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    report.keptWorkRoot = workRoot
  }
  return errors
}

// ── main ───────────────────────────────────────────────────────────────────

/**
 * The selector dispatch: `--list`, `--case <id>` or `--suite <name>` delegate
 * to the ONE shared split-process selected runner in THIS process — the same
 * registry, the same parser and the same business case functions Linux runs.
 * A Mac selector never triggers the legacy A/P/M/L scene, and a candidate with
 * no selector keeps the original complete scene below. Importing the lane
 * module performs no I/O and starts no process.
 */
async function runSelectorLane(argv) {
  const [{ parseSelectionArgs, resolveSelection }, lane] = await Promise.all([
    import('../lib/split-smoke-selection.mjs'),
    import('../split-process-smoke.mjs'),
  ])
  let selection
  try {
    selection = resolveSelection(parseSelectionArgs(argv))
  } catch (error) {
    emitInputFailure({
      lane: 'macos-split',
      heading: 'MACOS_SPLIT',
      error,
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw error
  }
  if (selection.mode === 'list') {
    lane.printSelectableCases()
    return
  }
  // The shared runner's selected entry drives THIS Mac CLI's own Darwin PTY
  // driver through the platform seam; no second registry, no second runner.
  await lane.runSelectedCases(selection)
}

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
    await runScene({ installation, workRoot, report })
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'
    report.error = error instanceof Error ? error.message : String(error)
    failures.push(report.error)
  } finally {
    if (installation !== undefined) {
      const cleanupErrors = await cleanup({ workRoot, report })
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
  const rawArgs = process.argv.slice(2)
  // A selector dispatch must be detected on the RAW argv before any candidate
  // resolution: `--list` never names a tarball and a selector never falls back
  // to the legacy scene. `--` is the pnpm separator and may lead.
  const selectorArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const hasSelector = selectorArgs.includes('--list')
    || selectorArgs.includes('--case')
    || selectorArgs.includes('--suite')
  // A Mac CLI invocation that names ANY dash option this lane does not own is
  // an unqualified input, refused before any candidate inspection: it can
  // never silently fall back into the legacy A/P/M/L scene (the `--q2` shape
  // the retired plan tried to introduce is exactly such an input).
  if (!hasSelector && selectorArgs.some(argument => argument.startsWith('-') && argument !== '--')) {
    const unknown = selectorArgs.find(argument => argument.startsWith('-') && argument !== '--')
    const refusal = new SplitSmokeInputError(
      'INPUT_SMOKE_SELECTION_INVALID',
      `INPUT_UNQUALIFIED: INPUT_SMOKE_SELECTION_INVALID (invalid smoke selection, not a product regression): `
        + `unknown option ${JSON.stringify(String(unknown))}; the macOS CLI accepts only <candidate.tgz>, --list, --case <id> or --suite <name>`,
    )
    emitInputFailure({
      lane: 'macos-split',
      heading: 'MACOS_SPLIT',
      error: refusal,
      evidencePath: process.env.SPLIT_PROCESS_FAILURE_EVIDENCE,
    })
    throw refusal
  }
  if (hasSelector) {
    await runSelectorLane(selectorArgs)
  } else {
    const explicit = rawArgs[0] === '--' ? rawArgs[1] : rawArgs[0]
    await main(explicit)
  }
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  process.stderr.write(`MACOS_SPLIT_PARITY: FAIL: ${message}\n`)
  process.exitCode = 1
}
