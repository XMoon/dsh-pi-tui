#!/usr/bin/env node
/**
 * Split-process external signal/parent-death probe.
 *
 * This file is deliberately outside the test body: it drives real Vitest or
 * Upgrade worker processes and checks OS process state, so a passing test
 * assertion cannot stand in for resource release. It never kills a process by
 * a guessed PID; the Supervisor receipt names the exact Worker/Host/Client
 * identities it owns.
 *
 * Modes (Pilot, unchanged):
 *   --mode main-signal --signal SIGINT|SIGTERM
 *   --mode foreground-group-sigint
 *   --mode worker-kill --at two-clients-ready|host-spawned-before-ack
 *   --mode bootstrap-main-sigterm
 *
 * Modes (Upgrade U0):
 *   --mode upgrade-sequential-hosts
 *   --mode upgrade-live-profile-refusal
 *   --mode upgrade-live-host-exit
 *   --mode upgrade-qualification-host-death
 *   --mode upgrade-worker-kill --at old-host-ready|between-host-generations|new-host-spawned-before-ack|side-build-install|bootstrap-install|reload-child-active|reload-child-started-before-report|qualification-client-active
 *
 * Required env:
 *   Pilot: SPLIT_VITEST_TMP_BASE + SPLIT_VITEST_CANDIDATE_TGZ
 *   Upgrade: SPLIT_VITEST_TMP_BASE + SPLIT_VITEST_UPGRADE_OLD_TGZ + SPLIT_VITEST_UPGRADE_NEW_TGZ
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { isBootstrapInstallInProgress, isSideNewInstallInProgress } from './split-upgrade-install-state.mjs'

const PILOT_MODES = ['main-signal', 'foreground-group-sigint', 'worker-kill', 'bootstrap-main-sigterm']
const UPGRADE_ATS = ['old-host-ready', 'between-host-generations', 'new-host-spawned-before-ack', 'side-build-install', 'bootstrap-install', 'reload-child-active', 'reload-child-started-before-report', 'qualification-client-active']
const UPGRADE_MODES = ['upgrade-sequential-hosts', 'upgrade-live-profile-refusal', 'upgrade-live-host-exit', 'upgrade-qualification-host-death', 'upgrade-worker-kill']

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FAIL: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function requireEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '') fail(`${name} must be set`)
  return value
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, label, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await predicate()
    if (value !== undefined && value !== null && value !== false) return value
    await sleep(100)
  }
  fail(`${label}: timed out after ${String(timeoutMs)}ms`)
}

function assertLiveReceipt(receipt) {
  const problems = []
  if (receipt.host === undefined || !pidAlive(receipt.host.pid)) problems.push('Host PID is not live before the probe trigger')
  if ((receipt.clients ?? []).length < 2) problems.push('two Client receipts are missing before the probe trigger')
  for (const client of receipt.clients ?? []) {
    if (!pidAlive(client.shellPid)) problems.push(`Client shell PID is not live before the probe trigger: ${String(client.shellPid)}`)
  }
  if (problems.length > 0) fail(problems.join('; '))
}

function workerKillTarget(receipt, at, vitestPid) {
  const worker = receipt?.worker
  const workerPid = Number(worker?.pid)
  const workerPpid = Number(worker?.ppid)
  if (!Number.isInteger(workerPid) || workerPid <= 0
    || !Number.isInteger(workerPpid) || workerPpid <= 0) {
    fail(`worker-kill receipt did not carry a valid worker identity for ${String(at)}`)
  }
  if (!Number.isInteger(vitestPid) || workerPpid !== vitestPid) {
    fail(`worker PPID ${String(workerPpid)} does not match the probe-owned Vitest PID ${String(vitestPid)}`)
  }
  if (!pidAlive(workerPid)) fail(`worker PID ${String(workerPid)} is not alive before the probe SIGKILL`)
  return workerPid
}

function upgradeWorkerKillTarget(receipt, at) {
  const worker = receipt?.worker
  const workerPid = Number(worker?.pid)
  const workerPpid = Number(worker?.ppid)
  if (!Number.isInteger(workerPid) || workerPid <= 0 || !Number.isInteger(workerPpid) || workerPpid <= 0) {
    fail(`upgrade worker-kill receipt did not carry a valid worker identity for ${String(at)}`)
  }
  if (workerPpid !== process.pid) {
    fail(`upgrade worker PPID ${String(workerPpid)} does not match the probe PID ${String(process.pid)}`)
  }
  if (!pidAlive(workerPid)) fail(`upgrade worker PID ${String(workerPid)} is not alive before the probe SIGKILL`)
  return workerPid
}

async function waitForPidGone(pid, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return
    await sleep(50)
  }
  fail(`SIGKILL target PID ${String(pid)} is still alive`)
}

async function waitChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      reject(new Error(`child did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onClose = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('close', onClose)
  })
}

function readReceipts(tmpBase) {
  const root = join(tmpBase, 'split-resources')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name.endsWith('.json'))
    .flatMap(name => {
      try {
        return [JSON.parse(readFileSync(join(root, name), 'utf8'))]
      } catch {
        return []
      }
    })
}

function receipts(tmpBase, runId) {
  return readReceipts(tmpBase).filter(value => value.runId === runId)
}

function upgradeReceipts(tmpBase, parentRunId) {
  return readReceipts(tmpBase).filter(value => value.parentRunId === parentRunId)
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

/** Whether the kernel Host seat of one scope is free (Linux abstract / Darwin O_EXLOCK). */
async function hostSeatFree(scopeId) {
  if (process.platform === 'linux') {
    return await new Promise((resolve, reject) => {
      const server = createServer()
      let settled = false
      server.once('error', error => {
        if (settled) return
        settled = true
        if (error?.code === 'EADDRINUSE') {
          resolve(false)
          return
        }
        reject(error)
      })
      server.listen(`\0dsh-pi-tui-h-${scopeId.slice(0, 40)}`, () => {
        if (settled) return
        settled = true
        server.close(() => resolve(true))
      })
    })
  }
  if (process.platform === 'darwin') {
    // O_RDWR|O_EXLOCK|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC, no O_CREAT.
    const flags = 2 | 32 | 4 | 256 | 16777216
    const seatPath = join(userInfo().homedir, '.dsh-pi-tui', 'run', scopeId, `seat-host-${scopeId}.lock`)
    const started = Date.now()
    for (;;) {
      try {
        closeSync(openSync(seatPath, flags, 0o600))
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return true
        if (error?.code !== 'EAGAIN' && error?.code !== 'EWOULDBLOCK') throw error
        if (Date.now() - started > 15_000) return false
        await sleep(50)
      }
    }
  }
  fail(`no Host seat probe is implemented for ${process.platform}`)
  return false
}

