/** The ONE shared numeric Settings page for the FR5-B Agent-loop and
 * Shell-execution specialist entries. The controller owns every semantic
 * draft, validation and Host write; this page paints and routes input only.
 *
 * ONE tenant renderer serves two commit modes:
 * - `single` (SUX-01 Agent loop) is the inline single-value Detail tenant: ONE
 *   Confirm performs the stage->save handoff, `?` opens the Advanced
 *   disclosure, and the Root keeps the physical bar/parent panes.
 * - `grouped` (SUX-02 Shell execution) is the same Detail tenant for a group of
 *   fields: field browse/selection, an explicit Edit -> Stage draft, ONE Save
 *   of the whole patch, and the selected field's Advanced reset. */
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
import type { EmbeddedSpecialistPage, SpecialistParentLeaveTarget } from './settings-workspace-panel.ts'

export interface HostNumericSettingsPageSpec<T extends object> {
  readonly title: string
  /** The pane's own source fact (Agent: profile; Shell: the ACTIVE Host
   *  executor identity). It is painted above the field rows. */
  readonly sourceHeading: (source: SectionRead<T>) => string
  /** The grouped browse's authority notes (Shell execution). */
  readonly help: readonly string[]
  /** The row's ONE presentation contract: a single-value tenant or a grouped
   *  field tenant. It is never user-configurable and has no third mode. */
  readonly commitMode: 'single' | 'grouped'
  /** When the value takes effect (one sentence). */
  readonly effect?: string
  /** Single mode: what the change does NOT rewrite. */
  readonly dispatched?: string
  /** The owning authority's scope fact (Advanced). */
  readonly scope?: string
}

export interface HostNumericSettingsPageIntents<T extends object> {
  readonly controller: HostNumericSettingsController<T>
  readonly fields: readonly HostNumericSettingsField<T>[]
  readonly spec: HostNumericSettingsPageSpec<T>
  readonly requestRender: () => void
  readonly done: () => void
  /** Single mode: the typed explicit entry the Root really took. It is
   *  consumed ONCE by the first settled read and never replayed. */
  readonly entryIntent?: 'change' | 'details'
}

interface BodyTarget {
  readonly id: string
  readonly action:
    | { readonly kind: 'field'; readonly field: string }
    | { readonly kind: 'reset'; readonly field: string }
    | { readonly kind: 'input' }
    | { readonly kind: 'details' }
    | { readonly kind: 'edit' }
    | { readonly kind: 'refresh' }
  readonly startCol: number
  readonly endCol: number
}
type BarAction =
  | 'save' | 'refresh' | 'discard' | 'keep' | 'reset' | 'apply'
  | 'change' | 'edit' | 'details' | 'reset-confirm' | 'leave' | 'refresh-confirm'
type BarSegment = ActionBarSegment & { readonly action?: BarAction; readonly escape?: boolean }
interface Target extends BodyTarget {
  readonly row: number
}
interface ContentLine {
  readonly text: string
  readonly targets?: readonly BodyTarget[]
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
type QuestionKind = 'leave' | 'refresh' | 'reset' | 'parent-leave' | 'discard'
interface Question {
  readonly instance: number
  readonly kind: QuestionKind
  /** The captured parent-leave continuation. */
  readonly leave?: () => void
}

// These local, deliberately non-rebindable keys supply both handlers and badges.
const KEYS = { save: 's', refresh: 'r', reset: 'x', discard: 'd' } as const
const DETAILS_KEY = '?'
/** The reset confirmation's necessary risk copy: every line must have been
 *  painted inside THIS question instance before Confirm can be given. */
const RESET_RISK = [
  'Reset sends the official unset.',
  'The USER patch may retain the inherited value.',
  'The Host readback decides the value.',
] as const
const AMBIGUOUS_LEAVE = [
  'The Host may have applied this change.',
  'Leaving does not undo it.',
] as const
const DEFINITE_LEAVE = [
  'Discard unsaved changes?',
  'The Host did not save this change.',
] as const
const REFRESH_QUESTION = [
  'Refresh discards unsaved edits.',
  'The Host may have applied this change.',
] as const
const GROUP_REFRESH = [
  'Refresh discards unsaved edits.',
  'The staged values are lost.',
] as const
const GROUP_DISCARD = [
  'Discard unsaved changes?',
  'Staged values are lost; nothing is written.',
] as const

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

/** The semantic action a painted BODY affordance really is (the bar's own
 *  spans are registered by the bar loop). Field selection and the Input caret
 *  are not business actions. */
function bodyActionOf(kind: 'field' | 'reset' | 'input' | 'details' | 'edit' | 'refresh'): BarAction | undefined {
  switch (kind) {
    case 'reset': return 'reset'
    case 'details': return 'details'
    case 'edit': return 'edit'
    case 'refresh': return 'refresh'
    default: return undefined
  }
}

export class HostNumericSettingsPage<T extends object> implements EmbeddedSpecialistPage {
  readonly title: string
  private readonly intents: HostNumericSettingsPageIntents<T>
  private readonly controller: HostNumericSettingsController<T>
  private readonly fields: readonly HostNumericSettingsField<T>[]
  private readonly single: boolean
  private _focused = false
  private disposed = false
  private rowGrant = 8
  private revision = 0
  private fieldIndex = 0
  private formOffset = 0
  private revealSelection = true
  private numberInput: { readonly field: string; readonly input: Input } | undefined
  private question: Question | undefined
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
  // ── tenant state (SUX-01 single value / SUX-02 grouped fields) ────────────
  private entryIntent: 'change' | 'details' | undefined
  private advanced = false
  private fieldError: string | undefined
  private feedback: 'no-changes' | undefined
  /** The synchronous stage->save handoff token (0 = not in the handoff). */
  private handoff = 0
  /** The painted admission for the state's ONE main action (Confirm/Stage). */
  private paintedConfirm = false
  /** The semantic actions whose COMPLETE span this frame really painted
   *  (bar segment or body affordance). A dropped span is never admitted. */
  private paintedActions = new Set<BarAction>()
  /** The grouped browse's necessary dirty facts were painted this frame. */
  private paintedSaveFacts = false
  private riskSeen = new Set<number>()
  /** The reset confirmation's risk fragments projected by the LAST render. */
  private riskLines: readonly { readonly line: number }[] = []
  private riskSignature: string | undefined

  constructor(intents: HostNumericSettingsPageIntents<T>) {
    this.intents = intents
    this.controller = intents.controller
    this.fields = intents.fields
    this.title = intents.spec.title
    this.single = intents.spec.commitMode === 'single'
    this.entryIntent = this.single ? intents.entryIntent : undefined
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
    return snapshot.loading || snapshot.saving || snapshot.dirty
      || this.numberInput !== undefined || this.question !== undefined || this.advanced || this.handoff !== 0
  }

