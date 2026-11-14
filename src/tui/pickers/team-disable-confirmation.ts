/**
 * The independent OFF confirmation seat for Agent Team mode.
 *
 * A single-purpose component (never a generic confirmation framework): it
 * shows the exact consequence of disabling Team for ONE captured Root Session
 * and performs the write only after an explicit Confirm. It is a logical Root
 * seat of its own, mounted next to the `/model` overlay: closing `/model` does
 * NOT cancel this seat and does not change the Host.
 *
 * The captured scope/attempt and every read stay owned by the caller; this
 * component renders and forwards intent only. `Cancel`/`Esc` perform zero Host
 * writes, a failed write offers an explicit Retry only when it was proven not
 * to land, and an indeterminate write offers a read-only Recheck.
 *
 * @module @xmoon76/dsh-pi-tui/tui/pickers/team-disable-confirmation
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { TeamModeSnapshot, TeamModeWriteOutcome } from '../../runtime/team-mode-port.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'

/** The pristine confirmation text (kept plain, wrapped/painted at render time). */
const BODY = [
  'Team collaboration will be disabled for this Session.',
  'Existing subagents and shared tasks will not be deleted.',
  'Team tools change for later steps.',
] as const

/** The target this seat confirms. */
const TARGET_ENABLED = false

type Phase = 'idle' | 'saving' | 'checking' | 'failed' | 'unknown'
type Focus = 'cancel' | 'confirm'

/** The command-owned facts one confirmation seat renders and drives. */
export interface TeamDisableConfirmationRequest {
  /** The command-owned, scope-captured OFF attempt (re-verifies on every run). */
  run(): Promise<TeamModeWriteOutcome>
  /** The command-owned fresh projection read (never a local truth). */
  read(): TeamModeSnapshot
  /** Observe the captured Session's official projections. */
  subscribe(listener: () => void): () => void
  /** The seat was torn down (close or an owning screen swap); release state. */
  onClosed?(): void
}

/** The complete component dependencies (the mounting owner supplies the seat). */
export interface TeamDisableConfirmationOptions extends TeamDisableConfirmationRequest {
  /** Paint request for this component's owner. */
  requestRender(): void
  /** Hide the seat. The Host is never changed by this path. */
  close(): void
}

/** One painted action target (full visible segment). */
interface ActionHit {
  readonly action: 'cancel' | 'confirm'
  readonly start: number
  readonly end: number
}

export class TeamDisableConfirmation implements Component, Focusable {
  private readonly options: TeamDisableConfirmationOptions
  private phase: Phase = 'idle'
  private message: string | undefined
  private focus: Focus = 'cancel'
  private disposed = false
  private readonly unsubscribe: () => void
  /** Last painted action geometry for the click gesture fence. A real click's
   *  release arrives after the press's own focus repaint, so the fence is the
   *  painted WIDTH + action identity, never a render counter. */
  private lastFrameWidth = 0
  private lastActionRow = -1
  private lastActionHits: readonly ActionHit[] = []
  private pressed: { readonly action: 'cancel' | 'confirm' } | undefined

  get focused(): boolean {
    return true
  }

  set focused(_value: boolean) {
    // The seat owns its own keyboard focus; there is no Input to forward.
  }

