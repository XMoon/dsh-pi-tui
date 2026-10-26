/**
 * The process-group ownership contract the two wrappers depend on.
 *
 * These cases use the REAL shape both wrappers own: a group leader that dies
 * on the forwarded signal, and a descendant that ignores it. They cover the
 * probe a normally-finishing wrapper uses, the bounded escalation, and the
 * identity rules that decide whether an escalation may be sent at all.
 *
 * @module test/tooling/owned-process-group.test
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { isExecuting, killStillExecuting, startTimeOf, waitForNoExecuting } from '../support/pid-records.ts'
import { waitForFileLine } from '../support/wait-for-file.ts'
import { groupStillAlive, stopOwnedGroup } from '../../scripts/lib/owned-process-group.mjs'

const HOLDER = fileURLToPath(new URL('../fixtures/signal-tree/holder.mjs', import.meta.url))
const POSIX_ONLY = process.platform === 'win32' ? 'process groups are POSIX-only' : false
// These cases read REAL /proc identities; on POSIX without /proc they would
// pass for the wrong reason, so they are Linux-gated and the macOS boundary is
// reported as NOT_VERIFIED rather than exercised.
const PROC_ONLY = process.platform !== 'linux' ? 'the verifiable-identity escalation needs /proc' : false

/**
 * Start one owned group: the leader dies on the forwarded signal, and the
 * descendant it started ignores it.
 */
async function startOwnedGroup(t, prefix) {
  const life = testLifecycle(t)
  const dir = life.tempDir(prefix)
  const marker = join(dir, 'evidence.log')
  const child = spawn(process.execPath, [HOLDER], {
    env: { ...process.env, PROBE_MARKER: marker },
    stdio: 'ignore',
    // The leader must lead its OWN group, exactly as the wrappers spawn it.
    detached: true,
  })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  life.defer(() => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* the group is already gone */ }
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  })
  const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
  const [, rawPid] = ready.split(' ')
  const descendant = { kind: 'descendant', pid: Number(rawPid), startTime: startTimeOf(Number(rawPid)) }
  life.defer(() => { killStillExecuting([descendant]) })
  return { child, descendant, exited }
}

test('the group probe reports a live descendant and never signals it', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-probe-')
  assert.equal(groupStillAlive(child), true, 'a live descendant keeps the group alive')
  assert.equal(isExecuting(descendant), true, 'the probe must not signal anything')
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  await exited
  assert.equal(groupStillAlive(child), true,
    'the group survives its leader: a normal-close check must still see the descendant')
})

test('a verifiable group is escalated to SIGKILL after its leader exits', { skip: POSIX_ONLY || PROC_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-escalate-')
  // reason: the grace is the behaviour under test — 300 ms is the bounded wait
  // that lets the leader exit BEFORE the escalation, which is the guarded case.
  const settled = await stopOwnedGroup(child, 'SIGTERM', { graceMs: 300, settleMs: 2_000 })
  assert.equal(settled, true)
  await exited
  const survivors = await waitForNoExecuting([descendant], 5_000)
  assert.deepEqual(survivors, [], `the SIGKILL escalation ended the TERM-ignoring descendant: ${JSON.stringify(survivors)}`)
})

test('an unverifiable group is not escalated: the survivor is reported, never killed', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-unverifiable-')
  const settled = await stopOwnedGroup(child, 'SIGTERM', {
    graceMs: 300,
    settleMs: 300,
    // A platform without /proc cannot prove the numeric pgid still names OUR
    // group once the leader is gone, so the escalation must fail closed.
    statStartTime: () => undefined,
  })
  assert.equal(settled, false)
  await exited
  assert.equal(isExecuting(descendant), true, 'an unproven group must never receive SIGKILL')
})

test('a free leader slot without a surviving ownership witness is not escalated', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-no-witness-')
  // The reviewer's shape: the leader identity was readable at signal time, and
  // it is gone by escalation time. With no recorded witness the numeric pgid
  // proves nothing, so the escalation must not be sent.
  const startTimes = ['ours', undefined]
  let index = 0
  const settled = await stopOwnedGroup(child, 'SIGTERM', {
    graceMs: 300,
    settleMs: 300,
    statStartTime: () => startTimes[Math.min(index++, startTimes.length - 1)],
    captureWitnesses: () => [],
  })
  assert.equal(settled, false)
  await exited
  assert.equal(isExecuting(descendant), true, 'an unproven group must never receive SIGKILL')
})

test('a witness whose pid was reused is not ownership', { skip: POSIX_ONLY || PROC_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-reused-witness-')
  const startTimes = ['ours', undefined]
  let index = 0
  const settled = await stopOwnedGroup(child, 'SIGTERM', {
    graceMs: 300,
    settleMs: 300,
    statStartTime: () => startTimes[Math.min(index++, startTimes.length - 1)],
    // Same pid, DIFFERENT start time: a recycled process, not our witness.
    captureWitnesses: () => [{ pid: descendant.pid, startTime: 'not-this-process' }],
  })
  assert.equal(settled, false)
  await exited
  assert.equal(isExecuting(descendant), true, 'a recycled pid must never authorize SIGKILL')
})

test('a witness outside the group or session is not ownership', { skip: POSIX_ONLY || PROC_ONLY, timeout: 30_000 }, async (t) => {
  const { child, exited } = await startOwnedGroup(t, 'owned-group-wrong-group-')
  const startTimes = ['ours', undefined]
  let index = 0
  const settled = await stopOwnedGroup(child, 'SIGTERM', {
    graceMs: 300,
    settleMs: 300,
    statStartTime: () => startTimes[Math.min(index++, startTimes.length - 1)],
    // This process IS running, but it is not a member of the wrapper's group or
    // session: a live process is not a witness.
    captureWitnesses: () => [{ pid: process.pid, startTime: startTimeOf(process.pid) }],
  })
  assert.equal(settled, false)
  await exited
})

test('a recorded witness proves the group after the leader was reaped and the escalation runs', { skip: POSIX_ONLY || PROC_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-witness-')
  // Force the unreadable-identity branch: the leader identity is 'ours' at
  // signal time and unavailable at escalation time. The recorded witness is
  // the descendant itself, so ownership is proven and the escalation must run.
  const startTimes = ['ours', undefined]
  let index = 0
  const settled = await stopOwnedGroup(child, 'SIGTERM', {
    graceMs: 300,
    settleMs: 2_000,
    statStartTime: () => startTimes[Math.min(index++, startTimes.length - 1)],
    captureWitnesses: () => [{ pid: descendant.pid, startTime: descendant.startTime }],
  })
  assert.equal(settled, true)
  await exited
  const survivors = await waitForNoExecuting([descendant], 5_000)
  assert.deepEqual(survivors, [], `a verified witness authorizes the SIGKILL escalation: ${JSON.stringify(survivors)}`)
})

test('a reused pgid is never signalled', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { child, descendant, exited } = await startOwnedGroup(t, 'owned-group-reused-')
  // The read while the leader is alive is OUR start time; the read at
  // escalation time reports a DIFFERENT process under the same pid.
  const reads = ['ours', 'theirs']
  let index = 0
  const settled = await stopOwnedGroup(child, 'SIGTERM', {
    graceMs: 300,
    settleMs: 300,
    statStartTime: () => reads[Math.min(index++, reads.length - 1)],
  })
  assert.equal(settled, false)
  await exited
  assert.equal(isExecuting(descendant), true, 'a reused pgid must never receive SIGKILL')
})
