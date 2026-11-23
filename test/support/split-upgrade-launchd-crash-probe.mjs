/**
 * External worker-kill qualification for the launchd native managed-service
 * Scene.
 *
 * The probe is the independent parent of the real Vitest worker. It reads the
 * Supervisor receipt (never the Worker's log) for the exact ready note, the
 * unique Worker/Supervisor PIDs and the run-owned LaunchAgent, sends SIGKILL
 * ONLY to the Worker at the selected business point, waits for the Supervisor's
 * terminal `ABORTED_CLEAN`/`NOT_QUIESCED` receipt and then independently audits
 * the real launchctl job, the plist, the recorded Host kernel identities, the
 * registered Client/shell processes and the Scene root.
 *
 * The helper's pure IO seam is also exercised for same-label/different-identity,
 * foreign owner, loaded-source mismatch and manager-query failure: those must
 * all preserve the service (`clean: false`), never mutate a real job.
 *
 * @module test/support/split-upgrade-launchd-crash-probe
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildReservationFacts,
  serializeKernelIdentity,
} from './split-upgrade-native-contract.mjs'
import {
  inspectManagedServiceWithIo,
  preflightLaunchdTestEnvironment,
  reclaimManagedServiceWithIo,
} from './split-upgrade-launchd-manager.mjs'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))
const KILL_POINTS = Object.freeze([
  'managed-install-complete',
  'managed-host-client-attached',
  'managed-customization-committed',
])
const NOTE_EVENT = 'native-kill-ready'
const TERMINAL_PHASES = Object.freeze(['ABORTED_CLEAN', 'NOT_QUIESCED'])
const ISOLATED_FLAG = 'SPLIT_VITEST_LAUNCHD_ISOLATED'
const TMP_BASE_ENV = 'SPLIT_VITEST_TMP_BASE'
const OLD_TGZ_ENV = 'SPLIT_VITEST_UPGRADE_OLD_TGZ'
const NEW_TGZ_ENV = 'SPLIT_VITEST_UPGRADE_NEW_TGZ'
const RUN_ID_ENV = 'SPLIT_VITEST_RUN_ID'
const KILL_SWITCH = 'SPLIT_VITEST_NATIVE_KILL_POINT'
const READY_TIMEOUT_MS = 360_000
const TERMINAL_TIMEOUT_MS = 180_000
const CHILD_EXIT_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT_BYTES = 256 * 1024

const { readKernelProcess } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'runtime', 'native-process', 'identity.ts')).href
)
const { profileIdentityDigest } = await import(
  pathToFileURL(join(REPO_ROOT, 'src', 'app', 'remote-process', 'local-host-manager.ts')).href
)

function fail(message) {
  throw new Error(`launchd crash probe: ${message}`)
}

function usage() {
  return [
    'Usage: mise exec -- node test/support/split-upgrade-launchd-crash-probe.mjs --at <point>',
    `Points: ${KILL_POINTS.join(', ')}`,
    `Required environment: ${ISOLATED_FLAG}=1, ${TMP_BASE_ENV}, ${OLD_TGZ_ENV}, ${NEW_TGZ_ENV}`,
  ].join('\n')
}

function parseArgs(argv) {
  let at
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--at') {
      if (at !== undefined) fail('--at was supplied more than once')
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail('--at requires one business point')
      at = value
      index += 1
      continue
    }
    fail(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (help) return { help: true }
  if (at === undefined) fail('--at <point> is required')
  if (!KILL_POINTS.includes(at)) fail(`unknown kill point ${JSON.stringify(at)}; choose one of ${KILL_POINTS.join(', ')}`)
  return { help: false, at }
}

function requireAbsoluteEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '' || !isAbsolute(value)) {
    fail(`${name} must be one absolute path`)
  }
  return value
}

function requirePrivateBase() {
  const tmpBase = requireAbsoluteEnv(TMP_BASE_ENV)
  const stats = statSync(tmpBase)
  if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700 || stats.uid !== process.getuid?.()) {
    fail(`${TMP_BASE_ENV} must be a real 0700 directory owned by this uid`)
  }
  return tmpBase
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function launchctlPrint(uid, label) {
  const printed = spawnSync('/bin/launchctl', ['print', `gui/${String(uid)}/${label}`], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (printed.error !== undefined) fail(`launchctl print could not run: ${String(printed.error)}`)
  return { status: printed.status, stdout: printed.stdout ?? '', stderr: printed.stderr ?? '' }
}

function readReceipt(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function findReceipt(tmpBase, runId) {
  const directory = join(tmpBase, 'split-resources')
  if (!existsSync(directory)) return undefined
  const files = readdirSync(directory)
    .filter(name => name.startsWith(`${runId}-`) && name.endsWith('.json') && !name.includes('-crash-report-'))
  if (files.length === 0) return undefined
  if (files.length > 1) fail(`several Supervisor receipts match ${runId}: ${files.join(', ')}`)
  const path = join(directory, files[0])
  const receipt = readReceipt(path)
  if (receipt === undefined) return undefined
  return { path, receipt }
}

function delay(ms) {
  return sleep(ms)
}

async function waitForReadyPoint({ tmpBase, runId, at }) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const found = findReceipt(tmpBase, runId)
    if (found !== undefined) {
      const { path, receipt } = found
      if (TERMINAL_PHASES.includes(receipt.phase)) {
        fail(`the Supervisor reached ${receipt.phase} before the ${at} ready note`)
      }
      const note = (Array.isArray(receipt.notes) ? receipt.notes : [])
        .find(value => value?.event === NOTE_EVENT && value?.detail?.point === at)
      const workerPid = receipt.worker?.pid
      const supervisorPid = receipt.supervisor?.pid
      const reservation = receipt.native?.reservation
      if (note !== undefined) {
        if (!Number.isInteger(workerPid) || workerPid <= 0) fail('the ready note has no unique Worker PID')
        if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) fail('the ready note has no unique Supervisor PID')
        if (reservation === null || typeof reservation !== 'object') fail('the ready note has no native reservation')
        if (typeof reservation.unitName !== 'string' || typeof reservation.unitPath !== 'string') {
          fail('the ready note has no run-owned launchd unit/plist')
        }
        if (!pidAlive(workerPid)) fail(`the ready Worker PID ${String(workerPid)} is not alive`)
        if (!pidAlive(supervisorPid)) fail(`the ready Supervisor PID ${String(supervisorPid)} is not alive`)
        return { path, receipt, workerPid, supervisorPid, reservation }
      }
    }
    if (Date.now() >= deadline) {
      const receipt = found?.receipt
      fail(`the ${at} ready note did not appear within ${String(READY_TIMEOUT_MS)}ms (phase ${String(receipt?.phase ?? 'none')})`)
    }
    await delay(100)
  }
}

function sigkillWorker(workerPid, supervisorPid) {
  if (workerPid === supervisorPid) fail('the Worker and Supervisor PID are the same')
  try {
    process.kill(workerPid, 'SIGKILL')
  } catch (error) {
    if (error?.code === 'ESRCH') fail(`the Worker PID ${String(workerPid)} exited before SIGKILL`)
    throw error
  }
}

async function waitForTerminal(receiptPath) {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS
  for (;;) {
    const receipt = readReceipt(receiptPath)
    if (receipt !== undefined && TERMINAL_PHASES.includes(receipt.phase)) return receipt
    if (Date.now() >= deadline) {
      fail(`the Supervisor did not reach a terminal phase within ${String(TERMINAL_TIMEOUT_MS)}ms (phase ${String(receipt?.phase ?? 'none')})`)
    }
    await delay(100)
  }
}

function auditKernelIdentities(receipt) {
  const failures = []
  const hosts = []
  for (const identity of Array.isArray(receipt.native?.hostIdentities) ? receipt.native.hostIdentities : []) {
    if (!Number.isInteger(identity?.pid) || typeof identity?.kernelIdentity !== 'string') {
      failures.push('a recorded Host identity is malformed')
      continue
    }
    const observed = readKernelProcess(identity.pid)
    const alive = observed.kind === 'alive'
      && serializeKernelIdentity(observed.identity) === identity.kernelIdentity
    hosts.push({ pid: identity.pid, alive })
    if (alive) failures.push(`Host PID ${String(identity.pid)} still has its recorded kernel identity`)
  }
  const clients = []
  for (const client of Array.isArray(receipt.clients) ? receipt.clients : []) {
    const nativeOs = client?.nativeOs
    const identities = [
      ...(Array.isArray(nativeOs?.business) ? nativeOs.business : []),
      ...(nativeOs?.shell === null || nativeOs?.shell === undefined ? [] : [nativeOs.shell]),
    ]
    const seen = new Set()
    for (const identity of identities) {
      if (!Number.isInteger(identity?.pid) || typeof identity?.birth !== 'string') {
        failures.push(`Client ${String(client?.label)} has a malformed OS identity`)
        continue
      }
      if (seen.has(identity.pid)) continue
      seen.add(identity.pid)
      const observed = readKernelProcess(identity.pid)
      const alive = observed.kind === 'alive'
        && serializeKernelIdentity(observed.identity) === identity.birth
      clients.push({ label: String(client?.label), pid: identity.pid, alive })
      if (alive) failures.push(`Client ${String(client?.label)} PID ${String(identity.pid)} is still alive`)
    }
  }
  return { hosts, clients, failures }
}

function auditResources(receipt) {
  const failures = []
  const reservation = receipt.native?.reservation
  if (reservation === null || typeof reservation !== 'object') fail('the terminal receipt has no native reservation')
  const { uid, unitName, unitPath, dshHome } = reservation
  if (!Number.isInteger(uid) || typeof unitName !== 'string' || typeof unitPath !== 'string') {
    fail('the terminal receipt reservation is malformed')
  }
  if (receipt.phase !== 'ABORTED_CLEAN') failures.push(`terminal phase is ${String(receipt.phase)}`)
  if (receipt.native?.cleanup?.attempted !== true) failures.push('the native cleanup was not attempted')
  const state = receipt.native?.observed?.state
  if (state !== 'removed' && state !== 'reserved-but-absent') failures.push(`the native service state is ${String(state)}`)
  const printed = launchctlPrint(uid, unitName)
  if (printed.status !== 113) failures.push(`launchctl print ${unitName} exited ${String(printed.status)}`)
  const plistAbsent = !existsSync(unitPath)
  if (!plistAbsent) failures.push('the run-owned plist still exists')
  const sceneRootAbsent = typeof receipt.sceneRoot === 'string' ? !existsSync(receipt.sceneRoot) : true
  if (!sceneRootAbsent) failures.push('the Scene root still exists')
  const kernelAudit = auditKernelIdentities(receipt)
  failures.push(...kernelAudit.failures)
  const cleanup = receipt.cleanup
  if (cleanup?.sceneRootRemoved !== true) failures.push('the receipt does not confirm the Scene root removal')
  return {
    phase: receipt.phase,
    cleanupReason: cleanup?.reason ?? null,
    officialStop: receipt.native?.cleanup?.officialStop ?? null,
    officialUninstall: receipt.native?.cleanup?.officialUninstall ?? null,
    helperFallback: receipt.native?.cleanup?.fallback ?? null,
    nativeState: state ?? null,
    launchctlPrintStatus: printed.status,
    plistAbsent,
    sceneRootAbsent,
    dshHome: typeof dshHome === 'string' && dshHome !== '' ? dshHome : null,
    hosts: kernelAudit.hosts,
    clients: kernelAudit.clients,
    failures,
  }
}

function makeFakeIo({ decoded, launchctl, content }) {
  const calls = { bootout: [], unlink: [] }
  let currentContent = content
  const stats = { isFile: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o600, dev: 1, ino: 2 }
  const io = {
    lstat: () => stats,
    readFile: () => currentContent,
    realpath: path => path,
    launchctl: async args => {
      if (args[0] === 'bootout') calls.bootout.push(args)
      return await launchctl(args)
    },
    decodePlist: () => decoded,
    lintPlist: () => {},
    writeTempFile: () => { fail('the negative IO seam must never write a plist') },
    rename: () => { fail('the negative IO seam must never replace a plist') },
    unlink: path => {
      calls.unlink.push(path)
      currentContent = undefined
    },
    sleep: async () => {},
    now: () => 0,
    profileIdentityDigest: value => profileIdentityDigest(value),
  }
  return { io, calls }
}

async function negativeIoSeamAudit() {
  const scopeId = 'scope-0123456789abcdef-0123456789abcdef0123456789abcdef'
  const reservation = buildReservationFacts({
    manager: 'launchd',
    uid: 501,
    accountHome: '/Users/tester',
    profileRealpath: '/tmp/dsh-home/profiles/pi-tui',
    dshHome: '/tmp/dsh-home',
    scopeId,
    oldBuildId: 'a'.repeat(64),
    sceneId: 'probe-scene',
    parentRunId: 'probe-run',
  })
  const decoded = {
    Label: reservation.unitName,
    ProgramArguments: ['/usr/bin/node', '/tmp/entry/local-host.mjs'],
    EnvironmentVariables: {
      DSH_HOME: '/tmp/dsh-home',
      SPLIT_PROCESS_DSH_ANCHOR: '/tmp/anchor',
      SPLIT_PROCESS_PROFILE: 'pi-tui',
    },
    'X-DshPiTuiOwner': 'local-host-launchd-v1',
    'X-DshPiTuiScopeId': scopeId,
    'X-DshPiTuiProfileIdentity': profileIdentityDigest(reservation.profileRealpath),
    'X-DshPiTuiInstallBuild': 'b'.repeat(64),
  }
  const content = 'launchd-negative-seam-plist'
  const notLoaded = { kind: 'exited', code: 113, stdout: '', stderr: '' }
  const printOtherSource = [
    '\ttype = LaunchAgent',
    '\tpath = /tmp/other.plist',
    '\tstate = not running',
    '\tprogram = /usr/bin/node',
    '\targuments = {',
    '\t\t/usr/bin/node',
    '\t\t/tmp/entry/local-host.mjs',
    '\t}',
    '\tenvironment = {',
    '\t\tDSH_HOME => /tmp/dsh-home',
    '\t\tSPLIT_PROCESS_DSH_ANCHOR => /tmp/anchor',
    '\t\tSPLIT_PROCESS_PROFILE => pi-tui',
    '\t}',
  ].join('\n')
  const recorded = { device: '1', inode: '2', sha256: 'c'.repeat(64) }
  const cases = []

  for (const testCase of [
    {
      name: 'same-label-different-file-identity',
      decoded,
      launchctl: async () => notLoaded,
      recorded,
    },
    {
      name: 'foreign-owner-marker',
      decoded: { ...decoded, 'X-DshPiTuiOwner': 'another-owner' },
      launchctl: async () => notLoaded,
      recorded: null,
    },
    {
      name: 'loaded-source-is-another-plist',
      decoded,
      launchctl: async () => ({ kind: 'exited', code: 0, stdout: printOtherSource, stderr: '' }),
      recorded: null,
    },
    {
      name: 'manager-query-failure',
      decoded,
      launchctl: async () => ({ kind: 'timeout' }),
      recorded: null,
    },
  ]) {
    const { io, calls } = makeFakeIo({ ...testCase, content })
    let inspection
    try {
      inspection = await inspectManagedServiceWithIo(reservation, io)
    } catch (error) {
      cases.push({ name: testCase.name, pass: false, reason: `inspect threw: ${String(error?.message ?? error)}` })
      continue
    }
    const current = inspection.fileFacts === null
      ? recorded
      : { device: inspection.fileFacts.device, inode: inspection.fileFacts.inode, sha256: inspection.fileFacts.sha256 }
    const reclaimed = await reclaimManagedServiceWithIo({
      ...reservation,
      fileIdentity: testCase.recorded === null ? current : testCase.recorded,
      verifiedHostIdentities: [],
    }, io)
    const ownerRefusal = testCase.name === 'foreign-owner-marker'
      || testCase.name === 'loaded-source-is-another-plist'
    const pass = reclaimed.clean !== true
      && reclaimed.action === 'preserve'
      && calls.bootout.length === 0
      && calls.unlink.length === 0
      && (!ownerRefusal || inspection.ownerVerified !== true)
    cases.push({
      name: testCase.name,
      pass,
      file: inspection.file,
      ownerVerified: inspection.ownerVerified,
      managerState: inspection.managerState,
      action: reclaimed.action,
      clean: reclaimed.clean,
      reason: reclaimed.reason,
    })
  }
  return { cases, pass: cases.every(value => value.pass === true) }
}

function writeReport(tmpBase, runId, at, report) {
  const directory = join(tmpBase, 'split-resources')
  const path = join(directory, `${runId}-crash-report-${at}.json`)
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return path
}

function startVitest({ env }) {
  const child = spawn('mise', ['exec', '--', 'pnpm', 'test:split:upgrade:launchd'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const collect = chunk => {
    if (output.length >= OUTPUT_LIMIT_BYTES) return
    output += chunk.toString('utf8').slice(0, OUTPUT_LIMIT_BYTES - output.length)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  return { child, output: () => output }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const settled = new Promise(resolve => child.once('exit', resolve))
  const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs, 'timeout'))
  const result = await Promise.race([settled, timeout])
  if (result === 'timeout' && (child.exitCode === null && child.signalCode === null)) {
    child.kill('SIGTERM')
    return await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5_000)])
  }
  return result
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n${usage()}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  if (process.env[ISOLATED_FLAG] !== '1') {
    fail(`${ISOLATED_FLAG}=1 is required; the native launchd scene is opt-in`)
  }
  const tmpBase = requirePrivateBase()
  const oldTgz = requireAbsoluteEnv(OLD_TGZ_ENV)
  const newTgz = requireAbsoluteEnv(NEW_TGZ_ENV)
  if (!existsSync(oldTgz) || !existsSync(newTgz)) fail('the OLD/NEW tgz inputs must exist')
  const preflight = await preflightLaunchdTestEnvironment()
  const runId = `probe-${args.at}-${Date.now()}-${process.pid}`
  const childEnv = {
    ...process.env,
    [ISOLATED_FLAG]: '1',
    [TMP_BASE_ENV]: tmpBase,
    [OLD_TGZ_ENV]: oldTgz,
    [NEW_TGZ_ENV]: newTgz,
    [RUN_ID_ENV]: runId,
    [KILL_SWITCH]: args.at,
  }
  const startedAt = new Date().toISOString()
  const { child, output } = startVitest({ env: childEnv })
  let ready
  try {
    ready = await waitForReadyPoint({ tmpBase, runId, at: args.at })
    if (ready.workerPid === preflight.uid) fail('the ready Worker PID is the probe user, not a real Vitest Worker')
    sigkillWorker(ready.workerPid, ready.supervisorPid)
    const terminal = await waitForTerminal(ready.path)
    const resources = auditResources(terminal)
    const negative = await negativeIoSeamAudit()
    const failures = [...resources.failures]
    if (!negative.pass) failures.push('the platform helper IO-seam negative controls did not preserve')
    const pass = terminal.phase === 'ABORTED_CLEAN' && failures.length === 0
    const report = {
      schemaVersion: 1,
      probe: 'launchd-worker-kill',
      at: args.at,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      account: { uid: preflight.uid, accountHome: preflight.accountHome },
      workerPid: ready.workerPid,
      supervisorPid: ready.supervisorPid,
      reservation: {
        manager: ready.reservation.manager,
        unitName: ready.reservation.unitName,
        unitPath: ready.reservation.unitPath,
        scopeId: ready.reservation.scopeId,
      },
      terminalPhase: terminal.phase,
      resources,
      negativeIoSeam: negative,
      failures,
      pass,
    }
    const reportPath = writeReport(tmpBase, runId, args.at, report)
    await waitForChildExit(child, CHILD_EXIT_TIMEOUT_MS)
    process.stdout.write(`${JSON.stringify({
      probe: report.probe,
      at: report.at,
      runId,
      pass,
      terminalPhase: report.terminalPhase,
      reportPath,
      failures,
    }, null, 2)}\n`)
    if (!pass && output().trim() !== '') process.stderr.write(`\n${output().trim()}\n`)
    return pass ? 0 : 1
  } catch (error) {
    const receipt = ready !== undefined ? readReceipt(ready.path) : (() => {
      const found = findReceipt(tmpBase, runId)
      return found?.receipt
    })()
    const report = {
      schemaVersion: 1,
      probe: 'launchd-worker-kill',
      at: args.at,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      account: { uid: preflight.uid, accountHome: preflight.accountHome },
      error: String(error?.message ?? error),
      terminalPhase: receipt?.phase ?? null,
      workerPid: receipt?.worker?.pid ?? null,
      supervisorPid: receipt?.supervisor?.pid ?? null,
      reservation: receipt?.native?.reservation ?? null,
      reportPath: null,
    }
    let reportPath
    try {
      reportPath = writeReport(tmpBase, runId, args.at, report)
      report.reportPath = reportPath
    } catch { /* the failure report is diagnostic; preserve the primary error */ }
    if (output().trim() !== '') process.stderr.write(`\n${output().trim()}\n`)
    process.stderr.write(`launchd crash probe failed: ${String(error?.message ?? error)}\n`)
    if (reportPath !== undefined) process.stderr.write(`failure report: ${reportPath}\n`)
    return 1
  }
}

process.exitCode = await main()
