/** The ONE shared numeric Settings page for the FR5-B Agent-loop and
 * Shell-execution specialist entries. The controller owns every semantic
 * draft, validation and Host write; this page paints and routes input only. */
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { SectionRead } from '../../runtime/config-port.ts'
import type {
  HostNumericSettingsController,
  HostNumericSettingsField,
  HostNumericSettingsSnapshot,
} from '../../app/command/host-numeric-settings.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { EmbeddedSpecialistPage } from './settings-workspace-panel.ts'

export interface HostNumericSettingsPageSpec<T extends object> {
  readonly title: string
  /** The pane's own source fact (Agent: profile; Shell: the ACTIVE Host
   *  executor identity). It is painted above the field rows. */
  readonly sourceHeading: (source: SectionRead<T>) => string
  readonly help: readonly string[]
}

export interface HostNumericSettingsPageIntents<T extends object> {
  readonly controller: HostNumericSettingsController<T>
  readonly fields: readonly HostNumericSettingsField<T>[]
  readonly spec: HostNumericSettingsPageSpec<T>
  readonly requestRender: () => void
  readonly done: () => void
}

type BodyAction =
  | { readonly kind: 'field'; readonly field: string }
  | { readonly kind: 'reset'; readonly field: string }
  | { readonly kind: 'input' }
type BarAction = 'save' | 'refresh' | 'discard' | 'keep' | 'reset' | 'apply'
type BarSegment = ActionBarSegment & { readonly action?: BarAction; readonly escape?: boolean }
interface Target {
  readonly id: string
  readonly action: BodyAction
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}
interface ContentLine {
  readonly text: string
  readonly targets?: readonly Omit<Target, 'row'>[]
  readonly field?: string
}
interface Paint {
  readonly width: number
  readonly rows: number
  readonly identity: string
  readonly targets: readonly Target[]
  readonly maxOffset: number
  readonly scrollStart: number
  readonly scrollEnd: number
}

// These local, deliberately non-rebindable keys supply both handlers and badges.
const KEYS = { save: 's', refresh: 'r', reset: 'x', discard: 'd', yes: 'y', no: 'n' } as const
const DISCARD_QUESTION = 'Discard unsaved changes? y/N'
const RESET_WORD = '[Reset]'

function fit(text: string, width: number): string {
  const line = truncateToWidth(text, Math.max(0, width), '…', false)
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}

function statusWord<T extends object>(kind: string | undefined, snapshot: HostNumericSettingsSnapshot<T>): string {
  switch (kind) {
    case 'verified': return 'Verified'
    case 'not-saved': return 'Not saved'
    case 'unverified': return 'Unverified'
    case 'outcome-unconfirmed': return 'Outcome unconfirmed'
    case 'saving': return 'Saving…'
    default:
      if (snapshot.loading) return 'Loading Host settings…'
      if (snapshot.source.kind === 'unavailable') return 'Unavailable'
      if (snapshot.source.kind === 'unreadable') return 'Unreadable'
      if (!snapshot.current) return 'Last-known · read-only'
      if (snapshot.dirty) return 'Unsaved'
      return 'Ready'
  }
}

function statusInk(kind: string | undefined, text: string): string {
  if (kind === 'verified') return color.success(text)
  if (kind === 'not-saved') return color.error(text)
  if (kind === 'unverified' || kind === 'outcome-unconfirmed') return color.warning(text)
  return color.textDim(text)
}

export class HostNumericSettingsPage<T extends object> implements EmbeddedSpecialistPage {
  readonly title: string
  private readonly intents: HostNumericSettingsPageIntents<T>
  private readonly controller: HostNumericSettingsController<T>
  private readonly fields: readonly HostNumericSettingsField<T>[]
  private _focused = false
  private disposed = false
  private rowGrant = 8
  private revision = 0
  private fieldIndex = 0
  private formOffset = 0
  private revealSelection = true
  private numberInput: { readonly field: string; readonly input: Input } | undefined
  private question: { readonly instance: number; readonly target: 'leave' | 'refresh' } | undefined
  private nextQuestion = 0
  private paintedQuestion: string | undefined
  private waitNotice = false
  private readonly identities = new WeakMap<object, number>()
  private nextIdentity = 0
  private paint: Paint | undefined
  private pressed: { readonly paint: Paint; readonly target: Target } | undefined
  private awaitingPaint = true
  private escapeSpan: { readonly startCol: number; readonly endCol: number } | undefined
  private barSpans: readonly { readonly id: string; readonly action: BarAction; readonly startCol: number; readonly endCol: number }[] = []

