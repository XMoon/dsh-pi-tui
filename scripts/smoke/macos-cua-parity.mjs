#!/usr/bin/env node
/**
 * macOS official CUA native qualification lane (MAC-09 / macOS PR-5).
 *
 * This lane is an OPT-IN, operator-assisted native qualification. It installs
 * the packaged candidate into ONE isolated `pi-tui` profile (the shared
 * `createSplitSmokeProfile` owner), starts the REAL public TUI in a private
 * macOS `tmux` server, and drives the official CUA path with a real,
 * image-capable model route:
 *
 *   MAC09-01 the real Plugin Manager hides the official Computer use bundle
 *            from the default list until an explicit search reaches it.
 *   MAC09-02 the official bundle selection + PTC session makes the Host `cua`
 *            tool reachable, and a standard session receives no CUA dispatch.
 *   MAC09-03 macOS Accessibility and Screen Recording belong to the official
 *            `DSH Computer Use.app`; the native result reports them.
 *   MAC09-04 the official application-consent Question reaches the current
 *            PiTui Question seat for the exact pending `cua` dispatch.
 *   MAC09-05 exactly one official answer resumes the same pending dispatch.
 *   MAC09-06 a denied application consent fails closed: no observation or
 *            input follows.
 *   MAC09-07 the official Host Attachment Store receives the screenshot and
 *            the current Client paints its image identity row.
 *   MAC09-08 one bounded, non-destructive TextEdit input changes the real
 *            window and the same `cua` call reports the change.
 *   MAC09-09 another Session asks its own consent; Session A's decision is not
 *            copied to it.
 *   MAC09-10 after the Split Client exits mid-Question, a new Client on the
 *            same Host/Session paints no stale Question and no late answer
 *            settles the old dispatch.
 *   MAC09-11 disabling the bundle withdraws the tool and preserves the OS TCC
 *            entry and the durable consent storage.
 *   MAC09-12 cleanup reclaims only this run's processes and reaches
 *            QUIESCED.
 *
 * Every wait is a bounded condition wait on a real fact (a durable Session
 * event, a pending official `cua` dispatch, a painted TUI frame, a real
 * process or a real macOS code signature). The operator performs only the two
 * actions that must not be automated: granting the macOS TCC permissions and
 * answering the official application-consent Question in the real TUI.
 *
 * The lane deliberately does NOT implement a CUA permission page, a client
 * capture path, a second Host authority or a fake native provider. Its only
 * claims come from the official rc.3 packages, the real `DSH Computer Use.app`
 * and durable Session/Attachment facts. Unrun cases are reported
 * `NOT_VERIFIED`; a missing prerequisite stops the lane before it starts a
 * Host.
 *
 * Usage:
 *   node scripts/smoke/macos-cua-parity.mjs --help
 *   node scripts/smoke/macos-cua-parity.mjs <candidate.tgz>
 *   pnpm smoke:macos-cua -- <candidate.tgz>
 *
 * Operator environment (required for a real native run):
 *   MACOS_CUA_PROFILE_PATCH   absolute path to the operator's YAML user-layer
 *                             patch that declares an image-capable model route
 *                             (for example an `llm-pi-ai` provider entry) and
 *                             the agent default model. Copied 0600 into the
 *                             disposable profile and never printed.
 *   MACOS_CUA_CREDENTIALS     absolute path to the matching credentials YAML.
 *                             Copied 0600 into the disposable DSH_HOME.
 * Optional:
 *   MACOS_CUA_EVIDENCE_DIR    private directory for the 0600 JSON report.
 *   MACOS_CUA_KEEP=1          preserve the disposable work root for forensics.
 *   MACOS_CUA_OPERATOR_TIMEOUT_MS  operator-gate deadline (default 20 minutes).
 *
 * The lane is never selected by `pnpm test`, `pack:release`, the Split smoke or
 * a Linux CI lane.
 *
 * @module smoke/macos-cua-parity
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import { parse as parseYaml } from 'yaml'

import { createSplitSmokeProfile, inspectSplitCandidate } from '../lib/split-smoke-profile.mjs'
import { SplitSmokeAssertionError, SplitSmokeWaitError, writePrivateReport } from '../lib/split-smoke-diagnostics.mjs'
import { hostSessionEvents, sha16 } from '../lib/split-smoke-sessions.mjs'

const LANE = 'macos-cua-parity'
const HEADING = 'MACOS_CUA'
const KEEP = process.env.MACOS_CUA_KEEP === '1'
const TMUX_SOCKET = `dsh-macos-cua-${randomUUID().slice(0, 8)}`
const ACCOUNT_RUN_ROOT = join(homedir(), '.dsh-pi-tui', 'run')
const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'
const CUA_MACOS_PACKAGE = '@deepseek-ai/dsh-experimental-cua-macos'
const CUA_PRESET = 'ptc'
const TEXTEDIT_BUNDLE = 'com.apple.TextEdit'

/** Bounded waits: every one names the real fact it observes. */
const TIMEOUTS = {
  mount: 120_000,
  paint: 120_000,
  process: 60_000,
  turn: 8 * 60_000,
  consent: 15 * 60_000,
  screenshot: 4 * 60_000,
  exit: 45_000,
  daemon: 180_000,
  dump: 120_000,
}

const OPERATOR_GATE_TIMEOUT_MS = Number(process.env.MACOS_CUA_OPERATOR_TIMEOUT_MS ?? 20 * 60_000)

/** The frozen MAC-09 case list, in report order. */
const REQUIRED_CASES = Object.freeze([
  'MAC09-01',
  'MAC09-02',
  'MAC09-03',
  'MAC09-04',
  'MAC09-05',
  'MAC09-06',
  'MAC09-07',
  'MAC09-08',
  'MAC09-09',
  'MAC09-10',
  'MAC09-11',
  'MAC09-12',
])

/** A missing prerequisite: the lane stops without claiming a product defect. */
class CuaNotVerifiedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CuaNotVerifiedError'
  }
}

/** A rejected lane input: no work root, Host, helper or TCC action may start. */
class CuaInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CuaInputError'
  }
}

/** An expected operator action did not arrive within its deadline. */
class CuaOperatorTimeoutError extends CuaNotVerifiedError {
  constructor(message) {
    super(message)
    this.name = 'CuaOperatorTimeoutError'
  }
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** Bound a real condition wait; a timeout is a classified lane wait error. */
async function waitFor(probe, label, timeoutMs) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await sleep(120)
  }
  throw new SplitSmokeWaitError('WAIT_TIMEOUT', { waitLabel: label, elapsedMs: Date.now() - started })
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A bounded, non-secret error text for stderr and the private report. */
function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 4000)
}

// ── input / preflight ──────────────────────────────────────────────────────

const HELP_TEXT = [
  'usage: node scripts/smoke/macos-cua-parity.mjs [--help] <candidate.tgz>',
  '',
  'Real macOS CUA/PTC/TCC/Question/Attachment qualification for ONE packaged',
  'candidate. The candidate tarball is required and is never taken from the',
  'published registry.',
  '',
  'Required operator environment:',
  '  MACOS_CUA_PROFILE_PATCH  YAML user-layer patch with a real image-capable',
  '                           model route and the agent default model.',
  '  MACOS_CUA_CREDENTIALS    matching credentials YAML for that route.',
  '',
  'Optional:',
  '  MACOS_CUA_EVIDENCE_DIR   directory for the 0600 JSON report.',
  '  MACOS_CUA_KEEP=1         preserve the disposable work root.',
  '  MACOS_CUA_OPERATOR_TIMEOUT_MS  operator-gate deadline in milliseconds.',
  '',
  'The lane only runs when explicitly selected. It never runs on Linux, never',
  'in `pnpm test`, `pack:release` or the Split smoke.',
].join('\n')

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.some(argument => argument === '--help' || argument === '-h')) {
    throw new CuaInputError('--help must be used alone without a candidate')
  }
  for (const argument of argv) {
    if (argument.startsWith('-') && argument !== '--') {
      throw new CuaInputError(`unknown option ${JSON.stringify(argument)}; exactly one candidate tarball is accepted`)
    }
  }
  const positional = argv.filter(argument => argument !== '--')
  if (positional.length !== 1) {
    throw new CuaInputError(`exactly one candidate tarball is required, got ${String(positional.length)} positional argument(s)`)
  }
  return { help: false, candidate: positional[0] }
}

function requireOperatorFile(envName, description) {
  const value = process.env[envName]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CuaNotVerifiedError(`${envName} is required: ${description}`)
  }
  const absolute = resolve(value)
  if (!existsSync(absolute)) throw new CuaNotVerifiedError(`${envName} does not name an existing file: ${absolute}`)
  const info = lstatSync(absolute)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CuaNotVerifiedError(`${envName} must name a regular file: ${absolute}`)
  }
  return absolute
}

function preflightEnvironment() {
  if (process.platform !== 'darwin') {
    throw new CuaNotVerifiedError(`this lane requires a real macOS host; this process runs on ${process.platform}`)
  }
  if (process.getuid?.() === 0) {
    throw new CuaNotVerifiedError('this lane must run as the real logged-in macOS user, not root')
  }
  const account = spawnSync('id', ['-un'], { encoding: 'utf8', timeout: 10_000 })
  if (account.status !== 0 || account.stdout.trim() === '' || account.stdout.trim() === 'root') {
    throw new CuaNotVerifiedError('the current macOS account could not be identified')
  }
  const manager = spawnSync('launchctl', ['managername'], { encoding: 'utf8', timeout: 10_000 })
  const managerName = manager.status === 0 ? manager.stdout.trim() : ''
  // The lane runs inside a private tmux server, whose launchd manager is
  // `Background` even when the owning console user is in `Aqua`; the native
  // helper's own LaunchServices launch and TCC are proven later by the real
  // capability/screenshot results, never by this label. What the lane DOES
  // require is a real console login for the current account.
  if (managerName !== 'Aqua' && managerName !== 'Background') {
    throw new CuaNotVerifiedError(`a real logged-in macOS user session is required, launchctl managername reported ${JSON.stringify(managerName)}`)
  }
  const who = spawnSync('who', [], { encoding: 'utf8', timeout: 10_000 })
  const consoleLine = who.status === 0
    && who.stdout.split('\n').some(line => {
      const columns = line.trim().split(/\s+/u)
      return columns[0] === account.stdout.trim() && columns[1] === 'console'
    })
  if (!consoleLine) {
    throw new CuaNotVerifiedError(`no console login exists for ${account.stdout.trim()}; the native qualification needs the real logged-in desktop session`)
  }
  const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 10_000 })
  if (tmux.status !== 0) throw new CuaNotVerifiedError('tmux is required for the private terminal scene')
  if (!existsSync('/System/Applications/TextEdit.app')) {
    throw new CuaNotVerifiedError('the controlled test application /System/Applications/TextEdit.app is missing')
  }
  return { account: account.stdout.trim(), tmux: tmux.stdout.trim(), guiSession: managerName }
}

// ── private tmux ───────────────────────────────────────────────────────────

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
  return tmux(['has-session', '-t', session], `has-session ${session}`, { allowMissing: true }).status === 0
}

function sendKeys(session, data, label) {
  tmux(['send-keys', '-t', session, '-l', data], `${label} literal`)
  tmux(['send-keys', '-t', session, 'Enter'], `${label} enter`)
}

function sendNamedKey(session, key, label) {
  tmux(['send-keys', '-t', session, key], `${label} ${key}`)
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

function attachCommand(session) {
  return `tmux -L ${TMUX_SOCKET} attach -t ${session}`
}

async function waitPainted(session, label) {
  let lastFrame = ''
  try {
    return await waitFor(() => {
      if (!tmuxSessionExists(session)) {
        throw new SplitSmokeAssertionError(`${label}: the tmux session exited before painting`)
      }
      lastFrame = tmuxCapture(session, `${label} capture`)
      const dead = tmux(['display-message', '-p', '-t', session, '#{pane_dead}'], `${label} pane state`, { allowMissing: true })
      if (dead.status === 0 && dead.stdout.trim() === '1') {
        throw new SplitSmokeAssertionError(`${label}: the pane exited before painting`)
      }
      return /[╭╮╰╯│─]/u.test(lastFrame) ? lastFrame : undefined
    }, label, TIMEOUTS.paint)
  } catch (error) {
    if (error instanceof SplitSmokeAssertionError) {
      throw new SplitSmokeAssertionError(`${error.message}; frame sha256=${sha16(lastFrame)}`)
    }
    throw error
  }
}

async function waitFrameText(session, needle, label, timeoutMs = TIMEOUTS.mount) {
  let lastFrame = ''
  try {
    return await waitFor(() => {
      if (!tmuxSessionExists(session)) {
        throw new SplitSmokeAssertionError(`${label}: the tmux session exited while waiting for ${JSON.stringify(needle)}`)
      }
      lastFrame = tmuxCapture(session, `${label} capture`)
      return lastFrame.includes(needle) ? lastFrame : undefined
    }, label, timeoutMs)
  } catch (error) {
    if (error instanceof SplitSmokeAssertionError) {
      throw new SplitSmokeAssertionError(`${error.message}; frame sha256=${sha16(lastFrame)}`)
    }
    throw error
  }
}

async function waitComposer(session, label) {
  // The welcome card's `type a message` placeholder exists only before the
  // first Session; an established Session still paints the composer prompt
  // `❯` at the start of a row. Both are real painted composer facts.
  return await waitFrameMatching(session,
    frame => frame.includes('type a message') || /^❯/mu.test(frame),
    `${label} composer ready`, TIMEOUTS.mount)
}

/** Wait for a bounded conjunction of painted facts, not one racing capture. */
async function waitFrameMatching(session, predicate, label, timeoutMs = TIMEOUTS.mount) {
  let lastFrame = ''
  try {
    return await waitFor(() => {
      if (!tmuxSessionExists(session)) {
        throw new SplitSmokeAssertionError(`${label}: the tmux session exited while waiting for the painted facts`)
      }
      lastFrame = tmuxCapture(session, `${label} capture`)
      return predicate(lastFrame) ? lastFrame : undefined
    }, label, timeoutMs)
  } catch (error) {
    if (error instanceof SplitSmokeAssertionError) {
      throw new SplitSmokeAssertionError(`${error.message}; frame sha256=${sha16(lastFrame)}`)
    }
    throw error
  }
}

async function waitSessionExit(session, label) {
  await waitFor(() => (!tmuxSessionExists(session) ? true : undefined), label, TIMEOUTS.exit)
}

// ── process table / ownership ──────────────────────────────────────────────

function processTable() {
  // `lstart` is the kernel-visible process start time. Unlike a bare pid or a
  // command string it changes when the pid is reused, so it is the lane's
  // terminal-signal identity.
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
    encoding: 'utf8', timeout: 15_000, env: { ...process.env, LC_ALL: 'C' },
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new SplitSmokeAssertionError(`process table: ps failed: ${result.error?.message ?? result.stderr ?? ''}`)
  }
  const rows = []
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3].replace(/\s+/gu, ' '), command: match[4] })
  }
  return rows
}

