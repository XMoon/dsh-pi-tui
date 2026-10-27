/**
 * `KittyTerminalFacade` — the single `Terminal` wrapper the managed graphics
 * Core observes (Image-7A PR1, extended by Image-7B-A).
 *
 * The vendored screens (`TuiMainScreen` / `TuiAltScreen`) keep owning their
 * text frames, scrollback and layout. What this facade owns is the *graphics
 * permission* of the byte stream they produce:
 *
 * - a placement of a managed image gets its transmission injected immediately
 *   before it when the current screen buffer no longer holds the data;
 * - a legacy writer's per-id delete of a MANAGED image is layout intent, not
 *   ownership: it is translated into a scoped placement removal so the pixels
 *   disappear in that frame while the data stays resident (Native), or into no
 *   bytes at all because the text cells themselves hide the image (tmux
 *   virtual);
 * - a legacy global delete (`d=A` / `d=a`) becomes the same operations scoped
 *   to the Core's own ids (Native), or nothing at all (tmux virtual, whose
 *   invisible prototype has no physical place to delete);
 * - a destructive clear or screen-buffer switch invalidates residency, so the
 *   next placement re-transmits after the clear and before the placement;
 * - a foreign per-id delete passes through untouched.
 *
 * In the tmux virtual backend every managed Kitty APC — each transmission
 * chunk, the virtual placement and each Core retirement — is individually
 * wrapped in the tmux passthrough DCS. Nothing else is rewritten. Before ANY
 * physical write that carries a managed command, the facade re-probes the real
 * tmux client binding; a revoked handle throws instead of letting an unwrapped
 * APC or an unadmitted placeholder grid escape.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/kitty-terminal
 */

import type { ProgramStatus, Terminal, TerminalProgressState } from '@xmoon76/pi-tui'
import type {
  KittyGlobalImageDeletePlan,
  KittyGraphicsCore,
  KittyPlacementMode,
  KittyScreenBuffer,
} from './kitty-core.ts'
import { KITTY_APC_INTRODUCER, KITTY_APC_TERMINATOR, parseKittyApc } from './kitty-native.ts'
import type { TmuxKittyAdmission } from './tmux-admission.ts'
import { encodeTmuxPassthrough, stripManagedVirtualMarkers } from './tmux-virtual.ts'

/**
 * The physical-write refusal of a tmux virtual handle whose live admission was
 * revoked. The whole batch is refused: filtering the DCS but still writing the
 * same batch's placeholder cells would leave an unadmitted grid on screen.
 * The product layer must paint its text fallback and restart the TUI is the
 * only way to re-enable images.
 */
export class TmuxGraphicsRevokedError extends Error {
  constructor() {
    super('tmux graphics admission revoked; restart the TUI to enable images again')
    this.name = 'TmuxGraphicsRevokedError'
  }
}

/** The facade's immutable transport mode plus its tmux-only admission. */
export interface KittyTerminalFacadeOptions {
  readonly placementMode?: KittyPlacementMode
  /** Required for `tmux-virtual`; ignored by `native`. */
  readonly admission?: TmuxKittyAdmission
}

/**
 * The largest single Kitty command the stream may hold open across writes.
 * The managed transmit chunks are ~4 KiB each, and the fork's legacy
 * `a=T` chunker uses the same ceiling, so anything beyond this is a damaged
 * stream, not a slow one: fail fast instead of buffering without a bound.
 */
const MAX_PARTIAL_APC_CHARS = 64 * 1024
/** A complete provenance marker is far below this; a longer hold is a bug. */
const MAX_PENDING_MARKER_CHARS = 512

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

type ParsedSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'apc'; readonly apc: string }

/**
 * Split a concatenation of complete Core-owned Kitty commands into individual
 * APCs so each can get its own passthrough DCS. A non-APC byte in the Core's
 * own wire is an internal contract breach, not something to forward.
 */
function splitKittyApcs(wire: string): string[] {
  const apcs: string[] = []
  let index = 0
  while (index < wire.length) {
    if (!wire.startsWith(KITTY_APC_INTRODUCER, index)) {
      throw new Error('tmux graphics: own wire is not a Kitty APC sequence')
    }
    const end = wire.indexOf(KITTY_APC_TERMINATOR, index + KITTY_APC_INTRODUCER.length)
    if (end === -1) throw new Error('tmux graphics: unterminated own Kitty APC')
    apcs.push(wire.slice(index, end + KITTY_APC_TERMINATOR.length))
    index = end + KITTY_APC_TERMINATOR.length
  }
  return apcs
}

