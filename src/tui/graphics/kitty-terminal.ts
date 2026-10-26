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
import type { KittyGraphicsCore } from './kitty-core.ts'
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
    // Queued retirements and invisible uploads are released while the physical
    // terminal still accepts bytes; images that were really placed stay under
    // the screen's own preserve/release policy (the alternate screen emits its
    // global release through this facade; the main screen preserves its
    // scrollback).
    const cleanup = this.core.drain() + this.core.shutdownUnplaced()
    if (cleanup !== '') this.inner.write(cleanup)
    this.inner.stop()
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
    this.inner.clearScreen()
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
    let wire = this.core.drain()
    let input = data
    // Join the two bounded hold-backs with this write. They are at most one
    // incomplete APC plus one escape-sequence prefix, so no full-frame text or
    // image payload is ever retained here.
    if (input === '' && this.partialApc === '' && this.pendingText === '') {
      if (wire !== '') this.inner.write(wire)
      return
    }
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
        wire += this.scanText(input.slice(textStart), true)
        break
      }
      // A text segment followed by a graphics command is never the end of the
      // stream: holding any of it back would reorder it past that command.
      wire += this.scanText(input.slice(textStart, start), false)
      const end = input.indexOf(KITTY_APC_TERMINATOR, start + KITTY_APC_INTRODUCER.length)
      if (end === -1) {
        this.partialApc = input.slice(start)
        if (this.partialApc.length > MAX_PARTIAL_APC_CHARS) {
          throw new Error(`kitty graphics: unterminated APC after ${this.partialApc.length} chars`)
        }
        break
      }
      wire += this.handleApc(input.slice(start, end + KITTY_APC_TERMINATOR.length))
      cursor = end + KITTY_APC_TERMINATOR.length
      textStart = cursor
    }
    if (wire !== '') this.inner.write(wire)
  }

  /**
   * Observe the writer's destructive text signals. The text is returned
   * untouched — when `allowHoldback` is set and the input ends inside a
   * signal, that prefix is held back and re-emitted (in order) with the next
   * write.
   */
  private scanText(text: string, allowHoldback: boolean): string {
    if (text === '') return ''
    let index = 0
    while (index < text.length) {
      const at = text.indexOf('\x1b', index)
      if (at === -1) break
      const signal = TEXT_SIGNALS.find((candidate) => text.startsWith(candidate.sequence, at))
      if (signal !== undefined) {
        this.applyTextSignal(signal.kind)
        index = at + signal.sequence.length
        continue
      }
      const rest = text.slice(at)
      if (allowHoldback && TEXT_SIGNALS.some((candidate) => candidate.sequence.startsWith(rest))) {
        // The write ended inside a signal: hold the prefix and return the
        // visible text before it, exactly as if the signal arrived whole.
        this.pendingText = rest
        return text.slice(0, at)
      }
      index = at + 1
    }
    return text
  }

  private applyTextSignal(kind: TextSignal['kind']): void {
    switch (kind) {
      case 'clear-screen':
        this.core.invalidateResidency('2J')
        return
      case 'clear-scrollback':
        // Stage-0 S0-4 measured `none` / `2J-only` / `3J-only` / `2J+3J` in
        // fresh initial states on a real Kitty 0.41.1: a bare `3J` leaves the
        // visible screen empty AND the uploaded image data unusable (a
        // placement for the old id paints nothing until the payload is sent
        // again). The rule is therefore measured, not inferred from the spec —
        // this is a data-invalidating clear exactly like `2J`, and the next
        // placement must re-transmit first.
        this.core.invalidateResidency('3J')
        return
      case 'enter-alt':
      case 'exit-alt':
        // Each screen buffer keeps its own image set: a switch lands on a
        // buffer that may not hold the Core's data.
        this.core.invalidateResidency(kind)
        return
    }
  }

  /**
   * The graphics permission decision for one complete Kitty command. Returns
   * the exact bytes to write in its place (possibly an injected transmission
   * plus the command, possibly a translation, possibly nothing).
   */
  private handleApc(apc: string): string {
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
    const transmission = this.core.transmissionFor(imageId)
    this.core.notePlacement(imageId)
    return transmission + apc
  }

  private handleDelete(apc: string, controls: Readonly<Record<string, string>>): string {
    const imageId = numericControl(controls.i)
    if (imageId !== undefined && this.core.owns(imageId)) {
      // A legacy writer's delete of a managed image is its layout/frame intent.
      // Only the Core may free the data, so the placement is what disappears.
      return this.core.translateWriterDelete(imageId)
    }
    // A late delete for an id this Core already retired is a no-op: the data is
    // gone and the ownership decision was made at the retirement boundary.
    if (imageId !== undefined && this.core.wasOwned(imageId)) return ''
    if (imageId !== undefined) return apc // a foreign owner's image: untouched
    // Kitty's default deletion specifier is `a` ("without any other keys it
    // deletes all images visible on screen"), so a bare `a=d` is the same
    // global form and must be scoped too.
    const specifier = controls.d ?? 'a'
    if (specifier === 'A') return this.core.translateGlobalImageDelete()
    if (specifier === 'a') return this.core.translateGlobalPlacementDelete()
    return apc
  }
}
