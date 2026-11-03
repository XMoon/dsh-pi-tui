/**
 * The ONE native tmux SIXEL transport (Image-8 / I8-4).
 *
 * tmux 3.4+ parses a pane's own SIXEL DCS and paints it on the attached client
 * when both the server and the live client advertise SIXEL support. The app
 * therefore writes its existing, owner-registered SIXEL DCS unchanged — no
 * `DCS tmux;` passthrough envelope is involved.
 *
 * The facade owns exactly one responsibility: a bounded byte-stream holdback
 * for the SIXEL introducer this owner emits (`ESC P0;1;q … ESC \`). The fork's
 * `BoundedTerminalWriter` splits a frame at 1 MiB, so a managed DCS can span
 * several `Terminal.write()` calls. A partial DCS must never reach the sink,
 * and a complete trusted DCS is re-admitted through a forced live probe on the
 * SAME handle before its first byte is written. An untrusted lookalike DCS is
 * ordinary text and gets no admission shortcut.
 *
 * @module @xmoon76/dsh-pi-tui/tui/graphics/tmux-sixel
 */

import type { ProgramStatus, Terminal } from '@xmoon76/pi-tui'
import {
  TMUX_KITTY_PLACEHOLDERS_ENV,
  probeTmuxKittyIdentity,
  tmuxKittyHasKnownUnicodePlaceholders,
} from './tmux-admission.ts'
import { TmuxGraphicsRevokedError } from './kitty-terminal.ts'
import {
  createSixelGraphicsWithAdmission,
  SIXEL_REGISTRY_MAX_BYTES,
  type DirectSixelGraphics,
  type SixelScreenObservation,
} from './sixel-image.ts'
import { imageProtocolPreference, type ImageProtocolPreference } from './image-protocol-preference.ts'
import { TmuxSixelAdmission, probeTmuxSixelIdentity } from './tmux-sixel-admission.ts'

/** The exact introducer every owner-produced SIXEL DCS starts with. */
const SIXEL_DCS_INTRODUCER = '\x1bP0;1;q'
/** The SIXEL string terminator. */
const SIXEL_DCS_TERMINATOR = '\x1b\\'