function wrapManagedWire(wire: string): string {
  if (wire === '') return ''
  return splitKittyApcs(wire).map((apc) => encodeTmuxPassthrough(apc)).join('')
}

/**
 * Wrap one real `Terminal`. All non-graphics behavior delegates unchanged; the
 * caller keeps the returned object as the ONE terminal both screens and every
 * managed consumer see.
 */
export class KittyTerminalFacade implements Terminal {
  private readonly inner: Terminal
  private readonly core: KittyGraphicsCore
  private readonly placementMode: KittyPlacementMode
  private readonly admission: TmuxKittyAdmission | undefined
  /** An incomplete APC carried to the next write (the writer splits a frame at
   *  its own chunk boundary, which can land inside a graphics command). */
  private partialApc = ''
  /** A trailing escape prefix that may complete the next write's signals. */
  private pendingText = ''
  /** A split internal provenance marker that must never reach the terminal. */
  private pendingMarker = ''
  /** Which physical screen buffer the writer is currently drawing into. */
  private buffer: KittyScreenBuffer = 'main'
  /** Global image deletes offered by THIS write, committed only on success. */
  private pendingGlobalDeletes: KittyGlobalImageDeletePlan[] = []
  private disposed = false

  constructor(inner: Terminal, core: KittyGraphicsCore, options: KittyTerminalFacadeOptions = {}) {
    this.inner = inner
    this.core = core
    this.placementMode = options.placementMode ?? 'native'
    this.admission = options.admission
    if (this.placementMode === 'tmux-virtual' && this.admission === undefined) {
      throw new Error('tmux virtual facade requires an admission handle')
    }
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
      this.flushPendingRetirementsForStop()
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
    this.pendingMarker = ''
  }

  // --- Terminal.write: the graphics gate -----------------------------------

  write(data: string): void {
    if (this.placementMode === 'native') {
      this.writeNative(data)
      return
    }
    this.writeTmuxVirtual(data)
  }

  private writeNative(data: string): void {
    // Queued own-ID retirements go out FIRST, and they are only committed once
    // the sink accepted them: a failed write must be able to put them back.
    this.flushRetirements()
    const input = this.takeInput(data)
    if (input === undefined) return
    let wire = ''
    /** The managed ids this frame really offered to the sink. */
    const touched: number[] = []
    this.pendingGlobalDeletes = []
    for (const segment of this.scanSegments(input)) {
      wire += segment.kind === 'text' ? this.scanText(segment.text) : this.handleApc(segment.apc, touched)
    }
    if (wire === '') {
      // Nothing offered: a queued plan cannot have consumed ownership.
      this.pendingGlobalDeletes = []
      return
    }
    try {
      this.inner.write(wire)
    } catch (error) {
      // The global-delete plans were never committed, so every id they would
      // have released is still owned and the next cleanup retries them.
      this.pendingGlobalDeletes = []
      // `Terminal.write()` is an offer, never a terminal ACK: bytes may have
      // partially reached the sink. The touched images are now UNKNOWN, so the
      // next placement re-sends them; nothing is hard-deleted (a partially
      // painted image may still be referenced) and the failure is rethrown
      // instead of being swallowed.
      this.core.noteWriteFailure(touched, this.buffer)
      throw error
    }
    for (const plan of this.pendingGlobalDeletes) this.core.commitGlobalImageDelete(plan)
    this.pendingGlobalDeletes = []
  }

  private writeTmuxVirtual(data: string): void {
    const input = this.takeInput(data)
    if (input === undefined && !this.core.hasQueuedRetirements()) return
    const segments = input === undefined ? [] : this.scanSegments(input)
    const hasManagedPlacement = segments.some(
      (segment) => segment.kind === 'apc' && this.managedPlacementId(segment.apc) !== undefined,
    )
    const hasRetirements = this.core.hasQueuedRetirements()
    // The admission check comes BEFORE any managed APC/retirement is written.
    // A revoked handle must not flush old IDs to a new client, and refusing the
    // whole managed batch (including its placeholder text) is deliberate:
    // filtering the DCS but painting the grid would be an unadmitted image.
    if ((hasManagedPlacement || hasRetirements) && this.admission?.isAllowed(true) !== true) {
      // A never-painted retirement is only a local pending byte set; dropping it
      // here lets the caller's text-only fallback frame still reach the screen
      // instead of throwing forever. Nothing is sent to the possibly different
      // client and no painted image is affected.
      this.core.discardQueuedRetirements()
      if (hasManagedPlacement) throw new TmuxGraphicsRevokedError()
    }
    this.pendingGlobalDeletes = []
    // Queued retirements still go first, each one individually DCS-wrapped.
    if (this.core.hasQueuedRetirements()) this.flushVirtualRetirements()
    let wire = ''
    const touched: number[] = []
    for (const segment of segments) {
      wire += segment.kind === 'text' ? this.scanText(segment.text) : this.handleApc(segment.apc, touched)
    }
    if (wire === '') {
      this.pendingGlobalDeletes = []
      return
    }
    try {
      this.inner.write(wire)
    } catch (error) {
      this.pendingGlobalDeletes = []
      this.core.noteWriteFailure(touched, this.buffer)
      throw error
    }
    for (const plan of this.pendingGlobalDeletes) this.core.commitGlobalImageDelete(plan)
    this.pendingGlobalDeletes = []
  }

