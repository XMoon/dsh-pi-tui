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
 * therefore gated on PROOF: either the leader itself (same `/proc` start time;
 * a not-yet-reaped zombie must also carry our ppid), or a WITNESS captured
 * while the leader was verifiable — a process in BOTH the group and the session
 * this wrapper created, whose `(pid, start time)` still matches at escalation
 * time. Leader reaping alone is neither authorization nor a veto. Where
 * `/proc` is unavailable no witness can be captured, so the escalation FAILS
 * CLOSED and the caller reports the unproven group (that is also the macOS
 * boundary).
 *
 * POSIX ONLY. Windows has no process-group id to address, so the wrappers keep
 * their previous semantics there (forward to the direct child) and never call
 * this module.
 *
 * @module scripts/lib/owned-process-group
 */

import { readFileSync, readdirSync } from 'node:fs'

/** How long the group may take to exit on the forwarded signal. */
export const GROUP_SIGNAL_GRACE_MS = 2_000

/** How long the group may take to disappear after the SIGKILL escalation. */
export const GROUP_SETTLE_MS = 2_000

/** The group probe's interval. */
const GROUP_PROBE_MS = 25

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

/**
 * The `/proc/<pid>/stat` facts this module needs, or undefined when the process
 * has no readable entry (already gone, or a platform without `/proc`).
 *
 * Fields are counted from the LAST `)`: the command name between `(` and that
 * `)` may contain spaces and parentheses, so the first field after it is the
 * state (field 3). `startTime` is field 22.
 */
function procStats(pid) {
  let stat
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return {
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    session: Number(fields[3]),
    startTime: fields[19],
  }
}

/** Field 22: the pid-reuse discriminator. Undefined where `/proc` is absent. */
function defaultStatStartTime(pid) {
  return procStats(pid)?.startTime
}

/**
 * Capture ownership witnesses for the group `pgid` while its leader is
 * verifiably ours.
 *
 * A witness is a member of BOTH the process group and the session the wrapper
 * created (`pgrp === session === pgid`), recorded as `(pid, start time)`. One
 * surviving witness proves at escalation time that the numeric pgid still
 * names THIS group: a group id that was freed and reused cannot contain the
 * same process again.
 *
 * The capture is bracketed by the leader's identity — the leader must still be
 * the process whose start time was read before AND after the scan, or the scan
 * may have observed a different group that happened to carry the same id.
 */
function defaultCaptureWitnesses(pgid, leaderStartTime) {
  if (defaultStatStartTime(pgid) !== leaderStartTime) return undefined
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return undefined
  }
  const witnesses = []
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    const pid = Number(entry)
    // The leader's own identity is the primary proof, not a witness.
    if (pid === pgid) continue
    const stats = procStats(pid)
    if (stats === undefined || stats.pgrp !== pgid || stats.session !== pgid) continue
    witnesses.push({ pid, startTime: stats.startTime })
  }
  if (defaultStatStartTime(pgid) !== leaderStartTime) return undefined
  return witnesses
}

/** Whether one captured witness still identifies a member of THIS group. */
function witnessStillOwns(witness, pgid) {
  const stats = procStats(witness.pid)
  return stats !== undefined
    && stats.startTime === witness.startTime
    && stats.pgrp === pgid
    && stats.session === pgid
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
 * wrapper created. While the leader occupies its pid it is the primary proof
 * (same start time; a zombie must also carry our ppid). Once the leader has
 * been reaped its pid slot is free and the numeric pgid proves nothing, so a
 * WITNESS recorded while the leader was verifiable must still be a member of
 * the same group AND session. No witness, a different start time, or a member
 * that left the group/session fails closed: the caller reports the unproven
 * group instead of signalling a stranger's.
 */
export async function stopOwnedGroup(
  child,
  signal,
  {
    graceMs = GROUP_SIGNAL_GRACE_MS,
    settleMs = GROUP_SETTLE_MS,
    statStartTime = defaultStatStartTime,
    captureWitnesses = defaultCaptureWitnesses,
  } = {},
) {
  const pgid = child.pid
  // A child that never spawned has no group, so there is nothing to wait for.
  if (pgid === undefined) return true
  if (child.exitCode !== null || child.signalCode !== null) {
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
  const leaderStartTime = statStartTime(pgid)
  const witnesses = leaderStartTime === undefined ? undefined : captureWitnesses(pgid, leaderStartTime)
  signalGroup(pgid, signal)
  if (await waitUntilGone(pgid, graceMs)) return true

  if (child.exitCode !== null || child.signalCode !== null) {
    const current = statStartTime(pgid)
    if (current !== undefined) {
      // The leader still occupies its pid. It must be the SAME process: a
      // different start time is a recycled pid, and a zombie must carry our
      // ppid.
      if (leaderStartTime === undefined || current !== leaderStartTime) return false
      const stats = procStats(pgid)
      if (stats !== undefined && stats.ppid !== process.pid) return false
    } else if (witnesses === undefined || !witnesses.some((witness) => witnessStillOwns(witness, pgid))) {
      // The leader slot is free, so the numeric pgid alone proves nothing and
      // only a recorded witness can establish that this is still the group the
      // wrapper created. Leader reaping is neither authorization nor a veto;
      // missing evidence fails closed.
      return false
    }
  }

  signalGroup(pgid, 'SIGKILL')
  return waitUntilGone(pgid, settleMs)
}
