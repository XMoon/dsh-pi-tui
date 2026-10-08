/**
 * The ONE shared main-Agent terminal-progress interval fold.
 *
 * It answers exactly one question: for a single ALREADY-AUTHORIZED Agent
 * instance, given the running edges and the matched durable
 * `turn/start` / `turn/end(reason.kind)` boundaries observed in the REAL
 * synchronous order of that Agent, which terminal outcome can be PROVEN at
 * the moment the interval settles (`running -> idle`)?
 *
 * It deliberately does NOT answer Agent ownership, the target main Session,
 * Connection currentness or the output protocol mode. Those stay with the
 * caller's own fences (Direct: the surface routing's exact-agent identity
 * gate; Remote: the Host plugin's live-Agent identity gate), so the same fold
 * can be instantiated once per authority WITHOUT becoming a second authority:
 * one shared interval semantics, two input adapters (plan §4, §5.4).
 *
 * Invariants (plan §5.2), each proven by `test/terminal-progress-interval.test.ts`:
 *
 * - a `done`/`error` claim REQUIRES a `turn/end` that matched the turn the
 *   current running interval actually opened; an open-but-unclosed turn, an
 *   unmatched end, or a running interval that produced no turn at all settle
 *   `idle`;
 * - every newer `turn/start` invalidates the previous closed candidate, so the
 *   LAST valid closed turn of the interval decides;
 * - a repeated `running`/`idle` status is inert (a repeated idle must never
 *   re-settle, and an idle notification must never fabricate a completion);
 * - `retire()` never fabricates a settlement: it keeps the PROVEN outcome, so
 *   a final disposal can retain a `done`/`error` while a still-live `working`
 *   interval retires to `idle`;
 * - `reset()` (a new Session / rebind) discards every result of the previous
 *   owner — a new owner must prove its own running edge and can never inherit
 *   the previous owner's `done`/`error`;
 * - an UNKNOWN upstream reason kind is NOT guessed: the injected reporter
 *   records it and the interval stays `idle`.
 *
 * `status()`/`retire()` return `undefined` when the call changed nothing, so a
 * caller can skip a duplicate physical commit without a second state copy.
 *
 * @module @xmoon76/dsh-pi-tui/domain/terminal-progress/interval
 */

import type { TerminalProgressOutcome } from './settings.ts'

/** The publishable `(active, outcome)` pair of one commit. */
export interface IntervalProgress {
  readonly active: boolean
  readonly outcome: TerminalProgressOutcome
}

/**
 * The fold's commands. Every mutating command has already latched its own
 * state before returning, so a synchronous re-entrant read from the commit
 * callback observes the committed generation, never the previous one.
 */
export interface TerminalProgressInterval {
  /**
   * Advance the Agent's running truth.
   * @param running - the live Agent's lifecycle status (`running` or not).
   * @returns the commit to publish, or `undefined` for a repeated status.
   */
  status(running: boolean): IntervalProgress | undefined
  /** Record one live `turn/start`; only inside the current running interval. */
  turnStart(turn: number): void
  /** Record one live `turn/end`; only when it closes the interval's open turn. */
  turnEnd(turn: number, reasonKind: string): void
  /**
   * Retire the running truth without fabricating a settlement (owner rebind,
   * final teardown).
   * @returns the commit to publish, or `undefined` when nothing changed.
   */
  retire(): IntervalProgress | undefined
  /** Discard every result of the previous owner (new Session / Agent rebind). */
  reset(): IntervalProgress
  /** Read the current presentation state without changing it. */
  snapshot(): IntervalProgress
}

/**
 * Classify one official `turn/end.reason.kind` (plan §5.2). `completed` is the
 * DSH turn result (not a claim about every business step); `error` and
 * `max-tokens` (a resource ceiling, not success) are `error`; a cancelled /
 * blocked / non-live closer is honestly `idle`. An UNKNOWN upstream kind is
 * NOT guessed — the caller records it and the interval stays `idle`.
 *
 * @param kind - the durable `turn/end` reason kind.
 * @returns the proven outcome, or `undefined` for an unknown kind.
 */
export function classifyTerminalTurnEnd(kind: string): TerminalProgressOutcome | undefined {
  switch (kind) {
    case 'completed': return 'done'
    case 'error': return 'error'
    case 'max-tokens': return 'error'
    case 'aborted':
    case 'blocked':
    case 'interrupted':
    case 'forked': return 'idle'
    default: return undefined
  }
}

/**
 * Create one independent fold instance.
 * @param onUnknownReason - reports an unknown `turn/end.reason.kind` (the
 * Host/Direct owner injects its diagnostics channel here); the interval stays
 * `idle` instead of guessing.
 */
export function createTerminalProgressInterval(
  onUnknownReason?: (kind: string) => void,
): TerminalProgressInterval {
  let active = false
  /** The turn opened by the newest live `turn/start` of THIS interval. */
  let openTurn: number | undefined
  /** The classified outcome of the newest turn whose `turn/end` matched the
   *  open turn — reset whenever a newer turn opens. */
  let lastClosed: TerminalProgressOutcome | undefined
  /** The currently committed outcome of the interval (`idle` while running
   *  without a proven result). */
  let outcome: TerminalProgressOutcome = 'idle'

  const state = (): IntervalProgress => ({ active, outcome })

  return {
    status(running: boolean): IntervalProgress | undefined {
      if (running) {
        // A repeated running status is inert; a rising edge opens a FRESH
        // interval that must discard the previous candidate.
        if (active) return undefined
        active = true
        openTurn = undefined
        lastClosed = undefined
        outcome = 'idle'
        return state()
      }
      if (!active) return undefined
      // An unmatched open turn has NO completion evidence: only a turn/end
      // that closed the turn this interval opened can prove done/error.
      outcome = openTurn === undefined ? (lastClosed ?? 'idle') : 'idle'
      active = false
      openTurn = undefined
      lastClosed = undefined
      return state()
    },
    turnStart(turn: number): void {
      if (!active) return
      openTurn = turn
      lastClosed = undefined
    },
    turnEnd(turn: number, reasonKind: string): void {
      if (!active) return

      if (openTurn !== turn) return
      openTurn = undefined
      const classified = classifyTerminalTurnEnd(reasonKind)
      if (classified === undefined) {
        onUnknownReason?.(reasonKind)
        lastClosed = 'idle'
        return
      }
      lastClosed = classified
    },
    retire(): IntervalProgress | undefined {
      openTurn = undefined
      lastClosed = undefined
      if (!active && outcome === 'idle') return undefined
      active = false
      return state()
    },
    reset(): IntervalProgress {
      active = false
      openTurn = undefined
      lastClosed = undefined
      outcome = 'idle'
      return state()
    },
    snapshot(): IntervalProgress {
      return state()
    },
  }
}
