/**
 * The opening-session journal (A2 seam, A4-owned).
 *
 * Presentation-only state that fences the PRE-COMMIT session events belonging
 * to the session currently being opened. `initLiveSession` merges the journal's
 * cut into the cold hydration so an event that arrives before the target
 * session is committed still lands exactly once.
 *
 * The mutable event array is PRIVATE behind this API: callers only ever hold
 * the opaque identity token returned by {@link OpeningJournal.begin} and read
 * events through the readonly {@link OpeningJournal.cut} view. The journal is
 * GENERIC over the event type so this application-layer module never imports a
 * Host session type.
 *
 * @module app/surface/opening-journal
 */

/** The readonly merge view of one in-progress opening. */
export interface OpeningCut<Event> {
  readonly id: string
  readonly events: readonly Event[]
}

/** The opening-journal contract; one instance owns at most one open target. */
export interface OpeningJournal<Event> {
  /** Begin an opening for `sessionId` and return its opaque identity token. */
  begin(sessionId: string): object
  /**
   * Stop RECORDING for `sessionId` once its live surface owns event delivery
   * (the Remote ingress is installed for the committed owner, so the pre-commit
   * buffering window is over). The recorded cut stays readable for a hydration
   * that already took it, and the entry is still cleared by its own token — but
   * `isOpening` answers false and later events route normally instead of being
   * buffered and then discarded at `clear`. A journal for another target is
   * untouched.
   */
  close(sessionId: string): void
  /** The opaque identity token of the journal currently being opened, if any. */
  current(): object | undefined
  /** Clear only the EXACT journal identity (a newer transition's journal wins). */
  clear(token: object): void
  /** Unconditional clear (the ensure-first-session finally path). */
  reset(): void
  /** Whether `sessionId` is the session currently being opened. */
  isOpening(sessionId: string): boolean
  /** Record one pre-commit event for the opening target (no-op otherwise). */
  record(sessionId: string, event: Event): void
  /** The readonly opening cut for `sessionId`, or undefined. */
  cut(sessionId: string): OpeningCut<Event> | undefined
}

/** Create the process-local opening journal. */
export function createOpeningJournal<Event>(): OpeningJournal<Event> {
  let journal: { readonly token: object; readonly id: string; events: Event[]; open: boolean } | undefined
  return {
    begin(sessionId) {
      const token: object = {}
      journal = { token, id: sessionId, events: [], open: true }
      return token
    },
    close(sessionId) {
      if (journal !== undefined && journal.id === sessionId) journal.open = false
    },
    current: () => journal?.token,
    clear(token) {
      if (journal?.token === token) journal = undefined
    },
    reset() { journal = undefined },
    isOpening: (sessionId) => journal !== undefined && journal.id === sessionId && journal.open,
    record(sessionId, event) {
      if (journal !== undefined && journal.id === sessionId && journal.open) journal.events.push(event)
    },
    cut: (sessionId) => (journal?.id === sessionId ? { id: journal.id, events: journal.events } : undefined),
  }
}
