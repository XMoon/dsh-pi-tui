/**
 * The four session-commit shapes as STATELESS ordering helpers (A2 plan §4).
 *
 * These functions own NO state: the runner supplies every operation as a seam
 * and keeps `liveAgent` / `liveHandle` / `sessionGeneration` itself. Their only
 * job is to fix the ORDER, so a spy-seam unit test can lock the sequence the
 * runner had before the ownership cutover — the shapes differ and must NOT be
 * unified:
 *
 * ```text
 * A ordinary transition: bump(reset) → publish owner → completion
 * B fork adoption:       settle → bump(reset) → publish owner → completion
 * C first session:       publish owner → completion → await idle → bump(reset) → init
 * D startup resume:      publish owner → completion → pre-mount quiesce
 * ```
 *
 * `bumpGeneration` runs its synchronous surface reset, so in A/B the reset
 * necessarily observes the NEW generation while the OLD owner is still current.
 * @module @xmoon76/dsh-pi-tui/app/session/commit-order
 */

/** Publish the new owner and return its completion identity (Direct `Agent.id`). */
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
 * `transitionCommitted`.
 */
export function runOrdinaryCommit(seams: OrdinaryCommitSeams, next: unknown): void {
  seams.settlePendingQueueRecalls(true)
  if (!seams.isSurfaceDisposed()) seams.settleLocalSubmitAck('session switched')
  if (!seams.isSurfaceDisposed()) seams.resetSubmitLatency()
  if (!seams.isSurfaceDisposed()) seams.bumpGeneration()
  const identity = seams.publishOwner(next)
  if (seams.isSurfaceDisposed()) return
  seams.setCompletionOwner(identity)
}

/** B — the fork-adoption commit (the navigation fence ran before it). */
export function runForkCommit(seams: ForkCommitSeams, next: unknown): void {
  seams.settlePendingQueueRecalls(true)
  seams.settleLocalSubmitAck('session forked')
  seams.resetSubmitLatency()
  seams.bumpGeneration()
  const identity = seams.publishOwner(next)
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
