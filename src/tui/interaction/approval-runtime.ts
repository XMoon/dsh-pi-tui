/**
 * The TUI-local approval interaction lifecycle (Surface Phase 3C / C1-B): the
 * FIFO prompt queue, the ONE approval action sheet on screen, its abort
 * binding, the blocking editor-seat projection, the fixed y/n/Esc/Ctrl+C
 * ownership, the exactly-once settlement, the next-item scheduling and the
 * teardown cancellation.
 *
 * It owns no Host business semantics: the approval request production, the
 * `InteractionPort` and the application currentness stay above it. The sheet
 * itself is `tui/panels/approval-dialog.ts`; this runtime creates exactly one
 * frame per active prompt, projects it through the host's seat arbitration and
 * releases it before the caller promise settles. Pointer decisions and the
 * fixed keyboard decisions both enter the ONE `settle` path below.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/approval-runtime
 */

import { matchesKey, type OverlayHandle, type TuiInputListenerResult } from '@xmoon76/pi-tui'
import { runSyncDisposalSteps, runSyncDisposalStepsWithPrimary } from '../../runtime/process/disposal.ts'
import {
  ApprovalSheetFrame,
  type ApprovalOutcome,
  type ApprovalPromptRequest,
} from '../panels/approval-dialog.ts'

/**
 * The terminal/seat capabilities the approval runtime consumes. Every member
 * is an existing TuiApp coordination primitive — the runtime owns the approval
 * state machine, never a second copy of the editor/focus/overlay facts.
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
  /** Repaint the active surface after a sheet-local reading state change. */
  requestRender(): void
  /** The live terminal dimensions the sheet frame budget derives from. */
  terminalSize(): { readonly columns: number; readonly rows: number }
  /**
   * Project the approval frame into the blocking editor seat: commit the
   * overlay-root suspension, install the frame as the live seat occupant and
   * hand it the keyboard. Does NOT touch the approval queue/promise: the
   * runtime already committed the pending prompt as active before this call.
   */
  mountApprovalFrame(pending: PendingApproval): void
  /**
   * Release the seat projection: reveal the suspended managed roots and
   * re-project the LIVE seat owner (a newer blocker, the optional tenant or
   * the editor). The caller has already cleared the active slot, so this can
   * never paint the released frame again.
   */
  releaseApprovalFrame(pending: PendingApproval): void
  /**
   * Roll back a FAILED seat presentation: the prompt never mounted (or lost a
   * synchronous callback race). Re-project the live owner and reveal only the
   * roots still owned by THIS prompt; never touch a newer owner.
   */
  rollbackApprovalFrame(pending: PendingApproval): void
  /** Total frame-row grant (borders included) for the current reading size. */
  approvalSeatRows(expanded: boolean): number
  /** Whether the active surface supports approval pointer actions (fullscreen). */
  approvalMouseEnabled(): boolean
  /** Deliver the exact received argument bytes through the Client clipboard. */
  copyApprovalArguments(text: string): void
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
  /** The live editor-seat action sheet behind this prompt. */
  frame?: ApprovalSheetFrame
  /** Managed overlay roots hidden by this blocking seat owner; revealed when
   * this prompt releases the seat (or transferred to a newer blocker). */
  suspendedOverlays: Set<OverlayHandle>
  /** Latched by settle: every prompt promise settles exactly once. */
  settled?: boolean
}

/**
 * The approval interaction owner. Requests queue FIFO; only one action sheet is
 * on screen at a time; an aborted signal settles the prompt `cancelled`.
 */
export class ApprovalRuntime {
  private readonly queue: PendingApproval[] = []
  private active: PendingApproval | undefined

  private readonly host: ApprovalRuntimeHost

  constructor(host: ApprovalRuntimeHost) {
    this.host = host
  }

  /** Whether an approval currently owns the input stage. */
  isActive(): boolean {
    return this.active !== undefined
  }

  /** The live action sheet of the active prompt, if it has been built. */
  activeFrame(): ApprovalSheetFrame | undefined {
    return this.active?.frame
  }

