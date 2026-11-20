/**
 * The PiTui Exit Choice seat (M6 UX PR1).
 *
 * One single-purpose component: it paints the Client-local exit model and
 * forwards the ONE selection callback. It owns no business decision — the
 * currentness fence, the daemon Stop/idle proof and the final exit commit all
 * stay with the exit-intent coordinator.
 *
 * Operability is a REAL terminal property, not a style: an option is actable
 * only when its complete label fits the painted width AND the painted box can
 * show every actable option. When the terminal cannot host the three actions,
 * the seat degrades to the truthful safe path (Stay) instead of leaving a
 * clipped or off-screen destructive action keyboard-reachable. A pointer only
 * activates the exact complete option segment of the current frame.
 *
 * @module @xmoon76/dsh-pi-tui/tui/interaction/exit-choice
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { ExitChoiceModel, ExitChoiceOption, ExitChoiceOptionView } from '../../app/surface/exit-choice.ts'
import { color, selectListTheme as theme } from '../theme/runtime.ts'

/** Below this inner width the compact option labels are used. */
const NARROW_WIDTH = 40
/**
 * The focused option's navigation cursor — the Owner-frozen D3 device: the
 * ASCII `>` two-cell cursor gutter owns `primary`; the selected label itself is
 * bold `textStrong` (see `docs/architecture/design-language.md` D3/§5). `❯`
 * stays reserved for its transcript/legacy roles and is never a list cursor.
 */
const FOCUS_MARK = '>'
/** The fallback content height before the mounting frame reports a budget. */
const DEFAULT_MAX_ROWS = 20

/** Pad a non-focused option row to the frame width so the box stays solid. */
function paddedRow(text: string, inner: number): string {
  return text + ' '.repeat(Math.max(0, inner - visibleWidth(text)))
}

/** One painted option's clickable segment. */
interface OptionHit {
  readonly option: ExitChoiceOption
  readonly y: number
  readonly start: number
  readonly end: number
}