/** The longest suffix of `text` that could still grow into the introducer. */
function introducerHoldLength(text: string): number {
  const limit = Math.min(SIXEL_DCS_INTRODUCER.length - 1, text.length)
  for (let length = limit; length > 0; length -= 1) {
    if (SIXEL_DCS_INTRODUCER.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

/**
 * Whether the old tmux virtual Kitty transport is a live, trustworthy U1
 * positive and therefore keeps its fixed precedence over native SIXEL.
 *
 * A pending unknown-renderer U1 probe is NOT a positive: a real Sxl client
 * outranks a transport that has never proven it can draw. Only known
 * Kitty/Ghostty U1 evidence or the explicit placeholder assertion counts.
 */
function tmuxKittyTransportHasPriority(
  env: NodeJS.ProcessEnv,
  preference: ImageProtocolPreference,
): boolean {
  const identity = probeTmuxKittyIdentity(env, preference)
  if (identity === undefined) return false
  return tmuxKittyHasKnownUnicodePlaceholders(identity) || env[TMUX_KITTY_PLACEHOLDERS_ENV] === '1'
}

/** One real `Terminal` with the trusted-SIXEL write gate. */
export class TmuxSixelTerminal implements Terminal {
  private readonly inner: Terminal
  private readonly admission: TmuxSixelAdmission
  private readonly trustedDcs: (dcs: string) => boolean
  /** A held partial introducer or complete-in-progress managed DCS. */
  private pending = ''
  private disposed = false

  constructor(
    inner: Terminal,
    admission: TmuxSixelAdmission,
    trustedDcs: (dcs: string) => boolean,
  ) {
    this.inner = inner
    this.admission = admission
    this.trustedDcs = trustedDcs
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
    this.pending = ''
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
    // A partial command from the old screen can never belong to a cleared
    // buffer; drop it rather than appending the next frame to it.
    this.pending = ''
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

  get setProgressState(): Terminal['setProgressState'] {
    const method = this.inner.setProgressState
    return method === undefined ? undefined : method.bind(this.inner)
  }

  get onSixelSupport(): Terminal['onSixelSupport'] {
    const method = this.inner.onSixelSupport
    return method === undefined ? undefined : method.bind(this.inner)
  }

  // --- Terminal.write: the trusted-DCS gate --------------------------------

  write(data: string): void {
    if (this.disposed) return
    let input = this.pending + data
    this.pending = ''
    let cursor = 0
    while (cursor < input.length) {
      const start = input.indexOf(SIXEL_DCS_INTRODUCER, cursor)
      if (start === -1) {
        const tail = input.slice(cursor)
        const hold = introducerHoldLength(tail)
        const text = hold === 0 ? tail : tail.slice(0, tail.length - hold)
        if (text !== '') this.inner.write(text)
        this.pending = hold === 0 ? '' : tail.slice(tail.length - hold)
        return
      }
      if (start > cursor) this.inner.write(input.slice(cursor, start))
      const end = input.indexOf(SIXEL_DCS_TERMINATOR, start + SIXEL_DCS_INTRODUCER.length)
      if (end === -1) {
        const held = input.slice(start)
        if (held.length > SIXEL_REGISTRY_MAX_BYTES) {
          throw new Error('tmux SIXEL: managed DCS exceeds the registry bound')
        }
        this.pending = held
        return
      }
      const dcs = input.slice(start, end + SIXEL_DCS_TERMINATOR.length)
      // A completed DCS on the managed introducer path is never an ordinary
      // text byte. An unregistered lookalike is a refusal, not a pass-through:
      // it must write zero bytes and cannot bypass the forced live probe.
      if (!this.trustedDcs(dcs)) throw new TmuxGraphicsRevokedError()
      // The forced probe happens BEFORE the first byte of this DCS: a client
      // change is detected cleanly and the refused command writes zero bytes.
      if (!this.admission.isAllowed(true)) throw new TmuxGraphicsRevokedError()
      this.inner.write(dcs)
      cursor = end + SIXEL_DCS_TERMINATOR.length
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = ''
  }
}

/** A terminal produced by the native tmux SIXEL factory. */
export function isTmuxSixelTerminal(terminal: Terminal): terminal is TmuxSixelTerminal {
  return terminal instanceof TmuxSixelTerminal
}

/**
 * Create the ONE native tmux SIXEL handle for this app, or `undefined` when
 * either the server/client binding is not proven or the old tmux Kitty
 * transport has a trustworthy live U1 positive.
 *
 * The returned `graphics.terminal` is the write gate; the SIXEL owner, its
 * encoder, registry and Screen trust port are the SAME implementation Direct
 * SIXEL uses.
 */
export function createTmuxSixelGraphics(
  terminal: Terminal,
  environment: NodeJS.ProcessEnv = process.env,
  onReadinessChanged: () => void = () => {},
): DirectSixelGraphics | undefined {
  const preference = imageProtocolPreference(environment)
  if (tmuxKittyTransportHasPriority(environment, preference)) return undefined
  const identity = probeTmuxSixelIdentity(environment, preference)
  if (identity === undefined) return undefined

  const admission = new TmuxSixelAdmission(identity, environment, preference)
  let graphics: DirectSixelGraphics | undefined
  const facade = new TmuxSixelTerminal(terminal, admission, (dcs) => graphics?.screen.footprint(dcs) !== undefined)
  graphics = createSixelGraphicsWithAdmission(facade, admission, onReadinessChanged)
  if (graphics === undefined) {
    facade.dispose()
    admission.dispose()
    return undefined
  }
  return {
    mode: 'sixel',
    terminal: facade,
    screen: graphics.screen,
    canPaint: () => graphics!.canPaint(),
    observeScreen: (observer: SixelScreenObservation | undefined, columns: number, rows: number) =>
      graphics!.observeScreen(observer, columns, rows),
    resample: () => graphics!.resample(),
    image: (source, options) => graphics!.image(source, options),
    dispose: () => {
      graphics!.dispose()
      facade.dispose()
    },
  }
}
