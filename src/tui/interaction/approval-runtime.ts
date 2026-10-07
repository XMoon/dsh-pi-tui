/**
 * The TUI-local approval interaction lifecycle (TS5 plan §8.3): the FIFO
 * prompt queue, the ONE prompt on screen, its abort binding, the responsive
 * overlay mount/rebind, the fixed y/n/Esc/Ctrl+C ownership, the exactly-once
 * settlement, the next-item scheduling and the teardown cancellation.
 *
 * It owns no Host business semantics: the approval request production, the
 * `InteractionPort` and the application currentness stay above it. The dialog
 * body itself is the TS4 `tui/panels/approval-dialog.ts` presentation, which
 * this runtime mounts and rebinds.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/approval-runtime
 */

import { matchesKey, type OverlayHandle, type TuiInputListenerResult } from '@xmoon76/pi-tui'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import { ResponsiveOverlayFrame } from '../components/frame.ts'
import {
  ApprovalDialogSurface,
  approvalOverlayGeometry,
  buildApprovalDialog,
  type ApprovalOutcome,
  type ApprovalPromptRequest,
} from '../panels/approval-dialog.ts'

/**
 * The terminal/seat capabilities the approval runtime consumes. Every member
 * is an existing TuiApp coordination primitive — the runtime owns the approval
 * state machine, never a second copy of the overlay/editor/focus facts.
 */
export interface ApprovalRuntimeHost {
  /** The surface is finally disposed: a new prompt settles cancelled at once. */
  isDisposed(): boolean
  /** Contain one terminal callback's settlement failure (the owned sink). */
  routeSettlementFailure(label: string, error: unknown): void
  /** A Host approval outranks the Client-local Save Location prompt. */
  cancelActiveSaveLocation(): void
  clearFullscreenPointerGestures(): void
  /** A capturing modal owns the keyboard now: cancel any pending leader. */
  cancelLeader(): void
  /** Re-derive the activity projection (the approval is a live modal). */
  projectActivity(): void
  /** The live terminal dimensions the approval geometry derives from. */
  terminalSize(): { readonly columns: number; readonly rows: number }
  /** Mount the responsive frame as a remountable managed overlay. */
  showApprovalOverlay(frame: ResponsiveOverlayFrame): OverlayHandle
  /** Register the fullscreen-rebind callback for one logical node. */
  setOverlayRemount(handle: OverlayHandle, remount: () => void): void
  /** Drop one logical node's rebind callback when it closes. */
  clearOverlayRemount(handle: OverlayHandle): void
  /** Project a fresh physical frame for an existing logical node. */
  rebindApprovalOverlay(handle: OverlayHandle, frame: ResponsiveOverlayFrame): void
  /** Restore the editor seat as the input fallback beneath the approval. */
  focusEditorSeat(): void
}

/** Live state of one approval prompt. */
export interface PendingApproval {
  request: ApprovalPromptRequest
  resolve: (outcome: ApprovalOutcome) => void
  onAbort?: () => void
  /** Whether the main Agent is BLOCKED on this approval (never a local dialog). */
  agentInputWait: boolean
  /** The live overlay handle behind the current approval dialog. */
  handle?: OverlayHandle
  /** The live geometry wrapper behind the current approval handle. */
  responsiveFrame?: ResponsiveOverlayFrame
  /** Latched by settle: every prompt promise settles exactly once. */
  settled?: boolean
}

/**
 * The approval interaction owner. Requests queue FIFO; only one dialog is on
 * screen at a time; an aborted signal settles the prompt `cancelled`.
 */
export class ApprovalRuntime {
  private readonly queue: PendingApproval[] = []
  private active: PendingApproval | undefined
  /** Live approval frames: a fullscreen rebind REPLACES the frame for the SAME
   * logical node (the overlay opts out of disposeOnHide). */
  private readonly frames = new Set<ResponsiveOverlayFrame>()

  private readonly host: ApprovalRuntimeHost

  constructor(host: ApprovalRuntimeHost) {
    this.host = host
  }

  /** Whether an approval dialog currently owns the input stage. */
  isActive(): boolean {
    return this.active !== undefined
  }

  /** Whether the approval that owns the input stage is one the main Agent is
   * blocked on: only then may it be projected as the pane's `waiting_input`. */
  activeAgentInputWait(): boolean {
    return this.active?.agentInputWait === true
  }

  /** Sync the on-screen approval against a live terminal resize. */
  syncGeometry(): void {
    this.active?.responsiveFrame?.syncGeometry()
  }

