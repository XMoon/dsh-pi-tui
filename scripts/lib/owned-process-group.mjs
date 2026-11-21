#!/usr/bin/env node
/**
 * POSIX process-group ownership for a wrapper's DIRECT child.
 *
 * A wrapper forwards a signal to the process it spawned. That signal does NOT
 * reach the processes that child started — `node --test` workers, a shell's
 * command, pnpm's script processes — and the leader can exit while they keep
 * running (MEASURED: both `test/tooling/test-lane-runner.test.mjs` and
 * `test/tooling/run-with-temp-root.test.mjs` reproduce a TERM-ignoring
 * descendant surviving the wrapper, with the wrapper's disposable temp root —
 * its TMPDIR — deleted underneath it).
 *
 * This module owns two narrow facts:
 *
 *   - how to ADDRESS that tree: the wrapper spawns the direct child as the
 *     leader of its OWN process group, and this module sends signals ONLY to
 *     that captured group id;
 *   - how to PROVE it stopped: the whole-group probe `kill(-pgid, 0)`, a
 *     bounded grace on the forwarded signal, then ONE SIGKILL escalation.
 *
 * It does NOT own the child, its exit code, or the temp root: the caller keeps
 * those and decides what an UNPROVEN group means for its own resources. The
 * caller also asks `groupStillAlive()` after a NORMAL exit before deleting a
 * resource the group may still use — a direct child's `close` says nothing
 * about the group it led.
 *
 * IDENTITY. A numeric pgid is not an identity: once the leader has been reaped
 * its pid — and therefore the group id — can be reused. The escalation is
 * therefore gated on PROOF from the shared kernel-identity seam
 * (`src/runtime/native-process/identity.ts`, the same source the footer
 * consumes): either the leader itself is still the SAME kernel process, or a
 * WITNESS captured while the leader was verifiable is still the same process in
 * BOTH the group and the session this wrapper created. Leader reaping alone is
 * neither authorization nor a veto; missing evidence fails closed and the
 * caller reports the unproven group (macOS is no longer a fail-closed-only
 * boundary: its libproc identity provides the same proof).
 *
 * POSIX ONLY. Windows has no process-group id to address, so the wrappers keep
 * their previous semantics there (forward to the direct child) and never call
 * this module.
 *
 * @module scripts/lib/owned-process-group
 */

import {
  listKernelGroupMembers,
  readKernelProcess,
  sameKernelProcess,
} from '../../src/runtime/native-process/identity.ts'

/** How long the group may take to exit on the forwarded signal. */
export const GROUP_SIGNAL_GRACE_MS = 2_000

/** How long the group may take to disappear after the SIGKILL escalation. */
export const GROUP_SETTLE_MS = 2_000

/** The group probe's interval. */
const GROUP_PROBE_MS = 25

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

/** The production kernel-identity source. Tests inject the same shape to make
 * reuse/lost-evidence branches deterministic without manufacturing pid reuse. */
const KERNEL_IDENTITY = Object.freeze({
  read: readKernelProcess,
  listGroupMembers: listKernelGroupMembers,
  same: sameKernelProcess,
})

/**
 * Capture ownership witnesses for the group `pgid` while its leader is
 * verifiably ours. A witness is a member of BOTH the process group and the
 * session the wrapper created (`pgrp === session === pgid`), recorded as its
 * full kernel identity. One surviving witness proves at escalation time that
 * the numeric pgid still names THIS group: a group id that was freed and
 * reused cannot contain the same kernel process again.
 *
 * An unverifiable scan yields no witness (undefined): witnesses are only ever
 * captured from a scan the kernel identity seam could fully verify.
 */
function captureWitnesses(kernelIdentity, pgid) {
  const listed = kernelIdentity.listGroupMembers(pgid)
  if (!Array.isArray(listed)) return undefined
  const witnesses = []
  for (const observation of listed) {
    if (observation.kind !== 'alive') continue
    // The leader's own identity is the primary proof, not a witness.
    if (observation.identity.pid === pgid) continue
    witnesses.push(observation.identity)
  }
  return witnesses
}

/** Whether one captured witness still identifies a member of THIS group and
 * session, as the SAME kernel process (pid/starttime/boot/unique-id all match). */
function witnessStillOwns(kernelIdentity, witness, pgid) {
  const current = kernelIdentity.read(witness.pid)
  if (current.kind !== 'alive') return false
  if (current.identity.pgid !== pgid || current.identity.sid !== pgid) return false
  return kernelIdentity.same(witness, current) === 'same'
}

