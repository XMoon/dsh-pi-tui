#!/usr/bin/env node
/**
 * S0 external signal/parent-death probe.
 *
 * This file is deliberately outside the test body: it drives real vitest
 * processes and checks OS process state, so a passing Vitest assertion cannot
 * stand in for resource release. It never kills a process by a guessed PID;
 * the Supervisor receipt names the exact Host/Client identities it owns.
 *
 * Modes:
 *   --mode main-signal --signal SIGINT|SIGTERM
 *   --mode foreground-group-sigint
 *   --mode worker-kill --at two-clients-ready|host-spawned-before-ack
 *   --mode bootstrap-main-sigterm
 *
 * Required env: S0_TMP_BASE, S0_CANDIDATE_TGZ.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

function arg(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`S0_SIGNAL_PROBE_FAIL: ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function requireEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value === '') fail(`${name} must be set`)
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

async function waitChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      reject(new Error(`Vitest did not exit within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const onClose = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('close', onClose)
  })
}

function receipts(tmpBase, runId) {
  const root = join(tmpBase, 's0-resources')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name.endsWith('.json'))
    .flatMap(name => {
      try {
        const value = JSON.parse(readFileSync(join(root, name), 'utf8'))
        return value.runId === runId ? [value] : []
      } catch {
        return []
      }
    })
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

function checkNoLingeringPaths(tmpBase, receipt) {
  let commands
  try {
    commands = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
  } catch (error) {
    fail(`could not inspect OS process commands: ${error instanceof Error ? error.message : String(error)}`)
  }
  const needles = [tmpBase, receipt.sceneRoot].filter(value => typeof value === 'string' && value !== '')
  const lingering = commands.split('\n').filter(line => {
    const trimmed = line.trim()
    if (trimmed === '') return false
    if (trimmed.includes('s0-supervisor-signal-probe.mjs')) return false
    if (trimmed.includes('S0_TMP_BASE') || trimmed.includes('S0_CANDIDATE_TGZ')) return false
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
  }
  if (pidAlive(receipt.supervisor?.pid)) problems.push(`Supervisor PID still alive: ${String(receipt.supervisor.pid)}`)
  return problems
}

const mode = arg('--mode')
const signal = arg('--signal') ?? 'SIGTERM'
const at = arg('--at')
if (!['main-signal', 'foreground-group-sigint', 'worker-kill', 'bootstrap-main-sigterm'].includes(mode)) {
  fail(`unknown --mode ${JSON.stringify(mode)}`)
}
if (mode === 'main-signal' && signal !== 'SIGINT' && signal !== 'SIGTERM') {
  fail(`--mode main-signal requires --signal SIGINT or SIGTERM`)
}
if (mode === 'worker-kill' && at !== 'two-clients-ready' && at !== 'host-spawned-before-ack') {
  fail(`--mode worker-kill requires --at two-clients-ready or host-spawned-before-ack`)
}

const tmpBase = requireEnv('S0_TMP_BASE')
const candidate = requireEnv('S0_CANDIDATE_TGZ')
if (!existsSync(tmpBase) || !existsSync(candidate)) fail('S0_TMP_BASE or S0_CANDIDATE_TGZ does not exist')
const runId = `s0-probe-${String(process.pid)}-${String(Date.now())}`
const env = {
  ...process.env,
  S0_TMP_BASE: tmpBase,
  S0_CANDIDATE_TGZ: candidate,
  S0_RUN_ID: runId,
}
if (mode === 'worker-kill') env.S0_PROBE_WORKER_KILL_POINT = at

const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'ignore',
})
sentinel.unref()
if (sentinel.pid === undefined) fail('could not start the external sentinel process')

const child = spawn(process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config',
  'vitest.s0.config.ts',
  'test/integration/split-multi-client.vitest.ts',
  '-t',
  'first real Question',
], {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  detached: mode === 'foreground-group-sigint',
})

let childExited = false
try {
  let deadline
  if (mode === 'bootstrap-main-sigterm') {
    await waitUntil(() => {
      const receipt = latestReceipt(tmpBase, runId)
      return (receipt?.notes ?? []).some(note => note.event === 'bootstrap-root-created')
        && receipt?.install?.inProgress === true ? receipt : undefined
    }, 'BOOTSTRAP_ROOT_CREATED receipt', 60_000)
    if (child.kill('SIGTERM') === false) fail('could not signal the Vitest main process')
    deadline = Date.now() + 240_000
  } else if (mode === 'worker-kill') {
    await waitUntil(() => {
      const receipt = latestReceipt(tmpBase, runId)
      if (at === 'host-spawned-before-ack') {
        const hostSpawned = (receipt?.notes ?? []).some(note => note.event === 'host-spawned')
          || receipt?.phase === 'HOST_SPAWNED'
        return hostSpawned && pidAlive(receipt?.host?.pid) && groupAlive(receipt?.host?.pgid)
          ? receipt : undefined
      }
      return (receipt?.notes ?? []).some(note => note.event === 'worker-kill-point'
        && note.detail?.point === 'two-clients-ready') ? receipt : undefined
    }, `${mode}/${at} receipt`, 180_000)
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
  const receipt = await waitUntil(() => {
    const current = latestReceipt(tmpBase, runId)
    return current?.phase === 'ABORTED_CLEAN' ? current : undefined
  }, 'Supervisor ABORTED_CLEAN', Math.max(1, deadline - Date.now()))
  await sleep(Math.min(300, Math.max(1, deadline - Date.now())))
  const problems = checkReceiptResources(receipt)
  if (problems.length > 0) fail(problems.join('; '))
  checkNoLingeringPaths(tmpBase, receipt)
  if (Date.now() > deadline) fail('probe exceeded its single fixed post-trigger deadline')
  if (!pidAlive(sentinel.pid)) fail(`external sentinel PID ${String(sentinel.pid)} died; the probe touched an unrelated process`)
  console.log(`S0_SIGNAL_PROBE_FACTS ${JSON.stringify({
    mode,
    at,
    signal: mode === 'main-signal' ? signal : undefined,
    runId,
    vitestPid: child.pid,
    workerPid: (receipt.notes ?? []).find(note => note.event === 'worker-kill-point')?.detail?.workerPid,
    vitestExit: exit,
    supervisorPid: receipt.supervisor?.pid,
    supervisorPhase: receipt.phase,
    hostPid: receipt.host?.businessPid ?? receipt.host?.pid,
    clientPids: (receipt.clients ?? []).map(client => client.shellPid),
    sceneRoot: receipt.sceneRoot,
    sentinelPid: sentinel.pid,
  })}`)
  console.log(`S0_SIGNAL_PROBE_PASS mode=${mode}${at === undefined ? '' : ` at=${at}`}${mode === 'main-signal' ? ` signal=${signal}` : ''} vitest_exit=${JSON.stringify(exit)} supervisor_phase=${receipt.phase}`)
} finally {
  if (!childExited && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  try { process.kill(-sentinel.pid, 'SIGKILL') } catch {
    try { sentinel.kill('SIGKILL') } catch { /* already gone */ }
  }
}
