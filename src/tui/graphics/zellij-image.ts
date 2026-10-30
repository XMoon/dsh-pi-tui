/**
 * Zellij Native admission and factory (Image-7C-3, generalized by Image-7C).
 *
 * A Zellij pane inherits its parent terminal's environment, so the fork's
 * `TERM_PROGRAM`/`GHOSTTY_RESOURCES_DIR` hints cannot prove that the CURRENT
 * Zellij pane really supports Kitty graphics. This module therefore asks the
 * live Zellij server one bounded Kitty `a=q` query after the physical terminal
 * input listener is installed, and only the matching `OK` reply promotes the
 * SAME Native `KittyGraphicsCore` + `KittyTerminalFacade` used by a Direct
 * capable Kitty protocol terminal.
 *
 * The admission is deliberately small: it owns no image id, placement,
 * payload or terminal frame. It answers two questions only — "is this process
 * a Zellij pane worth querying?" and "did this pane answer the probe?".
 * `mode` stays `native`: Zellij is an admission boundary, not a second
 * graphics transport.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/zellij-image
 */

import { randomInt } from 'node:crypto'
import type { Terminal } from '@xmoon76/pi-tui'
import {
  KittyGraphicsCore,
  type KittyGraphicsCoreOptions,
  type KittyImageSource,
} from './kitty-core.ts'
import { KITTY_APC_INTRODUCER, KITTY_APC_TERMINATOR, parseKittyApc } from './kitty-native.ts'
import { KittyTerminalFacade } from './kitty-terminal.ts'
import {
  NativeKittyImage,
  type KittyGraphics,
  type NativeKittyImageOptions,
} from './native-image.ts'

/** The high-half range reserved for per-admission probe ids (Core ids stay below). */
const ZELLIJ_PROBE_ID_MIN = 0x80000000
const ZELLIJ_PROBE_ID_MAX = 0xffffffff

/** Create a fresh, unpredictable probe id for ONE graphics handle. */
export function createZellijProbeId(): number {
  return randomInt(ZELLIJ_PROBE_ID_MIN, ZELLIJ_PROBE_ID_MAX)
}

/** Encode the ONE live-pane query: `a=q` stores no image and moves no cursor. */
export function zellijProbeWire(probeId: number): string {
  return `\x1b_Ga=q,i=${probeId},s=1,v=1,t=d,f=24;AAAA${KITTY_APC_TERMINATOR}`
}
/** The bounded wait after which an unanswered probe is denied for this lifetime. */
export const ZELLIJ_PROBE_TIMEOUT_MS = 500

/**
 * Whether this process is a Zellij pane worth one live protocol query.
 *
 * The candidate decision is deliberately transport-only: a non-empty `ZELLIJ`
 * session marker, no explicit `TMUX`/`STY` session in between, and no explicit
 * image opt-out (`PI_IMAGE_PROTOCOL=none/0`) or iTerm2 override. Host brand,
 * `TERM_PROGRAM`, `TERM`, session name, inherited WezTerm/Warp markers and the
 * fork's static capability verdict are NOT admission facts: the per-handle
 * live `a=q` answer is the authority for this pane.
 */
export function candidateZellijKitty(environment: NodeJS.ProcessEnv = process.env): boolean {
  const protocol = (environment.PI_IMAGE_PROTOCOL ?? '').toLowerCase()
  if (protocol === 'none' || protocol === '0' || protocol === 'iterm2') return false
  if ((environment.ZELLIJ ?? '') === '') return false
  if ((environment.TMUX ?? '') !== '' || (environment.STY ?? '') !== '') return false
  return true
}

/**
 * The shared Zellij topology gate for every Zellij graphics consumer.
 *
 * This is intentionally a thin alias of {@link candidateZellijKitty}: one set
 * of topology facts, never a second gate that could drift.
 */
export function candidateZellijGraphics(environment: NodeJS.ProcessEnv = process.env): boolean {
  return candidateZellijKitty(environment)
}

type ZellijAdmissionState = 'pending' | 'probing' | 'allowed' | 'denied'

/** The one irreversible outcome of this handle's live-probe lifetime. */
export type ZellijKittySettlement = 'allowed' | 'denied'

/**
 * One TuiApp lifetime's Zellij probe state.
 *
 * `pending -> probing -> allowed | denied`; only a matching live reply may
 * promote once, and `denied` is permanent. The class never sends bytes itself:
 * the facade's `start()` supplies the write callback after the real input
 * listener is installed, so a probe can never be written from a constructor or
 * a render pass.
 *
 * `onSettled` is an OPTIONAL read-only notification for a composite consumer
 * (the Image-8 / I8-5 negotiator): it runs after the state has been committed
 * and receives this handle's one outcome. The original callback and factory API
 * stay unchanged.
 */
export class ZellijKittyAdmission {
  private readonly onAllowed: (() => void) | undefined
  private readonly onSettled: ((outcome: ZellijKittySettlement) => void) | undefined
  private readonly probeIdValue: number
  private state: ZellijAdmissionState = 'pending'
  private timer: NodeJS.Timeout | undefined
  private disposed = false
  /** Whether the facade currently has a real input listener installed. */
  private inputActive = false