function processStarted(pid) {
  return processTable().find(row => row.pid === pid)?.started
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function ownedProcessRows(workRoot) {
  return processTable().filter(row => row.command.includes(workRoot))
}

function roleOf(row) {
  if (row.command.includes('local-host.mjs')) return 'host'
  if (row.command.includes('local-client.mjs')) return 'client'
  if (row.command.includes(['dsh', 'lib', 'bin.js'].join('/'))) return 'supervisor'
  if (row.command.includes('DSH Computer Use.app')) return 'helper'
  return undefined
}

function ownedRoles(workRoot) {
  const rows = ownedProcessRows(workRoot)
  return {
    rows,
    hosts: rows.filter(row => roleOf(row) === 'host'),
    clients: rows.filter(row => roleOf(row) === 'client'),
    helpers: rows.filter(row => roleOf(row) === 'helper'),
  }
}

async function waitOwnedRoleGone(workRoot, pid, started, label) {
  await waitFor(() => (!alive(pid) ? true : undefined), `${label} pid ${String(pid)} is gone`, TIMEOUTS.process)
  const stillOwned = ownedProcessRows(workRoot).find(row => row.pid === pid && row.started === started)
  assert(stillOwned === undefined, `${label}: pid ${String(pid)} still belongs to this work root`)
}

// ── durable Session readers ────────────────────────────────────────────────

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

function eventsOf(dshHome, sessionId) {
  try {
    return hostSessionEvents(dshHome, sessionId) ?? []
  } catch {
    // A torn append tail is not durable yet; the bounded wait retries.
    return []
  }
}

/** Wait for one durable user message carrying the exact prompt token. */
async function waitSessionPrompt(dshHome, token, label, timeoutMs = TIMEOUTS.turn) {
  return await waitFor(() => {
    for (const session of sessionDirs(dshHome)) {
      const events = eventsOf(dshHome, session.sessionId)
      const index = events.findIndex(event => event.type === 'user/message'
        && JSON.stringify(event).includes(token))
      if (index >= 0) return { sessionId: session.sessionId, events, index }
    }
    return undefined
  }, label, timeoutMs)
}

function cuaDispatches(events, afterIndex) {
  return events.slice(afterIndex)
    .filter(event => event.type === 'tool/ptc-dispatch-start' && event.data?.name === 'cua')
    .map(event => event.data)
}

function cuaResults(events, afterIndex) {
  return events.slice(afterIndex)
    .filter(event => event.type === 'tool/ptc-dispatch' && event.data?.name === 'cua')
    .map(event => event.data)
}

/** Wait for the exact settled result of one PTC sub-call. */
async function waitCuaResult(dshHome, sessionId, subCallId, label, timeoutMs = TIMEOUTS.consent) {
  return await waitFor(() => {
    const events = eventsOf(dshHome, sessionId)
    const result = cuaResults(events, 0).find(item => item.subCallId === subCallId)
    return result === undefined ? undefined : { result, events }
  }, label, timeoutMs)
}

async function waitTurnEnd(dshHome, sessionId, afterIndex, label, timeoutMs = TIMEOUTS.turn) {
  return await waitFor(() => {
    const events = eventsOf(dshHome, sessionId)
    const index = events.findIndex((event, position) => position >= afterIndex && event.type === 'turn/end')
    return index < 0 ? undefined : { index, events }
  }, label, timeoutMs)
}

function sessionIdFromFrame(frame) {
  const match = /session\s+(session-[0-9a-f-]{8,})/u.exec(frame)
  return match?.[1]
}

// ── operator console ───────────────────────────────────────────────────────

function createOperatorConsole() {
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
  const iterator = readline[Symbol.asyncIterator]()
  let closed = false
  return {
    close() {
      closed = true
      readline.close()
    },
    async gate(stage, instructions, expected, timeoutMs = OPERATOR_GATE_TIMEOUT_MS) {
      if (closed) throw new CuaOperatorTimeoutError('the operator console is closed')
      // A stage-specific token, not a bare "continue": a line typed before this
      // prompt cannot satisfy a later gate and silently advance the scene.
      process.stderr.write(`\n[MACOS_CUA operator] ${stage}\n${instructions}\n[MACOS_CUA operator] type "${expected}" + Enter in this terminal when done.\n`)
      let timer
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new CuaOperatorTimeoutError(`operator action "${stage}" did not arrive within ${String(timeoutMs)}ms`))
        }, timeoutMs)
      })
      let next
      try {
        next = await Promise.race([iterator.next(), deadline])
      } finally {
        clearTimeout(timer)
      }
      if (next.done === true) {
        closed = true
        throw new CuaOperatorTimeoutError(`the operator console closed during "${stage}"`)
      }
      if (next.value.trim() !== expected) {
        throw new CuaOperatorTimeoutError(`operator action "${stage}" was not confirmed with "${expected}"`)
      }
    },
  }
}

async function operatorGate(operator, tui, stage, token, lines, timeoutMs) {
  return await operator.gate(stage, [`TUI attach command: ${attachCommand(tui)}`, '', ...lines].join('\n'), token, timeoutMs)
}

function logOperator(lines) {
  process.stderr.write(`\n[MACOS_CUA operator] ${lines.join('\n[MACOS_CUA operator] ')}\n`)
}

// ── isolated installation / official distribution ──────────────────────────

function resolvePackageJson(fromPackageJson, name) {
  try {
    return createRequire(fromPackageJson).resolve(`${name}/package.json`)
  } catch {
    return undefined
  }
}

function helperFromPackage(packageJsonPath, arch) {
  const packageDir = dirname(packageJsonPath)
  const receipt = JSON.parse(readFileSync(join(packageDir, 'cua-helper.json'), 'utf8'))
  const current = JSON.parse(readFileSync(join(packageDir, 'native', 'bin', `darwin-${arch}`, 'current.json'), 'utf8'))
  const expected = receipt.applications?.find(application => application.architecture === arch)
  return {
    packageDir,
    receipt,
    current,
    expected,
    appPath: join(packageDir, 'native', 'bin', `darwin-${arch}`, current.bundle, 'DSH Computer Use.app'),
  }
}

function verifyHelperReceipt(helper, providerVersion) {
  // The provider PACKAGE is what the candidate pins; the helper RECEIPT is an
  // independent upstream fact (rc.5 still ships a receipt that says rc.3). Both
  // are recorded, and the receipt must be a real DSH-family version — it is not
  // asserted equal to the pinned DSH, which the upstream package does not keep.
  assert(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u.test(String(helper.receipt.version ?? '')),
    `the CUA helper receipt carries no DSH-family version: ${JSON.stringify(helper.receipt.version)}`)
  assert(typeof providerVersion === 'string' && providerVersion !== '',
    'the CUA provider package version is unreadable')
  assert(helper.expected !== undefined, `the CUA helper receipt has no ${process.arch} application`)
  assert(helper.current.bundle === helper.expected.bundle,
    'the CUA helper current.json does not select the package receipt bundle')
  assert(existsSync(helper.appPath), `the signed CUA helper app is missing: ${helper.appPath}`)
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', helper.appPath], { encoding: 'utf8', timeout: 60_000 })
  assert(verify.status === 0,
    `the official CUA helper signature did not verify: ${(verify.stderr ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-800)}`)
  const details = spawnSync('codesign', ['-d', '--verbose=2', helper.appPath], { encoding: 'utf8', timeout: 60_000 })
  const detailText = `${details.stdout ?? ''}${details.stderr ?? ''}`
  assert(details.status === 0, 'the official CUA helper signature details could not be read')
  assert(detailText.includes('Authority=Developer ID Application'),
    'the official CUA helper is not Developer ID signed')
  assert(detailText.includes(`TeamIdentifier=${helper.receipt.teamId}`),
    `the official CUA helper team id does not match the package receipt ${helper.receipt.teamId}`)
  return {
    bundle: helper.current.bundle,
    // The upstream receipt's own declared version: an observed fact, NOT the
    // pinned pairing (the rc.5 package still ships an rc.3 receipt).
    receiptVersion: helper.receipt.version,
    teamId: helper.receipt.teamId,
    architectures: helper.receipt.applications?.map(application => application.architecture) ?? [],
    arch: `darwin-${process.arch}`,
  }
}

function verifyDistribution(installation, targetDshVersion) {
  const dshPackage = resolvePackageJson(join(installation.harnessDir, 'package.json'), '@deepseek-ai/dsh')
  assert(dshPackage !== undefined, 'the isolated harness did not install @deepseek-ai/dsh')
  const officialPackage = resolvePackageJson(dshPackage, '@deepseek-ai/dsh-official-bundles')
  assert(officialPackage !== undefined, 'the pinned DSH distribution is missing @deepseek-ai/dsh-official-bundles')
  const bundlePackage = resolvePackageJson(officialPackage, CUA_BUNDLE)
  assert(bundlePackage !== undefined, `the pinned DSH distribution is missing ${CUA_BUNDLE}`)
  const macosPackage = resolvePackageJson(bundlePackage, CUA_MACOS_PACKAGE)
  assert(macosPackage !== undefined, 'the pinned DSH distribution is missing the macOS CUA provider')
  const helper = helperFromPackage(macosPackage, process.arch)
  // The pinned pairing is enforced on the PACKAGE the distribution resolves, and
  // the receipt stays an observed upstream fact.
  const providerVersion = JSON.parse(readFileSync(macosPackage, 'utf8')).version
  assert(providerVersion === targetDshVersion,
    `the CUA provider package ${JSON.stringify(providerVersion)} != the pinned DSH ${targetDshVersion}`)
  const receipt = verifyHelperReceipt(helper, providerVersion)
  return { dshPackage, bundlePackage, macosPackage, helperAppPath: helper.appPath, receipt, providerVersion }
}

function profileCuaHelper(profileDir) {
  const bundlePackage = resolvePackageJson(join(profileDir, 'package.json'), CUA_BUNDLE)
  if (bundlePackage === undefined) return undefined
  const macosPackage = resolvePackageJson(bundlePackage, CUA_MACOS_PACKAGE)
  if (macosPackage === undefined) return undefined
  try {
    return helperFromPackage(macosPackage, process.arch)
  } catch {
    return undefined
  }
}

/** The operator user-layer patch is applied to the profile's OWN patch file. */
function applyOperatorPatch(profileDir, operatorPatchPath) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const stock = readFileSync(patchPath, 'utf8')
  const operator = readFileSync(operatorPatchPath, 'utf8')
  const noEmpty = stock.split('\n').filter(line => line.trim() !== '[]').join('\n')
  writeFileSync(patchPath, `${noEmpty.replace(/\s*$/u, '')}\n${operator.replace(/\s*$/u, '')}\n`, { mode: 0o600 })
}