  constructor(options: TeamDisableConfirmationOptions) {
    this.options = options
    this.unsubscribe = options.subscribe(() => {
      if (this.disposed) return
      // While waiting for a committed write to become observable, a projection
      // event is the freshness proof; other phases only repaint the row.
      if (this.phase === 'checking') this.settleChecking()
      else options.requestRender()
    })
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // An in-flight (or committed-but-unobserved) write owns this seat until an
    // explicit settlement: Esc/Cancel must never relinquish it and let the
    // picker behind start a second Team write.
    if (this.phase === 'saving' || this.phase === 'checking') return
    if (matchesKey(data, 'escape')) {
      this.cancel()
      return
    }
    if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.focus = this.focus === 'cancel' ? 'confirm' : 'cancel'
      this.options.requestRender()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      this.activate(this.focus)
      return
    }
    // The unknown state's explicit read-only recheck. Never a write.
    if (data === 'r' || data === 'R') {
      if (this.phase === 'unknown') this.recheck()
      return
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    const pressed = this.pressed
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) this.pressed = undefined
    if (event.width !== this.lastFrameWidth || event.y !== this.lastActionRow) return undefined
    const hit = this.lastActionHits.find(candidate => event.x >= candidate.start && event.x < candidate.end)
    if (hit === undefined) return undefined
    if (event.type === 'press') {
      if (event.button !== 'left') return undefined
      this.pressed = { action: hit.action }
      this.focus = hit.action
      this.options.requestRender()
      return { handled: true, focus: true }
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined
    // Only the SAME action at the CURRENT painted geometry may activate: a
    // resize/re-hydration changes the width/row/segment and rejects.
    if (pressed === undefined || pressed.action !== hit.action) return undefined
    this.activate(hit.action)
    return { handled: true }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.options.onClosed?.()
  }

  invalidate(): void {
    // No cached paint state beyond the last-frame hit map, rebuilt per render.
  }

  /** Whether the owning host may hide this seat right now. An in-flight write
   *  (saving/checking) must not be torn down: the operation owns the seat until
   *  an explicit settlement. */
  requestClose(): boolean {
    return this.phase !== 'saving' && this.phase !== 'checking'
  }

  render(width: number): string[] {
    const lines: string[] = []
    this.lastFrameWidth = width
    this.lastActionHits = []
    lines.push(truncateToWidth(color.textStrong('Disable Agent Team'), width, ''))
    lines.push('')
    for (const paragraph of BODY) {
      for (const row of wrapTextWithAnsi(paragraph, Math.max(1, width))) {
        lines.push(truncateToWidth(color.text(row), width, ''))
      }
    }
    if (this.phase === 'failed' || this.phase === 'unknown') {
      lines.push('')
      const tone = this.phase === 'failed' ? color.error : color.warning
      for (const row of wrapTextWithAnsi(this.message ?? '', Math.max(1, width))) {
        lines.push(truncateToWidth(tone(row), width, ''))
      }
    }
    lines.push('')
    const status = this.statusLine()
    if (status !== undefined) lines.push(truncateToWidth(status, width, ''))
    this.lastActionRow = lines.length
    const actionRow = this.renderActions(width)
    lines.push(actionRow.line)
    this.lastActionHits = actionRow.hits
    lines.push(truncateToWidth(`  ${color.textDim(this.hintText())}`, width, ''))
    return lines
  }

  private statusLine(): string | undefined {
    if (this.phase === 'saving') return `  ${color.textDim('Saving…')}`
    if (this.phase === 'checking') return `  ${color.textDim('Checking saved state…')}`
    return undefined
  }

  private hintText(): string {
    if (this.phase === 'saving') return 'Waiting for the Host…'
    if (this.phase === 'checking') return 'Checking saved state…'
    if (this.phase === 'unknown') return 'Esc close · R recheck (read-only)'
    return 'Esc cancel · ←→ choose · Enter act'
  }

  private cancelLabel(): string {
    return this.phase === 'unknown' ? 'Close' : 'Cancel'
  }

  private confirmLabel(): string {
    if (this.phase === 'failed') return 'Retry'
    if (this.phase === 'unknown') return 'Recheck'
    return 'Disable Team'
  }

