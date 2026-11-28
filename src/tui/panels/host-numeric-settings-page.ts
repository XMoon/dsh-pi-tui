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
import { formatShellSettingValue } from '../presentation/settings-values.ts'
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
    | { readonly kind: 'discard' }
    | { readonly kind: 'accept' }
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
/** The ONE recovery line of an accepted-but-unattributable write. */
const MAY_HAVE_BEEN_SAVED = 'The change may have been saved. Refresh and check.'

function fit(text: string, width: number): string {
  const line = truncateToWidth(text, Math.max(0, width), '…', false)
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}

function statusWord<T extends object>(kind: string | undefined, snapshot: HostNumericSettingsSnapshot<T>): string {
  switch (kind) {
    case 'verified': return snapshot.current ? 'Saved' : 'Last-known · read-only'
    case 'not-saved': return 'Could not save'
    case 'unverified':
    case 'outcome-unconfirmed': return 'Could not confirm save'
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
function bodyActionOf(kind: 'field' | 'reset' | 'input' | 'details' | 'edit' | 'refresh' | 'discard' | 'accept'): BarAction | undefined {
  switch (kind) {
    case 'reset': return 'reset'
    case 'details': return 'details'
    case 'edit': return 'edit'
    case 'refresh': return 'refresh'
    case 'discard': return 'discard'
    // The question's ONE accept target is registered separately once its
    // necessary copy is really complete.
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
  /** The grouped Advanced's necessary facts that were really painted in THIS
   *  disclosure instance (field identity + staging/unset copy). A width, field
   *  or authority change invalidates the receipt. */
  private advancedSeen = new Set<number>()
  private advancedSignature: string | undefined
  private advancedFactLines: readonly number[] = []
  /** The grouped Reset is published only once its own receipt holds. */
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
    return !snapshot.loading && !snapshot.saving && !snapshot.refreshRequired
      && snapshot.current && snapshot.source.kind === 'ready'
  }
  private canSave(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    return snapshot.dirty && this.editable(snapshot)
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
      // The staged field (and its Current) is the fact that must stay in view;
      // at a short grant the reveal is what publishes the dirty receipt.
      if (!this.single) { this.revealSelection = true; this.formOffset = 0 }
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
    // The selected identity and the staging/unset explanation must have been
    // really painted in THIS disclosure instance; a bare shortcut is not proof.
    if (this.advancedFactLines.length === 0 || !this.advancedFactLines.every(line => this.advancedSeen.has(line))) return
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
    // The settlement confirmation is the priority after a dispatch: show the
    // status/heading from the top instead of keeping a field reveal.
    this.formOffset = 0
    this.revealSelection = false
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
    if (data === DETAILS_KEY) {
      if (this.editable(snapshot)) this.openAdvanced()
      return
    }
    if (matchesKey(data, KEYS.save)) { this.saveGroup(); return }
    if (matchesKey(data, KEYS.discard) && snapshot.dirty && !this.ambiguous(snapshot)
      && this.paintedActions.has('discard')) { this.openQuestion('discard'); return }
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
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) return
    if (this.question !== undefined) {
      // ONLY the current question's explicitly painted accept target answers;
      // no background field/bar/row action is reachable from a question body.
      if (target.action.kind === 'accept') this.discard()
      return
    }
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
      case 'edit': if (this.editable(snapshot)) this.activateField(this.fields[this.fieldIndex]!.key); break
      case 'refresh': this.refresh(); break
      case 'discard': if (snapshot.dirty && !this.ambiguous(snapshot)) this.openQuestion('discard'); break
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    return this.renderTenant(width, this.controller.snapshot())
  }

  // ── ONE numeric tenant projection (SUX-01 single / SUX-02 grouped) ───────

  private renderTenant(width: number, snapshot: HostNumericSettingsSnapshot<T>): string[] {
    this.consumeEntry()
    // A grouped disclosure whose capture became stale/refused has no editable
    // facts to show: fall back to the browse's advertised Refresh/Back recovery
    // instead of painting Effective/Inherited as if they were current.
    if (!this.single && this.advanced && !this.editable(snapshot)) this.advanced = false
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
    let saveFacts: {
      readonly count?: number
      readonly dirty: readonly { readonly lines: readonly number[]; readonly complete: boolean }[]
    } = { dirty: [] }
    let inputAdmissible = true
    let advancedFacts: readonly number[] = []
    let advancedAction: ContentLine | undefined
    let acceptLine: number | undefined
    if (this.question !== undefined) {
      const question = this.questionLines(width, snapshot)
      content = question.lines
      mustSee = question.mustSee
      risk = question.risk
      acceptLine = question.acceptLine
    } else if (this.numberInput !== undefined) {
      const built = this.inputLines(width, snapshot)
      content = built.lines
      mustSee = built.critical
      inputAdmissible = built.admissible
    } else if (this.advanced) {
      if (this.single) {
        content = this.singleAdvancedLines(width, snapshot)
      } else {
        const built = this.groupAdvancedLines(width, snapshot)
        content = built.lines
        advancedFacts = built.facts
        advancedAction = built.action
      }
    } else if (this.single) {
      content = this.singleCleanLines(width, snapshot)
    } else {
      const browse = this.groupBrowseLines(width, snapshot)
      content = browse.lines
      saveFacts = browse.saveFacts
    }
    const baseMaxOffset = Math.max(0, content.length - bodyRows)
    let offset = Math.min(Math.max(0, this.formOffset), baseMaxOffset)
    if (!this.single) {
      // Reveal the SELECTED field's whole span (its value line and Current line)
      // against the REAL content rows; the Top/End jump never calls this. A
      // settlement status is the FIRST truth about the capture and is never
      // scrolled away by that reveal.
      const browseSettlement = this.question === undefined && this.numberInput === undefined && !this.advanced
        && snapshot.status !== undefined && snapshot.status.kind !== 'verified'
      const span = this.selectedFieldSpan(content)
      if (this.revealSelection && !browseSettlement && span !== undefined && bodyRows > 0) {
        if (span.start < offset) offset = span.start
        if (span.end > offset + bodyRows) offset = Math.max(span.start, span.end - bodyRows)
        offset = Math.min(Math.max(0, offset), baseMaxOffset)
      }
      this.revealSelection = false
    }
    // The grouped Reset is published only when THIS frame's provisional facts
    // really fit. The action line is part of the content for the authoritative
    // offset round: if the user is already at the bottom, the view shifts down
    // so the fresh action is the visible last row instead of one row too far.
    let resetReady = false
    if (!this.single && this.advanced && advancedAction !== undefined) {
      const signature = `${this.fieldIndex}|${width}|${this.authorityIdentity(snapshot)}|${advancedFacts.join(',')}`
      if (this.advancedSignature !== signature) {
        this.advancedSignature = signature
        this.advancedSeen.clear()
      }
      this.advancedFactLines = advancedFacts
      for (let index = 0; index < bodyRows; index += 1) this.advancedSeen.add(offset + index)
      resetReady = advancedFacts.length > 0 && advancedFacts.every(line => this.advancedSeen.has(line))
      if (resetReady) content.push(advancedAction)
    } else if (this.advancedFactLines.length > 0) {
      this.advancedFactLines = []
      this.advancedSeen.clear()
    }
    const maxOffset = Math.max(0, content.length - bodyRows)
    if (resetReady && offset < maxOffset && offset + bodyRows >= content.length - 1) offset = maxOffset
    offset = Math.min(Math.max(0, offset), maxOffset)
    this.formOffset = offset
    // An ordinary question's necessary copy is judged against the FINAL
    // physical viewport. The same answer controls the accept row's visible
    // word, its hit target and the bar action: a copy scrolled out of view
    // leaves only an inert blank row (scroll geometry preserved), not a blue
    // word whose handler refuses.
    const questionFrameComplete = this.question !== undefined && this.question.kind !== 'reset'
      && mustSee.every(lineIndex => lineIndex >= offset && lineIndex < offset + bodyRows)
    const visible = new Set<number>()
    let acceptPainted = false
    for (let index = 0; index < bodyRows; index += 1) {
      const line = content[offset + index]
      const suppressed = this.question !== undefined && this.question.kind !== 'reset'
        && !questionFrameComplete && acceptLine !== undefined && offset + index === acceptLine
      lines.push(fit(suppressed ? '' : line?.text ?? '', width))
      visible.add(offset + index)
      if (!suppressed) {
        for (const target of line?.targets ?? []) {
          targets.push({ ...target, row: index })
          if (target.action.kind === 'accept') acceptPainted = true
          const action = bodyActionOf(target.action.kind)
          if (action !== undefined) this.paintedActions.add(action)
        }
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
    const frameComplete = mustSee.every(lineIndex => visible.has(lineIndex)) && inputAdmissible
    // Ordinary questions answer from the CURRENT frame only: every necessary
    // fragment must be visible at once. Optional requested detail may scroll;
    // an insufficient grant publishes only Keep. The Agent single Reset keeps
    // its separate cumulative risk-fragment receipt.
    const questionRead = this.question === undefined ? false
      : this.question.kind === 'reset'
        ? this.resetRiskRead(width, risk)
        : questionFrameComplete
    const complete = questionRead || (this.question === undefined && frameComplete)
    if (this.question !== undefined && questionRead) this.paintedQuestion = this.questionIdentity()
    // A question's ONE accept target is admitted only once its necessary copy
    // was really read in THIS instance: a scrolled/insufficient grant publishes
    // no hidden answer.
    if (this.question !== undefined && questionRead && acceptPainted) {
      this.paintedActions.add(this.question.kind === 'refresh'
        ? 'refresh-confirm' : this.question.kind === 'discard' ? 'discard' : 'leave')
    }
    // The grouped Save needs a REAL staged fact on screen, not only its bar
    // span: the dirty count, or at least one COMPLETE staged field block.
    this.paintedSaveFacts = (saveFacts.count !== undefined && visible.has(saveFacts.count))
      || saveFacts.dirty.some(block => block.complete && block.lines.length > 0
        && block.lines.every(lineIndex => visible.has(lineIndex)))
    while (lines.length < bodyRows) lines.push(fit('', width))
    lines.push(this.renderTenantBar(snapshot, width, complete, maxOffset > 0, resetReady))
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
  /**
   * Compose ONE labelled fact against the REAL row width. The complete label
   * wraps when needed; a value that cannot fit WHOLE on its own line is
   * REPAIRED to `complete: false` and must never count as a readable fact for
   * an action admission (Stage/Save).
   */
  private fact(
    label: string,
    value: string,
    width: number,
    ink: (text: string) => string = color.text,
    pad = 0,
  ): { lines: ContentLine[]; complete: boolean } {
    const text = sanitizedPhysicalLine(value)
    const valueWidth = visibleWidth(text)
    const gap = Math.max(2, pad - visibleWidth(label))
    if (visibleWidth(label) + gap + valueWidth <= width) {
      return { lines: [{ text: color.textDim(label) + ' '.repeat(gap) + ink(text) }], complete: true }
    }
    const lines: ContentLine[] = wrapTextWithAnsi(sanitizedPhysicalLine(label), Math.max(1, width))
      .map(line => ({ text: color.textDim(line) }))
    // The value is complete only when the ACTUAL physical line carries it
    // whole: indent it only when the indent itself fits; otherwise use the
    // full width without indent. A truncation is an incomplete fact.
    if (valueWidth + 2 <= width) {
      lines.push({ text: `  ${ink(text)}` })
      return { lines, complete: true }
    }
    if (valueWidth <= width) {
      lines.push({ text: ink(text) })
      return { lines, complete: true }
    }
    lines.push({ text: `  ${ink(truncateToWidth(text, Math.max(1, width - 2), '…', false))}` })
    return { lines, complete: false }
  }
  /** A labelled prose fact: one line when the whole sentence fits, otherwise a
   *  wrapped label/value pair whose every physical fragment is complete. */
  private proseFact(label: string, value: string, width: number, pad = 0): ContentLine[] {
    const gap = Math.max(2, pad - visibleWidth(label))
    if (visibleWidth(label) + gap + visibleWidth(sanitizedPhysicalLine(value)) <= width) {
      return [{ text: color.textDim(label) + ' '.repeat(gap) + color.textDim(sanitizedPhysicalLine(value)) }]
    }
    return this.prose(label, value, width)
  }
  /** A prose fact (comparison/scope/help): every physical fragment is complete. */
  private prose(label: string, value: string, width: number): ContentLine[] {
    const lines: ContentLine[] = [{ text: color.textDim(label) }]
    for (const line of wrapTextWithAnsi(sanitizedPhysicalLine(value), Math.max(1, width - 2))) {
      lines.push({ text: `  ${color.textDim(line)}` })
    }
    return lines
  }
  /** Compact complete body verbs on shared rows. Separators and padding are
   *  inert; every target keeps the exact span its verb really painted. */
  private bodyActions(
    actions: readonly { readonly label: string; readonly action: BodyTarget['action'] }[],
    width: number,
  ): ContentLine[] {
    const lines: ContentLine[] = []
    let text = ''
    let targets: BodyTarget[] = []
    let column = 0
    const flush = (): void => {
      if (text === '') return
      lines.push({ text, targets })
      text = ''
      targets = []
      column = 0
    }
    for (const entry of actions) {
      const label = sanitizedPhysicalLine(entry.label)
      const cells = visibleWidth(label)
      if (cells > width) continue
      const separator = text === '' ? 0 : visibleWidth(ACTION_BAR_SEPARATOR)
      if (text !== '' && column + separator + cells > width) flush()
      const startCol = column + (text === '' ? 0 : visibleWidth(ACTION_BAR_SEPARATOR))
      text += `${text === '' ? '' : color.textMuted(ACTION_BAR_SEPARATOR)}${color.primary(label)}`
      targets.push({ id: entry.action.kind, action: entry.action, startCol, endCol: startCol + cells })
      column = startCol + cells
    }
    flush()
    return lines
  }
  private acceptAction(label: string, width: number): ContentLine {
    if (visibleWidth(label) > width) return { text: color.primary(label) }
    return { text: color.primary(label), targets: [{ id: 'accept', action: { kind: 'accept' }, startCol: 0, endCol: visibleWidth(label) }] }
  }
  private unitSuffix(field: HostNumericSettingsField<T>): string {
    return field.unit === undefined ? '' : ` ${field.unit}`
  }
  /** The browse label must not repeat the unit the value cell already paints:
   *  the field's own trailing `(<unit>)` is dropped from the DISPLAY text only
   *  (the raw Input/Advanced keep the complete authoritative label). */
  private browseLabel(field: HostNumericSettingsField<T>): string {
    if (field.unit === undefined) return field.label
    const suffix = ` (${field.unit})`
    return field.label.endsWith(suffix) ? field.label.slice(0, -suffix.length) : field.label
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
    lines.push({ text: this.row(snapshot.current ? 'Current value' : 'Last confirmed', this.singleValue(snapshot)) })
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, width))
    const status = snapshot.status
    const historicalSuccess = status?.kind === 'verified' && !snapshot.current
    if (status !== undefined) {
      // The settlement is the page's short user-facing result, never the
      // workspace's internal status vocabulary. Wrap it on the real grant
      // instead of letting the compose pass truncate it to an ellipsis.
      const word = statusWord(status.kind, snapshot)
      const inkWord = historicalSuccess ? color.warning(word) : statusInk(status.kind, word)
      for (const line of wrapTextWithAnsi(inkWord, Math.max(1, width))) lines.push({ text: line })
      if (status.kind === 'unverified' || status.kind === 'outcome-unconfirmed') {
        lines.push(...this.note(MAY_HAVE_BEEN_SAVED, width))
      }
      if (historicalSuccess) lines.push(...this.note('Previous save completed; refresh to review.', width))
      if (status.kind !== 'verified' && status.kind !== 'saving') lines.push(...this.note(status.text, width, color.textDim))
    } else if (this.feedback === 'no-changes') {
      lines.push({ text: color.textDim('No changes') })
    }
    if (snapshot.dirty) {
      const requested = this.singleRequested(snapshot)
      if (requested !== undefined) lines.push({ text: this.row('Requested', requested, color.text) })
    }
    if (snapshot.source.kind !== 'ready') {
      lines.push(...this.note(snapshot.source.reason, width, color.error))
    } else if (!snapshot.current && !historicalSuccess) {
      lines.push(...this.note('Last-known · the Host has newer state; refresh to review.', width))
    }
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, width, color.error))
    // The ONE body affordance of the clean state (Role 14).
    if (this.editable(snapshot)) lines.push({ text: color.primary('Details…'), targets: [{ id: 'details', action: { kind: 'details' }, startCol: 0, endCol: visibleWidth('Details…') }] })
    return lines
  }

  /** The grouped browse: one row per field (label + its real candidate), the
   *  served Current (or Last confirmed) for a staged field, the dirty count and
   *  the authority notes. Every field row SELECTS only; the editor needs its
   *  explicit Edit. */
  private groupBrowseLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): {
    lines: ContentLine[]
    saveFacts: {
      readonly count?: number
      readonly dirty: readonly { readonly lines: readonly number[]; readonly complete: boolean }[]
    }
  } {
    const lines: ContentLine[] = []
    const dirtyBlocks: { lines: number[]; complete: boolean }[] = []
    let countLine: number | undefined
    const source = snapshot.source
    const editable = this.editable(snapshot)
    if (snapshot.loading) {
      lines.push({ text: color.textDim('Loading Host settings…') })
      return { lines, saveFacts: { dirty: dirtyBlocks } }
    }
    const rowWidth = Math.min(width, 64)
    const copyWidth = Math.min(width, 72)
    const stale = !snapshot.current
    // A captured row is NOT a current readback once currentness is lost: the
    // heading names the captured executor as last-known, never as today's row.
    const heading = sanitizedPhysicalLine(this.intents.spec.sourceHeading(source))
    lines.push(...this.note(stale ? `Last-known · ${heading}` : heading, copyWidth, stale ? color.warning : color.textDim))
    const status = snapshot.status
    const historicalSuccess = status?.kind === 'verified' && !snapshot.current
    // Settlement state owns the FIRST readable rows: a short grant must not
    // hide the saved/refused/unknown result behind prose. The word is the
    // page's short user feedback, without the internal `Status` label.
    if (status !== undefined) {
      const word = statusWord(status.kind, snapshot)
      const inkWord = historicalSuccess ? color.warning(word) : statusInk(status.kind, word)
      for (const line of wrapTextWithAnsi(inkWord, Math.max(1, copyWidth))) lines.push({ text: line })
      if (status.kind === 'unverified' || status.kind === 'outcome-unconfirmed') {
        lines.push(...this.note(MAY_HAVE_BEEN_SAVED, copyWidth))
      }
      if (historicalSuccess) lines.push(...this.note('Previous save completed; refresh to review.', copyWidth))
      if (status.kind !== 'verified' && status.kind !== 'saving') lines.push(...this.note(status.text, copyWidth, color.textDim))
    } else if (this.feedback === 'no-changes') {
      lines.push({ text: color.textDim('No changes') })
    }
    for (const [index, field] of this.fields.entries()) {
      const selected = index === this.fieldIndex
      const staged = snapshot.dirtyFields.includes(field.key)
      const reset = snapshot.resetFields.includes(field.key)
      const browseLabel = this.browseLabel(field)
      const displayUnit = field.unit === 'ms' || field.unit === 'bytes' ? field.unit : undefined
      const unit = this.unitSuffix(field)
      const raw = snapshot.texts[field.key]
      // The browse paints the CANONICAL value of a legal draft (1e3 -> 1000),
      // and the raw text only while it is still refused by the validator.
      const candidate = raw !== undefined && this.controller.numberIssue(field.key, raw) === undefined
        ? String(Number(raw))
        : raw
      const candidateIsValid = raw === undefined || this.controller.numberIssue(field.key, raw) === undefined
      const authoritative = source.kind === 'ready' ? source.effective[field.key] : undefined
      const displayNumber = candidateIsValid ? Number(candidate ?? authoritative) : undefined
      const value = source.kind !== 'ready'
        ? 'Unknown'
        : reset ? 'Reset staged'
          : displayNumber !== undefined && displayUnit !== undefined
            ? formatShellSettingValue(displayNumber, displayUnit)
            : `${candidate ?? String(authoritative)}${unit}`
      const valueWidth = visibleWidth(value)
      const blockStart = lines.length
      let blockComplete = valueWidth <= rowWidth
      const active = selected && this.focused
      const marker = active ? color.primary('> ') : '  '
      // Every wrapped label fragment carries the 2-cell marker/indent, so the
      // wrap width is the real row width MINUS that prefix.
      const labelLines = wrapTextWithAnsi(sanitizedPhysicalLine(browseLabel), Math.max(1, rowWidth - 2))
      const target: BodyTarget = {
        id: `field:${field.key}`,
        action: { kind: 'field', field: field.key },
        startCol: 0,
        endCol: rowWidth,
      }
      if (labelLines.length === 1 && visibleWidth(marker) + visibleWidth(browseLabel) + 2 + valueWidth <= rowWidth) {
        const gap = Math.max(2, rowWidth - visibleWidth(marker) - visibleWidth(browseLabel) - valueWidth)
        const labelText = sanitizedPhysicalLine(browseLabel)
        const label = selected ? color.textStrong(labelText) : color.text(labelText)
        lines.push({ text: `${marker}${label}${' '.repeat(gap)}${color.text(sanitizedPhysicalLine(value))}`, field: field.key, targets: [target] })
      } else {
        // A label and its canonical value that cannot share ONE line keep the
        // COMPLETE label (wrapped, never cut mid-word) and the value on its own
        // line; a value wider than the row is marked incomplete.
        labelLines.forEach((line, lineIndex) => {
          const label = lineIndex === 0
            ? `${marker}${selected ? color.textStrong(line) : color.text(line)}`
            : `  ${color.text(line)}`
          lines.push({ text: label, field: field.key, ...(lineIndex === 0 ? { targets: [target] } : {}) })
        })
        const valueLine = valueWidth + 2 <= rowWidth
          ? `  ${color.text(value)}`
          : valueWidth <= rowWidth ? color.text(value)
            : `  ${color.text(truncateToWidth(value, Math.max(1, rowWidth - 2), '…', false))}`
        if (valueWidth > rowWidth) blockComplete = false
        lines.push({ text: valueLine, field: field.key })
      }
      if (staged) {
        // The served/current fact is part of the dirty block receipt: compose
        // its REAL physical lines and mark it complete only when the value and
        // the Unsaved marker are both fully painted.
        const prefix = `${stale ? 'Last confirmed' : 'Current'}:`
        const currentValue = this.fieldValue(snapshot, field)
        const currentUnit = field.unit === 'ms' || field.unit === 'bytes' ? field.unit : undefined
        const current = currentUnit === undefined
          ? currentValue
          : formatShellSettingValue(Number(currentValue), currentUnit)
        const suffix = 'Unsaved'
        const prefixWidth = visibleWidth(prefix)
        const currentWidth = visibleWidth(current)
        const valueText = currentWidth + 2 <= rowWidth ? `  ${color.textDim(current)}`
          : currentWidth <= rowWidth ? color.textDim(current)
            : `  ${color.textDim(truncateToWidth(current, Math.max(1, rowWidth - 2), '…', false))}`
        const valueComplete = currentWidth <= rowWidth
        // Composed: '  ' + prefix + ' ' + value + ' · ' + suffix (3 cells).
        const oneLine = 2 + prefixWidth + 1 + currentWidth + 3 + visibleWidth(suffix) <= rowWidth
        if (oneLine) {
          lines.push({ text: `  ${color.textDim(prefix)} ${color.textDim(current)} · ${color.textDim(suffix)}`, field: field.key })
        } else if (2 + prefixWidth + 1 + currentWidth <= rowWidth) {
          lines.push({ text: `  ${color.textDim(prefix)} ${color.textDim(current)}`, field: field.key })
          lines.push({ text: color.textDim('  · Unsaved'), field: field.key })
        } else {
          // Wrap the label fragments with the real 2-cell indent; then the
          // whole value line; then the Unsaved marker.
          const label = wrapTextWithAnsi(prefix, Math.max(1, rowWidth - 2))
          for (const fragment of label) lines.push({ text: `  ${color.textDim(fragment)}`, field: field.key })
          lines.push({ text: valueText, field: field.key })
          lines.push({ text: color.textDim('  · Unsaved'), field: field.key })
          blockComplete = blockComplete && valueComplete
        }
        // A one-line/split value that fits keeps the block complete; a clipped
        // value or an unrenderable Unsaved marker denies the dirty receipt.
        if (currentWidth > rowWidth || rowWidth < 5) blockComplete = false
      }
      if (staged) dirtyBlocks.push({ lines: lines.slice(blockStart).map((_, offset) => blockStart + offset), complete: blockComplete })
    }
    if (snapshot.dirty) {
      const count = snapshot.dirtyFields.length
      countLine = lines.length
      lines.push({ text: color.text(`${count} unsaved change${count === 1 ? '' : 's'} · ${this.title}`) })
    }
    const actions: { label: string; action: BodyTarget['action'] }[] = []
    if (editable) {
      actions.push({ label: 'Edit…', action: { kind: 'edit' } })
      actions.push({ label: 'Details…', action: { kind: 'details' } })
    }
    if (snapshot.dirty && !this.ambiguous(snapshot)) actions.push({ label: 'Discard…', action: { kind: 'discard' } })
    if (editable) actions.push({ label: 'Refresh…', action: { kind: 'refresh' } })
    lines.push(...this.bodyActions(actions, width))
    lines.push(...this.note('Edit values, then Save to apply.', copyWidth))
    if (source.kind !== 'ready') lines.push(...this.note(source.reason, copyWidth, color.error))
    if (this.waitNotice && snapshot.saving) lines.push(...this.note('Dispatched writes continue.', copyWidth))
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, copyWidth, color.error))
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, copyWidth))
    for (const help of this.intents.spec.help) lines.push(...this.note(help, copyWidth))
    return {
      lines,
      saveFacts: { ...(countLine === undefined ? {} : { count: countLine }), dirty: dirtyBlocks },
    }
  }

  private inputLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): {
    lines: ContentLine[]
    critical: readonly number[]
    admissible: boolean
  } {
    const lines: ContentLine[] = []
    const active = this.numberInput!
    const field = this.fields.find(candidate => candidate.key === active.field)!
    const unit = this.unitSuffix(field)
    const copyWidth = this.single ? width : Math.min(width, 72)
    if (!this.single) lines.push(...this.note(`Edit ${field.label}`, width, color.textDim))
    lines.push(...this.fact('Current value', `${this.fieldValue(snapshot, field)}${unit}`, width).lines)
    const inputRow = lines.length
    lines.push({ text: active.input.render(width)[0] ?? '', targets: [{ id: 'input', action: { kind: 'input' }, startCol: 0, endCol: width }] })
    const critical = [inputRow]
    let admissible = true
    const raw = active.input.getValue()
    if (raw.trim() !== '') {
      const canonical = this.controller.numberIssue(active.field as keyof T & string, raw) === undefined ? String(Number(raw)) : undefined
      // Input.render strips the prompt and reserves a cursor cell, then slices
      // a longer value horizontally. The raw editor is only a complete fact
      // when the whole number fits that window; when it is clipped the
      // canonical fact is required even for text that is already canonical.
      const prompt = 'Value: '
      const window = Math.max(0, width - visibleWidth(prompt) - 1)
      // The editor's own window is measured on the FULL buffer (legal leading/
      // trailing whitespace included), not on the trimmed numeric text.
      const rawVisible = visibleWidth(raw) <= window
      if (canonical !== undefined && (canonical !== raw.trim() || !rawVisible)) {
        // The canonical numeric fact is admissible only when its COMPLETE value
        // (and unit) really fits the row: a clipped canonical line can never
        // stand as proof of the number that will be sent.
        const sent = this.fact('Value sends', `${canonical}${unit}`, width)
        const sentStart = lines.length
        for (const line of sent.lines) lines.push(line)
        critical.push(...sent.lines.map((_, offset) => sentStart + offset))
        admissible = sent.complete
      }
    }
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, copyWidth))
    if (this.single && this.intents.spec.dispatched !== undefined) lines.push(...this.note(this.intents.spec.dispatched, copyWidth))
    return { lines, critical, admissible }
  }

  private singleAdvancedLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): ContentLine[] {
    const lines: ContentLine[] = []
    const pad = 14
    lines.push(...this.fact('Effective', this.singleValue(snapshot), width, color.text, pad).lines)
    lines.push(...this.fact('Inherited', this.singleInherited(snapshot), width, color.textDim, pad).lines)
    lines.push(...this.fact('Comparison', this.singleComparison(snapshot), width, color.textDim, pad).lines)
    if (snapshot.source.kind === 'ready') lines.push(...this.fact('Revision', String(snapshot.source.revision), width, color.textDim, pad).lines)
    if (this.intents.spec.scope !== undefined) lines.push(...this.proseFact('Scope', this.intents.spec.scope, width, pad))
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
   *  the Host row identity and the ONE explicit reset-staging action. It also
   *  returns the physical lines that prove the selected identity and the
   *  unset semantics for the reset READ receipt. */
  private groupAdvancedLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): {
    lines: ContentLine[]
    facts: readonly number[]
    action: ContentLine | undefined
  } {
    const field = this.fields[this.fieldIndex]!
    const source = snapshot.source
    const lines: ContentLine[] = []
    const facts: number[] = []
    const unit = this.unitSuffix(field)
    const pad = 12
    const rowWidth = Math.min(width, 64)
    const copyWidth = Math.min(width, 72)
    const stale = !snapshot.current
    const heading = sanitizedPhysicalLine(this.intents.spec.sourceHeading(source))
    lines.push(...this.note(stale ? `Last-known · ${heading}` : heading, copyWidth, stale ? color.warning : color.textDim))
    // The selected identity is the COMPLETE label, wrapped at the real width;
    // every physical fragment is part of the receipt.
    const labelLines = wrapTextWithAnsi(sanitizedPhysicalLine(field.label), Math.max(1, rowWidth))
    const labelStart = lines.length
    for (const fragment of labelLines) lines.push({ text: color.textStrong(fragment) })
    for (let index = 0; index < labelLines.length; index += 1) facts.push(labelStart + index)
    // The staging/unset explanation stands BEFORE the served facts: a short
    // grant must be able to read WHICH field and HOW it resets before it can
    // reach the action. Both necessary statements are part of the receipt.
    const resetCopy = this.note('Reset stages the official unset.', copyWidth)
    let next = lines.length
    for (const _line of resetCopy) { facts.push(next); next += 1 }
    lines.push(...resetCopy)
    const stagedCopy = this.note('Changes are staged until Save.', copyWidth)
    next = lines.length
    for (const _line of stagedCopy) { facts.push(next); next += 1 }
    lines.push(...stagedCopy)
    lines.push(...this.fact('Effective', `${this.fieldValue(snapshot, field)}${unit}`, rowWidth, color.text, pad).lines)
    lines.push(...this.fact('Inherited', `${this.fieldInherited(snapshot, field)}${unit}`, rowWidth, color.textDim, pad).lines)
    lines.push(...this.fact('Comparison', this.fieldComparison(snapshot, field), rowWidth, color.textDim, pad).lines)
    if (source.kind === 'ready') lines.push(...this.fact('Revision', String(source.revision), rowWidth, color.textDim, pad).lines)
    if (this.intents.spec.scope !== undefined) lines.push(...this.proseFact('Scope', this.intents.spec.scope, copyWidth, pad))
    if (snapshot.dirtyFields.includes(field.key)) {
      const requested = this.fieldRequested(snapshot, field)
      if (requested !== undefined) lines.push(...this.fact('Staged', `${requested}${requested === 'official unset' ? '' : unit}`, rowWidth, color.text, pad).lines)
    }
    if (this.intents.spec.effect !== undefined) lines.push(...this.note(this.intents.spec.effect, copyWidth))
    lines.push(...this.note('The USER patch may retain the inherited value.', copyWidth))
    lines.push(...this.note('The Host readback decides the value.', copyWidth))
    if (source.kind !== 'ready') {
      lines.push(...this.note(source.reason, copyWidth, color.error))
    }
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, copyWidth, color.error))
    const action = this.editable(snapshot) && visibleWidth('Reset to inherited…') <= rowWidth
      ? {
          text: color.primary('Reset to inherited…'),
          targets: [{ id: `reset:${field.key}`, action: { kind: 'reset' as const, field: field.key }, startCol: 0, endCol: visibleWidth('Reset to inherited…') }],
        }
      : undefined
    return { lines, facts, action }
  }

  private questionLines(
    width: number,
    snapshot: HostNumericSettingsSnapshot<T>,
  ): {
    lines: ContentLine[]
    mustSee: readonly number[]
    risk: readonly { readonly line: number; readonly statement: number }[]
    /** The ONE action row of the grouped question, when its full word fits. */
    acceptLine?: number
  } {
    const question = this.question!
    if (question.kind === 'reset') {
      const lines: ContentLine[] = []
      lines.push(...this.fact('Current', this.singleValue(snapshot), width, color.text).lines)
      lines.push(...this.fact('Inherited', this.singleInherited(snapshot), width, color.textDim).lines)
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
      const countLine = `${count} unsaved change${count === 1 ? '' : 's'} · ${this.title}`
      facts = this.ambiguous(snapshot)
        ? [countLine, ...AMBIGUOUS_LEAVE]
        : this.canSave(snapshot)
          ? [countLine, 'Save keeps you here.', 'Discard and leave loses staged values.']
          // A stale/refused capture cannot save here: never advertise the
          // unavailable action, state the real choice instead.
          : [countLine, 'Save is unavailable until you refresh and review.', 'Discard and leave loses staged values.']
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
      return { lines, mustSee, risk: [] }
    }
    // The grouped question's necessary copy and its ONE accept action must fit
    // the REAL grant together: a scrolled copy could otherwise leave a visible
    // answer whose receipt is no longer complete.
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const detail: ContentLine[] = []
    if (this.ambiguous(snapshot)) {
      const rowWidth = Math.min(width, 64)
      const unitOf = (field: HostNumericSettingsField<T>): string => this.unitSuffix(field)
      for (const field of this.fields) {
        if (!snapshot.dirtyFields.includes(field.key)) continue
        const requested = this.fieldRequested(snapshot, field)
        detail.push(...this.fact(`Requested ${field.label}`, requested === 'official unset' ? 'official unset' : `${requested ?? ''}${unitOf(field)}`, rowWidth, color.text).lines)
      }
      // Both last-confirmed caps, not only the dirty fields: the whole captured
      // row is the authority being acknowledged.
      for (const field of this.fields) {
        detail.push(...this.fact(`Last confirmed ${field.label}`, `${this.fieldValue(snapshot, field)}${unitOf(field)}`, rowWidth, color.textDim).lines)
      }
    }
    const acceptWord = question.kind === 'refresh'
      ? 'Refresh…'
      : question.kind === 'discard' ? 'Discard…' : this.ambiguous(snapshot) ? 'Leave anyway…' : 'Discard and leave…'
    // The necessary copy + accept must fit together; the requested/last-known
    // detail is scrollable and never blocks the fallback's publication. The
    // accept word itself must fit WHOLE: a truncated action word is never
    // painted. Its row is reserved and later gated by the FINAL viewport.
    let acceptLine: number | undefined
    if (visibleWidth(acceptWord) <= width && lines.length + 1 <= bodyRows) {
      acceptLine = lines.length
      lines.push(this.acceptAction(acceptWord, width))
    }
    lines.push(...detail)
    return { lines, mustSee, risk: [], ...(acceptLine === undefined ? {} : { acceptLine }) }
  }

  private renderTenantBar(
    snapshot: HostNumericSettingsSnapshot<T>,
    width: number,
    complete: boolean,
    scrollable: boolean,
    resetReady: boolean,
  ): string {
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
          ...(this.single ? [] : painted && this.canSave(snapshot)
            ? [{ text: `Save [${KEYS.save.toUpperCase()}]`, short: 'Save', priority: 950, action: 'save' as const }]
            : []),
          ...(painted ? [{
            text: word,
            // An ambiguous outcome must never be relabelled as an ordinary
            // discard; only the definite action may compact.
            ...(this.single || this.ambiguous(snapshot) ? {} : { short: 'Discard [D]' }),
            priority: 900,
            action: 'leave' as const,
          }] : []),
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
        ...((this.single ? this.editable(snapshot) : resetReady)
          ? [{ text: 'Reset [X]', priority: 900, action: 'reset' as const }]
          : []),
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
    } else if (snapshot.dirty && this.canSave(snapshot) && this.paintedSaveFacts) {
      // Grouped dirty browse: Save is published only while ITS OWN dirty facts
      // are really on screen; the secondary routes drop WHOLE and the body
      // keeps Edit…/Details…/Discard…/Refresh… reachable.
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
