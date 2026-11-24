/** The ONE shared numeric Settings page for the FR5-B Agent-loop and
 * Shell-execution specialist entries. The controller owns every semantic
 * draft, validation and Host write; this page paints and routes input only.
 *
 * Two presentations share this one page/controller:
 * - `staged` (Shell execution) keeps the Apply -> Save form with one physical
 *   Action Bar and the shared blank-stages-Reset contract.
 * - `single` (SUX-01 Agent loop) is the inline single-value Detail tenant: ONE
 *   Confirm performs the stage->save handoff, `?` opens the Advanced
 *   disclosure, and the Root keeps the physical bar/parent panes. */
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
  /** The staged mode's explanation block (Shell execution). */
  readonly help: readonly string[]
  /** `single` = the SUX-01 inline single-value Detail tenant. It is a real
   *  presentation contract of THIS row, never a user-configurable mode. */
  readonly commitMode?: 'single'
  /** Single mode: when the value takes effect (one sentence). */
  readonly effect?: string
  /** Single mode: what the change does NOT rewrite. */
  readonly dispatched?: string
  /** Single mode: the owning authority's scope fact (Advanced). */
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
  readonly startCol: number
  readonly endCol: number
}
type BarAction =
  | 'save' | 'refresh' | 'discard' | 'keep' | 'reset' | 'apply'
  | 'change' | 'details' | 'reset-confirm' | 'leave' | 'refresh-confirm'
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
type QuestionKind = 'leave' | 'refresh' | 'reset' | 'parent-leave'
interface Question {
  readonly instance: number
  readonly kind: QuestionKind
  /** The captured parent-leave continuation (single mode only). */
  readonly leave?: () => void
}

