/**
 * The four session-commit shapes as STATELESS ordering helpers (A2 plan §4).
 *
 * These functions own NO state: the caller supplies every operation as a seam
 * and keeps the owner slot, the generation and the completion identity itself
 * (the ownership core holds them). Their only job is to fix the ORDER, so a
 * spy-seam unit test can lock the exact sequence the session layer requires —
 * the shapes differ and must NOT be unified:
 *
 * ```text
 * A ordinary transition: bump(reset) → publish owner → recall commit → completion
 * B fork adoption:       bump(reset) → publish owner → recall commit → completion
 * C first session:       publish owner → completion → await idle → bump(reset) → init
 * D startup resume:      publish owner → completion → pre-mount quiesce
 * ```
 *
 * In A/B the queued recalls settle as committed only AFTER the owner
 * publication — the publication is the commit point of a session transition;
 * everything before it is restorable, everything after it is a contained
 * post-commit failure.
 *
 * `bumpGeneration` runs its synchronous surface reset, so in A/B the reset
 * necessarily observes the NEW generation while the OLD owner is still current.
 * @module @xmoon76/dsh-pi-tui/app/session/commit-order
 */

/** Publish the new owner and return its completion identity (an opaque id the
 *  completion controller compares; the backend decides what it is). */
export interface OwnerPublicationSeams {
  publishOwner(owner: unknown): string | undefined
  setCompletionOwner(identity: string | undefined): void
}

export interface BumpSeams extends OwnerPublicationSeams {
  bumpGeneration(): number
}

/** A — ordinary transition (guarded by the surface-disposed fence). */
export interface OrdinaryCommitSeams extends BumpSeams {
  isSurfaceDisposed(): boolean
  settlePendingQueueRecalls(committed: boolean): void
  settleLocalSubmitAck(reason: 'session switched'): void
  resetSubmitLatency(): void
}

/** B — fork adoption (the cleanup-before-commit fence already ran). */
export interface ForkCommitSeams extends BumpSeams {
  settlePendingQueueRecalls(committed: boolean): void
  settleLocalSubmitAck(reason: 'session forked'): void
  resetSubmitLatency(): void
}

/** C — first-session creation (bump AFTER the committed child's idle). */
export interface FirstSessionCommitSeams extends BumpSeams {
  /** Resolve the committed child's idle; `true` = aborted (skip bump + init). */
  quiesceChild(): Promise<boolean>
  initChild(): Promise<void>
}

/**
 * D — startup `--session` resume (no bump in the publication shape).
 * `preMountQuiesce` is OPTIONAL and may return `undefined`: a sessionless
 * (deferred) startup has nothing to quiesce and MUST NOT gain an extra
 * microtask yield at this point.
 */
export interface ResumeCommitSeams extends OwnerPublicationSeams {
  preMountQuiesce?(): Promise<unknown> | undefined
}

/**
 * A — the ordinary transition commit. Returns nothing; the caller owns
 * `transitionCommitted`. The queued recalls settle as COMMITTED only after the
 * owner publication succeeded — the publication is the transition's commit
 * point, so a pre-publication seam failure leaves the recalls restorable.
 */
export function runOrdinaryCommit(seams: OrdinaryCommitSeams, next: unknown): void {
  if (!seams.isSurfaceDisposed()) seams.settleLocalSubmitAck('session switched')
  if (!seams.isSurfaceDisposed()) seams.resetSubmitLatency()
  if (!seams.isSurfaceDisposed()) seams.bumpGeneration()
  const identity = seams.publishOwner(next)
  seams.settlePendingQueueRecalls(true)
  if (seams.isSurfaceDisposed()) return
  seams.setCompletionOwner(identity)
}

/** B — the fork-adoption commit (the navigation fence ran before it). The
 *  queued recalls settle as COMMITTED only after the owner publication
 *  succeeded, exactly like the ordinary transition. */
export function runForkCommit(seams: ForkCommitSeams, next: unknown): void {
  seams.settleLocalSubmitAck('session forked')
  seams.resetSubmitLatency()
  seams.bumpGeneration()
  const identity = seams.publishOwner(next)
  seams.settlePendingQueueRecalls(true)
  seams.setCompletionOwner(identity)
}

/**
 * C — the first-session commit. Returns `false` when the committed child's
 * quiesce aborted (the caller must skip its post-init work).
 */
export async function runFirstSessionCommit(seams: FirstSessionCommitSeams, next: unknown): Promise<boolean> {
  const identity = seams.publishOwner(next)
  seams.setCompletionOwner(identity)
  if (await seams.quiesceChild()) return false
  seams.bumpGeneration()
  await seams.initChild()
  return true
}

/**
 * D — the startup-resume publication (the later mount/init stays with the
 * caller). Returns the pre-mount quiesce promise ONLY when the seam produced
 * one, so a sessionless startup stays fully SYNCHRONOUS (no microtask yield),
 * exactly like the pre-cutover code did.
 */
export function runResumeCommit(seams: ResumeCommitSeams, owner: unknown): Promise<unknown> | undefined {
  const identity = seams.publishOwner(owner)
  seams.setCompletionOwner(identity)
  return seams.preMountQuiesce?.()
}

/** The generation counter stays with the caller; these seams operate it. */
export interface GenerationSeams {
  isSurfaceDisposed(): boolean
  get(): number
  set(next: number): void
  reset(): void
}

/**
 * Bump the generation then run the synchronous surface reset. The reset MUST
 * observe the bumped value; a THROW from the reset must NOT roll the bump back;
 * a RE-ENTRANT reset that bumps again must be reflected in the returned value
 * (read at the END, not captured before the reset).
 */
export function runGenerationBump(seams: GenerationSeams): number {
  if (seams.isSurfaceDisposed()) return seams.get()
  seams.set(seams.get() + 1)
  seams.reset()
  return seams.get()
}
