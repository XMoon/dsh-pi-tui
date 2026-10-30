/**
 * Image-8 / I8-5 — the ONE Zellij protocol negotiation handle.
 *
 * A Zellij pane inherits its outer terminal's environment, so neither
 * `TERM_PROGRAM` nor the fork's static capability may decide whether the pane
 * can paint pixels. The existing Zellij Kitty admission answers one bounded
 * `a=q`, and `ProcessTerminal` passively exposes the pane's real primary DA1.
 * This module combines BOTH live facts exactly once:
 *
 *   pending -> kitty | sixel | none | revoked
 *
 * Kitty wins whenever its own probe answered `OK` (even if DA1 also declares
 * SIXEL). SIXEL is selected only when Kitty did not admit, the pane's DA1
 * declares attribute `4`, and the LOCAL Zellij program is at least 0.45.0 —
 * older versions unconditionally advertised SIXEL to their panes. Unknown
 * facts are never treated as positive: no answer, an ineligible version, a
 * missing binary or a failed probe all settle to text.
 *
 * The handle owns two existing internals behind ONE stable identity:
 * `KittyGraphicsCore`/`ZellijKittyTerminal` for the Kitty branch and a
 * `DirectSixelGraphics` owner (same encoder/registry/Screen port as Direct
 * SIXEL) for the SIXEL branch. `ZellijNegotiatedImage` creates exactly ONE
 * protocol delegate per source, lazily, and never both.
 *
 * A selected SIXEL surface re-verifies the pane with one bounded `CSI c` on
 * screen handoff/resize/external-editor resume. The reply is consumed by the
 * same facade input path before the editor; the capability boolean remains
 * owned by the existing `onSixelSupport` observation. A negative answer (or a
 * timeout) revokes SIXEL permanently; there is no runtime switch to Kitty.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/zellij-sixel
 */

import { execFileSync } from 'node:child_process'
import type { Component, Terminal } from '@xmoon76/pi-tui'
import type { SixelRaster } from '../../client/media/sixel/types.ts'
import { KittyGraphicsCore, type KittyImageSource } from './kitty-core.ts'
import { NativeKittyImage, type NativeKittyImageOptions, type PixelBody } from './native-image.ts'
import {
  createSixelGraphicsWithAdmission,
  type DirectSixelGraphics,
  type DirectSixelScreenPort,
  type SixelCapability,
  type SixelScreenObservation,
} from './sixel-image.ts'
import { ZellijKittyAdmission, ZellijKittyTerminal, candidateZellijGraphics } from './zellij-image.ts'
import { normalizeZellijSixelRaster } from './zellij-sixel-width.ts'

/** The one bounded DA1 window for the initial negotiation and every re-query. */
export const ZELLIJ_SIXEL_DA1_TIMEOUT_MS = 800

/** The immutable protocol selection of one negotiated Zellij handle. */
export type ZellijNegotiatedProtocol = 'kitty' | 'sixel' | null

/**
 * The public face of the ONE negotiated Zellij handle.
 *
 * `mode` is fixed for the whole lifetime; `selectedProtocol()` is the ONE
 * selection projection and answers `null` for `none`/`revoked`. Consumers ask
 * `effectiveImageProtocol()` rather than either member.
 */
export interface ZellijNegotiatedGraphics {
  readonly mode: 'zellij-negotiated'
  /** The ONE byte writer both screens and every media consumer share. */
  readonly terminal: Terminal
  /** The SIXEL owner's trust port; installed on every screen from construction. */
  readonly sixelScreen: DirectSixelScreenPort
  /** The selected protocol, or `null` while pending and after none/revoked. */
  selectedProtocol(): ZellijNegotiatedProtocol
  /** Whether the selected transport may paint pixels on the current frame. */
  canPaint(): boolean
  /** Bind one display occurrence; the returned body owns its delegate. */
  image(source: KittyImageSource, options: NativeKittyImageOptions): PixelBody
  /** Point the SIXEL projection at the screen that owns the terminal now. */
  observeScreen(observer: SixelScreenObservation | undefined, columns: number, rows: number): void
  /** Re-observe the current screen; on a selected SIXEL this re-verifies the pane. */
  resample(): void
  /** Release both potential owners and the ONE facade. Idempotent. */
  dispose(): void
}