/** The content plan of one frame: only what the granted box can really show. */
interface FramePlan {
  /** The single fallback line when nothing else fits (never an action). */
  readonly minimal: string | undefined
  readonly title: boolean
  /** The full risk paragraphs (otherwise the short line). */
  readonly body: 'full' | 'short' | 'none'
  readonly status: boolean
  /** The actable options, in keyboard order. */
  readonly options: readonly ExitChoiceOptionView[]
  readonly hint: boolean
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
  /** The options the LAST painted frame made actable (keyboard + pointer). */
  private lastOperable: readonly ExitChoiceOptionView[] = []
  /** The content rows granted by the owning responsive frame. */
  private maxRows = DEFAULT_MAX_ROWS
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
    this.focus = options.model.focus ?? options.model.options[0]?.id
  }

  /** Replace the painted model (a phase transition of the SAME choice). */
  setModel(model: ExitChoiceModel): void {
    if (this.disposed) return
    this.model = model
    // A phase/model transition is an intervening gesture: a pointer press
    // captured by the previous frame can never complete on the new one.
    this.pressed = undefined
    // Reset focus when the new phase no longer offers the current option;
    // otherwise keep the user's focus across an update of the same list.
    if (this.focus === undefined || !model.options.some(option => option.id === this.focus)) {
      this.focus = model.focus ?? model.options[0]?.id
    }
  }

  /** Content-row budget from the owning responsive frame. */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
  }

  /**
   * The physical geometry changed (a terminal resize): the last painted
   * action set no longer describes the viewport. Keyboard confirmation is
   * refused until the next render recomputes it.
   */
  invalidateActions(): void {
    this.lastOperable = []
    this.pressed = undefined
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // While the daemon Stop is in flight the choice is LOCKED: no key can
    // dispatch a second cancel or turn the wait into an exit.
    if (this.model.phase === 'stopping') return
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      // Any intervening gesture cancels a pending pointer press: the release
      // can only ever complete the gesture the user CURRENTLY sees.
      this.pressed = undefined
      this.model.select('stay')
      return
    }
    const operable = this.lastOperable
    if (operable.length === 0) return
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      // A keyboard focus move is an intervening gesture: a pointer press
      // started on another option can never be released into an action.
      this.pressed = undefined
      const forward = !matchesKey(data, 'up') && !matchesKey(data, 'shift+tab')
      const index = operable.findIndex(option => option.id === this.focusedOption())
      const from = index < 0 ? 0 : index
      const next = forward ? (from + 1) % operable.length : (from - 1 + operable.length) % operable.length
      this.focus = operable[next]!.id
      this.options.requestRender()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      this.pressed = undefined
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
    this.lastFrameWidth = inner
    this.lastOptionHits = []
    const narrow = inner < NARROW_WIDTH
    const plan = this.plan(inner)
    this.lastOperable = plan.options
    if (plan.minimal !== undefined) {
      this.lastOperable = []
      return [truncateToWidth(color.textDim(plan.minimal), inner, '')]
    }
    const lines: string[] = []
    if (plan.title) lines.push(truncateToWidth(color.textStrong(this.title(narrow)), inner, ''))
    if (plan.body === 'full') {
      lines.push('')
      for (const paragraph of this.model.body) {
        for (const row of wrapTextWithAnsi(paragraph, inner)) {
          lines.push(truncateToWidth(color.text(row), inner, ''))
        }
      }
    } else if (plan.body === 'short') {
      for (const row of wrapTextWithAnsi(this.model.shortBody, inner)) {
        lines.push(truncateToWidth(color.text(row), inner, ''))
      }
    }
    if (plan.status && this.model.status !== undefined && this.model.status !== '') {
      lines.push('')
      for (const row of wrapTextWithAnsi(this.model.status, inner)) {
        lines.push(truncateToWidth(color.warning(row), inner, ''))
      }
    }
    if (plan.options.length > 0) {
      if (plan.body === 'full') lines.push('')
      const hits: OptionHit[] = []
      for (const option of plan.options) {
        const focused = option.id === this.focusedOption()
        const label = narrow ? option.shortLabel : option.label
        const text = `${focused ? FOCUS_MARK : ' '} ${label}`
        const complete = visibleWidth(text) <= inner
        const painted = complete ? text : truncateToWidth(text, inner, '…')
        // D3: the two-cell gutter owns primary; the focused LABEL is bold
        // textStrong — never a primary-painted whole row.
        lines.push(focused
          ? `${theme.selectedPrefix(`${FOCUS_MARK} `)}${theme.selectedText(label)}`
          : color.text(paddedRow(painted, inner)))
        // Register a target only for a WHOLE label: a clipped option must never
        // be clickable or keyboard-actable as if it were fully readable.
        if (complete) hits.push({ option: option.id, y: lines.length - 1, start: 0, end: visibleWidth(text) })
      }
      this.lastOptionHits = hits
    }
    if (plan.hint) {
      lines.push('')
      lines.push(truncateToWidth(`  ${color.textDim(this.hintText())}`, inner, ''))
    }
    return lines
  }

  /**
   * Choose the richest truthful layout the granted box can host. A destructive
   * option is actable only when EVERY offered option is fully readable and the
   * box can paint them all; otherwise only Stay remains (or no action at all).
   */
  private plan(inner: number): FramePlan {
    const narrow = inner < NARROW_WIDTH
    const model = this.model
    const label = (option: ExitChoiceOptionView): string => narrow ? option.shortLabel : option.label
    const fits = (option: ExitChoiceOptionView): boolean => visibleWidth(`${FOCUS_MARK} ${label(option)}`) <= inner
    const widthOptions = model.options.length === 0
      ? []
      : model.options.every(fits)
        ? [...model.options]
        : model.options.filter(option => option.id === 'stay' && fits(option))
    const wrapRows = (text: string): number => Math.max(1, wrapTextWithAnsi(text, inner).length)
    const bodyRows = model.body.reduce((rows, paragraph) => rows + wrapRows(paragraph), 0)
    const shortRows = wrapRows(model.shortBody)
    // The status is a blank row plus its REAL wrapped rows: a long Host error
    // must never be budgeted as two rows and then push the actions off-screen.
    const statusRows = model.status === undefined || model.status === ''
      ? 0
      : 1 + wrapRows(model.status)
    const minimal = (): FramePlan => ({
      minimal: model.phase === 'stopping' ? 'Stopping current work…' : 'Esc Stay',
      title: false,
      body: 'none',
      status: false,
      options: [],
      hint: false,
    })

    // The Stopping phase offers no option: paint the bounded progress text.
    if (model.options.length === 0) {
      const fullNeeded = 1 + 1 + bodyRows + 1
      if (this.maxRows >= fullNeeded) {
        return { minimal: undefined, title: true, body: 'full', status: false, options: [], hint: true }
      }
      if (this.maxRows >= 1 + shortRows) {
        return { minimal: undefined, title: true, body: 'short', status: false, options: [], hint: false }
      }
      return minimal()
    }
    // Nothing actable fits this width: only the truthful safe exit remains.
    if (widthOptions.length === 0) return minimal()

    const fullNeeded = 1 + 1 + bodyRows + statusRows + widthOptions.length + 1 + 1
    if (this.maxRows >= fullNeeded) {
      return { minimal: undefined, title: true, body: 'full', status: statusRows > 0, options: widthOptions, hint: true }
    }
    // The risk sentence is part of the decision contract: a box that cannot
    // host it WITH every action must not keep the destructive actions actable.
    const compactNeeded = 1 + shortRows + widthOptions.length
    if (this.maxRows >= compactNeeded) {
      return { minimal: undefined, title: true, body: 'short', status: false, options: widthOptions, hint: false }
    }
    // The box cannot host the risk line plus every actable option: keep ONLY
    // the safe path, with the risk line when it still fits.
    const stay = widthOptions.find(option => option.id === 'stay')
    if (stay !== undefined && this.maxRows >= 2 + shortRows) {
      return { minimal: undefined, title: true, body: 'short', status: false, options: [stay], hint: false }
    }
    if (stay !== undefined && this.maxRows >= 2) {
      return { minimal: undefined, title: true, body: 'none', status: false, options: [stay], hint: false }
    }
    return minimal()
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
    const operable = this.lastOperable
    if (operable.length === 0) return undefined
    return operable.find(option => option.id === this.focus)?.id ?? operable[0]!.id
  }
}