function dumpProfile(installation, label) {
  const result = spawnSync(installation.dshInvocation[0], [...installation.dshInvocation.slice(1), '--profile', 'pi-tui', '--dump-config'], {
    cwd: installation.profileDir,
    env: installation.env,
    encoding: 'utf8',
    timeout: TIMEOUTS.dump,
  })
  assert(result.status === 0,
    `${label}: the isolated profile did not compose (--dump-config exit ${String(result.status)}): ${(result.stderr ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-1200)}`)
  let entries
  try {
    entries = parseYaml(result.stdout, { logLevel: 'silent' })
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the composed profile tree is unreadable: ${boundedError(error)}`)
  }
  assert(Array.isArray(entries), `${label}: the composed profile tree is not a YAML array`)
  return entries
}

/** The composed profile must name a real image-capable model route. */
function verifyModelRoute(installation) {
  const entries = dumpProfile(installation, 'model route preflight')
  const defaultModel = entries.find(entry => entry?.id === 'agent-default-model')
  const provider = defaultModel?.config?.provider
  const model = defaultModel?.config?.model
  assert(typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '',
    'the composed profile has no agent default provider/model')
  const route = entries.find(entry => entry?.id === 'llm-pi-ai' && entry?.config?.providers?.[provider] !== undefined)
  const routeEntry = route?.config.providers[provider]
  const modelEntry = routeEntry?.models?.find(candidate => candidate?.id === model)
  assert(modelEntry !== undefined,
    `the composed profile does not declare the agent default model ${provider}/${model} in a mounted image-capable route`)
  const modalities = Array.isArray(modelEntry.input) ? modelEntry.input : []
  assert(modalities.includes('image'),
    `the composed agent default model ${provider}/${model} does not declare image input`)
  const apiKeyEnv = routeEntry?.apiKeyEnv
  assert(typeof apiKeyEnv === 'string' && apiKeyEnv !== '',
    `the composed model route ${provider} declares no credential reference`)
  return { provider, model, apiKeyEnv, contextWindow: modelEntry.contextWindow }
}

function verifyCredentialReference(dshHome, apiKeyEnv) {
  const credentials = parseYaml(readFileSync(join(dshHome, '.credentials.yaml'), 'utf8'))
  assert(credentials?.refs?.[apiKeyEnv] !== undefined,
    `the operator credentials do not provide the composed route's credential reference ${apiKeyEnv}`)
}

function verifyBundleSelected(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  assert(Array.isArray(bundles), 'the profile package.json has no dsh.profile.bundles selection list')
  return bundles.includes(CUA_BUNDLE)
}

function verifyBundleComposition(installation) {
  const entries = dumpProfile(installation, 'CUA bundle composition')
  const provider = entries.find(entry => entry?.id === 'cua')
  assert(provider !== undefined, 'the official Computer use bundle did not select the macOS CUA provider row')
  assert(provider.name === CUA_MACOS_PACKAGE,
    `the CUA provider row loads ${JSON.stringify(provider.name)} instead of ${CUA_MACOS_PACKAGE}`)
  assert(provider.config?.agentPreset === CUA_PRESET,
    `the CUA provider row is not bounded to the ${CUA_PRESET} preset: ${JSON.stringify(provider.config)}`)
  return { providerRow: provider.name, agentPreset: provider.config.agentPreset }
}

/**
 * Wait until the durable CUA permission store is QUIESCENT, then return its
 * immutable decision snapshot.
 *
 * The store legitimately changes while a consent decision is being written: the
 * resumed Split Client can raise a NEW model-initiated ask after the disconnect
 * case, and answering it writes a decision. A "before" snapshot taken during
 * that write would then differ from the post-disable read for a reason that has
 * nothing to do with disabling the bundle. A painted consent Question that no
 * case owns is denied here (a local refusal, recorded in the report) so the
 * store settles; the snapshot is accepted only when two consecutive reads agree.
 */
async function quiesceConsentDecisions(installation, tui, label) {
  const deadline = Date.now() + TIMEOUTS.consent
  let deniedAsks = 0
  let snapshot = permissionStoreSnapshot(installation.dshHome)
  while (Date.now() < deadline) {
    const frame = tmuxCapture(tui, `${label} consent state`)
    if (frame.includes('Allow computer use')) {
      // Deny through the PAINTED option rows only (never a blind key).
      const optionRow = frame.split('\n').find(line => line.includes('[2] Deny'))
      assert(optionRow !== undefined, `${label}: the painted Question has no Deny option row`)
      sendNamedKey(tui, '2', `${label} deny option`)
      await sleep(500)
      sendNamedKey(tui, 'Enter', `${label} deny review`)
      await sleep(500)
      if (tmuxCapture(tui, `${label} review state`).includes('Submit [Enter]')) {
        sendNamedKey(tui, 'Enter', `${label} deny submit`)
      }
      deniedAsks += 1
      for (let wait = 0; wait < 20; wait += 1) {
        if (!tmuxCapture(tui, `${label} after deny`).includes('Allow computer use')) break
        await sleep(500)
      }
    }
    const next = permissionStoreSnapshot(installation.dshHome)
    if (JSON.stringify(next) === JSON.stringify(snapshot)) {
      return { snapshot: next, deniedAsks }
    }
    snapshot = next
    await sleep(400)
  }
  throw new Error(`${label}: the durable CUA consent store never settled`)
}

/**
 * THE IMMUTABLE DECISION SNAPSHOT of the durable CUA permission store.
 *
 * A fingerprint taken BEFORE an operation cannot be re-read afterwards: the
 * file at that path may already be the new one. This reads the decision content
 * ONCE, at the moment the caller asks for it, and returns plain data — the only
 * form in which a "before" value can still be compared after the operation ran.
 * Never secrets: application ids, names, decisions, revisions.
 */
function permissionStoreSnapshot(dshHome) {
  const directory = join(dshHome, 'storages')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(name => /^cua_permissions_.*\.json$/u.test(name))
    .sort()
    .map(name => {
      const path = join(directory, name)
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const state = parsed?.state ?? parsed
      const applications = state?.applications ?? state?.global?.applications ?? {}
      return {
        name,
        sha256: sha256File(path),
        bytes: statSync(path).size,
        applications,
      }
    })
}

// ── scene helpers ─────────────────────────────────────────────────────────

function startTui({ installation, workRoot, backend, sessionName, args = [] }) {
  const project = join(workRoot, 'project')
  mkdirSync(project, { recursive: true })
  const { dshInvocation, env } = installation
  const command = [
    'env',
    '-u',
    'NO_COLOR',
    ...(backend === undefined ? [] : [`DSH_PI_TUI_BACKEND=${backend}`]),
    ...Object.entries(env).filter(([key]) => key !== 'NO_COLOR').map(([key, value]) => `${key}=${String(value)}`),
    dshInvocation[0],
    ...dshInvocation.slice(1),
    '--profile',
    'pi-tui',
    ...args,
  ].map(shellQuote).join(' ')
  tmux(['new-session', '-d', '-s', sessionName, '-x', '120', '-y', '40', '-c', project, command], `new-session ${sessionName}`)
  return sessionName
}

/** Send one SGR left-button click at a 1-based pane cell (no Enter). */
function sendMouseClick(session, row, col, label) {
  const sequence = `\x1b[<0;${String(col)};${String(row)}M\x1b[<0;${String(col)};${String(row)}m`
  tmux(['send-keys', '-t', session, '-l', sequence], label)
}

/**
 * Expand the collapsed nested tool card whose header names `needle`: the
 * existing TSP image identity row is only painted inside the child's expanded
 * body. A pointer click on the painted disclosure marker is the same user
 * action, not a second transcript owner.
 */

/**
 * Answer ONE official approval Question in the real pane by its OWN painted
 * states: select the option whose row paints `optionText`, wait for the
 * painted review seat, then submit. Every step re-reads the visible screen,
 * so a stale frame can never drive the keys.
 */
async function answerApprovalQuestion(session, optionText, label) {
  const selectFrame = await waitFor(() => {
    const frame = tmuxCapture(session, `${label} select`)
    return frame.includes(optionText) ? frame : undefined
  }, `${label} the option row is painted`, 20_000)
  const index = /\[1\]/u.test(selectFrame) && optionText.includes('Allow') ? '1'
    : /\[2\]/u.test(selectFrame) && optionText.includes('Deny') ? '2' : undefined
  assert(index !== undefined, `${label}: the painted Question offers no ${optionText} option row`)
  sendNamedKey(session, index, `${label} select`)
  await waitFor(() => tmuxCapture(session, `${label} review`).includes('Review your answer before submit'),
    `${label} the review seat is painted`, 10_000)
  sendNamedKey(session, 'Enter', `${label} submit`)
}

async function expandNestedToolCard(session, needle, label) {
  const frame = tmuxCapture(session, `${label} before expand`)
  const lines = frame.split('\n')
  const rowIndex = lines.findIndex(line => line.includes(needle) && /[▶▸]/u.test(line))
  assert(rowIndex >= 0, `${label}: the collapsed nested ${needle} card is not painted`)
  const line = lines[rowIndex]
  const marker = line.search(/[▶▸]/u)
  assert(marker >= 0, `${label}: the nested ${needle} card has no painted disclosure marker`)
  // The per-card tool disclosure is MOUSE-OWNED on the full-screen Focus
  // surface; the SGR click is the user's real toggle. The painted frame is the
  // proof: the expansion must be visible before the image-row wait runs, and
  // an unexpanded card fails HERE instead of inside the identity wait.
  const expandedAt = () => tmuxCapture(session, `${label} after expand`)
    .split('\n')
    .some(row => row.includes(needle) && /[▼▾]/u.test(row))
  // A streaming transcript can move the card between the capture and the
  // click; re-locate the CURRENT painted row and click again each tick until
  // the painted expansion proves the toggle.
  const deadline = Date.now() + 15_000
  while (!expandedAt()) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: the nested ${needle} card never expanded under the disclosure click`)
    }
    const lines = tmuxCapture(session, `${label} relocate`).split('\n')
    const row = lines.findIndex(line => line.includes(needle) && /[▶▸]/u.test(line))
    if (row >= 0) {
      const marker = lines[row].search(/[▶▸]/u)
      sendMouseClick(session, row + 1, marker + 1, `${label} disclosure click`)
    }
    await sleep(1_000)
  }
  await waitFor(expandedAt, `${label} the nested ${needle} card expanded`, 5_000)
  await waitFor(expandedAt, `${label} the nested ${needle} card expanded`, 10_000)
}

async function closeTui(session, label) {
  if (!tmuxSessionExists(session)) return
  sendKeys(session, '/exit', label)
  await waitSessionExit(session, `${label} exits`)
}

/**
 * Send one one-line model instruction and wait for its durable user message.
 * Returns the exact Session and the durable event index of the message.
 */
async function sendPrompt({ tui, dshHome, prompt, label }) {
  const token = `[${label.replace(/[^A-Za-z0-9-]/gu, '-')}-${randomUUID().slice(0, 8)}]`
  const text = `${token} ${prompt}`
  await waitComposer(tui, `${label} composer`)
  sendKeys(tui, text, label)
  return await waitSessionPrompt(dshHome, token, `${label} durable user message`, TIMEOUTS.turn)
}

/**
 * Run one model instruction and wait for a `cua` dispatch of the requested raw
 * method (the SDK method a PTC nested call names). Returns the Session, the
 * durable snapshot index and the matching dispatch-start data.
 */
async function promptAndWaitCua({ tui, dshHome, sessionId, prompt, label, method, timeoutMs = TIMEOUTS.turn }) {
  const before = sessionId === undefined ? 0 : eventsOf(dshHome, sessionId).length
  const message = await sendPrompt({ tui, dshHome, prompt, label })
  const session = sessionId ?? message.sessionId
  const afterIndex = sessionId === undefined ? message.index + 1 : before
  const dispatch = await waitFor(() => cuaDispatches(eventsOf(dshHome, session), afterIndex)
    .find(candidate => method === undefined || dispatchMethod(candidate) === method),
  `${label} official cua ${method ?? 'dispatch'}`, timeoutMs)
  return { sessionId: session, afterIndex, dispatch, message }
}

/** Wait for a completed turn after a prompt without any new `cua` dispatch. */
async function promptAndRequireNoCua({ tui, dshHome, sessionId, prompt, label }) {
  const before = sessionId === undefined ? 0 : eventsOf(dshHome, sessionId).length
  const message = await sendPrompt({ tui, dshHome, prompt, label })
  const session = sessionId ?? message.sessionId
  const afterIndex = sessionId === undefined ? message.index + 1 : before
  const turn = await waitTurnEnd(dshHome, session, afterIndex, `${label} model turn completed`)
  const dispatches = cuaDispatches(turn.events, afterIndex)
  assert(dispatches.length === 0,
    `${label}: a non-CUA/non-enabled Session received ${String(dispatches.length)} official cua dispatch(es)`)
  await sleep(1_000)
  assert(cuaDispatches(eventsOf(dshHome, session), afterIndex).length === 0,
    `${label}: the cua dispatch appeared after the turn boundary`)
  return { sessionId: session, turnIndex: turn.index }
}

async function newSession(tui, label) {
  const before = sessionIdFromFrame(tmuxCapture(tui, `${label} before /new`))
  sendKeys(tui, '/new', label)
  return await waitFor(() => {
    const id = sessionIdFromFrame(tmuxCapture(tui, `${label} frame`))
    return id !== undefined && id !== before ? id : undefined
  }, `${label} a new Session id is painted`, TIMEOUTS.mount)
}

function dispatchArguments(dispatch) {
  const value = dispatch?.arguments
  if (value !== undefined && typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

function dispatchMethod(dispatch) {
  return dispatchArguments(dispatch)?.method
}

/** The method params of one official cua dispatch/result event. */
function dispatchParams(dispatch) {
  const args = dispatchArguments(dispatch)
  return args?.params !== undefined && typeof args.params === 'object' ? args.params : undefined
}

function dispatchErrorCode(result) {
  const text = JSON.stringify(result?.content ?? result ?? '')
  const match = /"code"\s*:\s*"([A-Z0-9_]+)"/u.exec(text)
  if (match !== null) return match[1]
  // The official PTC error settles as a text block: `Error: <CODE>: <message>`.
  const textMatch = /\bError:\s*([A-Z][A-Z0-9_]+):/u.exec(dispatchContentText(result))
  return textMatch?.[1]
}

function dispatchContentText(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
}

/** Parse the official cua result's JSON text when it carries one. */
function dispatchJsonContent(result) {
  try {
    return JSON.parse(dispatchContentText(result))
  } catch {
    return undefined
  }
}

function attachmentRefs(value, found = new Set()) {
  if (typeof value === 'string') {
    const match = /\bsha256:[0-9a-f]{64}\b/u.exec(value)
    if (match !== null) found.add(match[0])
    return found
  }
  if (Array.isArray(value)) {
    for (const item of value) attachmentRefs(item, found)
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) attachmentRefs(item, found)
  }
  return found
}

function attachmentObjectPath(dshHome, ref) {
  const digest = ref.slice('sha256:'.length)
  return join(dshHome, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
}

function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) return undefined
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xc3 && offset + 9 <= buffer.length) {
        return { mediaType: 'image/jpeg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
    return undefined
  }
  if (buffer.length >= 16 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buffer.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return {
        mediaType: 'image/webp',
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        mediaType: 'image/webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return {
        mediaType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }
  }
  return undefined
}

function parseCapabilityPermissions(text) {
  try {
    const value = JSON.parse(text)
    const permissions = value?.permissions ?? value?.result?.permissions
    if (permissions !== undefined && typeof permissions === 'object') return permissions
  } catch {
    // CUA tool text may wrap the JSON in prose; fall through to the narrow
    // extraction below.
  }
  const accessibility = /"accessibility"\s*:\s*(true|false)/u.exec(text)?.[1]
  const screenRecording = /"screenRecording"\s*:\s*(true|false)/u.exec(text)?.[1]
  if (accessibility === undefined || screenRecording === undefined) return undefined
  return { accessibility: accessibility === 'true', screenRecording: screenRecording === 'true' }
}

// ── TextEdit (the ONE controlled test application) ─────────────────────────

function textEditPids() {
  const result = spawnSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return []
  return result.stdout.split('\n').map(line => Number(line.trim())).filter(pid => Number.isSafeInteger(pid) && pid > 0)
}

async function openBlankTextEdit(workRoot) {
  const directory = join(workRoot, 'textedit')
  mkdirSync(directory, { recursive: true })
  // The document NAME is the run's owned-window identity: TextEdit titles the
  // window after the file, and the MAC09-08 audit requires exactly ONE window
  // whose title carries the run's token. A fixed name would collide with
  // documents left by an earlier run (including an aborted one), so the run's
  // own token is part of the file name and the scene never matches a stale
  // window.
  const runToken = `cua-blank-${randomUUID().slice(0, 8)}`
  const file = join(directory, `${runToken}.txt`)
  writeFileSync(file, '', { mode: 0o600 })
  const before = new Set(textEditPids())
  const opened = spawnSync('open', ['-na', 'TextEdit', file], { encoding: 'utf8', timeout: 30_000 })
  assert(opened.status === 0, `the controlled TextEdit document could not be opened: ${(opened.stderr ?? '').slice(-500)}`)
  const pid = await waitFor(() => {
    const created = textEditPids().filter(candidate => !before.has(candidate))
    return created.length === 1 ? created[0] : undefined
  }, 'ONE new TextEdit instance for the qualification', TIMEOUTS.process)
  const started = processStarted(pid)
  assert(started !== undefined, 'the qualification TextEdit instance has no kernel start identity')
  return { file, runToken, pid, started, before: [...before] }
}

function processIsTextEdit(pid, started) {
  const row = processTable().find(candidate => candidate.pid === pid)
  return row !== undefined && row.started === started
    && /(?:^|\/)TextEdit(?:\s|$)/u.test(row.command.trim())
}

async function stopBlankTextEdit(textEdit) {
  if (textEdit === undefined) return []
  const errors = []
  if (alive(textEdit.pid) && !processIsTextEdit(textEdit.pid, textEdit.started)) {
    errors.push(`the qualification TextEdit pid ${String(textEdit.pid)} no longer has this run's kernel start identity; refusing to signal it`)
    return errors
  }
  if (alive(textEdit.pid)) {
    try { process.kill(textEdit.pid, 'SIGTERM') } catch { /* already gone */ }
    try {
      await waitFor(() => (!alive(textEdit.pid) ? true : undefined), 'the qualification TextEdit instance stops', 15_000)
    } catch {
      // A PID can be reused while waiting. Never escalate to SIGKILL unless the
      // CURRENT process at that pid is still this run's TextEdit.
      if (!processIsTextEdit(textEdit.pid, textEdit.started)) {
        errors.push(`the qualification TextEdit pid ${String(textEdit.pid)} changed kernel identity before SIGKILL; refusing to signal it`)
      } else {
        try { process.kill(textEdit.pid, 'SIGKILL') } catch { /* already gone */ }
        try {
          await waitFor(() => (!alive(textEdit.pid) ? true : undefined), 'the qualification TextEdit instance is reaped', 10_000)
        } catch {
          errors.push(`the qualification TextEdit pid ${String(textEdit.pid)} survived cleanup`)
        }
      }
    }
  }
  return errors
}

// ── report / case bookkeeping ──────────────────────────────────────────────

/** The checkout revision whose scripts/ judged this run ('' when unavailable). */
function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0 ? result.stdout.trim() : ''
}

function makeReport({ candidate, preflight, installation, model, helper }) {
  return {
    schemaVersion: 1,
    lane: LANE,
    status: 'FAIL',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    macos: macosProductVersion(),
    account: { name: preflight.account, launchdSession: preflight.guiSession, consoleLogin: true, tmux: preflight.tmux },
    candidate: {
      path: resolve(candidate.tarball),
      sha256: candidate.candidateSha256,
      version: candidate.manifest.version,
      dshPin: candidate.targetDshVersion,
      // The tarball does NOT contain scripts/, so the LANE logic that judged
      // this run comes from the checkout: record that revision so lane-only
      // changes can never ride on an unchanged product sha.
      laneRevision: gitRevision(),
    },
    isolatedProfile: {
      dshHome: installation.dshHome,
      profileDir: installation.profileDir,
      dshVersion: candidate.targetDshVersion,
      helper: helper.receipt,
      // The resolved provider PACKAGE is the pinned pairing fact; the receipt's
      // own version is the upstream helper fact recorded above.
      providerVersion: helper.providerVersion,
      helperAppPath: helper.helperAppPath,
    },
    model,
    rows: [],
    activeCase: undefined,
    cleanup: null,
  }
}

