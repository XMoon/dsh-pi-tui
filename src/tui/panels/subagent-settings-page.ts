/** Subagent settings presentation inside the existing Settings screen lease.
 * The controller owns every semantic draft, validation and Host write. */
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from '@xmoon76/pi-tui'
import type { SubagentSettingsController, SubagentSettingsField, SubagentSettingsSnapshot, SubagentSectionSnapshot } from '../../app/command/subagent-settings.ts'
import type { ModelDirectoryDto } from '../../runtime/catalog-port.ts'
import type { SubagentAllowedModelRoute } from '../../runtime/config-port.ts'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { projectSubagentAllowlist, allowlistRouteKey, allowlistSummary, type AllowlistCatalogState } from '../pickers/subagent-model-menu.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { EmbeddedSpecialistPage } from './settings-workspace-panel.ts'

export interface SubagentSettingsPageIntents {
  readonly controller: SubagentSettingsController
  readonly catalog: { loadDirectory(signal?: AbortSignal): Promise<ModelDirectoryDto> }
  readonly requestRender: () => void
  readonly done: () => void
  runOwned<T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void
}

type NumberField = 'maxDepth' | 'maxActiveSubagents'
type BodyAction =
  | { readonly kind: 'field' | 'reset'; readonly field: SubagentSettingsField }
  | { readonly kind: 'route'; readonly route: SubagentAllowedModelRoute }
  | { readonly kind: 'search' | 'input' }
type BarAction = 'save' | 'refresh' | 'discard' | 'keep' | 'reset' | 'apply' | 'search' | 'search-done'
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

const FIELDS = ['maxDepth', 'maxActiveSubagents', 'enabled', 'allowedModels'] as const
const LABELS: Record<SubagentSettingsField, string> = {
  maxDepth: 'Maximum recursion depth',
  maxActiveSubagents: 'Subagent parallelism limit',
  enabled: 'Enabled',
  allowedModels: 'Allowed models',
}
// These local, deliberately non-rebindable keys supply both handlers and badges.
const KEYS = { save: 's', refresh: 'r', reset: 'x', discard: 'd', search: '/', yes: 'y', no: 'n' } as const
const DISCARD_QUESTION = 'Discard unsaved changes? y/N'

function fit(text: string, width: number): string {
  const line = truncateToWidth(text, Math.max(0, width), '…', false)
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)))
}
function sectionWord(section: { readonly source: { readonly kind: string }; readonly current: boolean }): string {
  return section.source.kind !== 'ready' ? 'Unavailable' : section.current ? 'Ready' : 'Last-known · read-only'
}
function statusInk(kind: string | undefined, text: string): string {
  if (kind === 'verified') return color.success(text)
  if (kind === 'not-saved') return color.error(text)
  if (kind === 'unverified' || kind === 'outcome-unconfirmed') return color.warning(text)
  return color.textDim(text)
}