/**
 * The local Zellij program version gate.
 *
 * This is a NEGATIVE gate only: it excludes the versions known to advertise
 * SIXEL unconditionally. It never proves the pane can paint. The parser is
 * strict (`zellij <major>.<minor>.<patch>`) and every failure mode is false.
 */
export function zellijVersionEligible(environment: NodeJS.ProcessEnv = process.env): boolean {
  let output: string
  try {
    output = execFileSync('zellij', ['--version'], {
      encoding: 'utf8',
      env: environment,
      shell: false,
      timeout: 500,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return false
  }
  const match = /^zellij (\d+)\.(\d+)\.(\d+)$/.exec(output.trim())
  if (match === null) return false
  const major = Number.parseInt(match[1]!, 10)
  const minor = Number.parseInt(match[2]!, 10)
  const patch = Number.parseInt(match[3]!, 10)
  if (major !== 0) return major > 0
  if (minor !== 45) return minor > 45
  return patch >= 0
}

type ZellijGraphicsState = 'pending' | 'kitty' | 'sixel' | 'none' | 'revoked'

interface ZellijGraphicsCallbacks {
  /** Kitty was committed; the product repaint seam. */
  readonly onKittySelected: () => void
  /** SIXEL was committed; the coordinator must bind the current screen first. */
  readonly onSixelSelected: () => void
  /** SIXEL was revoked (or the handle disposed) and needs a text repaint. */
  readonly onSixelLost: () => void
}

/**
 * The ONE selection state machine.
 *
 * Timers, input-active state, the initial DA1 fact, the Kitty settlement and
 * the one outstanding re-query lease are all committed here before any
 * callback runs. Late/duplicate answers are consumed but never change a
 * settled state.
 */
export class ZellijGraphicsAdmission {
  readonly kittyAdmission: ZellijKittyAdmission
  readonly capability: SixelCapability
  private readonly environment: NodeJS.ProcessEnv
  private readonly callbacks: ZellijGraphicsCallbacks
  private state: ZellijGraphicsState = 'pending'
  private kittyOutcome: 'allowed' | 'denied' | undefined
  private da1Supported: boolean | undefined
  private versionEligible: boolean | undefined
  private started = false
  private disposed = false
  private inputActive = false
  private initialDeadline: NodeJS.Timeout | undefined
  private recheck:
    | { deadline: NodeJS.Timeout; settled: boolean; supported: boolean | undefined }
    | undefined
  private readonly verdictListeners = new Set<() => void>()

  constructor(environment: NodeJS.ProcessEnv = process.env, callbacks: ZellijGraphicsCallbacks) {
    this.environment = environment
    this.callbacks = callbacks
    this.kittyAdmission = new ZellijKittyAdmission(undefined, undefined, (outcome) => {
      if (this.disposed) return
      this.kittyOutcome = outcome
      this.tryFinalize()
    })
    const state = this
    this.capability = {
      get verdict(): SixelCapability['verdict'] {
        return state.sixelVerdict
      },
      observe(listener: () => void): () => void {
        if (state.disposed) return () => {}
        state.verdictListeners.add(listener)
        return () => {
          state.verdictListeners.delete(listener)
        }
      },
      dispose(): void {},
    }
  }

  /** The public selection projection. */
  get protocol(): ZellijNegotiatedProtocol {
    if (this.disposed) return null
    if (this.state === 'kitty') return 'kitty'
    if (this.state === 'sixel') return 'sixel'
    return null
  }

  /** The SIXEL-only projection consumed by the owner. */
  private get sixelVerdict(): SixelCapability['verdict'] {
    if (this.disposed) return 'denied'
    if (this.state === 'sixel') return this.recheck === undefined ? 'admitted' : 'pending'
    if (this.state === 'pending' || this.state === 'kitty') return 'pending'
    return 'denied'
  }

  get inputListening(): boolean {
    return this.inputActive && !this.disposed
  }

  /** One real terminal input listener is installed. */
  markInputStarted(): void {
    if (!this.disposed) this.inputActive = true
  }

  /** The active screen stopped; the admission itself survives a handoff. */
  markInputStopped(): void {
    this.inputActive = false
  }

  /**
   * Candidate start. Reads the local Zellij version ONCE, installs the single
   * 800 ms initial DA1 bound, and attempts a settlement from any fact already
   * known (a synchronous probe reply or a replayed DA1).
   */
  begin(): void {
    if (this.started || this.disposed) return
    this.started = true
    // The 800 ms bound covers the WHOLE initial negotiation, including the
    // blocking local version read below.
    this.initialDeadline = setTimeout(() => {
      this.initialDeadline = undefined
      this.tryFinalize(true)
    }, ZELLIJ_SIXEL_DA1_TIMEOUT_MS)
    this.initialDeadline.unref()
    this.versionEligible = zellijVersionEligible(this.environment)
    this.tryFinalize()
  }

  /** One complete primary DA1 answer from the existing passive observation. */
  observeDa1(supported: boolean): void {
    if (this.disposed) return
    if (this.state === 'pending') {
      this.da1Supported = supported
      this.tryFinalize()
      return
    }
    if (this.state === 'sixel') {
      const lease = this.recheck
      if (lease !== undefined) {
        if (lease.settled) return
        // The authority value changed, so the callback names this reply.
        lease.settled = true
        lease.supported = supported
        clearTimeout(lease.deadline)
        queueMicrotask(() => this.finishRecheckLease(lease))
        return
      }
      if (!supported) this.revoke()
    }
    // A late answer after kitty/none/revoked is consumed but inert.
  }

  /**
   * Ask for one re-query lease before the caller writes `CSI c`. Commits the
   * `pending` projection first so no old pixel frame can paint in between.
   */
  beginRecheck(): boolean {
    if (this.disposed || this.state !== 'sixel' || this.recheck !== undefined || !this.inputActive) return false
    const lease = {
      deadline: setTimeout(() => this.revoke(), ZELLIJ_SIXEL_DA1_TIMEOUT_MS),
      settled: false,
      supported: undefined as boolean | undefined,
    }
    lease.deadline.unref()
    this.recheck = lease
    this.notifyVerdict()
    return true
  }

  /** A re-query write failed; the surface must fall to text. */
  failRecheck(): void {
    this.revoke()
  }

  /**
   * Consume exactly the complete primary DA1 reply owned by the outstanding
   * re-query lease, before it can reach the editor. An answer whose value did
   * not change never calls `onSixelSupport` (the fork dedupes), so the
   * already-authoritative value remains the fact for that reply.
   */
  consumeRequeryReply(data: string): boolean {
    const lease = this.recheck
    if (lease === undefined || !/^\x1b\[\?[\d;]*c$/.test(data)) return false
    this.recheck = undefined
    clearTimeout(lease.deadline)
    const supported = lease.settled ? lease.supported === true : this.da1Supported === true
    if (supported) this.notifyVerdict()
    else this.revoke()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.inputActive = false
    this.clearInitialDeadline()
    if (this.recheck !== undefined) {
      clearTimeout(this.recheck.deadline)
      this.recheck = undefined
    }
    this.kittyAdmission.dispose()
    this.verdictListeners.clear()
  }

  private tryFinalize(timedOut = false): void {
    if (this.disposed || this.state !== 'pending') return
    if (this.kittyOutcome === 'allowed') {
      this.selectKitty()
      return
    }
    if (this.kittyOutcome === 'denied') {
      if (this.sixelEligible()) {
        this.selectSixel()
        return
      }
      if (this.da1Supported === undefined && !timedOut) return
      // A synchronous probe answer can arrive during `super.start()` before
      // `begin()` has read the local version. Do not lock text on a fact that
      // is still unknown; `begin()` will finalize immediately afterwards.
      if (this.versionEligible === undefined && !timedOut) return
      this.selectNone()
      return
    }
    if (!timedOut) return
    // The Kitty probe timer is 500 ms, so reaching this 800 ms bound with no
    // Kitty outcome means the probe could not settle either; a SIXEL-proven
    // pane may still be used, otherwise text.
    if (this.sixelEligible()) this.selectSixel()
    else this.selectNone()
  }

  private sixelEligible(): boolean {
    if ((this.environment.PI_IMAGE_PROTOCOL ?? '').toLowerCase() === 'kitty') return false
    return this.da1Supported === true && this.versionEligible === true
  }

  private selectKitty(): void {
    this.state = 'kitty'
    this.clearInitialDeadline()
    this.notifyVerdict()
    this.callbacks.onKittySelected()
  }

  private selectSixel(): void {
    this.state = 'sixel'
    this.clearInitialDeadline()
    this.notifyVerdict()
    this.callbacks.onSixelSelected()
  }

  private selectNone(): void {
    this.state = 'none'
    this.clearInitialDeadline()
    this.notifyVerdict()
  }

  private revoke(): void {
    if (this.disposed || this.state === 'revoked' || this.state === 'none') return
    this.state = 'revoked'
    this.clearInitialDeadline()
    if (this.recheck !== undefined) {
      clearTimeout(this.recheck.deadline)
      this.recheck = undefined
    }
    this.notifyVerdict()
    this.callbacks.onSixelLost()
  }

  private finishRecheckLease(lease: { deadline: NodeJS.Timeout; settled: boolean; supported: boolean | undefined }): void {
    if (this.recheck !== lease) return
    this.recheck = undefined
    clearTimeout(lease.deadline)
    if (lease.supported === true) this.notifyVerdict()
    else this.revoke()
  }

  private notifyVerdict(): void {
    for (const listener of [...this.verdictListeners]) listener()
  }

  private clearInitialDeadline(): void {
    if (this.initialDeadline === undefined) return
    clearTimeout(this.initialDeadline)
    this.initialDeadline = undefined
  }
}

/**
 * The terminal facade: the existing `ZellijKittyTerminal` plus the one re-query
 * reply consumer. It never writes bytes itself beyond asking the inherited
 * facade to write the bounded `CSI c`.
 */
class ZellijNegotiatedTerminal extends ZellijKittyTerminal {
  private readonly graphicsAdmission: ZellijGraphicsAdmission

  constructor(
    inner: Terminal,
    core: KittyGraphicsCore,
    kittyAdmission: ZellijKittyAdmission,
    graphicsAdmission: ZellijGraphicsAdmission,
  ) {
    super(inner, core, kittyAdmission)
    this.graphicsAdmission = graphicsAdmission
  }

  override start(onInput: (data: string) => void, onResize: () => void): void {
    const wasActive = this.graphicsAdmission.inputListening
    const wasSixel = this.graphicsAdmission.protocol === 'sixel'
    this.graphicsAdmission.markInputStarted()
    super.start((data) => {
      if (this.graphicsAdmission.consumeRequeryReply(data)) return
      onInput(data)
    }, onResize)
    this.graphicsAdmission.begin()
    // A real Screen stop -> start is another ownership change: if SIXEL was
    // ALREADY selected before this start, re-verify the pane once before the
    // restarted surface paints. The initial start does nothing.
    if (!wasActive && wasSixel) this.requestRequery()
  }

  override stop(): void {
    this.graphicsAdmission.markInputStopped()
    super.stop()
  }

  /** Send the one bounded re-query; the caller committed the lease first. */
  requestRequery(): void {
    if (!this.graphicsAdmission.beginRecheck()) return
    try {
      this.write('\x1b[c')
    } catch (error) {
      this.graphicsAdmission.failRecheck()
      throw error
    }
  }
}

/**
 * One per-source negotiated image. Before the selection settles it renders the
 * caller's fallback text. After it settles it creates EXACTLY ONE lazy
 * protocol delegate; the selection never changes again, so the two pixel
 * implementations can never coexist for one occurrence.
 */
class ZellijNegotiatedImage implements Component {
  private readonly coordinator: ZellijNegotiatedGraphicsImpl
  private readonly source: KittyImageSource
  private readonly options: NativeKittyImageOptions
  private delegate: PixelBody | undefined
  private delegateProtocol: 'kitty' | 'sixel' | undefined

  constructor(
    coordinator: ZellijNegotiatedGraphicsImpl,
    source: KittyImageSource,
    options: NativeKittyImageOptions,
  ) {
    this.coordinator = coordinator
    this.source = source
    this.options = options
  }

  render(width: number): string[] {
    const protocol = this.coordinator.selectedProtocol()
    if (protocol === null) {
      this.releaseDelegate()
      return [this.options.fallback]
    }
    if (this.delegate === undefined || this.delegateProtocol !== protocol) {
      // The selection is irreversible, so this branch can only be entered once
      // per protocol; the guard exists for a disposed-then-rebuilt component.
      this.releaseDelegate()
      this.delegate = protocol === 'kitty'
        ? this.coordinator.createKittyImage(this.source, this.options)
        : this.coordinator.createSixelImage(this.source, this.options)
      this.delegateProtocol = protocol
    }
    return this.delegate.render(width)
  }

  paintedBodyAt(width: number): ReturnType<NonNullable<PixelBody['paintedBodyAt']>> {
    return this.delegate?.paintedBodyAt?.(width)
  }

  invalidate(): void {
    this.delegate?.invalidate()
  }

  dispose(): void {
    this.releaseDelegate()
  }

  private releaseDelegate(): void {
    this.delegate?.dispose?.()
    this.delegate = undefined
    this.delegateProtocol = undefined
  }
}

/** The concrete coordinator; the public face is {@link ZellijNegotiatedGraphics}. */
class ZellijNegotiatedGraphicsImpl implements ZellijNegotiatedGraphics {
  readonly mode = 'zellij-negotiated' as const
  readonly terminal: ZellijNegotiatedTerminal
  readonly sixelScreen: DirectSixelScreenPort
  private readonly core: KittyGraphicsCore
  private readonly admission: ZellijGraphicsAdmission
  private readonly sixelOwner: DirectSixelGraphics
  private readonly onSixelSettled: () => void
  private lastObserver: SixelScreenObservation | undefined
  private lastColumns = 0
  private lastRows = 0
  /** Whether a SIXEL-bound surface has ever been observed on this handle. */
  private sixelSurfaceBound = false
  private unsubscribeDa1: (() => void) | undefined
  private disposed = false

  constructor(
    terminal: Terminal,
    environment: NodeJS.ProcessEnv,
    onKittySelected: () => void,
    onSixelSettled: () => void,
  ) {
    this.core = new KittyGraphicsCore()
    this.onSixelSettled = onSixelSettled
    const coordinator = this
    this.admission = new ZellijGraphicsAdmission(environment, {
      onKittySelected: () => {
        queueMicrotask(() => {
          if (!coordinator.disposed && coordinator.admission.protocol === 'kitty' && coordinator.admission.inputListening) {
            onKittySelected()
          }
        })
      },
      onSixelSelected: () => {
        // Bind the screen TuiApp already reported while the negotiation was
        // pending, then ask the owner to sample its three facts. This initial
        // bind is NOT a re-query: the DA1 answer that selected SIXEL is current.
        if (coordinator.lastObserver !== undefined) coordinator.sixelSurfaceBound = true
        coordinator.sixelOwner.observeScreen(coordinator.lastObserver, coordinator.lastColumns, coordinator.lastRows)
        queueMicrotask(() => {
          if (!coordinator.disposed && coordinator.admission.protocol === 'sixel' && coordinator.admission.inputListening) {
            coordinator.onSixelSettled()
          }
        })
      },
      onSixelLost: () => {
        queueMicrotask(() => {
          if (!coordinator.disposed) coordinator.onSixelSettled()
        })
      },
    })
    this.terminal = new ZellijNegotiatedTerminal(
      terminal,
      this.core,
      this.admission.kittyAdmission,
      this.admission,
    )
    const owner = createSixelGraphicsWithAdmission(
      this.terminal,
      this.admission.capability,
      onSixelSettled,
      normalizeZellijSixelRaster,
    )
    if (owner === undefined) throw new Error('Zellij negotiated SIXEL owner was statically denied')
    this.sixelOwner = owner
    this.sixelScreen = owner.screen
    this.unsubscribeDa1 = this.terminal.onSixelSupport?.((supported) => this.admission.observeDa1(supported))
  }

  selectedProtocol(): ZellijNegotiatedProtocol {
    if (this.disposed) return null
    return this.admission.protocol
  }

  canPaint(): boolean {
    if (this.disposed) return false
    if (this.admission.protocol === 'kitty') return this.admission.kittyAdmission.allowed
    if (this.admission.protocol === 'sixel') return this.sixelOwner.canPaint()
    return false
  }

  image(source: KittyImageSource, options: NativeKittyImageOptions): PixelBody {
    return new ZellijNegotiatedImage(this, source, options)
  }

  createKittyImage(source: KittyImageSource, options: NativeKittyImageOptions): PixelBody {
    return new NativeKittyImage(this.core, source, options)
  }

  createSixelImage(source: KittyImageSource, options: NativeKittyImageOptions): PixelBody {
    return this.sixelOwner.image(source, options)
  }

  observeScreen(observer: SixelScreenObservation | undefined, columns: number, rows: number): void {
    if (this.disposed) return
    const changed = observer !== this.lastObserver || columns !== this.lastColumns || rows !== this.lastRows
    this.lastObserver = observer
    this.lastColumns = columns
    this.lastRows = rows
    if (this.admission.protocol !== 'sixel') return
    // The first bind after selection is the DA1-certified surface; only a LATER
    // handoff/resize re-verifies the pane.
    if (this.sixelSurfaceBound && changed && observer !== undefined && this.admission.inputListening) this.requestRecheck()
    if (observer !== undefined) this.sixelSurfaceBound = true
    this.sixelOwner.observeScreen(observer, columns, rows)
  }

  resample(): void {
    if (this.disposed || this.admission.protocol !== 'sixel') return
    if (this.admission.inputListening) this.requestRecheck()
    else this.sixelOwner.resample()
  }

  private requestRecheck(): void {
    this.terminal.requestRequery()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeDa1?.()
    this.unsubscribeDa1 = undefined
    this.admission.dispose()
    this.sixelOwner.dispose()
    this.terminal.dispose()
    this.core.dispose()
  }
}

/**
 * Create the ONE negotiated Zellij graphics handle, or `undefined` for every
 * topology the existing candidate gate excludes. The returned handle is
 * committed before any product callback can observe it.
 */
export function createZellijNegotiatedGraphics(
  terminal: Terminal,
  environment: NodeJS.ProcessEnv = process.env,
  onKittySelected: () => void,
  onSixelSettled: () => void,
): ZellijNegotiatedGraphics | undefined {
  if (!candidateZellijGraphics(environment)) return undefined
  return new ZellijNegotiatedGraphicsImpl(terminal, environment, onKittySelected, onSixelSettled)
}