function checkNoLingeringPaths(receipt) {
  let commands
  try {
    commands = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  } catch (error) {
    fail(`could not inspect OS process commands: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Only THIS Scene's own root is evidence. The shared tmp base may contain
  // other concurrently authorized probe Scenes and is never a leak by itself.
  const needles = [receipt.sceneRoot].filter(value => typeof value === 'string' && value !== '')
  const lingering = commands.split('\n').filter(line => {
    const trimmed = line.trim()
    if (trimmed === '') return false
    if (trimmed.includes('split-supervisor-signal-probe.mjs') || trimmed.includes('split-upgrade-probe-worker.mjs')) return false
    if (trimmed.includes('SPLIT_VITEST_TMP_BASE') || trimmed.includes('SPLIT_VITEST_CANDIDATE_TGZ')
      || trimmed.includes('SPLIT_VITEST_UPGRADE_OLD_TGZ') || trimmed.includes('SPLIT_VITEST_UPGRADE_NEW_TGZ')) return false
    return needles.some(needle => trimmed.includes(needle))
  })
  if (lingering.length > 0) {
    fail(`process(es) still reference the run's private path: ${lingering.join(' | ')}`)
  }
}

function latestReceipt(tmpBase, runId) {
  const all = receipts(tmpBase, runId)
  return all.length === 0 ? undefined : all.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0]
}

function latestUpgradeReceipt(tmpBase, parentRunId) {
  const all = upgradeReceipts(tmpBase, parentRunId)
  return all.length === 0 ? undefined : all.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0]
}

function checkReceiptResources(receipt) {
  const problems = []
  if (receipt.sceneRoot !== undefined && existsSync(receipt.sceneRoot)) {
    problems.push(`scene root still exists: ${receipt.sceneRoot}`)
  }
  if (receipt.install?.inProgress === true) {
    problems.push('install is still marked in progress')
  }
  if (receipt.host !== undefined) {
    for (const pid of [receipt.host.pid, receipt.host.businessPid]) {
      if (pidAlive(pid)) problems.push(`Host PID still alive: ${String(pid)}`)
    }
  }
  if (receipt.host?.pgid !== undefined && groupAlive(receipt.host.pgid)) {
    problems.push(`Host process group still alive: ${String(receipt.host.pgid)}`)
  }
  for (const client of receipt.clients ?? []) {
    if (pidAlive(client.shellPid)) problems.push(`Client shell PID still alive: ${String(client.shellPid)} (${String(client.label)})`)
    for (const pid of client.businessPids ?? []) {
      if (pidAlive(pid)) problems.push(`Client business PID still alive: ${String(pid)} (${String(client.label)})`)
    }
  }
  if (pidAlive(receipt.supervisor?.pid)) problems.push(`Supervisor PID still alive: ${String(receipt.supervisor.pid)}`)
  return problems
}