  /** One action row with only COMPLETE, currently hittable segments. */
  private renderActions(width: number): { line: string; hits: readonly ActionHit[] } {
    const cancel = this.actionToken(this.cancelLabel(), this.focus === 'cancel')
    const confirm = this.actionToken(this.confirmLabel(), this.focus === 'confirm')
    const cancelWidth = visibleWidth(cancel)
    const confirmWidth = visibleWidth(confirm)
    const spacing = width - cancelWidth - confirmWidth
    if (spacing < 1) {
      // Extremely narrow: keep only the focused action, and register a hit only
      // when the whole token fits.
      const focused = this.focus === 'cancel' ? cancel : confirm
      const line = truncateToWidth(`  ${focused}`, width, '')
      const start = 2
      const end = start + visibleWidth(focused)
      const complete = end <= width
      return {
        line,
        hits: complete
          ? [{ action: this.focus, start, end }]
          : [],
      }
    }
    const line = `${cancel}${' '.repeat(spacing)}${confirm}`
    return {
      line,
      hits: [
        { action: 'cancel', start: 0, end: cancelWidth },
        { action: 'confirm', start: cancelWidth + spacing, end: cancelWidth + spacing + confirmWidth },
      ],
    }
  }

  private actionToken(label: string, active: boolean): string {
    return active ? color.primary(`[${label}]`) : color.textDim(` ${label} `)
  }

  private activate(action: 'cancel' | 'confirm'): void {
    if (this.disposed || this.phase === 'saving' || this.phase === 'checking') return
    if (action === 'cancel') {
      this.cancel()
      return
    }
    if (this.phase === 'unknown') {
      this.recheck()
      return
    }
    this.confirm()
  }

  private confirm(): void {
    this.phase = 'saving'
    this.message = undefined
    this.options.requestRender()
    this.options.run().then(
      outcome => { this.settle(outcome) },
      (error: unknown) => {
        // A thrown run() is an unexpected owner failure, never a proven write.
        this.settle({
          kind: 'indeterminate',
          reason: `the Team mode write could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        })
      },
    )
  }

  private settle(outcome: TeamModeWriteOutcome): void {
    if (this.disposed) return
    if (outcome.kind === 'committed') {
      this.phase = 'checking'
      this.options.requestRender()
      this.settleChecking()
      return
    }
    if (outcome.kind === 'indeterminate') {
      this.phase = 'unknown'
      this.message = sanitizedPhysicalLine(outcome.reason)
      this.focus = 'confirm'
      this.options.requestRender()
      return
    }
    // rejected / cancelled: both are proven not to have landed, so an explicit
    // Retry is safe (it re-runs the SAME captured attempt, which re-verifies).
    this.phase = 'failed'
    this.message = sanitizedPhysicalLine(outcome.reason)
    this.focus = 'confirm'
    this.options.requestRender()
  }

  /** Prove the committed target from a fresh official read, then close once. */
  private settleChecking(): void {
    if (this.disposed || this.phase !== 'checking') return
    const snapshot = this.options.read()
    if (snapshot.kind === 'ready' && snapshot.enabled === TARGET_ENABLED) {
      this.close()
      return
    }
    this.options.requestRender()
  }

  private recheck(): void {
    this.phase = 'checking'
    this.message = undefined
    this.options.requestRender()
    const snapshot = this.options.read()
    if (this.disposed) return
    if (snapshot.kind === 'ready' && snapshot.enabled === TARGET_ENABLED) {
      this.close()
      return
    }
    // The readback proves the target only when it EQUALS it. A still-On
    // readback cannot prove the earlier indeterminate write did not happen or
    // will not land later, so it must stay `unknown` and offer no Retry.
    this.phase = 'unknown'
    this.message = snapshot.kind === 'ready'
      ? sanitizedPhysicalLine(
        `the Host still reports Agent Team ${snapshot.enabled ? 'On' : 'Off'}; the earlier write may still land — recheck again`,
      )
      : sanitizedPhysicalLine(`the Host Team state is not readable yet: ${snapshot.reason}`)
    this.focus = 'confirm'
    this.options.requestRender()
  }

  private cancel(): void {
    // A write already dispatched with an unknown result must never be reported
    // as cancelled to the Host: closing this seat changes nothing there.
    this.close()
  }

  private close(): void {
    if (this.disposed) return
    // Commit the local ownership BEFORE the hide path can re-enter dispose().
    this.disposed = true
    this.unsubscribe()
    this.options.onClosed?.()
    this.options.close()
  }
}
