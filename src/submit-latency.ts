/**
 * Submit latency phase timings (plan E): monotonic timestamps for one
 * submission's journey, written to the diagnostics channel ONLY (never
 * the transcript) at debug level:
 *
 * ```text
 * accept     T0 input accepted (Enter / Ctrl+S / `!` submit)
 * dispatch   T1 followup / steer invoked — marked BEFORE the write call so
 *            synchronously-emitted events (Direct in-process) can never
 *            log T2-T5 ahead of T1
 * inbox.inserted  T2 authoritative inbox event
 * turn.start T3 turn started
 * user.message    T4 user message committed to the session
 * assistant.first T5 first assistant chunk — the timeline AUTO-COMPLETES
 *                 here (a new accept starts the next one)
 * ```
 *
 * Diagnostic meaning: T0→T1 slow = TUI local submit path; T1→T4 slow =
 * DSH preStep / context / plugin work; T4→T5 slow = provider first-token
 * latency.
 *
 * Timeline LIFECYCLE: `reset` is NOT tied to arbitrary `turn/end`s — a
 * submission accepted while a previous turn is still running (busy/queue)
 * must keep its baseline ACROSS that turn's end, or exactly the most
 * diagnostic-rich `queued → next turn` journey would lose T1→T4/T4→T5.
 * The baseline ends only on:
 *
 * - the next `accept` (every gesture rebases — newest wins),
 * - an assistant.first mark (T5 collected — the timeline is complete),
 * - `reset()` from the runner for TERMINAL non-delivery exits (failure /
 *   stale / fence / cancel / no-agent / consumed-by-command) and session
 *   switches.
 *
 * One baseline per submission with DOCUMENTED COALESCING semantics: same-
 * session writes are serialized by the operation barrier (single writer),
 * so the NEWEST gesture owns the timeline and a slower in-flight
 * submission's marks coalesce into it — offsets are approximate for burst
 * submissions, exact for the common single-writer flow. A timeline opened
 * WITHOUT a session id (deferred first submission) ADOPTS the first
 * session that reports back. Marks for other sessions or without a
 * baseline are ignored; the tracker never throws and a timing failure can
 * never affect the session.
 * @module @xmoon76/dsh-pi-tui/submit-latency
 */

export type SubmitLatencyPhase =
  | 'dispatch'
  | 'inbox.inserted'
  | 'turn.start'
  | 'user.message'
  | 'assistant.first'

/** The diag-shaped sink (debug only — this module never warns). */
export interface SubmitLatencySink {
  debug(message: string, fields?: Record<string, unknown>): void
}

export interface SubmitLatencyOptions {
  sink: SubmitLatencySink
  /** Injectable monotonic clock (defaults to `performance.now`). */
  now?: () => number
}

/** One logged line per phase: `submit.<phase>  +Nms`. */
export class SubmitLatencyTracker {
  private readonly sink: SubmitLatencySink
  private readonly now: () => number
  private baseline: number | undefined
  private sessionId: string | undefined
  private readonly logged = new Set<SubmitLatencyPhase>()

  constructor(options: SubmitLatencyOptions) {
    this.sink = options.sink
    this.now = options.now ?? (typeof performance === 'object' && typeof performance.now === 'function'
      ? () => performance.now()
      : Date.now)
  }

  /**
   * Start one submission's timeline (T0). EVERY gesture rebases — the
   * newest submit wins (an older one still waiting for its first event is
   * superseded). A deferred first submission is accepted BEFORE its
   * session exists: `accept(undefined)` still arms the baseline here, and
   * the first mark that names a session ADOPTS that id — the deferred
   * submission keeps measurable T0-T5 without a second accept.
   */
  accept(sessionId: string | undefined): void {
    this.sessionId = sessionId
    this.baseline = this.now()
    this.logged.clear()
    this.emit('accept', 0, sessionId)
  }

  /**
   * Mark one phase (T1-T5); the first mark per phase logs its offset.
   * Returns TRUE when the phase was logged by this call (false for
   * duplicates / foreign sessions / no baseline). Logging
   * `assistant.first` AUTO-COMPLETES the timeline: T5 is the last phase,
   * so the baseline is dropped immediately instead of waiting for a
   * turn/end that a queue-then-next-turn journey must not depend on.
   */
  mark(sessionId: string | undefined, phase: SubmitLatencyPhase): boolean {
    if (this.baseline === undefined) return false
    if (sessionId === undefined) return false
    if (this.logged.has(phase)) return false
    // A timeline opened WITHOUT a session id (deferred first submission)
    // adopts the first session that reports back; a timeline bound to a
    // different session ignores foreign marks.
    if (this.sessionId === undefined) this.sessionId = sessionId
    else if (this.sessionId !== sessionId) return false
    this.logged.add(phase)
    const elapsed = Math.max(0, this.now() - this.baseline)
    this.emit(phase, elapsed, sessionId)
    if (phase === 'assistant.first') {
      // T5 collected — the timeline is complete.
      this.reset()
    }
    return true
  }

  /** Drop the baseline (terminal non-delivery exits / session switch):
   * later marks are no-ops until the next accept. */
  reset(): void {
    this.baseline = undefined
    this.sessionId = undefined
    this.logged.clear()
  }

  private emit(phase: SubmitLatencyPhase | 'accept', elapsed: number, sessionId: string | undefined): void {
    try {
      this.sink.debug(`submit.${phase}`, { session: sessionId ?? '(pending)', offset: `${elapsed}ms` })
    } catch {
      // Diagnostics must never take the TUI down.
    }
  }
}