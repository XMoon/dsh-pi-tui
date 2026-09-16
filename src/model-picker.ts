/**
 * `/model` inline-effort picker: ONE capturing overlay owning ONE
 * SearchablePicker (the provider-grouped flat model list). Reasoning effort
 * is a PER-MODEL, picker-local presentation value edited with `←`/`→` and
 * rendered on the model's own primary row (`current · effort ‹high›`) — never
 * a separate Effort view, so the list's physical height stays constant as the
 * cursor moves. Model descriptions (and the model id) are deliberately NOT
 * rendered, so a selection move can never change the frame height.
 *
 * The panel opens IMMEDIATELY in a `loading` state and hydrates in place via
 * {@link ModelPicker.setDirectory}; a failed directory read shows an in-panel
 * error state ({@link ModelPicker.setLoadError}) instead of closing the
 * overlay. The command layer owns the directory read, the session/generation
 * fences, the global-default vs Session write semantics, the write classifier
 * and the operation tokens; the injected `apply` resolves with the semantic
 * settlement so a rejected/cancelled/unsupported write keeps the picker usable.
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

/** The loaded/effective selection the picker highlights and badges. */
export interface ModelPickerCurrent {
  readonly provider: string
  readonly model: string
  /** The EXPLICIT effective reasoning effort, when the Session projection has
   *  one; absent means the picker must NOT invent a "current effort". */
  readonly reasoningEffort?: string
}

/** One flattened model presentation row, identity-complete: provider/model are
 *  kept separately so duplicate model ids across providers never collapse. */
export interface ModelPickerModelRow {
  readonly providerId: string
  readonly providerName: string
  readonly modelId: string
  readonly modelName: string
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
  readonly isCurrent: boolean
  readonly isDefault: boolean
  /** The explicit effort of the CURRENT Session selection (fact badge only). */
  readonly currentEffort?: string
  /**
   * The explicit effort of the picker's CONFIGURED selection (the live Session
   * selection, or — sessionless — the directory default). Seeds the inline
   * effort value WITHOUT implying a `current` badge, so a sessionless global
   * default of high never silently downgrades to the model default.
   */
  readonly configuredEffort?: string
}

/** One provider whose catalog read failed; inert in the list. */
export interface ModelPickerFailureRow {
  readonly providerId: string
  readonly providerName: string
  readonly message: string
}

export interface ModelPickerProjection {
  readonly models: readonly ModelPickerModelRow[]
  readonly failures: readonly ModelPickerFailureRow[]
}

/** The hydration payload the command layer supplies once the directory read
 *  settles (the panel may already be visible in its loading state). */
export interface ModelPickerDirectory {
  readonly directory: ModelDirectoryDto
  readonly current: ModelPickerCurrent | undefined
  readonly sessionless: boolean
}

/** The picker's dependencies: the command layer's write/lifecycle seams. The
 *  directory arrives later through {@link ModelPicker.setDirectory}. */
