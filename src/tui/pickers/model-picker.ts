/**
 * `/model`: ONE capturing overlay owning ONE SearchablePicker (the
 * provider-grouped flat model list), an independent Reasoning Effort strip,
 * an Agent Team row and a composed footer hint — never a second view/page.
 *
 * Keyboard focus is a three-zone state machine over the SAME component:
 *
 * - MODEL zone (the default): `↑`/`↓` move the model, `←`/`→` are the Search
 *   Input's text cursor, typing edits the query, `Tab` moves to the Team row,
 *   and `Enter` FOCUSES the selected reasoning model's Effort strip (no write)
 *   or commits a model with no effort choice in one press.
 * - EFFORT zone: `←`/`→` cycle the selected model's official effort candidates,
 *   `Enter` commits the model with the visible effort, `Esc` backs out to the
 *   model list keeping the draft, and every other key is consumed.
 * - TEAM zone: `Enter`/`Space` toggle the exact Root Session's Agent Team mode,
 *   `Tab`/`Shift+Tab` return to the model list, `Esc` backs out without a
 *   write. An OFF write over a Session that already recorded a model request
 *   uses the independent {@link TeamDisableConfirmation} seat.
 *
 * The effort is a PER-MODEL, picker-local draft keyed by the full
 * `(provider, model)` identity and rendered OUTSIDE the model rows, so cycling
 * it never changes a row's physical height. Team is a SEPARATE Host write
 * (`TeamModePort`), never folded into a model `apply()`.
 *
 * The panel opens IMMEDIATELY in a `loading` state and hydrates in place via
 * {@link ModelPicker.setDirectory}; a failed directory read shows an in-panel
 * error state ({@link ModelPicker.setLoadError}) instead of closing the
 * overlay. The command layer owns the directory read, the Session/generation
 * fences, the model write semantics and the Team gesture admission; the
 * injected seams resolve with semantic settlements so a rejected/cancelled
 * write keeps the picker usable.
 *
 * @module @xmoon76/dsh-pi-tui/tui/pickers/model-picker
 */

import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type RowBudgetAware,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'
import type { ModelSelectionDto } from '../../runtime/catalog-port.ts'
import type { TeamModeSnapshot } from '../../runtime/team-mode-port.ts'
import { SearchablePicker, joinBadgeParts, type SearchablePickerBadgePart, type SearchablePickerItem } from './searchable-picker.ts'
import type { TeamDisableConfirmationRequest } from './team-disable-confirmation.ts'
import { color, selectListTheme } from '../theme/runtime.ts'

import type {
  ModelApplyOutcome,
  ModelPickerDirectory,
  ModelPickerSubject,
  ModelPickerTeamAttempt,
  ModelPickerTeamControl,
} from '../../app/command/model-presentation.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
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
  ModelPickerTeamAttempt,
  ModelPickerTeamControl,
} from '../../app/command/model-presentation.ts'

/** The picker's dependencies: the command layer's write/lifecycle seams. The
 *  directory arrives later through {@link ModelPicker.setDirectory}. */
export interface ModelPickerDeps {
  /** The write subject the command captured at open: whether the user was
   *  sessionless. Fixed for this picker's whole life (never re-derived here). */
  subject: ModelPickerSubject
  /** Commit a selection and resolve with its semantic settlement. */
  apply(selection: ModelSelectionDto): Promise<ModelApplyOutcome> | ModelApplyOutcome
  /** Request a frame so a hydration/effort/Team change renders. */
  requestRender(): void
  /** Close the whole overlay (settled model commit, or the model view's Esc). */
  close(): void
  /** The owned-task entry (runOwned shape, diag pre-wired by the runner): the
   *  async write routes through it instead of a bare `void promise`. */
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
  /** The optional PiTui Agent Team seam (absent on a renderer that presents
   *  only the model list: the Team row then reports a truthful unavailable). */
  team?: ModelPickerTeamControl
  /** Mount the independent Team-disable confirmation seat. Absent means an
   *  OFF write over a recorded model request is refused (never auto-written). */
  openTeamDisableConfirmation?(request: TeamDisableConfirmationRequest): () => void
}

const IDENTITY_SEP = '\u0000'
const FAILURE_PREFIX = `${IDENTITY_SEP}failure${IDENTITY_SEP}`
/** One shared group key for EVERY failed provider, so all failures collapse
 *  into a single private `Unavailable` section (a real provider's own
 *  `groupKey` is its id and can never collide with this NUL-prefixed key). */
const FAILURE_GROUP_KEY = `${IDENTITY_SEP}unavailable`
/** Model-zone footer hint. §4.1/§7.1 key tokens are Capitalized, verbs
 *  lowercase, and `Esc` is last (§7.2/D8). */