// These local, deliberately non-rebindable keys supply both handlers and badges.
const KEYS = { save: 's', refresh: 'r', reset: 'x', discard: 'd', yes: 'y', no: 'n' } as const
const DETAILS_KEY = '?'
const DISCARD_QUESTION = 'Discard unsaved changes? y/N'
const RESET_WORD = '[Reset]'
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
  // ── single mode (SUX-01) ─────────────────────────────────────────────────
  private entryIntent: 'change' | 'details' | undefined
  private advanced = false
  private singleError: string | undefined
  private singleFeedback: 'no-changes' | undefined
  /** The synchronous stage->save handoff token (0 = not in the handoff). */
  private handoff = 0
  /** The painted admission for the state's ONE confirm action. */
  private paintedConfirm = false
  /** The leave/refresh question's own action span was really published by the
   *  last frame (a dropped or truncated segment is never keyboard-admitted). */
  private paintedAction = false
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
    if (this.single) {
      return snapshot.loading || snapshot.saving || snapshot.dirty
        || this.numberInput !== undefined || this.question !== undefined || this.advanced || this.handoff !== 0
    }
    return snapshot.dirty || snapshot.saving || this.numberInput !== undefined || this.question !== undefined
  }

  /** PR-D admission: a pointer press may only arm against the frame THIS page
   *  really painted for the CURRENT state (a landed readback that has not
   *  repainted refuses the press instead of completing on newer cells). */
  pointerFrameCurrent(): boolean {
    return this.paint !== undefined && !this.awaitingPaint && this.paint.identity === this.gestureIdentity()
  }

  /**
   * The single mode's ONE consumer of a user parent navigation. `allow` releases
   * the page immediately (nothing was typed/pending); `refuse` keeps the page:
   * either a local input/disclosure/saving window owns the keys, or the page
   * opened its OWN question and will call `leave` only after the user really
   * confirms. Nothing here writes, refreshes or navigates by itself.
   */
  requestParentLeave(target: SpecialistParentLeaveTarget, leave: () => void): 'allow' | 'refuse' {
    if (!this.single || this.disposed) return 'refuse'
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
      + `|${this.singleFeedback ?? ''}|${this.handoff === 0 ? '' : 'handoff'}`
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
  private keepEditing(): void { this.question = undefined; this.changed() }
  private ambiguous(snapshot: HostNumericSettingsSnapshot<T>): boolean {
    const kind = snapshot.status?.kind
    return kind === 'unverified' || kind === 'outcome-unconfirmed'
  }
  private discard(): void {
    const question = this.question
    if (question === undefined || this.paintedQuestion !== this.questionIdentity()) return
    // SUX-01: the single-mode accepting action (Discard/Leave or Refresh) must
    // be a really painted span; a dropped segment is never admitted through its
    // shortcut key. The staged Shell form keeps its established behaviour.
    if (this.single && !this.paintedAction) return
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    this.question = undefined
    if (question.kind === 'refresh') { this.controller.refresh(true); this.changed(); return }
    this.controller.discard()
    this.advanced = false
    this.singleFeedback = undefined
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
      this.singleError = undefined
      this.changed()
      return
    }
    if (this.single && this.advanced) { this.advanced = false; this.changed(); return }
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
      placeholder: this.single ? 'positive integer' : 'blank stages Reset',
      placeholderStyle: color.textDim,
    })
    const current = this.controller.textOf(spec.key) ?? (snapshot.source.kind === 'ready' ? String(snapshot.source.effective[spec.key]) : '')
    input.setValue(current)
    input.focused = this.focused
    this.numberInput = { field, input }
    this.singleError = undefined
    this.singleFeedback = undefined
    this.formOffset = 0
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

  // ── single mode actions ──────────────────────────────────────────────────

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
    if (!this.single || this.numberInput !== undefined || this.question !== undefined) return
    this.advanced = true
    this.formOffset = 0
    this.changed()
  }

  /**
   * ONE Confirm for both the Input and the Reset confirmation: validate, commit
   * the local transition, stage the ONE controller intent and dispatch the ONE
   * save in the same call stack. Every step re-proofs the captured source and
   * the live controller; a refused stage restores the raw input instead of
   * saving an older patch.
   */
  private confirmSingle(): void {
    const active = this.numberInput
    if (active === undefined || this.disposed || this.handoff !== 0) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) return
    if (!this.paintedConfirm) return
    const key = active.field as keyof T & string
    const raw = active.input.getValue()
    const issue = this.controller.numberIssue(key, raw)
    if (issue !== undefined) {
      this.singleError = issue
      this.changed()
      return
    }
    if (!this.editable(snapshot)) {
      this.singleError = 'Host settings changed or are unavailable; cancel and refresh.'
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
    this.singleFeedback = undefined
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
        this.singleError = staged.notice ?? 'Host settings changed or are unavailable; cancel and refresh.'
        this.changed()
        return
      }
      this.advanced = false
      this.singleError = undefined
      this.singleFeedback = staged.dirty ? undefined : 'no-changes'
      this.revoke()
      if (!staged.dirty) return
      this.controller.save()
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
    this.singleFeedback = undefined
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

  /** Whether every necessary reset risk line has been painted in THIS question
   *  instance, width and body grant (a shorter frame re-arms the receipt). */
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
    if (this.question !== undefined) {
      if (this.single) {
        if (this.question.kind === 'reset') {
          if (matchesKey(data, 'enter')) this.confirmReset()
          else if (this.singleScrollKey(data)) this.scrollSingle(data)
          return
        }
        if (this.question.kind === 'refresh') {
          if (matchesKey(data, KEYS.refresh) || matchesKey(data, 'enter')) this.discard()
          else if (this.singleScrollKey(data)) this.scrollSingle(data)
          return
        }
        if (data === KEYS.discard || data === KEYS.discard.toUpperCase()) this.discard()
        else if (this.singleScrollKey(data)) this.scrollSingle(data)
        return
      }
      if (data === KEYS.yes || data === KEYS.yes.toUpperCase()) this.discard()
      else if (data === KEYS.no || data === KEYS.no.toUpperCase() || matchesKey(data, 'enter')) this.keepEditing()
      return
    }
    if (this.single) { this.handleSingleInput(data, snapshot); return }
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

  private handleSingleInput(data: string, snapshot: HostNumericSettingsSnapshot<T>): void {
    if (Math.max(0, this.rowGrant - 1) < 1) {
      // A bar-only grant paints ONLY the page's own Back: no body action exists,
      // so no key may start an Input, a disclosure or an official refresh.
      if (matchesKey(data, 'left')) this.back()
      return
    }
    const active = this.numberInput
    if (active !== undefined) {
      if (matchesKey(data, 'enter')) { this.confirmSingle(); return }
      active.input.handleInput(data)
      this.singleError = undefined
      this.changed()
      return
    }
    if (this.advanced) {
      if (this.singleScrollKey(data)) { this.scrollSingle(data); return }
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
    if (this.singleScrollKey(data)) this.scrollSingle(data)
  }

  private singleScrollKey(data: string): boolean {
    return matchesKey(data, 'up') || matchesKey(data, 'down')
      || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
      || matchesKey(data, 'home') || matchesKey(data, 'end')
  }
  private scrollSingle(data: string): void {
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
      case 'apply': if (this.single) this.confirmSingle(); else this.applyNumber(); break
      case 'reset':
        // Single mode NEVER stages a reset from a key/pointer: the Advanced
        // action only OPENS the guarded confirmation.
        if (this.single) this.openQuestion('reset')
        else this.reset(this.fields[this.fieldIndex]!.key)
        break
      case 'change': if (this.editable(snapshot)) this.beginSingleInput(); break
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
      // SUX-01: the single-value page's OWN body scrolls under the wheel,
      // including a scrollable reset confirmation whose risk fragments must have
      // been painted before its Confirm exists (a mouse-only user must be able
      // to reach them). The staged Shell form keeps its old question exclusion.
      if (this.question !== undefined && !this.single) return undefined
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
      case 'reset':
        if (this.numberInput === undefined) {
          if (this.single) this.openQuestion('reset')
          else this.reset(target.action.field)
        }
        break
      case 'input': this.numberInput?.input.handleMouse({ ...event, type: 'press', y: 0, height: 1 }); this.changed(); break
      case 'details': this.openAdvanced(); break
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    const snapshot = this.controller.snapshot()
    if (this.single) return this.renderSingle(width, snapshot)
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const lines: string[] = []
    const targets: Target[] = []
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
    this.paintedConfirm = false
    let maxOffset = 0
    let scrollStart = 0
    let scrollEnd = 0
    if (this.question !== undefined) {
      const question = this.question.kind === 'refresh'
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

  // ── single mode projection (SUX-01 Detail tenant) ────────────────────────

  private renderSingle(width: number, snapshot: HostNumericSettingsSnapshot<T>): string[] {
    this.consumeEntry()
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const lines: string[] = []
    const targets: Target[] = []
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
    this.paintedConfirm = false
    this.paintedAction = false
    let content: ContentLine[]
    let mustSee: readonly number[] = []
    let risk: readonly { readonly line: number; readonly statement: number }[] = []
    if (this.question !== undefined) {
      const question = this.singleQuestionLines(width, snapshot)
      content = question.lines
      mustSee = question.mustSee
      risk = question.risk
    } else if (this.numberInput !== undefined) {
      const built = this.singleInputLines(width, snapshot)
      content = built.lines
      mustSee = built.critical
    } else if (this.advanced) {
      content = this.singleAdvancedLines(width, snapshot)
    } else {
      content = this.singleCleanLines(width, snapshot)
    }
    const maxOffset = Math.max(0, content.length - bodyRows)
    const offset = Math.min(Math.max(0, this.formOffset), maxOffset)
    this.formOffset = offset
    const visible = new Set<number>()
    for (let index = 0; index < bodyRows; index += 1) {
      const line = content[offset + index]
      lines.push(fit(line?.text ?? '', width))
      visible.add(offset + index)
      for (const target of line?.targets ?? []) targets.push({ ...target, row: index })
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
    while (lines.length < bodyRows) lines.push(fit('', width))
    lines.push(this.renderSingleBar(snapshot, width, complete, maxOffset > 0))
    this.awaitingPaint = false
    this.paint = { width, rows: this.rowGrant, identity: this.gestureIdentity(), targets, maxOffset, scrollStart: 0, scrollEnd: bodyRows }
    return lines
  }

  private singleRow(label: string, value: string, ink: (text: string) => string = color.text, pad = 0): string {
    const head = color.textDim(label) + ' '.repeat(Math.max(2, pad - visibleWidth(label)))
    return head + ink(sanitizedPhysicalLine(value))
  }
  private singleNote(text: string, width: number, tone: (text: string) => string = color.textDim): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(line => ({ text: tone(line) }))
  }
  private singleValue(snapshot: HostNumericSettingsSnapshot<T>): string {
    const field = this.fields[0]!
    return snapshot.source.kind === 'ready' ? String(snapshot.source.effective[field.key]) : 'Unknown'
  }
  private singleInherited(snapshot: HostNumericSettingsSnapshot<T>): string {
    const field = this.fields[0]!
    return snapshot.source.kind === 'ready' ? String(snapshot.source.inherited[field.key]) : 'Unknown'
  }
  private singleComparison(snapshot: HostNumericSettingsSnapshot<T>): string {
    const field = this.fields[0]!
    if (snapshot.source.kind !== 'ready') return 'Unknown'
    return snapshot.source.overridden[field.key] === true ? 'Differs from base' : 'Matches base'
  }
  private singleRequested(snapshot: HostNumericSettingsSnapshot<T>): string | undefined {
    const field = this.fields[0]!
    if (snapshot.resetFields.includes(field.key)) return 'official unset'
    const text = snapshot.texts[field.key]
    return text === undefined || text.trim() === '' ? undefined : String(Number(text))
  }

  private singleCleanLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): ContentLine[] {
    const lines: ContentLine[] = []
    if (snapshot.loading) {
      lines.push({ text: color.textDim('Loading Host settings…') })
      return lines
    }
    lines.push({ text: this.singleRow('Current value', this.singleValue(snapshot)) })
    if (this.intents.spec.effect !== undefined) lines.push(...this.singleNote(this.intents.spec.effect, width))
    const status = snapshot.status
    if (status !== undefined) {
      const ink = status.kind === 'verified' ? color.success
        : status.kind === 'not-saved' ? color.error
          : status.kind === 'unverified' || status.kind === 'outcome-unconfirmed' ? color.warning
            : color.textDim
      lines.push({ text: this.singleRow('Status', statusWord(status.kind, snapshot), ink) })
      if (status.kind !== 'verified') lines.push(...this.singleNote(status.text, width, color.textDim))
    } else if (this.singleFeedback === 'no-changes') {
      lines.push({ text: this.singleRow('Status', 'No changes', color.textDim) })
    }
    if (snapshot.dirty) {
      const requested = this.singleRequested(snapshot)
      if (requested !== undefined) lines.push({ text: this.singleRow('Requested', requested, color.text) })
    }
    if (snapshot.source.kind !== 'ready') {
      lines.push(...this.singleNote(snapshot.source.reason, width, color.error))
    } else if (!snapshot.current) {
      lines.push(...this.singleNote('Last-known · the Host has newer state; refresh to review.', width))
    }
    if (snapshot.notice !== undefined) lines.push(...this.singleNote(snapshot.notice, width, color.error))
    // The ONE body affordance of the clean state (Role 14).
    if (this.editable(snapshot)) lines.push({ text: color.primary('Details…'), targets: [{ id: 'details', action: { kind: 'details' }, startCol: 0, endCol: visibleWidth('Details…') }] })
    return lines
  }

  private singleInputLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): { lines: ContentLine[]; critical: readonly number[] } {
    const lines: ContentLine[] = []
    const active = this.numberInput!
    lines.push({ text: this.singleRow('Current value', this.singleValue(snapshot)) })
    const inputRow = lines.length
    lines.push({ text: active.input.render(width)[0] ?? '', targets: [{ id: 'input', action: { kind: 'input' }, startCol: 0, endCol: width }] })
    const critical = [inputRow]
    const raw = active.input.getValue()
    if (raw.trim() !== '') {
      const canonical = this.controller.numberIssue(active.field as keyof T & string, raw) === undefined ? String(Number(raw)) : undefined
      if (canonical !== undefined && canonical !== raw.trim()) {
        critical.push(lines.length)
        lines.push({ text: this.singleRow('Value sends', canonical, color.text) })
      }
    }
    if (this.singleError !== undefined) lines.push(...this.singleNote(this.singleError, width, color.error))
    if (this.intents.spec.effect !== undefined) lines.push(...this.singleNote(this.intents.spec.effect, width))
    if (this.intents.spec.dispatched !== undefined) lines.push(...this.singleNote(this.intents.spec.dispatched, width))
    return { lines, critical }
  }

  private singleAdvancedLines(width: number, snapshot: HostNumericSettingsSnapshot<T>): ContentLine[] {
    const lines: ContentLine[] = []
    const pad = 14
    lines.push({ text: this.singleRow('Effective', this.singleValue(snapshot), color.text, pad) })
    lines.push({ text: this.singleRow('Inherited', this.singleInherited(snapshot), color.textDim, pad) })
    lines.push({ text: this.singleRow('Comparison', this.singleComparison(snapshot), color.textDim, pad) })
    if (snapshot.source.kind === 'ready') lines.push({ text: this.singleRow('Revision', String(snapshot.source.revision), color.textDim, pad) })
    if (this.intents.spec.scope !== undefined) lines.push({ text: this.singleRow('Scope', this.intents.spec.scope, color.textDim, pad) })
    if (this.intents.spec.effect !== undefined) lines.push(...this.singleNote(this.intents.spec.effect, width))
    lines.push(...this.singleNote(RESET_RISK[0], width))
    lines.push(...this.singleNote(RESET_RISK[1], width))
    if (this.editable(snapshot)) {
      lines.push({
        text: color.primary('Reset to inherited…'),
        targets: [{ id: 'reset-field', action: { kind: 'reset', field: this.fields[0]!.key }, startCol: 0, endCol: visibleWidth('Reset to inherited…') }],
      })
    } else if (snapshot.source.kind !== 'ready') {
      lines.push(...this.singleNote(snapshot.source.reason, width, color.error))
    } else {
      lines.push(...this.singleNote('Last-known · the Host has newer state; refresh to review.', width))
    }
    if (snapshot.notice !== undefined) lines.push(...this.singleNote(snapshot.notice, width, color.error))
    return lines
  }

  private singleQuestionLines(
    width: number,
    snapshot: HostNumericSettingsSnapshot<T>,
  ): { lines: ContentLine[]; mustSee: readonly number[]; risk: readonly { readonly line: number; readonly statement: number }[] } {
    const question = this.question!
    if (question.kind === 'reset') {
      const lines: ContentLine[] = []
      lines.push({ text: this.singleRow('Current', this.singleValue(snapshot), color.text) })
      lines.push({ text: this.singleRow('Inherited', this.singleInherited(snapshot), color.textDim) })
      // Every PHYSICAL wrapped line of a statement carries its statement index:
      // reading the wrapped fragments of the first two statements can never
      // satisfy the third one.
      const risk: { line: number; statement: number }[] = []
      RESET_RISK.forEach((statement, index) => {
        for (const wrapped of this.singleNote(statement, width)) {
          risk.push({ line: lines.length, statement: index })
          lines.push(wrapped)
        }
      })
      return { lines, mustSee: [], risk }
    }
    const facts = question.kind === 'refresh'
      ? REFRESH_QUESTION
      : this.ambiguous(snapshot) ? AMBIGUOUS_LEAVE : DEFINITE_LEAVE
    const lines: ContentLine[] = []
    const mustSee: number[] = []
    for (const fact of facts) {
      for (const wrapped of this.singleNote(fact, width, color.warning)) {
        mustSee.push(lines.length)
        lines.push(wrapped)
      }
    }
    const requested = this.singleRequested(snapshot)
    if (requested !== undefined) lines.push({ text: this.singleRow('Requested', requested, color.text) })
    return { lines, mustSee, risk: [] }
  }

  private renderSingleBar(snapshot: HostNumericSettingsSnapshot<T>, width: number, complete: boolean, scrollable: boolean): string {
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
      if (question.kind === 'reset') {
        this.paintedConfirm = this.paintedQuestion === this.questionIdentity()
        segments = [
          ...(this.paintedConfirm ? [{ text: 'Confirm [Enter]', priority: 900, action: 'reset-confirm' as const }] : []),
          { text: 'Cancel [Esc]', priority: 1000, escape: true },
        ]
      } else if (question.kind === 'refresh') {
        segments = [
          ...(this.paintedQuestion === this.questionIdentity() ? [{ text: 'Refresh [R]', priority: 900, action: 'refresh-confirm' as const }] : []),
          { text: 'Keep [Esc]', priority: 1000, escape: true },
        ]
      } else {
        const word = this.ambiguous(snapshot) ? 'Leave anyway [D]' : 'Discard and leave [D]'
        segments = [
          ...(this.paintedQuestion === this.questionIdentity() ? [{ text: word, priority: 900, action: 'leave' as const }] : []),
          { text: 'Keep [Esc]', priority: 1000, escape: true },
        ]
      }
    } else if (this.numberInput !== undefined) {
      this.paintedConfirm = complete
      segments = [
        ...(this.paintedConfirm ? [{ text: 'Confirm [Enter]', priority: 900, action: 'apply' as const }] : []),
        { text: 'Cancel [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.advanced) {
      segments = [
        ...(this.editable(snapshot) ? [{ text: 'Reset [X]', priority: 900, action: 'reset' as const }] : []),
        ...(scrollable ? [{ text: 'Up/Down scroll', priority: 400 }] : []),
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.editable(snapshot)) {
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
    const layout = layoutActionBarRow(segments, width)
    if (layout.truncated) {
      // Not even one segment fits WHOLE: the row is an inert truncated hint, so
      // no action (least of all a main Confirm) may stay keyboard-admitted.
      this.paintedConfirm = false
      this.paintedAction = false
      this.barSpans = []
      return fit(color.textMuted(layout.text), width)
    }
    const painted: string[] = []
    const spans: { id: string; action: BarAction; startCol: number; endCol: number }[] = []
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]!
      painted.push(segment.action === undefined && !segment.escape ? color.textMuted(span.text)
        : paintActionSpan(span.text, segment.action === 'change' || segment.action === 'apply'
          || segment.action === 'reset-confirm' || segment.action === 'refresh-confirm' || segment.action === 'leave'
          ? 'primary' : 'secondary'))
      if (segment.escape) this.escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else if (segment.action !== undefined) {
        spans.push({ id: `bar:${segment.action}`, action: segment.action, startCol: span.startCol, endCol: span.endCol })
        if (segment.action === 'leave' || segment.action === 'refresh-confirm') this.paintedAction = true
      }
    }
    this.barSpans = spans
    // A dropped Confirm publishes neither a span nor the keyboard admission.
    if (!spans.some(span => span.action === 'apply' || span.action === 'reset-confirm')) this.paintedConfirm = false
    return fit(painted.join(ACTION_BAR_SEPARATOR), width)
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
      const rowTargets: BodyTarget[] = []
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
      const differs = source.kind === 'ready' ? source.overridden[field.key] === true : undefined
      const comparison = differs === undefined ? 'Unknown' : differs ? 'Differs from base' : 'Matches base'
      lines.push({
        text: color.textDim(`  Comparison: ${comparison}${stagedReset ? ' · Reset staged' : ''}${source.kind === 'ready' && !snapshot.current ? ' · Last-known · read-only' : ''}`),
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
      else if (segment.action !== undefined) {
        spans.push({ id: `bar:${segment.action}`, action: segment.action, startCol: span.startCol, endCol: span.endCol })
        if (segment.action === 'leave' || segment.action === 'refresh-confirm') this.paintedAction = true
      }
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
    this.question = undefined
    this.controller.dispose()
  }
}
