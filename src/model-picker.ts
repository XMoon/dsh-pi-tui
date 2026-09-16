/**
 * `/model` picker: ONE capturing overlay with two internal views. The model
 * list is a provider-grouped flat command palette (no provider-first
 * navigation); `Right` drills into the highlighted model's reasoning-effort
 * list and `Left`/`Esc` returns to the model list with its query, selection
 * and scroll window intact. Model ↔ Effort is a VIEW SWAP inside the same
 * mounted component — never a nested `openSettings`/picker overlay, which
 * would leave a ghost panel and layered Esc ownership beneath it.
 *
 * The component owns presentation only. The directory read, session/
 * generation fences, the global-default vs Session write semantics, the
 * write classifier and the operation token stay in the command layer; the
 * injected `apply` resolves with the semantic settlement so a rejected /
 * cancelled / unsupported write keeps the picker usable.
 *
 * @module @xmoon76/dsh-pi-tui/model-picker
 */

import {
  matchesKey,
  type Component,
  type Focusable,
  type RowBudgetAware,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type { OwnedTaskOptions } from './detached.ts'
import type { ModelDirectoryDto, ModelSelectionDto } from './runtime/catalog-port.ts'
import { SearchablePicker, type SearchablePickerItem } from './searchable-picker.ts'
import { selectListTheme } from './theme.ts'

/** The semantic settlement of one applied selection, as the picker needs it:
 *  a rejected/cancelled/unsupported write never committed, so the picker stays
 *  usable; a committed/indeterminate settle dismisses it. */
export type ModelApplyOutcome = 'committed' | 'rejected' | 'cancelled' | 'indeterminate' | 'unsupported' | 'superseded'

/** The live/effective selection the picker highlights and badges. */
export interface ModelPickerCurrent {
  readonly provider: string
  readonly model: string
  /** The EXPLICIT effective reasoning effort, when the Session projection has
   *  one; absent means the picker must NOT invent a "current effort". */
  readonly reasoningEffort?: string
}

/** One flattened model presentation row (Models view), identity-complete:
 *  provider/model are kept separately so duplicate model ids across providers
 *  never collapse into one logical row. */
export interface ModelPickerModelRow {
  readonly providerId: string
  readonly providerName: string
  readonly modelId: string
  readonly modelName: string
  readonly description?: string
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
  readonly isCurrent: boolean
  readonly isDefault: boolean
  readonly currentEffort?: string
}

/** One provider whose catalog read failed; inert in the Models view. */
export interface ModelPickerFailureRow {
  readonly providerId: string
  readonly providerName: string
  readonly message: string
}

export interface ModelPickerProjection {
  readonly models: readonly ModelPickerModelRow[]
  readonly failures: readonly ModelPickerFailureRow[]
}

/** The picker's dependencies: a loaded directory snapshot plus the command
 *  layer's write/lifecycle seams. No Host service objects cross this seam. */
export interface ModelPickerDeps {
  readonly directory: ModelDirectoryDto
  /** The effective selection to highlight (Session selection for a live
   *  Session, the directory default for a sessionless surface). */
  readonly current: ModelPickerCurrent | undefined
  /** A sessionless surface has no live "current" model: the directory default
   *  is a `default` fact, never a fabricated `current`. */
  readonly sessionless: boolean
  /** Commit a selection and resolve with its semantic settlement. The command
   *  layer owns all validation/write semantics; this callback is the seam. */
  apply(selection: ModelSelectionDto): Promise<ModelApplyOutcome> | ModelApplyOutcome
  /** Request a frame so a swapped-in view or the selecting state renders. */
  requestRender(): void
  /** Close the whole overlay (settled commit, or the model view's Esc). */
  close(): void
  /** The owned-task entry (runOwned shape, diag pre-wired by the runner):
   *  the async write routes through it instead of a bare `void promise`. */
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

const IDENTITY_SEP = '\u0000'
/** The synthetic `Provider default` effort row (submit with no effort id). */
const PROVIDER_DEFAULT = `${IDENTITY_SEP}provider-default`
const FAILURE_PREFIX = `${IDENTITY_SEP}failure${IDENTITY_SEP}`

/** Full logical identity of a model row. Model ids are not globally unique. */
export function modelIdentity(providerId: string, modelId: string): string {
  return `${providerId}${IDENTITY_SEP}${modelId}`
}

/**
 * Project the Host directory into identity-complete presentation rows. Pure:
 * no terminal/component state, so the current/default/effort rules are unit
 * testable without a rendering snapshot.
 */
export function projectModelDirectory(
  directory: ModelDirectoryDto,
  current: ModelPickerCurrent | undefined,
  sessionless: boolean,
): ModelPickerProjection {
  const models: ModelPickerModelRow[] = []
  for (const group of directory.groups) {
    for (const model of group.models) {
      // Full (provider, model) identity: a same-id model under another
      // provider must never be marked current/default.
      const isCurrentModel = !sessionless
        && current !== undefined
        && current.provider === group.id
        && current.model === model.id
      const isDefault = directory.default.provider === group.id && directory.default.model === model.id
      models.push({
        providerId: group.id,
        providerName: group.name,
        modelId: model.id,
        modelName: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        efforts: model.reasoning?.efforts ?? [],
        ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
        isCurrent: isCurrentModel,
        isDefault,
        // Only the current model can carry a current effort; it must be the
        // EXPLICIT projection effort (an absent one stays absent).
        ...(isCurrentModel && current?.reasoningEffort !== undefined ? { currentEffort: current.reasoningEffort } : {}),
      })
    }
  }
  const failures: ModelPickerFailureRow[] = directory.failures.map(failure => ({
    providerId: failure.id,
    providerName: failure.name,
    message: failure.message,
  }))
  return { models, failures }
}

/** The `current · default · high` badge for a model row (absent when neither
 *  fact holds). */
function modelBadge(row: ModelPickerModelRow): string | undefined {
  const parts: string[] = []
  if (row.isCurrent) parts.push('current')
  if (row.isDefault) parts.push('default')
  if (row.currentEffort !== undefined) parts.push(row.currentEffort)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** The selected-only detail: `id · description`, without repeating an id that
 *  already IS the display name. */
function modelDetail(row: ModelPickerModelRow): string | undefined {
  const parts: string[] = []
  if (row.modelName !== row.modelId) parts.push(row.modelId)
  if (row.description !== undefined && row.description !== '') parts.push(row.description)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * The `/model` picker component: a Models view (grouped flat list, search
 * over name/id/provider, selected-only detail) and an Efforts view for the
 * highlighted model. Mounted by the host as ONE capturing overlay.
 */
export class ModelPicker implements Component, RowBudgetAware, Focusable {
  private readonly deps: ModelPickerDeps
  private readonly modelsList: SearchablePicker
  private readonly modelRows: Map<string, ModelPickerModelRow>
  private mode: { kind: 'models' } | { kind: 'efforts'; row: ModelPickerModelRow } = { kind: 'models' }
  private effortsList: SearchablePicker | undefined
  /** The inner that was ACTUALLY PAINTED last (mouse parity): a view swap
   *  between paint and pointer event must not let the new view eat a click
   *  aimed at the old screen. */
  private paintedList: SearchablePicker
  /** The last host row grant, re-applied to a view swapped in after a resize. */
  private rowGrant = Number.POSITIVE_INFINITY
  private _focused = false
  /** Whether a semantic selection is in flight (blocks a duplicate apply). */
  private selecting = false
  /** Latched by every close/dispose path; late settlements must not act. */
  private disposed = false

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.applyFocused()
  }

  constructor(deps: ModelPickerDeps) {
    this.deps = deps
    const projection = projectModelDirectory(deps.directory, deps.current, deps.sessionless)
    this.modelRows = new Map(projection.models.map(row => [modelIdentity(row.providerId, row.modelId), row]))
    const modelItems: SearchablePickerItem[] = projection.models.map((row) => {
      const detail = modelDetail(row)
      const badge = modelBadge(row)
      return {
        value: modelIdentity(row.providerId, row.modelId),
        label: row.modelName,
        ...(detail === undefined ? {} : { description: detail }),
        // The header shows the display name; the GROUP IDENTITY is the
        // provider id, so distinct providers that share a display name (or a
        // provider literally named "Unavailable") never merge into one group.
        group: row.providerName,
        groupKey: row.providerId,
        ...(badge === undefined ? {} : { badge }),
        searchText: `${row.providerId} ${row.modelId} ${row.providerName} ${row.modelName}`,
      }
    })
    const items: SearchablePickerItem[] = [
      ...modelItems,
      // A failed provider is an inert presentation row: it stays searchable
      // (provider name/id) and shows its message as selected-only detail, but
      // Enter/Right are no-ops so it can never submit a fake model.
      ...projection.failures.map(row => ({
        value: `${FAILURE_PREFIX}${row.providerId}`,
        label: row.providerName,
        description: row.message,
        group: 'Unavailable',
        // A private key so a provider also named "Unavailable" keeps its own
        // section/count instead of merging with the failure section.
        groupKey: `${FAILURE_PREFIX}${row.providerId}`,
        badge: 'unavailable',
        searchText: `${row.providerId} ${row.providerName}`,
      })),
    ]
    this.modelsList = new SearchablePicker(items, 8, selectListTheme, {}, {
      enableSearch: true,
      showHint: true,
      header: 'Models',
      hint: '↑↓ move · enter select · → effort · esc close',
      noMatchText: '  No matching models',
      descriptionMode: 'selected-below',
    })
    this.modelsList.onSelect = (item) => { this.confirmModel(item.value) }
    this.modelsList.onCancel = () => { this.deps.close() }
    this.paintedList = this.modelsList
    // Identity-based initial selection: highlight the current (provider,
    // model). An unlisted current model matches nothing and the selection
    // stays on the first catalog row (never a same-id other provider).
    if (deps.current !== undefined) {
      this.modelsList.setSelectedValue(modelIdentity(deps.current.provider, deps.current.model))
    }
    this.applyGrant()
  }

  /** Host row-budget seam: keep the grant and forward it to the active view,
   *  so a view swapped in after a resize still reflows. */
  setMaxRows(rows: number): void {
    this.rowGrant = rows
    this.applyGrant()
  }

  private applyGrant(): void {
    const list = this.activeList()
    list.setMaxRows(this.rowGrant)
  }

  private applyFocused(): void {
    this.activeList().focused = this._focused
  }

  private activeList(): SearchablePicker {
    return this.mode.kind === 'models' ? this.modelsList : this.effortsList ?? this.modelsList
  }

  handleInput(data: string): void {
    if (this.disposed || this.selecting) return
    if (this.mode.kind === 'models') {
      // `Right` is the Effort drill-down (the footer advertises it): it is
      // consumed even when the highlighted model has no effort choices, so it
      // never doubles as a text-cursor move inside the search box. Search
      // horizontal cursor movement stays on the Input's Ctrl+B/Ctrl+F.
      if (matchesKey(data, 'right')) {
        this.enterEfforts()
        return
      }
      this.modelsList.handleInput(data)
      return
    }
    // Efforts view: `Left` returns to the model view (the efforts list's own
    // cancel path handles Esc/ctrl+c through onCancel). The whole overlay
    // closes only from the model view's Esc.
    if (matchesKey(data, 'left')) {
      this.showModels()
      return
    }
    this.activeList().handleInput(data)
  }

  /** Drill into the highlighted model's effort list. A no-op when the row is
   *  a failure or has no effort choices (Right is still consumed). */
  private enterEfforts(): boolean {
    const item = this.modelsList.getSelectedItem()
    if (item === null) return false
    const row = this.modelRows.get(item.value)
    if (row === undefined || row.efforts.length === 0) return false
    this.mode = { kind: 'efforts', row }
    this.effortsList = this.buildEffortsList(row)
    this.applyGrant()
    this.applyFocused()
    this.deps.requestRender()
    return true
  }

  private showModels(): void {
    if (this.mode.kind !== 'models') {
      this.mode = { kind: 'models' }
      this.effortsList = undefined
      this.applyGrant()
      this.applyFocused()
    }
    // Always repaint: a failure settlement that arrives AFTER the `Selecting…`
    // frame has painted must visibly restore the model view (clearing the
    // latch alone leaves the stale frame on screen).
    this.deps.requestRender()
  }

  /** The effort rows for one model, with the plan's cursor contract:
   *  - current model with an explicit current effort → that row;
   *  - otherwise the model's concrete `defaultEffort` (badged `default`);
   *  - otherwise the synthetic `Provider default` (submit without effort).
   *  A non-current model never carries a `current` badge. */
  private buildEffortsList(row: ModelPickerModelRow): SearchablePicker {
    const currentEffort = row.isCurrent ? row.currentEffort : undefined
    const items: SearchablePickerItem[] = []
    if (row.defaultEffort === undefined) {
      items.push({ value: PROVIDER_DEFAULT, label: 'Provider default' })
    }
    for (const effort of row.efforts) {
      const badges: string[] = []
      if (currentEffort === effort.id) badges.push('current')
      if (row.defaultEffort === effort.id) badges.push('default')
      items.push({
        value: effort.id,
        label: effort.name,
        ...(badges.length === 0 ? {} : { badge: badges.join(' · ') }),
      })
    }
    const list = new SearchablePicker(items, 8, selectListTheme, {}, {
      showHint: true,
      header: `Models › ${row.modelName}`,
      hint: '← model · enter select · esc back',
      noMatchText: '  No efforts',
    })
    list.onSelect = (item) => {
      this.submit(row, item.value === PROVIDER_DEFAULT ? undefined : item.value)
    }
    list.onCancel = () => { this.showModels() }
    // Cursor: the current effective effort when the current model has one,
    // else the model default, else Provider default.
    const cursor = currentEffort !== undefined && row.efforts.some(effort => effort.id === currentEffort)
      ? currentEffort
      : row.defaultEffort ?? PROVIDER_DEFAULT
    list.setSelectedValue(cursor)
    return list
  }

  /** Submit one selection: the semantic write owns the settlement, so the
   *  overlay shows a selecting state and only dismisses once the outcome is
   *  known. A rejected/cancelled/unsupported write returns to the model view
   *  (the picker stays usable); committed/indeterminate dismiss. */
  private submit(row: ModelPickerModelRow, effortId: string | undefined): void {
    if (this.disposed || this.selecting) return
    this.selecting = true
    this.deps.requestRender()
    const selection: ModelSelectionDto = effortId === undefined
      ? { provider: row.providerId, model: row.modelId }
      : { provider: row.providerId, model: row.modelId, reasoningEffort: effortId }
    this.deps.runOwned('model selection', () => this.deps.apply(selection), {
      isCancellation: () => this.disposed,
      onResult: (outcome) => {
        if (this.disposed) return
        // A locally superseded operation makes NO close/open decision, emits
        // no success/error notice AND repaints nothing — a newer operation owns
        // the surface, so the selecting state is left exactly as painted.
        if (outcome === 'superseded') return
        this.selecting = false
        // A write that provably did not commit keeps the picker usable: walk
        // back to the model view; the caller's notice explains the refusal.
        if (outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unsupported') {
          this.showModels()
          return
        }
        this.deps.close()
      },
      onError: () => {
        if (this.disposed) return
        this.selecting = false
        this.showModels()
      },
    })
  }

  /** Confirm the Models-view row: apply the model directly (no synthesized
   *  effort). Failure rows are inert. */
  private confirmModel(value: string): void {
    if (this.disposed || this.selecting) return
    const row = this.modelRows.get(value)
    if (row === undefined) return
    this.submit(row, undefined)
  }

  /** Ownership-safe external disposal: the overlay's owning frame calls this
   *  when the picker is removed or replaced (app teardown, overlay replacement
   *  — NOT the picker's own Esc/selection). Teardown is ownership, not a user
   *  choice: it never calls close/apply/navigation, and the disposed latch
   *  fences a late settlement from repainting a dead surface. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
  }

  /** Transparent mouse forwarding (mouse parity): the active view owns row
   *  hit-testing and its own last-painted width map. A view swapped in but not
   *  yet painted must not receive a click aimed at the previous screen. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.selecting) return undefined
    const list = this.activeList()
    if (list !== this.paintedList) return undefined
    return list.handleMouse?.(event)
  }

  invalidate(): void {
    this.activeList().invalidate?.()
  }

  render(width: number): string[] {
    if (this.selecting) return ['  Selecting…']
    const list = this.activeList()
    this.paintedList = list
    return list.render(width)
  }
}