function macosProductVersion() {
  const result = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function setCase(report, id) {
  report.activeCase = id
}

function pushRow(report, id, status, detail, reason) {
  const row = { case: id, status, tier: 'L6', detail }
  if (reason !== undefined) row.reason = reason
  report.rows.push(row)
  report.activeCase = id
  return row
}

function findRow(report, id) {
  return report.rows.find(row => row.case === id)
}

function caseNotVerified(report, id, reason) {
  if (findRow(report, id) === undefined) pushRow(report, id, 'NOT_VERIFIED', { evidence: 'not reached' }, reason)
}

/** Record a failed/not-verified case once and abort the scene. */
function recordCaseFailure(report, id, error) {
  const reason = boundedError(error)
  const status = error instanceof CuaNotVerifiedError ? 'NOT_VERIFIED' : 'FAIL'
  if (findRow(report, id) === undefined) pushRow(report, id, status, { evidence: 'aborted' }, reason)
}

function fillUnreachedCases(report) {
  for (const id of REQUIRED_CASES) caseNotVerified(report, id, 'not reached because an earlier case stopped the scene')
}

// ── MAC09-08 controlled-trace audit ───────────────────────────────────────
//
// The WHOLE structural audit of one settled controlled program, as a pure
// function of its trace so the real judging code can be replayed against
// synthetic traces (test/tooling/macos-cua-trace-audit.test.mjs) instead of
// only being exercised by whatever a model happened to emit. Two async facts
// are injected because they come from the live event stream: the JSON payload
// of a dispatch result, and the settlement of the FINAL segment's own typeText.
//
// NO earlier segment is exempt and NO earlier segment may WRITE. The only legal
// shape of a controlled program is:
//   for EVERY segment (split at each getApp):
//     getApp(this run's exact PID) -> listWindows(that handle)
//     -> show(that handle, a window whose title carries THIS run's token)
//     -> optional activate(that handle) / read-only getState(that handle)
//   and exactly ONE typeText in the WHOLE trace, in the FINAL segment, typed
//   with that segment's handle and this run's marker, observed by the final
//   getState of that same segment.
// Anything else fails closed: an app-scoped typeText can write into ANY open
// document of the app, so a segment that never selected the owned window is
// indistinguishable from a write into a user document, and a second typeText
// is a second input (MAC09-08 claims ONE bounded input).
export async function auditControlledTrace({ trace, turnDispatches, rootCallId, textEditPid, runToken, marker, resolveJson, resolveTypeTextResult }) {
  const inputSequence = trace.map(dispatchMethod)
  // The controlled trace must OPEN with getApp: a leading dispatch would sit
  // before every segment and therefore outside the per-segment audit below, so
  // an unowned `show`/`activate` (which can still raise an already-authorized
  // foreign app and move focus) would have no this-run handle or owned target
  // behind it. Fail closed instead of auditing such a prefix.
  assert(inputSequence[0] === 'getApp',
    `MAC09-08: the controlled call dispatched before obtaining an app handle: ${JSON.stringify(inputSequence)}`)
  const segmentStarts = inputSequence.flatMap((method, index) => method === 'getApp' ? [index] : [])
  const attemptDispatches = segmentStarts.length === 0 ? [] : trace.slice(segmentStarts.at(-1))
  const attemptMethods = attemptDispatches.map(dispatchMethod)
  const firstOf = method => attemptDispatches.find(dispatch => dispatchMethod(dispatch) === method)
  const getAppDispatch = firstOf('getApp')
  const listWindowsDispatch = firstOf('listWindows')
  const showDispatch = firstOf('show')
  const activateDispatch = firstOf('activate')
  const typeDispatch = firstOf('typeText')
  // The observation is the LAST dispatch of the segment (the post-typing read);
  // an earlier getState is a bounded read-only preview and never qualifies.
  const attemptStateDispatch = attemptDispatches.at(-1)
  const TRACE_METHODS = new Set(['getApp', 'listWindows', 'show', 'activate', 'typeText', 'getState'])
  for (const dispatch of trace) {
    assert(TRACE_METHODS.has(dispatchMethod(dispatch)),
      `MAC09-08: the controlled call dispatched a method the scene does not audit: ${dispatchMethod(dispatch)}`)
  }
  // ONE bounded input is a WHOLE-TURN claim: a second CUA root in the same user
  // turn could type without the selected root showing it, so both the turn and
  // the selected root must carry exactly one typeText.
  // A foreign root is judged FIRST so its side effect is reported as such
  // instead of being folded into the turn-wide input count.
  const foreignRoots = turnDispatches.filter(item => item.rootCallId !== rootCallId)
  const FOREIGN_READ_ONLY = new Set(['getApp', 'listWindows', 'getState'])
  const foreignSideEffects = foreignRoots.filter(item => !FOREIGN_READ_ONLY.has(dispatchMethod(item)))
  assert(foreignSideEffects.length === 0,
    `MAC09-08: another cua root in the same user turn dispatched side effects: ${JSON.stringify([...new Set(foreignSideEffects.map(dispatchMethod))])}`)
  const turnTypeTexts = turnDispatches.filter(item => dispatchMethod(item) === 'typeText')
  assert(turnTypeTexts.length === 1,
    `MAC09-08: the user turn triggered ${String(turnTypeTexts.length)} cua typeText calls; the scene claims ONE bounded input`)
  const typeTextDispatches = trace.filter(item => dispatchMethod(item) === 'typeText')
  assert(typeTextDispatches.length === 1,
    `MAC09-08: the controlled root typed ${String(typeTextDispatches.length)} times; the scene claims ONE bounded input`)
  // The qualifying RESULT belongs to the FINAL segment's own typeText: an
  // earlier attempt's success may never stand in for it, and an earlier
  // attempt's failure may not disqualify a recovered program.
  const typeTextSettled = await resolveTypeTextResult(typeDispatch)
  assert(typeTextSettled !== undefined && typeTextSettled.result?.isError !== true,
    `MAC09-08: the controlled typeText failed: ${dispatchErrorCode(typeTextSettled?.result) ?? 'unknown error'} :: ${dispatchContentText(typeTextSettled?.result ?? {}).slice(0, 400)}`)
  const segmentRanges = segmentStarts.map((start, index) =>
    trace.slice(start, segmentStarts[index + 1] ?? trace.length))
  const segmentFacts = []
  let observationJson
  for (const [index, segment] of segmentRanges.entries()) {
    const methods = segment.map(dispatchMethod)
    const final = index === segmentRanges.length - 1
    assert(methods[0] === 'getApp' && methods[1] === 'listWindows',
      `MAC09-08: a controlled segment did not open with getApp -> listWindows: ${JSON.stringify(methods)}`)
    assert(methods.every(method => TRACE_METHODS.has(method) && method !== 'typeText' || final),
      `MAC09-08: a NON-final segment dispatched typeText: ${JSON.stringify(methods)}`)
    const appDispatch = segment[0]
    assert(dispatchParams(appDispatch)?.selector === String(textEditPid),
      `MAC09-08: a controlled getApp selected a target other than this run's exact TextEdit PID: ${JSON.stringify(dispatchParams(appDispatch)?.selector)}`)
    const handle = resolveJson(appDispatch)?.appHandle
    assert(typeof handle === 'string' && handle !== '',
      'MAC09-08: a controlled getApp result carried no app handle')
    const windowDispatch = segment[1]
    assert(dispatchParams(windowDispatch)?.appHandle === handle,
      'MAC09-08: a controlled listWindows did not use its own getApp handle')
    const windows = resolveJson(windowDispatch)
    const ownedWindowIds = (Array.isArray(windows) ? windows : [])
      .filter(window => String(window?.title ?? '').includes(runToken))
      .map(window => window?.windowId)
    assert(ownedWindowIds.length === 1,
      `MAC09-08: the controlled app did not expose exactly one owned cua-blank window in a segment: ${JSON.stringify(ownedWindowIds)}`)
    const ownedWindowId = ownedWindowIds[0]
    const shows = segment.filter(dispatch => dispatchMethod(dispatch) === 'show')
    assert(shows.length >= 1,
      'MAC09-08: a controlled segment never selected the owned cua-blank window (show)')
    for (const show of shows) {
      assert(dispatchParams(show)?.appHandle === handle,
        'MAC09-08: a controlled show did not use its own getApp handle')
      assert(dispatchParams(show)?.windowId === ownedWindowId,
        `MAC09-08: a controlled show selected a window that is not this run's owned cua-blank window: ${JSON.stringify(dispatchParams(show)?.windowId)}`)
    }
    for (const dispatch of segment) {
      const method = dispatchMethod(dispatch)
      if (method === 'getApp' || method === 'show') continue
      assert(dispatchParams(dispatch)?.appHandle === handle,
        `MAC09-08: a controlled ${method} did not use its own segment's getApp handle`)
    }
    // ORDER is part of the proof: the owned window must be selected AFTER this
    // segment's listWindows and BEFORE any side effect. Without this, a trace
    // like getApp,listWindows,typeText,show(owned),getState would type into
    // whatever window was focused and only THEN select the owned one.
    const listWindowsIndex = methods.indexOf('listWindows')
    const showIndexes = methods.flatMap((method, position) => method === 'show' ? [position] : [])
    const activateIndexes = methods.flatMap((method, position) => method === 'activate' ? [position] : [])
    const typeIndexes = methods.flatMap((method, position) => method === 'typeText' ? [position] : [])
    for (const showIndex of showIndexes) {
      assert(showIndex > listWindowsIndex,
        `MAC09-08: a controlled segment selected the owned window BEFORE its listWindows: ${JSON.stringify(methods)}`)
    }
    for (const activateIndex of activateIndexes) {
      assert(activateIndex > listWindowsIndex && (typeIndexes.length === 0 || activateIndex < typeIndexes[0]),
        `MAC09-08: a controlled activate was not between listWindows and the input: ${JSON.stringify(methods)}`)
    }
    for (const typeIndex of typeIndexes) {
      const lastShowBefore = showIndexes.filter(position => position < typeIndex).at(-1)
      assert(lastShowBefore !== undefined,
        `MAC09-08: a controlled segment typed BEFORE selecting the owned cua-blank window: ${JSON.stringify(methods)}`)
      assert(!activateIndexes.some(position => position > typeIndex && position < typeIndexes.at(-1)),
        'MAC09-08: a controlled segment activated the app after typing')
    }
    const segmentTypeTexts = segment.filter(dispatch => dispatchMethod(dispatch) === 'typeText')
    for (const typeText of segmentTypeTexts) {
      assert(dispatchParams(typeText)?.text === marker,
        'MAC09-08: the controlled call typed text other than this run\'s marker')
    }
    if (final && typeIndexes.length === 1) {
      // TARGET PROOF 1 (before the input): the rc.5 provider's `show` ->
      // restoreWindow only clears AXHidden/AXMinimized and never raises or
      // focuses (AXAccess.swift, rc.5 tag), while an app-scoped typeText goes to
      // AXFocusedWindow (AXWorker.swift keyboardRecipient). Showing the owned
      // window therefore proves NOTHING about where the input lands: the app
      // must actually FOCUS the owned window before the input, and the trace
      // must carry that read.
      const prefix = segment.slice(0, typeIndexes[0])
      const beforeInput = prefix
        .flatMap((dispatch, position) => dispatchMethod(dispatch) === 'getState' ? [{ dispatch, position }] : [])
      // The FOCUS proof must be the LAST read before the input and must follow
      // the segment's last show/activate: an earlier `true` cannot carry over a
      // later change of focus, and a read that precedes a show/activate says
      // nothing about where the app is focused when the input runs.
      const lastRead = beforeInput.at(-1)
      assert(lastRead !== undefined,
        'MAC09-08: the controlled attempt never read focusedWindowId before the input')
      const lastFocusChange = prefix
        .flatMap((dispatch, position) => ['show', 'activate'].includes(dispatchMethod(dispatch)) ? [position] : [])
        .at(-1)
      assert(lastFocusChange === undefined || lastRead.position > lastFocusChange,
        `MAC09-08: the focus proof precedes the last show/activate, so no fresh read proves the input target: ${JSON.stringify(methods)}`)
      const lastFocused = resolveJson(lastRead.dispatch)?.focusedWindowId
      assert(lastFocused !== undefined && lastFocused !== null && String(lastFocused) === String(ownedWindowId),
        `MAC09-08: the owned window was not the app's focused window before the input (last read focusedWindowId ${JSON.stringify(lastFocused)}, owned ${JSON.stringify(ownedWindowId)})`)
      // TARGET PROOF 2 (after the input): the observation must be a
      // WINDOW-SCOPED read of the owned window, and the provider must report
      // that same windowId. An app-scoped tree can contain the marker in a
      // different restored document.
      const observation = segment.at(-1)
      assert(dispatchMethod(observation) === 'getState'
        && String(dispatchParams(observation)?.windowId) === String(ownedWindowId),
      'MAC09-08: the observation is not a window-scoped read of the owned window')
      assert(String(resolveJson(observation)?.windowId) === String(ownedWindowId),
        `MAC09-08: the window-scoped observation reported another window: ${JSON.stringify(resolveJson(observation)?.windowId)}`)
      // The marker must be read from THIS owned-window observation's tree: an
      // app-scoped tree (or another window's) can contain the marker elsewhere.
      const observationTree = resolveJson(observation)?.tree
      assert(typeof observationTree === 'string' && observationTree.includes(marker),
        'MAC09-08: the owned-window observation tree does not contain the typed marker')
      observationJson = resolveJson(observation)
    }
    segmentFacts.push({ methods, handle, ownedWindowId, typeTexts: segmentTypeTexts.length })
  }
  assert(segmentFacts.at(-1).typeTexts === 1,
    'MAC09-08: the final segment did not carry the ONE controlled typeText')
  // The CLAIM is one bounded input observed by the same call. `show` of the
  // OWNED window is REQUIRED in every segment (getState carries no window
  // identity, so the explicit selection is the only target proof). A bounded
  // READ-ONLY preview getState before the input is legitimate; the LAST dispatch
  // of the final segment must be the observation getState.
  const previews = attemptMethods.slice(0, attemptMethods.indexOf('typeText'))
    .filter(method => method === 'getState').length
  const sequenceShaped = attemptMethods.at(-1) === 'getState' && previews <= 2
  assert(sequenceShaped,
    `MAC09-08: the controlled root dispatched an unexpected cua method sequence: ${JSON.stringify(inputSequence)} (attempt ${JSON.stringify(attemptMethods)}, previews ${String(previews)})`)
  assert(getAppDispatch !== undefined && dispatchParams(getAppDispatch)?.selector === String(textEditPid),
    'MAC09-08: the official getApp did not select this run\'s exact TextEdit PID')
  const controlledHandle = resolveJson(getAppDispatch)?.appHandle
  assert(typeof controlledHandle === 'string' && controlledHandle !== '',
    'MAC09-08: the official getApp result carried no app handle')
  const controlledWindows = resolveJson(listWindowsDispatch)
  return {
    inputSequence, segmentStarts, attemptMethods, attemptDispatches, getAppDispatch,
    listWindowsDispatch, showDispatch, activateDispatch, typeDispatch, attemptStateDispatch,
    previews, controlledHandle, controlledWindows, segmentFacts, typeTextSettled, observationJson,
  }
}

/**
 * Classify the settlements of the dead Client's pending CUA dispatch (MAC09-10).
 *
 * The rc.5 contract is that the request signal ends the channel with
 * `ASK_ABORTED` (client/ui-user-questions slots.ts). That terminal fact — NOT
 * the mere absence of a late answer — is what proves the abandoned Host ask is
 * no longer live, so the classifier returns the two facts separately and the
 * caller must require `aborts.length > 0`.
 *
 * @param results - every recorded result for the dead dispatch's subCallId.
 * @returns The disconnect aborts and every other (late/foreign) settlement.
 */
export function classifyDisconnectSettlements(results) {
  const codeOf = item => item.error?.code ?? dispatchErrorCode(item)
  const aborts = results.filter(item => item.isError === true && codeOf(item) === 'ASK_ABORTED')
  const late = results.filter(item => !(item.isError === true && codeOf(item) === 'ASK_ABORTED'))
  return { aborts, late }
}

// ── Direct scene ──────────────────────────────────────────────────────────

async function sceneDirect({ installation, workRoot, report, operator, helperAppPath, textEditPid, runToken }) {
  const dshHome = installation.dshHome
  let tui = startTui({ installation, workRoot, sessionName: `cua-direct-${randomUUID().slice(0, 6)}` })
  report.directTui = { session: tui }
  await waitPainted(tui, 'Direct TUI')
  await waitComposer(tui, 'Direct TUI')

  // MAC09-01: the REAL Host roster shows the official Computer use card in the
  // Experimental section on a supported (darwin) Host, with the Host's own
  // default-listing fact and no active provider rows. The hidden-by-default
  // contract belongs to the UNSUPPORTED-platform path (listedByDefault=false),
  // which the existing Host catalog owner test covers; on darwin the Host
  // reports `Host default`. Record the observed fact rather than asserting the
  // outdated plan wording.
  setCase(report, 'MAC09-01')
  await operatorGate(operator, tui, 'MAC09-01 default plugin list', 'continue mac09-01-list', [
    'Run /plugins and wait for the Settings → Plugins list. Do NOT search yet.',
    'Return here when the default list is painted.',
  ])
  let frame = tmuxCapture(tui, 'MAC09-01 default plugin list')
  assert(frame.includes('/ searches hidden official bundles'),
    'MAC09-01: the Plugin Manager did not paint its explicit hidden-bundle search route')
  const defaultListDigest = sha16(frame)
  const defaultCardVisible = frame.includes('Computer use')
  await operatorGate(operator, tui, 'MAC09-01 explicit CUA search + Details', 'continue mac09-01-search', [
    'Press "/" (the explicit hidden-bundle search), type the exact name',
    `${CUA_BUNDLE}, press Enter, select the Computer use card and press Enter`,
    'to open its Details panel. Return here when the Details facts are painted.',
  ])
  frame = await waitFrameMatching(tui, painted => painted.includes('Computer use')
    && /\[experimental\]/u.test(painted)
    && /Default listing\s+(Host default|Hidden)/u.test(painted)
    && /Installed\s+No/u.test(painted)
    && painted.includes('Selected in profile')
    && painted.includes('Not live'), 'MAC09-01 CUA Details facts')
  const listedByDefaultObserved = /Default listing\s+(Host default|Hidden)/u.exec(frame)?.[1]
  assert(listedByDefaultObserved !== undefined,
    'MAC09-01: the CUA Details did not paint the Host default-listing fact')
  pushRow(report, 'MAC09-01', 'PASS', {
    defaultListDigest,
    searchedDigest: sha16(frame),
    defaultCardVisible,
    listedByDefaultObserved,
    planExpectation: 'the untouched list hides the card via listedByDefault=false (unsupported-platform path)',
    platformSupportedFact: 'the real darwin Host reports Host default; the card is visible in Experimental',
    official: true,
    section: 'Experimental',
    selectedInProfile: false,
    providerRowsLive: false,
    crossPlatformNegative: 'covered by the existing Host catalog owner test, not by this macOS Host',
  })
  await operatorGate(operator, tui, 'MAC09-01 close Plugins', 'continue mac09-01-close', [
    'Press Esc to leave the Details panel, then Esc again to leave the Plugins',
    'page and return to the normal composer. Do not enable the bundle yet.',
  ])
  await waitComposer(tui, 'MAC09-01 composer restored')

  // MAC09-02 NEGATIVE: the bundle is still DISABLED, so the Host never mounts
  // the CUA provider/tool at all. That Host admission fact is read from the
  // real profile (official Plugin Manager selection + the mounted roster),
  // not inferred from model compliance; the completed model turn then adds the
  // bounded "no dispatch" fact on top of the absent tool.
  setCase(report, 'MAC09-02')
  assert(!verifyBundleSelected(installation.profileDir),
    'MAC09-02: the profile already selected the CUA bundle before the operator enabled it')
  const preEnableEntries = dumpProfile(installation, 'MAC09-02 before enable')
  assert(preEnableEntries.every(entry => entry?.id !== 'cua'),
    'MAC09-02: a disabled bundle still mounts the CUA provider row before enable')
  const negative = await promptAndRequireNoCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: 'Without using any tools, answer in one short sentence: which tool would you use for macOS computer control?',
    label: 'MAC09-02 non-PTC negative',
  })
  report.standardSession = { sessionId: sha16(negative.sessionId) }

  // MAC09-02 POSITIVE: the operator enables the official bundle and switches a
  // new session to the PTC preset through the real UI.
  await operatorGate(operator, tui, 'MAC09-02 enable Computer use + PTC', 'continue mac09-02-enable', [
    'In the Plugins page search for the Computer use card again and choose its',
    'Install/Enable action (use "Set to PTC" if the card offers it).',
    'Press Esc to leave the Plugins page, then run /preset default ptc (the',
    'shipped PTC preset), press Enter, and start a NEW session with /new.',
    'Return here from the composer.',
    '',
    'TCC is NOT granted yet. Do not approve any macOS system dialog at this stage.',
  ])
  assert(verifyBundleSelected(installation.profileDir),
    'MAC09-02: the official Plugin Manager did not save the CUA bundle selection in the profile')
  const composition = verifyBundleComposition(installation)
  report.cuaComposition = composition

  const capabilities = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: "Run exactly this in run_code and return only the JSON: return await tools.cua({ method: 'getCapabilities', params: {} })",
    label: 'MAC09-02 PTC cua',
    method: 'getCapabilities',
  })
  const capabilitiesResult = await waitCuaResult(dshHome, capabilities.sessionId, capabilities.dispatch.subCallId,
    'MAC09-02 cua capabilities result', TIMEOUTS.consent)
  assert(capabilitiesResult.result.isError !== true,
    `MAC09-02: the official cua tool failed: ${dispatchErrorCode(capabilitiesResult.result) ?? 'unknown error'}`)
  // MAC09-02 NEGATIVE (bundle ENABLED, non-PTC Session): after the positive PTC
  // session proved the tool is mounted, a NEW Session on the shipped non-PTC
  // preset must NOT be granted `cua`. This is the v1 required negative: the
  // bundle being enabled on the Host says nothing about the standard preset's
  // tool admission.
  await sendKeys(tui, '/preset default standard', 'MAC09-02 standard preset')
  await waitComposer(tui, 'MAC09-02 standard preset settled')
  await newSession(tui, 'MAC09-02 standard Session')
  // The negative's claim is about THIS Session's admission, so read the
  // Session's OWN preset back from the live command surface instead of trusting
  // the switch command or the static preset definition.
  await sendKeys(tui, '/preset status', 'MAC09-02 negative Session preset readback')
  const negativePresetFrame = await waitFrameText(tui, 'preset: standard',
    'MAC09-02 negative Session reports the standard preset', TIMEOUTS.mount)
  assert(!negativePresetFrame.includes('preset: ptc'),
    'MAC09-02: the negative Session is still a PTC Session; the negative proves nothing')
  const enabledNegative = await promptAndRequireNoCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: 'Without using any tools, answer in one short sentence: which tool would you use for macOS computer control?',
    label: 'MAC09-02 enabled non-PTC negative',
  })
  // The profile composes EVERY shipped agent preset, so the PTC row's own
  // presence proves nothing about the STANDARD preset: read the standard
  // preset's OWN plugin list and require it to carry no PTC executor (the only
  // path by which a Session reaches the cua tool).
  const standardPresetAfter = dumpProfile(installation, 'MAC09-02 after the standard Session')
  const presetRows = standardPresetAfter.filter(entry => entry?.name === '@deepseek-ai/dsh-agent-preset')
  const standardRow = presetRows.find(entry => entry?.config?.id === 'standard')
  assert(standardRow !== undefined, 'MAC09-02: the profile declares no standard agent preset')
  const standardPlugins = Array.isArray(standardRow?.config?.plugins) ? standardRow.config.plugins : []
  assert(standardPlugins.every(plugin => plugin?.name !== '@deepseek-ai/dsh-tool-executor-ptc'),
    'MAC09-02: the standard preset composed the PTC executor, so a non-PTC Session could reach cua')

  // The rest of the lane runs PTC Sessions: restore the shipped default so the
  // negative above cannot change later cases' admission.
  await sendKeys(tui, '/preset default ptc', 'MAC09-02 restore PTC default')
  await waitComposer(tui, 'MAC09-02 PTC default restored')
  const restored = await newSession(tui, 'MAC09-02 restore PTC Session')
  await sendKeys(tui, '/preset status', 'MAC09-02 restored Session preset readback')
  const restoredPresetFrame = await waitFrameText(tui, 'preset: ptc',
    'MAC09-02 the restored Session is a PTC Session', TIMEOUTS.mount)
  report.macos02Preset = {
    negative: sha16(negativePresetFrame),
    restored: sha16(restoredPresetFrame),
    restoredSession: sha16(restored),
  }
  pushRow(report, 'MAC09-02', 'PASS', {
    sessionId: sha16(capabilities.sessionId),
    subCallId: sha16(capabilities.dispatch.subCallId),
    dispatchMethod: dispatchMethod(capabilities.dispatch),
    nonPtcSession: sha16(negative.sessionId),
    nonPtcCuaDispatches: 0,
    enabledNonPtcSession: sha16(enabledNegative.sessionId),
    enabledNonPtcCuaDispatches: 0,
    standardPresetHasPtcExecutor: false,
    negativeSessionPreset: 'standard (live /preset status readback)',
    restoredSessionPreset: 'ptc (live /preset status readback)',
    bundle: CUA_BUNDLE,
    agentPreset: composition.agentPreset,
    negativeEvidence: 'Host: profile selection absent + mounted roster has no cua row before enable; bounded zero cua dispatch; model compliance recorded separately',
    hostAdmission: { selectionBeforeEnable: 'absent', rosterBeforeEnable: 'no cua row', selectionAfterEnable: 'present', ptcPositive: 'getCapabilities ok' },
  })

  // MAC09-03: the REAL helper reports its observed macOS permissions. The
  // operator grants Accessibility + Screen Recording in System Settings; the
  // helper is then stopped so the next operation starts it under the new TCC
  // state (macOS documents a relaunch for Screen Recording).
  setCase(report, 'MAC09-03')
  const capabilityText = dispatchContentText(capabilitiesResult.result)
  report.observedPermissions = { source: 'official cua.getCapabilities result', digest: sha16(capabilityText) }
  const grantApp = profileCuaHelper(installation.profileDir)?.appPath ?? helperAppPath
  report.helperAppPathUsed = grantApp
  await operatorGate(operator, tui, 'MAC09-03 macOS TCC grants', 'continue mac09-03-tcc', [
    'Grant BOTH permissions to the OFFICIAL helper application:',
    `  ${grantApp}`,
    'Open System Settings → Privacy & Security → Accessibility and add the app,',
    'then Privacy & Security → Screen Recording and add the same app. Confirm',
    'the macOS prompts. Do not grant anything to tmux, Terminal or this lane.',
    'Keep the Mac unlocked for the rest of the run.',
    '',
    'When both switches are ON, return here and type continue. The lane will',
    'stop the current helper so the next operation launches it with the grants.',
  ])
  const helpersBefore = ownedRoles(workRoot).helpers.filter(row => alive(row.pid))
  for (const helper of helpersBefore) {
    // The list was read a moment ago: re-prove the EXACT owned helper identity
    // (pid + kernel start time) before signalling it.
    const current = ownedRoles(workRoot).helpers
      .find(row => row.pid === helper.pid && row.started === helper.started && alive(row.pid))
    if (current === undefined) continue
    try { process.kill(current.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  for (const helper of helpersBefore) {
    try {
      await waitOwnedRoleGone(workRoot, helper.pid, helper.started, 'MAC09-03 helper restart')
    } catch {
      // Never escalate a helper pid after the wait without re-proving that the
      // CURRENT process at that pid still has this run's kernel start identity.
      const stillHelper = ownedRoles(workRoot).helpers.some(row => row.pid === helper.pid
        && row.started === helper.started && alive(row.pid))
      if (stillHelper) {
        try { process.kill(helper.pid, 'SIGKILL') } catch { /* already gone */ }
        await waitOwnedRoleGone(workRoot, helper.pid, helper.started, 'MAC09-03 helper restart')
      }
    }
  }
  // MAC09-02's enabled non-PTC negative created and left Sessions of its own, so
  // the CURRENT composer Session is the restored PTC one. Bind the TCC check to
  // THAT durable Session (resolved from the message it really produced) instead
  // of assuming the earlier capabilities Session is still on screen.
  const verified = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: "Run exactly this in run_code and return only the JSON: return await tools.cua({ method: 'getCapabilities', params: {} })",
    label: 'MAC09-03 TCC capability check',
    method: 'getCapabilities',
  })
  const verifiedResult = await waitCuaResult(dshHome, verified.sessionId, verified.dispatch.subCallId,
    'MAC09-03 TCC result', TIMEOUTS.consent)
  assert(verifiedResult.result.isError !== true,
    `MAC09-03: the TCC check failed: ${dispatchErrorCode(verifiedResult.result) ?? 'unknown error'}`)
  const verifiedText = dispatchContentText(verifiedResult.result)
  const permissionFacts = parseCapabilityPermissions(verifiedText)
  assert(permissionFacts !== undefined,
    'MAC09-03: the official capability result did not carry the macOS permission facts')
  assert(permissionFacts.accessibility === true && permissionFacts.screenRecording === true,
    `MAC09-03: the official helper reports accessibility=${String(permissionFacts.accessibility)} screenRecording=${String(permissionFacts.screenRecording)}`)
  pushRow(report, 'MAC09-03', 'PASS', {
    sessionId: sha16(verified.sessionId),
    subCallId: sha16(verified.dispatch.subCallId),
    permissions: { accessibility: permissionFacts.accessibility, screenRecording: permissionFacts.screenRecording },
    helperRestarts: helpersBefore.length,
  })

  // MAC09-04/05: the official consent Question for the controlled app, then
  // exactly one operator answer resumes the same pending dispatch.
  setCase(report, 'MAC09-04')
  const consent = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: verified.sessionId,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${String(textEditPid)}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); return JSON.stringify(windows). Do not click or type.`,
    label: 'MAC09-04 consent request',
    method: 'getApp',
  })
  assert(dispatchParams(consent.dispatch)?.selector === String(textEditPid),
    'MAC09-04: the official getApp did not select this run\'s exact TextEdit PID')
  const questionFrame = await waitFrameText(tui, 'Allow computer use', 'MAC09-04 official consent Question', TIMEOUTS.consent)
  const questionDigest = sha16(questionFrame)
  logOperator([`MAC09-04 consent Question is painted. Attach now: ${attachCommand(tui)}`,
    'Choose "Allow for this session" exactly once (Enter on the default option).'])
  setCase(report, 'MAC09-05')
  const consentResult = await waitCuaResult(dshHome, consent.sessionId, consent.dispatch.subCallId,
    'MAC09-04 consent answer resumes the exact dispatch', TIMEOUTS.consent)
  assert(consentResult.result.isError !== true,
    `MAC09-05: the approved app consent did not resume the dispatch: ${dispatchErrorCode(consentResult.result) ?? 'unknown error'}`)
  await waitFor(() => (!tmuxCapture(tui, 'MAC09-05 question closed').includes('Allow computer use') ? true : undefined),
    'MAC09-05 the consent Question leaves the seat', TIMEOUTS.mount)
  pushRow(report, 'MAC09-04', 'PASS', {
    sessionId: sha16(consent.sessionId),
    subCallId: sha16(consent.dispatch.subCallId),
    questionFrameDigest: questionDigest,
    questionApp: TEXTEDIT_BUNDLE,
    pendingDispatchObserved: true,
  })
  const consentSettlements = cuaResults(eventsOf(dshHome, consent.sessionId), 0)
    .filter(item => item.subCallId === consent.dispatch.subCallId)
  assert(consentSettlements.length === 1,
    `MAC09-05: the approved dispatch settled ${String(consentSettlements.length)} times, expected exactly one`)
  pushRow(report, 'MAC09-05', 'PASS', {
    sessionId: sha16(consent.sessionId),
    subCallId: sha16(consent.dispatch.subCallId),
    answers: 1,
    resultSettled: true,
  })
  await waitTurnEnd(dshHome, consent.sessionId, consent.afterIndex, 'MAC09-05 consent turn completed')

  // MAC09-07: the official screenshot lands in the Host Attachment Store and
  // the Client paints the image identity row (name/dimensions/bytes).
  setCase(report, 'MAC09-07')
  const screenshot = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: consent.sessionId,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${String(textEditPid)}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); const window = windows.find(item => String(item.title ?? '').includes('${runToken}')); if (!window) throw new Error('the controlled TextEdit window was not found'); const shot = await tools.cua({ method: 'screenshot', params: { appHandle: app.appHandle, windowId: window.windowId } }); return { width: shot.pixelWidth, height: shot.pixelHeight }`,
    label: 'MAC09-07 screenshot',
    method: 'screenshot',
    timeoutMs: TIMEOUTS.screenshot,
  })
  const shotEvents = eventsOf(dshHome, screenshot.sessionId)
  const shotDispatches = cuaDispatches(shotEvents, screenshot.afterIndex)
    .filter(dispatch => dispatch.rootCallId === screenshot.dispatch.rootCallId)
  const shotSequence = shotDispatches.map(dispatchMethod)
  assert(JSON.stringify(shotSequence)
    === JSON.stringify(['getApp', 'listWindows', 'screenshot']),
  `MAC09-07: the controlled root dispatched an unexpected cua method sequence: ${JSON.stringify(shotSequence)}`)
  const shotGetApp = shotDispatches.find(dispatch => dispatchMethod(dispatch) === 'getApp')
  const shotWindows = shotDispatches.find(dispatch => dispatchMethod(dispatch) === 'listWindows')
  const shotDispatch = shotDispatches.find(dispatch => dispatchMethod(dispatch) === 'screenshot')
  assert(shotGetApp !== undefined && dispatchParams(shotGetApp)?.selector === String(textEditPid),
    'MAC09-07: the official getApp did not select this run\'s exact TextEdit PID')
  const shotAppResult = cuaResults(shotEvents, 0).find(result => result.subCallId === shotGetApp?.subCallId)
  const shotAppHandle = dispatchJsonContent(shotAppResult)?.appHandle
  assert(typeof shotAppHandle === 'string' && shotAppHandle !== ''
    && dispatchParams(shotWindows)?.appHandle === shotAppHandle
    && dispatchParams(shotDispatch)?.appHandle === shotAppHandle,
    'MAC09-07: listWindows/screenshot do not use the exact approved getApp handle')
  const shotWindowId = dispatchParams(shotDispatch)?.windowId
  assert(typeof shotWindowId === 'number',
    'MAC09-07: the official screenshot did not name a concrete window')
  const windowsResult = cuaResults(shotEvents, 0).find(result => result.subCallId === shotWindows?.subCallId)
  const windows = dispatchJsonContent(windowsResult)
  const controlledWindow = Array.isArray(windows)
    ? windows.find(window => window?.windowId === shotWindowId && String(window?.title ?? '').includes(runToken))
    : undefined
  assert(controlledWindow !== undefined,
    'MAC09-07: the screenshot window is not this run\'s controlled cua-blank document')
  const screenshotResult = await waitCuaResult(dshHome, screenshot.sessionId, screenshot.dispatch.subCallId,
    'MAC09-07 official screenshot result', TIMEOUTS.screenshot)
  assert(screenshotResult.result.isError !== true,
    `MAC09-07: the official screenshot failed: ${dispatchErrorCode(screenshotResult.result) ?? 'unknown error'}`)
  const refs = [...attachmentRefs(screenshotResult.result)]
  assert(refs.length > 0, 'MAC09-07: the official screenshot result carried no durable attachment reference')
  const ref = refs[0]
  const objectPath = attachmentObjectPath(dshHome, ref)
  assert(existsSync(objectPath), `MAC09-07: the official Host Attachment object is missing: ${ref}`)
  const bytes = readFileSync(objectPath)
  assert(bytes.length > 0, 'MAC09-07: the official Host Attachment object is empty')
  const dimensions = imageDimensions(bytes)
  assert(dimensions !== undefined, 'MAC09-07: the official Host Attachment object is not a supported image')
  await expandNestedToolCard(tui, 'cua · screenshot', 'MAC09-07 screenshot result')
  // The TSP tool-result image identity line is the frozen `[IMAGE] name ·
  // W×H · bytes` row (`imageIdentityText`); `🖼️` is the DRAFT/queued
  // attachment vocabulary, never the tool-result row. Record the exact
  // expanded body: if the settled child content ever stops carrying the
  // image block, this digest is the evidence of what was really painted.
  const expandedCard = tmuxCapture(tui, 'MAC09-07 expanded screenshot card')
  const bodyStart = expandedCard.indexOf('cua · screenshot')
  const expandedBody = bodyStart < 0 ? '' : expandedCard.slice(bodyStart, bodyStart + 2000)
  report.macos07 = { expandedCardDigest: sha16(expandedBody), paintedIdentityRow: expandedBody.includes('[IMAGE]') }
  const imageFrame = await waitFrameText(tui, '[IMAGE]', 'MAC09-07 Client image identity row', TIMEOUTS.mount)
  // The identity row names the ATTACHMENT's own stored geometry; the official
  // rc.3 native screenshot returns the window pixel size and the admitted
  // ref may carry its pre-normalization originalDimensions instead. Either
  // pair proves the same attachment; both are recorded.
  const pixelPair = `${String(dimensions.width)}×${String(dimensions.height)}`
  const rowGeometry = /\[IMAGE\][^\n]*?(\d+×\d+)/u.exec(imageFrame)?.[1]
  assert(rowGeometry === pixelPair,
    `MAC09-07: the Client image row geometry ${rowGeometry ?? '<none>'} is not this screenshot attachment's stored ${pixelPair}`)
  report.macos07 = {
    ...report.macos07,
    identityRowGeometry: rowGeometry,
    windowPixelPair: pixelPair,
    geometryMatchesWindow: rowGeometry === pixelPair,
  }
  pushRow(report, 'MAC09-07', 'PASS', {
    sessionId: sha16(screenshot.sessionId),
    subCallId: sha16(screenshot.dispatch.subCallId),
    attachment: sha16(ref),
    bytes: bytes.length,
    mediaType: dimensions.mediaType,
    width: dimensions.width,
    height: dimensions.height,
    clientRowDigest: sha16(imageFrame),
  })
  await waitTurnEnd(dshHome, screenshot.sessionId, screenshot.afterIndex, 'MAC09-07 screenshot turn completed')

  // MAC09-08: one safe, bounded TextEdit input, verified through the same
  // official CUA observation (the window's accessibility tree).
  setCase(report, 'MAC09-08')
  // The scene's fact is the HOST tool behaviour (one bounded input, observed by
  // the same official call), not model obedience. A model that stops after
  // typeText without reading the tree leaves the observation unproven, so the
  // scene re-runs the SAME bounded program once with an explicit instruction and
  // records the retry. Every attempt keeps its own random marker, so the
  // identity checks below always bind the attempt that actually ran.
  // The program uses ONE API style: `tools.cua` is the raw binding whose result
  // is plain JSON (bridge.ts: CuaToolBinding -> Promise<JsonValue>), so getApp
  // returns an `appHandle`, NOT an object with methods. The object facade only
  // comes from connectCua/createCuaApi, which this scene does not use; mixing
  // them made the "exact program" throw a TypeError that the model had to repair
  // itself (a likely source of the earlier multi-attempt traces).
  // `show` restores a window WITHOUT raising or focusing it (rc.5 provider:
  // AXAccess.restoreWindow), and an app-scoped typeText goes to AXFocusedWindow.
  // The program therefore has to (1) prove the owned window is the app's focused
  // window BEFORE typing, (2) type, and (3) read the observation WINDOW-SCOPED,
  // so the marker is proven to be in the owned window and not in another
  // restored document of the same app.
  const controlledProgram = marker => `Run exactly this in run_code and DO NOT stop early — every call below must run in this one program: const app = await tools.cua({ method: 'getApp', params: { selector: '${String(textEditPid)}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); const window = windows.find(item => String(item.title ?? '').includes('${runToken}')); if (!window) throw new Error('the controlled TextEdit window was not found'); await tools.cua({ method: 'show', params: { appHandle: app.appHandle, windowId: window.windowId } }); await tools.cua({ method: 'activate', params: { appHandle: app.appHandle } }); const before = await tools.cua({ method: 'getState', params: { appHandle: app.appHandle } }); if (String(before.focusedWindowId) !== String(window.windowId)) throw new Error('the owned TextEdit window is not the focused window'); const typed = await tools.cua({ method: 'typeText', params: { appHandle: app.appHandle, text: '${marker}' } }); const after = await tools.cua({ method: 'getState', params: { appHandle: app.appHandle, windowId: window.windowId } }); return JSON.stringify(after.tree).includes('${marker}') ? 'MARKER_PRESENT' : 'MARKER_MISSING'`
  // ONE prompt and ONE bounded input: a scene that observes nothing after the
  // input must NOT re-prompt, because the first prompt may already have typed —
  // a second successful turn would erase the first, already-dispatched input and
  // make "ONE bounded input" unprovable. The observation failure is reported as
  // the case's failure instead.
  const marker = `CUA-MARKER-${randomUUID().slice(0, 8).toUpperCase()}`
  const input = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: consent.sessionId,
    prompt: controlledProgram(marker),
    label: 'MAC09-08 controlled input',
    method: 'typeText',
    timeoutMs: TIMEOUTS.turn,
  })
  // The program is only finished when the turn is: settle BEFORE reading the
  // trace, otherwise a later segment can still appear and never be audited.
  await waitTurnEnd(dshHome, input.sessionId, input.afterIndex, 'MAC09-08 controlled turn completed')
  // The audit judges the WHOLE user turn: every CUA dispatch of this turn, not
  // only the selected root call. A second root that typed would otherwise be
  // invisible while the selected root still looked controlled.
  const eventLog = eventsOf(dshHome, input.sessionId)
  const turnDispatches = cuaDispatches(eventLog, input.afterIndex)
  const trace = turnDispatches.filter(dispatch => dispatch.rootCallId === input.dispatch.rootCallId)
  // The WHOLE structural audit is one pure function (see auditControlledTrace)
  // so its real judging code is replayable; only the two async facts are
  // injected from this live scene.
  const {
    inputSequence, segmentStarts, attemptMethods, attemptDispatches, getAppDispatch,
    listWindowsDispatch, showDispatch, activateDispatch, typeDispatch, attemptStateDispatch, previews,
    observationJson,
  } = await auditControlledTrace({
    trace,
    turnDispatches,
    rootCallId: input.dispatch.rootCallId,
    textEditPid,
    runToken,
    marker,
    resolveJson: dispatch => dispatchJsonContent(
      cuaResults(eventLog, 0).find(item => item.subCallId === dispatch.subCallId)),
    resolveTypeTextResult: async dispatch => waitCuaResult(dshHome, input.sessionId, dispatch.subCallId,
      'MAC09-08 final typeText result', TIMEOUTS.turn),
  })
  // The audit above already bound the handle, the owned window, the order, the
  // result identity and the marker inside the OWNED-WINDOW observation tree; the
  // scene only needs the params it reports.
  const typeParams = dispatchParams(typeDispatch)
  pushRow(report, 'MAC09-08', 'PASS', {
    sessionId: sha16(input.sessionId),
    rootCallId: sha16(input.dispatch.rootCallId),
    method: 'typeText',
    sequence: attemptMethods,
    rootSequence: inputSequence,
    attemptSegments: segmentStarts.length,
    previewReads: previews,
    typeSubCallId: sha16(typeDispatch.subCallId),
    windowPreSteps: true,
    markerDigest: sha16(marker),
    attempts: 1,
    windowId: typeParams.windowId,
    appBound: true,
    observedInAccessibilityTree: String(observationJson?.tree ?? '').includes(marker),
    turnTypeTexts: 1,
    foreignRootSideEffects: 0,
    focusedWindowId: observationJson?.focusedWindowId,
  })

  // MAC09-06/09: another Session must ask its own consent. The operator DENIES
  // it; the tool fails closed with the official code and dispatches no input.
  setCase(report, 'MAC09-09')
  await newSession(tui, 'MAC09-09 new Session B')
  const deniedSession = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${String(textEditPid)}' } }); return app.appHandle`,
    label: 'MAC09-09 Session B consent',
    method: 'getApp',
  })
  const deniedQuestion = await waitFrameText(tui, 'Allow computer use', 'MAC09-09 Session B independent Question', TIMEOUTS.consent)
  setCase(report, 'MAC09-06')
  logOperator([`MAC09-09 Session B has its own consent Question. Attach now: ${attachCommand(tui)}`,
    'Choose "Deny" (Down, then Enter) exactly once.'])
  const deniedResult = await waitCuaResult(dshHome, deniedSession.sessionId, deniedSession.dispatch.subCallId,
    'MAC09-09 denied dispatch settles', TIMEOUTS.consent)
  assert(deniedResult.result.isError === true, 'MAC09-06: the denied application consent did not fail the dispatch')
  assert(dispatchErrorCode(deniedResult.result) === 'APP_ACCESS_DENIED',
    `MAC09-06: the denied dispatch did not carry APP_ACCESS_DENIED: ${dispatchErrorCode(deniedResult.result) ?? 'unknown'} :: ${dispatchContentText(deniedResult.result).slice(0, 400)}`)
  const afterDeny = cuaResults(eventsOf(dshHome, deniedSession.sessionId), 0)
    .filter(item => item.rootCallId === deniedSession.dispatch.rootCallId)
    .filter(item => ['typeText', 'click', 'pressKey', 'paste'].includes(dispatchMethod(item)))
  assert(afterDeny.length === 0, 'MAC09-06: a denied application still dispatched input')
  pushRow(report, 'MAC09-06', 'PASS', {
    sessionId: sha16(deniedSession.sessionId),
    subCallId: sha16(deniedSession.dispatch.subCallId),
    code: 'APP_ACCESS_DENIED',
    inputDispatches: 0,
  })
  pushRow(report, 'MAC09-09', 'PASS', {
    sessionA: sha16(consent.sessionId),
    sessionB: sha16(deniedSession.sessionId),
    independentQuestionDigest: sha16(deniedQuestion),
    sessionBDecision: 'deny',
  })
  await waitTurnEnd(dshHome, deniedSession.sessionId, deniedSession.afterIndex, 'MAC09-06 deny turn completed')

  report.directSessions = {
    primary: sha16(consent.sessionId),
    denied: sha16(deniedSession.sessionId),
    standard: sha16(negative.sessionId),
  }
  const archive = { sessionId: consent.sessionId, width: dimensions.width, height: dimensions.height }
  await closeTui(tui, 'Direct TUI')
  tui = undefined
  return { archive }
}