const MODEL_MODE_HINT = 'Tab Team · ↑↓ model · Enter effort/select · Esc close'
/** Effort-zone footer hint (the strip below the list owns the keys). */
const EFFORT_MODE_HINT = '←→ effort · Enter select · Esc back'
/** Team-zone footer hint. */
const TEAM_MODE_HINT = 'Tab model · Enter/Space toggle · Esc back'
/** The narrow-terminal hint every zone falls back to. */
const COMPACT_HINT = 'Tab Team · Enter select · Esc'
/** Rows the composed surface reserves below the model list: separator, Effort,
 *  Team and the footer hint. */
const FIXED_ROWS = 4
/** Width from which the full-width layout (label + all candidates) is used. */
const WIDE_LAYOUT_WIDTH = 64
/** Minimum width that can hold both confirmation labels side by side. */
const TEAM_LABEL = 'Agent Team'
const EFFORT_LABEL = 'Reasoning Effort'

/** The human-facing label for one effort value within a row's candidates. */
function effortLabelOf(choices: readonly InlineEffortChoice[], value: string): string | undefined {
  return choices.find(choice => choice.value === value)?.label
}

/** One painted hit segment (columns relative to the component content box). */
interface HitSegment {
  readonly start: number
  readonly end: number
}

interface TeamHit extends HitSegment {
  readonly enabled: boolean
}

interface EffortHit extends HitSegment {
  readonly value: string
}

/** One local Team write phase (the Host value is ALWAYS re-read). */
type TeamPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving'; readonly target: boolean }
  | { readonly kind: 'checking'; readonly target: boolean }
  | { readonly kind: 'failed'; readonly target: boolean; readonly message: string }
  | { readonly kind: 'unknown'; readonly target: boolean; readonly message: string }

