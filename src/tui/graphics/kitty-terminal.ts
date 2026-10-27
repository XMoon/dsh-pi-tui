/**
 * `KittyTerminalFacade` — the single `Terminal` wrapper the managed graphics
 * Core observes (Image-7A PR1).
 *
 * The vendored screens (`TuiMainScreen` / `TuiAltScreen`) keep owning their
 * text frames, scrollback and layout. What this facade owns is the *graphics
 * permission* of the byte stream they produce:
 *
 * - a placement of a managed image gets its transmission injected immediately
 *   before it when the current screen buffer no longer holds the data;
 * - a legacy writer's per-id delete of a MANAGED image is layout intent, not
 *   ownership: it is translated into a scoped placement removal so the pixels
 *   disappear in that frame while the data stays resident;
 * - a legacy global delete (`d=A` / `d=a`) never reaches the terminal: it is
 *   translated into the same operations scoped to the Core's own ids, so a
 *   foreign owner's image is never touched;
 * - a destructive clear or screen-buffer switch invalidates residency, so the
 *   next placement re-transmits after the clear and before the placement;
 * - a foreign per-id delete passes through untouched.
 *
 * Everything else — text, OSC 8, OSC 52, OSC 1337, mouse/keyboard modes,
 * queries, cursor movement — is written through byte-for-byte. This is a
 * stream observer for ONE protocol family, not a general ANSI rewriter.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/kitty-terminal
 */

import type { ProgramStatus, Terminal, TerminalProgressState } from '@xmoon76/pi-tui'
import type { KittyGraphicsCore, KittyScreenBuffer } from './kitty-core.ts'
import { KITTY_APC_INTRODUCER, KITTY_APC_TERMINATOR, parseKittyApc } from './kitty-native.ts'

/**
 * The largest single Kitty command the stream may hold open across writes.
 * The managed transmit chunks are ~4 KiB each, and the fork's legacy
 * `a=T` chunker uses the same ceiling, so anything beyond this is a damaged
 * stream, not a slow one: fail fast instead of buffering without a bound.
 */
const MAX_PARTIAL_APC_CHARS = 64 * 1024

interface TextSignal {
  readonly sequence: string
  readonly kind: 'clear-screen' | 'clear-scrollback' | 'enter-alt' | 'exit-alt'
}

/**
 * The writer-issued sequences whose effect on image data/placements cannot be
 * assumed from the spec alone (Stage-0 S0-4 measures each independently).
 * `2J` clears images by the protocol's own rule; the alternate-screen switch
 * always lands on an empty image buffer.
 */
const TEXT_SIGNALS: readonly TextSignal[] = [
  { sequence: '\x1b[2J', kind: 'clear-screen' },
  { sequence: '\x1b[3J', kind: 'clear-scrollback' },
  { sequence: '\x1b[?1049h', kind: 'enter-alt' },
  { sequence: '\x1b[?1049l', kind: 'exit-alt' },
]

/**
 * The longest suffix of `text` that could still grow into a gated sequence on
 * the next write: a graphics introducer (`ESC`, `ESC _`) or the head of one of
 * the destructive signals. The writer splits a frame at its own chunk
 * boundary, which can land INSIDE the introducer — forwarding that prefix
 * would let the terminal assemble a command this gate never parsed.
 */
function trailingHoldbackLength(text: string): number {
  let longest = 0
  for (const sequence of [KITTY_APC_INTRODUCER, ...TEXT_SIGNALS.map((signal) => signal.sequence)]) {
    const limit = Math.min(sequence.length - 1, text.length)
    for (let length = limit; length > longest; length--) {
      if (sequence.startsWith(text.slice(text.length - length))) {
        longest = length
        break
      }
    }
  }
  return longest
}