  /** Headless-test hook: the number of live approval frames (a fullscreen
   * swap must replace, not accumulate, them). */
  ownedFramesForTest(): number {
    return this.frames.size
  }

  /** Approval's fixed response keys must beat a conflicting inspection remap. */
  ownsFixedKey(data: string): boolean {
    return matchesKey(data, 'y')
      || matchesKey(data, 'n')
      || matchesKey(data, 'escape')
      || matchesKey(data, 'ctrl+c')
  }

  /** Route a key while a prompt is showing; every key except the explicit
   * inspection-safe whitelist is consumed. */
  handleKey(data: string): TuiInputListenerResult {
    const pending = this.active
    if (pending === undefined) return undefined
    if (matchesKey(data, 'y')) this.settle(pending, 'allowed-once')
    else if (matchesKey(data, 'n')) this.settle(pending, 'rejected')
    else if (matchesKey(data, 'escape')) this.settle(pending, 'cancelled')
    else if (matchesKey(data, 'ctrl+c')) this.settle(pending, 'cancelled')
    return { consume: true }
  }

  /**
   * Queue an approval prompt and resolve when the user decides.
   * @param request - the tool, reason, and optional abort signal.
   * @param agentInputWait - whether the main Agent is blocked on this approval;
   *   only such a prompt may become the pane's `waiting_input`.
   * @returns the user's decision.
   */
  showPrompt(
    request: ApprovalPromptRequest,
    agentInputWait = false,
  ): Promise<ApprovalOutcome> {
    // A disposed surface must never leave the caller hanging: settle
    // cancelled immediately (M0 stale-generation contract — the runner's
    // approval handler may fire during exit teardown).
    if (this.host.isDisposed()) return Promise.resolve('cancelled')
    return new Promise<ApprovalOutcome>((resolve) => {
      const pending: PendingApproval = { request, resolve, agentInputWait }
      if (request.signal !== undefined) {
        const onAbort = (): void => {
          try {
            this.settle(pending, 'cancelled')
          } catch (error) {
            this.host.routeSettlementFailure('approval abort settlement', error)
          }
        }
        pending.onAbort = onAbort
        request.signal.addEventListener('abort', onAbort, { once: true })
        if (request.signal.aborted) {
          this.settle(pending, 'cancelled')
          return
        }
      }
      this.queue.push(pending)
      this.showNext()
    })
  }

  /**
   * Snapshot and clear every pending approval for final disposal: each entry
   * is an INDEPENDENT settlement step, so one rejected prompt cannot strand
   * its siblings' promises. The active prompt's cancellation follows as its
   * own step.
   */
  teardownSettlementSteps(): Array<() => void> {
    const pending = [...this.queue]
    this.queue.length = 0
    const steps = pending.map(entry => () => this.settle(entry, 'cancelled'))
    if (this.active !== undefined) steps.push(() => this.settleActive('cancelled'))
    return steps
  }

  /** Cancel the on-screen prompt, if any (the final disposal path). */
  private settleActive(outcome: ApprovalOutcome): void {
    const active = this.active
    if (active !== undefined) this.settle(active, outcome)
  }

  /** Render the next queued prompt, if any and none is showing. */
  private showNext(): void {
    if (this.active !== undefined || this.queue.length === 0) return
    const pending = this.queue.shift()
    if (pending === undefined) return
    // A signal that aborted while the prompt was queued (e.g. a turn cancel
    // aborts every in-flight request) must never reach the screen: settle it
    // cancelled right away instead of popping a stale dialog.
    if (pending.request.signal?.aborted === true) {
      this.settle(pending, 'cancelled')
      return
    }
    // A Host approval is authoritative over a Client-local Save Location
    // prompt: showing the approval settles the prompt as cancelled (the
    // caller's owned workflow classifies it and notifies nothing) — the
    // approval must never be left unanswerable behind the prompt's input
    // routing (the same rule as presenting a question).
    this.host.cancelActiveSaveLocation()
    this.host.clearFullscreenPointerGestures()
    this.mount(pending)
    this.active = pending
    // M6: a capturing surface owns the input now — any pending leader
    // sequence is cancelled (focus-transition cancellation).
    this.host.cancelLeader()
    this.host.projectActivity()
  }

