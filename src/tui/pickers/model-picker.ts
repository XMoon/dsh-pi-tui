/**
 * `/model` inline-effort picker: ONE capturing overlay owning ONE
 * SearchablePicker (the provider-grouped flat model list) and a two-phase
 * keyboard focus — never a second view/page.
 *
 * - MODEL mode (the default): `↑`/`↓` move the model, `←`/`→` are the Search
 *   Input's text cursor, typing edits the query, and `Enter` either FOCUSES the
 *   highlighted reasoning model's inline effort (no write) or commits a model
 *   with no effort choice. `Esc` closes the overlay.
 * - EFFORT mode (explicitly entered): the SAME row is focused, rendered as
 *   `effort [ High ]` instead of `effort ‹High›`; `←`/`→` cycle that model's
 *   effort, `Enter` commits the visible selection, `Esc` backs out to MODEL
 *   mode, and every other key is consumed.
 *
 * The effort is a PER-MODEL, picker-local presentation value keyed by the full
 * `(provider, model)` identity and rendered on the model's own primary row, so
 * the list's physical height stays constant across selection, cycling and
 * focus changes. Model descriptions (and the model id) are deliberately NOT
 * rendered, so a selection move can never change the frame height either.
 *
 * The panel opens IMMEDIATELY in a `loading` state and hydrates in place via
 * {@link ModelPicker.setDirectory}; a failed directory read shows an in-panel
 * error state ({@link ModelPicker.setLoadError}) instead of closing the
 * overlay. The command layer owns the directory read, the session/generation
 * fences, the global-default vs Session write semantics, the write classifier
 * and the operation tokens; the injected `apply` resolves with the semantic
 * settlement so a rejected/cancelled/unsupported write keeps the picker usable.
 *
 * @module @xmoon76/dsh-pi-tui/tui/pickers/model-picker
 */

import {
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type RowBudgetAware,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'
import type { ModelSelectionDto } from '../../runtime/catalog-port.ts'
import { SearchablePicker, joinBadgeParts, type SearchablePickerBadgePart, type SearchablePickerItem } from './searchable-picker.ts'
import { color, selectListTheme } from '../theme/runtime.ts'

import type {
  ModelApplyOutcome,
  ModelPickerDirectory,
  ModelPickerSubject,
} from '../../app/command/model-presentation.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import {
  modelIdentity,
  projectModelDirectory,
  effortChoicesOf,
  initialEffortOf,
  PROVIDER_DEFAULT,
  type ModelPickerModelRow,
  type ModelPickerFailureRow,
  type InlineEffortChoice,
} from './model-directory.ts'
export { modelIdentity, projectModelDirectory } from './model-directory.ts'
export type {
  ModelPickerCurrent,
  ModelPickerModelRow,
  ModelPickerFailureRow,
  ModelPickerProjection,
} from './model-directory.ts'
export type {
  ModelApplyOutcome,
  ModelPickerDirectory,
  ModelPickerSubject,
} from '../../app/command/model-presentation.ts'

/** The picker's dependencies: the command layer's write/lifecycle seams. The
 *  directory arrives later through {@link ModelPicker.setDirectory}. */