  /**
   * Join the two bounded hold-backs with this write. They are at most one
   * incomplete APC plus one escape-sequence prefix, so no full-frame text or
   * image payload is ever retained here. `undefined` means the write carries
   * nothing at all (the queued-retirement check is the caller's business).
   */
  private takeInput(data: string): string | undefined {
    if (data === '' && this.partialApc === '' && this.pendingText === '' && this.pendingMarker === '') {
      return undefined
    }
    let input = data
    if (this.pendingMarker !== '') {
      input = this.pendingMarker + input
      this.pendingMarker = ''
    }
    if (this.partialApc !== '') {
      input = this.partialApc + input
      this.partialApc = ''
    }
    if (this.pendingText !== '') {
      input = this.pendingText + input
      this.pendingText = ''
    }
    const stripped = stripManagedVirtualMarkers(input)
    if (stripped.hold.length > MAX_PENDING_MARKER_CHARS) {
      throw new Error(`kitty graphics: unterminated provenance marker after ${stripped.hold.length} chars`)
    }
    this.pendingMarker = stripped.hold
    return stripped.text
  }

  /**
   * Split one write into ordered text and complete-APC segments, carrying the
   * incomplete APC and the trailing escape prefix to the next write. A text
   * segment followed by a graphics command is never held back: holding any of
   * it would reorder it past that command.
   */
  private scanSegments(input: string): ParsedSegment[] {
    const segments: ParsedSegment[] = []
    let cursor = 0
    let textStart = 0
    for (;;) {
      const start = input.indexOf(KITTY_APC_INTRODUCER, cursor)
      if (start === -1) {
        const tail = input.slice(textStart)
        const hold = trailingHoldbackLength(tail)
        if (hold !== 0) {
          segments.push({ kind: 'text', text: tail.slice(0, tail.length - hold) })
          this.pendingText = tail.slice(tail.length - hold)
        } else {
          segments.push({ kind: 'text', text: tail })
        }
        break
      }
      segments.push({ kind: 'text', text: input.slice(textStart, start) })
      const end = input.indexOf(KITTY_APC_TERMINATOR, start + KITTY_APC_INTRODUCER.length)
      if (end === -1) {
        this.partialApc = input.slice(start)
        if (this.partialApc.length > MAX_PARTIAL_APC_CHARS) {
          throw new Error(`kitty graphics: unterminated APC after ${this.partialApc.length} chars`)
        }
        break
      }
      segments.push({ kind: 'apc', apc: input.slice(start, end + KITTY_APC_TERMINATOR.length) })
      cursor = end + KITTY_APC_TERMINATOR.length
      textStart = cursor
    }
    return segments
  }

  /** The managed placement id in one APC: `a=p,U=1` inside the Core slice. */
  private managedPlacementId(apc: string): number | undefined {
    const command = parseKittyApc(apc)
    if (command === undefined || command.controls.a !== 'p' || command.controls.U !== '1') return undefined
    const imageId = numericControl(command.controls.i)
    if (imageId === undefined || !this.core.ownsIdSpace(imageId)) return undefined
    return imageId
  }

  /**
   * Offer the queued own-ID retirements; commit or roll back on the result.
   * Native: raw Core bytes.
   */
  private flushRetirements(): void {
    const { wire, ids } = this.core.takeRetirements()
    if (wire === '') {
      // Nothing offered: a queued plan cannot have consumed ownership.
      this.pendingGlobalDeletes = []
      return
    }
    try {
      this.inner.write(wire)
    } catch (error) {
      // The global-delete plans were never committed, so every id they would
      // have released is still owned and the next cleanup retries them.
      this.pendingGlobalDeletes = []
      this.core.rollbackRetirements(ids)
      throw error
    }
    this.core.commitRetirements(ids)
  }