/**
 * Whether ANY member of the group with `pgid` still exists.
 *
 * The GROUP, never the leader: the leader may already have closed while a
 * descendant keeps the group alive.
 */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // ESRCH is the ONLY answer that proves the group is gone. Any other
    // failure names a member we cannot inspect, which is not the same fact.
    return error.code !== 'ESRCH'
  }
}

/** Every captured identity whose kernel process is still in this
 * group+session; undefined when the evidence has expired. */
function survivingWitnesses(kernelIdentity, witnesses, pgid) {
  if (witnesses === undefined) return undefined
  return witnesses.filter((witness) => witnessStillOwns(kernelIdentity, witness, pgid))
}

/**
 * Whether the group led by `child` still has a live member.
 *
 * This is a PROBE, not a teardown: a wrapper that finished normally asks it
 * before deleting the temp root the group may still be using. It never signals
 * anything, and a group id that cannot be probed is reported alive (never
 * deleted underneath a possible user).
 */
export function groupStillAlive(child) {
  return child.pid !== undefined && groupAlive(child.pid)
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The group is already gone; nothing is left to signal.
  }
}

/** Poll the group probe until it reports ESRCH or the deadline expires. */
async function waitUntilGone(pgid, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true
    await sleep(GROUP_PROBE_MS)
  }
  return !groupAlive(pgid)
}

/**
 * Stop the process group led by `child` and prove it is gone.
 *
 * Sends `signal` to the group, waits up to `graceMs` for it to empty, then
 * escalates ONCE to SIGKILL and waits up to `settleMs`. The result is true
 * only when the group is PROVABLY gone; false means the caller must not claim
 * its own resources are quiesced.
 *
 * The escalation never SIGKILLs a group it cannot prove is still the one this
 * wrapper created. While the unreaped ChildProcess handle owns the numeric
 * pgid, the leader's kernel identity (and a witness scan) is captured. At
 * escalation time the leader must still be the SAME kernel process, or a
 * witness must still be the same process inside the same group+session. No
 * witness, a different identity, an unverifiable read or a member that left the
 * group/session fails closed: the caller reports the unproven group instead of
 * signalling a stranger's.
 */
export async function stopOwnedGroup(
  child,
  signal,
  {
    graceMs = GROUP_SIGNAL_GRACE_MS,
    settleMs = GROUP_SETTLE_MS,
    kernelIdentity = KERNEL_IDENTITY,
  } = {},
) {
  const pgid = child.pid
  // A child that never spawned has no group, so there is nothing to wait for.
  if (pgid === undefined) return true
  // Node has not reaped this child: its pid slot is still allocated, so the
  // numeric group id is the one this wrapper created.
  const leaderUnreaped = child.exitCode === null && child.signalCode === null
  const observed = kernelIdentity.read(pgid)
  const leader = leaderUnreaped && observed.kind === 'alive' && observed.identity.ppid === process.pid
    ? observed.identity
    : undefined
  if (!leaderUnreaped && leader === undefined) {
    // The leader is already gone, so its pid slot — and therefore the group id
    // — may name a different group. NOTHING is signalled without proof, not
    // even the FIRST forwarded signal: a live ChildProcess is the only thing
    // that makes the numeric pgid trustworthy here. If the group is already
    // empty it is provably gone; otherwise the caller reports the unproven
    // group.
    return !groupAlive(pgid)
  }
  // Captured while the leader is (normally) alive: the escalation needs this
  // identity, or a witness recorded under it.
  const witnesses = leader === undefined ? undefined : captureWitnesses(kernelIdentity, pgid)
  signalGroup(pgid, signal)
  if (await waitUntilGone(pgid, graceMs)) return true

  const current = kernelIdentity.read(pgid)
  const leaderStillOwns = leader !== undefined
    && current.kind === 'alive'
    && current.identity.ppid === process.pid
    && kernelIdentity.same(leader, current) === 'same'
  const witnessStillOwnsGroup = (survivingWitnesses(kernelIdentity, witnesses, pgid)?.length ?? 0) > 0
  if (!leaderStillOwns && !witnessStillOwnsGroup) {
    // Leader reaping is neither authorization nor a veto; missing evidence
    // fails closed.
    return false
  }

  signalGroup(pgid, 'SIGKILL')
  return waitUntilGone(pgid, settleMs)
}
