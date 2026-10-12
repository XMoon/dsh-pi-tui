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
import { runSyncDisposalSteps, runSyncDisposalStepsWithPrimary } from '../../runtime/process/disposal.ts'
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
  /** Mount the responsive frame as a remountable managed overlay. The `remount`
   *  callback is built from the stable logical handle and registered BEFORE the
   *  physical mount (see `TuiApp.showOverlayOnHost`), so a fullscreen swap started
   *  by a callback inside that mount already re-creates this node's projection. */
  showApprovalOverlay(
    frame: ResponsiveOverlayFrame,
    remount: (handle: OverlayHandle) => void,
  ): OverlayHandle
  /** Drop one logical node's rebind callback when it closes. */
  clearOverlayRemount(handle: OverlayHandle): void
  /** Project a fresh physical frame for an existing logical node. */
  rebindApprovalOverlay(handle: OverlayHandle, frame: ResponsiveOverlayFrame): void
  /** Restore the editor seat as the input fallback beneath the approval. */
  focusEditorSeat(): void
  /**
   * Phase 3A / PR-B: the optional editor-seat tenant must be PARKED before the
   * mount can run a synchronous focus/blur callback. Called AFTER the pending
   * prompt was committed as the active owner.
   */
  beforeApprovalMount(): void
  /**
   * Phase 3A / PR-B: the approval queue fully drained (no active prompt and no
   * queued prompt) — the ONLY point where a parked optional tenant may be
   * restored. A queued A → B approval must never restore it in between.
   */
  afterApprovalQueueDrained(): void
  /**
   * Phase 3A / PR-B: abandon a FAILED `beforeApprovalMount` park — re-project
   * the live seat owner (a retired tenant never stays painted/focused) and
   * repaint. The approval presentation never happened.
   */
  rollbackApprovalPark(): void
}

/** Live state of one approval prompt. */
export interface PendingApproval {
  request: ApprovalPromptRequest
  resolve: (outcome: ApprovalOutcome) => void
  /**
   * The promise's own rejection path. A prompt whose presentation FAILS must
   * settle its caller too: a prompt mounted from ANOTHER prompt's settle tail
   * (`showNext()` inside `settle`) has already returned from its executor, so
   * nothing else would ever settle it. The rejected value is exactly the value
   * the failure path throws (the primary failure, aggregated by identity with
   * the rollback failures).
   */
  reject: (error: unknown) => void
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

  /** Whether an approval owns OR is WAITING FOR the input stage: an active
   * prompt or a queued one. The optional seat tenant must neither open nor be
   * restored while ANY approval is pending — between a settle clearing `active`
   * and the next `showNext()`, a synchronous callback (for example a restored
   * overlay's `onFocus`) must still observe the handover as pending (Phase 3A /
   * PR-B). */
  hasPending(): boolean {
    return this.active !== undefined || this.queue.length > 0
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
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const pending: PendingApproval = { request, resolve, reject, agentInputWait }
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
    // Phase 3A / PR-B: the LOGICAL input ownership is committed BEFORE any
    // call below that can synchronously run a plugin/focus callback (the
    // optional-tenant park, the Save Location cancellation, the overlay
    // mount). A callback fired by any of them must already observe THIS
    // approval as the active owner, so the optional tenant can never be
    // restored (or a Save Location settle can never take its
    // "no approval active" restore path) behind an uncommitted approve.
    this.active = pending
    try {
      this.host.beforeApprovalMount()
    } catch (error) {
      // Phase 3A / PR-B: the park's stale-tenant retirement ran a throwing
      // caller cleanup. The approval must never stay half-committed.
      this.rollbackFailedPresentation('approval park rollback', pending, error)
    }
    // The park hook can also run a caller cleanup that settles THIS prompt
    // WITHOUT throwing (it aborts the approval and opens a newer owner). The
    // logical precommit above must not survive as side effects of a settled
    // prompt: its own release already cleared the active slot, so this tail must
    // not cancel the Save Location prompt that cleanup just opened, nor mount
    // this frame.
    if (!this.ownsStage(pending)) return
    // A Host approval is authoritative over a Client-local Save Location
    // prompt: showing the approval settles the prompt as cancelled (the
    // caller's owned workflow classifies it and notifies nothing) — the
    // approval must never be left unanswerable behind the prompt's input
    // routing (the same rule as presenting a question).
    this.host.cancelActiveSaveLocation()
    this.host.clearFullscreenPointerGestures()
    // The prompt's disposal aborts its completion port, whose subscribers can
    // synchronously settle or replace THIS approval: a replaced prompt must not
    // mount its frame over the newer owner (the post-mount fence below cannot
    // undo an overlay that is already physically up).
    if (!this.ownsStage(pending)) return
    try {
      this.mount(pending)
    } catch (error) {
      // Phase 3A / PR-B MOUNT FAILURE: the physical mount runs a synchronous
      // focus transition (a plugin onBlur/onFocus), which may throw. The prompt
      // is already committed as active, so this failure releases exactly its own
      // bindings and resources (see `rollbackFailedPresentation`); `mount()` has
      // already disposed the frame it created and the host has unwound the
      // partially committed overlay node.
      this.rollbackFailedPresentation('approval mount rollback', pending, error)
    }
    // M6: a capturing surface owns the input now — any pending leader
    // sequence is cancelled (focus-transition cancellation).
    this.host.cancelLeader()
    this.host.projectActivity()
  }