function checkUpgradeReceiptResources(receipt, options = {}) {
  const problems = []
  if (options.allowRemainingRoot !== true && receipt.sceneRoot !== undefined && existsSync(receipt.sceneRoot)) {
    problems.push(`scene root still exists: ${receipt.sceneRoot}`)
  }
  if (receipt.install?.inProgress === true) {
    problems.push('install is still marked in progress')
  }
  const generations = Array.isArray(receipt.hosts) ? receipt.hosts : []
  if (generations.length === 0 && receipt.phase !== 'NOT_QUIESCED' && options.allowNoHosts !== true) {
    problems.push('receipt carries no Host generation ledger')
  }
  for (const host of generations) {
    for (const pid of [host.pid, host.businessPid]) {
      if (pidAlive(pid)) problems.push(`Host generation ${String(host.generation)} PID still alive: ${String(pid)}`)
    }
    if (host.pgid !== undefined && groupAlive(host.pgid)) {
      problems.push(`Host generation ${String(host.generation)} process group still alive: ${String(host.pgid)}`)
    }
  }
  for (const client of receipt.clients ?? []) {
    if (pidAlive(client.shellPid)) problems.push(`Client shell PID still alive: ${String(client.shellPid)} (${String(client.label)})`)
    for (const pid of client.businessPids ?? []) {
      if (pidAlive(pid)) problems.push(`Client business PID still alive: ${String(pid)} (${String(client.label)})`)
    }
  }
  for (const qualification of receipt.qualificationClients ?? []) {
    if (pidAlive(qualification.pid)) problems.push(`qualification Client PID still alive: ${String(qualification.pid)}`)
    if (qualification.pgid !== undefined && groupAlive(qualification.pgid)) {
      problems.push(`qualification Client process group still alive: ${String(qualification.pgid)}`)
    }
  }
  for (const fallback of receipt.fallbackHosts ?? []) {
    if (fallback.reclaimed !== true) problems.push(`fallback Host PID ${String(fallback.pid)} was not reclaimed`)
    if (pidAlive(fallback.pid)) problems.push(`fallback Host PID still alive: ${String(fallback.pid)}`)
    if (fallback.pgid !== undefined && groupAlive(fallback.pgid)) {
      problems.push(`fallback Host process group still alive: ${String(fallback.pgid)}`)
    }
  }
  if (pidAlive(receipt.supervisor?.pid)) problems.push(`Supervisor PID still alive: ${String(receipt.supervisor.pid)}`)
  return problems
}

function verifyUpgradePair(receipt, oldTgz, newTgz) {
  const pair = receipt.pair
  if (pair === undefined) fail('the upgrade receipt carries no pair facts')
  if (pair.old.sha256 !== sha256(oldTgz)) fail('the receipt old SHA256 does not match the actual old tarball')
  if (pair.new.sha256 !== sha256(newTgz)) fail('the receipt new SHA256 does not match the actual new tarball')
  if (pair.old.sha256 === pair.new.sha256) fail('the two artifacts have the same SHA256')
  if (pair.old.manifestPin !== pair.new.manifestPin) fail('the two artifacts declare different DSH pins')
}

