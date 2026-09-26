/**
 * The live-turn interrupt helper (web Stop parity): abort the current
 * turn/tool run while PRESERVING the pending queue. Kept out of the
 * composition root so the rule is testable headless, and its structural
 * faces keep the internal runtime port module out of the published entry.
 * @module @xmoon76/dsh-pi-tui/interrupt
 */
/** Public settlement shape for the interrupt helper. Kept local so the
 * entry-point declaration does not expose the internal runtime port module. */
export type InterruptWriteOutcome =
  | { readonly kind: 'committed'; readonly value: undefined }
  | { readonly kind: 'rejected'; readonly error: {
      readonly code: string
      readonly message: string
      readonly details?: Readonly<Record<string, unknown>>
    } }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'indeterminate'; readonly error: {
      readonly code: string
      readonly message: string
      readonly details?: Readonly<Record<string, unknown>>
    } }
  | { readonly kind: 'unsupported'; readonly reason: string }

/** The live-agent surface {@link interruptAgent} needs (structural — the
 * TUI never imports the agent runtime for this call). */
export interface InterruptAgentLike {
  readonly session: { readonly id: string }
  readonly status: string
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
}

/** The writer surface {@link interruptAgent} needs (structural — a LOCAL
 * type so the public declaration never inlines internal runtime modules;
 * the runner's SessionWriter satisfies it). */
export interface InterruptWriterLike {
  cancel(sessionId: string): Promise<InterruptWriteOutcome>
}

/**
 * Interrupt the live agent (web Stop parity): abort the current
 * turn/tool run while PRESERVING the pending queue. dsh's DEFAULT
 * `cancel()` clears queued AND steering input, so a bare cancel would
 * destroy everything the user queued with Ctrl+S / queue-mode Enter —
 * the Esc-interrupt semantic is "stop the current thinking", never
 * "drop the queue". `keepInbox: true` parks the preserved work; dsh's
 * cancel is a documented no-op when nothing is active, so an idle
 * interrupt (double-Esc while idle) is harmless and still aborts a
 * local shell / maintenance task through the caller.
 *
 * NOTE (upstream dependency): dsh currently PARKS the preserved queue
 * after an abort — the "Esc with a queue continues immediately" UX
 * needs an upstream `wakePending`/`continueInbox` capability (not yet
 * in dsh). A TUI-side emulation (remove + re-send a queue message)
 * would fabricate durable discarded/inserted events in the session
 * log, which the design explicitly rejects — the parked queue is the
 * agreed web-parity behavior until upstream lands the capability.
 */
export function interruptAgent(agent: InterruptAgentLike | undefined, writer: InterruptWriterLike): Promise<InterruptWriteOutcome> {
  if (agent === undefined) return Promise.resolve({ kind: 'committed', value: undefined })
  return writer.cancel(agent.session.id)
}
