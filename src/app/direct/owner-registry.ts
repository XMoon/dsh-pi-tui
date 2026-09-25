/**
 * The Direct Agent↔OwnerRef registry (A2 §3.3/§3.7).
 *
 * One exact Direct `Agent` OBJECT always maps to the SAME opaque
 * `SessionOwnerRef`, so re-wrapping the same parked owner into a new
 * `SessionHandle` cannot mint a second identity; different Agent objects are
 * always different owners, even when they share a session id. `fromHandle` is
 * the ONLY `SessionHandle → SessionOwnerRef` path.
 *
 * `currentDirectAttachment()` is the explicitly A2-TRANSITIONAL derived read: it
 * consults the ownership core's current owner on EVERY call and caches nothing.
 * It serves Direct DATA/OPERATION reads only — never identity/currentness.
 * @module @xmoon76/dsh-pi-tui/app/direct/owner-registry
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { directAgentOf, ownerHandleOf, type SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import type { SessionOwnerAccess } from '../session/owner-access.ts'
import type { SessionOwnerRef } from '../session/subject.ts'

/** The Direct facts behind one opaque owner. */
export interface DirectOwnerRecord {
  readonly agent: Agent
  readonly handle: unknown
}

/** The Direct owner registry: the opaque mapping plus the A2 escape hatches. */
export interface DirectOwnerRegistry extends SessionOwnerAccess {
  /** The exact Direct Agent + owner handle of one opaque owner. */
  attachmentOf(owner: SessionOwnerRef): DirectOwnerRecord | undefined
  /** The Direct owner handle of one opaque owner (retirement disposal). */
  handleOf(owner: SessionOwnerRef): unknown
  /**
   * A2 TRANSITIONAL derived read: the Direct attachment of the CURRENT owner,
   * read fresh on every call (no cached current Agent).
   */
  currentDirectAttachment(): Agent | undefined
}

/**
 * Build the registry over a READ-ONLY getter of the ownership core's current
 * owner. The registry never stores "the current owner" itself.
 */
export function createDirectOwnerRegistry(currentOwner: () => SessionOwnerRef | undefined): DirectOwnerRegistry {
  const byAgent = new WeakMap<object, SessionOwnerRef>()
  const byOwner = new WeakMap<SessionOwnerRef, DirectOwnerRecord>()

  const mint = (agent: Agent, handle: unknown): SessionOwnerRef => {
    const existing = byAgent.get(agent)
    if (existing !== undefined) {
      // The same exact Agent re-wrapped: keep the SAME owner identity but
      // refresh the handle record to the newest wrapper.
      byOwner.set(existing, { agent, handle })
      return existing
    }
    const owner = {} as SessionOwnerRef
    byAgent.set(agent, owner)
    byOwner.set(owner, { agent, handle })
    return owner
  }

  const recordOf = (owner: SessionOwnerRef): DirectOwnerRecord => {
    const record = byOwner.get(owner)
    if (record === undefined) throw new Error('session owner is not registered in the Direct owner registry')
    return record
  }

  return {
    fromHandle: (handle: SessionHandle) => {
      const agent = directAgentOf(handle) as Agent | undefined
      if (agent === undefined) return undefined
      return mint(agent, ownerHandleOf(handle))
    },
    sessionId: (owner) => recordOf(owner).agent.session.id,
    completionIdentity: (owner) => byOwner.get(owner)?.agent.id,
    surfaceAttachment: (owner) => byOwner.get(owner)?.agent,
    attachmentOf: (owner) => byOwner.get(owner),
    handleOf: (owner) => byOwner.get(owner)?.handle,
    currentDirectAttachment: () => {
      const owner = currentOwner()
      return owner === undefined ? undefined : byOwner.get(owner)?.agent
    },
  }
}
