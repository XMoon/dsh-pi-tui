/**
 * Direct-only owned-session retirement — the fixed teardown order for a
 * top-level Agent the Direct TUI owns in-process:
 *
 * ```text
 * cancel → idle → descendants → flush → dispose
 * ```
 *
 * This is NOT a semantic port, NOT a Remote API, and NOT a future
 * `session.close` RPC. It exists only because the current Direct backend
 * runs the TUI and the Host in one process and the TUI itself created the
 * Agent: closing the TUI surface must also retire that Direct ownership
 * (quiesce the main Agent, drain its continuable descendants, flush the
 * final durability boundary, and release the AgentHandle). A future Remote
 * client closes its client-side observation/connection state through
 * official DSH client contracts — it does NOT destroy the Host Agent.
 *
 * The order mirrors the official DSH ACP session close (cancel admission →
 * agent.cancel → whenIdle → drain continuable descendants → flush →
 * AgentHandle.dispose). Every step is individually contained: a failure is
 * recorded and the NEXT step still runs, so one failure can never re-create
 * a handle leak (a skipped dispose would pin the old session lease).
 *
 * The helper is deliberately structural: it receives plain callbacks and
 * never imports Host types or touches `ctx`, so it adds no Host coupling
 * (see docs/client-server-coupling.md) and cannot be mistaken for a
 * cross-backend capability.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/owned-session-retirement
 */

import { safeErrorMessage } from '../../error-boundary.ts'

/** The Direct ownership surface the retirement drives (structural — the
 * runner wires the live Agent / AgentHandle / sessions / subagents). */
export interface DirectOwnedSessionRetirementDeps {
  /** Cancel the main Agent's current work (`agent.cancel({ kind: 'user' })`). */
  cancel(): void
  /** Await the main Agent's quiescence (`agent.whenIdle()`). */
  whenIdle(): Promise<void>
  /** Drain the main Agent's continuable descendants
   * (`subagents.drainContinuableDescendants([agent])`). */
  drainDescendants(): Promise<void>
  /** Final durable flush of the session (`sessions.flush(session)`). */
  flush(): Promise<void>
  /** Release the AgentHandle (`handle.dispose()` — also stops Agent-scoped
   * background jobs; the TUI never enumerates/kills jobs itself). */
  disposeOwner(): Promise<void>
}

/** One contained retirement-phase failure. */
export interface RetirementFailure {
  phase: 'cancel' | 'idle' | 'descendants' | 'flush' | 'dispose'
  error: string
}

/** The retirement outcome: every phase failure, never a throw. */
export interface RetirementReport {
  failures: readonly RetirementFailure[]
}

/** Run one phase, recording (never throwing on) its failure. */
async function runPhase(
  phase: RetirementFailure['phase'],
  step: () => Promise<void> | void,
  failures: RetirementFailure[],
): Promise<void> {
  try {
    await step()
  } catch (error) {
    failures.push({ phase, error: safeErrorMessage(error) })
  }
}

/**
 * Retire one Direct-owned session in the fixed order
 * `cancel → idle → descendants → flush → dispose`. Never throws: every
 * phase failure is recorded in the report and the remaining phases still
 * run (a failed flush must not skip the handle dispose, and a failed drain
 * must not skip the final flush).
 * @param deps - the structural ownership surface.
 * @returns the retirement report (empty `failures` = clean retirement).
 */
export async function retireDirectOwnedSession(
  deps: DirectOwnedSessionRetirementDeps,
): Promise<RetirementReport> {
  const failures: RetirementFailure[] = []
  // cancel is synchronous: a throwing cancel is still contained.
  try {
    deps.cancel()
  } catch (error) {
    failures.push({ phase: 'cancel', error: safeErrorMessage(error) })
  }
  await runPhase('idle', deps.whenIdle, failures)
  await runPhase('descendants', deps.drainDescendants, failures)
  await runPhase('flush', deps.flush, failures)
  await runPhase('dispose', deps.disposeOwner, failures)
  return { failures }
}