  /** PR-D admission: a pointer press may only arm against the frame THIS page
   *  really painted for the CURRENT state (a landed readback that has not
   *  repainted refuses the press instead of completing on newer cells). */
  pointerFrameCurrent(): boolean {
    return this.paint !== undefined && !this.awaitingPaint && this.paint.identity === this.gestureIdentity()
  }

  /**
   * The ONE consumer of a user parent navigation. `allow` releases the page
   * immediately (nothing was typed/pending); `refuse` keeps the page: either a
   * local input/disclosure/saving window owns the keys, or the page opened its
   * OWN question and will call `leave` only after the user really confirms.
   * Nothing here writes, refreshes or navigates by itself.
   */
  requestParentLeave(target: SpecialistParentLeaveTarget, leave: () => void): 'allow' | 'refuse' {
    if (this.disposed) return 'refuse'
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving || this.handoff !== 0) return 'refuse'
    if (this.numberInput !== undefined || this.advanced || this.question !== undefined) return 'refuse'
    if (snapshot.dirty) {
      this.openQuestion('parent-leave', leave)
      return 'refuse'
    }
    return 'allow'
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
      + `|${this.advanced ? 'adv' : ''}|${this.numberInput === undefined ? '' : 'input'}`
      + `|${this.question === undefined ? '' : `${this.question.kind}:${this.question.instance}`}`
      + `|${this.feedback ?? ''}|${this.fieldIndex}|${this.handoff === 0 ? '' : 'handoff'}`
  }
  private questionIdentity(): string | undefined {
    const snapshot = this.controller.snapshot()
    return this.question === undefined ? undefined
      : `${this.question.instance}:${this.question.kind}:${snapshot.revision}:${this.authorityIdentity(snapshot)}`
  }
  private revoke(): void {
    this.revision += 1
    this.awaitingPaint = true
    this.pressed = undefined
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
    this.paintedConfirm = false
    this.paintedActions.clear()
    this.paintedSaveFacts = false
  }
  private changed(): void { this.revoke(); this.intents.requestRender() }