async function main() {
const mode = arg('--mode')
const signal = arg('--signal') ?? 'SIGTERM'
const at = arg('--at')
if (!PILOT_MODES.includes(mode) && !UPGRADE_MODES.includes(mode)) {
  fail(`unknown --mode ${JSON.stringify(mode)}`)
}
if (mode === 'main-signal' && signal !== 'SIGINT' && signal !== 'SIGTERM') {
  fail('--mode main-signal requires --signal SIGINT or SIGTERM')
}
if (mode === 'worker-kill' && at !== 'two-clients-ready' && at !== 'host-spawned-before-ack') {
  fail('--mode worker-kill requires --at two-clients-ready or host-spawned-before-ack')
}
if (mode === 'upgrade-worker-kill' && !UPGRADE_ATS.includes(at)) {
  fail(`--mode upgrade-worker-kill requires --at ${UPGRADE_ATS.join('|')}`)
}
const upgradeMode = UPGRADE_MODES.includes(mode)

const tmpBase = requireEnv('SPLIT_VITEST_TMP_BASE')
let candidate
let oldTgz
let newTgz
if (upgradeMode) {
  oldTgz = requireEnv('SPLIT_VITEST_UPGRADE_OLD_TGZ')
  newTgz = requireEnv('SPLIT_VITEST_UPGRADE_NEW_TGZ')
  if (!existsSync(tmpBase) || !existsSync(oldTgz) || !existsSync(newTgz)) {
    fail('SPLIT_VITEST_TMP_BASE or an upgrade tarball does not exist')
  }
} else {
  candidate = requireEnv('SPLIT_VITEST_CANDIDATE_TGZ')
  if (!existsSync(tmpBase) || !existsSync(candidate)) fail('SPLIT_VITEST_TMP_BASE or SPLIT_VITEST_CANDIDATE_TGZ does not exist')
}
const runId = `split-vitest-probe-${String(process.pid)}-${String(Date.now())}`
const env = {
  ...process.env,
  SPLIT_VITEST_TMP_BASE: tmpBase,
  SPLIT_VITEST_RUN_ID: runId,
  ...(upgradeMode
    ? {
        SPLIT_VITEST_UPGRADE_OLD_TGZ: oldTgz,
        SPLIT_VITEST_UPGRADE_NEW_TGZ: newTgz,
      }
    : { SPLIT_VITEST_CANDIDATE_TGZ: candidate }),
}
if (mode === 'worker-kill') env.SPLIT_VITEST_WORKER_KILL_POINT = at
if (mode === 'upgrade-worker-kill' && (at === 'new-host-spawned-before-ack' || at === 'qualification-client-active')) {
  env.SPLIT_VITEST_UPGRADE_KILL_POINT = at
}
if (mode === 'upgrade-live-host-exit') {
  env.SPLIT_VITEST_UPGRADE_HOST_EXIT_AFTER_PROFILE_INSTALL = '1'
}
if (mode === 'upgrade-qualification-host-death') {
  env.SPLIT_VITEST_UPGRADE_QUALIFICATION_HOST_DEATH = '1'
}

const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
})
sentinel.unref()
if (sentinel.pid === undefined) fail('could not start the external sentinel process')

let child
let vitestPid
let siblingChild
let siblingRunId
let siblingStopFile
if (upgradeMode) {
  if (mode === 'upgrade-worker-kill' && (at === 'reload-child-active' || at === 'reload-child-started-before-report'
    || at === 'qualification-client-active')) {
    siblingRunId = `${runId}-sibling`
    siblingStopFile = join(tmpBase, `split-upgrade-sibling-stop-${String(process.pid)}.flag`)
    siblingChild = spawn(process.execPath, [
      '--import',
      'tsx/esm',
      'test/support/split-upgrade-probe-worker.mjs',
      '--scenario',
      'upgrade-sibling-live',
    ], {
      cwd: process.cwd(),
      env: {
        ...env,
        SPLIT_VITEST_RUN_ID: siblingRunId,
        SPLIT_UPGRADE_PROBE_SIBLING_STOP_FILE: siblingStopFile,
      },
      stdio: 'inherit',
    })
  }
  const scenario = mode === 'upgrade-worker-kill' ? `upgrade-worker-kill:${at}` : mode
  child = spawn(process.execPath, [
    '--import',
    'tsx/esm',
    'test/support/split-upgrade-probe-worker.mjs',
    '--scenario',
    scenario,
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  vitestPid = process.pid
} else {
  child = spawn(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.split.config.ts',
    '--project',
    'split-process',
    'test/integration/split-multi-client.vitest.ts',
    '-t',
    'first real Question',
  ], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    detached: mode === 'foreground-group-sigint',
  })
  vitestPid = child.pid
}