  /** The active prompt's overlay suspension view (the broker's modal seam). */
  activeSuspension(): { readonly suspendedOverlays: Set<OverlayHandle> } | undefined {
    return this.active
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

  /**
   * Whether a key must be admitted to the sheet BEFORE the configurable modal
   * inspection ladder: the four fixed response keys plus the sheet's own
   * read-only keys. A remapped inspection action can never steal a decision or
   * a reading key while the action sheet is the blocking owner.
   */
  ownsFixedKey(data: string): boolean {
    if (matchesKey(data, 'y')
      || matchesKey(data, 'n')
      || matchesKey(data, 'escape')
      || matchesKey(data, 'ctrl+c')
    ) return true
    return this.active?.frame?.ownsReadKey(data) === true
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
    else if (pending.frame?.handleActionKey(data) === true) this.host.requestRender()
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
      const pending: PendingApproval = {
        request,
        resolve,
        reject,
        agentInputWait,
        suspendedOverlays: new Set(),
      }
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
    // optional-tenant park, the Save Location cancellation, the seat mount).
    // A callback fired by any of them must already observe THIS approval as
    // the active owner, so the optional tenant can never be restored (or a
    // Save Location settle can never take its "no approval active" restore
    // path) behind an uncommitted approve.
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
    // project its sheet over the newer owner (the post-mount fence below cannot
    // undo a seat frame that is already physically installed).
    if (!this.ownsStage(pending)) return
    try {
      this.mount(pending)
    } catch (error) {
      // Phase 3A / PR-B MOUNT FAILURE: the seat projection runs a synchronous
      // focus transition (a plugin onBlur/onFocus), which may throw. The prompt
      // is already committed as active, so this failure releases exactly its own
      // bindings and resources (see `rollbackFailedPresentation`).
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
   * cancellation, the seat projection) — a settled or replaced prompt must not
   * keep acting on the stage its newer owner took.
   */
  private ownsStage(pending: PendingApproval): boolean {
    return this.active === pending && pending.settled !== true && !this.host.isDisposed()
  }

  /**
   * Phase 3A / PR-B: release THIS prompt after a failed presentation (a throwing
   * park hook or a throwing seat mount). The rollback is IDENTITY FENCED and
   * its obligations are INDEPENDENT: the prompt is latched settled and its abort
   * listener removed (it leaves every owner slot here, so nothing else would ever
   * unbind the caller's signal), the active slot is cleared only while THIS prompt
   * still owns it (a cleanup that synchronously settled this prompt and opened a
   * NEWER approval keeps its ownership, or 'y'/'n' could no longer settle the
   * newer prompt), the host completes the abandoned presentation's seat/publish
   * obligations, a legally queued successor is still presented through the
   * existing queue authority, the LAST-blocker notification runs once no approval
   * is active and the queue drained, and the ORIGINAL failure propagates
   * (aggregated by identity with a rollback failure).
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
        () => this.host.rollbackApprovalFrame(pending),
        () => this.releaseFrame(pending),
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

  /** Build and project the action sheet for one prompt into the editor seat. */
  private mount(pending: PendingApproval): void {
    const frame = new ApprovalSheetFrame(pending.request, {
      rowsOf: (expanded) => this.host.approvalSeatRows(expanded),
      terminalRows: () => this.host.terminalSize().rows,
      mouseEnabled: () => this.host.approvalMouseEnabled(),
      onDecision: (outcome) => {
        // A synchronous focus/blur/plugin callback may run inside the pointer
        // dispatch; its settlement cleanup can throw. Contain it through the
        // SAME owned sink the abort listener uses instead of letting it escape
        // the terminal callback as an uncaught exception.
        try {
          this.settle(pending, outcome)
        } catch (error) {
          this.host.routeSettlementFailure('approval pointer settlement', error)
        }
      },
      onCopy: (text) => this.host.copyApprovalArguments(text),
    })
    pending.frame = frame
    // The seat projection is a synchronous focus transition: it may settle or
    // replace THIS prompt (the mount fence below decides what is still owned).
    this.host.mountApprovalFrame(pending)
    // Phase 3A / PR-B MOUNT FENCE: the physical projection can synchronously run
    // a plugin callback (onFocus/onBlur) that settles this prompt, replaces it
    // with a newer one, or disposes the surface. Only the STILL-current prompt may
    // keep the frame; a losing mount releases exactly what THIS mount created and
    // never touches the newer prompt.
    if (!this.ownsStage(pending)) this.releaseFrame(pending)
  }

  /** Release this prompt's sheet object. The host has already re-projected the
   * seat, so the frame is detached before it is disposed. Idempotent: a settle
   * or a newer prompt may already have cleared it. */
  private releaseFrame(pending: PendingApproval): void {
    const frame = pending.frame
    if (frame === undefined) return
    pending.frame = undefined
    frame.dispose?.()
  }

  /**
   * Resolve one prompt and release its sheet. The prompt may be on screen
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
        // Re-project the LIVE seat owner and reveal the roots this prompt hid.
        // `releaseApprovalFrame` runs BEFORE the frame is disposed so the seat
        // never paints a detached component; a newer blocker opened by these
        // callbacks keeps its own projection.
        () => this.host.releaseApprovalFrame(pending),
        () => this.releaseFrame(pending),
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
