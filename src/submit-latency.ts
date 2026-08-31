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
 * assistant.first T5 first assistant chunk
 * ```
 *
 * Diagnostic meaning: T0→T1 slow = TUI local submit path; T1→T4 slow =
 * DSH preStep / context / plugin work; T4→T5 slow = provider first-token
 * latency.
 *
 * One baseline per submission with DOCUMENTED COALESCING semantics: same-
 * session writes are serialized by the operation barrier (single writer),
 * so the NEWEST gesture owns the timeline and a slower in-flight
 * submission's marks coalesce into it — offsets are approximate for burst
 * submissions, exact for the common single-writer flow. `accept` starts
 * (or rebases to) the timeline; a timeline opened WITHOUT a session id
 * (deferred first submission) ADOPTS the first session that reports back;
 * the first `mark` per phase logs its offset once; `reset` drops the
 * baseline (turn end / session switch / a FAILED or refused submission —
 * the next submission starts a new baseline). Marks for other sessions or
 * without a baseline are ignored; the tracker never throws and a timing
 * failure can never affect the session.
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
   * Start one submission's timeline (T0). Re-accepting restarts it.
   * A DEFERRED first submission is accepted before its session exists:
   * `accept(undefined)` still arms the baseline, and the first mark that
   * names a session ADOPTS that id for the timeline — the deferred
   * submission's T0-T5 stays measurable without a second accept.
   */
  accept(sessionId: string | undefined): void {
    // EVERY gesture opens a fresh timeline (the newest submit wins — an
    // older one still waiting for its first event is superseded). A
    // deferred first submission is accepted BEFORE its session exists:
    // `accept(undefined)` still arms the baseline here, and the first
    // mark that names a session ADOPTS that id — the deferred submission
    // keeps measurable T0-T5 without a second accept.
    this.sessionId = sessionId
    this.baseline = this.now()
    this.logged.clear()
    this.emit('accept', 0, sessionId)
  }

  /** Mark one phase (T1-T5); the first mark per phase logs its offset. */
  mark(sessionId: string | undefined, phase: SubmitLatencyPhase): void {
    if (this.baseline === undefined) return
    if (sessionId === undefined) return
    if (this.logged.has(phase)) return
    // A timeline opened WITHOUT a session id (deferred first submission)
    // adopts the first session that reports back; a timeline bound to a
    // different session ignores foreign marks.
    if (this.sessionId === undefined) this.sessionId = sessionId
    else if (this.sessionId !== sessionId) return
    this.logged.add(phase)
    const elapsed = Math.max(0, this.now() - this.baseline)
    this.emit(phase, elapsed, sessionId)
  }

  /** Drop the baseline (turn end / session switch): later marks are no-ops. */
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