function numericControl(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Wrap one real `Terminal`. All non-graphics behavior delegates unchanged; the
 * caller keeps the returned object as the ONE terminal both screens and every
 * managed consumer see.
 */
export class KittyTerminalFacade implements Terminal {
  private readonly inner: Terminal
  private readonly core: KittyGraphicsCore
  /** An incomplete APC carried to the next write (the writer splits a frame at
   *  its own chunk boundary, which can land inside a graphics command). */
  private partialApc = ''
  /** A trailing escape prefix that may complete the next write's signals. */
  private pendingText = ''
  /** Which physical screen buffer the writer is currently drawing into. */
  private buffer: KittyScreenBuffer = 'main'
  private disposed = false

  constructor(inner: Terminal, core: KittyGraphicsCore) {
    this.inner = inner
    this.core = core
  }

  // --- Terminal: pure delegation ------------------------------------------

  get columns(): number {
    return this.inner.columns
  }

  get rows(): number {
    return this.inner.rows
  }

  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, onResize)
  }

  stop(): void {
    if (this.disposed) return
    // A screen stop is NOT the end of its components: a rendered occurrence may
    // simply not have reached the terminal yet (pre-layout, clipping, a screen
    // switch, a suspend/resume). Registrations therefore stay owned by their
    // components — only the component's own retire, the screen's own release,
    // and the final `dispose()` end them. Queued retirements are still flushed
    // here while the terminal accepts bytes; images that were really placed
    // stay under the screen's preserve/release policy (the alternate screen
    // emits its global release through this facade; the main screen preserves
    // its scrollback). A failing cleanup is reported AFTER the terminal is
    // restored, never swallowed and never left to skip `inner.stop()`.
    let failure: unknown
    try {
      this.flushRetirements()
    } catch (error) {
      failure = error
    }
    this.inner.stop()
    if (failure !== undefined) throw failure
  }

  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs)
  }

  moveBy(lines: number): void {
    this.inner.moveBy(lines)
  }

  hideCursor(): void {
    this.inner.hideCursor()
  }

  showCursor(): void {
    this.inner.showCursor()
  }

  clearLine(): void {
    this.inner.clearLine()
  }

  clearFromCursor(): void {
    this.inner.clearFromCursor()
  }

  clearScreen(): void {
    // The real terminal erases every image intersecting the screen here, so the
    // Core's residency must be invalidated even though this path bypasses
    // `write()`.
    this.inner.clearScreen()
    this.core.invalidateResidency(this.buffer, 'clearScreen')
  }

  setTitle(title: string): void {
    this.inner.setTitle(title)
  }

  setProgress(active: boolean): void {
    this.inner.setProgress(active)
  }

  setProgramStatus(status: ProgramStatus): void {
    this.inner.setProgramStatus(status)
  }

  setProgressState(state: TerminalProgressState): void {
    this.inner.setProgressState?.(state)
  }

  /** Release the facade after the physical terminal is gone. Idempotent. */
  dispose(): void {
    this.disposed = true
    this.partialApc = ''
    this.pendingText = ''
  }

  // --- Terminal.write: the graphics gate -----------------------------------

  write(data: string): void {
    // Queued own-ID retirements go out FIRST, and they are only committed once
    // the sink accepted them: a failed write must be able to put them back.
    this.flushRetirements()
    let wire = ''
    /** The managed ids this frame really offered to the sink. */
    const touched: number[] = []
    let input = data
    // Join the two bounded hold-backs with this write. They are at most one
    // incomplete APC plus one escape-sequence prefix, so no full-frame text or
    // image payload is ever retained here.
    if (input === '' && this.partialApc === '' && this.pendingText === '') return
    if (this.partialApc !== '') {
      input = this.partialApc + input
      this.partialApc = ''
    }
    if (this.pendingText !== '') {
      input = this.pendingText + input
      this.pendingText = ''
    }

    let cursor = 0
    let textStart = 0
    for (;;) {
      const start = input.indexOf(KITTY_APC_INTRODUCER, cursor)
      if (start === -1) {
        const tail = input.slice(textStart)
        const hold = trailingHoldbackLength(tail)
        wire += this.scanText(hold === 0 ? tail : tail.slice(0, tail.length - hold))
        if (hold !== 0) this.pendingText = tail.slice(tail.length - hold)
        break
      }
      // A text segment followed by a graphics command is never the end of the
      // stream: holding any of it back would reorder it past that command.
      wire += this.scanText(input.slice(textStart, start))
      const end = input.indexOf(KITTY_APC_TERMINATOR, start + KITTY_APC_INTRODUCER.length)
      if (end === -1) {
        this.partialApc = input.slice(start)
        if (this.partialApc.length > MAX_PARTIAL_APC_CHARS) {
          throw new Error(`kitty graphics: unterminated APC after ${this.partialApc.length} chars`)
        }
        break
      }
      wire += this.handleApc(input.slice(start, end + KITTY_APC_TERMINATOR.length), touched)
      cursor = end + KITTY_APC_TERMINATOR.length
      textStart = cursor
    }
    if (wire === '') return
    try {
      this.inner.write(wire)
    } catch (error) {
      // `Terminal.write()` is an offer, never a terminal ACK: bytes may have
      // partially reached the sink. The touched images are now UNKNOWN, so the
      // next placement re-sends them; nothing is hard-deleted (a partially
      // painted image may still be referenced) and the failure is rethrown
      // instead of being swallowed.
      this.core.noteWriteFailure(touched, this.buffer)
      throw error
    }
  }

  /** Offer the queued own-ID retirements; commit or roll back on the result. */
  private flushRetirements(): void {
    const { wire, ids } = this.core.takeRetirements()
    if (wire === '') return
    try {
      this.inner.write(wire)
    } catch (error) {
      this.core.rollbackRetirements(ids)
      throw error
    }
    this.core.commitRetirements(ids)
  }

  /**
   * Observe the writer's destructive text signals and return the text
   * untouched. A signal split across writes is completed by the holdback in
   * `write()` before this runs, so anything recognised here is whole.
   */
  private scanText(text: string): string {
    if (text === '') return ''
    let index = 0
    while (index < text.length) {
      const at = text.indexOf('\x1b', index)
      if (at === -1) break
      const signal = TEXT_SIGNALS.find((candidate) => text.startsWith(candidate.sequence, at))
      if (signal === undefined) {
        index = at + 1
        continue
      }
      this.applyTextSignal(signal.kind)
      index = at + signal.sequence.length
    }
    return text
  }

  private applyTextSignal(kind: TextSignal['kind']): void {
    switch (kind) {
      case 'clear-screen':
        this.core.invalidateResidency(this.buffer, '2J')
        return
      case 'clear-scrollback':
        // Stage-0 S0-4 measured `none` / `2J-only` / `3J-only` / `2J+3J` in
        // fresh initial states on a real Kitty 0.41.1: a bare `3J` leaves the
        // visible screen empty AND the uploaded image data unusable (a
        // placement for the old id paints nothing until the payload is sent
        // again). The rule is therefore measured, not inferred from the spec —
        // this is a data-invalidating clear exactly like `2J`, and the next
        // placement must re-transmit first.
        this.core.invalidateResidency(this.buffer, '3J')
        return
      case 'enter-alt':
        // The alternate buffer starts empty: anything the Core placed there in
        // an earlier alternate session is gone. The MAIN buffer keeps its
        // images (Kitty stores them per screen), so its data stays resident.
        this.buffer = 'alt'
        this.core.invalidateResidency('alt', 'enter-alt')
        this.core.beginAltSession()
        return
      case 'exit-alt':
        // Leaving discards the alternate buffer's images; the main buffer's
        // images and placements survive the round trip untouched. An ordinary
        // clear INSIDE a session must never take this path: it invalidates
        // residency without ending the session's placement ownership.
        this.core.invalidateResidency('alt', 'exit-alt')
        this.core.endAltSession()
        this.buffer = 'main'
        return
    }
  }

  /**
   * The graphics permission decision for one complete Kitty command. Returns
   * the exact bytes to write in its place (possibly an injected transmission
   * plus the command, possibly a translation, possibly nothing).
   */
  private handleApc(apc: string, touched: number[]): string {
    const command = parseKittyApc(apc)
    if (command === undefined) return apc
    const action = command.controls.a
    if (action === 'd') return this.handleDelete(apc, command.controls)
    if (action !== 'p') return apc
    const imageId = numericControl(command.controls.i)
    if (imageId === undefined || !this.core.owns(imageId)) return apc
    // Data must be resident BEFORE the placement lands: the transmission is
    // injected at the placement's own position in the stream, never earlier
    // (a clear between the two writes would invalidate it again).
    const transmission = this.core.transmissionFor(imageId, this.buffer)
    this.core.notePlacement(imageId, this.buffer)
    touched.push(imageId)
    return transmission + apc
  }

  private handleDelete(apc: string, controls: Readonly<Record<string, string>>): string {
    const imageId = numericControl(controls.i)
    if (imageId !== undefined) {
      // A delete for an id inside this Core's own id range — live or retired —
      // is its layout/frame intent: only the Core may free the data, so the
      // placement is what disappears. Anything outside that range is a foreign
      // owner's command and is never touched.
      const translated = this.core.translateWriterDelete(imageId)
      return translated === '' ? apc : translated
    }
    // Kitty's default deletion specifier is `a` ("without any other keys it
    // deletes all images visible on screen"), so a bare `a=d` is the same
    // global form and must be scoped too.
    const specifier = controls.d ?? 'a'
    if (specifier === 'A') return this.core.translateGlobalImageDelete(this.buffer)
    if (specifier === 'a') return this.core.translateGlobalPlacementDelete(this.buffer)
    return apc
  }
}
