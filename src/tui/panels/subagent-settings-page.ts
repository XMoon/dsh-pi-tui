/** Subagent settings presentation inside the existing Settings Detail lease.
 * The controller owns every semantic draft, validation and Host write; this
 * page is the ONE grouped Detail TENANT for the two official sections. */
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { SubagentSettingsController, SubagentSettingsField, SubagentSettingsSnapshot, SubagentSectionSnapshot } from '../../app/command/subagent-settings.ts'
import type { ModelDirectoryDto } from '../../runtime/catalog-port.ts'
import type { SubagentAllowedModelRoute } from '../../runtime/config-port.ts'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import {
  projectSubagentAllowlist,
  allowlistRouteKey,
  allowlistSummary,
  type AllowlistCatalogState,
  type SubagentAllowlistModelRow,
} from '../pickers/subagent-model-menu.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { EmbeddedSpecialistPage, SpecialistParentLeaveTarget } from './settings-workspace-panel.ts'

export interface SubagentSettingsPageIntents {
  readonly controller: SubagentSettingsController
  readonly catalog: { loadDirectory(signal?: AbortSignal): Promise<ModelDirectoryDto> }
  readonly requestRender: () => void
  readonly done: () => void
  runOwned<T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void
}

type NumberField = 'maxDepth' | 'maxActiveSubagents'
type QuestionKind = 'discard' | 'refresh' | 'leave' | 'parent-leave'
type BodyAction =
  | { readonly kind: 'field'; readonly field: SubagentSettingsField }
  | { readonly kind: 'edit' | 'toggle' | 'manage' | 'details' | 'reset' | 'route-toggle' | 'search' | 'input' | 'accept' | 'discard' | 'refresh' }
  | { readonly kind: 'route'; readonly key: string }
type BarAction =
  | 'save' | 'refresh' | 'discard' | 'keep' | 'edit' | 'toggle' | 'manage' | 'details'
  | 'reset' | 'apply' | 'search' | 'search-done' | 'route-toggle' | 'leave' | 'refresh-confirm'
type BarSegment = ActionBarSegment & { readonly action?: BarAction; readonly escape?: boolean }
interface Target {
  readonly id: string
  readonly action: BodyAction
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}
interface BodyTarget extends Omit<Target, 'row'> {}
interface ContentLine {
  readonly text: string
  readonly targets?: readonly BodyTarget[]
  readonly field?: SubagentSettingsField
  readonly routeKey?: string
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
interface Question {
  readonly instance: number
  readonly kind: QuestionKind
  readonly leave?: () => void
}

const FIELDS = ['maxDepth', 'maxActiveSubagents', 'enabled', 'allowedModels'] as const
const NUMBER_FIELDS: readonly NumberField[] = ['maxDepth', 'maxActiveSubagents']
const LABELS: Record<SubagentSettingsField, string> = {
  maxDepth: 'Maximum depth',
  maxActiveSubagents: 'Parallelism',
  enabled: 'Enabled',
  allowedModels: 'Allowed models',
}
const FULL_LABELS: Record<SubagentSettingsField, string> = {
  maxDepth: 'Maximum recursion depth',
  maxActiveSubagents: 'Subagent parallelism limit',
  enabled: 'Enabled',
  allowedModels: 'Allowed models',
}
const SECTION_OF: Record<SubagentSettingsField, 'Limits' | 'Model selection'> = {
  maxDepth: 'Limits',
  maxActiveSubagents: 'Limits',
  enabled: 'Model selection',
  allowedModels: 'Model selection',
}
const LIMITS_EFFECT = 'Limits apply to new delegations; already running activations and child processes are unchanged.'
const SELECTION_EFFECT = 'Model selection is sampled by new top-level Sessions; the current Agent tool schema is unchanged.'
const SAVE_NOTE = 'Changes are staged until Save.'
const SCOPE = 'DSH Host profile · official settings'
// These local, deliberately non-rebindable keys supply both handlers and badges.
const KEYS = { save: 's', refresh: 'r', reset: 'x', discard: 'd', search: '/' } as const
const DETAILS_KEY = '?'
const GROUP_DISCARD = ['Discard unsaved changes?', 'Staged values are lost; nothing is written.'] as const
const GROUP_REFRESH = ['Refresh discards unsaved edits.', 'The staged values are lost.'] as const
const AMBIGUOUS_COPY = ['The Host may have applied changes.', 'Leaving does not undo them.'] as const

function fit(text: string, width: number): string {
  const line = truncateToWidth(text, Math.max(0, width), '…', false)
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}
function sectionWord(section: SubagentSectionSnapshot<object>): string {
  const kind = section.status?.kind
  if (kind === 'verified') return 'Verified'
  if (kind === 'not-saved') return 'Not saved'
  if (kind === 'unverified') return 'Unverified'
  if (kind === 'outcome-unconfirmed') return 'Outcome unconfirmed'
  if (kind === 'saving') return 'Saving…'
  if (section.source.kind !== 'ready') return section.source.kind === 'unavailable' ? 'Unavailable' : 'Unreadable'
  if (!section.current) return 'Last-known · read-only'
  return section.dirty ? 'Unsaved' : ''
}
function statusInk(kind: string | undefined, text: string): string {
  if (kind === 'verified') return color.success(text)
  if (kind === 'not-saved') return color.error(text)
  if (kind === 'unverified' || kind === 'outcome-unconfirmed') return color.warning(text)
  return color.textDim(text)
}
function bodyActionOf(kind: BodyAction['kind']): BarAction | undefined {
  switch (kind) {
    case 'edit': return 'edit'
    case 'toggle': return 'toggle'
    case 'manage': return 'manage'
    case 'details': return 'details'
    case 'reset': return 'reset'
    case 'discard': return 'discard'
    case 'refresh': return 'refresh'
    case 'route-toggle': return 'route-toggle'
    default: return undefined
  }
}

export class SubagentSettingsPage implements EmbeddedSpecialistPage {
  readonly title = 'Subagent settings'
  private readonly intents: SubagentSettingsPageIntents
  private readonly controller: SubagentSettingsController
  private _focused = false
  private disposed = false
  private rowGrant = 8
  private revision = 0
  private view: 'browse' | 'directory' = 'browse'
  private fieldIndex = 0
  private browseOffset = 0
  private directoryOffset = 0
  private revealSelection = true
  private selectedRoute: string | undefined
  private searching = false
  private readonly searchInput = new Input({ prompt: 'Search: ', placeholder: 'provider or model', placeholderStyle: color.textDim })
  private numberInput: { readonly field: NumberField; readonly input: Input } | undefined
  private advanced = false
  private fieldError: string | undefined
  private routeNotice: string | undefined
  private feedback: 'no-changes' | undefined
  private question: Question | undefined
  private nextQuestion = 0
  private paintedQuestion: string | undefined
  private waitNotice = false
  private catalog: AllowlistCatalogState = { state: 'loading' }
  private catalogAbort: AbortController | undefined
  private catalogAuthority: string | undefined
  private readonly identities = new WeakMap<object, number>()
  private nextIdentity = 0
  private paint: Paint | undefined
  private pressed: { readonly paint: Paint; readonly target: Target } | undefined
  private awaitingPaint = true
  private escapeSpan: { readonly startCol: number; readonly endCol: number } | undefined
  private barSpans: readonly { readonly id: string; readonly action: BarAction; readonly startCol: number; readonly endCol: number }[] = []
  private readonly paintedFields = new Set<SubagentSettingsField>()
  /** The synchronous local-action latch (stage/toggle/reset/save). */
  private handoff = 0
  /** The painted admission for the state's ONE main action (Stage). */
  private paintedConfirm = false
  /** The semantic actions whose COMPLETE span this frame really painted. */
  private paintedActions = new Set<BarAction>()
  private paintedSaveFacts = false
  private advancedSignature: string | undefined
  private advancedSeen = new Set<number>()
  private advancedFactLines: readonly number[] = []