  /**
   * Whether THIS prompt still owns the input stage: it is the active one, not
   * settled, and the surface is alive. Re-read after EVERY mount-phase hook that
   * can synchronously run a plugin/focus callback (the park, the Save
   * cancellation, the physical mount) — a settled or replaced prompt must not
   * keep acting on the stage its newer owner took.
   */
  private ownsStage(pending: PendingApproval): boolean {
    return this.active === pending && pending.settled !== true && !this.host.isDisposed()
  }

  /**
   * Phase 3A / PR-B: release THIS prompt after a failed presentation (a throwing
   * park hook or a throwing physical mount). The rollback is IDENTITY FENCED and
   * its obligations are INDEPENDENT: the prompt is latched settled and its abort
   * listener removed (it leaves every owner slot here, so nothing else would ever
   * unbind the caller's signal), the active slot is cleared only while THIS prompt
   * still owns it (a cleanup that synchronously settled this prompt and opened a
   * NEWER approval keeps its ownership, or 'y'/'n' could no longer settle the
   * newer prompt), the host completes the abandoned presentation's
   * seat/publish/render obligations, a legally queued successor is still presented
   * through the existing queue authority, the LAST-blocker notification runs once
   * no approval is active and the queue drained, and the ORIGINAL failure
   * propagates (aggregated by identity with a rollback failure).
   */
  private rollbackFailedPresentation(
    label: string,
    pending: PendingApproval,
    primary: unknown,
  ): never {
    pending.settled = true
    if (pending.onAbort !== undefined && pending.request.signal !== undefined) {
      pending.request.signal.removeEventListener('abort', pending.onAbort)
    }
    const owned = this.active === pending
    if (owned) this.active = undefined
    try {
      runSyncDisposalStepsWithPrimary(label, primary, [
        () => this.host.rollbackApprovalPark(),
        () => { if (owned) this.showNext() },
        // The failed presentation left the stage, so the normal settle tail's
        // LAST-blocker obligation applies here too: a PARKED but still-current
        // optional tenant must come back once no approval is active and the queue
        // drained (a mount failure with a healthy tenant would otherwise strand it
        // parked forever). A successor `showNext()` just presented keeps it parked —
        // the predicate is the same live one `settle` uses.
        () => {
          if (this.active === undefined && this.queue.length === 0) this.host.afterApprovalQueueDrained()
        },
      ])
    } catch (failure) {
      // THIS prompt's own promise settles here too: when it was mounted from
      // another prompt's settle tail its executor already returned, so the throw
      // could never reject it (a caller would have waited forever). The rejected
      // value is exactly what this failure path throws, so the first-presented
      // case (whose executor also rejects) observes the SAME value.
      pending.reject(failure)
      throw failure
    }
  }

  /** Build and mount the approval dialog for one prompt on the active screen. */
  private mount(pending: PendingApproval): void {
    const frame = this.createFrame(pending)
    // The approval is REMOUNTABLE like every other managed overlay: a
    // fullscreen swap rebinds the SAME logical node (with a fresh surface), so
    // the overlays it suppresses stay suppressed and never get revealed/
    // focused/re-hidden (no fabricated focus transition).
    // The frame is published BEFORE the physical mount: the mount's focus
    // transition can synchronously run a plugin callback that starts a fullscreen
    // swap, and that swap calls the remount callback registered inside the mount
    // funnel — which replaces `responsiveFrame` and disposes the frame it replaces.
    pending.responsiveFrame = frame
    let handle: OverlayHandle
    try {
      handle = this.host.showApprovalOverlay(frame, (logical) => {
        if (this.active !== pending) return
        const previous = pending.responsiveFrame
        const next = this.createFrame(pending)
        pending.responsiveFrame = next
        this.host.rebindApprovalOverlay(logical, next)
        previous?.dispose()
      })
    } catch (error) {
      // The physical mount threw: the host has already unwound the overlay node it
      // prepared and forgot this node's remount callback. Dispose the frame this
      // mount currently owns — a swap inside the failing mount may already have
      // replaced `frame` with its successor, which the callback published and which
      // is the only frame left to release here — as an independent obligation, so a
      // dispose failure cannot hide the original failure.
      const current = pending.responsiveFrame
      pending.responsiveFrame = undefined
      runSyncDisposalStepsWithPrimary('approval overlay mount', error, [
        () => current?.dispose(),
      ])
    }
    // Phase 3A / PR-B MOUNT FENCE: the physical mount can synchronously run a
    // plugin callback (onFocus/onBlur) that settles this prompt, replaces it
    // with a newer one, or disposes the surface. Only the STILL-current prompt may
    // publish the handle; a losing mount releases exactly what THIS mount created
    // and never overwrites the newer prompt.
    if (!this.ownsStage(pending)) {
      // A callback of this mount settled or replaced the prompt: release exactly
      // what THIS mount created — its logical node (which also hides the physical
      // projection it owns) and the CURRENT frame, which a swap inside the mount may
      // already have replaced.
      const current = pending.responsiveFrame
      pending.responsiveFrame = undefined
      runSyncDisposalSteps('approval mount fence', [
        () => this.host.clearOverlayRemount(handle),
        () => handle.hide(),
        () => current?.dispose(),
      ])
      return
    }
    pending.handle = handle
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
      // Phase 3A / PR-B: the notification runs AFTER the handover decision and
      // reads the LIVE state — a queued approval that just took over keeps the
      // optional tenant PARKED; only a fully drained queue may restore it.
      () => {
        if (this.active === undefined && this.queue.length === 0) {
          this.host.afterApprovalQueueDrained()
        }
      },
    ])
  }
}
