/**
 * The tmux U1 feature-query probe (Image-7C tmux supplement).
 *
 * tmux forwards a DCS passthrough to the outer terminal, but it does not manage
 * the outer terminal's Unicode-placeholder capability. A client that is not
 * one of the pre-feature-query Kitty/Ghostty evidence lines therefore proves
 * `U=1` with the protocol's own feature query:
 *
 *   ESC _ G a=q,i=<id>,e=T,U=1 ESC \
 *
 * A valid reply must echo the same id and contain `e=T`, `U=1` and payload
 * `OK`. A plain `a=q` acknowledgement (or any reply without `e`) proves only the
 * base Kitty protocol; it must stay text-only. This module owns no image id,
 * placement, payload or terminal frame: it answers exactly one capability
 * question for one graphics handle.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/tmux-kitty-feature-probe
 */

import { randomInt } from 'node:crypto'
import { KITTY_APC_INTRODUCER, KITTY_APC_TERMINATOR, parseKittyApc } from './kitty-native.ts'

/** The high-half range reserved for per-admission probe ids (Core ids stay below). */
const TMUX_FEATURE_PROBE_ID_MIN = 0x80000000
const TMUX_FEATURE_PROBE_ID_MAX = 0xffffffff

/** The bounded wait after which an unanswered feature query is denied. */
export const TMUX_FEATURE_PROBE_TIMEOUT_MS = 500

/** Create a fresh, unpredictable feature-probe id for ONE graphics handle. */
export function createTmuxFeatureProbeId(): number {
  return randomInt(TMUX_FEATURE_PROBE_ID_MIN, TMUX_FEATURE_PROBE_ID_MAX)
}

/** Encode the ONE feature query: `a=q` stores no image and moves no cursor. */
export function tmuxFeatureQueryWire(probeId: number): string {
  return `${KITTY_APC_INTRODUCER}a=q,i=${probeId},e=T,U=1${KITTY_APC_TERMINATOR}`
}

type TmuxFeatureProbeState = 'pending' | 'probing' | 'allowed' | 'denied'

/**
 * One TuiApp lifetime's U1 feature state for one tmux virtual handle.
 *
 * `pending -> probing -> allowed | denied`; only a matching live feature reply
 * may promote once, and `denied` is permanent. The class never writes bytes
 * itself: the terminal wrapper supplies the write callback after the real
 * input listener is installed, so a query can never be sent from a constructor
 * or a render pass.
 */
export class TmuxKittyFeatureProbe {
  private readonly onAllowed: (() => void) | undefined
  private readonly probeIdValue: number
  private state: TmuxFeatureProbeState = 'pending'
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  /** Whether the facade currently has a real input listener installed. */
  private inputActive = false

  constructor(onAllowed?: () => void, probeId: number = createTmuxFeatureProbeId()) {
    this.onAllowed = onAllowed
    this.probeIdValue = probeId
  }

  /** The one unpredictable id this handle owns. */
  get probeId(): number {
    return this.probeIdValue
  }

  /** The exact query this handle must send once. */
  get probeWire(): string {
    return tmuxFeatureQueryWire(this.probeIdValue)
  }

  /** Whether this handle's live feature query was answered with `e=T,U=1;OK`. */
  get allowed(): boolean {
    return this.state === 'allowed'
  }

  /** Whether the screen currently has the facade's input listener mounted. */
  get inputListening(): boolean {
    return this.inputActive && !this.disposed
  }

  /** Record a real `Terminal.start()` (main/alt hand-off keeps the admission). */
  markInputStarted(): void {
    if (!this.disposed) this.inputActive = true
  }

  /** Record a real `Terminal.stop()`; the one-way feature admission survives. */
  markInputStopped(): void {
    this.inputActive = false
  }

  /**
   * Mark probing, install the bounded timeout, THEN write the one query. The
   * order is observable: a synchronous reply from a test sink must not be
   * overwritten back to `probing`. A throwing write denies immediately and
   * rethrows so the caller keeps the real failure.
   */
  start(sendQuery: () => void): void {
    if (this.disposed || this.state !== 'pending') return
    this.state = 'probing'
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.state === 'probing') this.state = 'denied'
    }, TMUX_FEATURE_PROBE_TIMEOUT_MS)
    this.timer.unref()
    try {
      sendQuery()
    } catch (error) {
      this.clearTimer()
      this.state = 'denied'
      throw error
    }
  }

  /**
   * Consume one complete input sequence when it is THIS probe's reply.
   *
   * `StdinBuffer` has already rebuilt split APC input into complete sequences.
   * A reply for any other id (or any other input) returns `false` and flows to
   * the screen untouched. A matching-id reply is always consumed so it cannot
   * surface as editor input, but it only promotes while probing and only with
   * the exact `e=T,U=1;OK` feature result. `canCommit` is the live identity
   * check: a reply observed after the bound client changed must deny instead of
   * promoting, even if the terminal that sent it supports the feature. A late
   * reply after allowed/denied or dispose never changes the one-way state.
   */
  consume(data: string, canCommit?: () => boolean): boolean {
    if (!data.startsWith(KITTY_APC_INTRODUCER) || !data.endsWith(KITTY_APC_TERMINATOR)) return false
    const command = parseKittyApc(data)
    if (command === undefined || command.controls.i !== String(this.probeIdValue)) return false
    if (this.state === 'probing' && !this.disposed) {
      this.clearTimer()
      if (canCommit !== undefined && !canCommit()) {
        this.state = 'denied'
      } else if (command.controls.e === 'T' && command.controls.U === '1' && command.payload === 'OK') {
        this.state = 'allowed'
        this.onAllowed?.()
      } else {
        this.state = 'denied'
      }
    }
    return true
  }

  /** Cancel the pending timer; late replies are consumed but never promote. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
