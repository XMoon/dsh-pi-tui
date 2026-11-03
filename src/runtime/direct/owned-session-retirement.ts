/**
 * Direct-only owned-session retirement — the fixed teardown order for a
 * top-level Agent the Direct TUI owns in-process. The durability OWNER
 * differs by mode, so the deps are a discriminated union:
 *
 * ```text
 * transition: cancel → idle → descendants → sessions.flush → dispose
 * shutdown:   cancel → idle → descendants → AgentHandle.dispose
 * ```
 *
 * This is NOT a semantic port, NOT a Remote API, and NOT a future
 * `session.close` RPC. It exists only because the current Direct backend
 * runs the TUI and the Host in one process and the TUI itself created the
 * Agent: closing the TUI surface must also retire that Direct ownership.
 * A future Remote client closes its client-side observation/connection
 * state through official DSH client contracts — it does NOT destroy the
 * Host Agent.
 *
 * The transition order mirrors the official DSH ACP session close (cancel
 * admission → agent.cancel → whenIdle → drain continuable descendants →
 * flush → AgentHandle.dispose) because the Host stays LIVE: pi-tui owns
 * that final explicit `sessions.flush` durability boundary.
 *
 * The shutdown order deliberately drops the explicit flush: during root
 * unload the DSH agent loop and the JSONL backend may already be closing
 * the same write handle (the backend's own `session/disposed` listener and
 * its open-handle close sweep), and a flush issued after `closing` started
 * is rejected with `flush on a closed handle`. The final durability of a
 * shutdown retirement is settled by DSH's `AgentHandle.dispose()` joining
 * the handle close/drain — re-flushing from here would race that authority
 * instead of adding durability.
 *
 * Every step is individually contained: a failure is recorded and the NEXT
 * step still runs, so one failure can never re-create a handle leak (a
 * skipped dispose would pin the old session lease).
 *
 * The helper is deliberately structural: it receives plain callbacks and
 * never imports Host types or touches `ctx`, so it adds no Host coupling
 * (see docs/architecture/host-client.md) and cannot be mistaken for a
 * cross-backend capability.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/owned-session-retirement
 */

import { safeErrorMessage } from '../process/errors.ts'

/** The phases shared by every retirement mode. */
interface DirectOwnedSessionRetirementCommon {
  /** Cancel the main Agent's current work (`agent.cancel({ kind: 'user' })`). */
  cancel(): void
  /** Await the main Agent's quiescence (`agent.whenIdle()`). */
  whenIdle(): Promise<void>
  /** Drain the main Agent's continuable descendants
   * (`subagents.drainContinuableDescendants([agent])`). */
  drainDescendants(): Promise<void>
  /** Release the AgentHandle (`handle.dispose()` — also stops Agent-scoped
   * background jobs, and on shutdown joins DSH's durable handle close/drain;
   * the TUI never enumerates/kills jobs itself). */
  disposeOwner(): Promise<void>
}

/**
 * The Direct ownership surface the retirement drives (structural — the
 * runner wires the live Agent / AgentHandle / sessions / subagents).
 * `mode` is discriminating: a LIVE-Host transition still requests the final
 * explicit durable flush before the dispose, while a shutdown/HMR/parked
 * retirement relies on DSH's close/drain and must NOT re-enter a write
 * handle that the root teardown may already be closing.
 */
export type DirectOwnedSessionRetirementDeps = DirectOwnedSessionRetirementCommon & (
  | {
      mode: 'transition'
      /**
       * Whether the LIVE-HOST durability regime still holds at FLUSH time.
       * The entry-time mode alone is not enough: the exit can begin DURING
       * this retirement's `idle`/`descendants` awaits (the runner's shutdown
       * does not wait for an in-flight transition retirement), and once it has
       * begun DSH owns the durable close — flushing then races a closing write
       * handle. The adapter supplies the authoritative lifecycle fact here, so
       * the phase is evaluated when it actually runs.
       */
      isLiveHost(): boolean
      flush(): Promise<void>
    }
  | { mode: 'shutdown' }
)

/** One contained retirement-phase failure. */
export interface RetirementFailure {
  phase: 'cancel' | 'idle' | 'descendants' | 'flush' | 'dispose'
  error: string
}

/** The retirement outcome: every phase failure, never a throw. */
export interface RetirementReport {
  failures: readonly RetirementFailure[]
  /**
   * The contained failure that broke FINAL DURABILITY for this mode, when
   * there was one: the transition mode's explicit `flush` phase, or the
   * shutdown mode's `dispose` phase (a failed dispose means the durable
   * close/drain could not be CONFIRMED — it does not claim data was lost).
   * `undefined` when durability held. The consumer contract carries this
   * SEMANTIC outcome; the phase names stay local.
   */
  durabilityFailure: RetirementFailure | undefined
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
 * Retire one Direct-owned session in the fixed mode order (see the module
 * header). Never throws: every phase failure is recorded in the report and
 * the remaining phases still run (a failed flush must not skip the handle
 * dispose, and a failed drain must not skip the final flush).
 * @param deps - the structural ownership surface with its explicit mode.
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
  // The explicit durable flush belongs to the LIVE-HOST regime only, and that
  // regime is re-read HERE (not at entry): an exit that began during the
  // awaits above has already handed durability to DSH's close/drain.
  const liveHostFlush = deps.mode === 'transition' && deps.isLiveHost()
  if (liveHostFlush) {
    await runPhase('flush', deps.flush, failures)
  }
  await runPhase('dispose', deps.disposeOwner, failures)
  // The semantic outcome the consumer needs: which failure (if any) broke
  // final durability for the regime THIS retirement actually used. The
  // consumer never has to know this implementation's phases.
  const durabilityFailure = liveHostFlush
    ? failures.find(failure => failure.phase === 'flush')
    : failures.find(failure => failure.phase === 'dispose')
  return { failures, durabilityFailure }
}