  /** tmux virtual: each retirement is its own DCS-wrapped Kitty APC. */
  private flushVirtualRetirements(): void {
    const { wire, ids } = this.core.takeRetirements()
    if (wire === '') return
    try {
      this.inner.write(wrapManagedWire(wire))
    } catch (error) {
      this.pendingGlobalDeletes = []
      this.core.rollbackRetirements(ids)
      throw error
    }
    this.core.commitRetirements(ids)
  }

  /**
   * A revoked tmux handle may not flush its queued retirements to whatever
   * client is attached now (it could be a different outer terminal). The state
   * is simply released by `Core.dispose()` instead. A still-admitted handle
   * flushes exactly like a native stop.
   */
  private flushPendingRetirementsForStop(): void {
    if (this.placementMode === 'native') {
      this.flushRetirements()
      return
    }
    if (!this.core.hasQueuedRetirements()) return
    if (this.admission?.isAllowed(true) !== true) {
      // Revoked: do not send old IDs to a possibly different client. These are
      // never-painted records only, so the local release is safe and invisible.
      this.core.discardQueuedRetirements()
      return
    }
    this.flushVirtualRetirements()
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
        // Native: the alternate buffer starts empty, so anything the Core
        // placed there in an earlier alternate session is gone; the MAIN
        // buffer keeps its images. tmux virtual: the outer image namespace is
        // shared and the screen switch itself does not clear the text cells of
        // the other buffer, so residency survives the switch.
        this.buffer = 'alt'
        if (this.placementMode === 'native') this.core.invalidateResidency('alt', 'enter-alt')
        this.core.beginAltSession()
        return
      case 'exit-alt':
        // Native: leaving discards the alternate buffer's images; the main
        // buffer's images and placements survive. tmux virtual: the placement
        // is a text-driven prototype in the one outer namespace; the replayed
        // main cells still refer to it, so it must not be discarded here.
        if (this.placementMode === 'native') this.core.invalidateResidency('alt', 'exit-alt')
        this.core.endAltSession()
        this.buffer = 'main'
        return
    }
  }

  /**
   * The graphics permission decision for one complete Kitty command. Returns
   * the exact bytes to write in its place (possibly injected transmissions plus
   * the command, possibly a translation, possibly nothing).
   */
  private handleApc(apc: string, touched: number[]): string {
    const command = parseKittyApc(apc)
    if (command === undefined) return apc
    const action = command.controls.a
    if (action === 'd') return this.handleDelete(apc, command.controls)
    if (action !== 'p') return apc
    const imageId = numericControl(command.controls.i)
    if (imageId === undefined) return apc
    if (this.placementMode === 'tmux-virtual') {
      // Only the Core's own virtual placement is managed. `ownsIdSpace` is the
      // Core's ownership predicate for the whole reserved slice, including an
      // already-retired id whose pixels the outer terminal still holds: such an
      // anchor must still be DCS-wrapped, never leaked raw into tmux.
      if (command.controls.U !== '1' || !this.core.ownsIdSpace(imageId)) return apc
      const transmission = this.core.transmissionFor(imageId, this.buffer)
      this.core.notePlacement(imageId, this.buffer)
      touched.push(imageId)
      return wrapManagedWire(transmission) + encodeTmuxPassthrough(apc)
    }
    if (!this.core.owns(imageId)) return apc
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
      if (this.placementMode === 'tmux-virtual') {
        // Writer-issued deletes for OUR ids are layout intent and emit nothing;
        // a foreign owner's command is never hijacked and keeps its exact bytes.
        return this.core.ownsIdSpace(imageId) ? '' : apc
      }
      // A delete for an id inside this Core's own id range — live or retired —
      // is its layout/frame intent: only the Core may free the data, so the
      // placement is what disappears. Anything outside that range is a foreign
      // owner's command and is never touched.
      const translated = this.core.translateWriterDelete(imageId)
      return translated === '' ? apc : translated
    }
    if (this.placementMode === 'tmux-virtual') {
      // No global deletion form may ever reach the outer terminal: virtual
      // placements have no physical location and scrollback prototypes are not
      // ours to erase.
      return ''
    }
    // Kitty's default deletion specifier is `a` ("without any other keys it
    // deletes all images visible on screen"), so a bare `a=d` is the same
    // global form and must be scoped too.
    const specifier = controls.d ?? 'a'
    if (specifier === 'A') {
      // Ownership may only be consumed once the sink accepted the bytes, so the
      // plan is committed by `write()` after `inner.write()` returns.
      const plan = this.core.planGlobalImageDelete(this.buffer)
      if (plan.wire !== '') this.pendingGlobalDeletes.push(plan)
      return plan.wire
    }
    if (specifier === 'a') return this.core.translateGlobalPlacementDelete(this.buffer)
    return apc
  }
}