/**
 * The `/model` picker: one SearchablePicker over a provider-grouped flat model
 * list, with a composed Effort strip, an Agent Team row and a footer hint.
 * Mounted by the host as ONE capturing overlay; it starts in `loading` and
 * hydrates in place.
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
  /** Whether a semantic model selection is in flight (blocks a duplicate apply). */
  private selecting = false
  /** Latched by every close/dispose path; late settlements must not act. */
  private disposed = false
  /**
   * Keyboard focus zone. `models` is the normal list; `effort` is the
   * two-phase edit of ONE model's effort, BOUND to its full identity so an
   * async refresh can never re-target it; `team` is the Agent Team row.
   */
  private interactionMode:
    | { kind: 'models' }
    | { kind: 'effort'; modelKey: string }
    | { kind: 'team' } = { kind: 'models' }
  /** One-shot latch: a refresh that removed the effort-bound model already
   *  released the focus, so the NEXT key is consumed instead of falling through
   *  onto the replacement row. */
  private swallowNextKey = false
  /** The last official Team snapshot (undefined until the first read). */
  private teamSnapshot: TeamModeSnapshot | undefined
  /** The local write phase; the displayed value still comes from a fresh read. */
  private teamPhase: TeamPhase = { kind: 'idle' }
  /** One gesture-level refusal/notice (e.g. "another operation is in progress"). */
  private teamNotice: string | undefined
  private readonly unsubscribeTeam: (() => void) | undefined
  /** Last painted geometry for the Team/Effort hit testing. The press latch is
   *  fenced on the painted WIDTH + token identity (the SearchablePicker
   *  contract), not a render counter: an ordinary focus repaint between press
   *  and release must NOT drop a valid click, while a resize/re-hydration that
   *  changes the hit geometry still rejects it. */
  private lastFrame: {
    readonly width: number
    readonly teamRow: number
    readonly effortRow: number
    readonly teamHits: readonly TeamHit[]
    readonly effortHits: readonly EffortHit[]
  } | undefined
  private pressed:
    | { readonly kind: 'team'; readonly enabled: boolean }
    | { readonly kind: 'effort'; readonly modelKey: string; readonly value: string }
    | undefined

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.modelsList.focused = value
  }

  constructor(deps: ModelPickerDeps) {
    this.deps = deps
    // The Host row grant is the only visible-row cap: a fixed 8 would silently
    // cap the 88×28 wide layout at the old narrow default.
    this.modelsList = new SearchablePicker([], Number.POSITIVE_INFINITY, selectListTheme, {}, {
      enableSearch: true,
      externalHint: true,
      header: 'Models',
      noMatchText: '  Loading models…',
      descriptionMode: 'selected-below',
      // Model identity must never be squeezed out by a long factual badge:
      // when label + badge cannot share the row, the badge wraps onto an
      // inert second line.
      badgeLayout: 'wrap-when-needed',
    })
    this.modelsList.onSelect = (item) => { this.activateModel(item.value) }
    this.modelsList.onCancel = () => { this.deps.close() }
    this.modelsList.onSelectionChange = () => { this.deps.requestRender() }
    this.applyRowBudget()
    if (deps.team !== undefined) {
      this.teamSnapshot = deps.team.read()
      this.unsubscribeTeam = deps.team.subscribe(() => { this.onTeamProjectionChanged() })
    }
  }

  /** Whether this picker has been torn down (the command layer's stale-load
   *  fence: a late directory settle must not hydrate a disposed surface). */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Host row-budget seam: keep the composed strips inside the grant and give
   *  the remainder to the model list. */
  setMaxRows(rows: number): void {
    this.rowGrant = rows
    this.applyRowBudget()
  }

  private applyRowBudget(): void {
    const listRows = Number.isFinite(this.rowGrant) ? Math.max(1, this.rowGrant - FIXED_ROWS) : this.rowGrant
    this.modelsList.setMaxRows(listRows)
  }

  /** Hydrate the panel IN PLACE once the directory read settles: project the
   *  rows, seed each model's effort draft, and preserve the query the user
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
    // An effort focus is bound to a full identity: drop back to the model zone
    // when that exact model did not survive the (re-)hydration OR when it lost
    // all reasoning metadata. A VANISHED model also consumes the next key: a
    // refresh that yanks the model out from under the user must not let the
    // very next Enter/Esc fall through onto the replacement row.
    if (this.interactionMode.kind === 'effort') {
      const modelKey = this.interactionMode.modelKey
      const survives = this.modelRows.has(modelKey)
      const hasChoices = survives && (this.choicesByModel.get(modelKey)?.length ?? 0) > 0
      if (!survives || !hasChoices) {
        this.interactionMode = { kind: 'models' }
        if (!survives) this.swallowNextKey = true
      }
    }
    const items = this.buildItems()
    // A settled-but-empty catalog is not a "no match" (nothing was filtered).
    this.modelsList.setNoMatchText(items.length === 0 ? '  No models available' : '  No matching models')
    this.modelsList.setItems(items)
    // Identity-based selection: a SURVIVING effort focus keeps its own row
    // selected (the focus and the cursor must never point at different rows);
    // otherwise highlight the configured (provider, model).
    if (this.interactionMode.kind === 'effort') {
      this.modelsList.setSelectedValue(this.interactionMode.modelKey)
    } else if (input.current !== undefined) {
      this.modelsList.setSelectedValue(modelIdentity(input.current.provider, input.current.model))
    }
    this.applyRowBudget()
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
    this.failures = []
    this.modelsList.setItems([])
    // §12.2/role 16: only a REAL failure names a failure, and that word is
    // painted `error`. Pre-paint it here so the picker's `noMatch` (`textMuted`)
    // wrapper does not recolour it (the nested span wins, the outer paint
    // resumes); an ordinary empty-filter message keeps the placeholder ink.
    const failure = color.error('Model catalog unavailable')
    // The load error is a runtime/provider message: project it onto ONE safe
    // physical row before it enters the picker's single-row no-match line.
    const detail = sanitizedPhysicalLine(message)
    this.modelsList.setNoMatchText(detail === '' ? `  ${failure}` : `  ${failure}: ${detail}`)
    this.deps.requestRender()
  }

  private buildItems(): SearchablePickerItem[] {
    const items: SearchablePickerItem[] = []
    for (const row of this.modelRows.values()) {
      const identity = modelIdentity(row.providerId, row.modelId)
      const badgeParts = this.modelBadgePartsOf(row)
      const badge = badgeParts === undefined ? undefined : joinBadgeParts(badgeParts)
      items.push({
        value: identity,
        label: sanitizedPhysicalLine(row.modelName),
        // The header shows the display name; the GROUP IDENTITY is the
        // provider id, so distinct providers that share a display name (or a
        // provider literally named "Unavailable") never merge into one group.
        group: sanitizedPhysicalLine(row.providerName),
        groupKey: row.providerId,
        ...(badge === undefined ? {} : { badge }),
        ...(badgeParts === undefined ? {} : { badgeParts }),
        // Search covers provider/model NAME + ID only: the (hidden) model
        // description and effort descriptions are deliberately NOT searchable.
        searchText: `${row.providerId} ${row.modelId} ${row.providerName} ${row.modelName}`,
      })
    }
    for (const failure of this.failures) {
      items.push({
        value: `${FAILURE_PREFIX}${failure.providerId}`,
        label: sanitizedPhysicalLine(failure.providerName),
        description: sanitizedPhysicalLine(failure.message),
        group: 'Unavailable',
        groupKey: FAILURE_GROUP_KEY,
        badge: 'unavailable',
        searchText: `${failure.providerId} ${failure.providerName}`,
      })
    }
    return items
  }

  /** The factual state chips (`current`/`default`) only: effort lives in the
   *  strip below the list, never on the model row. */
  private modelBadgePartsOf(row: ModelPickerModelRow): SearchablePickerBadgePart[] | undefined {
    const parts: SearchablePickerBadgePart[] = []
    if (row.isCurrent) parts.push({ kind: 'chip', text: color.textMuted('[current]') })
    if (row.isDefault) parts.push({ kind: 'chip', text: color.textMuted('[default]') })
    return parts.length === 0 ? undefined : parts
  }

  /** Cycle the effort of the one bound model (no-op without metadata, the key
   *  is still consumed by the caller). */
  private adjustEffort(modelKey: string, step: 1 | -1): void {
    const choices = this.choicesByModel.get(modelKey) ?? []
    if (choices.length === 0) return
    const current = this.effortChoices.get(modelKey) ?? choices[0]!.value
    const index = Math.max(0, choices.findIndex(choice => choice.value === current))
    this.effortChoices.set(modelKey, choices[(index + step + choices.length) % choices.length]!.value)
    this.deps.requestRender()
  }

  /** Select ONE effort candidate with the pointer: updates the draft only —
   *  selecting an Effort never submits the model. */
  private selectEffortDraft(modelKey: string, value: string): void {
    const choices = this.choicesByModel.get(modelKey) ?? []
    if (!choices.some(choice => choice.value === value)) return
    this.effortChoices.set(modelKey, value)
    this.interactionMode = { kind: 'effort', modelKey }
    this.modelsList.setSelectedValue(modelKey)
    this.deps.requestRender()
  }

  /** Enter the effort strip of a model, or commit a no-effort model directly. */
  private activateModel(value: string): void {
    if (this.disposed || this.selecting) return
    const row = this.modelRows.get(value)
    if (row === undefined) return
    if ((this.choicesByModel.get(value) ?? []).length === 0) {
      this.submit(row, undefined)
      return
    }
    this.interactionMode = { kind: 'effort', modelKey: value }
    this.modelsList.setSelectedValue(value)
    this.deps.requestRender()
  }

  /** Leave the effort zone without closing or changing anything else. */
  private leaveEffortMode(): void {
    if (this.interactionMode.kind !== 'effort') return
    this.interactionMode = { kind: 'models' }
    this.deps.requestRender()
  }

  handleInput(data: string): void {
    if (this.disposed || this.selecting) return
    // A refresh removed the effort-bound model: consume the triggering key.
    if (this.swallowNextKey) {
      this.swallowNextKey = false
      return
    }
    if (this.interactionMode.kind === 'team') {
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        this.interactionMode = { kind: 'models' }
        this.deps.requestRender()
        return
      }
      if (matchesKey(data, 'escape')) {
        this.interactionMode = { kind: 'models' }
        this.deps.requestRender()
        return
      }
      if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
        this.beginTeam()
        return
      }
      // The unknown outcome's explicit read-only recheck (never a retry).
      if (data === 'r' || data === 'R') {
        if (this.teamPhase.kind === 'unknown') this.recheckTeam()
        return
      }
      // Every other key is consumed so the model list can never be edited or
      // selected from the Team zone.
      return
    }
    if (this.interactionMode.kind === 'effort') {
      const modelKey = this.interactionMode.modelKey
      // The bound model can vanish after a directory re-hydration: fall back to
      // the model zone instead of re-targeting whatever now sits at that
      // position. The triggering key is consumed.
      if (!this.modelRows.has(modelKey)) {
        this.leaveEffortMode()
        return
      }
      if (matchesKey(data, 'right')) {
        this.adjustEffort(modelKey, 1)
        return
      }
      if (matchesKey(data, 'left')) {
        this.adjustEffort(modelKey, -1)
        return
      }
      if (matchesKey(data, 'enter')) {
        this.confirmModel(modelKey)
        return
      }
      if (matchesKey(data, 'escape')) {
        this.leaveEffortMode()
        return
      }
      // `Tab` and ordinary typing are consumed: the effort zone owns the keys.
      return
    }
    // Model zone: `Tab` moves to the Team row (when the surface serves Team),
    // `Enter` focuses the effort strip or commits a no-effort model, and
    // everything else stays the Search Input's / the list's.
    if (this.deps.team !== undefined && matchesKey(data, 'tab')) {
      this.interactionMode = { kind: 'team' }
      this.deps.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      const item = this.modelsList.getSelectedItem()
      if (item !== null) this.activateModel(item.value)
      return
    }
    this.modelsList.handleInput(data)
  }

  /** Commit a model with its CURRENT effort draft (or no effort for a
   *  provider-default / no-effort model). Failure rows are inert. */
  private confirmModel(value: string): void {
    if (this.disposed || this.selecting) return
    const row = this.modelRows.get(value)
    if (row === undefined) return
    const choice = this.effortChoices.get(value)
    this.submit(row, choice === undefined || choice === PROVIDER_DEFAULT ? undefined : choice)
  }

  /** Submit one model selection: the semantic write owns the settlement, so
   *  the overlay shows a selecting state and only dismisses once the outcome is
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
        if (outcome === 'superseded') return
        this.selecting = false
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

  /** Admit and run one Agent Team toggle gesture from the Team zone. */
  private beginTeam(requested?: boolean): void {
    if (this.disposed || this.selecting || this.deps.team === undefined) return
    if (this.teamPhase.kind === 'saving' || this.teamPhase.kind === 'checking') return
    // An unknown outcome admits no blind write: the user's only Team-zone
    // gesture is the explicit read-only recheck.
    if (this.teamPhase.kind === 'unknown') {
      this.recheckTeam()
      return
    }
    // A failed phase may be retried, but a read that already proves the target
    // must win: never write the opposite state because the row was stale.
    if (this.teamPhase.kind === 'failed') {
      const fresh = this.deps.team.read()
      this.teamSnapshot = fresh
      if (fresh.kind === 'ready' && fresh.enabled === this.teamPhase.target) {
        this.teamPhase = { kind: 'idle' }
        this.deps.requestRender()
        return
      }
    }
    const admission = this.deps.team.begin()
    if (admission.kind === 'refused') {
      this.teamNotice = admission.reason
      this.deps.requestRender()
      return
    }
    const attempt = admission.attempt
    // A pointer gesture named a target: the admitted gesture must still name
    // the same state, or the read moved under the press and nothing may run.
    if (requested !== undefined && attempt.enabled !== requested) {
      attempt.abandon?.()
      this.teamSnapshot = this.deps.team.read()
      this.deps.requestRender()
      return
    }
    this.teamNotice = undefined
    if (attempt.confirmRequired) {
      this.openDisableConfirmation(attempt)
      return
    }
    this.runTeamAttempt(attempt)
  }

  /** Mount the independent OFF confirmation seat for one admitted attempt.
   *  The seat's write/read seams stay command-owned, so its lifetime does not
   *  depend on this overlay remaining mounted. */
  private openDisableConfirmation(attempt: ModelPickerTeamAttempt): void {
    if (this.deps.openTeamDisableConfirmation === undefined) {
      attempt.abandon?.()
      this.teamNotice = 'the Agent Team disable confirmation is not available here'
      this.deps.requestRender()
      return
    }
    this.deps.openTeamDisableConfirmation({
      run: () => attempt.run(),
      read: () => this.deps.team!.read(),
      subscribe: (listener) => this.deps.team!.subscribe(listener),
      onClosed: () => {
        // A seat closed without running (Cancel/Esc/owner teardown) releases
        // the admitted gesture; after a real run this is a no-op.
        attempt.abandon?.()
        // The seat may outlive THIS picker: never touch picker state after
        // disposal, but always ask for a repaint (the command's app owns it).
        if (!this.disposed) this.deps.requestRender()
      },
    })
  }

  /** Run one admitted non-confirmed Team write and keep the row truthful. */
  private runTeamAttempt(attempt: ModelPickerTeamAttempt): void {
    this.teamPhase = { kind: 'saving', target: attempt.enabled }
    this.deps.requestRender()
    this.deps.runOwned('team mode', () => attempt.run(), {
      isCancellation: () => this.disposed,
      onResult: (outcome) => {
        if (this.disposed) return
        if (outcome.kind === 'committed') {
          this.teamPhase = { kind: 'checking', target: attempt.enabled }
          this.teamSnapshot = this.deps.team?.read()
          if (this.teamSnapshot?.kind === 'ready' && this.teamSnapshot.enabled === attempt.enabled) {
            this.teamPhase = { kind: 'idle' }
          }
        } else if (outcome.kind === 'rejected') {
          this.teamPhase = { kind: 'failed', target: attempt.enabled, message: outcome.reason }
        } else if (outcome.kind === 'indeterminate') {
          this.teamPhase = { kind: 'unknown', target: attempt.enabled, message: outcome.reason }
        } else {
          this.teamPhase = { kind: 'idle' }
          this.teamNotice = outcome.reason
        }
        // A non-confirmed gesture owns the shared latch only for its one write:
        // release it once the settlement is known.
        attempt.abandon?.()
        this.deps.requestRender()
      },
      onError: (error) => {
        if (this.disposed) return
        this.teamPhase = {
          kind: 'unknown',
          target: attempt.enabled,
          message: error instanceof Error ? error.message : String(error),
        }
        attempt.abandon?.()
        this.deps.requestRender()
      },
    })
  }

  /** A fresh projection changed: repaint, and reconcile a settled-but-unproven
   *  local phase when the official value now proves the target. */
  private onTeamProjectionChanged(): void {
    if (this.disposed || this.deps.team === undefined) return
    this.teamSnapshot = this.deps.team.read()
    if (this.teamPhase.kind !== 'saving' && this.teamPhase.kind !== 'idle'
      && this.teamSnapshot.kind === 'ready'
      && this.teamSnapshot.enabled === this.teamPhase.target) {
      this.teamPhase = { kind: 'idle' }
    }
    this.deps.requestRender()
  }

  /** Explicit read-only recheck after an unknown Team write outcome. */
  private recheckTeam(): void {
    if (this.disposed || this.deps.team === undefined) return
    const phase = this.teamPhase
    const target = phase.kind === 'unknown' || phase.kind === 'failed' || phase.kind === 'checking'
      ? phase.target
      : undefined
    const snapshot = this.deps.team.read()
    this.teamSnapshot = snapshot
    if (target === undefined) {
      this.teamPhase = { kind: 'idle' }
    } else if (snapshot.kind === 'ready' && snapshot.enabled === target) {
      this.teamPhase = { kind: 'idle' }
    } else if (phase.kind === 'failed') {
      // `failed` only ever means a PROVEN pre-dispatch refusal; its Retry is
      // safe. A fresh read that still differs keeps the explicit failure.
      this.teamPhase = {
        kind: 'failed',
        target,
        message: `the Host reports Agent Team ${snapshot.kind === 'ready' ? (snapshot.enabled ? 'On' : 'Off') : 'unknown'}; retry is still available`,
      }
    } else {
      // An indeterminate write stays unknown: an old readback cannot prove the
      // dispatched write did not (or will not) land, so no Retry is offered.
      this.teamPhase = {
        kind: 'unknown',
        target,
        message: snapshot.kind === 'ready'
          ? `the Host still reports Agent Team ${snapshot.enabled ? 'On' : 'Off'}; the earlier write may still land — recheck again`
          : `the Host Team state is not readable: ${snapshot.reason}`,
      }
    }
    this.deps.requestRender()
  }

  /** Ownership-safe external disposal: the overlay's owning frame calls this
   *  when the picker is removed or replaced (app teardown, overlay replacement,
   *  a newer `/model` surface — NOT the picker's own Esc/selection). Teardown
   *  is ownership, not a user choice: it never calls close/apply/navigation,
   *  and the disposed latch fences a late settlement from repainting a dead
   *  surface. An independently mounted Team confirmation seat is NOT closed
   *  here: its own root seat owns its lifetime. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeTeam?.()
  }

  /** Mouse routing: the Effort/Team strips own their last-painted token hit
   *  segments; every other row is the list's own (already identity-fenced)
   *  pointer router. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.selecting) return undefined
    const pressed = this.pressed
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) this.pressed = undefined
    const frame = this.lastFrame
    if (frame === undefined || event.width !== frame.width) return undefined
    if (event.y === frame.teamRow) {
      if (event.type === 'wheel') return { handled: true }
      const hit = frame.teamHits.find(candidate => event.x >= candidate.start && event.x < candidate.end)
      if (hit === undefined) return { handled: true }
      if (event.type === 'press') {
        if (event.button !== 'left') return { handled: true }
        this.pressed = { kind: 'team', enabled: hit.enabled }
        this.interactionMode = { kind: 'team' }
        this.deps.requestRender()
        return { handled: true, focus: true }
      }
      if (event.type !== 'click' || event.button !== 'left') return { handled: true }
      if (pressed === undefined || pressed.kind !== 'team' || pressed.enabled !== hit.enabled) {
        return { handled: true }
      }
      this.interactionMode = { kind: 'team' }
      this.beginTeam(hit.enabled)
      return { handled: true }
    }
    if (frame.effortRow >= 0 && event.y === frame.effortRow) {
      if (event.type === 'wheel') return { handled: true }
      const hit = frame.effortHits.find(candidate => event.x >= candidate.start && event.x < candidate.end)
      if (hit === undefined) return { handled: true }
      const selected = this.modelsList.getSelectedItem()
      if (event.type === 'press') {
        if (event.button !== 'left') return { handled: true }
        // Bind the gesture to the full model identity that owned the painted
        // row; a selection move between press and release must not retarget it.
        if (selected === null) return { handled: true }
        this.pressed = { kind: 'effort', modelKey: selected.value, value: hit.value }
        return { handled: true, focus: true }
      }
      if (event.type !== 'click' || event.button !== 'left') return { handled: true }
      if (pressed === undefined || pressed.kind !== 'effort'
        || pressed.value !== hit.value || pressed.modelKey !== (selected?.value ?? '')) {
        return { handled: true }
      }
      if (selected !== null) this.selectEffortDraft(selected.value, hit.value)
      return { handled: true }
    }
    return this.modelsList.handleMouse?.(event)
  }

  invalidate(): void {
    this.modelsList.invalidate()
  }

  render(width: number): string[] {
    // A model apply keeps the strips visible: the Team row must still show the
    // current Host state while the model write is in flight.
    const inner = this.selecting ? ['  Selecting…'] : this.modelsList.render(width)
    const team = this.renderTeamLine(width)
    const hint = this.renderHintLine(width)
    const budget = Number.isFinite(this.rowGrant) ? Math.max(1, Math.floor(this.rowGrant)) : Number.POSITIVE_INFINITY
    // Degenerate grants: keep the actionable Team row and the footer, never a
    // half-cut strip. The specified 44×8 layout still grants six content rows,
    // so this path only protects a terminal smaller than the design matrix.
    if (budget < FIXED_ROWS + 2) {
      const lines = [team.line, hint].slice(0, budget)
      this.lastFrame = {
        width,
        teamRow: 0,
        effortRow: -1,
        teamHits: team.hits,
        effortHits: [],
      }
      return lines
    }
    const effort = this.renderEffortLine(width)
    const lines = [
      ...inner,
      this.renderSeparator(width),
      effort.line,
      team.line,
      hint,
    ]
    const effortRow = inner.length + 1
    const teamRow = inner.length + 2
    this.lastFrame = {
      width,
      teamRow,
      effortRow,
      teamHits: team.hits,
      effortHits: effort.hits,
    }
    return lines
  }

  private renderSeparator(width: number): string {
    return color.border('─'.repeat(Math.max(1, Math.floor(width))))
  }

  /** The Reasoning Effort strip for the LIST-SELECTED model. */
  private renderEffortLine(width: number): { line: string; hits: readonly EffortHit[] } {
    const item = this.modelsList.getSelectedItem()
    const row = item === null ? undefined : this.modelRows.get(item.value)
    if (row === undefined) {
      return { line: this.paintStrip(width, `${EFFORT_LABEL}   ${color.textDim('—')}`), hits: [] }
    }
    const identity = modelIdentity(row.providerId, row.modelId)
    const choices = this.choicesByModel.get(identity) ?? []
    if (choices.length === 0) {
      return {
        line: this.paintStrip(width, `${EFFORT_LABEL}   ${color.textDim('No reasoning effort for this model')}`),
        hits: [],
      }
    }
    const draft = this.effortChoices.get(identity) ?? choices[0]!.value
    const focused = this.interactionMode.kind === 'effort' && this.interactionMode.modelKey === identity
    if (width < WIDE_LAYOUT_WIDTH) {
      const label = effortLabelOf(choices, draft) ?? draft
      const suffix = focused ? ' · ←→' : ''
      const line = `Effort: ${label}${suffix}`
      const start = 2 + visibleWidth('Effort: ')
      const end = start + visibleWidth(sanitizedPhysicalLine(label))
      return {
        line: this.paintStrip(width, sanitizedPhysicalLine(line)),
        hits: end <= width ? [{ start, end, value: draft }] : [],
      }
    }
    // Wide layout: label + every candidate, the current draft bracketed.
    interface Candidate { readonly value: string; readonly text: string; readonly draft: boolean }
    const candidates: Candidate[] = choices.map((choice) => {
      const label = sanitizedPhysicalLine(choice.label)
      return {
        value: choice.value,
        text: choice.value === draft ? `[${label}]` : label,
        draft: choice.value === draft,
      }
    })
    const prefix = `  ${EFFORT_LABEL}   `
    const paint = (candidate: Candidate): string => {
      if (!candidate.draft) return color.textDim(candidate.text)
      return focused ? color.primary(candidate.text) : color.textStrong(candidate.text)
    }
    const build = (list: readonly Candidate[]): string =>
      prefix + list.map(paint).join('  ')
    let visible = candidates
    // Keep the draft and trim neighbours from the tail, then the head.
    while (visible.length > 1 && width > 0 && visibleWidth(build(visible)) > width) {
      const dropIndex = visible[visible.length - 1]!.draft ? 0 : visible.length - 1
      const next = [...visible]
      next.splice(dropIndex, 1)
      if (next.some(candidate => candidate.draft)) visible = next
      else break
    }
    if (visibleWidth(build(visible)) > width) {
      const label = effortLabelOf(choices, draft) ?? draft
      return {
        line: this.paintStrip(width, sanitizedPhysicalLine(`Effort: ${label} · ←→`)),
        hits: [],
      }
    }
    const hits: EffortHit[] = []
    let column = visibleWidth(prefix)
    for (let index = 0; index < visible.length; index += 1) {
      const candidate = visible[index]!
      const textWidth = visibleWidth(candidate.text)
      if (index > 0) column += 2
      if (column + textWidth <= width) {
        hits.push({ start: column, end: column + textWidth, value: candidate.value })
      }
      column += textWidth
    }
    return { line: build(visible), hits }
  }

  /** The Agent Team row: the only place the saved mode is presented. */
  private renderTeamLine(width: number): { line: string; hits: readonly TeamHit[] } {
    return this.teamRowText(width, this.interactionMode.kind === 'team')
  }

  private teamRowText(width: number, focused: boolean): { line: string; hits: readonly TeamHit[] } {
    const prefix = focused ? color.primary('> ') : '  '
    const label = focused ? color.primary(TEAM_LABEL) : color.textMuted(TEAM_LABEL)
    const base = `${prefix}${label}   `
    const paint = (text: string): string => truncateToWidth(text, width, '')
    if (this.deps.team === undefined) {
      return { line: paint(`${base}${color.textDim('Unavailable: Agent Team is unavailable here')}`), hits: [] }
    }
    const phase = this.teamPhase
    if (phase.kind === 'saving') {
      return { line: paint(`${base}${color.textDim('Saving…')}`), hits: [] }
    }
    if (phase.kind === 'checking') {
      return { line: paint(`${base}${color.textDim('Checking saved state…')}`), hits: [] }
    }
    if (phase.kind === 'failed') {
      return { line: paint(`${base}${color.error(`Save failed: ${sanitizedPhysicalLine(phase.message)}`)}`), hits: [] }
    }
    if (phase.kind === 'unknown') {
      return { line: paint(`${base}${color.warning('Outcome unknown — R recheck')}`), hits: [] }
    }
    const snapshot = this.teamSnapshot
    if (snapshot === undefined) {
      return { line: paint(`${base}${color.textDim('Checking…')}`), hits: [] }
    }
    if (snapshot.kind !== 'ready') {
      const reason = this.teamNotice ?? snapshot.reason
      return { line: paint(`${base}${color.textDim(`Unavailable: ${sanitizedPhysicalLine(reason)}`)}`), hits: [] }
    }
    // The bracket marks the SAVED state regardless of focus; the focus is the
    // `> ` prefix and the `primary` paint, so color is never the only signal.
    const onText = snapshot.enabled ? '[On]' : 'On'
    const offText = snapshot.enabled ? 'Off' : '[Off]'
    const onPaint = snapshot.enabled
      ? (focused ? color.primary(onText) : color.textStrong(onText))
      : color.textDim(onText)
    const offPaint = snapshot.enabled
      ? color.textDim(offText)
      : (focused ? color.primary(offText) : color.textStrong(offText))
    const tokens = `${onPaint}  ${offPaint}`
    const suffix = '(current Root Session)'
    const notice = this.teamNotice === undefined ? '' : `  ${sanitizedPhysicalLine(this.teamNotice)}`
    const body = `${base}${tokens}${notice === '' ? '' : color.textDim(notice)}`
    const suffixWidth = visibleWidth(suffix) + 2
    let line = body
    if (notice === '' && width >= 70 && visibleWidth(body) + suffixWidth <= width) {
      line = `${body}${' '.repeat(width - visibleWidth(body) - suffixWidth)}  ${color.textDim(suffix)}`
    }
    const onStart = visibleWidth(base)
    const onEnd = onStart + visibleWidth(onText)
    const offStart = onEnd + 2
    const offEnd = offStart + visibleWidth(offText)
    const hits: TeamHit[] = []
    if (onEnd <= width) hits.push({ start: onStart, end: onEnd, enabled: true })
    if (offEnd <= width) hits.push({ start: offStart, end: offEnd, enabled: false })
    return { line: truncateToWidth(line, width, ''), hits }
  }

  private renderHintLine(width: number): string {
    // A surface without the Team seam paints no Team row it can act on, so its
    // hint must not advertise a dead `Tab Team`.
    const servesTeam = this.deps.team !== undefined
    const hint = width < WIDE_LAYOUT_WIDTH
      ? (servesTeam ? COMPACT_HINT : '↑↓ model · Enter select · Esc')
      : this.interactionMode.kind === 'team'
        ? this.teamPhase.kind === 'unknown'
          ? 'R recheck · Tab model · Esc back'
          : this.teamPhase.kind === 'failed'
            ? 'Enter retry · Tab model · Esc back'
            : TEAM_MODE_HINT
        : this.interactionMode.kind === 'effort'
          ? EFFORT_MODE_HINT
          : servesTeam
            ? MODEL_MODE_HINT
            : '↑↓ model · Enter effort/select · Esc close'
    return truncateToWidth(`  ${color.textDim(hint)}`, width, '')
  }

  /** Paint a composed strip with the shared 2-cell prefix. */
  private paintStrip(width: number, text: string): string {
    return truncateToWidth(`  ${text}`, width, '')
  }
}
