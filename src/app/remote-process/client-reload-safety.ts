/**
 * The Client-local safety decision of the manual `/reload-client` gesture
 * (M4 PR4).
 *
 * The decision answers exactly ONE question: may THIS Client process retire
 * and hand the still-running Host/Session to a replacement Client process?
 * It lives in `app/remote-process` because the fact it governs is the Client
 * process's own retirement, not a Session-domain policy and not a renderer
 * rule. It is pure: every fact is supplied by the owning live source, so this
 * module performs no IO, reads no environment and imports no Host/DSH/terminal
 * implementation.
 *
 * The caller (the composition root) builds the facts from the ACTUAL owners in
 * ONE synchronous call stack and then, only when this function returns
 * `undefined`, invokes the process-owned reexec request in that same stack. No
 * asynchronous step may sit between the decision and the request: an awaited
 * gap would admit new local input after the gate passed.
 *
 * Refusal priority is fixed and user-visible: the FIRST matching reason wins,
 * so a Client with both a draft and a staged attachment reports the draft
 * (`draft-text`) — the user fixes one thing at a time and retries.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/client-reload-safety
 */

/**
 * Why one Client reload request was refused by the Client-local owners.
 * `unavailable` is outside the split Client (no process capability at all);
 * every other reason describes a real, resolvable local state.
 */
export type ClientReloadRefusal =
  | 'unavailable'
  | 'not-ready'
  | 'draft-text'
  | 'attachments'
  | 'submission'
  | 'interaction'
  | 'transition'

/**
 * The live facts the pure decision consumes, each read SYNCHRONOUSLY from its
 * single owning source at gesture time:
 *
 * - `capable` — a split-Client process composition with the one-shot reexec
 *   capability is mounted;
 * - `ready` — the application surface itself is still alive (not disposed and
 *   not stopping); the process-owned preflight keeps its own transport/Host
 *   readiness checks;
 * - `draftText` — the exact current Composer text (`getDraft()`), never
 *   trimmed: a whitespace-only draft is real unsubmitted input;
 * - `stagedImageCount`/`stagedFileCount` — the REAL draft store sizes,
 *   including pinned/unreferenced entries the editor text no longer mentions;
 * - `unsettledUserWrite` — an accepted business submission (prompt, Host
 *   command, steer, local shell, queue mutation) has not reached its terminal
 *   settlement;
 * - `unsettledInteraction` — a Client-local Question/Approval input is live
 *   (editor seat, continued form, delivered answer, refused admission wait);
 * - `unsettledTransition` — a local Session navigation/fork/transition or
 *   writer barrier is still in flight.
 */
export interface ClientReloadSafetyFacts {
  readonly capable: boolean
  readonly ready: boolean
  readonly draftText: string
  readonly stagedImageCount: number
  readonly stagedFileCount: number
  readonly unsettledUserWrite: boolean
  readonly unsettledInteraction: boolean
  readonly unsettledTransition: boolean
}

/**
 * The ONE Client-local reload refusal decision. Returns `undefined` only when
 * the Client may retire now; otherwise the fixed-priority reason.
 * @param facts - the live owner facts read in this synchronous call stack.
 * @returns the refusal reason, or `undefined` when reload is safe.
 */
export function clientReloadRefusal(facts: ClientReloadSafetyFacts): ClientReloadRefusal | undefined {
  if (!facts.capable) return 'unavailable'
  if (!facts.ready) return 'not-ready'
  if (facts.draftText.length !== 0) return 'draft-text'
  if (facts.stagedImageCount !== 0 || facts.stagedFileCount !== 0) return 'attachments'
  if (facts.unsettledUserWrite) return 'submission'
  if (facts.unsettledInteraction) return 'interaction'
  if (facts.unsettledTransition) return 'transition'
  return undefined
}