  constructor(intents: SubagentSettingsPageIntents) {
    this.intents = intents
    this.controller = intents.controller
    this.controller.start()
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    if (value !== this._focused) {
      this._focused = value
      this.revoke()
    }
    this.searchInput.focused = value && this.searching
    if (this.numberInput !== undefined) this.numberInput.input.focused = value
  }

  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next === this.rowGrant) return
    this.rowGrant = next
    this.revealSelection = true
    this.advancedSignature = undefined
    this.advancedSeen.clear()
    this.advancedFactLines = []
    this.revoke()
  }
  grantAwaitingPaint(): boolean { return this.awaitingPaint }
  pointerFrameCurrent(): boolean {
    return this.paint !== undefined && !this.awaitingPaint && this.paint.identity === this.gestureIdentity()
  }
  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined { return this.escapeSpan }
  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] { return this.barSpans }
  blocksParentNavigation(): boolean {
    const snapshot = this.controller.snapshot()
    return snapshot.loading || snapshot.saving || snapshot.dirty || this.view === 'directory'
      || this.numberInput !== undefined || this.question !== undefined || this.advanced || this.handoff !== 0
  }

  /**
   * The ONE consumer of a user parent navigation: a clean page releases
   * immediately; a dirty page opens its OWN leave question and calls the
   * captured continuation only after the user explicitly confirms. Local
   * input/disclosure/directory/pending states keep the keys.
   */
  requestParentLeave(target: SpecialistParentLeaveTarget, leave: () => void): 'allow' | 'refuse' {
    if (this.disposed) return 'refuse'
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving || this.handoff !== 0) return 'refuse'
    if (this.numberInput !== undefined || this.advanced || this.question !== undefined
      || this.view === 'directory' || this.searching) return 'refuse'
    if (snapshot.dirty) {
      this.openQuestion('parent-leave', leave)
      return 'refuse'
    }
    return 'allow'
  }

  private identityOf(identity: object): number {
    let value = this.identities.get(identity)
    if (value === undefined) { value = ++this.nextIdentity; this.identities.set(identity, value) }
    return value
  }
  private authorityIdentity(snapshot: SubagentSettingsSnapshot): string {
    return ([snapshot.limits, snapshot.selection] as const).map(section => {
      const live = section.currentGeneration === undefined ? '' : this.identityOf(section.currentGeneration)
      return section.source.kind === 'ready'
        ? `${this.identityOf(section.source.generation)}:${section.source.revision}->${live}:${section.current}`
        : `${section.source.kind}:${section.source.reason}:${live}`
    }).join('|')
  }
  gestureIdentity(): string {
    const snapshot = this.controller.snapshot()
    return `${this.revision}|${snapshot.revision}|${this.authorityIdentity(snapshot)}|${snapshot.loading}|${snapshot.saving}`
      + `|${this._focused}|${this.view}|${this.advanced ? 'adv' : ''}|${this.numberInput === undefined ? '' : 'input'}`
      + `|${this.question === undefined ? '' : `${this.question.kind}:${this.question.instance}`}`
      + `|${this.fieldIndex}|${this.selectedRoute ?? ''}|${this.searching ? 'search' : ''}`
      + `|${this.catalogAuthority ?? ''}|${this.handoff === 0 ? '' : 'handoff'}|${this.feedback ?? ''}`
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
    this.paintedFields.clear()
  }
  private changed(): void { this.revoke(); this.intents.requestRender() }

  // ── field/section facts ──────────────────────────────────────────────────

  private sectionOf(snapshot: SubagentSettingsSnapshot, field: SubagentSettingsField): SubagentSectionSnapshot<object> {
    return (field === 'maxDepth' || field === 'maxActiveSubagents' ? snapshot.limits : snapshot.selection) as SubagentSectionSnapshot<object>
  }
  private editable(field: SubagentSettingsField, snapshot: SubagentSettingsSnapshot): boolean {
    const section = this.sectionOf(snapshot, field)
    return !snapshot.loading && !snapshot.saving && section.current && section.source.kind === 'ready'
  }
  private canSave(): boolean { return this.controller.canSave() }
  private ambiguous(snapshot: SubagentSettingsSnapshot): boolean {
    return (['unverified', 'outcome-unconfirmed'] as const).some(kind =>
      snapshot.limits.status?.kind === kind || snapshot.selection.status?.kind === kind)
  }
  private fieldValue(snapshot: SubagentSettingsSnapshot, field: SubagentSettingsField): string {
    const section = this.sectionOf(snapshot, field)
    if (section.source.kind !== 'ready') return 'Unknown'
    const reset = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string }>>>)[field]?.kind === 'reset'
    if (reset) return 'Reset staged'
    if (field === 'maxDepth') return snapshot.depthText === '' ? 'Reset staged' : snapshot.depthText
    if (field === 'maxActiveSubagents') return snapshot.capacityText === '' ? 'Reset staged' : snapshot.capacityText
    if (field === 'enabled') return snapshot.enabled === true ? 'On' : 'Off'
    return allowlistSummary(snapshot.allowedModels)
  }
  private effectiveValue(snapshot: SubagentSettingsSnapshot, field: SubagentSettingsField): string {
    const section = this.sectionOf(snapshot, field)
    if (section.source.kind !== 'ready') return 'Unknown'
    const source = section.source as Extract<typeof section.source, { kind: 'ready' }>
    if (field === 'maxDepth' || field === 'maxActiveSubagents') return String((source.effective as Record<string, unknown>)[field])
    if (field === 'enabled') return (source.effective as { enabled: boolean }).enabled ? 'On' : 'Off'
    return allowlistSummary((source.effective as { allowedModels: readonly SubagentAllowedModelRoute[] }).allowedModels)
  }
  private inheritedValue(snapshot: SubagentSettingsSnapshot, field: SubagentSettingsField): string {
    const section = this.sectionOf(snapshot, field)
    if (section.source.kind !== 'ready') return 'Unknown'
    const source = section.source as Extract<typeof section.source, { kind: 'ready' }>
    if (field === 'maxDepth' || field === 'maxActiveSubagents') return String((source.inherited as Record<string, unknown>)[field])
    if (field === 'enabled') return (source.inherited as { enabled: boolean }).enabled ? 'On' : 'Off'
    return allowlistSummary((source.inherited as { allowedModels: readonly SubagentAllowedModelRoute[] }).allowedModels)
  }
  private comparison(snapshot: SubagentSettingsSnapshot, field: SubagentSettingsField): string {
    const section = this.sectionOf(snapshot, field)
    if (section.source.kind !== 'ready') return 'Unknown'
    const overridden = (section.source as Extract<typeof section.source, { kind: 'ready' }>).overridden as Record<string, boolean>
    return overridden[field] === true ? 'Differs from base' : 'Matches base'
  }
  private requestedValue(snapshot: SubagentSettingsSnapshot, field: SubagentSettingsField): string | undefined {
    const section = this.sectionOf(snapshot, field)
    if (section.source.kind !== 'ready') return undefined
    const entry = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string; readonly value?: unknown }>>>)[field]
    if (entry === undefined) return undefined
    if (entry.kind === 'reset') return 'official unset'
    if (field === 'enabled') return entry.value === true ? 'On' : 'Off'
    if (field === 'allowedModels') return allowlistSummary(entry.value as readonly SubagentAllowedModelRoute[])
    return String(entry.value)
  }
  private dirtyCount(snapshot: SubagentSettingsSnapshot): number {
    return Object.keys(snapshot.limits.patch).length + Object.keys(snapshot.selection.patch).length
  }
  private dirtyCountText(snapshot: SubagentSettingsSnapshot): string {
    const total = this.dirtyCount(snapshot)
    const limits = Object.keys(snapshot.limits.patch).length
    const selection = Object.keys(snapshot.selection.patch).length
    if (limits > 0 && selection > 0) {
      return `${total} unsaved change${total === 1 ? '' : 's'} · Limits ${limits} · Model selection ${selection}`
    }
    return `${total} unsaved change${total === 1 ? '' : 's'} · ${limits > 0 ? 'Limits' : 'Model selection'}`
  }
  private fieldEffect(field: SubagentSettingsField, advanced = false): string {
    if (field === 'maxDepth' || field === 'maxActiveSubagents') {
      return advanced
        ? 'Applies to new delegations only; the next delegation samples it.'
        : LIMITS_EFFECT
    }
    return advanced
      ? 'Sampled by new top-level Sessions only; the current Agent tool schema is unchanged.'
      : SELECTION_EFFECT
  }

  // ── questions / local intents ─────────────────────────────────────────────

  private openQuestion(kind: QuestionKind, leave?: () => void): void {
    this.question = { instance: ++this.nextQuestion, kind, ...(leave === undefined ? {} : { leave }) }
    this.browseOffset = 0
    this.changed()
  }
  private keepEditing(): void { this.question = undefined; this.revealSelection = true; this.changed() }

  private acceptQuestion(): void {
    const question = this.question
    if (question === undefined || this.paintedQuestion !== this.questionIdentity()) return
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    const accepting: BarAction = question.kind === 'refresh'
      ? 'refresh-confirm'
      : question.kind === 'discard' ? 'discard' : 'leave'
    if (!this.paintedActions.has(accepting)) return
    this.question = undefined
    this.browseOffset = 0
    if (question.kind === 'refresh') {
      this.invalidateCatalog()
      this.controller.refresh(true)
      this.changed()
      return
    }
    if (question.kind === 'discard') {
      this.controller.discard()
      this.advanced = false
      this.feedback = undefined
      this.changed()
      return
    }
    const ambiguous = this.ambiguous(snapshot)
    // A definite leave discards the local intents; an ambiguous leave only
    // ACKNOWLEDGES the possible Host write (never a silent rollback claim).
    if (!ambiguous) this.controller.discard()
    this.advanced = false
    this.feedback = undefined
    this.changed()
    if (question.kind === 'parent-leave') question.leave?.()
    else this.intents.done()
  }

  private back(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) { this.waitNotice = true; this.changed(); return }
    if (this.handoff !== 0) return
    if (this.question !== undefined) { this.keepEditing(); return }
    if (this.numberInput !== undefined) {
      this.numberInput = undefined
      this.fieldError = undefined
      this.changed()
      return
    }
    if (this.advanced) {
      this.advanced = false
      this.advancedSignature = undefined
      this.advancedSeen.clear()
      this.advancedFactLines = []
      this.changed()
      return
    }
    if (this.view === 'directory') {
      if (this.searching) {
        this.searching = false
        this.searchInput.focused = false
      } else {
        this.view = 'browse'
        this.routeNotice = undefined
      }
      this.revealSelection = true
      this.changed()
      return
    }
    if (snapshot.dirty) this.openQuestion('leave')
    else this.intents.done()
  }
  /** Retire the old directory request/authority BEFORE a refresh callback; a
   *  stale result can never publish into the new capture. Query/selection/
   *  offsets stay local and the reload happens only after settlement with a
   *  real body grant. */
  private invalidateCatalog(): void {
    this.catalogAbort?.abort()
    this.catalogAbort = undefined
    this.catalogAuthority = undefined
    this.catalog = { state: 'loading' }
  }
  private refresh(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    if (snapshot.dirty) { this.openQuestion('refresh'); return }
    this.invalidateCatalog()
    this.controller.refresh()
    this.changed()
  }

  // ── browse / input / advanced / directory actions ─────────────────────────

  private openInput(): void {
    const field = FIELDS[this.fieldIndex]!
    if (field !== 'maxDepth' && field !== 'maxActiveSubagents') return
    if (!this.editable(field, this.controller.snapshot())) return
    const snapshot = this.controller.snapshot()
    const current = field === 'maxDepth' ? snapshot.depthText : snapshot.capacityText
    const input = new Input({ prompt: 'Value: ', placeholder: 'number', placeholderStyle: color.textDim })
    input.setValue(current)
    input.focused = this.focused
    this.numberInput = { field, input }
    this.fieldError = undefined
    this.feedback = undefined
    this.routeNotice = undefined
    this.browseOffset = 0
    this.changed()
  }
  private openAdvanced(): void {
    if (this.numberInput !== undefined || this.question !== undefined || this.view === 'directory') return
    if (this.sectionOf(this.controller.snapshot(), FIELDS[this.fieldIndex]!).source.kind !== 'ready') return
    this.advanced = true
    this.browseOffset = 0
    this.advancedSignature = undefined
    this.advancedSeen.clear()
    this.advancedFactLines = []
    this.changed()
  }
  private openDirectory(): void {
    if (this.view === 'directory') return
    if (!this.editable('allowedModels', this.controller.snapshot())) return
    this.view = 'directory'
    this.revealSelection = true
    this.routeNotice = undefined
    this.loadDirectory(false)
    this.changed()
  }
  private enterSearch(): void {
    if (this.view !== 'directory' || this.searching) return
    this.searching = true
    this.searchInput.focused = this._focused
    this.changed()
  }
  private completeSearch(): void {
    if (!this.searching) return
    this.searching = false
    this.searchInput.focused = false
    this.changed()
  }
  private selectField(field: SubagentSettingsField): void {
    const index = FIELDS.indexOf(field)
    if (index < 0 || index === this.fieldIndex) return
    this.fieldIndex = index
    this.revealSelection = true
    this.feedback = undefined
    this.changed()
  }
  private moveField(delta: number, wrap: boolean): void {
    const count = FIELDS.length
    const raw = this.fieldIndex + delta
    const next = wrap ? (raw + count) % count : Math.min(Math.max(0, raw), count - 1)
    if (next === this.fieldIndex) return
    this.fieldIndex = next
    this.revealSelection = true
    this.feedback = undefined
    this.changed()
  }
  private directoryModels(snapshot: SubagentSettingsSnapshot): readonly SubagentAllowlistModelRow[] {
    const query = this.searchInput.getValue().trim().toLowerCase()
    return projectSubagentAllowlist({ catalog: this.catalog, allowed: snapshot.allowedModels }).models.filter(row =>
      `${row.providerId} ${row.providerName} ${row.modelId} ${row.modelName ?? ''}`.toLowerCase().includes(query))
  }
  private ensureRouteSelection(models: readonly SubagentAllowlistModelRow[]): void {
    if (models.some(row => allowlistRouteKey(row.providerId, row.modelId) === this.selectedRoute)) return
    const first = models.find(row => row.allowed) ?? models[0]
    this.selectedRoute = first === undefined ? undefined : allowlistRouteKey(first.providerId, first.modelId)
  }
  private moveRoute(delta: number): void {
    const models = this.directoryModels(this.controller.snapshot())
    this.ensureRouteSelection(models)
    const index = models.findIndex(row => allowlistRouteKey(row.providerId, row.modelId) === this.selectedRoute)
    const next = models[Math.max(0, Math.min(models.length - 1, index + delta))]
    this.selectedRoute = next === undefined ? undefined : allowlistRouteKey(next.providerId, next.modelId)
    this.revealSelection = true
    this.routeNotice = undefined
    this.changed()
  }
  private selectedModel(snapshot: SubagentSettingsSnapshot): SubagentAllowlistModelRow | undefined {
    const models = this.directoryModels(snapshot)
    this.ensureRouteSelection(models)
    return models.find(row => allowlistRouteKey(row.providerId, row.modelId) === this.selectedRoute)
  }
  private routeBlockReason(snapshot: SubagentSettingsSnapshot, model: SubagentAllowlistModelRow): string | undefined {
    if (!model.allowed) return undefined
    if (snapshot.allowedModels.length === 1 && snapshot.enabled === true) {
      return 'Disable model selection before removing the last route.'
    }
    return undefined
  }
  private routeActionLabel(snapshot: SubagentSettingsSnapshot, model: SubagentAllowlistModelRow): string | undefined {
    if (!this.editable('allowedModels', snapshot)) return undefined
    if (this.routeBlockReason(snapshot, model) !== undefined) return undefined
    return model.allowed ? 'Remove route [Enter]' : 'Add route [Enter]'
  }

  // ── local commits (callbacks may re-enter synchronously) ──────────────────

  private beginLocal(): number {
    this.revoke()
    this.pressed = undefined
    return ++this.handoff
  }
  private endLocal(token: number): void {
    if (!this.disposed && this.handoff === token) {
      this.handoff = 0
      this.intents.requestRender()
    }
  }
  private stageInput(): void {
    const active = this.numberInput
    if (active === undefined || this.disposed || this.handoff !== 0) return
    if (!this.paintedConfirm) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) return
    const raw = active.input.getValue()
    const issue = this.controller.numberIssue(active.field, raw)
    if (issue !== undefined) {
      this.fieldError = issue
      this.changed()
      return
    }
    if (!this.editable(active.field, snapshot)) {
      this.fieldError = 'Host settings changed or are unavailable; cancel and refresh.'
      this.changed()
      return
    }
    const captured = snapshot.limits.source
    const token = this.beginLocal()
    this.numberInput = undefined
    this.fieldError = undefined
    this.feedback = undefined
    try {
      this.controller.setNumber(active.field, raw)
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== token) return
      const value = Number(raw)
      const expected = captured.kind === 'ready' && value === captured.effective[active.field]
        ? undefined
        : { kind: 'set' as const, value }
      const patchEntry = staged.limits.patch[active.field]
      const accepted = staged.notice === undefined
        && staged.limits.current && staged.limits.source.kind === 'ready'
        && captured.kind === 'ready'
        && staged.limits.source.revision === captured.revision
        && staged.limits.source.generation === captured.generation
        && (expected === undefined
          ? patchEntry === undefined
          : patchEntry?.kind === 'set' && patchEntry.value === value)
      if (!accepted) {
        this.numberInput = active
        this.fieldError = staged.notice ?? 'Host settings changed or are unavailable; cancel and refresh.'
        this.changed()
        return
      }
      this.advanced = false
      this.feedback = staged.dirty ? undefined : 'no-changes'
      this.revealSelection = true
      this.browseOffset = 0
    } finally {
      this.endLocal(token)
    }
  }
  private stageToggle(): void {
    if (this.disposed || this.handoff !== 0) return
    const snapshot = this.controller.snapshot()
    if (!this.editable('enabled', snapshot)) return
    if (!this.paintedActions.has('toggle')) return
    const captured = snapshot.selection.source
    const candidate = snapshot.enabled === true
    const next = !candidate
    const token = this.beginLocal()
    try {
      this.controller.toggleEnabled()
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== token) return
      const expected = captured.kind === 'ready' && next === captured.effective.enabled
        ? undefined
        : { kind: 'set' as const, value: next }
      const patchEntry = staged.selection.patch.enabled
      const accepted = staged.notice === undefined
        && staged.selection.current && staged.selection.source.kind === 'ready'
        && captured.kind === 'ready'
        && staged.selection.source.revision === captured.revision
        && staged.selection.source.generation === captured.generation
        && (expected === undefined
          ? patchEntry === undefined
          : patchEntry?.kind === 'set' && patchEntry.value === next)
      if (!accepted) {
        this.fieldError = staged.notice ?? 'Host settings changed or are unavailable; cancel and refresh.'
      } else {
        this.fieldError = undefined
        this.feedback = staged.dirty ? undefined : 'no-changes'
        this.revealSelection = true
      }
    } finally {
      this.endLocal(token)
    }
  }
  private stageRouteToggle(): void {
    if (this.disposed || this.handoff !== 0 || this.searching || this.view !== 'directory') return
    const snapshot = this.controller.snapshot()
    if (!this.editable('allowedModels', snapshot)) return
    if (!this.paintedActions.has('route-toggle')) return
    const model = this.selectedModel(snapshot)
    if (model === undefined) return
    const blocked = this.routeBlockReason(snapshot, model)
    if (blocked !== undefined) { this.routeNotice = blocked; this.changed(); return }
    const route = { provider: model.providerId, model: model.modelId }
    const token = this.beginLocal()
    try {
      this.controller.toggleRoute(route)
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== token) return
      if (staged.notice !== undefined) {
        this.routeNotice = staged.notice
      } else {
        this.routeNotice = undefined
        this.revealSelection = true
      }
    } finally {
      this.endLocal(token)
    }
  }
  private stageAdvancedReset(): void {
    if (this.disposed || this.handoff !== 0 || !this.advanced) return
    if (!this.paintedActions.has('reset')) return
    const facts = this.advancedFactLines
    if (facts.length === 0 || !facts.every(line => this.advancedSeen.has(line))) return
    const snapshot = this.controller.snapshot()
    const field = FIELDS[this.fieldIndex]!
    if (!this.editable(field, snapshot)) return
    const captured = this.sectionOf(snapshot, field).source
    const token = this.beginLocal()
    try {
      this.controller.reset(field)
      const staged = this.controller.snapshot()
      if (this.disposed || this.handoff !== token) return
      const section = this.sectionOf(staged, field)
      const entry = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string }>>>)[field]
      const accepted = staged.notice === undefined && section.current && section.source.kind === 'ready'
        && captured.kind === 'ready' && section.source.revision === captured.revision
        && section.source.generation === captured.generation && entry?.kind === 'reset'
      if (!accepted) {
        this.fieldError = staged.notice ?? 'Host settings changed or are unavailable; cancel and refresh.'
        this.changed()
        return
      }
      this.advanced = false
      this.fieldError = undefined
      this.feedback = undefined
      this.revealSelection = true
      this.browseOffset = 0
    } finally {
      this.endLocal(token)
    }
  }
  private saveGroup(): void {
    if (this.disposed || this.handoff !== 0) return
    const snapshot = this.controller.snapshot()
    if (snapshot.saving || !this.canSave()) return
    if (this.numberInput !== undefined || this.advanced || this.view === 'directory') return
    const question = this.question
    if (question !== undefined) {
      if (question.kind !== 'leave' && question.kind !== 'parent-leave') return
      if (this.paintedQuestion !== this.questionIdentity()) return
      if (this.ambiguous(snapshot)) return
    }
    if (!this.paintedActions.has('save')) return
    if (question === undefined && !this.paintedSaveFacts) return
    this.question = undefined
    this.feedback = undefined
    this.browseOffset = 0
    this.revealSelection = false
    const token = this.beginLocal()
    try {
      this.controller.save()
      if (this.disposed || this.handoff !== token) return
      this.revoke()
    } finally {
      this.endLocal(token)
    }
  }

  // ── catalog authority ─────────────────────────────────────────────────────

  private loadDirectory(force: boolean): void {
    const authority = this.authorityIdentity(this.controller.snapshot())
    if (!force && this.catalogAuthority === authority) return
    this.catalogAbort?.abort()
    const abort = new AbortController()
    this.catalogAbort = abort
    this.catalogAuthority = authority
    this.catalog = { state: 'loading' }
    this.intents.runOwned('subagent settings model directory', () => this.intents.catalog.loadDirectory(abort.signal), {
      isCancellation: () => this.disposed || abort.signal.aborted || authority !== this.authorityIdentity(this.controller.snapshot()),
      onResult: directory => {
        if (this.disposed || abort.signal.aborted || authority !== this.authorityIdentity(this.controller.snapshot())) return
        this.catalog = { state: 'ready', directory }
        this.changed()
      },
      onError: error => {
        if (this.disposed || abort.signal.aborted || authority !== this.authorityIdentity(this.controller.snapshot())) return
        this.catalog = { state: 'failed', reason: safeErrorMessage(error) }
        this.changed()
      },
    })
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    // Any local commit callback may synchronously re-enter; it never starts a
    // second stage/save/reset of the same gesture.
    if (this.handoff !== 0) return
    // The action admission is the identity of the frame the user ACTUALLY saw,
    // captured before this key advances the local input revision. Pointer paths
    // use the same fact through their painted box/gesture identity.
    const frameCurrent = this.pointerFrameCurrent()
    this.revision += 1
    this.pressed = undefined
    const snapshot = this.controller.snapshot()
    if (matchesKey(data, 'escape')) { this.back(); return }
    if (snapshot.saving) return
    const bodyRows = Math.max(0, this.rowGrant - 1)
    // A zero-body grant keeps ONLY its real Back/Cancel/Keep/Wait: no input,
    // read, write or local field move reaches a body the user cannot see.
    if (bodyRows < 1) {
      if (matchesKey(data, 'left')) this.back()
      return
    }
    if (this.question !== undefined) { this.handleQuestionInput(data, snapshot, frameCurrent); return }
    if (this.numberInput !== undefined) {
      if (matchesKey(data, 'enter')) {
        if (!frameCurrent) { this.changed(); return }
        this.stageInput()
      } else {
        this.numberInput.input.handleInput(data)
        this.fieldError = undefined
        this.changed()
      }
      return
    }
    if (this.advanced) {
      if (this.scrollKey(data)) { this.scroll(data); return }
      if (data === DETAILS_KEY || matchesKey(data, 'left')) { this.back(); return }
      if (matchesKey(data, KEYS.reset) && this.paintedActions.has('reset')) {
        if (!frameCurrent) { this.changed(); return }
        this.stageAdvancedReset()
        return
      }
      return
    }
    if (this.view === 'directory') { this.handleDirectoryInput(data, snapshot, frameCurrent); return }
    this.handleBrowseInput(data, snapshot, frameCurrent)
  }

  private handleQuestionInput(data: string, snapshot: SubagentSettingsSnapshot, frameCurrent: boolean): void {
    if (this.scrollKey(data)) { this.scroll(data); return }
    const question = this.question!
    if (question.kind === 'refresh') {
      if (matchesKey(data, KEYS.refresh) || matchesKey(data, 'enter')) {
        if (!frameCurrent) { this.changed(); return }
        this.acceptQuestion()
      }
      return
    }
    if (question.kind === 'discard') {
      if (data === KEYS.discard || data === KEYS.discard.toUpperCase()) {
        if (!frameCurrent) { this.changed(); return }
        this.acceptQuestion()
      } else if (matchesKey(data, 'left')) this.keepEditing()
      return
    }
    if (data === KEYS.discard || data === KEYS.discard.toUpperCase()) {
      if (!frameCurrent) { this.changed(); return }
      this.acceptQuestion()
      return
    }
    if (matchesKey(data, KEYS.save)) {
      if (!frameCurrent) { this.changed(); return }
      this.saveGroup()
      return
    }
    if (matchesKey(data, 'left')) this.keepEditing()
  }

  private handleDirectoryInput(data: string, snapshot: SubagentSettingsSnapshot, frameCurrent: boolean): void {
    if (this.searching) {
      if (matchesKey(data, 'enter') || matchesKey(data, 'tab')) { this.completeSearch(); return }
      this.searchInput.handleInput(data)
      this.revealSelection = true
      this.routeNotice = undefined
      this.changed()
      return
    }
    if (matchesKey(data, 'up')) { this.moveRoute(-1); return }
    if (matchesKey(data, 'down')) { this.moveRoute(1); return }
    if (matchesKey(data, 'tab')) { this.moveRoute(1); return }
    if (matchesKey(data, 'shift+tab')) { this.moveRoute(-1); return }
    if (this.scrollKey(data)) { this.scroll(data); return }
    if (matchesKey(data, KEYS.search)) { this.enterSearch(); return }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      if (!frameCurrent) { this.changed(); return }
      this.stageRouteToggle()
      return
    }
    if (matchesKey(data, KEYS.refresh) && this.paintedActions.has('refresh')) {
      if (!frameCurrent) { this.changed(); return }
      this.refresh()
      return
    }
    if (matchesKey(data, 'left')) { this.back(); return }
  }

  private handleBrowseInput(data: string, snapshot: SubagentSettingsSnapshot, frameCurrent: boolean): void {
    const business = matchesKey(data, 'enter') || matchesKey(data, 'right')
      || data === DETAILS_KEY || matchesKey(data, KEYS.save) || matchesKey(data, KEYS.discard)
      || matchesKey(data, KEYS.refresh)
    if (business && !frameCurrent) { this.changed(); return }
    if (matchesKey(data, 'up')) { this.moveField(-1, false); return }
    if (matchesKey(data, 'down')) { this.moveField(1, false); return }
    if (matchesKey(data, 'tab')) { this.moveField(1, true); return }
    if (matchesKey(data, 'shift+tab')) { this.moveField(-1, true); return }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) { this.activateFieldAction(snapshot); return }
    if (matchesKey(data, 'left')) { this.back(); return }
    if (data === DETAILS_KEY) {
      if (this.paintedActions.has('details')) this.openAdvanced()
      return
    }
    if (matchesKey(data, KEYS.save)) { this.saveGroup(); return }
    if (matchesKey(data, KEYS.discard) && snapshot.dirty && !this.ambiguous(snapshot)
      && this.paintedActions.has('discard')) { this.openQuestion('discard'); return }
    if (matchesKey(data, KEYS.refresh) && this.paintedActions.has('refresh')) {
      this.refresh()
      return
    }
    if (this.scrollKey(data)) this.scroll(data)
  }

  private activateFieldAction(snapshot: SubagentSettingsSnapshot): void {
    const field = FIELDS[this.fieldIndex]!
    if (!this.editable(field, snapshot)) return
    // A manual scroll that hides the selected field first reveals it and waits
    // for a fresh frame; it never activates an offscreen action.
    if (!this.paintedFields.has(field)) {
      this.revealSelection = true
      this.changed()
      return
    }
    if (!this.paintedActions.has(this.fieldActionOf(field))) {
      this.revealSelection = true
      this.changed()
      return
    }
    if (field === 'maxDepth' || field === 'maxActiveSubagents') this.openInput()
    else if (field === 'enabled') this.stageToggle()
    else this.openDirectory()
  }
  private fieldActionOf(field: SubagentSettingsField): BarAction {
    return field === 'enabled' ? 'toggle' : field === 'allowedModels' ? 'manage' : 'edit'
  }

  private scrollKey(data: string): boolean {
    return matchesKey(data, 'up') || matchesKey(data, 'down')
      || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
      || matchesKey(data, 'home') || matchesKey(data, 'end')
  }
  private scroll(data: string): void {
    const page = matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
    const step = page ? Math.max(1, Math.max(1, this.rowGrant - 1) - 2) : 1
    const delta = matchesKey(data, 'up') || matchesKey(data, 'pageUp') ? -step
      : matchesKey(data, 'home') ? -Number.MAX_SAFE_INTEGER
        : matchesKey(data, 'end') ? Number.MAX_SAFE_INTEGER
          : step
    const key = this.view === 'directory' && this.question === undefined ? 'directoryOffset' : 'browseOffset'
    this[key] = Math.max(0, this[key] + delta)
    this.revealSelection = false
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
      case 'discard': if (this.question !== undefined) this.acceptQuestion(); else this.openQuestion('discard'); break
      case 'keep': this.keepEditing(); break
      case 'edit':
      case 'toggle':
      case 'manage': this.activateFieldAction(snapshot); break
      case 'details': this.openAdvanced(); break
      case 'reset': this.stageAdvancedReset(); break
      case 'apply': this.stageInput(); break
      case 'search': this.enterSearch(); break
      case 'search-done': this.completeSearch(); break
      case 'route-toggle': this.stageRouteToggle(); break
      case 'leave': this.acceptQuestion(); break
      case 'refresh-confirm': this.acceptQuestion(); break
    }
  }

  // ── pointer ───────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const pressed = this.pressed
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
      if (this.numberInput !== undefined || event.y < paint.scrollStart || event.y >= paint.scrollEnd || !event.wheelDelta) return undefined
      this.scroll(event.wheelDelta < 0 ? 'up' : 'down')
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
      if (target.action.kind === 'accept') this.acceptQuestion()
      return
    }
    switch (target.action.kind) {
      case 'field':
        if (this.numberInput === undefined && this.view === 'browse') this.selectField(target.action.field)
        break
      case 'edit':
      case 'toggle':
      case 'manage': if (this.numberInput === undefined) this.activateFieldAction(snapshot); break
      case 'details': this.openAdvanced(); break
      case 'reset': if (this.numberInput === undefined) this.stageAdvancedReset(); break
      case 'route': if (this.searching) break; if (this.view === 'directory') { this.selectedRoute = target.action.key; this.revealSelection = true; this.routeNotice = undefined; this.changed() }; break
      case 'route-toggle': this.stageRouteToggle(); break
      case 'search':
        if (!this.searching) this.enterSearch()
        else { this.searchInput.handleMouse({ ...event, type: 'press', y: 0, height: 1 }); this.changed() }
        break
      case 'input': this.numberInput?.input.handleMouse({ ...event, type: 'press', y: 0, height: 1 }); this.changed(); break
      case 'discard': if (snapshot.dirty && !this.ambiguous(snapshot) && this.paintedActions.has('discard')) this.openQuestion('discard'); break
      case 'refresh': this.refresh(); break
      case 'accept': break
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    const snapshot = this.controller.snapshot()
    const bodyRows = Math.max(0, this.rowGrant - 1)
    // A bar-only grant starts no new read; the current authority read resumes
    // only once the pane really grants body rows again.
    if (bodyRows > 0 && this.question === undefined && this.view === 'directory'
      && !snapshot.loading && this.catalogAuthority !== this.authorityIdentity(snapshot)) {
      this.loadDirectory(true)
    }
    return this.renderTenant(width, snapshot)
  }

  private renderTenant(width: number, snapshot: SubagentSettingsSnapshot): string[] {
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const lines: string[] = []
    const targets: Target[] = []
    this.escapeSpan = undefined
    this.barSpans = []
    this.paintedQuestion = undefined
    this.paintedConfirm = false
    this.paintedActions.clear()
    this.paintedSaveFacts = false
    this.paintedFields.clear()
    let content: ContentLine[]
    let mustSee: readonly number[] = []
    let acceptLine: number | undefined
    let saveFacts: { readonly count?: readonly number[]; readonly dirty: readonly { readonly lines: readonly number[]; readonly complete: boolean }[] } = { dirty: [] }
    let inputAdmissible = true
    let advancedAction: ContentLine | undefined
    let advancedFacts: readonly number[] = []
    let fixedRows = 0
    let scrollStart = 0
    let scrollEnd = bodyRows
    let maxOffset = 0
    let offset = 0
    if (this.question !== undefined) {
      const built = this.questionLines(width, snapshot)
      content = built.lines
      mustSee = built.mustSee
      acceptLine = built.acceptLine
    } else if (this.numberInput !== undefined) {
      const built = this.inputLines(width, snapshot)
      content = built.lines
      mustSee = built.critical
      inputAdmissible = built.admissible
    } else if (this.advanced) {
      const built = this.advancedLines(width, snapshot)
      content = built.lines
      advancedFacts = built.facts
      advancedAction = built.action
    } else if (this.view === 'directory') {
      const built = this.directoryLines(width, snapshot)
      const search = this.searchRow(width)
      if (search !== undefined && bodyRows > 0 && (this.searching || bodyRows >= 3)) {
        fixedRows = 1
        scrollStart = 1
      }
      content = built
    } else {
      const built = this.browseLines(width, snapshot)
      content = built.lines
      saveFacts = built.saveFacts
    }
    const viewport = Math.max(0, bodyRows - fixedRows)
    const baseMaxOffset = Math.max(0, content.length - viewport)
    // A question/Input/Advanced owns the existing browse scroll coordinate. A
    // directory question must not consume or re-anchor the directory offset.
    const directoryScroll = this.view === 'directory' && this.question === undefined
    offset = Math.min(Math.max(0, directoryScroll ? this.directoryOffset : this.browseOffset), baseMaxOffset)
    if (this.view === 'browse' && this.revealSelection && this.question === undefined && this.numberInput === undefined && !this.advanced) {
      const settlement = snapshot.notice !== undefined
        || snapshot.limits.status !== undefined && snapshot.limits.status.kind !== 'verified'
        || snapshot.selection.status !== undefined && snapshot.selection.status.kind !== 'verified'
      const span = this.selectedFieldSpan(content)
      if (!settlement && span !== undefined && viewport > 0) {
        if (span.start < offset) offset = span.start
        if (span.end > offset + viewport) offset = Math.max(span.start, span.end - viewport)
        offset = Math.min(Math.max(0, offset), baseMaxOffset)
      }
    }
    if (directoryScroll && this.revealSelection && viewport > 0) {
      const span = this.selectedRouteSpan(content)
      if (span !== undefined) {
        if (span.start < offset) offset = span.start
        if (span.end > offset + viewport) offset = Math.max(span.start, span.end - viewport)
        offset = Math.min(Math.max(0, offset), baseMaxOffset)
      }
    }
    this.revealSelection = false
    // The grouped Advanced publishes Reset only once this disclosure instance's
    // complete necessary facts were really painted.
    let resetReady = false
    if (this.advanced && advancedAction !== undefined) {
      const signature = `${this.fieldIndex}|${width}|${this.rowGrant}|${this.authorityIdentity(snapshot)}|${advancedFacts.join(',')}`
      if (this.advancedSignature !== signature) {
        this.advancedSignature = signature
        this.advancedSeen.clear()
      }
      this.advancedFactLines = advancedFacts
      for (let index = 0; index < viewport; index += 1) this.advancedSeen.add(offset + index)
      resetReady = advancedFacts.length > 0 && advancedFacts.every(line => this.advancedSeen.has(line))
      if (resetReady) content = [...content, advancedAction]
    } else if (this.advancedFactLines.length > 0) {
      this.advancedFactLines = []
      this.advancedSeen.clear()
    }
    const maxAfterAction = Math.max(0, content.length - viewport)
    offset = Math.min(Math.max(0, offset), maxAfterAction)
    maxOffset = maxAfterAction
    if (directoryScroll) this.directoryOffset = offset
    else this.browseOffset = offset
    if (this.view === 'directory' && fixedRows === 1) {
      const search = this.searchRow(width)!
      lines.push(fit(search.text, width))
      for (const target of search.targets ?? []) targets.push({ ...target, row: 0 })
    }
    const visible = new Set<number>()
    let acceptPainted = false
    const routeDetailLines = this.view === 'directory' && this.selectedRoute !== undefined
      ? content.flatMap((line, index) => line.routeKey === this.selectedRoute ? [index] : [])
      : []
    const routeActionRead = routeDetailLines.length > 0
      && routeDetailLines.every(lineIndex => lineIndex >= offset && lineIndex < offset + viewport)
    const questionFrameComplete = this.question !== undefined
      && mustSee.every(lineIndex => lineIndex >= offset && lineIndex < offset + viewport)
    for (let index = 0; index < viewport; index += 1) {
      const line = content[offset + index]
      const hiddenRouteAction = !routeActionRead
        && (line?.targets?.some(target => target.action.kind === 'route-toggle') ?? false)
      const suppressed = hiddenRouteAction
        || this.question !== undefined && questionFrameComplete === false
        && acceptLine !== undefined && offset + index === acceptLine
      lines.push(fit(suppressed ? '' : line?.text ?? '', width))
      visible.add(offset + index)
      if (suppressed) continue
      if (line?.field !== undefined) this.paintedFields.add(line.field)
      for (const target of line?.targets ?? []) {
        targets.push({ ...target, row: fixedRows + index })
        if (target.action.kind === 'accept') acceptPainted = true
        const action = bodyActionOf(target.action.kind)
        if (action !== undefined) this.paintedActions.add(action)
      }
    }
    const questionRead = this.question !== undefined && questionFrameComplete
    if (questionRead) this.paintedQuestion = this.questionIdentity()
    if (questionRead && acceptPainted) {
      this.paintedActions.add(this.question!.kind === 'refresh'
        ? 'refresh-confirm'
        : this.question!.kind === 'discard' ? 'discard' : 'leave')
    }
    const frameComplete = mustSee.every(lineIndex => visible.has(lineIndex)) && inputAdmissible
    this.paintedSaveFacts = (saveFacts.count !== undefined && saveFacts.count.every(lineIndex => visible.has(lineIndex)))
      || saveFacts.dirty.some(block => block.complete && block.lines.length > 0
        && block.lines.every(lineIndex => visible.has(lineIndex)))
    while (lines.length < bodyRows) lines.push(fit('', width))
    lines.push(this.renderBar(snapshot, width, questionRead, frameComplete, maxOffset > 0, resetReady, routeActionRead))
    this.awaitingPaint = false
    this.paint = {
      width, rows: this.rowGrant, identity: this.gestureIdentity(), targets, maxOffset,
      scrollStart: fixedRows, scrollEnd: Math.max(fixedRows, bodyRows),
    }
    return lines
  }

  private selectedFieldSpan(content: readonly ContentLine[]): { readonly start: number; readonly end: number } | undefined {
    const field = FIELDS[this.fieldIndex]
    let start = -1
    let end = -1
    content.forEach((line, index) => {
      if (line.field !== field) return
      if (start < 0) start = index
      end = index + 1
    })
    return start < 0 ? undefined : { start, end }
  }
  private selectedRouteSpan(content: readonly ContentLine[]): { readonly start: number; readonly end: number } | undefined {
    let start = -1
    let end = -1
    content.forEach((line, index) => {
      if (line.routeKey === undefined || line.routeKey !== this.selectedRoute) return
      if (start < 0) start = index
      end = index + 1
    })
    return start < 0 ? undefined : { start, end }
  }

  // ── content builders ──────────────────────────────────────────────────────

  private note(text: string, width: number, tone: (text: string) => string = color.textDim): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(line => ({ text: tone(line) }))
  }
  private fact(label: string, value: string, width: number, ink: (text: string) => string = color.text, pad = 0): { lines: ContentLine[]; complete: boolean } {
    const text = sanitizedPhysicalLine(value)
    const valueWidth = visibleWidth(text)
    const gap = Math.max(2, pad - visibleWidth(label))
    if (visibleWidth(label) + gap + valueWidth <= width) {
      return { lines: [{ text: color.textDim(label) + ' '.repeat(gap) + ink(text) }], complete: true }
    }
    const lines: ContentLine[] = wrapTextWithAnsi(sanitizedPhysicalLine(label), Math.max(1, width))
      .map(line => ({ text: color.textDim(line) }))
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
  private proseFact(label: string, value: string, width: number, pad = 0): ContentLine[] {
    const gap = Math.max(2, pad - visibleWidth(label))
    if (visibleWidth(label) + gap + visibleWidth(sanitizedPhysicalLine(value)) <= width) {
      return [{ text: color.textDim(label) + ' '.repeat(gap) + color.textDim(sanitizedPhysicalLine(value)) }]
    }
    const lines: ContentLine[] = [{ text: color.textDim(label) }]
    for (const line of wrapTextWithAnsi(sanitizedPhysicalLine(value), Math.max(1, width - 2))) {
      lines.push({ text: `  ${color.textDim(line)}` })
    }
    return lines
  }
  private routeIdentityLines(
    label: string,
    routes: readonly SubagentAllowedModelRoute[],
    width: number,
    ink: (text: string) => string = color.textDim,
  ): ContentLine[] {
    const lines: ContentLine[] = [{ text: ink(sanitizedPhysicalLine(label)) }]
    if (routes.length === 0) lines.push({ text: ink('  None') })
    for (const route of routes) {
      for (const fragment of wrapTextWithAnsi(sanitizedPhysicalLine(`  ${route.provider} / ${route.model}`), Math.max(1, width))) {
        lines.push({ text: ink(fragment) })
      }
    }
    return lines
  }
  private bodyAction(label: string, action: BodyAction, width: number): ContentLine {
    if (visibleWidth(label) > width) return { text: '' }
    const suffix = action.kind === 'field' ? `:${action.field}` : ''
    return { text: color.primary(label), targets: [{ id: `${action.kind}${suffix}`, action, startCol: 0, endCol: visibleWidth(label) }] }
  }
  private acceptAction(label: string, width: number): ContentLine {
    if (visibleWidth(label) > width) return { text: '' }
    return { text: color.primary(label), targets: [{ id: 'accept', action: { kind: 'accept' }, startCol: 0, endCol: visibleWidth(label) }] }
  }

  private sectionFacts(snapshot: SubagentSettingsSnapshot, width: number): ContentLine[] {
    const lines: ContentLine[] = []
    const copyWidth = Math.min(width, 72)
    for (const [name, section] of [['Limits', snapshot.limits], ['Selection', snapshot.selection]] as const) {
      const kind = section.status?.kind
      const stale = section.source.kind === 'ready' && !section.current
      if (kind !== undefined) {
        if (kind === 'verified' && stale) {
          // A previous verification is history, never a certificate that an old
          // source is current.
          lines.push(...this.fact(name, 'Last-known · read-only', width, color.warning).lines)
          lines.push(...this.note('Previous save verified; refresh to review.', copyWidth, color.textDim))
        } else {
          lines.push({ text: color.textDim(`${name}:`) + ' ' + statusInk(kind, sectionWord(section)) })
          if (stale) lines.push(...this.note('Last-known · read-only', copyWidth, color.warning))
          if (kind !== 'verified' && kind !== 'saving') lines.push(...this.note(section.status!.text, copyWidth))
        }
      } else if (section.source.kind !== 'ready') {
        lines.push(...this.fact(name, section.source.kind === 'unavailable' ? 'Unavailable' : 'Unreadable', width, color.error).lines)
        lines.push(...this.note(section.source.reason, copyWidth, color.error))
      } else if (!section.current) {
        lines.push(...this.fact(name, 'Last-known · read-only', width, color.warning).lines)
      }
    }
    return lines
  }

  private browseLines(width: number, snapshot: SubagentSettingsSnapshot): {
    lines: ContentLine[]
    saveFacts: { readonly count?: readonly number[]; readonly dirty: readonly { readonly lines: readonly number[]; readonly complete: boolean }[] }
  } {
    const lines: ContentLine[] = []
    const dirtyBlocks: { lines: number[]; complete: boolean }[] = []
    let countLines: readonly number[] | undefined
    const copyWidth = Math.min(width, 72)
    const rowWidth = Math.min(width, 64)
    if (snapshot.loading) {
      lines.push({ text: color.textDim('Loading Host settings…') })
      return { lines, saveFacts: { dirty: dirtyBlocks } }
    }
    lines.push(...this.sectionFacts(snapshot, width))
    if (this.feedback === 'no-changes') lines.push(...this.fact('Status', 'No changes', width, color.textDim).lines)
    if (snapshot.notice !== undefined && snapshot.notice !== this.fieldError) {
      lines.push(...this.note(snapshot.notice, copyWidth, color.error))
    }
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    if (this.waitNotice && snapshot.saving) lines.push(...this.note('Dispatched writes continue.', copyWidth))
    // The real dirty count is a TOP fact: a short grant must never hide the
    // total/sub-counts behind the fields it describes.
    if (snapshot.dirty) {
      const fragments = wrapTextWithAnsi(this.dirtyCountText(snapshot), copyWidth)
      const start = lines.length
      for (const fragment of fragments) lines.push({ text: color.text(fragment) })
      countLines = fragments.map((_, offset) => start + offset)
    }
    let index = 0
    for (const field of FIELDS) {
      const section = this.sectionOf(snapshot, field)
      if (field === 'maxDepth') lines.push({ text: color.textDim('Limits') })
      if (field === 'enabled') lines.push({ text: color.textDim('Model selection') })
      const selected = index === this.fieldIndex
      const marker = selected ? '> ' : '  '
      const value = this.fieldValue(snapshot, field)
      const valueWidth = visibleWidth(value)
      const blockStart = lines.length
      let blockComplete = valueWidth <= rowWidth
      const labelLines = wrapTextWithAnsi(sanitizedPhysicalLine(LABELS[field]), Math.max(1, rowWidth - 2))
      const target: BodyTarget = { id: `field:${field}`, action: { kind: 'field', field }, startCol: 0, endCol: rowWidth }
      if (labelLines.length === 1 && visibleWidth(marker) + visibleWidth(LABELS[field]) + 2 + valueWidth <= rowWidth) {
        const gap = Math.max(2, rowWidth - visibleWidth(marker) - visibleWidth(LABELS[field]) - valueWidth)
        const label = selected ? color.textStrong(LABELS[field]) : color.text(LABELS[field])
        lines.push({ text: `${marker}${label}${' '.repeat(gap)}${color.text(sanitizedPhysicalLine(value))}`, field, targets: [target] })
      } else {
        labelLines.forEach((line, lineIndex) => {
          const label = lineIndex === 0
            ? `${marker}${selected ? color.textStrong(line) : color.text(line)}`
            : `  ${color.text(line)}`
          lines.push({ text: label, field, ...(lineIndex === 0 ? { targets: [target] } : {}) })
        })
        const valueLine = valueWidth + 2 <= rowWidth
          ? `  ${color.text(value)}`
          : valueWidth <= rowWidth ? color.text(value)
            : `  ${color.text(truncateToWidth(value, Math.max(1, rowWidth - 2), '…', false))}`
        if (valueWidth > rowWidth) blockComplete = false
        lines.push({ text: valueLine, field })
      }
      const patched = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string }>>>)[field] !== undefined
      if (patched) {
        const prefix = section.current ? 'Current:' : 'Last confirmed:'
        const current = this.effectiveValue(snapshot, field)
        const currentWidth = visibleWidth(current)
        const valueText = currentWidth + 2 <= rowWidth ? `  ${color.textDim(current)}`
          : currentWidth <= rowWidth ? color.textDim(current)
            : `  ${color.textDim(truncateToWidth(current, Math.max(1, rowWidth - 2), '…', false))}`
        const valueComplete = currentWidth <= rowWidth
        const prefixWidth = visibleWidth(prefix)
        const oneLine = 2 + prefixWidth + 1 + currentWidth + 3 + 7 <= rowWidth
        if (oneLine) lines.push({ text: `  ${color.textDim(prefix)} ${color.textDim(current)} · ${color.textDim('Unsaved')}`, field })
        else if (2 + prefixWidth + 1 + currentWidth <= rowWidth) {
          lines.push({ text: `  ${color.textDim(prefix)} ${color.textDim(current)}`, field })
          lines.push({ text: color.textDim('  · Unsaved'), field })
        } else {
          for (const fragment of wrapTextWithAnsi(prefix, Math.max(1, rowWidth - 2))) {
            lines.push({ text: `  ${color.textDim(fragment)}`, field })
          }
          lines.push({ text: valueText, field })
          lines.push({ text: color.textDim('  · Unsaved'), field })
          blockComplete = blockComplete && valueComplete
        }
        if (currentWidth > rowWidth || rowWidth < 5) blockComplete = false
        dirtyBlocks.push({ lines: lines.slice(blockStart).map((_, offset) => blockStart + offset), complete: blockComplete })
      }
      const issue = snapshot.issues[field]
      if (issue !== undefined) lines.push(...this.note(issue, copyWidth, color.error))
      if (field === 'maxActiveSubagents') lines.push(...this.note(LIMITS_EFFECT, copyWidth))
      if (field === 'allowedModels') lines.push(...this.note(SELECTION_EFFECT, copyWidth))
      index += 1
    }
    lines.push(...this.note(SAVE_NOTE, copyWidth))
    const field = FIELDS[this.fieldIndex]!
    if (this.editable(field, snapshot)) {
      lines.push(this.bodyAction(this.fieldActionLabel(field), { kind: this.fieldActionOf(field) as 'edit' | 'toggle' | 'manage' }, width))
    }
    if (this.sectionOf(snapshot, field).source.kind === 'ready') {
      lines.push(this.bodyAction('Details…', { kind: 'details' }, width))
    }
    if (snapshot.dirty && !this.ambiguous(snapshot) && !snapshot.saving && !snapshot.loading) {
      lines.push(this.bodyAction('Discard…', { kind: 'discard' }, width))
    }
    if (!snapshot.loading && !snapshot.saving) lines.push(this.bodyAction('Refresh…', { kind: 'refresh' }, width))
    // A settled ambiguous outcome is the FIRST truth about the capture.
    for (const section of [snapshot.limits, snapshot.selection]) {
      if (section.source.kind !== 'ready') lines.push(...this.note(section.source.reason, copyWidth))
    }
    return { lines, saveFacts: { ...(countLines === undefined ? {} : { count: countLines }), dirty: dirtyBlocks } }
  }
  private fieldActionLabel(field: SubagentSettingsField): string {
    return field === 'enabled' ? 'Toggle [Enter]' : field === 'allowedModels' ? 'Manage [Enter]' : 'Edit [Enter]'
  }
  private inputLines(width: number, snapshot: SubagentSettingsSnapshot): {
    lines: ContentLine[]
    critical: readonly number[]
    admissible: boolean
  } {
    const lines: ContentLine[] = []
    const active = this.numberInput!
    const field = active.field
    const copyWidth = Math.min(width, 72)
    lines.push(...this.note(`Edit ${FULL_LABELS[field]}`, width))
    lines.push(...this.fact('Current value', this.effectiveValue(snapshot, field), width).lines)
    const inputRow = lines.length
    lines.push({ text: active.input.render(width)[0] ?? '', targets: [{ id: 'input', action: { kind: 'input' }, startCol: 0, endCol: width }] })
    const critical = [inputRow]
    let admissible = true
    const raw = active.input.getValue()
    if (raw.trim() !== '') {
      const canonical = this.controller.numberIssue(field, raw) === undefined ? String(Number(raw)) : undefined
      const prompt = 'Value: '
      const window = Math.max(0, width - visibleWidth(prompt) - 1)
      const rawVisible = visibleWidth(raw) <= window
      if (canonical !== undefined && (canonical !== raw.trim() || !rawVisible)) {
        const sent = this.fact('Value sends', canonical, width)
        const sentStart = lines.length
        for (const line of sent.lines) lines.push(line)
        critical.push(...sent.lines.map((_, offset) => sentStart + offset))
        admissible = sent.complete
      }
    }
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    lines.push(...this.note(this.fieldEffect(field), copyWidth))
    return { lines, critical, admissible }
  }
  private advancedLines(width: number, snapshot: SubagentSettingsSnapshot): {
    lines: ContentLine[]
    facts: readonly number[]
    action: ContentLine | undefined
  } {
    const field = FIELDS[this.fieldIndex]!
    const section = this.sectionOf(snapshot, field)
    const lines: ContentLine[] = []
    const facts: number[] = []
    const rowWidth = Math.min(width, 64)
    const copyWidth = Math.min(width, 72)
    const pad = 12
    const labelLines = wrapTextWithAnsi(sanitizedPhysicalLine(FULL_LABELS[field]), Math.max(1, rowWidth))
    const labelStart = lines.length
    for (const fragment of labelLines) lines.push({ text: color.textStrong(fragment) })
    for (let index = 0; index < labelLines.length; index += 1) facts.push(labelStart + index)
    const resetCopy = this.note('Reset stages the official unset.', copyWidth)
    let next = lines.length
    for (const _line of resetCopy) { facts.push(next); next += 1 }
    lines.push(...resetCopy)
    const stagedCopy = this.note(SAVE_NOTE, copyWidth)
    next = lines.length
    for (const _line of stagedCopy) { facts.push(next); next += 1 }
    lines.push(...stagedCopy)
    lines.push(...this.fact('Effective', this.effectiveValue(snapshot, field), rowWidth, color.text, pad).lines)
    lines.push(...this.fact('Inherited', this.inheritedValue(snapshot, field), rowWidth, color.textDim, pad).lines)
    lines.push(...this.fact('Comparison', this.comparison(snapshot, field), rowWidth, color.textDim, pad).lines)
    if (section.source.kind === 'ready') lines.push(...this.fact('Revision', String(section.source.revision), rowWidth, color.textDim, pad).lines)
    lines.push(...this.proseFact('Scope', SCOPE, copyWidth, pad))
    if (field === 'allowedModels' && section.source.kind === 'ready') {
      const effectiveRoutes = (section.source.effective as { allowedModels: readonly SubagentAllowedModelRoute[] }).allowedModels
      lines.push(...this.routeIdentityLines('Effective routes', effectiveRoutes, copyWidth))
      const entry = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string; readonly value?: unknown }>>>)[field]
      if (entry !== undefined) {
        if (entry.kind === 'reset') {
          lines.push({ text: color.text('Staged official unset') })
        } else {
          lines.push(...this.routeIdentityLines('Staged routes', entry.value as readonly SubagentAllowedModelRoute[], copyWidth, color.text))
        }
      }
    } else {
      const requested = this.requestedValue(snapshot, field)
      if (requested !== undefined) lines.push(...this.fact('Staged', requested, rowWidth, color.text, pad).lines)
    }
    lines.push(...this.note(this.fieldEffect(field, true), copyWidth))
    lines.push(...this.note('The USER patch may retain the inherited value.', copyWidth))
    lines.push(...this.note('The Host readback decides the value.', copyWidth))
    if (section.source.kind !== 'ready') lines.push(...this.note(section.source.reason, copyWidth, color.error))
    if (this.fieldError !== undefined) lines.push(...this.note(this.fieldError, copyWidth, color.error))
    if (snapshot.notice !== undefined) lines.push(...this.note(snapshot.notice, copyWidth, color.error))
    const action = this.editable(field, snapshot) && visibleWidth('Reset to inherited…') <= rowWidth
      ? {
          text: color.primary('Reset to inherited…'),
          targets: [{ id: `reset:${field}`, action: { kind: 'reset' as const }, startCol: 0, endCol: visibleWidth('Reset to inherited…') }],
        }
      : undefined
    return { lines, facts, action }
  }
  private searchRow(width: number): ContentLine | undefined {
    if (this.view !== 'directory') return undefined
    if (this.searching) {
      const text = this.searchInput.render(width)[0] ?? ''
      return { text, targets: [{ id: 'search', action: { kind: 'search' }, startCol: 0, endCol: width }] }
    }
    const word = `Search [${KEYS.search}]`
    if (visibleWidth(word) > width) return undefined
    const text = color.primary(word) + color.textDim(`  ${sanitizedPhysicalLine(this.searchInput.getValue())}`)
    return { text, targets: [{ id: 'search', action: { kind: 'search' }, startCol: 0, endCol: visibleWidth(word) }] }
  }
  private directoryLines(width: number, snapshot: SubagentSettingsSnapshot): ContentLine[] {
    const lines: ContentLine[] = []
    const rowWidth = Math.min(width, 64)
    const copyWidth = Math.min(width, 72)
    const models = this.directoryModels(snapshot)
    this.ensureRouteSelection(models)
    let group: string | undefined
    for (const model of models) {
      const key = allowlistRouteKey(model.providerId, model.modelId)
      const groupKey = model.savedRoute === undefined ? `provider:${model.providerId}` : 'saved'
      if (groupKey !== group) {
        group = groupKey
        lines.push({ text: color.textDim(sanitizedPhysicalLine(model.savedRoute === undefined ? model.providerName : 'Saved routes')) })
      }
      const selected = key === this.selectedRoute
      const marker = selected ? '> ' : '  '
      const chip = model.allowed ? ' [allowed]' : ''
      const label = sanitizedPhysicalLine(model.modelName ?? model.modelId)
      const room = Math.max(1, rowWidth - 2 - (chip === '' ? 0 : visibleWidth(chip)))
      const name = truncateToWidth(label, room, '…', false)
      const text = `${marker}${selected ? color.textStrong(name) : color.text(name)}${chip === '' ? '' : color.textMuted(chip)}`
      const searching = this.searching
      lines.push(searching ? { text } : {
        text,
        routeKey: key,
        targets: [{ id: `route:${key}`, action: { kind: 'route', key }, startCol: 0, endCol: Math.min(rowWidth, visibleWidth(text)) }],
      })
      if (!selected || searching) continue
      const detail = (line: ContentLine): ContentLine => ({ ...line, routeKey: key })
      for (const line of this.note(`${model.providerId} / ${model.modelId}`, copyWidth)) lines.push(detail(line))
      const section = snapshot.selection
      if (section.source.kind === 'ready' && section.dirty) {
        const effectiveMember = (section.source.effective as { allowedModels: readonly SubagentAllowedModelRoute[] }).allowedModels
          .some(route => route.provider === model.providerId && route.model === model.modelId)
        for (const line of this.note(`Current: ${effectiveMember ? 'allowed' : 'not allowed'}`, copyWidth)) lines.push(detail(line))
      }
      if (model.savedRoute !== undefined) {
        const note = model.savedRoute === 'absent' ? 'Saved route not listed in the current directory.'
          : model.savedRoute === 'catalog-loading' ? 'Saved route; the model directory is still loading.'
            : model.savedRoute === 'provider-unavailable' ? "Saved route; this provider's directory is unavailable."
              : 'Saved route; the model directory is unavailable.'
        for (const line of this.note(note, copyWidth)) lines.push(detail(line))
      }
      const actionLabel = this.routeActionLabel(snapshot, model)
      const blocked = this.routeBlockReason(snapshot, model)
      if (actionLabel !== undefined && visibleWidth(actionLabel) <= rowWidth) {
        lines.push(detail({
          text: color.primary(actionLabel),
          targets: [{ id: 'route-toggle', action: { kind: 'route-toggle' }, startCol: 0, endCol: visibleWidth(actionLabel) }],
        }))
      } else if (blocked !== undefined) for (const line of this.note(blocked, copyWidth, color.warning)) lines.push(detail(line))
    }
    const projection = projectSubagentAllowlist({ catalog: this.catalog, allowed: snapshot.allowedModels })
    for (const failure of projection.failures) {
      lines.push(...this.note(`Unavailable: ${failure.providerName}: ${failure.message}`, copyWidth, color.error))
    }
    if (models.length === 0) {
      lines.push(...this.note(this.catalog.state === 'loading' ? 'Loading models…'
        : this.catalog.state === 'ready' ? 'No matching models' : 'Model directory unavailable', copyWidth))
    } else if (this.catalog.state === 'loading') {
      lines.push(...this.note('Loading models…', copyWidth))
    }
    if (this.routeNotice !== undefined) lines.push(...this.note(this.routeNotice, copyWidth, color.warning))
    return lines
  }

  private questionLines(width: number, snapshot: SubagentSettingsSnapshot): {
    lines: ContentLine[]
    mustSee: readonly number[]
    acceptLine?: number
  } {
    const question = this.question!
    const lines: ContentLine[] = []
    const mustSee: number[] = []
    const copyWidth = Math.min(width, 72)
    let facts: readonly string[]
    if (question.kind === 'refresh') {
      facts = this.ambiguous(snapshot) ? [...GROUP_REFRESH, 'The Host may have applied changes.'] : GROUP_REFRESH
    } else if (question.kind === 'discard') {
      facts = GROUP_DISCARD
    } else {
      const count = this.dirtyCountText(snapshot)
      const invalid = Object.keys(snapshot.issues).length !== 0
      facts = this.ambiguous(snapshot)
        ? [count, ...AMBIGUOUS_COPY]
        : this.canSave()
          ? [count, 'Save keeps you here.', 'Discard and leave loses staged values.']
          : [count, invalid ? 'Save is unavailable while the field issue remains.' : 'Save is unavailable until you refresh and review.',
            'Discard and leave loses staged values.']
    }
    for (const fact of facts) {
      for (const wrapped of this.note(fact, copyWidth, color.warning)) {
        mustSee.push(lines.length)
        lines.push(wrapped)
      }
    }
    // The complete mandatory copy is followed immediately by the reserved body
    // answer; optional requested/last-confirmed detail is appended AFTER it so
    // a long route identity can never push the answer out of the frame.
    const acceptWord = question.kind === 'refresh'
      ? 'Refresh…'
      : question.kind === 'discard' ? 'Discard…' : this.ambiguous(snapshot) ? 'Leave anyway…' : 'Discard and leave…'
    const bodyRows = Math.max(0, this.rowGrant - 1)
    let acceptLine: number | undefined
    if (visibleWidth(acceptWord) <= width && lines.length + 1 <= bodyRows) {
      acceptLine = lines.length
      lines.push(this.acceptAction(acceptWord, width))
    }
    if (this.ambiguous(snapshot)) {
      const ambiguousLimits = snapshot.limits.status?.kind === 'unverified' || snapshot.limits.status?.kind === 'outcome-unconfirmed'
      const ambiguousSelection = snapshot.selection.status?.kind === 'unverified' || snapshot.selection.status?.kind === 'outcome-unconfirmed'
      const fields = FIELDS.filter(field => (field === 'maxDepth' || field === 'maxActiveSubagents') ? ambiguousLimits : ambiguousSelection)
      for (const field of fields) {
        const section = this.sectionOf(snapshot, field)
        if (Object.keys(section.patch).length === 0) continue
        if (field === 'allowedModels' && section.source.kind === 'ready') {
          const entry = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string; readonly value?: unknown }>>>)[field]
          if (entry?.kind === 'reset') lines.push({ text: color.warning('Requested Allowed models official unset') })
          else lines.push(...this.routeIdentityLines('Requested Allowed models',
            entry?.value as readonly SubagentAllowedModelRoute[] ?? [], Math.min(width, 72), color.text))
          continue
        }
        const requested = this.requestedValue(snapshot, field)
        if (requested !== undefined) lines.push(...this.fact(`Requested ${LABELS[field]}`, requested, Math.min(width, 64), color.text).lines)
      }
      for (const field of fields) {
        const section = this.sectionOf(snapshot, field)
        if (field === 'allowedModels' && section.source.kind === 'ready') {
          const routes = (section.source.effective as { allowedModels: readonly SubagentAllowedModelRoute[] }).allowedModels
          lines.push(...this.routeIdentityLines('Last confirmed Allowed models', routes, Math.min(width, 72)))
          continue
        }
        lines.push(...this.fact(`Last confirmed ${LABELS[field]}`, this.effectiveValue(snapshot, field), Math.min(width, 64), color.textDim).lines)
      }
    }
    return { lines, mustSee, ...(acceptLine === undefined ? {} : { acceptLine }) }
  }

  // ── bar ───────────────────────────────────────────────────────────────────

  private renderBar(
    snapshot: SubagentSettingsSnapshot,
    width: number,
    questionRead: boolean,
    inputComplete: boolean,
    scrollable: boolean,
    resetReady: boolean,
    routeActionRead: boolean,
  ): string {
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const painted = this.paintedQuestion !== undefined && this.paintedQuestion === this.questionIdentity()
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
      if (!painted || !questionRead) {
        // A question whose necessary copy is not complete publishes ONLY Keep;
        // no shortcut may bypass the missing risk/count facts.
        segments = [{ text: 'Keep [Esc]', priority: 1000, escape: true }]
      } else if (this.question.kind === 'refresh') {
        segments = [{ text: `Refresh [${KEYS.refresh.toUpperCase()}]`, priority: 900, action: 'refresh-confirm' }, { text: 'Keep [Esc]', priority: 1000, escape: true }]
      } else if (this.question.kind === 'discard') {
        segments = [{ text: `Discard [${KEYS.discard.toUpperCase()}]`, priority: 900, action: 'discard' }, { text: 'Keep [Esc]', priority: 1000, escape: true }]
      } else {
        const ambiguous = this.ambiguous(snapshot)
        segments = [
          ...(!ambiguous && this.canSave() ? [{ text: `Save [${KEYS.save.toUpperCase()}]`, short: 'Save', priority: 950, action: 'save' as const }] : []),
          {
            text: ambiguous ? 'Leave anyway [D]' : 'Discard and leave [D]',
            ...(ambiguous ? {} : { short: 'Discard [D]' }),
            priority: 900,
            action: 'leave',
          },
          { text: 'Keep [Esc]', priority: 1000, escape: true },
        ]
      }
    } else if (this.numberInput !== undefined) {
      this.paintedConfirm = inputComplete
      segments = [
        ...(this.paintedConfirm ? [{ text: 'Stage [Enter]', priority: 900, action: 'apply' as const }] : []),
        { text: 'Cancel [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.advanced) {
      segments = [
        ...(resetReady && this.editable(FIELDS[this.fieldIndex]!, snapshot)
          ? [{ text: `Reset [${KEYS.reset.toUpperCase()}]`, priority: 900, action: 'reset' as const }]
          : []),
        ...(scrollable ? [{ text: 'Up/Down scroll', priority: 400 }] : []),
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else if (snapshot.loading) {
      // A loading capture keeps ONLY the safe Back: its still-painted old facts
      // are not a current action basis.
      segments = [{ text: 'Back [Esc]', priority: 1000, escape: true }]
    } else if (this.view === 'directory') {
      if (this.searching) {
        // Search focus is a distinct typing state: Enter is Done, Escape is the
        // REAL Back. No route action or Refresh is advertised while typing.
        segments = [
          { text: 'Done [Enter]', priority: 400, action: 'search-done' as const },
          { text: 'Back [Esc]', priority: 1000, escape: true },
        ]
      } else {
        const model = this.selectedModel(snapshot)
        const action = model === undefined ? undefined : this.routeActionLabel(snapshot, model)
        const actionWord = model !== undefined && action !== undefined && routeActionRead
          ? `${model.allowed ? 'Remove' : 'Add'} route [Enter]`
          : undefined
        segments = [
          ...(actionWord === undefined ? [] : [{ text: actionWord, priority: 850, action: 'route-toggle' as const }]),
          { text: `Search [${KEYS.search}]`, priority: 400, action: 'search' as const },
          { text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 500, action: 'refresh' as const },
          { text: 'Back [Esc]', priority: 1000, escape: true },
        ]
      }
    } else if (snapshot.dirty && !this.ambiguous(snapshot)) {
      // A real dirty group keeps its local Discard even while an invalid draft
      // makes Save inadmissible; Save itself stays gated by its own facts.
      segments = [
        ...(this.canSave() && this.paintedSaveFacts
          ? [{ text: `Save [${KEYS.save.toUpperCase()}]`, priority: 900, action: 'save' as const }]
          : []),
        ...(this.editable(FIELDS[this.fieldIndex]!, snapshot)
          ? [{ text: this.fieldActionLabel(FIELDS[this.fieldIndex]!), priority: 800, action: this.fieldActionOf(FIELDS[this.fieldIndex]!) }]
          : []),
        ...(this.sectionOf(snapshot, FIELDS[this.fieldIndex]!).source.kind === 'ready'
          ? [{ text: 'Details [?]', short: 'Details', priority: 700, action: 'details' as const }]
          : []),
        { text: `Discard [${KEYS.discard.toUpperCase()}]`, short: 'Discard', priority: 600, action: 'discard' },
        { text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 500, action: 'refresh' },
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else if (snapshot.dirty && this.ambiguous(snapshot)) {
      segments = [
        { text: 'Details [?]', short: 'Details', priority: 700, action: 'details' },
        { text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 800, action: 'refresh' },
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else if (this.editable(FIELDS[this.fieldIndex]!, snapshot)) {
      segments = [
        { text: this.fieldActionLabel(FIELDS[this.fieldIndex]!), priority: 800, action: this.fieldActionOf(FIELDS[this.fieldIndex]!) },
        { text: 'Details [?]', short: 'Details', priority: 700, action: 'details' },
        ...(!snapshot.loading ? [{ text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 500, action: 'refresh' as const }] : []),
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    } else {
      segments = [
        ...(!snapshot.loading ? [{ text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 800, action: 'refresh' as const }] : []),
        ...(this.sectionOf(snapshot, FIELDS[this.fieldIndex]!).source.kind === 'ready'
          ? [{ text: 'Details [?]', short: 'Details', priority: 700, action: 'details' as const }]
          : []),
        { text: 'Back [Esc]', priority: 1000, escape: true },
      ]
    }
    const layout = layoutActionBarRow(segments, width)
    if (layout.truncated) {
      this.paintedConfirm = false
      this.paintedActions.clear()
      this.barSpans = []
      return fit(color.textMuted(layout.text), width)
    }
    const paintedSegments: string[] = []
    const spans: { id: string; action: BarAction; startCol: number; endCol: number }[] = []
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]!
      paintedSegments.push(segment.action === undefined && !segment.escape ? color.textMuted(span.text)
        : paintActionSpan(span.text, segment.action === 'save' || segment.action === 'apply' || segment.action === 'toggle'
          || segment.action === 'manage' || segment.action === 'route-toggle' || segment.action === 'leave'
          || segment.action === 'reset' || segment.action === 'discard' || segment.action === 'refresh-confirm'
          ? 'primary' : 'secondary'))
      if (segment.escape) this.escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else if (segment.action !== undefined) {
        spans.push({ id: `bar:${segment.action}`, action: segment.action, startCol: span.startCol, endCol: span.endCol })
        this.paintedActions.add(segment.action)
      }
    }
    this.barSpans = spans
    if (!spans.some(span => span.action === 'apply')) this.paintedConfirm = false
    return fit(paintedSegments.join(ACTION_BAR_SEPARATOR), width)
  }

  invalidate(): void { this.numberInput?.input.invalidate(); this.searchInput.invalidate() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.catalogAbort?.abort()
    this.revoke()
    this.paint = undefined
    this.numberInput = undefined
    this.searchInput.focused = false
    this.controller.dispose()
  }
}