  constructor(intents: HostNumericSettingsPageIntents<T>) {
    this.intents = intents
    this.controller = intents.controller
    this.fields = intents.fields
    this.title = intents.spec.title
    this.controller.start()
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    if (value !== this._focused) {
      this._focused = value
      this.revoke()
    }
    if (this.numberInput !== undefined) this.numberInput.input.focused = value
  }

  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next === this.rowGrant) return
    this.rowGrant = next
    this.revealSelection = true
    this.revoke()
  }
  grantAwaitingPaint(): boolean { return this.awaitingPaint }
  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined { return this.escapeSpan }
  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] { return this.barSpans }
  blocksParentNavigation(): boolean {
    const snapshot = this.controller.snapshot()
    return snapshot.dirty || snapshot.saving || this.numberInput !== undefined || this.question !== undefined
  }

  private identityOf(identity: object): number {
    let value = this.identities.get(identity)
    if (value === undefined) {
      value = ++this.nextIdentity
      this.identities.set(identity, value)
    }
    return value
  }
  private authorityIdentity(snapshot: HostNumericSettingsSnapshot<T>): string {
    const live = snapshot.currentGeneration === undefined ? '' : this.identityOf(snapshot.currentGeneration)
    return snapshot.source.kind === 'ready'
      ? `${this.identityOf(snapshot.source.generation)}:${snapshot.source.revision}->${live}:${snapshot.current}`
      : `${snapshot.source.kind}:${snapshot.source.reason}:${live}`
  }
  gestureIdentity(): string {
    const snapshot = this.controller.snapshot()
    return `${this.revision}|${snapshot.revision}|${this.authorityIdentity(snapshot)}|${snapshot.loading}|${snapshot.saving}|${this._focused}`
  }
  private questionIdentity(): string | undefined {
    const snapshot = this.controller.snapshot()
    return this.question === undefined ? undefined
      : `${this.question.instance}:${this.question.target}:${snapshot.revision}:${this.authorityIdentity(snapshot)}`
  }
  private revoke(): void {
    this.revision += 1
    this.awaitingPaint = true
    this.pressed = undefined
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
  }
  private changed(): void { this.revoke(); this.intents.requestRender() }

  private editable(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    return !snapshot.loading && !snapshot.saving && snapshot.current && snapshot.source.kind === 'ready'
  }
  private canSave(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    return snapshot.dirty && !snapshot.saving && !snapshot.loading && snapshot.current && snapshot.source.kind === 'ready'
  }
  private openQuestion(target: 'leave' | 'refresh'): void {
    this.question = { instance: ++this.nextQuestion, target }
    this.changed()
  }
  private keepEditing(): void { this.question = undefined; this.changed() }
  private discard(): void {
    if (this.question === undefined || this.paintedQuestion !== this.questionIdentity()) return
    const target = this.question.target
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    this.question = undefined
    if (target === 'refresh') this.controller.refresh(true)
    else this.controller.discard()
    this.changed()
    if (target === 'leave') this.intents.done()
  }
  private back(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) { this.waitNotice = true; this.changed(); return }
    if (this.question !== undefined) { this.keepEditing(); return }
    if (this.numberInput !== undefined) { this.numberInput = undefined; this.changed(); return }
    if (snapshot.dirty) this.openQuestion('leave')
    else this.intents.done()
  }
  private refresh(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    if (snapshot.dirty) { this.openQuestion('refresh'); return }
    this.controller.refresh()
    this.changed()
  }
  private activateField(field: string): void {
    const snapshot = this.controller.snapshot()
    if (!this.editable(snapshot)) return
    const spec = this.fields.find(item => item.key === field)
    if (spec === undefined) return
    this.fieldIndex = this.fields.indexOf(spec)
    const input = new Input({ prompt: 'Value: ', placeholder: 'blank stages Reset', placeholderStyle: color.textDim })
    const current = this.controller.textOf(spec.key) ?? (snapshot.source.kind === 'ready' ? String(snapshot.source.effective[spec.key]) : '')
    input.setValue(current)
    input.focused = this.focused
    this.numberInput = { field, input }
    this.changed()
  }
  private applyNumber(): void {
    const active = this.numberInput
    if (active === undefined || !this.editable(this.controller.snapshot())) return
    this.controller.setNumber(active.field as keyof T & string, active.input.getValue())
    this.numberInput = undefined
    this.revealSelection = true
    this.changed()
  }
  private reset(field: string): void {
    if (!this.editable(this.controller.snapshot())) return
    this.controller.reset(field as keyof T & string)
    this.revealSelection = true
    this.changed()
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // Every key retires a Root bar gesture and a body gesture. The painted
    // question receipt is independent: an explicit answer still proves it.
    this.revision += 1
    this.pressed = undefined
    const snapshot = this.controller.snapshot()
    if (matchesKey(data, 'escape')) { this.back(); return }
    if (snapshot.saving) return
    if (this.question !== undefined) {
      if (data === KEYS.yes || data === KEYS.yes.toUpperCase()) this.discard()
      else if (data === KEYS.no || data === KEYS.no.toUpperCase() || matchesKey(data, 'enter')) this.keepEditing()
      return
    }
    if (this.numberInput !== undefined) {
      if (matchesKey(data, 'enter')) this.applyNumber()
      else { this.numberInput.input.handleInput(data); this.changed() }
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.move(matchesKey(data, 'up') || matchesKey(data, 'shift+tab') ? -1 : 1)
      return
    }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.scroll((matchesKey(data, 'pageUp') ? -1 : 1) * Math.max(1, this.rowGrant - 4))
      return
    }
    if (matchesKey(data, 'home') || matchesKey(data, 'end')) {
      this.scroll(matchesKey(data, 'home') ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER)
      return
    }
    if (matchesKey(data, 'enter')) this.activateField(this.fields[this.fieldIndex]!.key)
    else if (matchesKey(data, KEYS.save) && this.canSave(snapshot)) { this.controller.save(); this.changed() }
    else if (matchesKey(data, KEYS.refresh)) this.refresh()
    else if (matchesKey(data, KEYS.reset)) this.reset(this.fields[this.fieldIndex]!.key)
    else if (matchesKey(data, KEYS.discard) && snapshot.dirty) this.openQuestion('leave')
  }

  private move(delta: number): void {
    this.fieldIndex = (this.fieldIndex + delta + this.fields.length) % this.fields.length
    this.revealSelection = true
    this.changed()
  }
  private scroll(delta: number): void {
    this.formOffset = Math.min(Math.max(0, this.formOffset + delta), this.paint?.maxOffset ?? 0)
    this.revealSelection = false
    this.changed()
  }

  activateBarSpan(id: string): void {
    if (this.disposed || this.awaitingPaint || this.paint?.identity !== this.gestureIdentity()) return
    const span = this.barSpans.find(span => span.id === id)
    if (span === undefined) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving || (span.action === 'save' && !this.canSave(snapshot))) return
    switch (span.action) {
      case 'save': this.controller.save(); this.changed(); break
      case 'refresh': this.refresh(); break
      case 'discard': this.question === undefined ? this.openQuestion('leave') : this.discard(); break
      case 'keep': this.keepEditing(); break
      case 'apply': this.applyNumber(); break
      case 'reset': this.reset(this.fields[this.fieldIndex]!.key); break
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const pressed = this.pressed
    // Only a NEW press or a wheel retires the previous body gesture. A release
    // may arrive through more than one screen event around a Root body grant,
    // so a click that does not match the current grant must not consume the
    // admitted press before the grant-sized click is considered.
    if (event.type === 'press' || event.type === 'wheel') this.pressed = undefined
    const paint = this.paint
    const sizeOnlyDuplicate = event.type === 'click' && paint !== undefined
      && event.width === paint.width && event.height !== paint.rows && event.height !== paint.rows - 1
    if (this.disposed || this.awaitingPaint || paint === undefined || paint.identity !== this.gestureIdentity()
      || event.width !== paint.width || (event.height !== paint.rows && event.height !== paint.rows - 1)
      || event.y < 0 || event.y >= paint.rows - 1) {
      if (event.type === 'click' && !sizeOnlyDuplicate) this.pressed = undefined
      return undefined
    }
    if (event.type === 'wheel') {
      if (event.y < paint.scrollStart || event.y >= paint.scrollEnd || this.question !== undefined || this.numberInput !== undefined || !event.wheelDelta) return undefined
      this.scroll(event.wheelDelta < 0 ? -1 : 1)
      return { handled: true }
    }
    const target = paint.targets.find(target => target.row === event.y && event.x >= target.startCol && event.x < target.endCol)
    if (target === undefined || event.button !== 'left') {
      if (event.type === 'click') this.pressed = undefined
      return undefined
    }
    if (event.type === 'press') { this.pressed = { paint, target }; return { handled: true } }
    if (event.type !== 'click' || pressed === undefined
      || pressed.paint.identity !== paint.identity || pressed.paint.width !== paint.width || pressed.paint.rows !== paint.rows
      || pressed.target.id !== target.id || pressed.target.row !== target.row
      || pressed.target.startCol !== target.startCol || pressed.target.endCol !== target.endCol) {
      if (event.type === 'click') this.pressed = undefined
      return undefined
    }
    this.pressed = undefined
    this.activateTarget(target, event)
    return { handled: true }
  }
  private activateTarget(target: Target, event: TuiMouseEvent): void {
    if (this.question !== undefined || this.controller.snapshot().saving) return
    switch (target.action.kind) {
      case 'field': if (this.numberInput === undefined) this.activateField(target.action.field); break
      case 'reset': if (this.numberInput === undefined) this.reset(target.action.field); break
      case 'input': this.numberInput?.input.handleMouse({ ...event, type: 'press', y: 0, height: 1 }); this.changed(); break
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    const snapshot = this.controller.snapshot()
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const lines: string[] = []
    const targets: Target[] = []
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
    let maxOffset = 0
    let scrollStart = 0
    let scrollEnd = 0
    if (this.question !== undefined) {
      const question = this.question.target === 'refresh'
        ? `${DISCARD_QUESTION} This also refreshes Host settings.`
        : DISCARD_QUESTION
      const facts = wrapTextWithAnsi(question, Math.max(1, width))
      for (const line of facts.slice(0, bodyRows)) lines.push(fit(color.warning(line), width))
      if (facts.length <= bodyRows && facts.every(line => visibleWidth(line) <= width)) this.paintedQuestion = this.questionIdentity()
    } else if (this.numberInput !== undefined) {
      const active = this.numberInput
      const label = this.fields.find(field => field.key === active.field)?.label ?? active.field
      if (bodyRows > 0) lines.push(fit(color.textDim(`Edit ${label}`), width))
      if (bodyRows > 1) {
        lines.push(active.input.render(width)[0] ?? '')
        targets.push({ id: 'input', action: { kind: 'input' }, row: 1, startCol: 0, endCol: width })
      }
      if (bodyRows > 2) lines.push(fit(color.textDim('Blank stages the official Reset operation.'), width))
    } else {
      const status = this.statusLines(snapshot, width)
      const statusRows = bodyRows >= 4 ? Math.min(3, status.length)
        : bodyRows >= 3 ? Math.min(2, status.length) : bodyRows >= 2 ? 1 : 0
      const viewport = Math.max(0, bodyRows - statusRows)
      const content = this.formLines(snapshot, width)
      maxOffset = Math.max(0, content.length - viewport)
      let offset = Math.min(this.formOffset, maxOffset)
      const selected = content.findIndex(line => line.field === this.fields[this.fieldIndex]!.key)
      if (this.revealSelection && selected >= 0 && viewport > 0) {
        if (selected < offset) offset = selected
        if (selected >= offset + viewport) offset = selected - viewport + 1
      }
      this.formOffset = offset
      this.revealSelection = false
      const top = lines.length + (bodyRows >= 4 ? 1 : 0)
      // Reserve one heading row whenever the grant can show a real field below it.
      if (bodyRows >= 4) lines.push(fit(color.textDim(this.intents.spec.sourceHeading(snapshot.source)), width))
      const contentRows = Math.max(0, viewport - (bodyRows >= 4 ? 1 : 0))
      scrollStart = top
      scrollEnd = top + contentRows
      for (let index = 0; index < contentRows; index += 1) {
        const line = content[offset + index]
        lines.push(fit(line?.text ?? '', width))
        for (const target of line?.targets ?? []) targets.push({ ...target, row: top + index })
      }
      for (const line of status.slice(0, statusRows)) lines.push(fit(line, width))
    }
    while (lines.length < bodyRows) lines.push(fit('', width))
    lines.push(this.renderBar(snapshot, width))
    this.awaitingPaint = false
    this.paint = { width, rows: this.rowGrant, identity: this.gestureIdentity(), targets, maxOffset, scrollStart, scrollEnd }
    return lines
  }

  private formLines(snapshot: HostNumericSettingsSnapshot<T>, width: number): ContentLine[] {
    const lines: ContentLine[] = []
    const source = snapshot.source
    const editable = this.editable(snapshot)
    for (const [index, field] of this.fields.entries()) {
      const selected = index === this.fieldIndex
      const stagedReset = snapshot.resetFields.includes(field.key)
      const draft = this.controller.textOf(field.key)
      const value = source.kind !== 'ready'
        ? 'Unknown'
        : stagedReset ? 'Reset staged' : draft ?? String(source.effective[field.key])
      const marker = selected ? color.primary('> ') : '  '
      const markerPlain = selected ? '> ' : '  '
      const resetWidth = visibleWidth(RESET_WORD)
      const minGap = 2
      const minLabel = 6
      // The painted Reset must be a COMPLETE segment whose hit span is derived
      // from the final line, never from a pre-fit composition. When the width
      // cannot host a real label + value + the whole word, the Reset action is
      // removed entirely (the field target still covers the row).
      const resetFits = width >= visibleWidth(markerPlain) + minLabel + minGap + 1 + resetWidth + 1
      const maxValueRoom = Math.max(1, width - visibleWidth(markerPlain) - minLabel - minGap - (resetFits ? resetWidth + 1 : 0))
      const valueRoom = Math.max(1, Math.min(Math.max(1, Math.floor(width / 3)), maxValueRoom))
      const paintedValue = truncateToWidth(sanitizedPhysicalLine(value), valueRoom, '…', false)
      const valueWidth = visibleWidth(paintedValue)
      const labelRoom = resetFits
        ? Math.max(0, width - visibleWidth(markerPlain) - valueWidth - resetWidth - minGap - 1)
        : Math.max(0, width - visibleWidth(markerPlain) - valueWidth - minGap)
      const paintedLabel = truncateToWidth(field.label, labelRoom, '…', false)
      const labelWidth = visibleWidth(paintedLabel)
      const used = visibleWidth(markerPlain) + labelWidth + valueWidth + (resetFits ? resetWidth + 1 : 0)
      const pad = Math.max(1, width - used)
      const suffix = resetFits ? ` ${color.primary(RESET_WORD)}` : ''
      const text = `${marker}${selected ? color.textStrong(paintedLabel) : color.text(paintedLabel)}${' '.repeat(pad)}${color.text(paintedValue)}${suffix}`
      const resetStart = resetFits ? width - resetWidth : undefined
      const rowTargets: Omit<Target, 'row'>[] = []
      if (editable) {
        rowTargets.push({
          id: `field:${field.key}`,
          action: { kind: 'field', field: field.key },
          startCol: 0,
          endCol: resetStart === undefined ? width : Math.max(0, resetStart - minGap),
        })
        if (resetStart !== undefined) {
          rowTargets.push({
            id: `reset:${field.key}`,
            action: { kind: 'reset', field: field.key },
            startCol: resetStart,
            endCol: resetStart + resetWidth,
          })
        }
      }
      lines.push({ text, field: field.key, targets: rowTargets })
      const overridden = source.kind === 'ready' ? source.overridden[field.key] === true : undefined
      const provenance = overridden === undefined ? 'Unknown' : overridden ? 'Overridden' : 'Inherited'
      lines.push({
        text: color.textDim(`  Source: ${provenance}${stagedReset ? ' · Reset staged' : ''}${source.kind === 'ready' && !snapshot.current ? ' · Last-known · read-only' : ''}`),
      })
      const issue = snapshot.issues[field.key]
      if (issue !== undefined) lines.push(...this.explanation(issue, width, true))
    }
    if (source.kind !== 'ready') lines.push(...this.explanation(source.reason, width, true))
    for (const help of this.intents.spec.help) lines.push(...this.explanation(help, width))
    if (snapshot.notice !== undefined) lines.push(...this.explanation(snapshot.notice, width, true))
    return lines
  }

  private explanation(text: string, width: number, error = false): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(text => ({ text: error ? color.error(text) : color.textDim(text) }))
  }

  private statusLines(snapshot: HostNumericSettingsSnapshot<T>, width: number): string[] {
    if (snapshot.loading) return [fit(color.textDim('Loading Host settings…'), width)]
    const kind = snapshot.status?.kind
    const line = `Status: ${statusInk(kind, statusWord(kind, snapshot))}`
    const lines = [line]
    const detail = this.waitNotice && snapshot.saving ? 'Saving… Dispatched writes continue.' : snapshot.status?.text
    if (detail !== undefined && kind !== 'verified') lines.push(color.error(sanitizedPhysicalLine(detail)))
    const issue = snapshot.issues[this.fields[this.fieldIndex]!.key]
    if (issue !== undefined) lines.push(color.error(sanitizedPhysicalLine(issue)))
    return lines.map(line => fit(line, width))
  }

  private renderBar(snapshot: HostNumericSettingsSnapshot<T>, width: number): string {
    let segments: BarSegment[]
    if (snapshot.saving) segments = [{ text: 'Saving…', priority: 900 }, { text: 'Wait [Esc]', priority: 1000, escape: true }]
    else if (this.rowGrant < 2) segments = [{ text: this.question !== undefined ? 'Keep [Esc]'
      : this.numberInput !== undefined ? 'Cancel [Esc]' : 'Back [Esc]', priority: 1000, escape: true }]
    else if (this.question !== undefined) segments = [
      ...(this.paintedQuestion === this.questionIdentity() ? [{ text: `Discard [${KEYS.yes.toUpperCase()}]`, priority: 900, action: 'discard' as const }] : []),
      { text: 'Keep [Esc]', priority: 1000, escape: true },
    ]
    else if (this.numberInput !== undefined) segments = [
      ...(this.rowGrant >= 3 && this.editable(snapshot) ? [{ text: 'Apply [Enter]', priority: 900, action: 'apply' as const }] : []),
      { text: 'Cancel [Esc]', priority: 1000, escape: true },
    ]
    else segments = [
      ...(this.canSave(snapshot) ? [{ text: `Save [${KEYS.save.toUpperCase()}]`, priority: 900, action: 'save' as const }] : []),
      ...(!snapshot.loading ? [{ text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 800, action: 'refresh' as const }] : []),
      ...(this.editable(snapshot) ? [{ text: `Reset [${KEYS.reset.toUpperCase()}]`, short: 'Reset', priority: 60, action: 'reset' as const }] : []),
      ...(snapshot.dirty ? [{ text: `Discard [${KEYS.discard.toUpperCase()}]`, short: 'Discard', priority: 50, action: 'discard' as const }] : []),
      { text: 'Back [Esc]', priority: 1000, escape: true },
    ]
    const layout = layoutActionBarRow(segments, width)
    if (layout.truncated) return fit(color.textMuted(layout.text), width)
    const painted: string[] = []
    const spans: { id: string; action: BarAction; startCol: number; endCol: number }[] = []
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]!
      painted.push(segment.action === undefined && !segment.escape ? color.textMuted(span.text)
        : paintActionSpan(span.text, segment.action === 'save' || segment.action === 'apply' ? 'primary' : 'secondary'))
      if (segment.escape) this.escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else if (segment.action !== undefined) spans.push({ id: `bar:${segment.action}`, action: segment.action, startCol: span.startCol, endCol: span.endCol })
    }
    this.barSpans = spans
    return fit(painted.join(ACTION_BAR_SEPARATOR), width)
  }

  invalidate(): void { this.numberInput?.input.invalidate() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revoke()
    this.paint = undefined
    this.numberInput = undefined
    this.controller.dispose()
  }
}