let childExited = false
let killedWorkerPid
let siblingReceipt
try {
  let deadline
  if (siblingChild !== undefined) {
    siblingReceipt = await waitUntil(() => {
      const current = latestUpgradeReceipt(tmpBase, siblingRunId)
      const live = (current?.notes ?? []).some(note => note.event === 'sibling-live')
      if (!live || !existsSync(current?.sceneRoot ?? '')) return undefined
      return pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid)
        && (current?.clients ?? []).every(client => pidAlive(client.shellPid)
          && (client.businessPids ?? []).every(pid => pidAlive(pid)))
        ? current : undefined
    }, 'live sibling Upgrade Scene', 600_000)
  }
  if (upgradeMode) {
    if (mode === 'upgrade-qualification-host-death') {
      // Controlled negative for the discovery-fallback window: old Host A dies
      // after the Supervisor's status-before proof and before the real
      // qualification Client's ensureLocalHost(). The operation must refuse and
      // the Supervisor must reclaim the detached Host that fallback started,
      // with a strict terminal proof (no live Host/Client/group/seat/root).
      const exit = await waitChildExit(child, 900_000)
      childExited = true
      if (exit.code !== 0 || exit.signal !== null) {
        fail(`upgrade-qualification-host-death worker exited abnormally: ${JSON.stringify(exit)}`)
      }
      const terminalReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return current?.phase === 'ABORTED_CLEAN' ? current : undefined
      }, 'upgrade-qualification-host-death ABORTED_CLEAN', 120_000)
      verifyUpgradePair(terminalReceipt, oldTgz, newTgz)
      if (!Array.isArray(terminalReceipt.hosts) || terminalReceipt.hosts.length !== 1) {
        fail(`upgrade-qualification-host-death: expected one Host generation, got ${String(terminalReceipt.hosts?.length)}`)
      }
      const injected = (terminalReceipt.notes ?? []).some(note => note.event === 'qualification-host-death-injected')
      if (!injected) fail('upgrade-qualification-host-death: the receipt carries no injected Host-death note')
      if (terminalReceipt.hosts[0].exitSignal !== 'SIGKILL') {
        fail(`upgrade-qualification-host-death: the injected Host did not die by SIGKILL: ${JSON.stringify(terminalReceipt.hosts[0].exitSignal)}`)
      }
      if ((terminalReceipt.qualificationClients ?? []).some(entry => entry.exited !== true)) {
        fail('upgrade-qualification-host-death: a qualification Client did not exit')
      }
      const fallbacks = terminalReceipt.fallbackHosts ?? []
      if (fallbacks.length === 0) {
        fail('upgrade-qualification-host-death: the injected Host death did not exercise the discovery fallback')
      }
      const scopeId = terminalReceipt.hosts[0].scopeId
      if (typeof scopeId !== 'string' || scopeId === '') {
        fail('upgrade-qualification-host-death: the terminal receipt carries no Host scope id')
      }
      if (!(await hostSeatFree(scopeId))) {
        fail('upgrade-qualification-host-death: the Host seat is still held after cleanup')
      }
      const problems = checkUpgradeReceiptResources(terminalReceipt)
      if (problems.length > 0) fail(problems.join('; '))
      checkNoLingeringPaths(terminalReceipt)
      if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        runId,
        workerPid: terminalReceipt.worker.pid,
        supervisorPid: terminalReceipt.supervisor?.pid,
        supervisorPhase: terminalReceipt.phase,
        hosts: terminalReceipt.hosts,
        qualificationClients: terminalReceipt.qualificationClients,
        fallbackHosts: fallbacks,
        hostSeatFree: true,
        sceneRoot: terminalReceipt.sceneRoot,
        sentinelPid: sentinel.pid,
      })}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} supervisor_phase=${terminalReceipt.phase} fallback_hosts=${String(fallbacks.length)}`)
      return
    }
    if (mode === 'upgrade-live-host-exit') {
      const exit = await waitChildExit(child, 600_000)
      childExited = true
      if (exit.code !== 0 || exit.signal !== null) fail(`upgrade-live-host-exit worker exited abnormally: ${JSON.stringify(exit)}`)
      const terminalReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return current?.phase === 'ABORTED_CLEAN' ? current : undefined
      }, 'upgrade-live-host-exit ABORTED_CLEAN', 60_000)
      verifyUpgradePair(terminalReceipt, oldTgz, newTgz)
      if (!Array.isArray(terminalReceipt.hosts) || terminalReceipt.hosts.length !== 1) {
        fail(`upgrade-live-host-exit: expected one Host generation, got ${String(terminalReceipt.hosts?.length)}`)
      }
      const problems = checkUpgradeReceiptResources(terminalReceipt)
      if (problems.length > 0) fail(problems.join('; '))
      checkNoLingeringPaths(terminalReceipt)
      if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        runId,
        workerPid: terminalReceipt.worker.pid,
        supervisorPid: terminalReceipt.supervisor?.pid,
        supervisorPhase: terminalReceipt.phase,
        hosts: terminalReceipt.hosts,
        sceneRoot: terminalReceipt.sceneRoot,
        sentinelPid: sentinel.pid,
      })}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} supervisor_phase=${terminalReceipt.phase} host_exit=${JSON.stringify(terminalReceipt.hosts[0].exitSignal)}`)
      return
    }
    if (mode === 'upgrade-sequential-hosts' || mode === 'upgrade-live-profile-refusal') {
      const finalReceipt = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return current?.phase === 'FINALIZED' ? current : undefined
      }, `${mode} FINALIZED`, 900_000)
      const exit = await waitChildExit(child, 30_000)
      childExited = true
      if (exit.code !== 0 || exit.signal !== null) fail(`upgrade worker exited abnormally: ${JSON.stringify(exit)}`)
      verifyUpgradePair(finalReceipt, oldTgz, newTgz)
      if (!Array.isArray(finalReceipt.hosts) || finalReceipt.hosts.length !== 2) {
        fail(`${mode}: expected exactly two Host generations, got ${String(finalReceipt.hosts?.length)}`)
      }
      for (const host of finalReceipt.hosts) {
        if (host.exitCode !== 0 || host.exitSignal !== null) fail(`Host generation ${String(host.generation)} did not exit 0: ${JSON.stringify(host)}`)
      }
      if (mode === 'upgrade-sequential-hosts' && finalReceipt.hosts[0].buildId === finalReceipt.hosts[1].buildId) {
        fail(`${mode}: the two generations published the same buildId`)
      }
      if (mode === 'upgrade-live-profile-refusal' && finalReceipt.hosts[0].buildId !== finalReceipt.hosts[1].buildId) {
        fail(`${mode}: the old profile and side-old generations must publish the same old buildId`)
      }
      if (finalReceipt.hosts[0].pid === finalReceipt.hosts[1].pid) fail(`${mode}: the two generations reused one PID`)
      if (mode === 'upgrade-live-profile-refusal') {
        if (finalReceipt.profile?.old?.version !== finalReceipt.pair.old.version) fail('live-profile-refusal: the old profile facts are missing')
        if (finalReceipt.profile?.newForReload?.version !== finalReceipt.pair.new.version) fail('live-profile-refusal: the legal new-for-reload install facts are missing')
      }
      const problems = checkUpgradeReceiptResources(finalReceipt)
      if (problems.length > 0) fail(problems.join('; '))
      checkNoLingeringPaths(finalReceipt)
      if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        runId,
        workerPid: finalReceipt.worker.pid,
        supervisorPid: finalReceipt.supervisor?.pid,
        supervisorPhase: finalReceipt.phase,
        hosts: finalReceipt.hosts,
        clients: finalReceipt.clients,
        pair: finalReceipt.pair,
        sceneRoot: finalReceipt.sceneRoot,
      })}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} supervisor_phase=${finalReceipt.phase} generations=${String(finalReceipt.hosts.length)}`)
      return
    }
    const barrierPoint = mode === 'upgrade-worker-kill' ? at : undefined
    if (barrierPoint === 'side-build-install') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        // Bind to the authoritative NEW side operation, not merely any current
        // install flag: the old bootstrap writes the same boolean earlier.
        return isSideNewInstallInProgress(current) ? current : undefined
      }, 'new side-build install currently in progress', 300_000)
    } else if (barrierPoint === 'bootstrap-install') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        return isBootstrapInstallInProgress(current) ? current : undefined
      }, 'old bootstrap install currently in progress', 300_000)
    } else if (barrierPoint === 'new-host-spawned-before-ack') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const barrierHit = (current?.notes ?? []).some(note => note.event === 'host-spawned-before-ack-barrier' && note.detail?.generation === 2)
        return barrierHit ? current : undefined
      }, 'second Host spawned before ACK', 600_000)
    } else if (barrierPoint === 'reload-child-active' || barrierPoint === 'reload-child-started-before-report') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const note = (current?.notes ?? []).find(value => value.event === 'worker-kill-point'
          && value.detail?.point === barrierPoint)
        if (note === undefined || !pidAlive(current?.host?.pid) || !groupAlive(current?.host?.pgid)) return undefined
        if (barrierPoint === 'reload-child-started-before-report') {
          return pidAlive(note.detail?.oldPid) && pidAlive(note.detail?.replacementPid) ? current : undefined
        }
        const client = (current?.clients ?? []).find(value => value.label === 'reload-child-active-client')
        const pids = client?.businessPids ?? []
        return pids.length >= 2 && pids.every(pid => pidAlive(pid)) ? current : undefined
      }, `reload replacement child at ${barrierPoint}`, 600_000)
    } else if (barrierPoint === 'qualification-client-active') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const ledger = Array.isArray(current?.qualificationClients) ? current.qualificationClients : []
        const qualification = ledger.at(-1)
        if (qualification === undefined || qualification.exited === true
          || !pidAlive(qualification.pid) || !groupAlive(qualification.pgid)) {
          return undefined
        }
        return pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid) ? current : undefined
      }, 'one-shot qualification Client active', 600_000)
    } else if (barrierPoint === 'old-host-ready') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const hit = (current?.notes ?? []).some(note => note.event === 'worker-kill-point' && note.detail?.point === 'old-host-ready')
        return hit && pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid) ? current : undefined
      }, 'old Host ready barrier', 600_000)
    } else if (barrierPoint === 'between-host-generations') {
      await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, runId)
        const hit = (current?.notes ?? []).some(note => note.event === 'worker-kill-point' && note.detail?.point === 'between-host-generations')
        return hit ? current : undefined
      }, 'between Host generations barrier', 600_000)
    }
    const receipt = latestUpgradeReceipt(tmpBase, runId)
    if (barrierPoint === 'bootstrap-install' && isSideNewInstallInProgress(receipt)) {
      fail('old-bootstrap-only kill incorrectly satisfied the side-new install selector')
    }
    killedWorkerPid = upgradeWorkerKillTarget(receipt, barrierPoint)
    if (process.kill(killedWorkerPid, 'SIGKILL') === false) {
      fail(`could not SIGKILL verified upgrade worker PID ${String(killedWorkerPid)}`)
    }
    deadline = Date.now() + (barrierPoint === 'side-build-install' || barrierPoint === 'bootstrap-install' ? 240_000 : 60_000)
    const exit = await waitChildExit(child, Math.max(1, deadline - Date.now()))
    childExited = true
    if (exit.code === 0 && exit.signal === null) fail(`upgrade worker unexpectedly exited 0 under ${mode}/${String(at)}`)
    await waitForPidGone(killedWorkerPid, Math.max(1, deadline - Date.now()))
    const terminalReceipt = await waitUntil(() => {
      const current = latestUpgradeReceipt(tmpBase, runId)
      if (current?.phase !== 'ABORTED_CLEAN' && current?.phase !== 'NOT_QUIESCED') return undefined
      return current
    }, 'Supervisor ABORTED_CLEAN/NOT_QUIESCED', Math.max(1, deadline - Date.now()))
    await sleep(Math.min(300, Math.max(1, deadline - Date.now())))
    if (terminalReceipt.phase !== 'ABORTED_CLEAN') {
      fail(`upgrade worker kill ended ${String(terminalReceipt.phase)}: ${String(terminalReceipt.errorName)}`)
    }
    const problems = checkUpgradeReceiptResources(terminalReceipt, {
      allowNoHosts: barrierPoint === 'side-build-install' || barrierPoint === 'bootstrap-install',
    })
    if (problems.length > 0) fail(problems.join('; '))
    if (Date.now() > deadline) fail('probe exceeded its single fixed post-trigger deadline')
    if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
    let siblingFinal
    if (siblingChild !== undefined) {
      const liveSibling = latestUpgradeReceipt(tmpBase, siblingRunId)
      if (liveSibling === undefined || !existsSync(liveSibling.sceneRoot ?? '')
        || !pidAlive(liveSibling.host?.pid) || !groupAlive(liveSibling.host?.pgid)
        || (liveSibling.clients ?? []).some(client => !pidAlive(client.shellPid)
          || (client.businessPids ?? []).some(pid => !pidAlive(pid)))) {
        fail('the sibling Upgrade Scene was not live when the killed Scene was reclaimed')
      }
      writeFileSync(siblingStopFile, 'stop\n', { mode: 0o600 })
      const siblingExit = await waitChildExit(siblingChild, 300_000)
      if (siblingExit.code !== 0 || siblingExit.signal !== null) {
        fail(`sibling Upgrade worker exited abnormally: ${JSON.stringify(siblingExit)}`)
      }
      siblingFinal = await waitUntil(() => {
        const current = latestUpgradeReceipt(tmpBase, siblingRunId)
        return current?.phase === 'FINALIZED' ? current : undefined
      }, 'sibling Upgrade Scene FINALIZED', 120_000)
      const siblingProblems = checkUpgradeReceiptResources(siblingFinal)
      if (siblingProblems.length > 0) fail(`sibling Upgrade Scene: ${siblingProblems.join('; ')}`)
      console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
        mode,
        at: 'sibling-live',
        runId: siblingRunId,
        workerPid: siblingFinal.worker.pid,
        supervisorPhase: siblingFinal.phase,
        hosts: siblingFinal.hosts,
        clients: siblingFinal.clients,
        sceneRoot: siblingFinal.sceneRoot,
      })}`)
    }
    console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
      mode,
      at,
      runId,
      workerPid: killedWorkerPid,
      workerExit: exit,
      supervisorPid: terminalReceipt.supervisor?.pid,
      supervisorPhase: terminalReceipt.phase,
      hosts: terminalReceipt.hosts,
      clients: terminalReceipt.clients,
      sceneRoot: terminalReceipt.sceneRoot,
      siblingRunId,
      siblingFinalPhase: siblingFinal?.phase,
      sentinelPid: sentinel.pid,
    })}`)
    console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode} at=${String(at)} supervisor_phase=${terminalReceipt.phase} worker_exit=${JSON.stringify(exit)}`)
    return
  }

  if (mode === 'bootstrap-main-sigterm') {
    await waitUntil(() => {
      const receipt = latestReceipt(tmpBase, runId)
      return (receipt?.notes ?? []).some(note => note.event === 'bootstrap-root-created')
        && receipt?.install?.inProgress === true ? receipt : undefined
    }, 'BOOTSTRAP_ROOT_CREATED receipt', 60_000)
    if (child.kill('SIGTERM') === false) fail('could not signal the Vitest main process')
    deadline = Date.now() + 240_000
  } else if (mode === 'worker-kill') {
    const receipt = await waitUntil(() => {
      const current = latestReceipt(tmpBase, runId)
      if (at === 'host-spawned-before-ack') {
        const barrierHit = (current?.notes ?? []).some(note => note.event === 'host-spawned-before-ack-barrier')
        return barrierHit && pidAlive(current?.host?.pid) && groupAlive(current?.host?.pgid)
          ? current : undefined
      }
      return (current?.notes ?? []).some(note => note.event === 'worker-kill-point'
        && note.detail?.point === 'two-clients-ready') ? current : undefined
    }, `${mode}/${at} receipt`, 180_000)
    killedWorkerPid = workerKillTarget(receipt, at, vitestPid)
    if (process.kill(killedWorkerPid, 'SIGKILL') === false) {
      fail(`could not SIGKILL verified worker PID ${String(killedWorkerPid)}`)
    }
    deadline = Date.now() + 30_000
  } else {
    const readyReceipt = await waitUntil(() => {
      const receipt = latestReceipt(tmpBase, runId)
      return receipt?.phase === 'HOST_READY' && (receipt.clients?.length ?? 0) >= 2 ? receipt : undefined
    }, 'HOST_READY with two Clients', 180_000)
    assertLiveReceipt(readyReceipt)
    if (mode === 'foreground-group-sigint') {
      process.kill(-child.pid, 'SIGINT')
    } else if (child.kill(signal) === false) {
      fail('could not signal the Vitest main process')
    }
    deadline = Date.now() + 30_000
  }

  const exit = await waitChildExit(child, Math.max(1, deadline - Date.now()))
  childExited = true
  if (exit.code === 0) fail(`Vitest unexpectedly exited 0 under ${mode}`)
  if (killedWorkerPid !== undefined) {
    await waitForPidGone(killedWorkerPid, Math.max(1, deadline - Date.now()))
  }
  const receipt = await waitUntil(() => {
    const current = latestReceipt(tmpBase, runId)
    return current?.phase === 'ABORTED_CLEAN' ? current : undefined
  }, 'Supervisor ABORTED_CLEAN', Math.max(1, deadline - Date.now()))
  await sleep(Math.min(300, Math.max(1, deadline - Date.now())))
  const problems = checkReceiptResources(receipt)
  if (problems.length > 0) fail(problems.join('; '))
  checkNoLingeringPaths(receipt)
  if (Date.now() > deadline) fail('probe exceeded its single fixed post-trigger deadline')
  if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
  console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FACTS ${JSON.stringify({
    mode,
    at,
    signal: mode === 'main-signal' ? signal : undefined,
    runId,
    vitestPid: child.pid,
    workerPid: killedWorkerPid,
    vitestExit: exit,
    supervisorPid: receipt.supervisor?.pid,
    supervisorPhase: receipt.phase,
    hostPid: receipt.host?.businessPid ?? receipt.host?.pid,
    clientPids: (receipt.clients ?? []).map(client => client.shellPid),
    sceneRoot: receipt.sceneRoot,
    sentinelPid: sentinel.pid,
  })}`)
  console.log(`SPLIT_SUPERVISOR_SIGNAL_PROBE_PASS mode=${mode}${at === undefined ? '' : ` at=${at}`}${mode === 'main-signal' ? ` signal=${signal}` : ''} vitest_exit=${JSON.stringify(exit)} supervisor_phase=${receipt.phase}`)
} finally {
  if (!childExited && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  if (siblingChild !== undefined && siblingChild.exitCode === null && siblingChild.signalCode === null) {
    try { siblingChild.kill('SIGKILL') } catch { /* already gone */ }
  }
  if (siblingStopFile !== undefined) {
    try { unlinkSync(siblingStopFile) } catch { /* not created */ }
  }
  try { process.kill(-sentinel.pid, 'SIGKILL') } catch {
    try { sentinel.kill('SIGKILL') } catch { /* already gone */ }
  }
}
}

main().catch(error => {
  if (process.exitCode !== 1) {
    console.error(`SPLIT_SUPERVISOR_SIGNAL_PROBE_FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  }
})
