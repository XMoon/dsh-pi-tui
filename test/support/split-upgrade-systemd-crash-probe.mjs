#!/usr/bin/env node
/**
 * External Worker SIGKILL probe for the real systemd upgrade scene.
 *
 * The probe starts the existing native Vitest project, waits for its durable
 * `native-kill-ready` receipt point, verifies the Supervisor and exact Worker,
 * sends SIGKILL only to that Worker, and then audits the Supervisor receipt and
 * the real OS manager. It never kills a Host, the Supervisor or the user
 * manager, and it never runs a second native cleanup.
 *
 * Usage:
 *   node test/support/split-upgrade-systemd-crash-probe.mjs \
 *     --at managed-install-complete|managed-host-client-attached
 *
 * Required input is the same isolated environment as the native business test:
 * SPLIT_PROCESS_MANAGED_HOST_ISOLATED=1,
 * SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME, SPLIT_VITEST_TMP_BASE,
 * SPLIT_VITEST_UPGRADE_OLD_TGZ, SPLIT_VITEST_UPGRADE_NEW_TGZ,
 * SPLIT_VITEST_RUN_ID and a real non-root user runtime directory.
 *
 * @module split-upgrade-systemd-crash-probe
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { inspectManagedService } from './split-upgrade-systemd-manager.mjs'
import { inspectSplitUpgradePair, readSplitUpgradePairEnvironment } from './split-upgrade-pair.mjs'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(SUPPORT_DIR, '..', '..'))
const KILL_POINTS = Object.freeze(['managed-install-complete', 'managed-host-client-attached'])
const RECEIPT_WAIT_MS = 600_000
const TERMINAL_WAIT_MS = 300_000
const SUPERVISOR_EXIT_WAIT_MS = 60_000
const CHILD_EXIT_WAIT_MS = 60_000

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function usage(message) {
  console.error(`RUN_OS_MANAGER_CLEANUP=FAIL: ${message}`)
  console.error('usage: node test/support/split-upgrade-systemd-crash-probe.mjs --at managed-install-complete|managed-host-client-attached')
}

function fail(message) {
  const error = new Error(message)
  Object.assign(error, { code: 'NATIVE_CRASH_PROBE_FAILED' })
  throw error
}

function requireEnvironment(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '') fail(`INPUT_UNQUALIFIED: ${name} is required`)
  return value
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

function readStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return tail[19] ?? null
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined
  }
}

function processState(pid, birth) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  if (!pidAlive(pid)) return 'gone'
  const ticks = readStartTicks(pid)
  if (ticks === undefined) return 'unknown'
  if (ticks === null) return 'gone'
  if (typeof birth !== 'string' || !birth.startsWith('linux:')) return 'unknown'
  return `linux:${ticks}` === birth ? 'alive' : 'different'
}

function hostProcessState(identity) {
  if (identity === null || typeof identity !== 'object') return 'unknown'
  return processState(Number(identity.pid), identity.kernelIdentity)
}

function requireAbsoluteDirectory(raw, label) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) fail(`INPUT_UNQUALIFIED: ${label} must be an absolute path`)
  const real = realpathSync(raw)
  const info = statSync(real)
  if (!info.isDirectory()) fail(`INPUT_UNQUALIFIED: ${label} is not a directory`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (info.uid !== uid) fail(`INPUT_UNQUALIFIED: ${label} is not owned by this user`)
  if ((info.mode & 0o777) !== 0o700) fail(`INPUT_UNQUALIFIED: ${label} must have mode 0700`)
  const rel = relative(REPO_ROOT, real)
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) fail(`INPUT_UNQUALIFIED: ${label} must be outside the checkout`)
  return real
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function findKillReadyReceipt(receiptDir, runId, point) {
  if (!existsSync(receiptDir)) return undefined
  for (const name of readdirSync(receiptDir)) {
    if (!name.endsWith('.json')) continue
    const receipt = readReceipt(join(receiptDir, name))
    if (receipt === undefined) continue
    if (receipt?.parentRunId !== runId && !String(receipt?.runId ?? '').startsWith(`${runId}-`)) continue
    if (receipt?.native === null || receipt?.native === undefined) continue
    const notes = Array.isArray(receipt.notes) ? receipt.notes : []
    const ready = notes.find(note => note?.event === 'native-kill-ready' && note?.detail?.point === point)
    if (ready !== undefined) return { path: join(receiptDir, name), receipt }
  }
  return undefined
}

async function waitForKillReadyReceipt(receiptDir, runId, point) {
  const deadline = Date.now() + RECEIPT_WAIT_MS
  while (Date.now() < deadline) {
    const found = findKillReadyReceipt(receiptDir, runId, point)
    if (found !== undefined) return found
    await sleep(200)
  }
  fail(`the Supervisor never published the ${point} kill-ready receipt`)
}

async function waitForTerminalReceipt(path) {
  const deadline = Date.now() + TERMINAL_WAIT_MS
  while (Date.now() < deadline) {
    const receipt = readReceipt(path)
    if (receipt?.phase === 'ABORTED_CLEAN' || receipt?.phase === 'NOT_QUIESCED') return receipt
    await sleep(200)
  }
  fail('the Supervisor receipt did not reach a terminal phase after the Worker SIGKILL')
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return
    await sleep(100)
  }
  return false
}

async function waitChildGone(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ])
  return exited
}

function verifiedRuntimeDir(uid) {
  const runtimeDir = `/run/user/${String(uid)}`
  const info = lstatSync(runtimeDir)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) fail('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: the user runtime directory is unavailable')
  return runtimeDir
}

function auditReceipt(receipt, point) {
  const problems = []
  const native = receipt?.native
  if (native === null || native === undefined) problems.push('the terminal receipt carries no native record')
  if (receipt?.phase !== 'ABORTED_CLEAN') problems.push(`the terminal phase is ${String(receipt?.phase)}`)
  if (native?.cleanup?.attempted !== true) problems.push('the native cleanup was not attempted')
  const state = native?.observed?.state
  if (state !== 'removed' && state !== 'reserved-but-absent') problems.push(`the managed service state is ${String(state)}`)
  if (point === 'managed-host-client-attached') {
    if (native?.cleanup?.officialStop !== 'exited-0') problems.push(`the official stop result is ${String(native?.cleanup?.officialStop)}`)
    if (native?.cleanup?.officialUninstall !== 'exited-0') problems.push(`the official uninstall result is ${String(native?.cleanup?.officialUninstall)}`)
  } else if (native?.cleanup?.officialUninstall !== 'exited-0') {
    problems.push(`the official uninstall result is ${String(native?.cleanup?.officialUninstall)}`)
  }
  if (typeof receipt?.sceneRoot === 'string' && existsSync(receipt.sceneRoot)) problems.push('the Scene root still exists')
  for (const identity of Array.isArray(native?.hostIdentities) ? native.hostIdentities : []) {
    const hostState = hostProcessState(identity)
    if (hostState === 'alive' || hostState === 'unknown') {
      problems.push(`the managed Host identity ${String(identity.pid)} is ${hostState}`)
    }
  }
  for (const client of Array.isArray(receipt?.clients) ? receipt.clients : []) {
    const nativeOs = client?.nativeOs
    if (nativeOs === undefined) continue
    const identities = [nativeOs.shell, ...(Array.isArray(nativeOs.business) ? nativeOs.business : [])].filter(Boolean)
    for (const identity of identities) {
      const clientState = processState(Number(identity.pid), identity.birth)
      if (clientState === 'alive' || clientState === 'unknown') {
        problems.push(`the Client ${String(client.label)} identity ${String(identity.pid)} is ${clientState}`)
      }
    }
  }
  if (typeof native?.reservation?.dshHome === 'string' && typeof native?.reservation?.scopeId === 'string') {
    const scopeDir = join(native.reservation.dshHome, 'run', 'dsh-pi-tui', native.reservation.scopeId)
    if (existsSync(join(scopeDir, 'instance.json'))) problems.push('the Host instance registry still exists')
    if (existsSync(join(scopeDir, 'launch.json'))) problems.push('the Host launch material still exists')
  }
  return problems
}

async function main() {
  const point = arg('--at')
  if (typeof point !== 'string' || !KILL_POINTS.includes(point)) {
    usage('--at must be one of the two real native kill points')
    process.exitCode = 2
    return
  }
  if (process.platform !== 'linux') fail(`platform ${process.platform} is not Linux`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (typeof uid !== 'number' || uid <= 0) fail('a real non-root uid is required')
  if (process.env.SPLIT_PROCESS_MANAGED_HOST_ISOLATED !== '1') fail('SPLIT_PROCESS_MANAGED_HOST_ISOLATED must be 1')
  const isolatedHome = requireEnvironment('SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME')
  const accountHome = realpathSync(userInfo().homedir)
  if (accountHome !== realpathSync(isolatedHome)) fail('the real account home is not the provisioned isolated home')
  if (!existsSync(join(accountHome, '.dsh-pi-tui-managed-host-isolated'))) fail('the isolated-home marker is missing')
  const tmpBase = requireAbsoluteDirectory(process.env.SPLIT_VITEST_TMP_BASE, 'SPLIT_VITEST_TMP_BASE')
  const runId = requireEnvironment('SPLIT_VITEST_RUN_ID')
  const oldTgz = requireEnvironment('SPLIT_VITEST_UPGRADE_OLD_TGZ')
  const newTgz = requireEnvironment('SPLIT_VITEST_UPGRADE_NEW_TGZ')
  inspectSplitUpgradePair(oldTgz, newTgz, { policy: 'native' })
  const runtimeDir = verifiedRuntimeDir(uid)
  const busPath = join(runtimeDir, 'bus')
  const managerEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeDir }
  if (existsSync(busPath)) managerEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
  else delete managerEnv.DBUS_SESSION_BUS_ADDRESS
  const probe = spawnSync('/usr/bin/systemctl', [
    '--user', '--no-pager', '--no-ask-password', 'show-environment',
  ], { encoding: 'utf8', timeout: 15_000, env: managerEnv })
  if (probe.status !== 0) fail('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment failed')
  const receiptDir = join(tmpBase, 'split-resources')
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 })
  const logPath = join(receiptDir, `${runId}-crash-probe.log`)
  const childEnv = {
    ...process.env,
    ...managerEnv,
    SPLIT_VITEST_NATIVE_KILL_POINT: point,
    SPLIT_VITEST_TMP_BASE: tmpBase,
    SPLIT_VITEST_UPGRADE_OLD_TGZ: oldTgz,
    SPLIT_VITEST_UPGRADE_NEW_TGZ: newTgz,
    SPLIT_VITEST_RUN_ID: runId,
    SPLIT_PROCESS_MANAGED_HOST_ISOLATED: '1',
    SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME: accountHome,
  }
  const child = spawn(process.execPath, [
    join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config', 'vitest.split.config.ts',
    '--project', 'split-upgrade-systemd',
  ], { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  let workerPid
  try {
    const found = await waitForKillReadyReceipt(receiptDir, runId, point)
    const receipt = found.receipt
    workerPid = Number(receipt?.worker?.pid)
    const supervisorPid = Number(receipt?.supervisor?.pid)
    if (!Number.isInteger(workerPid) || workerPid <= 0) fail('the kill-ready receipt carries no real Worker PID')
    if (receipt?.worker?.ppid !== child.pid) {
      fail(`the Worker PPID ${String(receipt?.worker?.ppid)} does not match the spawned Vitest PID ${String(child.pid)}`)
    }
    if (!pidAlive(workerPid)) fail('the Worker PID is not alive before the SIGKILL')
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0 || !pidAlive(supervisorPid)) {
      fail('the Supervisor PID is not alive before the SIGKILL')
    }
    const reservation = receipt?.native?.reservation
    if (reservation === null || reservation === undefined) fail('the kill-ready receipt carries no native reservation')
    const before = await inspectManagedService(reservation)
    if (before.file !== 'owned' || before.ownerVerified !== true || before.managerObserved !== true) {
      fail(`the managed service is not owned and observable before the SIGKILL (${String(before.reason)})`)
    }
    if (point === 'managed-install-complete') {
      if (before.managerState !== 'inactive' && before.managerState !== 'not-loaded') {
        fail(`the install-complete window is already ${String(before.managerState)}`)
      }
      if (before.mainPid !== null) fail('the install-complete window unexpectedly runs a Host')
    } else {
      if (before.managerState !== 'active') fail(`the client-attached window is ${String(before.managerState)}`)
      if (!Number.isInteger(before.mainPid) || before.mainPid <= 0) fail('the client-attached window has no manager MainPID')
      const hostIdentities = Array.isArray(receipt?.native?.hostIdentities) ? receipt.native.hostIdentities : []
      const host = hostIdentities.at(-1)
      if (host === undefined) fail('the client-attached window recorded no authenticated Host identity')
      if (host.pid !== before.mainPid) fail('the recorded Host PID does not match the manager MainPID')
      if (hostProcessState(host) !== 'alive') fail('the recorded managed Host is not a live kernel process before the SIGKILL')
      const clients = Array.isArray(receipt?.clients) ? receipt.clients : []
      if (clients.length === 0) fail('the client-attached window recorded no Client')
    }
    console.log(`KILL_POINT=${point}`)
    console.log(`WORKER_PID=${String(workerPid)}`)
    console.log(`SUPERVISOR_PID=${String(supervisorPid)}`)
    console.log(`MANAGED_UNIT=${String(reservation.unitName)}`)
    process.kill(workerPid, 'SIGKILL')
    const terminal = await waitForTerminalReceipt(found.path)
    const problems = auditReceipt(terminal, point)
    const after = await inspectManagedService(reservation)
    if (after.file !== 'absent' || after.managerState !== 'not-loaded' || after.managerObserved !== true) {
      problems.push(`the real user manager still reports file=${String(after.file)} state=${String(after.managerState)} observed=${String(after.managerObserved)}`)
    }
    if (existsSync(reservation.unitPath)) problems.push('the run-owned unit file still exists')
    if (terminal.phase === 'NOT_QUIESCED') {
      problems.push(`the Supervisor reported NOT_QUIESCED (${String(terminal?.native?.cleanup?.reason ?? terminal?.errorName ?? 'unknown')})`)
    }
    if (!(await waitForPidGone(supervisorPid, SUPERVISOR_EXIT_WAIT_MS))) {
      problems.push('the Supervisor is still alive after the terminal receipt')
    }
    if (problems.length > 0) {
      console.error(`RUN_OS_MANAGER_CLEANUP=FAIL: ${problems.join('; ')}`)
      console.error(`RECEIPT=${found.path}`)
      console.error(`PROBE_LOG=${logPath}`)
      process.exitCode = 1
      return
    }
    console.log(`RECEIPT_PHASE=${String(terminal.phase)}`)
    console.log(`RECEIPT=${found.path}`)
    console.log(`PROBE_LOG=${logPath}`)
    console.log('RUN_OS_MANAGER_CLEANUP=PASS')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      if (!(await waitChildGone(child, CHILD_EXIT_WAIT_MS))) {
        child.kill('SIGKILL')
        await waitChildGone(child, 10_000)
      }
    }
    log.end()
  }
}

main().catch(error => {
  console.error(`RUN_OS_MANAGER_CLEANUP=FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