// ── Split scene ───────────────────────────────────────────────────────────

async function sceneSplit({ installation, workRoot, report, textEditPid, runToken }) {
  const dshHome = installation.dshHome
  const tui = startTui({ installation, workRoot, backend: 'daemon', sessionName: `cua-split-${randomUUID().slice(0, 6)}` })
  report.splitTui = { session: tui }
  await waitPainted(tui, 'Split Client')
  await waitComposer(tui, 'Split Client')
  const registry = await waitRegistry(dshHome, 'Split Host registry')
  report.splitHost = { instanceId: sha16(registry.record.instanceId), hostPid: registry.record.hostPid }

  setCase(report, 'MAC09-10')
  const capabilities = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: "Run exactly this in run_code and return only the JSON: return await tools.cua({ method: 'getCapabilities', params: {} })",
    label: 'MAC09-10 Split cua capability',
    method: 'getCapabilities',
  })
  const capabilitiesResult = await waitCuaResult(dshHome, capabilities.sessionId, capabilities.dispatch.subCallId,
    'Split cua capability result', TIMEOUTS.consent)
  assert(capabilitiesResult.result.isError !== true,
    `Split cua capability failed: ${dispatchErrorCode(capabilitiesResult.result) ?? 'unknown error'}`)
  await waitTurnEnd(dshHome, capabilities.sessionId, capabilities.afterIndex, 'Split capability turn completed')

  const screenshot = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: capabilities.sessionId,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${String(textEditPid)}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); const window = windows.find(item => String(item.title ?? '').includes('${runToken}')); if (!window) throw new Error('the controlled TextEdit window was not found'); const shot = await tools.cua({ method: 'screenshot', params: { appHandle: app.appHandle, windowId: window.windowId } }); return { width: shot.pixelWidth, height: shot.pixelHeight }`,
    label: 'MAC09-10 Split screenshot selection',
    method: 'getApp',
    timeoutMs: TIMEOUTS.turn,
  })
  const splitQuestion = await waitFrameText(tui, 'Allow computer use', 'Split Client consent Question', TIMEOUTS.consent)
  logOperator([`Split Session consent Question is painted. Attach now: ${attachCommand(tui)}`,
    'Choose "Allow for this session" exactly once. This is the Split Host/Client path.'])
  // Runs 11-13: the answer landed AFTER the ask had aborted (ASK_ABORTED on
  // the pending dispatch) even though the frame painted the Question seconds
  // earlier. The submit is gated on the CURRENT frame still owning the
  // Question review/answer state: select only on a painted option row, and
  // submit only on a painted Submit row, re-reading the frame between keys.
  await answerApprovalQuestion(tui, 'Allow for this session', 'Split consent answer')
  // The answer has been submitted through the painted states; only the settled
  // dispatch or the consent budget may end this wait. (The earlier seat-
  // liveness poll fired AFTER a successful submit: the review seat and the
  // transcript legitimately stop painting 'Allow computer use'.)
  const deadline = Date.now() + TIMEOUTS.consent
  let splitConsent
  while (true) {
    const events = eventsOf(dshHome, screenshot.sessionId)
    const settled = cuaResults(events, 0).find(item => item.subCallId === screenshot.dispatch.subCallId)
    if (settled !== undefined) { splitConsent = { result: settled, events }; break }
    if (Date.now() > deadline) {
      throw new SplitSmokeAssertionError('Split consent: the dispatch never settled within the consent budget')
    }
    await sleep(1_000)
  }
  assert(splitConsent.result.isError !== true,
    `Split consent failed: ${dispatchErrorCode(splitConsent.result) ?? 'unknown error'} :: ${dispatchContentText(splitConsent.result).slice(0, 400)}`)
  assert(dispatchParams(screenshot.dispatch)?.selector === String(textEditPid),
    'Split MAC09-10: the official getApp did not select this run\'s exact TextEdit PID')
  const splitShot = await waitFor(() => cuaDispatches(eventsOf(dshHome, screenshot.sessionId), screenshot.afterIndex)
    .filter(dispatch => dispatch.rootCallId === screenshot.dispatch.rootCallId)
    .find(candidate => dispatchMethod(candidate) === 'screenshot'), 'Split official screenshot dispatch', TIMEOUTS.screenshot)
  const splitShotResult = await waitCuaResult(dshHome, screenshot.sessionId, splitShot.subCallId,
    'Split screenshot result', TIMEOUTS.screenshot)
  assert(splitShotResult.result.isError !== true,
    `Split screenshot failed: ${dispatchErrorCode(splitShotResult.result) ?? 'unknown error'}`)
  const splitEvents = eventsOf(dshHome, screenshot.sessionId)
  const splitDispatches = cuaDispatches(splitEvents, screenshot.afterIndex)
    .filter(dispatch => dispatch.rootCallId === screenshot.dispatch.rootCallId)
  assert(JSON.stringify(splitDispatches.map(dispatchMethod))
    === JSON.stringify(['getApp', 'listWindows', 'screenshot']),
  'Split MAC09-10: the controlled root dispatched an unexpected cua method sequence')
  const splitGetApp = splitDispatches.find(dispatch => dispatchMethod(dispatch) === 'getApp')
  const splitWindowsDispatch = splitDispatches.find(dispatch => dispatchMethod(dispatch) === 'listWindows')
  const splitAppResult = cuaResults(splitEvents, 0).find(result => result.subCallId === splitGetApp?.subCallId)
  const splitAppHandle = dispatchJsonContent(splitAppResult)?.appHandle
  assert(typeof splitAppHandle === 'string' && splitAppHandle !== ''
    && dispatchParams(splitShot)?.appHandle === splitAppHandle
    && dispatchParams(splitWindowsDispatch)?.appHandle === splitAppHandle,
    'Split MAC09-10: listWindows/screenshot do not use the approved getApp handle')
  const splitWindowId = dispatchParams(splitShot)?.windowId
  const splitWindowsResult = cuaResults(splitEvents, 0)
    .find(result => result.subCallId === splitWindowsDispatch?.subCallId)
  const splitWindows = dispatchJsonContent(splitWindowsResult)
  assert(typeof splitWindowId === 'number' && Array.isArray(splitWindows)
    && splitWindows.some(window => window?.windowId === splitWindowId
      && String(window?.title ?? '').includes(runToken)),
  'Split MAC09-10: the screenshot window is not this run\'s controlled cua-blank document')
  const splitRefs = [...attachmentRefs(splitShotResult.result)]
  assert(splitRefs.length > 0, 'Split screenshot carried no durable attachment reference')
  const splitDimensions = imageDimensions(readFileSync(attachmentObjectPath(dshHome, splitRefs[0])))
  assert(splitDimensions !== undefined, 'Split screenshot attachment is not a supported image')
  // The direct scene proved the real identity row vocabulary: the expanded
  // nested cua screenshot card paints the frozen '[IMAGE] name · W×H · bytes'
  // row (imageIdentityText), not the draft-only emoji. The Split Client uses
  // the SAME projection; expand its card and wait for the same row.
  await expandNestedToolCard(tui, 'cua · screenshot', 'Split screenshot card')
  const splitImageFrame = await waitFrameText(tui, '[IMAGE]', 'Split Client image identity row', TIMEOUTS.mount)
  assert(splitImageFrame.includes(`${String(splitDimensions.width)}×${String(splitDimensions.height)}`),
    'Split Client image row does not name the admitted screenshot dimensions')
  await waitTurnEnd(dshHome, screenshot.sessionId, screenshot.afterIndex, 'Split screenshot turn completed')

  // MAC09-10: a fresh Session asks its own consent; the Client exits while the
  // Question is pending. A new Client on the same Session must paint no stale
  // Question and the old dispatch must never settle with a late answer.
  await newSession(tui, 'MAC09-10 new Session')
  const reconnect = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${String(textEditPid)}' } }); return app.appHandle`,
    label: 'MAC09-10 pending consent',
    method: 'getApp',
  })
  await waitFrameText(tui, 'Allow computer use', 'MAC09-10 pending consent Question', TIMEOUTS.consent)
  const clientRows = ownedRoles(workRoot).clients.filter(row => alive(row.pid))
  assert(clientRows.length === 1, `MAC09-10: expected one owned Split Client, saw ${String(clientRows.length)}`)
  const clientPid = clientRows[0].pid
  const clientStarted = clientRows[0].started
  assert(clientPid !== registry.record.hostPid,
    `MAC09-10: the Split Client pid ${String(clientPid)} equals the Host pid ${String(registry.record.hostPid)}`)
  logOperator([`MAC09-10 is killing the Split Client pid ${String(clientPid)} while the Question is pending.`,
    'Do NOT answer it. A new Client will reopen the same Session.'])
  // Re-prove the EXACT owned Client identity immediately before the signal: a
  // reused pid with another start time must never be terminated.
  const currentClient = ownedRoles(workRoot).clients
    .find(row => row.pid === clientPid && row.started === clientStarted)
  assert(currentClient !== undefined,
    'MAC09-10: the owned Split Client identity changed before the signal; refusing to kill')
  try { process.kill(clientPid, 'SIGTERM') } catch { /* already gone */ }
  await waitOwnedRoleGone(workRoot, clientPid, clientStarted, 'MAC09-10 old Split Client')
  if (tmuxSessionExists(tui)) tmux(['kill-session', '-t', tui], 'MAC09-10 remove old Client pane', { allowMissing: true })

  const resumed = startTui({
    installation,
    workRoot,
    backend: 'daemon',
    sessionName: `cua-split-resume-${randomUUID().slice(0, 6)}`,
    args: ['--session', reconnect.sessionId],
  })
  report.splitResume = { session: resumed }
  await waitPainted(resumed, 'MAC09-10 resumed Client')
  await waitComposer(resumed, 'MAC09-10 resumed Client')
  await waitFor(() => {
    const frameText = tmuxCapture(resumed, 'MAC09-10 resumed Session transcript')
    return frameText.includes('Allow computer use') ? undefined : true
  }, 'MAC09-10 the resumed Client paints no stale consent Question', TIMEOUTS.mount)
  const staleFrame = tmuxCapture(resumed, 'MAC09-10 resumed frame')
  assert(!staleFrame.includes('Allow computer use'),
    'MAC09-10: the resumed Client repainted a stale consent Question from the dead Client')
  await sleep(2_000)
  // The official remote classifies a Client disconnect by ABORTING the turn's
  // foreground ask (ASK_ABORTED, recorded with the real run evidence). That is
  // the fail-closed disconnect outcome, NOT a late answer: the claim under test
  // is that the dead Client's dispatch is never settled by an ANSWER, and that
  // the resumed Client neither repaints the Question nor answers it.
  // The official disconnect classification is carried by the structured error
  // envelope (`error.code`), not by the model-facing sentence (whose message
  // text does not repeat the uppercase code).
  const settleCode = item => item.error?.code ?? dispatchErrorCode(item)
  const staleOf = () => classifyDisconnectSettlements(
    cuaResults(eventsOf(dshHome, reconnect.sessionId), 0)
      .filter(item => item.subCallId === reconnect.dispatch.subCallId))
  // ABSENCE OF A LATE ANSWER IS NOT PROOF THAT THE OLD ASK RETIRED. The rc.5
  // contract is that the request signal ends the channel with ASK_ABORTED
  // (packages/client/ui-user-questions .../slots.ts): that terminal fact — not
  // "nothing arrived for two seconds" — is what shows the abandoned Host ask is
  // no longer live. Wait for it boundedly; if it never appears the case is
  // NOT_VERIFIED with that exact missing fact, never PASS.
  let disconnectSettles = []
  try {
    disconnectSettles = await waitFor(() => {
      const aborted = staleOf().aborts
      return aborted.length > 0 ? aborted : undefined
    }, 'MAC09-10 the official disconnect terminal (ASK_ABORTED) for the dead dispatch', TIMEOUTS.consent)
  } catch {
    const observed = staleOf().late.concat(staleOf().aborts)
    throw new CuaNotVerifiedError(
      `MAC09-10: the abandoned consent ask has no authoritative terminal outcome — ${observed.length === 0 ? 'the dead Client\'s dispatch never settled at all' : `it settled ${JSON.stringify(observed.map(item => settleCode(item) ?? 'no-code'))}`}; "no late answer" does not prove the old ask retired`)
  }
  const lateAnswers = staleOf().late
  assert(lateAnswers.length === 0,
    `MAC09-10: the dead Client's dispatch settled by something other than the official disconnect abort: ${
      JSON.stringify(lateAnswers.map(item => ({
        isError: item.isError,
        error: item.error === undefined ? undefined : String(JSON.stringify(item.error)).slice(0, 240),
        text: dispatchContentText({ content: item.content }).slice(0, 240),
      })))}`)
  pushRow(report, 'MAC09-10', 'PASS', {
    sessionId: sha16(reconnect.sessionId),
    disconnectAbort: disconnectSettles.length > 0,
    lateAnswerSettles: lateAnswers.length,
    subCallId: sha16(reconnect.dispatch.subCallId),
    oldClientPid: clientPid,
    oldHostPid: registry.record.hostPid,
    resumedClientPid: ownedRoles(workRoot).clients.filter(row => alive(row.pid))[0]?.pid,
    staleQuestionPainted: false,
    lateDispatchResults: 0,
    splitHost: sha16(registry.record.instanceId),
    splitScreenshot: sha16(splitRefs[0]),
    splitImageWidth: splitDimensions.width,
    splitImageHeight: splitDimensions.height,
    splitConsentQuestionDigest: sha16(splitQuestion),
  })
  report.splitClient = { session: resumed }
  return resumed
}

