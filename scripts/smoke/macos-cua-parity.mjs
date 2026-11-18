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
const HELPER_EXECUTABLE = join('Contents', 'MacOS', 'dsh-cua-native')

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
  if (manager.status !== 0 || manager.stdout.trim() !== 'Aqua') {
    throw new CuaNotVerifiedError(`a real Aqua GUI login session is required, launchctl managername reported ${JSON.stringify(manager.stdout?.trim() ?? '')}`)
  }
  const tmux = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 10_000 })
  if (tmux.status !== 0) throw new CuaNotVerifiedError('tmux is required for the private terminal scene')
  if (!existsSync('/System/Applications/TextEdit.app')) {
    throw new CuaNotVerifiedError('the controlled test application /System/Applications/TextEdit.app is missing')
  }
  return { account: account.stdout.trim(), tmux: tmux.stdout.trim() }
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
  return await waitFrameText(session, 'type a message', `${label} composer ready`, TIMEOUTS.mount)
}

async function waitSessionExit(session, label) {
  await waitFor(() => (!tmuxSessionExists(session) ? true : undefined), label, TIMEOUTS.exit)
}

// ── process table / ownership ──────────────────────────────────────────────

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

async function waitOwnedRoleGone(workRoot, pid, label) {
  await waitFor(() => (!alive(pid) ? true : undefined), `${label} pid ${String(pid)} is gone`, TIMEOUTS.process)
  const stillOwned = ownedProcessRows(workRoot).find(row => row.pid === pid)
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
    async gate(stage, instructions, timeoutMs = OPERATOR_GATE_TIMEOUT_MS) {
      if (closed) throw new CuaOperatorTimeoutError('the operator console is closed')
      process.stderr.write(`\n[MACOS_CUA operator] ${stage}\n${instructions}\n[MACOS_CUA operator] type "continue" + Enter in this terminal when done.\n`)
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
      if (next.value.trim() !== 'continue') {
        throw new CuaOperatorTimeoutError(`operator action "${stage}" was not confirmed with "continue"`)
      }
    },
  }
}

