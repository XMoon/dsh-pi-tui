/**
 * The PiTui Exit Choice seat (M6 UX PR1).
 *
 * One single-purpose component: it paints the Client-local exit model and
 * forwards the ONE selection callback. It owns no business decision — the
 * currentness fence, the daemon Stop/idle proof and the final exit commit all
 * stay with the exit-intent coordinator. Three real, mutually exclusive
 * actions are always painted together (never a hidden or clipped action), and
 * a click activates only the EXACT option segment of the current frame.
 *
 * @module @xmoon76/dsh-pi-tui/tui/interaction/exit-choice
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { ExitChoiceModel, ExitChoiceOption } from '../../app/surface/exit-choice.ts'
import { color } from '../theme/runtime.ts'

/** Below this inner width the compact option labels are used. */
const NARROW_WIDTH = 40
/** The visible focus marker of the focused option row. */
const FOCUS_MARK = '❯'

/** One painted option's clickable segment. */
interface OptionHit {
  readonly option: ExitChoiceOption
  readonly y: number
  readonly start: number
  readonly end: number
}

/** The component dependencies (the mounting owner supplies the seat). */
export interface ExitChoicePanelOptions {
  readonly model: ExitChoiceModel
  /** Paint request for this component's owner. */
  requestRender(): void
  /** The seat was torn down (close or an owning screen swap). */
  onClosed?(): void
}

export class ExitChoicePanel implements Component, Focusable {
  private readonly options: ExitChoicePanelOptions
  private model: ExitChoiceModel
  private focus: ExitChoiceOption | undefined
  private disposed = false
  private pressed: ExitChoiceOption | undefined
  private lastOptionHits: readonly OptionHit[] = []
  /** The content width of the last painted frame (the pointer-frame fence). */
  private lastFrameWidth = 0

  get focused(): boolean {
    return true
  }

  set focused(_value: boolean) {
    // The seat owns its own keyboard focus; there is no Input to forward.
  }

  constructor(options: ExitChoicePanelOptions) {
    this.options = options
    this.model = options.model
    this.focus = options.model.focus
  }

  /** Replace the painted model (a phase transition of the SAME choice). */
  setModel(model: ExitChoiceModel): void {
    if (this.disposed) return
    this.model = model
    // Reset focus when the new phase no longer offers the current option;
    // otherwise keep the user's focus across an update of the same list.
    if (this.focus === undefined || !model.options.some(option => option.id === this.focus)) {
      this.focus = model.focus
    }
    this.pressed = undefined
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // While the daemon Stop is in flight the choice is LOCKED: no key can
    // dispatch a second cancel or turn the wait into an exit.
    if (this.model.phase === 'stopping') return
    if (matchesKey(data, 'escape') || (matchesKey(data, 'ctrl+c'))) {
      this.model.select('stay')
      return
    }
    const options = this.model.options
    if (options.length === 0) return
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const forward = !matchesKey(data, 'up') && !matchesKey(data, 'shift+tab')
      const index = this.focusIndex()
      const next = forward
        ? (index + 1) % options.length
        : (index - 1 + options.length) % options.length
      this.focus = options[next]!.id
      this.options.requestRender()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const focused = this.focusedOption()
      if (focused !== undefined) this.model.select(focused)
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    // The press identity is read BEFORE a release clears it: the gesture is
    // the SAME option's press and release on the SAME painted segment.
    const pressed = this.pressed
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) this.pressed = undefined
    // A pointer event from another painted width is a foreign frame, never a
    // near-miss on the current option geometry.
    if (event.width !== this.lastFrameWidth) return undefined
    const hit = this.lastOptionHits.find(candidate =>
      event.y === candidate.y && event.x >= candidate.start && event.x < candidate.end)
    if (hit === undefined) return undefined
    if (event.type === 'press') {
      if (event.button !== 'left') return undefined
      this.pressed = hit.option
      this.focus = hit.option
      this.options.requestRender()
      return { handled: true, focus: true }
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined
    // Only the SAME option at the CURRENT painted geometry may activate.
    if (pressed !== hit.option) return undefined
    this.model.select(hit.option)
    return { handled: true }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.onClosed?.()
  }

  invalidate(): void {
    // No cached paint state beyond the last-frame hit map, rebuilt per render.
  }

  render(width: number): string[] {
    const inner = Math.max(1, width)
    const narrow = inner < NARROW_WIDTH
    const lines: string[] = []
    this.lastFrameWidth = inner
    this.lastOptionHits = []
    lines.push(truncateToWidth(color.textStrong(this.title(narrow)), inner, ''))
    lines.push('')
    for (const paragraph of this.model.body) {
      for (const row of wrapTextWithAnsi(paragraph, inner)) {
        lines.push(truncateToWidth(color.text(row), inner, ''))
      }
    }
    if (this.model.status !== undefined && this.model.status !== '') {
      lines.push('')
      for (const row of wrapTextWithAnsi(this.model.status, inner)) {
        lines.push(truncateToWidth(color.warning(row), inner, ''))
      }
    }
    lines.push('')
    const hits: OptionHit[] = []
    for (const option of this.model.options) {
      const focused = option.id === this.focusedOption()
      const label = narrow ? option.shortLabel : option.label
      const marker = focused ? FOCUS_MARK : ' '
      const text = `${marker} ${label}`
      const complete = visibleWidth(text) <= inner
      const painted = complete ? text : truncateToWidth(text, inner, '…')
      lines.push(focused ? color.primary(painted) : color.text(painted))
      // Register a target only for a WHOLE label: a clipped option must never
      // be clickable as if it were fully readable.
      if (complete) hits.push({ option: option.id, y: lines.length - 1, start: 0, end: visibleWidth(text) })
    }
    this.lastOptionHits = hits
    lines.push('')
    lines.push(truncateToWidth(`  ${color.textDim(this.hintText())}`, inner, ''))
    return lines
  }

  private title(narrow: boolean): string {
    if (!narrow) return this.model.title
    return this.model.kind === 'daemon-busy' || this.model.kind === 'daemon-unknown' ? 'Disconnect' : 'Exit'
  }

  private hintText(): string {
    if (this.model.phase === 'stopping') return 'Waiting for the Host…'
    return '↑↓ Select · Enter Confirm · Esc Stay'
  }

  /** The option that currently owns the keyboard focus, if any. */
  private focusedOption(): ExitChoiceOption | undefined {
    const options = this.model.options
    if (options.length === 0) return undefined
    return options.find(option => option.id === this.focus)?.id ?? options[0]!.id
  }

  private focusIndex(): number {
    const options = this.model.options
    const focused = this.focusedOption()
    const index = options.findIndex(option => option.id === focused)
    return index < 0 ? 0 : index
  }
}