// ── registry / cleanup ─────────────────────────────────────────────────────

function readRegistry(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return undefined
  const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (entries.length === 0) return undefined
  const path = join(root, entries[0].name, 'instance.json')
  if (!existsSync(path)) return undefined
  try {
    return { path, record: JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return undefined
  }
}

async function waitRegistry(dshHome, label) {
  return await waitFor(() => readRegistry(dshHome), label, TIMEOUTS.daemon)
}

async function cleanup({ workRoot, dshHome, report, textEdit, helperAppPath }) {
  const errors = []
  // 1. The private tmux server owns only this run's panes.
  const kill = tmux(['kill-server'], 'cleanup tmux server', { allowMissing: true })
  if (kill.status !== 0 && !/no server running|no sessions|error connecting/u.test(`${kill.stderr ?? ''}`)) {
    errors.push(`tmux kill-server exited ${String(kill.status)}`)
  }
  // 2. The controlled test application instance this run started (tracked pid,
  //    never a name-based pkill).
  errors.push(...await stopBlankTextEdit(textEdit))
  // 3. Every process whose command line names THIS work root: the published
  //    Host, Clients, the supervisor and the official helper app.
  const registry = readRegistry(dshHome)
  const owned = ownedProcessRows(workRoot).filter(row => roleOf(row) !== undefined)
  const registryHost = registry?.record?.hostPid === undefined
    ? undefined
    : owned.find(row => row.pid === registry.record.hostPid && roleOf(row) === 'host')
  const targets = [
    ...(registryHost === undefined ? [] : [{ pid: registryHost.pid, command: registryHost.command, started: registryHost.started }]),
    ...owned.filter(row => alive(row.pid)).map(row => ({ pid: row.pid, command: row.command, started: row.started })),
  ]
  // Re-read the work-root ownership before EVERY signal: pid plus kernel start
  // time plus the owned command/role. A reused pid has a different start time
  // and is left untouched.
  const currentOwnedTarget = (target) => ownedProcessRows(workRoot)
    .find(row => row.pid === target.pid && row.command === target.command
      && row.started === target.started && roleOf(row) !== undefined)
  for (const target of targets) {
    if (currentOwnedTarget(target) === undefined) continue
    try { process.kill(target.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (targets.every(target => currentOwnedTarget(target) === undefined || !alive(target.pid))) break
    await sleep(120)
  }
  for (const target of targets) {
    if (currentOwnedTarget(target) === undefined || !alive(target.pid)) continue
    try { process.kill(target.pid, 'SIGKILL') } catch { /* gone */ }
  }
  await sleep(250)
  const survivors = targets.filter(target => currentOwnedTarget(target) !== undefined && alive(target.pid))
  if (survivors.length > 0) {
    report.notQuiesced = { survivors: survivors.map(target => target.pid) }
    errors.push(`NOT_QUIESCED: ${String(survivors.length)} owned process(es) survived cleanup`)
    return errors
  }
  // 4. The official native helper's /tmp socket is provider-owned and SHARED by
  //    every profile using the same uid and helper digest. Its path shape and
  //    mode cannot prove THIS run created it, so the lane must never unlink it:
  //    doing so can tear down another profile's live helper endpoint. The
  //    official provider owns its socket lifecycle; the lane only reclaims the
  //    processes/work root it actually started.
  // 5. This run's account-home Host seat, only when the registry named it.
  if (registry?.record?.scopeId !== undefined) {
    const seatDir = join(ACCOUNT_RUN_ROOT, registry.record.scopeId)
    if (dirname(seatDir) !== ACCOUNT_RUN_ROOT) {
      errors.push(`refusing to remove an unexpected global seat directory: ${seatDir}`)
    } else {
      try { rmSync(seatDir, { recursive: true, force: true }) } catch (error) {
        errors.push(`global seat directory removal failed: ${boundedError(error)}`)
      }
    }
  }
  // 6. The disposable work root, after every owned process is gone.
  if (!KEEP) {
    try { rmSync(workRoot, { recursive: true, force: true }) } catch (error) {
      errors.push(`work root removal failed: ${boundedError(error)}`)
    }
  } else {
    report.keptWorkRoot = workRoot
  }
  return errors
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.help === true) {
    process.stdout.write(`${HELP_TEXT}\n`)
    return
  }
  // The packaged INPUT is qualified before any host-level prerequisite: an
  // invalid tarball must be refused before a Host, helper, tmux server or even
  // the macOS account preflight can have a side effect. The input policy test
  // (test/tooling/macos-cua-parity.test.mjs) depends on this ordering.
  let candidate
  try {
    candidate = inspectSplitCandidate(args.candidate)
  } catch (error) {
    throw new CuaInputError(`the candidate tarball was refused: ${boundedError(error)}`)
  }
  const preflight = preflightEnvironment()
  const patchPath = requireOperatorFile('MACOS_CUA_PROFILE_PATCH', 'the operator model-route user-layer patch')
  const credentialsPath = requireOperatorFile('MACOS_CUA_CREDENTIALS', 'the operator credentials YAML')
  let parsedPatch
  try {
    parsedPatch = parseYaml(readFileSync(patchPath, 'utf8'))
  } catch (error) {
    throw new CuaInputError(`MACOS_CUA_PROFILE_PATCH is not valid YAML: ${boundedError(error)}`)
  }
  if (!Array.isArray(parsedPatch) || parsedPatch.length === 0) {
    throw new CuaInputError('MACOS_CUA_PROFILE_PATCH must be a non-empty YAML array of loader patch entries')
  }
  let parsedCredentials
  try {
    parsedCredentials = parseYaml(readFileSync(credentialsPath, 'utf8'))
  } catch (error) {
    throw new CuaInputError(`MACOS_CUA_CREDENTIALS is not valid YAML: ${boundedError(error)}`)
  }
  if (parsedCredentials?.refs === undefined || typeof parsedCredentials.refs !== 'object') {
    throw new CuaInputError('MACOS_CUA_CREDENTIALS must declare a refs mapping')
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-macos-cua-'))
  let installation
  let report
  let textEdit
  let operator
  let cleanupErrors = []
  let fatal
  let helperAppPath
  try {
    installation = createSplitSmokeProfile({
      tarball: candidate.tarball,
      targetDshVersion: candidate.targetDshVersion,
      workDir: workRoot,
    })
    // The operator credentials and model route are the only real secrets the
    // isolated profile sees; both are copied private and never printed.
    copyFileSync(credentialsPath, join(installation.dshHome, '.credentials.yaml'))
    chmodSync(join(installation.dshHome, '.credentials.yaml'), 0o600)
    applyOperatorPatch(installation.profileDir, patchPath)

    const version = spawnSync(installation.dshInvocation[0], [...installation.dshInvocation.slice(1), '--version'], {
      cwd: installation.harnessDir,
      env: installation.env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert(version.status === 0 && version.stdout.trim() === candidate.targetDshVersion,
      `the isolated DSH version is ${JSON.stringify(version.stdout?.trim())}, expected ${candidate.targetDshVersion}`)
    const distribution = verifyDistribution(installation, candidate.targetDshVersion)
    helperAppPath = distribution.helperAppPath
    const model = verifyModelRoute(installation)
    verifyCredentialReference(installation.dshHome, model.apiKeyEnv)

    report = makeReport({ candidate, preflight, installation, model, helper: distribution })
    operator = createOperatorConsole()
    textEdit = await openBlankTextEdit(workRoot)
    report.textEdit = { pid: textEdit.pid, file: textEdit.file, runToken: textEdit.runToken }

    const directScene = await sceneDirect({ installation, workRoot, report, operator, helperAppPath, textEditPid: textEdit.pid, runToken: textEdit.runToken })
    const splitTui = await sceneSplit({ installation, workRoot, report, textEditPid: textEdit.pid, runToken: textEdit.runToken })

    // MAC09-11: the operator disables the bundle through the real Plugin
    // Manager; the tool is withdrawn, but the OS TCC entry and the durable
    // consent storage remain untouched.
    setCase(report, 'MAC09-11')
    // Captured IMMUTABLY before the operator disables the bundle: the provider
    // rewrites its own state file during shutdown, so a late re-read of the same
    // path would silently compare the new file with itself.
    const quiesced = await quiesceConsentDecisions(installation, splitTui, 'MAC09-11')
    const storageBefore = quiesced.snapshot
    report.macos11Quiesce = { deniedAsks: quiesced.deniedAsks }
    assert(storageBefore.some(entry => Object.keys(entry.applications).length > 0),
      'MAC09-11: the durable CUA consent store carries no application decision to protect (positive control)')
    await operatorGate(operator, splitTui, 'MAC09-11 disable Computer use', 'continue mac09-11-disable', [
      'Open /plugins, search the Computer use card, open its Details and choose',
      'Disable. Wait until the card reports disabled. Then start a NEW session',
      'with /new and return here from the composer.',
      'Do not touch macOS System Settings and do not revoke any app grant.',
    ])
    assert(!verifyBundleSelected(installation.profileDir),
      'MAC09-11: the official Plugin Manager did not remove the CUA bundle selection')
    const disabledEntries = dumpProfile(installation, 'MAC09-11 disabled profile')
    assert(disabledEntries.every(entry => entry?.id !== 'cua'),
      'MAC09-11: the disabled bundle still mounts the CUA provider row')
    const noTool = await promptAndRequireNoCua({
      tui: splitTui,
      dshHome: installation.dshHome,
      sessionId: undefined,
      prompt: 'Without using any tools, answer in one short sentence: can you control macOS applications right now?',
      label: 'MAC09-11 disabled cua negative',
    })
    const storageAfter = permissionStoreSnapshot(installation.dshHome)
    // The contract is that the durable DECISIONS survive disabling the bundle.
    // `storageBefore` is the immutable snapshot taken BEFORE the disable, so
    // this comparison is real; the raw digests stay in the report, and a byte
    // drift (none measured on a quiescent store) is visible rather than hidden.
    const decisionsOf = entries => entries.map(entry => ({ name: entry.name, applications: entry.applications }))
    report.permissionStorage = {
      before: storageBefore.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
      after: storageAfter.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })),
      byteDrift: storageBefore.map(entry => entry.sha256).join(',') !== storageAfter.map(entry => entry.sha256).join(',')
        ? storageBefore.map((entry, index) => ({ name: entry.name, before: entry.sha256, after: storageAfter[index]?.sha256 }))
        : false,
      decisionsBefore: decisionsOf(storageBefore),
      decisionsAfter: decisionsOf(storageAfter),
    }
    report.permissionStorage.decisionsEqual = JSON.stringify(report.permissionStorage.decisionsBefore)
      === JSON.stringify(report.permissionStorage.decisionsAfter)
    assert(JSON.stringify(storageBefore.map(entry => entry.name))
      === JSON.stringify(storageAfter.map(entry => entry.name)),
    'MAC09-11: disabling the bundle changed the durable CUA consent storage files')
    assert(report.permissionStorage.decisionsEqual,
      `MAC09-11: disabling the bundle changed the durable CUA consent decisions: ${
        JSON.stringify(report.permissionStorage.decisionsBefore).slice(0, 600)} -> ${
        JSON.stringify(report.permissionStorage.decisionsAfter).slice(0, 600)}`)
    const profileHelper = profileCuaHelper(installation.profileDir)
    assert(profileHelper !== undefined && existsSync(profileHelper.appPath),
      'MAC09-11: disabling the bundle removed the official helper application')
    const archiveTui = startTui({
      installation,
      workRoot,
      sessionName: `cua-archive-${randomUUID().slice(0, 6)}`,
      args: ['--session', directScene.archive.sessionId],
    })
    await waitPainted(archiveTui, 'MAC09-11 archived Session')
    await waitComposer(archiveTui, 'MAC09-11 archived Session')
    // The archived Session is the DIRECT one: its nested `cua · screenshot`
    // card is the SAME TSP projection whose per-card disclosure is the mouse
    // click. Page the transcript until that card is painted, expand it, then
    // require the frozen '[IMAGE] … W×H' row — the attachment and its row must
    // stay viewable while the bundle itself is disabled.
    let archiveFrame = ''
    let archiveVisible = false
    let archiveExpanded = false
    for (let page = 0; page < 24 && !archiveVisible; page += 1) {
      archiveFrame = tmuxCapture(archiveTui, 'MAC09-11 archived Session frame')
      if (!archiveExpanded && archiveFrame.includes('cua · screenshot')) {
        await expandNestedToolCard(archiveTui, 'cua · screenshot', 'MAC09-11 archived screenshot card')
        archiveExpanded = true
        archiveFrame = tmuxCapture(archiveTui, 'MAC09-11 archived Session frame')
      }
      archiveVisible = archiveFrame.includes('[IMAGE]')
        && archiveFrame.includes(`${String(directScene.archive.width)}×${String(directScene.archive.height)}`)
      if (!archiveVisible) {
        sendNamedKey(archiveTui, 'PageUp', 'MAC09-11 archive page')
        await sleep(250)
      }
    }
    assert(archiveVisible, 'MAC09-11: the archived Session image row is not viewable after disabling the bundle')
    await closeTui(archiveTui, 'MAC09-11 archived TUI')
    pushRow(report, 'MAC09-11', 'PASS', {
      bundleSelected: false,
      providerRowMounted: false,
      disabledSession: sha16(noTool.sessionId),
      cuaDispatches: 0,
      helperOnDisk: true,
      tccEntriesRemoved: 0,
      permissionStorageUnchanged: true,
      previousSessionVisible: true,
      archiveSession: sha16(directScene.archive.sessionId),
      archiveFrameDigest: sha16(archiveFrame),
    })
    report.status = 'PASS'
  } catch (error) {
    fatal = error
    if (report === undefined) throw error
    recordCaseFailure(report, report.activeCase ?? 'PREFLIGHT', error)
  } finally {
    operator?.close()
    if (installation !== undefined && report !== undefined) {
      cleanupErrors = await cleanup({ workRoot, dshHome: installation.dshHome, report, textEdit, helperAppPath })
      report.cleanup = cleanupErrors.length === 0 ? 'QUIESCED' : 'FAILED'
      const cleanupRow = findRow(report, 'MAC09-12')
      if (cleanupErrors.length > 0) {
        if (cleanupRow === undefined) {
          pushRow(report, 'MAC09-12', 'FAIL', { cleanup: 'FAILED' }, cleanupErrors.join('; '))
        } else {
          cleanupRow.status = 'FAIL'
          cleanupRow.detail = { cleanup: 'FAILED' }
          cleanupRow.reason = cleanupErrors.join('; ')
        }
      } else if (cleanupRow === undefined || cleanupRow.reason === 'not reached because an earlier case stopped the scene') {
        const row = cleanupRow ?? pushRow(report, 'MAC09-12', 'PASS', { cleanup: 'QUIESCED' })
        row.status = 'PASS'
        row.detail = {
          cleanup: 'QUIESCED',
          ownedProcessesReclaimed: report.notQuiesced === undefined,
          workRootRemoved: !KEEP,
        }
        row.reason = undefined
      }
    } else if (!KEEP) {
      try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* setup never completed */ }
    }
  }
  if (report === undefined) return
  fillUnreachedCases(report)
  report.rows.sort((left, right) => REQUIRED_CASES.indexOf(left.case) - REQUIRED_CASES.indexOf(right.case))
  const failing = report.rows.some(row => row.status === 'FAIL' || row.status === 'BLOCKED_ENV')
  const unverified = report.rows.some(row => row.status === 'NOT_VERIFIED')
  report.status = failing ? 'FAIL' : unverified ? 'NOT_VERIFIED' : report.cleanup === 'QUIESCED' ? 'PASS' : 'FAIL'
  report.supportVerdict = report.status
  const evidenceDir = process.env.MACOS_CUA_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'dsh-macos-cua-evidence-'))
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const evidencePath = join(evidenceDir, `macos-cua-parity-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
  if (!writePrivateReport(evidencePath, report)) {
    throw new CuaNotVerifiedError(`the private CUA evidence report could not be written: ${evidencePath}`)
  }
  report.evidencePath = evidencePath
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.status !== 'PASS') {
    process.stderr.write(`${HEADING}: ${report.status} ${fatal === undefined ? 'not all required cases were verified' : boundedError(fatal)}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write('MACOS_CUA_PARITY: PASS\n')
}

try {
  // Importing this module must not start a qualification: the trace audit is
  // replayed directly by test/tooling/macos-cua-trace-audit.test.mjs.
  if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main()
  }
} catch (error) {
  const kind = error instanceof CuaInputError
    ? 'INPUT_UNQUALIFIED'
    : error instanceof CuaNotVerifiedError
      ? 'NOT_VERIFIED'
      : 'FAIL'
  process.stderr.write(`${HEADING}: ${kind} ${boundedError(error)}\n`)
  process.exitCode = 1
}