  /** Build and mount the approval dialog for one prompt on the active screen. */
  private mount(pending: PendingApproval): void {
    const frame = this.createFrame(pending)
    pending.responsiveFrame = frame
    // The approval is REMOUNTABLE like every other managed overlay: a
    // fullscreen swap rebinds the SAME logical node (with a fresh surface), so
    // the overlays it suppresses stay suppressed and never get revealed/
    // focused/re-hidden (no fabricated focus transition).
    const handle = this.host.showApprovalOverlay(frame)
    pending.handle = handle
    this.host.setOverlayRemount(handle, () => {
      if (this.active !== pending) return
      const previous = pending.responsiveFrame
      const next = this.createFrame(pending)
      pending.responsiveFrame = next
      this.host.rebindApprovalOverlay(handle, next)
      // The old frame's raw projection was detached with the old screen and
      // the overlay opted out of disposeOnHide: dispose it explicitly so a
      // repeated swap never leaks approval frames/surfaces.
      previous?.dispose()
    })
  }

  /** Build the responsive approval frame (surface + geometry) without mounting
   * it, so a fullscreen rebind can re-create it for the same logical node. */
  private createFrame(pending: PendingApproval): ResponsiveOverlayFrame {
    const geometryOf = (): ReturnType<typeof approvalOverlayGeometry> => {
      const { columns, rows } = this.host.terminalSize()
      return approvalOverlayGeometry(columns, rows)
    }
    const surface = new ApprovalDialogSurface(
      pending.request,
      geometryOf,
      (request, geometry) => buildApprovalDialog(request, geometry),
    )
    const frame: ResponsiveOverlayFrame = new ResponsiveOverlayFrame(surface, () => {
      const geometry = geometryOf()
      const { columns, rows } = this.host.terminalSize()
      return {
        width: geometry.width,
        maxHeight: geometry.maxHeight,
        // Raw terminal dims keep the key resize-sensitive once the approval
        // geometry caps are reached (last-painted-geometry mouse fence).
        key: `${columns}:${rows}:${geometry.width}:${geometry.maxHeight}:${geometry.contentWidth}`,
      }
    }, undefined, () => this.frames.delete(frame))
    this.frames.add(frame)
    return frame
  }

  /**
   * Resolve one prompt and hide its dialog. The prompt may be on screen
   * (active), queued behind another, or never queued at all (its signal was
   * already aborted on arrival) — every state must settle the promise
   * exactly once and never leave a cancelled prompt in the queue.
   */
  private settle(pending: PendingApproval, outcome: ApprovalOutcome): void {
    if (pending.settled === true) return
    pending.settled = true
    // M3-6 PR3: the presentation cleanup is NON-TRUNCATING and the caller's
    // promise settlement is an OBLIGATION that no cleanup throw may skip. The
    // committed `settled` latch makes this the only settlement attempt.
    const steps: Array<() => void> = this.active === pending
      ? [
        () => this.host.cancelLeader(),
        () => this.host.clearFullscreenPointerGestures(),
        () => { this.active = undefined },
        // Fallback: if nothing is restored beneath the approval, input returns
        // to the editor.
        () => this.host.focusEditorSeat(),
        // Closing the approval restores every overlay it hid (Quick, Settings,
        // any capturing overlay). pi-tui focuses a restored capturing overlay
        // on setHidden(false), overriding the editor fallback above, and the
        // broker's tracked close re-derives the final seat from that live
        // surface (the shared close contract — no approval-specific publish).
        () => { if (pending.handle !== undefined) this.host.clearOverlayRemount(pending.handle) },
        () => pending.handle?.hide(),
        // A remountable overlay opts out of disposeOnHide: the final close owns
        // the frame/surface lifecycle explicitly.
        () => pending.responsiveFrame?.dispose(),
        () => { pending.responsiveFrame = undefined },
        () => this.host.projectActivity(),
      ]
      : [
        () => {
          const queued = this.queue.indexOf(pending)
          if (queued !== -1) this.queue.splice(queued, 1)
        },
      ]
    steps.push(() => {
      if (pending.onAbort !== undefined && pending.request.signal !== undefined) {
        pending.request.signal.removeEventListener('abort', pending.onAbort)
      }
    })
    // The interaction settlement is an OBLIGATION step of the SAME
    // non-truncating batch: no cleanup failure may skip it, and every collected
    // failure — including a legitimately thrown `undefined` (rethrown by
    // identity) and a `showNext` failure — surfaces in execution order.
    runSyncDisposalSteps('approval settlement', [
      ...steps,
      () => pending.resolve(outcome),
      () => { if (this.active === undefined) this.showNext() },
    ])
  }
}
