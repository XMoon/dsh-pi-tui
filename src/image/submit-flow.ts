/**
 * The submission orchestration core (review finding): the ordering
 * contract every pinned submit path MUST follow, extracted so the real
 * dispatch code and the integration tests share ONE implementation
 * instead of hand-rolled copies.
 *
 * Contract:
 * ```text
 * reserve(text)                      // synchronous, same call stack as the editor clearing
 *   → run()                          // async: ensureSession / guard / prepare / send
 *       → success → consume
 *       → failure → restore(text)    // BEFORE the reservation releases
 *   → release()                      // finally
 *   → notify (runOwned onError)      // diagnostics + notice, never a second restore
 * ```
 * The restored editor text must reference its backing drafts BEFORE the
 * pin releases, so a concurrent attach-time prune cannot delete them
 * (review finding). Notifications stay OUT of this core: runOwned's
 * onError owns them.
 * @module @xmoon76/dsh-pi-tui/image/submit-flow
 */

/** One reserved submission's injectable surface. */
export interface SubmitFlowDeps {
  /** Reserve the referenced drafts synchronously; returns the release. */
  reserve(text: string): () => void
  /** The async submission work (ensure session, guard, prepare, send). */
  run(text: string): Promise<void>
  /** Restore the editor draft on failure (before the release). */
  restore(text: string): void
}

/**
 * Run one pinned submission end to end. The reservation is established
 * FIRST (the caller must call this synchronously, before any await — the
 * editor was already cleared by the submit path); on failure the editor
 * is restored BEFORE the reservation releases; the release always runs.
 * @returns when the submission committed (or was aborted normally).
 * @throws the run failure after the restore (the caller's runOwned
 *   onError then notifies — never a second restore).
 */
export async function runReservedSubmit(flow: SubmitFlowDeps, text: string): Promise<void> {
  const release = flow.reserve(text)
  try {
    await flow.run(text)
  } catch (error: unknown) {
    // Failure: restore the editor draft BEFORE the reservation releases —
    // the restored placeholders must keep their backing drafts against
    // concurrent attach-time prunes (review finding).
    flow.restore(text)
    throw error
  } finally {
    release()
  }
}