export interface ModelPickerDeps {
  /** Commit a selection and resolve with its semantic settlement. */
  apply(selection: ModelSelectionDto): Promise<ModelApplyOutcome> | ModelApplyOutcome
  /** Request a frame so a hydration/effort/selecting change renders. */
  requestRender(): void
  /** Close the whole overlay (settled commit, or the model view's Esc). */
  close(): void
  /** The owned-task entry (runOwned shape, diag pre-wired by the runner): the
   *  async write routes through it instead of a bare `void promise`. */
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

const IDENTITY_SEP = '\u0000'
/** The synthetic `provider default` effort choice (submit without an effort). */
const PROVIDER_DEFAULT = `${IDENTITY_SEP}provider-default`
const FAILURE_PREFIX = `${IDENTITY_SEP}failure${IDENTITY_SEP}`
/** One shared group key for EVERY failed provider, so all failures collapse
 *  into a single private `Unavailable` section (a real provider's own
 *  `groupKey` is its id and can never collide with this NUL-prefixed key). */
const FAILURE_GROUP_KEY = `${IDENTITY_SEP}unavailable`

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
      const matchesConfigured = current !== undefined
        && current.provider === group.id
        && current.model === model.id
      const isCurrentModel = !sessionless && matchesConfigured
      const isDefault = directory.default.provider === group.id && directory.default.model === model.id
      models.push({
        providerId: group.id,
        providerName: group.name,
        modelId: model.id,
        modelName: model.name,
        efforts: model.reasoning?.efforts ?? [],
        ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
        isCurrent: isCurrentModel,
        isDefault,
        // Only the current model can carry a current effort; it must be the
        // EXPLICIT projection effort (an absent one stays absent).
        ...(isCurrentModel && current?.reasoningEffort !== undefined ? { currentEffort: current.reasoningEffort } : {}),
        // The configured selection's effort is independent of the `current`
        // badge: sessionless has no current model, yet its global default's
        // effort must still seed the inline effort value.
        ...(matchesConfigured && current?.reasoningEffort !== undefined ? { configuredEffort: current.reasoningEffort } : {}),
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

/** The picker-local effort CHOICES for one model, in cycle order. A model with
 *  NO effort metadata has none — Left/Right must be a true no-op there. The
 *  synthetic `provider default` joins the cycle only when the model declares
 *  efforts but no concrete default. */
function effortChoicesOf(row: ModelPickerModelRow): string[] {
  if (row.efforts.length === 0) return []
  return row.defaultEffort === undefined
    ? [PROVIDER_DEFAULT, ...row.efforts.map(effort => effort.id)]
    : row.efforts.map(effort => effort.id)
}

/** The initial picker-local effort for one model: the configured/current
 *  explicit effort when advertised, else the model default, else provider
 *  default; `undefined` for a model with no effort metadata at all. */
function initialEffortOf(row: ModelPickerModelRow): string | undefined {
  if (row.efforts.length === 0) return undefined
  if (row.configuredEffort !== undefined && row.efforts.some(effort => effort.id === row.configuredEffort)) {
    return row.configuredEffort
  }
  return row.defaultEffort ?? PROVIDER_DEFAULT
}

/** The compact inline token for one effort choice (`high`, `provider default`). */
function effortTokenOf(choice: string): string {
  return choice === PROVIDER_DEFAULT ? 'provider default' : choice
}

/**
 * The `/model` picker: one SearchablePicker over a provider-grouped flat model
 * list, with a per-model inline effort value. Mounted by the host as ONE
 * capturing overlay; it starts in `loading` and hydrates in place.
 */
export class ModelPicker implements Component, RowBudgetAware, Focusable {
  private readonly deps: ModelPickerDeps
  private readonly modelsList: SearchablePicker
  private readonly modelRows = new Map<string, ModelPickerModelRow>()
  /** Per-model picker-local effort value (`effort id` or PROVIDER_DEFAULT). */
  private readonly effortChoices = new Map<string, string>()
  private failures: readonly ModelPickerFailureRow[] = []
  /** The last host row grant, re-applied on hydration and resize. */
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
    this.modelsList.focused = value
  }

  constructor(deps: ModelPickerDeps) {
    this.deps = deps
    this.modelsList = new SearchablePicker([], 8, selectListTheme, {}, {
      enableSearch: true,
      showHint: true,
      header: 'Models',
      hint: '↑↓ model · ←→ effort · enter select · esc close',
      noMatchText: '  Loading models…',
      descriptionMode: 'selected-below',
    })
    this.modelsList.onSelect = (item) => { this.confirm(item.value) }
    this.modelsList.onCancel = () => { this.deps.close() }
    this.setMaxRows(this.rowGrant)
  }

  /** Whether this picker has been torn down (the command layer's stale-load
   *  fence: a late directory settle must not hydrate a disposed surface). */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Host row-budget seam: kept and forwarded to the list on hydration too. */
  setMaxRows(rows: number): void {
    this.rowGrant = rows
    this.modelsList.setMaxRows(rows)
  }

  /** Hydrate the panel IN PLACE once the directory read settles: project the
   *  rows, seed each model's inline effort, and preserve the query the user
   *  may already have typed while loading (`setItems` re-applies the filter and
   *  keeps a surviving selected value). A no-op on a disposed picker. */
  setDirectory(input: ModelPickerDirectory): void {
    if (this.disposed) return
    const projection = projectModelDirectory(input.directory, input.current, input.sessionless)
    this.modelRows.clear()
    this.effortChoices.clear()
    for (const row of projection.models) {
      const identity = modelIdentity(row.providerId, row.modelId)
      this.modelRows.set(identity, row)
      const initial = initialEffortOf(row)
      if (initial !== undefined) this.effortChoices.set(identity, initial)
    }
    this.failures = projection.failures
    const items = this.buildItems()
    // A settled-but-empty catalog is not a "no match" (nothing was filtered).
    this.modelsList.setNoMatchText(items.length === 0 ? '  No models available' : '  No matching models')
    this.modelsList.setItems(items)
    // Identity-based initial selection: highlight the configured (provider,
    // model). An unlisted selection matches nothing and the cursor stays on
    // the first filtered row (never a same-id other provider).
    if (input.current !== undefined) {
      this.modelsList.setSelectedValue(modelIdentity(input.current.provider, input.current.model))
    }
    this.modelsList.setMaxRows(this.rowGrant)
    this.deps.requestRender()
  }

  /** Replace the loading state with an in-panel error (never close + print in
   *  the transcript). No retry; Esc still closes; Enter is inert. */
  setLoadError(message: string): void {
    if (this.disposed) return
    this.modelRows.clear()
    this.effortChoices.clear()
    this.failures = []
    this.modelsList.setItems([])
    this.modelsList.setNoMatchText(message === ''
      ? '  Model catalog unavailable'
      : `  Model catalog unavailable: ${message}`)
    this.deps.requestRender()
  }

  private buildItems(): SearchablePickerItem[] {
    const items: SearchablePickerItem[] = []
    for (const row of this.modelRows.values()) {
      const identity = modelIdentity(row.providerId, row.modelId)
      const badge = this.modelBadgeOf(row)
      items.push({
        value: identity,
        label: row.modelName,
        // The header shows the display name; the GROUP IDENTITY is the
        // provider id, so distinct providers that share a display name (or a
        // provider literally named "Unavailable") never merge into one group.
        group: row.providerName,
        groupKey: row.providerId,
        ...(badge === undefined ? {} : { badge }),
        // Search covers provider/model NAME + ID only: the (hidden) model
        // description and effort descriptions are deliberately NOT searchable.
        searchText: `${row.providerId} ${row.modelId} ${row.providerName} ${row.modelName}`,
      })
    }
    for (const failure of this.failures) {
      items.push({
        value: `${FAILURE_PREFIX}${failure.providerId}`,
        label: failure.providerName,
        description: failure.message,
        group: 'Unavailable',
        groupKey: FAILURE_GROUP_KEY,
        badge: 'unavailable',
        searchText: `${failure.providerId} ${failure.providerName}`,
      })
    }
    return items
  }

  /** The right-aligned badge: factual state (`current`/`default`) plus the
   *  picker-local `effort ‹…›` value. */
  private modelBadgeOf(row: ModelPickerModelRow): string | undefined {
    const parts: string[] = []
    if (row.isCurrent) parts.push('current')
    if (row.isDefault) parts.push('default')
    const choice = this.effortChoices.get(modelIdentity(row.providerId, row.modelId))
    if (choice !== undefined) parts.push(`effort ‹${effortTokenOf(choice)}›`)
    return parts.length === 0 ? undefined : parts.join(' · ')
  }

  /** Cycle the highlighted model's inline effort. Failure rows and models
   *  without effort metadata are a no-op (the key is still consumed). */
  private adjustEffort(step: 1 | -1): void {
    const item = this.modelsList.getSelectedItem()
    if (item === null) return
    const row = this.modelRows.get(item.value)
    if (row === undefined) return
    const choices = effortChoicesOf(row)
    if (choices.length === 0) return
    const current = this.effortChoices.get(item.value) ?? choices[0]!
    const index = Math.max(0, choices.indexOf(current))
    const next = choices[(index + step + choices.length) % choices.length]!
    this.effortChoices.set(item.value, next)
    // setItems preserves the selected row by VALUE, so the cursor stays put.
    this.modelsList.setItems(this.buildItems())
    this.deps.requestRender()
  }

  handleInput(data: string): void {
    if (this.disposed || this.selecting) return
    // `←`/`→` are the effort keys in EVERY state: consumed here, so they never
    // double as a text-cursor move inside the search box (search cursor
    // movement stays on the Input's Ctrl+B/Ctrl+F). Before hydration — and for
    // a model without effort metadata — `adjustEffort` is a no-op, so the key
    // is simply inert (plan §20).
    if (matchesKey(data, 'right')) {
      this.adjustEffort(1)
      return
    }
    if (matchesKey(data, 'left')) {
      this.adjustEffort(-1)
      return
    }
    // Everything else (Esc close, typing, ↑↓/PageUp/PageDown/Enter) goes to the
    // list; before hydration the empty list already makes navigation and Enter
    // inert while the search box still accepts typing.
    this.modelsList.handleInput(data)
  }

  /** Confirm the highlighted row: submit the model together with its CURRENT
   *  inline effort (or no effort for provider-default / no-effort models).
   *  Failure rows are inert. */
  private confirm(value: string): void {
    if (this.disposed || this.selecting) return
    const row = this.modelRows.get(value)
    if (row === undefined) return
    const choice = this.effortChoices.get(value)
    this.submit(row, choice === undefined || choice === PROVIDER_DEFAULT ? undefined : choice)
  }

  /** Submit one selection: the semantic write owns the settlement, so the
   *  overlay shows a selecting state and only dismisses once the outcome is
   *  known. A rejected/cancelled/unsupported/errored write clears the selecting
   *  state and keeps the picker usable; committed/indeterminate dismiss. */
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
        // A write that provably did not commit keeps the picker usable; the
        // caller's notice explains the refusal.
        if (outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unsupported') {
          this.deps.requestRender()
          return
        }
        this.deps.close()
      },
      onError: () => {
        if (this.disposed) return
        this.selecting = false
        this.deps.requestRender()
      },
    })
  }

  /** Ownership-safe external disposal: the overlay's owning frame calls this
   *  when the picker is removed or replaced (app teardown, overlay replacement,
   *  a newer `/model` surface — NOT the picker's own Esc/selection). Teardown
   *  is ownership, not a user choice: it never calls close/apply/navigation,
   *  and the disposed latch fences a late settlement from repainting a dead
   *  surface. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
  }

  /** Transparent mouse forwarding: the list owns row hit-testing and its own
   *  last-painted-geometry fence. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.selecting) return undefined
    return this.modelsList.handleMouse?.(event)
  }

  invalidate(): void {
    this.modelsList.invalidate()
  }

  render(width: number): string[] {
    if (this.selecting) return ['  Selecting…']
    return this.modelsList.render(width)
  }
}