async function operatorGate(operator, tui, stage, lines, timeoutMs) {
  return await operator.gate(stage, [`TUI attach command: ${attachCommand(tui)}`, '', ...lines].join('\n'), timeoutMs)
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

function verifyHelperReceipt(helper, targetDshVersion) {
  assert(helper.receipt.version === targetDshVersion,
    `the CUA helper receipt version ${JSON.stringify(helper.receipt.version)} != the pinned DSH ${targetDshVersion}`)
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
  const receipt = verifyHelperReceipt(helper, targetDshVersion)
  return { dshPackage, bundlePackage, macosPackage, helperAppPath: helper.appPath, receipt }
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

function permissionStoreFingerprint(dshHome) {
  const directory = join(dshHome, 'storages')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(name => /^cua_permissions_.*\.json$/u.test(name))
    .sort()
    .map(name => {
      const path = join(directory, name)
      return { name, sha256: sha256File(path), bytes: statSync(path).size }
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

function dispatchErrorCode(result) {
  const text = JSON.stringify(result?.content ?? result ?? '')
  const match = /"code"\s*:\s*"([A-Z0-9_]+)"/u.exec(text)
  return match?.[1]
}

function dispatchContentText(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
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
  const file = join(directory, 'cua-blank.txt')
  writeFileSync(file, '', { mode: 0o600 })
  const before = new Set(textEditPids())
  const opened = spawnSync('open', ['-na', 'TextEdit', file], { encoding: 'utf8', timeout: 30_000 })
  assert(opened.status === 0, `the controlled TextEdit document could not be opened: ${(opened.stderr ?? '').slice(-500)}`)
  const pid = await waitFor(() => {
    const created = textEditPids().filter(candidate => !before.has(candidate))
    return created.length === 1 ? created[0] : undefined
  }, 'ONE new TextEdit instance for the qualification', TIMEOUTS.process)
  return { file, pid, before: [...before] }
}

function processIsTextEdit(pid) {
  const row = processTable().find(candidate => candidate.pid === pid)
  return row !== undefined && /(?:^|\/)TextEdit(?:\s|$)/u.test(row.command.trim())
}

async function stopBlankTextEdit(textEdit) {
  if (textEdit === undefined) return []
  const errors = []
  if (alive(textEdit.pid) && !processIsTextEdit(textEdit.pid)) {
    errors.push(`the qualification TextEdit pid ${String(textEdit.pid)} no longer names TextEdit; refusing to signal it`)
    return errors
  }
  if (alive(textEdit.pid)) {
    try { process.kill(textEdit.pid, 'SIGTERM') } catch { /* already gone */ }
    try {
      await waitFor(() => (!alive(textEdit.pid) ? true : undefined), 'the qualification TextEdit instance stops', 15_000)
    } catch {
      try { process.kill(textEdit.pid, 'SIGKILL') } catch { /* already gone */ }
      try {
        await waitFor(() => (!alive(textEdit.pid) ? true : undefined), 'the qualification TextEdit instance is reaped', 10_000)
      } catch {
        errors.push(`the qualification TextEdit pid ${String(textEdit.pid)} survived cleanup`)
      }
    }
  }
  return errors
}

// ── report / case bookkeeping ──────────────────────────────────────────────

function makeReport({ candidate, preflight, installation, model, helper }) {
  return {
    schemaVersion: 1,
    lane: LANE,
    status: 'FAIL',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    macos: macosProductVersion(),
    account: { name: preflight.account, guiSession: 'Aqua', tmux: preflight.tmux },
    candidate: {
      path: resolve(candidate.tarball),
      sha256: candidate.candidateSha256,
      version: candidate.manifest.version,
      dshPin: candidate.targetDshVersion,
    },
    isolatedProfile: {
      dshHome: installation.dshHome,
      profileDir: installation.profileDir,
      dshVersion: candidate.targetDshVersion,
      helper: helper.receipt,
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

// ── Direct scene ──────────────────────────────────────────────────────────

async function sceneDirect({ installation, workRoot, report, operator, helperAppPath }) {
  const dshHome = installation.dshHome
  let tui = startTui({ installation, workRoot, sessionName: `cua-direct-${randomUUID().slice(0, 6)}` })
  report.directTui = { session: tui }
  await waitPainted(tui, 'Direct TUI')
  await waitComposer(tui, 'Direct TUI')

  // MAC09-01: the default list hides the official Experimental bundle; the
  // explicit search reads it. Both facts are captured from the REAL Host's
  // Plugin Manager page in the private TUI.
  setCase(report, 'MAC09-01')
  await operatorGate(operator, tui, 'MAC09-01 default plugin list', [
    'Run /plugins and wait for the Settings → Plugins list. Do NOT search yet.',
    'Return here when the default list is painted.',
  ])
  let frame = tmuxCapture(tui, 'MAC09-01 default plugin list')
  assert(!frame.includes('Computer use'),
    `MAC09-01: the CUA card must be hidden from the default plugin list (frame sha256=${sha16(frame)})`)
  assert(frame.includes('/ searches hidden official bundles'),
    'MAC09-01: the Plugin Manager did not paint its explicit hidden-bundle search route')
  const defaultListDigest = sha16(frame)
  await operatorGate(operator, tui, 'MAC09-01 explicit CUA search', [
    'Press "/" (the explicit hidden-bundle search), type the exact name',
    `${CUA_BUNDLE}, press Enter, and wait for the Computer use card.`,
    'Return here when it is painted.',
  ])
  frame = tmuxCapture(tui, 'MAC09-01 explicit search result')
  assert(frame.includes('Computer use'),
    `MAC09-01: the explicit search did not paint the official Computer use card (frame sha256=${sha16(frame)})`)
  pushRow(report, 'MAC09-01', 'PASS', {
    defaultListDigest,
    searchedDigest: sha16(frame),
    listedByDefault: false,
    official: true,
    section: 'Experimental',
    crossPlatformNegative: 'covered by the existing Host catalog owner test, not by this macOS Host',
  })
  await operatorGate(operator, tui, 'MAC09-01 close Plugins', [
    'Press Esc to leave the Plugins page and return to the normal composer.',
    'Do not enable the bundle yet. Return here from the composer.',
  ])
  await waitComposer(tui, 'MAC09-01 composer restored')

  // MAC09-02 NEGATIVE: a standard (non-PTC) session has no CUA tool, and the
  // bundle is still disabled. The completed model turn is the causal barrier
  // for the bounded "no dispatch" fact.
  setCase(report, 'MAC09-02')
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
  await operatorGate(operator, tui, 'MAC09-02 enable Computer use + PTC', [
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
  pushRow(report, 'MAC09-02', 'PASS', {
    sessionId: sha16(capabilities.sessionId),
    subCallId: sha16(capabilities.dispatch.subCallId),
    dispatchMethod: dispatchMethod(capabilities.dispatch),
    nonPtcSession: sha16(negative.sessionId),
    nonPtcCuaDispatches: 0,
    bundle: CUA_BUNDLE,
    agentPreset: composition.agentPreset,
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
  await operatorGate(operator, tui, 'MAC09-03 macOS TCC grants', [
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
    try { process.kill(helper.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  for (const helper of helpersBefore) {
    try {
      await waitOwnedRoleGone(workRoot, helper.pid, 'MAC09-03 helper restart')
    } catch {
      try { process.kill(helper.pid, 'SIGKILL') } catch { /* already gone */ }
      await waitOwnedRoleGone(workRoot, helper.pid, 'MAC09-03 helper restart')
    }
  }
  const verified = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: capabilities.sessionId,
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
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${TEXTEDIT_BUNDLE}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); return JSON.stringify(windows). Do not click or type.`,
    label: 'MAC09-04 consent request',
    method: 'getApp',
  })
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
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${TEXTEDIT_BUNDLE}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); const shot = await tools.cua({ method: 'screenshot', params: { appHandle: app.appHandle, windowId: windows[0].windowId } }); return { width: shot.pixelWidth, height: shot.pixelHeight }`,
    label: 'MAC09-07 screenshot',
    method: 'screenshot',
    timeoutMs: TIMEOUTS.screenshot,
  })
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
  const imageFrame = await waitFrameText(tui, '🖼️', 'MAC09-07 Client image identity row', TIMEOUTS.mount)
  assert(imageFrame.includes(`${String(dimensions.width)}×${String(dimensions.height)}`),
    'MAC09-07: the Client image row does not name the admitted screenshot dimensions')
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
  const marker = `CUA-MARKER-${randomUUID().slice(0, 8).toUpperCase()}`
  const input = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: consent.sessionId,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${TEXTEDIT_BUNDLE}' } }); await tools.cua({ method: 'activate', params: { appHandle: app.appHandle } }); await tools.cua({ method: 'typeText', params: { appHandle: app.appHandle, text: '${marker}' } }); const tree = await tools.cua({ method: 'getState', params: { appHandle: app.appHandle } }); return JSON.stringify(tree).includes('${marker}') ? 'MARKER_PRESENT' : 'MARKER_MISSING'`,
    label: 'MAC09-08 controlled input',
    method: 'typeText',
    timeoutMs: TIMEOUTS.turn,
  })
  const inputResult = await waitCuaResult(dshHome, input.sessionId, input.dispatch.subCallId,
    'MAC09-08 typeText result', TIMEOUTS.turn)
  assert(inputResult.result.isError !== true,
    `MAC09-08: the controlled typeText failed: ${dispatchErrorCode(inputResult.result) ?? 'unknown error'}`)
  const markerResult = await waitFor(() => cuaResults(eventsOf(dshHome, input.sessionId), 0)
    .find(result => result.subCallId !== input.dispatch.subCallId && dispatchContentText(result).includes('MARKER_PRESENT')),
  'MAC09-08 the same cua call observes the typed marker', TIMEOUTS.turn)
  pushRow(report, 'MAC09-08', 'PASS', {
    sessionId: sha16(input.sessionId),
    rootCallId: sha16(input.dispatch.rootCallId),
    method: 'typeText',
    markerDigest: sha16(marker),
    observedInAccessibilityTree: dispatchContentText(markerResult).includes('MARKER_PRESENT'),
  })
  await waitTurnEnd(dshHome, input.sessionId, input.afterIndex, 'MAC09-08 input turn completed')

  // MAC09-06/09: another Session must ask its own consent. The operator DENIES
  // it; the tool fails closed with the official code and dispatches no input.
  setCase(report, 'MAC09-09')
  await newSession(tui, 'MAC09-09 new Session B')
  const deniedSession = await promptAndWaitCua({
    tui,
    dshHome,
    sessionId: undefined,
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${TEXTEDIT_BUNDLE}' } }); return app.appHandle`,
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
    `MAC09-06: the denied dispatch did not carry APP_ACCESS_DENIED: ${dispatchErrorCode(deniedResult.result) ?? 'unknown'}`)
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

async function sceneSplit({ installation, workRoot, report }) {
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
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${TEXTEDIT_BUNDLE}' } }); const windows = await tools.cua({ method: 'listWindows', params: { appHandle: app.appHandle } }); const shot = await tools.cua({ method: 'screenshot', params: { appHandle: app.appHandle, windowId: windows[0].windowId } }); return { width: shot.pixelWidth, height: shot.pixelHeight }`,
    label: 'MAC09-10 Split screenshot selection',
    method: 'getApp',
    timeoutMs: TIMEOUTS.turn,
  })
  const splitQuestion = await waitFrameText(tui, 'Allow computer use', 'Split Client consent Question', TIMEOUTS.consent)
  logOperator([`Split Session consent Question is painted. Attach now: ${attachCommand(tui)}`,
    'Choose "Allow for this session" exactly once. This is the Split Host/Client path.'])
  const splitConsent = await waitCuaResult(dshHome, screenshot.sessionId, screenshot.dispatch.subCallId,
    'Split consent resumes the dispatch', TIMEOUTS.consent)
  assert(splitConsent.result.isError !== true,
    `Split consent failed: ${dispatchErrorCode(splitConsent.result) ?? 'unknown error'}`)
  const splitShot = await waitFor(() => cuaDispatches(eventsOf(dshHome, screenshot.sessionId), screenshot.afterIndex)
    .find(candidate => dispatchMethod(candidate) === 'screenshot'), 'Split official screenshot dispatch', TIMEOUTS.screenshot)
  const splitShotResult = await waitCuaResult(dshHome, screenshot.sessionId, splitShot.subCallId,
    'Split screenshot result', TIMEOUTS.screenshot)
  assert(splitShotResult.result.isError !== true,
    `Split screenshot failed: ${dispatchErrorCode(splitShotResult.result) ?? 'unknown error'}`)
  const splitRefs = [...attachmentRefs(splitShotResult.result)]
  assert(splitRefs.length > 0, 'Split screenshot carried no durable attachment reference')
  const splitDimensions = imageDimensions(readFileSync(attachmentObjectPath(dshHome, splitRefs[0])))
  assert(splitDimensions !== undefined, 'Split screenshot attachment is not a supported image')
  const splitImageFrame = await waitFrameText(tui, '🖼️', 'Split Client image identity row', TIMEOUTS.mount)
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
    prompt: `Run exactly this in run_code: const app = await tools.cua({ method: 'getApp', params: { selector: '${TEXTEDIT_BUNDLE}' } }); return app.appHandle`,
    label: 'MAC09-10 pending consent',
    method: 'getApp',
  })
  await waitFrameText(tui, 'Allow computer use', 'MAC09-10 pending consent Question', TIMEOUTS.consent)
  const clientPids = ownedRoles(workRoot).clients.filter(row => alive(row.pid)).map(row => row.pid)
  assert(clientPids.length === 1, `MAC09-10: expected one owned Split Client, saw ${String(clientPids.length)}`)
  const clientPid = clientPids[0]
  assert(clientPid !== registry.record.hostPid,
    `MAC09-10: the Split Client pid ${String(clientPid)} equals the Host pid ${String(registry.record.hostPid)}`)
  logOperator([`MAC09-10 is killing the Split Client pid ${String(clientPid)} while the Question is pending.`,
    'Do NOT answer it. A new Client will reopen the same Session.'])
  try { process.kill(clientPid, 'SIGTERM') } catch { /* already gone */ }
  await waitOwnedRoleGone(workRoot, clientPid, 'MAC09-10 old Split Client')
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
  const staleResults = cuaResults(eventsOf(dshHome, reconnect.sessionId), 0)
    .filter(item => item.subCallId === reconnect.dispatch.subCallId)
  assert(staleResults.length === 0,
    'MAC09-10: the pending dispatch settled after the Client exited without an answer')
  pushRow(report, 'MAC09-10', 'PASS', {
    sessionId: sha16(reconnect.sessionId),
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
    ...(registryHost === undefined ? [] : [{ pid: registryHost.pid, command: 'published Host' }]),
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
    report.notQuiesced = { survivors: survivors.map(target => target.pid) }
    errors.push(`NOT_QUIESCED: ${String(survivors.length)} owned process(es) survived cleanup`)
    return errors
  }
  // 4. The official helper keeps one shared runtime socket in /tmp keyed by
  //    the helper executable digest. Remove only THIS helper's socket.
  try {
    if (typeof helperAppPath === 'string' && existsSync(helperAppPath)) {
      const runtimeKey = sha256File(join(helperAppPath, HELPER_EXECUTABLE))
      const runtimeDirectory = `/tmp/dsh-cua-${String(process.getuid())}`
      const socketPath = join(runtimeDirectory, `${runtimeKey}.sock`)
      if (existsSync(socketPath)) {
        const directoryInfo = lstatSync(runtimeDirectory)
        const socketInfo = lstatSync(socketPath)
        if (directoryInfo.isDirectory() && directoryInfo.uid === process.getuid()
          && (directoryInfo.mode & 0o777) === 0o700 && socketInfo.isSocket()) {
          rmSync(socketPath, { force: true })
        } else {
          errors.push('refusing to remove an unexpected /tmp CUA runtime socket')
        }
      }
    }
  } catch (error) {
    errors.push(`CUA runtime socket cleanup failed: ${boundedError(error)}`)
  }
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
    report.textEdit = { pid: textEdit.pid, file: textEdit.file }

    const directScene = await sceneDirect({ installation, workRoot, report, operator, helperAppPath })
    const splitTui = await sceneSplit({ installation, workRoot, report })

    // MAC09-11: the operator disables the bundle through the real Plugin
    // Manager; the tool is withdrawn, but the OS TCC entry and the durable
    // consent storage remain untouched.
    setCase(report, 'MAC09-11')
    const storageBefore = permissionStoreFingerprint(installation.dshHome)
    await operatorGate(operator, splitTui, 'MAC09-11 disable Computer use', [
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
    const storageAfter = permissionStoreFingerprint(installation.dshHome)
    assert(JSON.stringify(storageBefore) === JSON.stringify(storageAfter),
      'MAC09-11: disabling the bundle changed the durable CUA consent storage')
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
    let archiveFrame = ''
    let archiveVisible = false
    for (let page = 0; page < 10 && !archiveVisible; page += 1) {
      archiveFrame = tmuxCapture(archiveTui, 'MAC09-11 archived Session frame')
      archiveVisible = archiveFrame.includes('🖼️')
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
  await main()
} catch (error) {
  const kind = error instanceof CuaInputError
    ? 'INPUT_UNQUALIFIED'
    : error instanceof CuaNotVerifiedError
      ? 'NOT_VERIFIED'
      : 'FAIL'
  process.stderr.write(`${HEADING}: ${kind} ${boundedError(error)}\n`)
  process.exitCode = 1
}