  private editable(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    return !snapshot.loading && !snapshot.saving && snapshot.current && snapshot.source.kind === 'ready'
  }
  private canSave(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    return snapshot.dirty && !snapshot.saving && !snapshot.loading && snapshot.current && snapshot.source.kind === 'ready'
  }
  private openQuestion(kind: QuestionKind, leave?: () => void): void {
    this.question = { instance: ++this.nextQuestion, kind, ...(leave === undefined ? {} : { leave }) }
    this.formOffset = 0
    this.changed()
  }
  private keepEditing(): void { this.question = undefined; this.revealSelection = true; this.changed() }
  private ambiguous(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    const kind = snapshot.status?.kind
    return kind === 'unverified' || kind === 'outcome-unconfirmed'
  }
  private discard(): void {
    const question = this.question
    if (question === undefined || this.paintedQuestion !== this.questionIdentity()) return
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    // The accepting action must be a really painted span of THIS question: a
    // dropped segment is never admitted through its shortcut key.
    const accepting: BarAction = question.kind === 'refresh'
      ? 'refresh-confirm'
      : question.kind === 'discard' ? 'discard' : 'leave'
    if (!this.paintedActions.has(accepting)) return
    this.question = undefined
    if (question.kind === 'refresh') { this.controller.refresh(true); this.changed(); return }
    this.controller.discard()
    this.advanced = false
    this.feedback = undefined
    this.changed()
    if (question.kind === 'leave') this.intents.done()
    // The parent-leave continuation runs LAST: it may dispose this page.
    else if (question.kind === 'parent-leave') question.leave?.()
  }
  private back(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) { this.waitNotice = true; this.changed(); return }
    if (this.question !== undefined) { this.keepEditing(); return }
    if (this.handoff !== 0) return
    if (this.numberInput !== undefined) {
      this.numberInput = undefined
      this.fieldError = undefined
      this.changed()
      return
    }
    if (this.advanced) { this.advanced = false; this.changed(); return }
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
    const input = new Input({
      prompt: 'Value: ',
      placeholder: this.single ? 'positive integer' : 'positive finite number',
      placeholderStyle: color.textDim,
    })
    const current = this.controller.textOf(spec.key) ?? (snapshot.source.kind === 'ready' ? String(snapshot.source.effective[spec.key]) : '')
    input.setValue(current)
    input.focused = this.focused
    this.numberInput = { field, input }
    this.fieldError = undefined
    this.feedback = undefined
    this.formOffset = 0
    this.changed()
  }
  /** Grouped browse: a field row click/key only SELECTS the field. */
  private selectField(field: string): void {
    const index = this.fields.findIndex(item => item.key === field)
    if (index < 0 || index === this.fieldIndex) return
    this.fieldIndex = index
    this.revealSelection = true
    this.feedback = undefined
    this.changed()
  }

  // ── the shared stage / reset / save actions (both tenants) ───────────────

  /** The one-shot explicit entry the Root really took, consumed by the first
   *  settled read. A read that lands unavailable/stale stays on the truthful
   *  read-only Detail: the intent is spent, never replayed after a refresh. */
  private consumeEntry(): void {
    if (!this.single || this.entryIntent === undefined) return
    const snapshot = this.controller.snapshot()
    if (snapshot.loading) return
    const intent = this.entryIntent
    this.entryIntent = undefined
    if (!this.editable(snapshot)) return
    if (intent === 'change') this.beginSingleInput()
    else this.advanced = true
  }

  private beginSingleInput(): void {
    const field = this.fields[0]
    if (field === undefined || this.numberInput !== undefined) return
    this.activateField(field.key)
  }

  private openAdvanced(): void {
    if (this.numberInput !== undefined || this.question !== undefined) return
    this.advanced = true
    this.formOffset = 0
    this.changed()
  }

  /** The grouped browse's Up/Down clamp and Tab wrap stay local field moves. */
  private moveField(delta: number, wrap: boolean): void {
    const count = this.fields.length
    if (count === 0) return
    const raw = this.fieldIndex + delta
    const next = wrap ? (raw + count) % count : Math.min(Math.max(0, raw), count - 1)
    if (next === this.fieldIndex) return
    this.fieldIndex = next
    this.revealSelection = true
    this.feedback = undefined
    this.changed()
  }

  /**
   * The ONE local stage of the raw Input. It validates, commits the local
   * transition, stages the controller intent and RE-PROOFS the captured text
   * and source. The single mode continues into its same-stack save; the grouped
   * mode stops at the local patch (Save is a separate user action). A refused
   * stage restores the raw input with the REAL reason.
   */
  private stageInput(): void {
    const active = this.numberInput
    if (active === undefined || this.disposed || this.handoff !== 0) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) return
    if (!this.paintedConfirm) return
    const key = active.field as keyof T & string
    const raw = active.input.getValue()
    const issue = this.controller.numberIssue(key, raw)
    if (issue !== undefined) {
      this.fieldError = issue
      this.changed()
      return
    }
    if (!this.editable(snapshot)) {
      this.fieldError = 'Host settings changed or are unavailable; cancel and refresh.'
      this.changed()
      return
    }
    const captured = snapshot.source
    const handoff = ++this.handoff
    // Retire THIS editor's admission BEFORE the stage: the synchronous changed
    // callback can render, and that frame must not offer a second Confirm of the
    // same request. The text stays in the (now detached) Input so a refusal can
    // restore it.
    this.numberInput = undefined
    this.feedback = undefined
    try {
      this.controller.setNumber(key, raw)
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== handoff) return
      // The staged intent must still be EXACTLY what this gesture captured: the
      // same text, a set (never a Reset), and the still-current captured source.
      const stagedIntent = staged.texts[key] === raw
        && !staged.resetFields.includes(key)
        && staged.current
        && staged.source.kind === 'ready' && captured.kind === 'ready'
        && staged.source.revision === captured.revision
        && staged.source.generation === captured.generation
      if (staged.notice !== undefined || !stagedIntent) {
        // The stage was refused, or the captured source is no longer the one
        // that was staged: restore the gesture's own text with the REAL reason.
        this.numberInput = active
        this.fieldError = staged.notice ?? 'Host settings changed or are unavailable; cancel and refresh.'
        this.changed()
        return
      }
      this.advanced = false
      this.fieldError = undefined
      this.feedback = staged.dirty ? undefined : 'no-changes'
      this.revoke()
      if (!this.single) return
      if (!staged.dirty) return
      this.controller.save()
    } finally {
      if (!this.disposed && this.handoff === handoff) {
        this.handoff = 0
        this.intents.requestRender()
      }
    }
  }

  /**
   * The grouped Advanced's explicit Reset: stage the OFFICIAL unset of the
   * CURRENT field only. It never confirms, never saves and never invents a
   * second question. The captured field/source are re-proved before it returns
   * to the browse.
   */
  private stageGroupReset(): void {
    if (this.disposed || this.handoff !== 0 || this.numberInput !== undefined || this.question !== undefined) return
    if (!this.advanced || !this.paintedActions.has('reset')) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving || !this.editable(snapshot)) return
    const key = this.fields[this.fieldIndex]?.key
    if (key === undefined) return
    const captured = snapshot.source
    const handoff = ++this.handoff
    this.advanced = false
    this.feedback = undefined
    try {
      this.controller.reset(key)
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== handoff) return
      const stagedReset = staged.resetFields.includes(key) && staged.current
        && captured.kind === 'ready' && staged.source.kind === 'ready'
        && staged.source.revision === captured.revision
        && staged.source.generation === captured.generation
      if (staged.notice !== undefined || !stagedReset) {
        this.advanced = true
        this.fieldError = staged.notice ?? 'Host settings changed or are unavailable; cancel and refresh.'
        this.changed()
        return
      }
      this.fieldError = undefined
      this.revealSelection = true
      this.changed()
    } finally {
      if (!this.disposed && this.handoff === handoff) {
        this.handoff = 0
        this.intents.requestRender()
      }
    }
  }

  /** The grouped browse's ONE Save: the current, valid, non-pending patch is
   *  handed to the existing controller latch. It retires a dirty-leave question
   *  and its captured continuation BEFORE the latch can run a synchronous
   *  callback; after that the SAME group stays mounted. */
  private saveGroup(): void {
    if (this.disposed || this.handoff !== 0) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving || !this.canSave(snapshot)) return
    if (this.numberInput !== undefined || this.advanced) return
    const question = this.question
    if (question !== undefined) {
      if (question.kind !== 'leave' && question.kind !== 'parent-leave') return
      if (this.paintedQuestion !== this.questionIdentity()) return
    }
    if (!this.paintedActions.has('save')) return
    if (question === undefined && !this.paintedSaveFacts) return
    this.question = undefined
    this.feedback = undefined
    const handoff = ++this.handoff
    try {
      this.controller.save()
      if (this.disposed || this.handoff !== handoff) return
      this.revoke()
    } finally {
      if (!this.disposed && this.handoff === handoff) {
        this.handoff = 0
        this.intents.requestRender()
      }
    }
  }

  /** The reset confirmation's Confirm: the official `unset` intent, then the
   *  same ONE save. It only exists once the necessary risk copy was painted. */
  private confirmReset(): void {
    if (this.disposed || this.question === undefined || this.question.kind !== 'reset') return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) return
    // The keyboard Confirm needs BOTH receipts: the whole risk copy read AND the
    // complete Confirm span really painted in this frame (a dropped segment can
    // never be activated by a shortcut).
    if (!this.paintedConfirm) return
    if (!this.resetRiskRead()) return
    if (!this.editable(snapshot)) { this.changed(); return }
    const key = this.fields[0]?.key
    if (key === undefined) return
    this.question = undefined
    this.advanced = false
    this.feedback = undefined
    const handoff = ++this.handoff
    try {
      this.controller.reset(key)
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== handoff) return
      if (staged.notice !== undefined) { this.advanced = true; this.changed(); return }
      this.revoke()
      if (staged.dirty) this.controller.save()
    } finally {
      if (!this.disposed && this.handoff === handoff) {
        this.handoff = 0
        this.intents.requestRender()
      }
    }
  }

  /** Whether every necessary reset risk FRAGMENT was painted inside this
   *  question instance at THIS width/grant. A wrapped sentence contributes one
   *  entry per physical line, so seeing only its tail can never satisfy it. */
  private resetRiskRead(width: number = this.paint?.width ?? 0, risk: readonly { readonly line: number }[] = this.riskLines): boolean {
    if (this.question?.kind !== 'reset') return false
    if (this.riskSignature !== this.riskSignatureFor(width)) return false
    return risk.every(entry => this.riskSeen.has(entry.line))
  }
  private riskSignatureFor(width: number): string {
    return `${this.questionIdentity() ?? ''}|${width}|${this.rowGrant}`
  }

  handleInput(data: string): void {
    if (this.disposed) return
    // The stage->save handoff owns the page: a key delivered by a synchronous
    // callback inside it can never start a second stage, confirm or save.
    if (this.handoff !== 0) return
    // Every key retires a Root bar gesture and a body gesture. The painted
    // question receipt is independent: an explicit answer still proves it.
    this.revision += 1
    this.pressed = undefined
    const snapshot = this.controller.snapshot()
    if (matchesKey(data, 'escape')) { this.back(); return }
    if (snapshot.saving) return
    if (this.question !== undefined) { this.handleQuestionInput(data, snapshot); return }
    if (this.single) this.handleSingleInput(data, snapshot)
    else this.handleGroupInput(data, snapshot)
  }

  private handleQuestionInput(data: string, snapshot: HostNumericSettingsSnapshot<T>): void {
    const question = this.question!
    if (question.kind === 'reset') {
      if (matchesKey(data, 'enter')) this.confirmReset()
      else if (this.scrollKey(data)) this.scrollTenant(data)
      return
    }
    if (this.scrollKey(data)) { this.scrollTenant(data); return }
    if (question.kind === 'refresh') {
      if (matchesKey(data, KEYS.refresh) || matchesKey(data, 'enter')) this.discard()
      return
    }
    if (question.kind === 'discard') {
      if (data === KEYS.discard || data === KEYS.discard.toUpperCase()) this.discard()
      else if (matchesKey(data, 'left')) this.keepEditing()
      return
    }
    // leave / parent-leave
    if (data === KEYS.discard || data === KEYS.discard.toUpperCase()) { this.discard(); return }
    if (!this.single && matchesKey(data, KEYS.save)) { this.saveGroup(); return }
    if (!this.single && matchesKey(data, 'left')) this.keepEditing()
  }

  private handleSingleInput(data: string, snapshot: HostNumericSettingsSnapshot<T>): void {
    if (Math.max(0, this.rowGrant - 1) < 1) {
      // A bar-only grant paints ONLY the page's own Back: no body action exists,
      // so no key may start an Input, a disclosure or an official refresh.
      if (matchesKey(data, 'left')) this.back()
      return
    }
    const active = this.numberInput
    if (active !== undefined) {
      if (matchesKey(data, 'enter')) { this.stageInput(); return }
      active.input.handleInput(data)
      this.fieldError = undefined
      this.changed()
      return
    }
    if (this.advanced) {
      if (this.scrollKey(data)) { this.scrollTenant(data); return }
      // `?` and Left close the disclosure exactly like Esc (its own Back).
      if (data === DETAILS_KEY || matchesKey(data, 'left')) { this.back(); return }
      if (matchesKey(data, KEYS.reset) && this.editable(snapshot)) { this.openQuestion('reset'); return }
      if (matchesKey(data, KEYS.refresh)) { this.refresh(); return }
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      if (this.editable(snapshot)) this.beginSingleInput()
      return
    }
    if (matchesKey(data, 'left')) { this.back(); return }
    if (data === DETAILS_KEY) { this.openAdvanced(); return }
    if (matchesKey(data, KEYS.refresh)) { this.refresh(); return }
    if (this.scrollKey(data)) this.scrollTenant(data)
  }

  private handleGroupInput(data: string, snapshot: HostNumericSettingsSnapshot<T>): void {
    if (Math.max(0, this.rowGrant - 1) < 1) {
      // A body-less grant paints only the page's own Back/Keep/Cancel/Wait: no
      // field, stage, save, disclosure or refresh may start from a hidden body.
      if (matchesKey(data, 'left')) this.back()
      return
    }
    const active = this.numberInput
    if (active !== undefined) {
      if (matchesKey(data, 'enter')) { this.stageInput(); return }
      active.input.handleInput(data)
      this.fieldError = undefined
      this.changed()
      return
    }
    if (this.advanced) {
      if (this.scrollKey(data)) { this.scrollTenant(data); return }
      // `?` and Left close the disclosure exactly like Esc (its own Back).
      if (data === DETAILS_KEY || matchesKey(data, 'left')) { this.back(); return }
      if (matchesKey(data, KEYS.reset) && this.editable(snapshot)) { this.stageGroupReset(); return }
      if (matchesKey(data, KEYS.refresh)) { this.refresh(); return }
      return
    }
    if (matchesKey(data, 'up')) { this.moveField(-1, false); return }
    if (matchesKey(data, 'down')) { this.moveField(1, false); return }
    if (matchesKey(data, 'tab')) { this.moveField(1, true); return }
    if (matchesKey(data, 'shift+tab')) { this.moveField(-1, true); return }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      if (this.editable(snapshot)) this.activateField(this.fields[this.fieldIndex]!.key)
      return
    }
    if (matchesKey(data, 'left')) { this.back(); return }
    if (data === DETAILS_KEY) { this.openAdvanced(); return }
    if (matchesKey(data, KEYS.save)) { this.saveGroup(); return }
    if (matchesKey(data, KEYS.discard) && snapshot.dirty && !this.ambiguous(snapshot)) { this.openQuestion('discard'); return }
    if (matchesKey(data, KEYS.refresh)) { this.refresh(); return }
    if (this.scrollKey(data)) this.scrollTenant(data)
  }

  private scrollKey(data: string): boolean {
    return matchesKey(data, 'up') || matchesKey(data, 'down')
      || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
      || matchesKey(data, 'home') || matchesKey(data, 'end')
  }
  private scrollTenant(data: string): void {
    const step = matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
      ? Math.max(1, this.rowGrant - 4)
      : 1
    const max = this.paint?.maxOffset ?? 0
    const delta = matchesKey(data, 'up') || matchesKey(data, 'pageUp') ? -step
      : matchesKey(data, 'home') ? -Number.MAX_SAFE_INTEGER
        : matchesKey(data, 'end') ? Number.MAX_SAFE_INTEGER
          : step
    this.formOffset = Math.min(Math.max(0, this.formOffset + delta), max)
    this.changed()
  }

  activateBarSpan(id: string): void {
    if (this.disposed || this.awaitingPaint || this.paint?.identity !== this.gestureIdentity()) return
    const span = this.barSpans.find(span => span.id === id)
    if (span === undefined) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) return
    switch (span.action) {
      case 'save': this.saveGroup(); break
      case 'refresh': this.refresh(); break
      case 'discard':
        if (this.question !== undefined) this.discard()
        else if (this.single) this.openQuestion('leave')
        else this.openQuestion('discard')
        break
      case 'keep': this.keepEditing(); break
      case 'apply': this.stageInput(); break
      case 'reset':
        // Single mode NEVER stages a reset from a key/pointer: the Advanced
        // action only OPENS the guarded confirmation. The grouped mode stages
        // the official unset of the CURRENT field directly, zero writes.
        if (this.single) this.openQuestion('reset')
        else this.stageGroupReset()
        break
      case 'change': if (this.editable(snapshot)) this.beginSingleInput(); break
      case 'edit': if (this.editable(snapshot)) this.activateField(this.fields[this.fieldIndex]!.key); break
      case 'details': this.openAdvanced(); break
      case 'reset-confirm': this.confirmReset(); break
      case 'leave': this.discard(); break
      case 'refresh-confirm': this.discard(); break
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
      if (event.y < paint.scrollStart || event.y >= paint.scrollEnd || this.numberInput !== undefined || !event.wheelDelta) return undefined
      // The tenant's OWN body scrolls under the wheel, including a scrollable
      // confirmation whose necessary copy must be painted before its action is
      // admitted (a mouse-only user must be able to reach it).
      this.scrollTenant(event.wheelDelta < 0 ? 'up' : 'down')
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
      case 'field':
        // Agent: the ONE field; a body click opens its Input (single mode).
        // Shell group: a field row only SELECTS it, never opens the editor.
        if (this.numberInput !== undefined) break
        if (this.single) this.activateField(target.action.field)
        else this.selectField(target.action.field)
        break
      case 'reset':
        if (this.numberInput === undefined) {
          if (this.single) this.openQuestion('reset')
          else this.stageGroupReset()
        }
        break
      case 'input': this.numberInput?.input.handleMouse({ ...event, type: 'press', y: 0, height: 1 }); this.changed(); break
      case 'details': this.openAdvanced(); break
      case 'edit': if (this.editable(this.controller.snapshot())) this.activateField(this.fields[this.fieldIndex]!.key); break
      case 'refresh': this.refresh(); break
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    return this.renderTenant(width, this.controller.snapshot())
  }

  // ── ONE numeric tenant projection (SUX-01 single / SUX-02 grouped) ───────

  private renderTenant(width: number, snapshot: HostNumericSettingsSnapshot<T>): string[] {
    this.consumeEntry()
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const lines: string[] = []
    const targets: Target[] = []
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
    this.paintedConfirm = false
    this.paintedActions.clear()
    this.paintedSaveFacts = false
    let content: ContentLine[]
    let mustSee: readonly number[] = []
    let risk: readonly { readonly line: number; readonly statement: number }[] = []
    let saveFacts: { readonly count?: number; readonly dirty: readonly (readonly number[])[] } = { dirty: [] }
    if (this.question !== undefined) {
      const question = this.questionLines(width, snapshot)
      content = question.lines
      mustSee = question.mustSee
      risk = question.risk
    } else if (this.numberInput !== undefined) {
      const built = this.inputLines(width, snapshot)
      content = built.lines
      mustSee = built.critical
    } else if (this.advanced) {
      content = this.single ? this.singleAdvancedLines(width, snapshot) : this.groupAdvancedLines(width, snapshot)
    } else if (this.single) {
      content = this.singleCleanLines(width, snapshot)
    } else {
      const browse = this.groupBrowseLines(width, snapshot)
      content = browse.lines
      saveFacts = browse.saveFacts
    }
    const maxOffset = Math.max(0, content.length - bodyRows)
    let offset = Math.min(Math.max(0, this.formOffset), maxOffset)
    if (!this.single) {
      // Reveal the SELECTED field's whole span (its value line and Current line)
      // against the REAL content rows; the Top/End jump never calls this.
      const span = this.selectedFieldSpan(content)
      if (this.revealSelection && span !== undefined && bodyRows > 0) {
        if (span.start < offset) offset = span.start
        if (span.end > offset + bodyRows) offset = Math.max(span.start, span.end - bodyRows)
        offset = Math.min(Math.max(0, offset), maxOffset)
      }
      this.revealSelection = false
    }
    this.formOffset = offset
    const visible = new Set<number>()
    for (let index = 0; index < bodyRows; index += 1) {
      const line = content[offset + index]
      lines.push(fit(line?.text ?? '', width))
      visible.add(offset + index)
      for (const target of line?.targets ?? []) {
        targets.push({ ...target, row: index })
        const action = bodyActionOf(target.action.kind)
        if (action !== undefined) this.paintedActions.add(action)
      }
    }
    // A confirmation's necessary facts are admitted only after they were really
    // PAINTED inside this question instance, width and grant: the leave/refresh
    // questions must fit whole, while the reset confirmation accumulates a
    // READ receipt because its risk copy is legitimately scrollable on a short
    // frame.
    if (this.question?.kind === 'reset') {
      const signature = this.riskSignatureFor(width)
      if (this.riskSignature !== signature) {
        this.riskSignature = signature
        this.riskSeen.clear()
      }
      // One entry per PHYSICAL fragment: a wrapped sentence only becomes
      // satisfied once every fragment was really painted, so jumping to the
      // tail can never prove the whole copy was read.
      this.riskLines = risk
      for (const lineIndex of visible) this.riskSeen.add(lineIndex)
    } else {
      this.riskLines = []
    }
    const complete = this.question?.kind === 'reset'
      ? this.resetRiskRead(width, risk)
      : mustSee.every(lineIndex => visible.has(lineIndex))
    if (this.question !== undefined && complete) this.paintedQuestion = this.questionIdentity()
    // The grouped Save needs a REAL staged fact on screen, not only its bar
    // span: the dirty count, or at least one complete staged field block.
    this.paintedSaveFacts = (saveFacts.count !== undefined && visible.has(saveFacts.count))
      || saveFacts.dirty.some(block => block.length > 0 && block.every(lineIndex => visible.has(lineIndex)))
    while (lines.length < bodyRows) lines.push(fit('', width))
    lines.push(this.renderTenantBar(snapshot, width, complete, maxOffset > 0))
    this.awaitingPaint = false
    this.paint = { width, rows: this.rowGrant, identity: this.gestureIdentity(), targets, maxOffset, scrollStart: 0, scrollEnd: bodyRows }
    return lines
  }

  private selectedFieldSpan(content: readonly ContentLine[]): { readonly start: number; readonly end: number } | undefined {
    const key = this.fields[this.fieldIndex]?.key
    if (key === undefined) return undefined
    let start = -1
    let end = -1
    content.forEach((line, index) => {
      if (line.field !== key) return
      if (start < 0) start = index
      end = index + 1
    })
    return start < 0 ? undefined : { start, end }
  }

  private row(label: string, value: string, ink: (text: string) => string = color.text, pad = 0): string {
    const head = color.textDim(label) + ' '.repeat(Math.max(2, pad - visibleWidth(label)))
    return head + ink(sanitizedPhysicalLine(value))
  }
  private note(text: string, width: number, tone: (text: string) => string = color.textDim): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(line => ({ text: tone(line) }))
  }
  private bodyAction(label: string, action: 'edit' | 'details' | 'refresh', width: number): ContentLine {
    if (visibleWidth(label) > width) return { text: color.primary(label) }
    return { text: color.primary(label), targets: [{ id: action, action: { kind: action }, startCol: 0, endCol: visibleWidth(label) }] }
  }
  private unitSuffix(field: HostNumericSettingsField<T>): string {
    return field.unit === undefined ? '' : ` ${field.unit}`
  }
  private fieldValue(snapshot: HostNumericSettingsSnapshot<T>, field: HostNumericSettingsField<T>): string {
    return snapshot.source.kind === 'ready' ? String(snapshot.source.effective[field.key]) : 'Unknown'
  }
  private fieldInherited(snapshot: HostNumericSettingsSnapshot<T>, field: HostNumericSettingsField<T>): string {
    return snapshot.source.kind === 'ready' ? String(snapshot.source.inherited[field.key]) : 'Unknown'
  }
  private fieldComparison(snapshot: HostNumericSettingsSnapshot<T>, field: HostNumericSettingsField<T>): string {
    if (snapshot.source.kind !== 'ready') return 'Unknown'
    return snapshot.source.overridden[field.key] === true ? 'Differs from base' : 'Matches base'
  }
  private fieldRequested(snapshot: HostNumericSettingsSnapshot<T>, field: HostNumericSettingsField<T>): string | undefined {
    if (snapshot.resetFields.includes(field.key)) return 'official unset'
    const text = snapshot.texts[field.key]
    return text === undefined || text.trim() === '' ? undefined : String(Number(text))
  }
  private singleField(): HostNumericSettingsField<T> { return this.fields[0]! }
  private singleValue(snapshot: HostNumericSettingsSnapshot<T>): string {
    return this.fieldValue(snapshot, this.singleField())
  }
  private singleInherited(snapshot: HostNumericSettingsSnapshot<T>): string {
    return this.fieldInherited(snapshot, this.singleField())
  }
  private singleComparison(snapshot: HostNumericSettingsSnapshot<T>): string {
    return this.fieldComparison(snapshot, this.singleField())
  }
  private singleRequested(snapshot: HostNumericSettingsSnapshot<T>): string | undefined {
    return this.fieldRequested(snapshot, this.singleField())
  }

  private singleCleanLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): ContentLine[] {
    const lines: ContentLine[] = []
    if (snapshot.loading) {
      lines.push({ text: color.textDim('Loading Host settings…') })
      return lines
    }
    lines.push({ text: this.row('Current value', this.singleValue(snapshot)) })
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, width))
    const status = snapshot.status
    if (status !== undefined) {
      lines.push({ text: this.row('Status', statusWord(status.kind, snapshot), word => statusInk(status.kind, word)) })
      if (status.kind !== 'verified') lines.push(...this.note(status.text, width, color.textDim))
    } else if (this.feedback === 'no-changes') {
      lines.push({ text: this.row('Status', 'No changes', color.textDim) })
    }
    if (snapshot.dirty) {
      const requested = this.singleRequested(snapshot)
      if (requested !== undefined) lines.push({ text: this.row('Requested', requested, color.text) })
    }
    if (snapshot.source.kind !== 'ready') {
      lines.push(...this.note(snapshot.source.reason, width, color.error))
    } else if (!snapshot.current) {
      lines.push(...this.note('Last-known · the Host has newer state; refresh to review.', width))
    }
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, width, color.error))
    // The ONE body affordance of the clean state (Role 14).
    if (this.editable(snapshot)) lines.push({ text: color.primary('Details…'), targets: [{ id: 'details', action: { kind: 'details' }, startCol: 0, endCol: visibleWidth('Details…') }] })
    return lines
  }

  /** The grouped browse: one row per field (label + its real candidate), the
   *  served Current for a staged field, the dirty count and the authority
   *  notes. Every field row SELECTS only; the editor needs its explicit Edit. */
  private groupBrowseLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): {
    lines: ContentLine[]
    saveFacts: { readonly count?: number; readonly dirty: readonly (readonly number[])[] }
  } {
    const lines: ContentLine[] = []
    const dirtyBlocks: number[][] = []
    let countLine: number | undefined
    const source = snapshot.source
    const editable = this.editable(snapshot)
    if (snapshot.loading) {
      lines.push({ text: color.textDim('Loading Host settings…') })
      return { lines, saveFacts: { dirty: dirtyBlocks } }
    }
    const rowWidth = Math.min(width, 64)
    const copyWidth = Math.min(width, 72)
    lines.push(...this.note(this.intents.spec.sourceHeading(source), copyWidth))
    for (const [index, field] of this.fields.entries()) {
      const selected = index === this.fieldIndex
      const staged = snapshot.dirtyFields.includes(field.key)
      const reset = snapshot.resetFields.includes(field.key)
      const unit = this.unitSuffix(field)
      const raw = snapshot.texts[field.key]
      // The browse paints the CANONICAL value of a legal draft (1e3 -> 1000),
      // and the raw text only while it is still refused by the validator.
      const candidate = raw !== undefined && this.controller.numberIssue(field.key, raw) === undefined
        ? String(Number(raw))
        : raw
      const value = source.kind !== 'ready'
        ? 'Unknown'
        : reset ? 'Reset staged'
          : `${candidate ?? String(source.effective[field.key])}${unit}`
      const blockStart = lines.length
      const marker = selected ? '> ' : '  '
      const paintedLabel = selected ? color.textStrong(sanitizedPhysicalLine(field.label)) : color.text(sanitizedPhysicalLine(field.label))
      const targets: BodyTarget[] = [{
        id: `field:${field.key}`,
        action: { kind: 'field', field: field.key },
        startCol: 0,
        endCol: width,
      }]
      const inline = visibleWidth(marker) + visibleWidth(field.label) + 2 + visibleWidth(value) <= rowWidth
      if (inline) {
        const gap = Math.max(2, rowWidth - visibleWidth(marker) - visibleWidth(field.label) - visibleWidth(value))
        lines.push({ text: `${marker}${paintedLabel}${' '.repeat(gap)}${color.text(sanitizedPhysicalLine(value))}`, field: field.key, targets })
      } else {
        // A label and its canonical value that cannot share ONE line keep the
        // complete label and the value on two lines instead of a fake column.
        lines.push({ text: `${marker}${paintedLabel}`, field: field.key, targets })
        lines.push({ text: `  ${color.text(sanitizedPhysicalLine(value))}`, field: field.key })
      }
      if (staged) {
        lines.push({ text: color.textDim(`  Current: ${this.fieldValue(snapshot, field)}${unit} · Unsaved`), field: field.key })
      }
      if (staged) dirtyBlocks.push(lines.slice(blockStart).map((_, offset) => blockStart + offset))
    }
    if (snapshot.dirty) {
      const count = snapshot.dirtyFields.length
      countLine = lines.length
      lines.push({ text: color.text(`${count} unsaved change${count === 1 ? '' : 's'} · ${this.title}`) })
    }
    lines.push(...this.note('Changes are staged until Save.', copyWidth))
    // State and reason come BEFORE the explanatory prose: on a short grant the
    // truth about the draft/write must not scroll away behind help text.
    const status = snapshot.status
    if (status !== undefined) {
      lines.push({ text: this.row('Status', statusWord(status.kind, snapshot), word => statusInk(status.kind, word)) })
      if (status.kind !== 'verified' && status.kind !== 'saving') {
        lines.push(...this.note(status.text, copyWidth, color.textDim))
      }
    } else if (this.feedback === 'no-changes') {
      lines.push({ text: this.row('Status', 'No changes', color.textDim) })
    }
    if (source.kind !== 'ready') lines.push(...this.note(source.reason, copyWidth, color.error))
    else if (!snapshot.current) lines.push(...this.note('Last-known · the Host has newer state; refresh to review.', copyWidth))
    if (this.waitNotice && snapshot.saving) lines.push(...this.note('Dispatched writes continue.', copyWidth))
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, copyWidth, color.error))
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, copyWidth))
    for (const help of this.intents.spec.help) lines.push(...this.note(help, copyWidth))
    if (editable) {
      lines.push(this.bodyAction('Edit…', 'edit', width))
      lines.push(this.bodyAction('Details…', 'details', width))
      lines.push(this.bodyAction('Refresh…', 'refresh', width))
    }
    return {
      lines,
      saveFacts: { ...(countLine === undefined ? {} : { count: countLine }), dirty: dirtyBlocks },
    }
  }

  private inputLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): { lines: ContentLine[]; critical: readonly number[] } {
    const lines: ContentLine[] = []
    const active = this.numberInput!
    const field = this.fields.find(candidate => candidate.key === active.field)!
    const unit = this.unitSuffix(field)
    const copyWidth = this.single ? width : Math.min(width, 72)
    if (!this.single) lines.push({ text: color.textDim(`Edit ${sanitizedPhysicalLine(field.label)}`) })
    lines.push({ text: this.row('Current value', `${this.fieldValue(snapshot, field)}${unit}`) })
    const inputRow = lines.length
    lines.push({ text: active.input.render(width)[0] ?? '', targets: [{ id: 'input', action: { kind: 'input' }, startCol: 0, endCol: width }] })
    const critical = [inputRow]
    const raw = active.input.getValue()
    if (raw.trim() !== '') {
      const canonical = this.controller.numberIssue(active.field as keyof T & string, raw) === undefined ? String(Number(raw)) : undefined
      if (canonical !== undefined && canonical !== raw.trim()) {
        critical.push(lines.length)
        lines.push({ text: this.row('Value sends', `${canonical}${unit}`, color.text) })
      }
    }
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, copyWidth))
    if (this.single && this.intents.spec.dispatched !== undefined) lines.push(...this.note(this.intents.spec.dispatched, copyWidth))
    return { lines, critical }
  }

  private singleAdvancedLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): ContentLine[] {
    const lines: ContentLine[] = []
    const pad = 14
    lines.push({ text: this.row('Effective', this.singleValue(snapshot), color.text, pad) })
    lines.push({ text: this.row('Inherited', this.singleInherited(snapshot), color.textDim, pad) })
    lines.push({ text: this.row('Comparison', this.singleComparison(snapshot), color.textDim, pad) })
    if (snapshot.source.kind === 'ready') lines.push({ text: this.row('Revision', String(snapshot.source.revision), color.textDim, pad) })
    if (this.intents.spec.scope !== undefined) lines.push({ text: this.row('Scope', this.intents.spec.scope, color.textDim, pad) })
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, width))
    lines.push(...this.note(RESET_RISK[0], width))
    lines.push(...this.note(RESET_RISK[1], width))
    if (this.editable(snapshot)) {
      lines.push({
        text: color.primary('Reset to inherited…'),
        targets: [{ id: 'reset-field', action: { kind: 'reset', field: this.fields[0]!.key }, startCol: 0, endCol: visibleWidth('Reset to inherited…') }],
      })
    } else if (snapshot.source.kind !== 'ready') {
      lines.push(...this.note(snapshot.source.reason, width, color.error))
    } else {
      lines.push(...this.note('Last-known · the Host has newer state; refresh to review.', width))
    }
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, width, color.error))
    return lines
  }

  /** The grouped Advanced disclosure of the SELECTED field: its served facts,
   *  the Host row identity and the ONE explicit reset-staging action. */
  private groupAdvancedLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): ContentLine[] {
    const field = this.fields[this.fieldIndex]!
    const source = snapshot.source
    const lines: ContentLine[] = []
    const unit = this.unitSuffix(field)
    const pad = 12
    const rowWidth = Math.min(width, 64)
    const copyWidth = Math.min(width, 72)
    lines.push(...this.note(this.intents.spec.sourceHeading(source), copyWidth))
    lines.push({ text: color.textStrong(sanitizedPhysicalLine(field.label)) })
    lines.push({ text: this.row('Effective', `${this.fieldValue(snapshot, field)}${unit}`, color.text, pad) })
    lines.push({ text: this.row('Inherited', `${this.fieldInherited(snapshot, field)}${unit}`, color.textDim, pad) })
    lines.push({ text: this.row('Comparison', this.fieldComparison(snapshot, field), color.textDim, pad) })
    if (source.kind === 'ready') lines.push({ text: this.row('Revision', String(source.revision), color.textDim, pad) })
    if (this.intents.spec.scope !== undefined) lines.push({ text: this.row('Scope', this.intents.spec.scope, color.textDim, pad) })
    if (snapshot.dirtyFields.includes(field.key)) {
      const requested = this.fieldRequested(snapshot, field)
      if (requested !== undefined) lines.push({ text: this.row('Staged', `${requested}${requested === 'official unset' ? '' : unit}`, color.text, pad) })
    }
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, copyWidth))
    lines.push(...this.note('Changes are staged until Save.', copyWidth))
    lines.push(...this.note('Reset stages the official unset.', copyWidth))
    lines.push(...this.note('The USER patch may retain the inherited value.', copyWidth))
    lines.push(...this.note('The Host readback decides the value.', copyWidth))
    if (this.editable(snapshot) && visibleWidth('Reset to inherited…') <= rowWidth) {
      lines.push({
        text: color.primary('Reset to inherited…'),
        targets: [{ id: `reset:${field.key}`, action: { kind: 'reset', field: field.key }, startCol: 0, endCol: visibleWidth('Reset to inherited…') }],
      })
    } else if (source.kind !== 'ready') {
      lines.push(...this.note(source.reason, copyWidth, color.error))
    } else if (!snapshot.current) {
      lines.push(...this.note('Last-known · the Host has newer state; refresh to review.', copyWidth))
    }
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, copyWidth, color.error))
    return lines
  }

  private questionLines(
    width: number,
    snapshot: HostNumericSettingsSnapshot<T>,
  ): { lines: ContentLine[]; mustSee: readonly number[]; risk: readonly { readonly line: number; readonly statement: number }[] } {
    const question = this.question!
    if (question.kind === 'reset') {
      const lines: ContentLine[] = []
      lines.push({ text: this.row('Current', this.singleValue(snapshot), color.text) })
      lines.push({ text: this.row('Inherited', this.singleInherited(snapshot), color.textDim) })
      // Every PHYSICAL wrapped line of a statement carries its statement index:
      // reading the wrapped fragments of the first two statements can never
      // satisfy the third one.
      const risk: { line: number; statement: number }[] = []
      RESET_RISK.forEach((statement, index) => {
        for (const wrapped of this.note(statement, width)) {
          risk.push({ line: lines.length, statement: index })
          lines.push(wrapped)
        }
      })
      return { lines, mustSee: [], risk }
    }
    const lines: ContentLine[] = []
    const mustSee: number[] = []
    let facts: readonly string[]
    if (this.single) {
      facts = question.kind === 'refresh'
        ? REFRESH_QUESTION
        : this.ambiguous(snapshot) ? AMBIGUOUS_LEAVE : DEFINITE_LEAVE
    } else if (question.kind === 'refresh') {
      facts = this.ambiguous(snapshot) ? [...GROUP_REFRESH, ...AMBIGUOUS_LEAVE] : GROUP_REFRESH
    } else if (question.kind === 'discard') {
      facts = GROUP_DISCARD
    } else {
      const count = snapshot.dirtyFields.length
      facts = this.ambiguous(snapshot)
        ? [`${count} unsaved change${count === 1 ? '' : 's'} · ${this.title}`, ...AMBIGUOUS_LEAVE]
        : [`${count} unsaved change${count === 1 ? '' : 's'} · ${this.title}`, 'Save keeps you here.', 'Discard and leave loses staged values.']
    }
    const copyWidth = this.single ? width : Math.min(width, 72)
    for (const fact of facts) {
      for (const wrapped of this.note(fact, copyWidth, color.warning)) {
        mustSee.push(lines.length)
        lines.push(wrapped)
      }
    }
    if (this.single) {
      const requested = this.singleRequested(snapshot)
      if (requested !== undefined) lines.push({ text: this.row('Requested', requested, color.text) })
    }
    return { lines, mustSee, risk: [] }
  }

  private renderTenantBar(snapshot: HostNumericSettingsSnapshot<T>, width: number, complete: boolean, scrollable: boolean): string {
    const bodyRows = Math.max(0, this.rowGrant - 1)
    let segments: BarSegment[]
    if (snapshot.saving) {
      segments = [{ text: 'Saving…', priority: 900 }, { text: 'Wait [Esc]', priority: 1000, escape: true }]
    } else if (bodyRows < 1) {
      segments = [{
        text: this.question !== undefined ? 'Keep [Esc]'
          : this.numberInput !== undefined ? 'Cancel [Esc]' : 'Back [Esc]',
        priority: 1000,
        escape: true,
      }]
    } else if (this.question !== undefined) {
      const question = this.question
      const painted = this.paintedQuestion === this.questionIdentity()
      if (question.kind === 'reset') {
        this.paintedConfirm = painted
        segments = [
          ...(painted ? [{ text: 'Confirm [Enter]', priority: 900, action: 'reset-confirm' as const }] : []),
          { text: 'Cancel [Esc]', priority: 1000, escape: true },
        ]
      } else if (question.kind === 'refresh') {
        segments = [
          ...(painted ? [{ text: 'Refresh [R]', priority: 900, action: 'refresh-confirm' as const }] : []),
          { text: 'Keep [Esc]', priority: 1000, escape: true },
        ]
      } else if (question.kind === 'discard') {
        segments = [
          ...(painted ? [{ text: 'Discard [D]', priority: 900, action: 'discard' as const }] : []),
          { text: 'Keep [Esc]', priority: 1000, escape: true },
        ]
      } else {
        const word = this.ambiguous(snapshot) ? 'Leave anyway [D]' : 'Discard and leave [D]'
        segments = [
          ...(this.single ? [] : this.canSave(snapshot) ? [{ text: `Save [${KEYS.save.toUpperCase()}]`, priority: 950, action: 'save' as const }] : []),
          ...(painted ? [{ text: word, ...(this.single ? {} : { short: 'Discard [D]' }), priority: 900, action: 'leave' as const }] : []),
          { text: 'Keep [Esc]', priority: 1000, escape: true },
        ]
      }
    } else if (this.numberInput !== undefined) {
      this.paintedConfirm = complete
      segments = [
        ...(this.paintedConfirm ? [{ text: this.single ? 'Confirm [Enter]' : 'Stage [Enter]', priority: 900, action: 'apply' as const }] : []),
        { text: 'Cancel [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.advanced) {
      segments = [
        ...(this.editable(snapshot) ? [{ text: 'Reset [X]', priority: 900, action: 'reset' as const }] : []),
        ...(scrollable ? [{ text: 'Up/Down scroll', priority: 400 }] : []),
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.single) {
      if (this.editable(snapshot)) {
        segments = [
          { text: 'Change [Enter]', priority: 900, action: 'change' },
          { text: 'Details [?]', priority: 850, action: 'details' },
          { text: 'Back [Esc]', priority: 1000, escape: true },
        ]
      } else {
        segments = [
          ...(!snapshot.loading ? [{ text: 'Refresh [R]', priority: 800, action: 'refresh' as const }] : []),
          { text: 'Back [Esc]', priority: 1000, escape: true },
        ]
      }
    } else if (snapshot.dirty && this.canSave(snapshot)) {
      // Grouped dirty browse: Save is the main action; the secondary routes
      // drop WHOLE, and the body keeps Edit…/Details…/Refresh… reachable.
      segments = [
        { text: `Save [${KEYS.save.toUpperCase()}]`, priority: 900, action: 'save' },
        { text: 'Edit [Enter]', priority: 800, action: 'edit' },
        { text: 'Details [?]', short: 'Details', priority: 700, action: 'details' },
        { text: `Discard [${KEYS.discard.toUpperCase()}]`, short: 'Discard', priority: 600, action: 'discard' },
        { text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 500, action: 'refresh' },
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.editable(snapshot)) {
      segments = [
        { text: 'Edit [Enter]', priority: 800, action: 'edit' },
        { text: 'Details [?]', short: 'Details', priority: 700, action: 'details' },
        { text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 500, action: 'refresh' },
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else {
      segments = [
        ...(!snapshot.loading ? [{ text: 'Refresh [R]', priority: 800, action: 'refresh' as const }] : []),
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    }
    const layout = layoutActionBarRow(segments, width)
    if (layout.truncated) {
      // Not even one segment fits WHOLE: the row is an inert truncated hint, so
      // no action (least of all a main Confirm) may stay keyboard-admitted.
      this.paintedConfirm = false
      this.paintedActions.clear()
      this.barSpans = []
      return fit(color.textMuted(layout.text), width)
    }
    const painted: string[] = []
    const spans: { id: string; action: BarAction; startCol: number; endCol: number }[] = []
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]!
      painted.push(segment.action === undefined && !segment.escape ? color.textMuted(span.text)
        : paintActionSpan(span.text, segment.action === 'change' || segment.action === 'edit' || segment.action === 'apply'
          || segment.action === 'reset-confirm' || segment.action === 'refresh-confirm' || segment.action === 'leave'
          ? 'primary' : 'secondary'))
      if (segment.escape) this.escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else if (segment.action !== undefined) {
        spans.push({ id: `bar:${segment.action}`, action: segment.action, startCol: span.startCol, endCol: span.endCol })
        this.paintedActions.add(segment.action)
      }
    }
    this.barSpans = spans
    // A dropped Confirm publishes neither a span nor the keyboard admission.
    if (!spans.some(span => span.action === 'apply' || span.action === 'reset-confirm')) this.paintedConfirm = false
    return fit(painted.join(ACTION_BAR_SEPARATOR), width)
  }

  invalidate(): void { this.numberInput?.input.invalidate() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revoke()
    this.paint = undefined
    this.numberInput = undefined
    this.question = undefined
    this.controller.dispose()
  }
}
