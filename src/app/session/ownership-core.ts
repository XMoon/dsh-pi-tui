/**
 * The session ownership core (A2-2): the SINGLE owner of the current session
 * owner slot, the generation, the navigation epoch, the transition gate, the
 * operation barrier and the owner-release ledger.
 *
 * It keeps NO Direct knowledge: the owner slot holds an opaque `SessionOwnerRef`
 * (minted by `app/direct`), and the session id travels alongside it. The runner
 * supplies only two seam callbacks (`isSurfaceDisposed`, `resetForGeneration`),
 * so the generation bump keeps the exact behavior locked by
 * `app/session/commit-order.ts`.
 * @module @xmoon76/dsh-pi-tui/app/session/ownership-core
 */

import { SessionOperationBarrier } from '../../session-operation-barrier.ts'
import { SessionTransitionGate } from '../../transition-gate.ts'
import { runGenerationBump } from './commit-order.ts'
import {
  createSessionSubjectAuthority,
  type SessionOwnerRef,
  type SessionSubject,
  type SessionSubjectAuthority,
} from './subject.ts'

/** The runner-owned seams the core needs (no Direct knowledge). */
export interface SessionOwnershipCoreDeps {
  /** Whether the surface is already disposed (`cleanedUp`). */
  isSurfaceDisposed(): boolean
  /** The synchronous generation-reset hook (never awaited). */
  resetForGeneration(): void
}

/** One atomic navigation identity capture (session id + generation + epoch). */
export interface NavigationIdentity {
  readonly sessionId?: string
  readonly generation: number
  readonly navigationEpoch: number
}

/** A `/fork` admission pin plus the retirement-owned release state. */
export interface ForkSourcePin {
  readonly state: { retirementOwnsRelease: boolean }
  release(): void
}

/** The session ownership authority consumed by the runner. */
export interface SessionOwnershipCore {
  readonly gate: SessionTransitionGate
  readonly barrier: SessionOperationBarrier

  generation(): number
  bumpGeneration(): number

  owner(): SessionOwnerRef | undefined
  currentSessionId(): string | undefined
  setCurrentOwner(owner: SessionOwnerRef | undefined, sessionId: string | undefined): void

  navigationEpoch(): number
  bumpNavigationEpoch(): number
  captureNavigationIdentity(): NavigationIdentity

  readonly subjectAuthority: SessionSubjectAuthority
  subject(): SessionSubject | undefined
  captureSubject(): SessionSubject | undefined
  isSubjectCurrent(subject: SessionSubject): boolean

  /** The one release ledger: Direct handle pools read it through this seam. */
  beginOwnerRelease(sessionId: string): () => void
  waitForOwnerRelease(sessionId: string): Promise<void>
  beginForkSourcePin(sessionId: string): ForkSourcePin
}

export function createSessionOwnershipCore(deps: SessionOwnershipCoreDeps): SessionOwnershipCore {
  const gate = new SessionTransitionGate()
  const barrier = new SessionOperationBarrier()

  let generation = 0
  let currentOwner: SessionOwnerRef | undefined
  let currentSessionId: string | undefined
  let navigationEpoch = 0

  // Release ledger: owners whose retirement is IN FLIGHT, keyed by session id.
  // A reopen must follow that release (the persistence write claim is
  // exclusive, and the retirement's `dispose` is what closes it). The release
  // is registered the moment a fork QUEUES the retirement, so a reopen admitted
  // before the retirement starts still waits.
  const pendingOwnerReleases = new Map<string, Set<Promise<void>>>()

  const beginOwnerRelease = (sessionId: string): (() => void) => {
    let resolve!: () => void
    const promise = new Promise<void>(settle => { resolve = settle })
    const releases = pendingOwnerReleases.get(sessionId) ?? new Set<Promise<void>>()
    releases.add(promise)
    pendingOwnerReleases.set(sessionId, releases)
    return () => {
      releases.delete(promise)
      if (releases.size === 0) pendingOwnerReleases.delete(sessionId)
      resolve()
    }
  }

  const waitForOwnerRelease = async (sessionId: string): Promise<void> => {
    // Loop: another release for the same id may be registered while waiting.
    while (true) {
      const releases = pendingOwnerReleases.get(sessionId)
      if (releases === undefined || releases.size === 0) return
      await Promise.allSettled([...releases])
    }
  }

  const beginForkSourcePin = (sessionId: string): ForkSourcePin => {
    const finish = beginOwnerRelease(sessionId)
    const state = { released: false, retirementOwnsRelease: false }
    return {
      state,
      release: (): void => {
        if (state.released) return
        state.released = true
        finish()
      },
    }
  }

  const subjectAuthority = createSessionSubjectAuthority(() =>
    currentOwner === undefined ? undefined : { owner: currentOwner, generation })

  const bumpGeneration = (): number => runGenerationBump({
    isSurfaceDisposed: deps.isSurfaceDisposed,
    get: () => generation,
    set: (next) => { generation = next },
    reset: deps.resetForGeneration,
  })

  return {
    gate,
    barrier,
    generation: () => generation,
    bumpGeneration,
    owner: () => currentOwner,
    currentSessionId: () => currentSessionId,
    setCurrentOwner: (owner, sessionId) => {
      currentOwner = owner
      currentSessionId = sessionId
    },
    navigationEpoch: () => navigationEpoch,
    bumpNavigationEpoch: () => (navigationEpoch += 1),
    captureNavigationIdentity: () => ({
      ...currentSessionId === undefined ? {} : { sessionId: currentSessionId },
      generation,
      navigationEpoch,
    }),
    subjectAuthority,
    subject: () => subjectAuthority.current(),
    captureSubject: () => subjectAuthority.capture(),
    isSubjectCurrent: (subject) => subjectAuthority.isCurrent(subject),
    beginOwnerRelease,
    waitForOwnerRelease,
    beginForkSourcePin,
  }
}