  constructor(
    onAllowed?: () => void,
    probeId: number = createZellijProbeId(),
    onSettled?: (outcome: ZellijKittySettlement) => void,
  ) {
    this.onAllowed = onAllowed
    this.onSettled = onSettled
    this.probeIdValue = probeId
  }

  /** The one unpredictable id this handle owns. */
  get probeId(): number {
    return this.probeIdValue
  }

  /** The exact query this handle must send once. */
  get probeWire(): string {
    return zellijProbeWire(this.probeIdValue)
  }

  /** Whether this pane's live query was answered with `OK`. */
  get allowed(): boolean {
    return this.state === 'allowed'
  }

  /** The one committed outcome, or `undefined` while the probe is unresolved. */
  get settledOutcome(): ZellijKittySettlement | undefined {
    if (this.state === 'allowed') return 'allowed'
    if (this.state === 'denied') return 'denied'
    return undefined
  }

  /** Whether the screen currently has the facade's input listener mounted. */
  get inputListening(): boolean {
    return this.inputActive && !this.disposed
  }

  /** Record a real `Terminal.start()` (main/alt hand-off keeps the admission). */
  markInputStarted(): void {
    if (!this.disposed) this.inputActive = true
  }

  /** Record a real `Terminal.stop()`; the one-way admission itself survives. */
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
      if (this.state === 'probing') this.settle('denied')
    }, ZELLIJ_PROBE_TIMEOUT_MS)
    this.timer.unref()
    try {
      sendQuery()
    } catch (error) {
      this.clearTimer()
      this.settle('denied')
      throw error
    }
  }

  /**
   * Consume one complete input sequence when it is THIS probe's reply.
   *
   * `StdinBuffer` has already rebuilt split APC input into complete sequences.
   * A reply for any other id (or any other input) returns `false` and flows to
   * the screen untouched. A late reply for this id after `allowed`/`denied` or
   * after `dispose()` is still consumed so it cannot surface as editor input,
   * but never changes the one-way state.
   */
  consume(data: string): boolean {
    if (!data.startsWith(KITTY_APC_INTRODUCER) || !data.endsWith(KITTY_APC_TERMINATOR)) return false
    const command = parseKittyApc(data)
    if (command === undefined || command.controls.i !== String(this.probeIdValue)) return false
    if (this.state === 'probing' && !this.disposed) {
      this.clearTimer()
      if (command.payload === 'OK') {
        this.settle('allowed')
        this.onAllowed?.()
      } else {
        this.settle('denied')
      }
    }
    return true
  }

  private settle(outcome: ZellijKittySettlement): void {
    this.state = outcome
    this.onSettled?.(outcome)
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

/**
 * The Native facade with ONE extra input/ownership step: consume this probe's
 * reply before the screen sees it, and send the query once the real input
 * listener is installed. Every byte-level lifecycle (transmission, placement,
 * clear/alt, delete, stop) remains `KittyTerminalFacade`'s.
 */
export class ZellijKittyTerminal extends KittyTerminalFacade {
  private readonly zellijAdmission: ZellijKittyAdmission

  constructor(inner: Terminal, core: KittyGraphicsCore, admission: ZellijKittyAdmission) {
    super(inner, core)
    this.zellijAdmission = admission
  }

  override start(onInput: (data: string) => void, onResize: () => void): void {
    this.zellijAdmission.markInputStarted()
    super.start((data) => {
      if (this.zellijAdmission.consume(data)) return
      onInput(data)
    }, onResize)
    this.zellijAdmission.start(() => this.write(this.zellijAdmission.probeWire))
  }

  override stop(): void {
    this.zellijAdmission.markInputStopped()
    super.stop()
  }
}

/**
 * Create the ONE graphics handle for a Zellij pane, or `undefined` when the
 * process is not a candidate (no Core, no facade, no query). The returned
 * handle is Native: the same Core/Facade/component path as a Direct capable
 * Kitty protocol terminal, gated by the one-way live-pane admission.
 */
export function createZellijKittyGraphics(
  terminal: Terminal,
  options: KittyGraphicsCoreOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
  onAllowed: () => void,
): KittyGraphics | undefined {
  if (!candidateZellijKitty(environment)) return undefined
  const core = new KittyGraphicsCore(options)
  let disposed = false
  const admission = new ZellijKittyAdmission(() => {
    queueMicrotask(() => {
      if (!disposed && admission.allowed && admission.inputListening) onAllowed()
    })
  })
  const facade = new ZellijKittyTerminal(terminal, core, admission)
  return {
    mode: 'native',
    canPaint: () => admission.allowed,
    image: (source: KittyImageSource, imageOptions: NativeKittyImageOptions) =>
      new NativeKittyImage(core, source, imageOptions),
    terminal: facade,
    dispose: () => {
      if (disposed) return
      disposed = true
      admission.dispose()
      facade.dispose()
      core.dispose()
    },
  }
}