export class SubagentSettingsPage implements EmbeddedSpecialistPage {
  readonly title = 'Subagent settings'
  private readonly intents: SubagentSettingsPageIntents
  private readonly controller: SubagentSettingsController
  private _focused = false
  private disposed = false
  private rowGrant = 8
  private revision = 0
  private view: 'form' | 'directory' = 'form'
  private fieldIndex = 0
  private formOffset = 0
  private directoryOffset = 0
  private revealSelection = true
  private selectedRoute: string | undefined
  private searching = false
  private readonly searchInput = new Input({ prompt: 'Search: ', placeholder: 'provider or model', placeholderStyle: color.textDim })
  private numberInput: { readonly field: NumberField; readonly input: Input } | undefined
  private question: { readonly instance: number; readonly target: 'leave' | 'refresh' | 'discard' } | undefined
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
    this.revoke()
  }
  grantAwaitingPaint(): boolean { return this.awaitingPaint }
  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined { return this.escapeSpan }
  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] { return this.barSpans }
  blocksParentNavigation(): boolean {
    const snapshot = this.controller.snapshot()
    return snapshot.dirty || snapshot.saving || this.view === 'directory' || this.numberInput !== undefined || this.question !== undefined
  }

  private identityOf(identity: object): number {
    let value = this.identities.get(identity)
    if (value === undefined) { value = ++this.nextIdentity; this.identities.set(identity, value) }
    return value
  }
  private authorityIdentity(snapshot: SubagentSettingsSnapshot): string {
    return [snapshot.limits, snapshot.selection].map(section => {
      const live = section.currentGeneration === undefined ? '' : this.identityOf(section.currentGeneration)
      return section.source.kind === 'ready'
        ? `${this.identityOf(section.source.generation)}:${section.source.revision}->${live}:${section.current}`
        : `${section.source.kind}:${section.source.reason}:${live}`
    }).join('|')
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

  private editable(field: SubagentSettingsField, snapshot: SubagentSettingsSnapshot): boolean {
    const section = field === 'maxDepth' || field === 'maxActiveSubagents' ? snapshot.limits : snapshot.selection
    return !snapshot.loading && !snapshot.saving && section.current && section.source.kind === 'ready'
  }
  private canSave(snapshot: SubagentSettingsSnapshot): boolean {
    // Each official namespace has its own CAS revision. One stale section must
    // not disable a current sibling; the controller still refuses a replacement
    // Host before dispatching either section.
    return snapshot.dirty && !snapshot.saving && !snapshot.loading
      && ((snapshot.limits.dirty && snapshot.limits.current)
        || (snapshot.selection.dirty && snapshot.selection.current))
  }
  private openQuestion(target: 'leave' | 'refresh' | 'discard'): void {
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
    if (target === 'refresh') {
      this.catalogAbort?.abort()
      this.catalogAuthority = undefined
      this.controller.refresh(true)
    } else this.controller.discard()
    this.changed()
    if (target === 'leave') this.intents.done()
  }
  private back(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.saving) { this.waitNotice = true; this.changed(); return }
    if (this.question !== undefined) { this.keepEditing(); return }
    if (this.numberInput !== undefined) { this.numberInput = undefined; this.changed(); return }
    if (this.view === 'directory') {
      this.view = 'form'
      this.searching = false
      this.searchInput.focused = false
      this.revealSelection = true
      this.changed()
      return
    }
    if (snapshot.dirty) this.openQuestion('leave')
    else this.intents.done()
  }
  private refresh(): void {
    const snapshot = this.controller.snapshot()
    if (snapshot.loading || snapshot.saving) return
    if (snapshot.dirty) { this.openQuestion('refresh'); return }
    this.catalogAbort?.abort()
    this.catalogAuthority = undefined
    this.controller.refresh()
    this.changed()
  }
  private activateField(field: SubagentSettingsField): void {
    const snapshot = this.controller.snapshot()
    if (!this.editable(field, snapshot)) return
    this.fieldIndex = FIELDS.indexOf(field)
    if (field === 'enabled') this.controller.toggleEnabled()
    else if (field === 'allowedModels') {
      this.view = 'directory'
      this.revealSelection = true
      this.loadDirectory()
    } else {
      const input = new Input({ prompt: 'Value: ', placeholder: 'blank stages Reset', placeholderStyle: color.textDim })
      input.setValue(field === 'maxDepth' ? snapshot.depthText : snapshot.capacityText)
      input.focused = this.focused
      this.numberInput = { field, input }
    }
    this.changed()
  }
  private applyNumber(): void {
    const active = this.numberInput
    if (active === undefined || !this.editable(active.field, this.controller.snapshot())) return
    this.controller.setNumber(active.field, active.input.getValue())
    this.numberInput = undefined
    this.revealSelection = true
    this.changed()
  }
  private reset(field: SubagentSettingsField): void {
    if (!this.editable(field, this.controller.snapshot())) return
    this.fieldIndex = FIELDS.indexOf(field)
    this.controller.reset(field)
    this.revealSelection = true
    this.changed()
  }
  private enterSearch(): void {
    if (this.view !== 'directory') return
    this.searching = true
    this.searchInput.focused = this.focused
    this.changed()
  }
  private loadDirectory(force = false): void {
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
    if (this.searching) {
      if (matchesKey(data, 'enter') || matchesKey(data, 'tab')) {
        this.searching = false
        this.searchInput.focused = false
      } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) this.move(matchesKey(data, 'up') ? -1 : 1)
      else {
        this.searchInput.handleInput(data)
        this.selectedRoute = undefined
        this.directoryOffset = 0
        this.revealSelection = true
      }
      this.changed()
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
    if (this.view === 'directory') {
      if (matchesKey(data, KEYS.search)) this.enterSearch()
      else if (matchesKey(data, 'enter')) {
        const row = this.directoryModels(snapshot).find(row => allowlistRouteKey(row.providerId, row.modelId) === this.selectedRoute)
        if (row !== undefined) this.toggleRoute({ provider: row.providerId, model: row.modelId })
      } else if (matchesKey(data, KEYS.refresh)) this.refresh()
      else { this.enterSearch(); this.searchInput.handleInput(data); this.changed() }
      return
    }
    if (matchesKey(data, 'enter')) this.activateField(FIELDS[this.fieldIndex]!)
    else if (matchesKey(data, KEYS.save) && this.canSave(snapshot)) { this.controller.save(); this.changed() }
    else if (matchesKey(data, KEYS.refresh)) this.refresh()
    else if (matchesKey(data, KEYS.reset)) this.reset(FIELDS[this.fieldIndex]!)
    else if (matchesKey(data, KEYS.discard) && snapshot.dirty) this.openQuestion('discard')
  }

  private directoryModels(snapshot: SubagentSettingsSnapshot) {
    const query = this.searchInput.getValue().trim().toLowerCase()
    return projectSubagentAllowlist({ catalog: this.catalog, allowed: snapshot.allowedModels }).models.filter(row =>
      `${row.providerId} ${row.providerName} ${row.modelId} ${row.modelName ?? ''}`.toLowerCase().includes(query))
  }
  private move(delta: number): void {
    if (this.view === 'form') this.fieldIndex = (this.fieldIndex + delta + FIELDS.length) % FIELDS.length
    else {
      const models = this.directoryModels(this.controller.snapshot())
      const index = models.findIndex(row => allowlistRouteKey(row.providerId, row.modelId) === this.selectedRoute)
      const next = models[Math.max(0, Math.min(models.length - 1, index + delta))]
      this.selectedRoute = next === undefined ? undefined : allowlistRouteKey(next.providerId, next.modelId)
    }
    this.revealSelection = true
    this.changed()
  }
  private scroll(delta: number): void {
    const key = this.view === 'form' ? 'formOffset' : 'directoryOffset'
    this[key] = Math.min(Math.max(0, this[key] + delta), this.paint?.maxOffset ?? 0)
    this.revealSelection = false
    this.changed()
  }
  private toggleRoute(route: SubagentAllowedModelRoute): void {
    if (!this.editable('allowedModels', this.controller.snapshot())) return
    this.selectedRoute = allowlistRouteKey(route.provider, route.model)
    this.controller.toggleRoute(route)
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
      case 'discard': this.question === undefined ? this.openQuestion('discard') : this.discard(); break
      case 'keep': this.keepEditing(); break
      case 'apply': this.applyNumber(); break
      case 'reset': this.reset(FIELDS[this.fieldIndex]!); break
      case 'search': this.enterSearch(); break
      case 'search-done': this.searching = false; this.searchInput.focused = false; this.changed(); break
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
    // The physical screen forwards one click using terminal height before the
    // Root's body-grant click. Keep the admitted press across that size-only
    // duplicate; any other invalid click retires it.
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
    const action = target.action
    switch (action.kind) {
      case 'field': if (this.numberInput === undefined) this.activateField(action.field); break
      case 'reset': if (this.numberInput === undefined) this.reset(action.field); break
      case 'route': this.toggleRoute(action.route); break
      case 'search':
        if (!this.searching) this.enterSearch()
        else {
          this.searchInput.handleMouse({ ...event, type: 'press', y: 0, height: 1 })
          this.changed()
        }
        break
      case 'input':
        this.numberInput?.input.handleMouse({ ...event, type: 'press', y: 0, height: 1 })
        this.changed()
        break
    }
  }

  render(width: number): string[] {
    if (this.disposed) return [fit('', width)]
    const snapshot = this.controller.snapshot()
    if (this.view === 'directory' && !snapshot.loading && this.catalogAuthority !== this.authorityIdentity(snapshot)) {
      this.loadDirectory(true)
    }
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
      if (bodyRows > 0) lines.push(fit(color.textDim(`Edit ${LABELS[active.field]}`), width))
      if (bodyRows > 1) {
        lines.push(active.input.render(width)[0] ?? '')
        targets.push({ id: 'input', action: { kind: 'input' }, row: 1, startCol: 0, endCol: width })
      }
      if (bodyRows > 2) lines.push(fit(color.textDim('Blank stages the official Reset operation.'), width))
    } else {
      const status = this.statusLines(snapshot, width)
      // Both independent section results remain pinned above the ONE bar.
      const statusRows = bodyRows >= 4 ? Math.min(3, status.length)
        : bodyRows >= 3 ? Math.min(2, status.length) : bodyRows >= 2 ? 1 : 0
      let viewport = Math.max(0, bodyRows - statusRows)
      if (this.view === 'directory' && viewport > 0) {
        const searchText = this.searching ? this.searchInput.render(width)[0] ?? ''
          : color.primary(`Search [${KEYS.search}]`) + color.textDim(`  ${sanitizedPhysicalLine(this.searchInput.getValue())}`)
        lines.push(fit(searchText, width))
        targets.push({ id: 'search', action: { kind: 'search' }, row: 0, startCol: 0,
          endCol: this.searching ? width : Math.min(width, visibleWidth(`Search [${KEYS.search}]`)) })
        viewport -= 1
      }
      const content = this.view === 'form' ? this.formLines(snapshot, width) : this.directoryLines(snapshot, width)
      const key = this.view === 'form' ? 'formOffset' : 'directoryOffset'
      maxOffset = Math.max(0, content.length - viewport)
      let offset = Math.min(this[key], maxOffset)
      const selected = content.findIndex(line => this.view === 'form' ? line.field === FIELDS[this.fieldIndex] : line.routeKey === this.selectedRoute)
      if (this.revealSelection && selected >= 0 && viewport > 0) {
        if (selected < offset) offset = selected
        if (selected >= offset + viewport) offset = selected - viewport + 1
      }
      this[key] = offset
      this.revealSelection = false
      const top = lines.length
      scrollStart = top
      scrollEnd = top + viewport
      for (let index = 0; index < viewport; index += 1) {
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

  private formLines(snapshot: SubagentSettingsSnapshot, width: number): ContentLine[] {
    const lines: ContentLine[] = []
    for (const field of FIELDS) {
      if (field === 'maxDepth' || field === 'enabled') {
        const section = field === 'maxDepth' ? snapshot.limits : snapshot.selection
        lines.push({ text: color.textDim(`${field === 'maxDepth' ? 'Limits' : 'Model selection'} · ${sectionWord(section)}`) })
        if (section.source.kind !== 'ready') lines.push(...this.explanation(section.source.reason, width, true))
      }
      const isLimits = field === 'maxDepth' || field === 'maxActiveSubagents'
      const section = isLimits ? snapshot.limits : snapshot.selection
      const available = section.source.kind === 'ready'
      const value = !available ? 'Unknown' : field === 'maxDepth' ? snapshot.depthText === '' ? 'Reset staged' : snapshot.depthText
        : field === 'maxActiveSubagents' ? snapshot.capacityText === '' ? 'Reset staged' : snapshot.capacityText
          : field === 'enabled' ? snapshot.enabled ? 'On' : 'Off' : allowlistSummary(snapshot.allowedModels)
      const selected = FIELDS[this.fieldIndex] === field
      const marker = selected ? color.primary('> ') : '  '
      const paintedValue = truncateToWidth(sanitizedPhysicalLine(value), Math.max(1, Math.floor(width / 3)), '…', false)
      const label = truncateToWidth(LABELS[field], Math.max(1, width - visibleWidth(paintedValue) - 4), '…', false)
      const text = `${marker}${selected ? color.textStrong(label) : color.text(label)}  ${color.text(paintedValue)}`
      const editable = this.editable(field, snapshot)
      lines.push({ text, field, ...(editable ? { targets: [{ id: `field:${field}`, action: { kind: 'field' as const, field }, startCol: 0, endCol: Math.min(width, visibleWidth(text)) }] } : {}) })
      const source = section.source.kind !== 'ready' ? 'Unknown'
        : `${section.current ? '' : 'Last-known · '}${(section.source.overridden as Readonly<Record<SubagentSettingsField, boolean>>)[field] ? 'Overridden' : 'Inherited'}`
      const stagedReset = (section.patch as Readonly<Partial<Record<SubagentSettingsField, { readonly kind: string }>>>)[field]?.kind === 'reset'
      let detail = color.textDim(`  Source: ${source}${stagedReset ? ' · Reset staged' : ''}`)
      const rowTargets: Omit<Target, 'row'>[] = []
      const addAction = (word: string, action: BodyAction, id: string): void => {
        const startCol = visibleWidth(detail) + 2
        if (startCol + visibleWidth(word) > width) return
        detail += `  ${color.primary(word)}`
        rowTargets.push({ id, action, startCol, endCol: startCol + visibleWidth(word) })
      }
      if (editable && field === 'allowedModels') addAction('Manage…', { kind: 'field', field }, `manage:${field}`)
      if (editable) addAction('Reset', { kind: 'reset', field }, `reset:${field}`)
      lines.push({ text: detail, targets: rowTargets })
      const issue = snapshot.issues[field]
      if (issue !== undefined) lines.push(...this.explanation(issue, width, true))
    }
    lines.push(...this.explanation('Limits apply to new activations; already running activations and child processes are unchanged.', width))
    lines.push(...this.explanation('Model selection is sampled by new top-level Sessions; the current Agent tool schema is unchanged.', width))
    lines.push(...this.explanation('Reset stages the official unset operation. Source compares current effective values with base; Reset does not promise deletion from the USER layer.', width))
    for (const section of [snapshot.limits, snapshot.selection]) {
      if (section.status !== undefined) lines.push(...this.explanation(section.status.text, width, section.status.kind === 'not-saved'))
    }
    if (snapshot.notice !== undefined) lines.push(...this.explanation(snapshot.notice, width, true))
    return lines
  }

  private explanation(text: string, width: number, error = false): ContentLine[] {
    return wrapTextWithAnsi(sanitizedPhysicalLine(text), Math.max(1, width)).map(text => ({ text: error ? color.error(text) : color.textDim(text) }))
  }
  private directoryLines(snapshot: SubagentSettingsSnapshot, width: number): ContentLine[] {
    const models = this.directoryModels(snapshot)
    if (!models.some(row => allowlistRouteKey(row.providerId, row.modelId) === this.selectedRoute)) {
      const first = models.find(row => row.allowed) ?? models[0]
      this.selectedRoute = first === undefined ? undefined : allowlistRouteKey(first.providerId, first.modelId)
    }
    const lines: ContentLine[] = []
    let group: string | undefined
    for (const model of models) {
      const key = allowlistRouteKey(model.providerId, model.modelId)
      const groupKey = model.savedRoute === undefined ? `provider:${model.providerId}` : 'saved'
      if (groupKey !== group) {
        group = groupKey
        lines.push({ text: color.textDim(sanitizedPhysicalLine(model.savedRoute === undefined ? model.providerName : 'Saved routes')) })
      }
      const selected = key === this.selectedRoute
      const state = model.allowed ? '[allowed]' : ''
      const label = sanitizedPhysicalLine(model.modelName ?? model.modelId)
      const room = Math.max(1, width - 2 - (state === '' ? 0 : visibleWidth(state) + 1))
      const name = truncateToWidth(label, room, '…', false)
      const text = `${selected ? color.primary('> ') : '  '}${selected ? color.textStrong(name) : color.text(name)}${state === '' ? '' : ` ${color.textMuted(state)}`}`
      lines.push({ text, routeKey: key, ...(this.editable('allowedModels', snapshot) ? { targets: [{ id: `route:${key}`, action: { kind: 'route' as const, route: { provider: model.providerId, model: model.modelId } }, startCol: 0, endCol: Math.min(width, visibleWidth(text)) }] } : {}) })
      if (selected) {
        lines.push(...this.explanation(`${model.providerId} / ${model.modelId}`, width))
        if (model.savedRoute !== undefined) {
          const note = model.savedRoute === 'absent' ? 'Saved route not in the current catalog.'
            : model.savedRoute === 'catalog-loading' ? 'Saved route; catalog is still loading.'
              : model.savedRoute === 'provider-unavailable' ? 'Saved route; provider catalog unavailable.' : 'Saved route; catalog unavailable.'
          lines.push(...this.explanation(note, width))
        }
      }
    }
    const projection = projectSubagentAllowlist({ catalog: this.catalog, allowed: snapshot.allowedModels })
    for (const failure of projection.failures) lines.push(...this.explanation(`Unavailable: ${failure.providerName}: ${failure.message}`, width, true))
    if (models.length === 0) lines.push({ text: color.textDim(this.catalog.state === 'loading' ? 'Loading models…' : 'No matching models') })
    return lines
  }

  private statusLines(snapshot: SubagentSettingsSnapshot, width: number): string[] {
    if (snapshot.loading) return [fit(color.textDim('Loading Host settings…'), width)]
    const sectionStatus = <T extends object>(name: string, section: SubagentSectionSnapshot<T>): string => {
      const kind = section.status?.kind
      const word = kind === 'outcome-unconfirmed' ? 'Outcome unconfirmed'
        : kind === 'not-saved' ? 'Not saved'
          : kind === 'unverified' ? 'Unverified'
            : kind === 'saving' ? 'Saving…'
              : kind === 'verified' ? 'Verified' : section.dirty ? 'Unsaved' : sectionWord(section)
      return `${color.textDim(`${name}: `)}${statusInk(kind, word)}`
    }
    const lines = [sectionStatus('Limits', snapshot.limits), sectionStatus('Selection', snapshot.selection)]
    const issue = snapshot.issues[FIELDS[this.fieldIndex]!]
    const detail = this.waitNotice && snapshot.saving ? 'Saving… Dispatched writes continue.' : issue ?? snapshot.notice
    if (detail !== undefined) lines.push(color.error(sanitizedPhysicalLine(detail)))
    return lines.map(line => fit(line, width))
  }

  private renderBar(snapshot: SubagentSettingsSnapshot, width: number): string {
    let segments: BarSegment[]
    if (snapshot.saving) segments = [{ text: 'Saving…', priority: 900 }, { text: 'Wait [Esc]', priority: 1000, escape: true }]
    else if (this.rowGrant < 2) segments = [{ text: this.question !== undefined ? 'Keep [Esc]'
      : this.numberInput !== undefined ? 'Cancel [Esc]' : 'Back [Esc]', priority: 1000, escape: true }]
    else if (this.question !== undefined) segments = [
      ...(this.paintedQuestion === this.questionIdentity() ? [{ text: `Discard [${KEYS.yes.toUpperCase()}]`, priority: 900, action: 'discard' as const }] : []),
      { text: 'Keep [Esc]', priority: 1000, escape: true },
    ]
    else if (this.numberInput !== undefined) segments = [
      ...(this.rowGrant >= 3 && this.editable(this.numberInput.field, snapshot) ? [{ text: 'Apply [Enter]', priority: 900, action: 'apply' as const }] : []),
      { text: 'Cancel [Esc]', priority: 1000, escape: true },
    ]
    else if (this.view === 'directory') segments = [
      this.searching ? { text: 'Done [Enter]', priority: 80, action: 'search-done' } : { text: `Search [${KEYS.search}]`, priority: 80, action: 'search' },
      { text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 70, action: 'refresh' },
      { text: 'Back [Esc]', priority: 1000, escape: true },
    ]
    else segments = [
      ...(this.canSave(snapshot) ? [{ text: `Save [${KEYS.save.toUpperCase()}]`, priority: 900, action: 'save' as const }] : []),
      ...(!snapshot.loading ? [{ text: `Refresh [${KEYS.refresh.toUpperCase()}]`, short: 'Refresh', priority: 800, action: 'refresh' as const }] : []),
      ...(this.editable(FIELDS[this.fieldIndex]!, snapshot) ? [{ text: `Reset [${KEYS.reset.toUpperCase()}]`, short: 'Reset', priority: 60, action: 'reset' as const }] : []),
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

  invalidate(): void { this.numberInput?.input.invalidate(); this.searchInput.invalidate() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.catalogAbort?.abort()
    this.revoke()
    this.paint = undefined
    this.numberInput = undefined
    this.controller.dispose()
  }
}