export interface ModelPickerDeps {
  /** The write subject the command captured at open: whether the user was
   *  sessionless. Fixed for this picker's whole life (never re-derived here). */
  subject: ModelPickerSubject
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
const FAILURE_PREFIX = `${IDENTITY_SEP}failure${IDENTITY_SEP}`
/** One shared group key for EVERY failed provider, so all failures collapse
 *  into a single private `Unavailable` section (a real provider's own
 *  `groupKey` is its id and can never collide with this NUL-prefixed key). */
const FAILURE_GROUP_KEY = `${IDENTITY_SEP}unavailable`
/** Model-mode footer hint: Enter either focuses the inline effort (reasoning
 *  model) or commits directly (no-effort model). §4.1/§7.1 key tokens are
 *  Capitalized, verbs lowercase, and `Esc` is last (§7.2/D8). */
const MODEL_MODE_HINT = '↑↓ model · Enter effort/select · Esc close'
/** Effort-mode footer hint: the same row, now editing its effort. */
const EFFORT_MODE_HINT = '←→ effort · Enter select · Esc back'

/** The human-facing label for one effort value within a row's candidates. */
function effortLabelOf(choices: readonly InlineEffortChoice[], value: string): string | undefined {
  return choices.find(choice => choice.value === value)?.label
}

/** The inline effort token: `effort ‹Name›` normally, `effort [ Name ]` while
 *  the row owns the inline effort focus (a shape change, so it is legible
 *  without color). */
function effortTokenOf(label: string, active: boolean): string {
  return active ? `effort [ ${label} ]` : `effort ‹${label}›`
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
  /** Per-model picker-local effort VALUE (`effort id` or PROVIDER_DEFAULT). */
  private readonly effortChoices = new Map<string, string>()
  /** Per-model effort candidates (value + human label), in cycle order. */
  private readonly choicesByModel = new Map<string, readonly InlineEffortChoice[]>()
  private failures: readonly ModelPickerFailureRow[] = []
  /** The last host row grant, re-applied on hydration and resize. */
  private rowGrant = Number.POSITIVE_INFINITY
  private _focused = false
  /** Whether a semantic selection is in flight (blocks a duplicate apply). */
  private selecting = false
  /** Latched by every close/dispose path; late settlements must not act. */
  private disposed = false
  /**
   * Keyboard focus mode. `models` is the normal list; `effort` is the inline
   * two-phase edit of ONE model's effort, BOUND to its full identity so an
   * async refresh can never re-target it. This is a focus mode over the SAME
   * SearchablePicker — never a second view/page.
   */
  private interactionMode: { kind: 'models' } | { kind: 'effort'; modelKey: string } = { kind: 'models' }
  /** One-shot latch: a refresh that removed the effort-bound model already
   *  released the focus, so the NEXT key is consumed instead of falling through
   *  onto the replacement row. */
  private swallowNextKey = false

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
      hint: MODEL_MODE_HINT,
      noMatchText: '  Loading models…',
      descriptionMode: 'selected-below',
      // Model identity must never be squeezed out by a long factual/effort
      // badge: when label + badge cannot share the row, the badge wraps onto
      // an inert second line.
      badgeLayout: 'wrap-when-needed',
    })
    this.modelsList.onSelect = (item) => { this.activateModel(item.value) }
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
    // Every (re-)hydration starts from a clean latch: only THIS refresh may
    // consume the next key, and only if it actually drops the bound model.
    this.swallowNextKey = false
    const projection = projectModelDirectory(input.directory, input.current, this.deps.subject.sessionless)
    // A refresh must NOT discard the user's picker-local effort edits: keep the
    // previous value for every surviving identity while it is still advertised,
    // and only (re-)anchor to configured/default/provider-default otherwise.
    const previousChoices = new Map(this.effortChoices)
    this.modelRows.clear()
    this.effortChoices.clear()
    this.choicesByModel.clear()
    for (const row of projection.models) {
      const identity = modelIdentity(row.providerId, row.modelId)
      this.modelRows.set(identity, row)
      const choices = effortChoicesOf(row)
      this.choicesByModel.set(identity, choices)
      const previous = previousChoices.get(identity)
      const initial = previous !== undefined && choices.some(choice => choice.value === previous)
        ? previous
        : initialEffortOf(row, choices)
      if (initial !== undefined) this.effortChoices.set(identity, initial)
    }
    this.failures = projection.failures
    // An effort focus is bound to a full identity: drop back to model mode when
    // that exact model did not survive the (re-)hydration OR when it lost all
    // reasoning metadata. A VANISHED model also consumes the next key: a
    // refresh that yanks the model out from under the user must not let the
    // very next Enter/Esc fall through onto the replacement row. A surviving
    // no-effort model keeps the normal fast path (Enter commits it).
    if (this.interactionMode.kind === 'effort') {
      const modelKey = this.interactionMode.modelKey
      const survives = this.modelRows.has(modelKey)
      const hasChoices = survives && (this.choicesByModel.get(modelKey)?.length ?? 0) > 0
      if (!survives || !hasChoices) {
        this.interactionMode = { kind: 'models' }
        this.modelsList.setHint(MODEL_MODE_HINT)
        if (!survives) this.swallowNextKey = true
      }
    }
    const items = this.buildItems()
    // A settled-but-empty catalog is not a "no match" (nothing was filtered).
    this.modelsList.setNoMatchText(items.length === 0 ? '  No models available' : '  No matching models')
    this.modelsList.setItems(items)
    // Identity-based selection: a SURVIVING inline-effort focus keeps its own
    // row selected (the focus and the cursor must never point at different
    // rows); otherwise highlight the configured (provider, model). An unlisted
    // value matches nothing and the cursor stays on the first filtered row
    // (never a same-id other provider).
    if (this.interactionMode.kind === 'effort') {
      this.modelsList.setSelectedValue(this.interactionMode.modelKey)
    } else if (input.current !== undefined) {
      this.modelsList.setSelectedValue(modelIdentity(input.current.provider, input.current.model))
    }
    this.modelsList.setMaxRows(this.rowGrant)
    this.deps.requestRender()
  }

  /** Enter the loading presentation: the command layer's read owner started
   *  (re-)reading the directory. Restores exactly the constructor's state while
   *  keeping the mounted panel, so a retry never closes and reopens it. */
  setLoading(): void {
    if (this.disposed) return
    this.swallowNextKey = false
    this.modelRows.clear()
    this.effortChoices.clear()
    this.choicesByModel.clear()
    this.interactionMode = { kind: 'models' }
    this.modelsList.setHint(MODEL_MODE_HINT)
    this.failures = []
    this.modelsList.setItems([])
    this.modelsList.setNoMatchText('  Loading models…')
    this.deps.requestRender()
  }

  /** Replace the loading state with an in-panel error (never close + print in
   *  the transcript). No retry; Esc still closes; Enter is inert. */
  setLoadError(message: string): void {
    if (this.disposed) return
    // A lifecycle/error reset also clears the one-shot latch: a later
    // re-hydration must not have its first key silently consumed.
    this.swallowNextKey = false
    this.modelRows.clear()
    this.effortChoices.clear()
    this.choicesByModel.clear()
    this.interactionMode = { kind: 'models' }
    this.modelsList.setHint(MODEL_MODE_HINT)
    this.failures = []
    this.modelsList.setItems([])
    // §12.2/role 16: only a REAL failure names a failure, and that word is
    // painted `error`. Pre-paint it here so the picker's `noMatch` (`textMuted`)
    // wrapper does not recolour it (the nested span wins, the outer paint
    // resumes); an ordinary empty-filter message keeps the placeholder ink.
    const failure = color.error('Model catalog unavailable')
    this.modelsList.setNoMatchText(message === '' ? `  ${failure}` : `  ${failure}: ${message}`)
    this.deps.requestRender()
  }

  private buildItems(): SearchablePickerItem[] {
    const items: SearchablePickerItem[] = []
    for (const row of this.modelRows.values()) {
      const identity = modelIdentity(row.providerId, row.modelId)
      // ONE parts array per row: the picker's wrap-trim drops WHOLE parts, so
      // an effort NAME containing ` · ` must never be mistaken for a boundary.
      const badgeParts = this.modelBadgePartsOf(row)
      const badge = badgeParts === undefined ? undefined : joinBadgeParts(badgeParts)
      // Layout measurement uses the WIDEST badge any effort value of this
      // model could render, so cycling the effort never toggles one/two lines.
      const badgeLayoutText = this.widestBadgeOf(row)
      items.push({
        value: identity,
        label: sanitizeDisplayText(row.modelName),
        // The header shows the display name; the GROUP IDENTITY is the
        // provider id, so distinct providers that share a display name (or a
        // provider literally named "Unavailable") never merge into one group.
        group: sanitizeDisplayText(row.providerName),
        groupKey: row.providerId,
        ...(badge === undefined ? {} : { badge }),
        ...(badgeParts === undefined ? {} : { badgeParts }),
        ...(badgeLayoutText === undefined ? {} : { badgeLayoutText }),
        // Search covers provider/model NAME + ID only: the (hidden) model
        // description and effort descriptions are deliberately NOT searchable.
        searchText: `${row.providerId} ${row.modelId} ${row.providerName} ${row.modelName}`,
      })
    }
    for (const failure of this.failures) {
      items.push({
        value: `${FAILURE_PREFIX}${failure.providerId}`,
        label: sanitizeDisplayText(failure.providerName),
        description: sanitizeDisplayText(failure.message),
        group: 'Unavailable',
        groupKey: FAILURE_GROUP_KEY,
        badge: 'unavailable',
        searchText: `${failure.providerId} ${failure.providerName}`,
      })
    }
    return items
  }

  /** The right-aligned badge PARTS: factual state (`current`/`default`) as
   *  `chip` parts plus the picker-local effort token — its provider-supplied
   *  NAME verbatim, ` · ` or not, as ONE `text` part — so the picker's
   *  wrap-trim never has to reverse-engineer boundaries from the joined text.
   *  The token is `[ Name ]` while THIS model owns the inline effort focus and
   *  `‹Name›` otherwise, so the active state is legible without relying on
   *  color. The caller joins the parts with `joinBadgeParts` — two adjacent state chips a single space apart, ` · ` otherwise — for the `badge` string. */
  private modelBadgePartsOf(row: ModelPickerModelRow): SearchablePickerBadgePart[] | undefined {
    const parts: SearchablePickerBadgePart[] = []
    const identity = modelIdentity(row.providerId, row.modelId)
    const choice = this.effortChoices.get(identity)
    // §4.5/§12.2: a row state is a `[current]` / `[default]` state chip in
    // `textMuted`, pre-painted so the badge slot's selected-dependent paint
    // (`primary` on the cursor row, `textDim` otherwise) never recolours it.
    if (row.isCurrent) parts.push({ kind: 'chip', text: color.textMuted('[current]') })
    if (row.isDefault) parts.push({ kind: 'chip', text: color.textMuted('[default]') })
    // The effort token keeps the LAST position — the wrapped badge drops from the LEFT,
    // so the tail is the fact the user is acting on — and it is painted its OWN role-4
    // ink: a nested span's reset ends the outer ink for everything after it (ANSI cannot
    // resume a style), so an unstyled tail would fall back to the terminal's default
    // colour on the selected row (measured in the real `/model` frame).
    if (choice !== undefined) {
      const label = effortLabelOf(this.choicesByModel.get(identity) ?? [], choice)
      if (label !== undefined) {
        // A provider-supplied effort name is external: project it BEFORE the
        // role-4 paint (the picker folds the part onto one row afterwards).
        parts.push({ kind: 'text', text: color.textDim(effortTokenOf(sanitizeDisplayText(label), this.isEffortFocused(identity))) })
      }
    }
    return parts.length === 0 ? undefined : parts
  }

  /** The widest badge this row could ever render (the facts plus the longest
   *  effort label in its WIDEST form), used only for the stable wrap
   *  measurement so neither cycling nor entering/leaving effort focus can
   *  change the physical row count. */
  private widestBadgeOf(row: ModelPickerModelRow): string | undefined {
    const parts: SearchablePickerBadgePart[] = []
    // Measurement uses the CHIP text (wider than the bare word) and the SAME
    // joiner as the painted badge, so the one/two-line wrap decision stays honest.
    if (row.isCurrent) parts.push({ kind: 'chip', text: '[current]' })
    if (row.isDefault) parts.push({ kind: 'chip', text: '[default]' })
    const choices = this.choicesByModel.get(modelIdentity(row.providerId, row.modelId)) ?? []
    if (choices.length > 0) {
      // Compare the PROJECTED width, the same text the inline row paints: an
      // effort name with line breaks measures 0 for its `\n` but paints a space, so
      // comparing raw labels could pick a candidate that is not the widest once
      // painted and leave the layout-only badge one cell short of a wrap.
      let widest = choices[0]!
      for (const choice of choices) {
        if (visibleWidth(sanitizedPhysicalLine(choice.label)) > visibleWidth(sanitizedPhysicalLine(widest.label))) widest = choice
      }
      // The painted row projects the label onto ONE physical line, so the
      // measurement must measure that same text: `visibleWidth('\n')` is 0, which
      // made the widest badge under-count by a cell or two for an effort name with
      // three or more breaks and let `shouldWrapBadge` decline to wrap a row that
      // overflows.
      parts.push({ kind: 'text', text: effortTokenOf(sanitizedPhysicalLine(widest.label), true) })
    }
    return parts.length === 0 ? undefined : joinBadgeParts(parts)
  }

  /** Whether `identity` is the model currently owning the inline effort focus. */
  private isEffortFocused(identity: string): boolean {
    return this.interactionMode.kind === 'effort' && this.interactionMode.modelKey === identity
  }

  /** Cycle one model's inline effort. Models without effort metadata are a
   *  no-op (the key is still consumed). */
  private adjustEffort(modelKey: string, step: 1 | -1): void {
    const row = this.modelRows.get(modelKey)
    if (row === undefined) return
    const choices = this.choicesByModel.get(modelKey) ?? []
    if (choices.length === 0) return
    const current = this.effortChoices.get(modelKey) ?? choices[0]!.value
    const index = Math.max(0, choices.findIndex(choice => choice.value === current))
    const next = choices[(index + step + choices.length) % choices.length]!.value
    this.effortChoices.set(modelKey, next)
    // setItems preserves the selected row by VALUE, so the cursor stays put.
    this.modelsList.setItems(this.buildItems())
    this.deps.requestRender()
  }

  /** Focus the inline effort of a row, or commit directly when the model has
   *  no effort choice at all. Failure/unknown rows are inert. */
  private activateModel(value: string): void {
    if (this.disposed || this.selecting) return
    const row = this.modelRows.get(value)
    if (row === undefined) return
    if ((this.choicesByModel.get(value) ?? []).length === 0) {
      this.submit(row, undefined)
      return
    }
    this.interactionMode = { kind: 'effort', modelKey: value }
    this.modelsList.setHint(EFFORT_MODE_HINT)
    // The effort token lives in the item's badge, so the focus change needs a
    // rebuild (setItems preserves the selected value and the query).
    this.modelsList.setItems(this.buildItems())
    this.deps.requestRender()
  }

  /** Leave the inline effort focus without closing or changing anything else
   *  (Esc from effort focus, or a settlement that did not commit). */
  private leaveEffortMode(): void {
    if (this.interactionMode.kind === 'models') return
    this.interactionMode = { kind: 'models' }
    this.modelsList.setHint(MODEL_MODE_HINT)
    this.modelsList.setItems(this.buildItems())
    this.deps.requestRender()
  }

  handleInput(data: string): void {
    if (this.disposed || this.selecting) return
    // A refresh removed the effort-bound model: consume the triggering key.
    if (this.swallowNextKey) {
      this.swallowNextKey = false
      return
    }
    if (this.interactionMode.kind === 'effort') {
      const modelKey = this.interactionMode.modelKey
      // The bound model can vanish after a directory re-hydration: fall back to
      // model mode instead of re-targeting whatever now sits at that position.
      // The triggering key is CONSUMED: it must not double as a Model-mode
      // Enter that immediately re-focuses (or commits) the replacement row.
      if (!this.modelRows.has(modelKey)) {
        this.leaveEffortMode()
        return
      }
      // Inline effort focus OWNS the keys: ←/→ cycle, Enter commits, Esc backs
      // out, and every other key (navigation, typing) is consumed so the mode
      // stays unambiguous.
      if (matchesKey(data, 'right')) {
        this.adjustEffort(modelKey, 1)
        return
      }
      if (matchesKey(data, 'left')) {
        this.adjustEffort(modelKey, -1)
        return
      }
      if (matchesKey(data, 'enter')) {
        this.confirm(modelKey)
        return
      }
      if (matchesKey(data, 'escape')) {
        this.leaveEffortMode()
        return
      }
      return
    }
    // Model mode: Enter either focuses the inline effort (reasoning model) or
    // commits directly (no-effort model); plain ←/→ and typing stay the Search
    // Input's, and ↑↓/PageUp/PageDown/Esc stay the list's.
    if (matchesKey(data, 'enter')) {
      const item = this.modelsList.getSelectedItem()
      if (item !== null) this.activateModel(item.value)
      return
    }
    this.modelsList.handleInput(data)
  }

  /** Commit a model with its CURRENT inline effort (or no effort for
   *  provider-default / no-effort models). Failure rows are inert. */
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
        // caller's notice explains the refusal. A refused COMMIT returns to
        // model mode: the user re-confirms before another focus transition.
        if (outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unsupported') {
          this.leaveEffortMode()
          this.deps.requestRender()
          return
        }
        this.deps.close()
      },
      onError: () => {
        if (this.disposed) return
        this.selecting = false
        this.leaveEffortMode()
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
