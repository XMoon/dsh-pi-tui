/**
 * The ONE exact kernel-group ownership predicate for Split test support.
 *
 * Both the Supervisor's Process-grade Host signals and its discovery-fallback
 * reclaim use {@link assertKernelGroupSignalOwnership} IMMEDIATELY before every
 * signal, including a TERM -> KILL escalation: the recorded kernel birth must
 * still name the live PID, that PID must still be its own group/session leader,
 * and the exact leader PID together with its birth must still be a LIVE member
 * of the group. A same-tick birth string is not an identity (two distinct Linux
 * processes started in one clock tick share it), a terminated task is not a
 * live member, and an unreadable group is unknown ownership: every one of those
 * refuses the signal instead of falling back to a bare numeric group.
 *
 * The reader set is injected so the tooling negative controls can bind the same
 * predicate to classifier-level observations without a forged destructive
 * target.
 */

import { classifyKernelLiveness, serializeKernelIdentity } from './split-upgrade-native-contract.mjs'

/**
 * @param {{ read(pid: number): any, listMembers(pgid: number): any }} kernel
 * @param {number} pid
 * @param {string | undefined} birth
 * @param {string} reason
 */
export function assertKernelGroupSignalOwnership(kernel, pid, birth, reason) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`${reason}: no real PID; refusing to signal`)
  }
  if (typeof birth !== 'string' || birth === '') {
    throw new Error(`${reason}: no captured kernel birth; refusing to signal`)
  }
  const observation = kernel.read(pid)
  const liveness = classifyKernelLiveness(observation)
  if (liveness.state !== 'alive') {
    throw new Error(`${reason}: PID ${String(pid)} is not the live kernel process captured at spawn (${liveness.state}); refusing to signal`)
  }
  if (serializeKernelIdentity(observation.identity) !== birth) {
    throw new Error(`${reason}: PID ${String(pid)} was replaced by another process; refusing to signal`)
  }
  if (observation.identity.pgid !== pid || observation.identity.sid !== pid) {
    throw new Error(`${reason}: PID ${String(pid)} is not its own group/session leader; refusing to signal`)
  }
  const members = kernel.listMembers(pid)
  if (!Array.isArray(members)) {
    throw new Error(`${reason}: process group ${String(pid)} cannot be enumerated (${String(members?.code)}); refusing to signal`)
  }
  if (!members.some(member => classifyKernelLiveness(member).state === 'alive'
    && member.identity.pid === pid
    && serializeKernelIdentity(member.identity) === birth)) {
    throw new Error(`${reason}: the captured process is no longer the live leader of group ${String(pid)}; refusing to signal`)
  }
  return observation
}

/**
 * The LIVE member PIDs of one owned group. A same-birth terminated task is not
 * a live member; an unreadable enumeration throws instead of being scored as an
 * empty (terminal) group.
 *
 * @param {{ listMembers(pgid: number): any }} kernel
 * @param {number} pgid
 * @param {string} reason
 * @returns {number[]}
 */
export function kernelGroupLiveMemberPids(kernel, pgid, reason) {
  const members = kernel.listMembers(pgid)
  if (!Array.isArray(members)) {
    throw new Error(`${reason}: process group ${String(pgid)} cannot be enumerated (${String(members?.code)})`)
  }
  const live = []
  for (const member of members) {
    const liveness = classifyKernelLiveness(member)
    if (liveness.state === 'unknown') {
      throw new Error(`${reason}: a member of process group ${String(pgid)} cannot be classified`)
    }
    if (liveness.state === 'alive') live.push(member.identity.pid)
  }
  return live
}
