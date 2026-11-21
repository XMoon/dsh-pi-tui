/**
 * The per-Turn TUI prompt policy latch (M6 PR-C C2/C3 boundary).
 *
 * The accepted Owner Focus ruling is a SAME-SESSION fact sampled ONCE:
 *
 * ```text
 * official turn/start  -> sample the Session's current verified TUI viewers
 *                         { eligible, focus } and FREEZE it for this Turn
 * official turn/end    -> clear the latch (the next Turn resamples)
 * ```
 *
 * This module owns the LATCh mechanics only: it folds the two official
 * durable boundaries into one frozen snapshot through an injected
 * {@link TuiPromptVoterSampler}. WHO counts as a current verified viewer is
 * the sampler's business — Direct answers with its own process surface, the
 * Split Host answers from `piTuiPromptPresence` (C3) — so the latch can never
 * become a second presence authority.
 *
 * Ordering (verified by the C0 spike over the real rc.5 loop): the official
 * `session.append('turn/start')` publishes `session/event` synchronously, and
 * the loop's first `systemPrompt.assemble()` for that Turn happens AFTER that
 * commit, so a latch installed during Agent setup always observes the
 * boundary before any section text is rendered for that Turn. A Turn that
 * started before the latch existed therefore renders NO TUI policy rather
 * than a guessed one (fail closed, never stale).
 *
 * @module @xmoon76/dsh-pi-tui/app/agent/turn-policy
 */

import type { TuiPromptTurnPolicy, TuiPromptTurnSnapshot } from './prompt-sections.ts'

/**
 * Sample the Session's current verified TUI viewers. The sampler is called
 * exactly ONCE per Turn, from the synchronous `turn/start` publication; it
 * must answer the CURRENT fact and never cache one of its own.
 */
export type TuiPromptVoterSampler = () => TuiPromptTurnSnapshot

/** The official `session/event` facts the latch folds (structural). */
export interface TuiPromptTurnBoundarySource {
  on(
    event: 'session/event',
    listener: (
      session: { readonly id: string },
      event: { readonly type: string; readonly data?: unknown },
    ) => void,
    options?: { readonly global?: boolean },
  ): () => void
}

/** The Turn number of one boundary event (`turn/start`/`turn/end` data). */
function turnNumberOf(event: { readonly data?: unknown }): number | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const turn = (data as { readonly turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

/** One installed latch: the policy plus the exact Session it follows. */
export interface TuiPromptTurnLatch extends TuiPromptTurnPolicy {
  /** The Session identity this latch follows. */
  readonly sessionId: string
  /** The frozen snapshot of the current Turn, or `undefined` between Turns. */
  snapshot(): TuiPromptTurnSnapshot | undefined
  /** Remove the boundary listener exactly once. */
  dispose(): void
}

/**
 * Install the per-Turn latch for ONE exact Session object on the Host's
 * synchronous `session/event` plane.
 *
 * Filtering is by the EXACT Session OBJECT (never a string id): a replaced
 * same-id Session can never move this Agent's frozen policy. The frozen
 * snapshot is cleared only by the `turn/end` of the SAME Turn number it was
 * frozen at — a late or foreign end boundary can never clear another Turn.
 * The listener is registered on the Agent's own scope by the caller, so it
 * unwinds with the Agent.
 *
 * @param source - the Host event plane (`ctx.on('session/event', ...)`).
 * @param session - the exact Session object this Agent drives (`agent.session`).
 * @param sample - the current-viewer sampler (called once per Turn).
 * @returns the latch; `currentTurn()` is `undefined` between Turns.
 */
export function installTuiPromptTurnLatch(
  source: TuiPromptTurnBoundarySource,
  session: { readonly id: string },
  sample: TuiPromptVoterSampler,
): TuiPromptTurnLatch {
  let frozen: TuiPromptTurnSnapshot | undefined
  let frozenTurn: number | undefined
  let disposed = false
  const disposeListener = source.on('session/event', (eventSession, event) => {
    if (eventSession !== session) return
    if (event.type === 'turn/start') {
      // ONCE per Turn, at the synchronous publication: the sampler answers
      // the CURRENT viewers and the result is frozen until this Turn ends.
      frozen = sample()
      frozenTurn = turnNumberOf(event)
      return
    }
    if (event.type === 'turn/end' && frozenTurn !== undefined && turnNumberOf(event) === frozenTurn) {
      frozen = undefined
      frozenTurn = undefined
    }
  }, { global: true })
  return {
    sessionId: session.id,
    currentTurn: () => frozen,
    snapshot: () => frozen,
    dispose: () => {
      if (disposed) return
      disposed = true
      frozen = undefined
      frozenTurn = undefined
      disposeListener()
    },
  }
}