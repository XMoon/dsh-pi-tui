/** Per-open draft and independent CAS settlement for the two official
 * subagent Settings sections. Host persistence remains with ConfigPort. */
import type {
  FieldPatch,
  SectionMutationOutcome,
  SectionPatch,
  SectionRead,
  SubagentAllowedModelRoute,
  SubagentLimits,
  SubagentLimitsConfig,
  SubagentModelSelection,
  SubagentModelSelectionConfig,
} from '../../runtime/config-port.ts'
import { isDeepStrictEqual } from 'node:util'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

export type SubagentSettingsField = 'maxDepth' | 'maxActiveSubagents' | 'enabled' | 'allowedModels'
export type SubagentSectionStatus = {
  readonly kind: 'saving' | 'verified' | 'not-saved' | 'unverified' | 'outcome-unconfirmed'
  readonly text: string
}
type Ready<T extends object> = Extract<SectionRead<T>, { kind: 'ready' }>

export interface SubagentSectionSnapshot<T extends object> {
  readonly source: SectionRead<T>
  readonly current: boolean
  /** Live authority identity for revoking a gesture when the captured read is stale. */
  readonly currentGeneration?: object
  readonly dirty: boolean
  readonly patch: SectionPatch<T>
  readonly status?: SubagentSectionStatus
}
export interface SubagentSettingsSnapshot {
  readonly loading: boolean
  readonly saving: boolean
  readonly revision: number
  readonly dirty: boolean
  readonly saved: boolean
  readonly limits: SubagentSectionSnapshot<SubagentLimits>
  readonly selection: SubagentSectionSnapshot<SubagentModelSelection>
  /** The CURRENT numeric candidate derived from the captured effective value and
   *  this field's patch; never a second long-lived draft store. */
  readonly depthText: string
  readonly capacityText: string
  readonly enabled?: boolean
  readonly allowedModels: readonly SubagentAllowedModelRoute[]
  readonly issues: Readonly<Partial<Record<SubagentSettingsField, string>>>
  readonly notice?: string
}
export interface SubagentSettingsControllerDeps {
  readonly limits: SubagentLimitsConfig
  readonly selection: SubagentModelSelectionConfig
  readonly requestRender: () => void
  readonly onAuthoritativeChange?: () => void
  readonly runOwned: (label: string, task: () => Promise<void>) => void
}

interface SectionState<T extends object> {
  source: SectionRead<T>
  patch: SectionPatch<T>
  refreshRequired?: boolean
  status?: SubagentSectionStatus
}

function sameRoutes(left: readonly SubagentAllowedModelRoute[], right: readonly SubagentAllowedModelRoute[]): boolean {
  return left.length === right.length && left.every((route, index) =>
    route.provider === right[index]!.provider && route.model === right[index]!.model)
}
function patched<T>(field: FieldPatch<T> | undefined, effective: T, inherited: T): T {
  return field === undefined ? effective : field.kind === 'reset' ? inherited : field.value
}
function readyCurrent<T extends object>(source: SectionRead<T>, live: SectionRead<T>): boolean {
  return source.kind === 'ready' && live.kind === 'ready'
    && source.generation === live.generation && source.revision === live.revision
}
function hasPatch<T extends object>(patch: SectionPatch<T>): boolean {
  return Object.keys(patch).length !== 0
}
function ambiguous(status: SubagentSectionStatus | undefined): boolean {
  return status?.kind === 'unverified' || status?.kind === 'outcome-unconfirmed'
}

export class SubagentSettingsController {
  private readonly deps: SubagentSettingsControllerDeps
  private limits: SectionState<SubagentLimits> = { source: { kind: 'unavailable', reason: 'Loading Host settings…' }, patch: {} }
  private selection: SectionState<SubagentModelSelection> = { source: { kind: 'unavailable', reason: 'Loading Host settings…' }, patch: {} }
  private issues: Partial<Record<SubagentSettingsField, string>> = {}
  private loading = false
  private saving = false
  private saved = false
  private started = false
  private disposed = false
  private revision = 0
  private operation = 0
  private notice: string | undefined

  constructor(deps: SubagentSettingsControllerDeps) { this.deps = deps }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.refresh()
  }

  snapshot(): SubagentSettingsSnapshot {
    const limitsLive = this.deps.limits.read()
    const selectionLive = this.deps.selection.read()
    const selection = this.selection.source
    return {
      loading: this.loading, saving: this.saving, revision: this.revision,
      dirty: this.dirty(), saved: this.saved,
      limits: this.sectionSnapshot(this.limits, limitsLive),
      selection: this.sectionSnapshot(this.selection, selectionLive),
      depthText: this.candidateText('maxDepth'),
      capacityText: this.candidateText('maxActiveSubagents'),
      ...(selection.kind === 'ready' ? { enabled: patched(this.selection.patch.enabled, selection.effective.enabled, selection.inherited.enabled) } : {}),
      allowedModels: selection.kind === 'ready'
        ? patched(this.selection.patch.allowedModels, selection.effective.allowedModels, selection.inherited.allowedModels)
        : [],
      issues: { ...this.issues },
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  private sectionSnapshot<T extends object>(state: SectionState<T>, live: SectionRead<T>): SubagentSectionSnapshot<T> {
    return { source: state.source, current: state.refreshRequired !== true && readyCurrent(state.source, live),
      ...(live.kind === 'ready' ? { currentGeneration: live.generation } : {}),
      dirty: hasPatch(state.patch), patch: { ...state.patch },
      ...(state.status === undefined ? {} : { status: state.status }) }
  }

  private dirty(): boolean { return hasPatch(this.limits.patch) || hasPatch(this.selection.patch) }
  private changed(): void { this.revision += 1; this.deps.requestRender() }

  private mayEdit(field: SubagentSettingsField): boolean {
    if (this.disposed || this.loading || this.saving) return false
    const limits = field === 'maxDepth' || field === 'maxActiveSubagents'
    const state = limits ? this.limits : this.selection
    const live = limits ? this.deps.limits.read() : this.deps.selection.read()
    if (state.refreshRequired === true || state.source.kind !== 'ready' || live.kind !== 'ready'
      || state.source.generation !== live.generation || state.source.revision !== live.revision) {
      this.notice = 'Host settings changed or are unavailable; refresh before editing.'
      this.changed()
      return false
    }
    this.saved = false
    this.notice = undefined
    return true
  }

  /**
   * The owning field's REAL acceptance rule: `undefined` = accepted, otherwise
   * the reason the text is refused. The page pre-validates with THIS method and
   * `setNumber` independently refuses, so no invalid value can enter a patch.
   */
  numberIssue(field: 'maxDepth' | 'maxActiveSubagents', text: string): string | undefined {
    if (text.trim() === '') return 'Value is required.'
    const minimum = field === 'maxDepth' ? 0 : 1
    const valid = /^\d+$/u.test(text.trim()) && Number.isSafeInteger(Number(text)) && Number(text) >= minimum
    return valid ? undefined : `Enter a safe integer from ${minimum} to ${Number.MAX_SAFE_INTEGER}.`
  }

  /** Stage ONE field's plain numeric text. It NEVER stages an official Reset:
   *  a blank/whitespace/invalid draft is refused with zero patch, while
   *  `reset(field)` is the ONE explicit unset intent. */
  setNumber(field: 'maxDepth' | 'maxActiveSubagents', text: string): void {
    if (this.numberIssue(field, text) !== undefined) return
    if (!this.mayEdit(field)) return
    const source = this.limits.source as Ready<SubagentLimits>
    const value = Number(text)
    const patch = { ...this.limits.patch }
    if (value === source.effective[field]) delete patch[field]
    else patch[field] = { kind: 'set', value }
    this.limits.patch = patch
    this.limits.status = undefined
    this.validate()
    this.changed()
  }

  toggleEnabled(): void {
    if (!this.mayEdit('enabled')) return
    const source = this.selection.source as Ready<SubagentModelSelection>
    const value = !patched(this.selection.patch.enabled, source.effective.enabled, source.inherited.enabled)
    const patch = { ...this.selection.patch }
    if (value === source.effective.enabled) delete patch.enabled
    else patch.enabled = { kind: 'set', value }
    this.selection.patch = patch
    this.selection.status = undefined
    this.validate()
    this.changed()
  }

  toggleRoute(route: SubagentAllowedModelRoute): void {
    if (!this.mayEdit('allowedModels')) return
    const source = this.selection.source as Ready<SubagentModelSelection>
    const routes = patched(this.selection.patch.allowedModels, source.effective.allowedModels, source.inherited.allowedModels)
    const present = routes.some(item => item.provider === route.provider && item.model === route.model)
    if (present && routes.length === 1 && patched(this.selection.patch.enabled, source.effective.enabled, source.inherited.enabled)) {
      this.issues.allowedModels = 'Disable model selection before removing the last route.'
      this.changed()
      return
    }
    const next = present ? routes.filter(item => item.provider !== route.provider || item.model !== route.model) : [...routes, { ...route }]
    const patch = { ...this.selection.patch }
    if (sameRoutes(next, source.effective.allowedModels)) delete patch.allowedModels
    else patch.allowedModels = { kind: 'set', value: next }
    this.selection.patch = patch
    this.selection.status = undefined
    this.validate()
    this.changed()
  }

  reset(field: SubagentSettingsField): void {
    if (!this.mayEdit(field)) return
    // Reset is an explicit operation even when effective already matches base.
    if (field === 'maxDepth' || field === 'maxActiveSubagents') {
      this.limits.patch = { ...this.limits.patch, [field]: { kind: 'reset' } }
      this.limits.status = undefined
    } else {
      this.selection.patch = { ...this.selection.patch, [field]: { kind: 'reset' } }
      this.selection.status = undefined
    }
    this.validate()
    this.changed()
  }

  /** Whether a new group Save is admitted: a REAL dirty field in a still-current
   *  section, no business issue, and no settled ambiguous outcome. A definite
   *  stale sibling never blocks a current dirty section; a settled unknown does
   *  (the user must Refresh first). */
  canSave(): boolean {
    if (this.disposed || this.loading || this.saving || !this.dirty()) return false
    if (Object.keys(this.issues).length !== 0) return false
    if (ambiguous(this.limits.status) || ambiguous(this.selection.status)) return false
    const limitsLive = this.deps.limits.read()
    const selectionLive = this.deps.selection.read()
    const limitsEligible = hasPatch(this.limits.patch) && this.limits.refreshRequired !== true
      && readyCurrent(this.limits.source, limitsLive)
    const selectionEligible = hasPatch(this.selection.patch) && this.selection.refreshRequired !== true
      && readyCurrent(this.selection.source, selectionLive)
    return limitsEligible || selectionEligible
  }

  /** A dirty refresh needs the page's explicit discard decision first. */
  refresh(discard = false): boolean {
    if (this.disposed || this.loading || this.saving) return false
    if (this.dirty() && !discard) {
      this.notice = 'Unsaved changes retained; discard them before refreshing.'
      this.changed()
      return false
    }
    const token = ++this.operation
    this.loading = true
    this.saved = false
    this.notice = undefined
    this.changed()
    this.deps.runOwned('subagent settings refresh', async () => {
      try {
        const results = await Promise.allSettled([this.deps.limits.refresh(), this.deps.selection.refresh()])
        if (this.disposed || token !== this.operation) return
        const failures = results.flatMap(result => result.status === 'rejected' ? [safeErrorMessage(result.reason)] : [])
        this.limits = this.refreshedSection(this.limits, this.deps.limits.read(), results[0].status === 'rejected')
        this.selection = this.refreshedSection(this.selection, this.deps.selection.read(), results[1].status === 'rejected')
        this.notice = failures.length === 0 ? undefined : `Refresh failed: ${failures.join('; ')}`
        this.issues = {}
        this.deps.onAuthoritativeChange?.()
      } finally {
        if (!this.disposed && token === this.operation) {
          this.loading = false
          this.changed()
        }
      }
    })
    return true
  }

  /**
   * ONE section's post-refresh state. A SETTLED AMBIGUOUS outcome whose refresh
   * could not produce a current authoritative read keeps its draft, status and
   * reason: an unreadable Host is not proof that the write did not land. A
   * definite/ordinary draft is cleared only by this explicit discard refresh.
   */
  private refreshedSection<T extends object>(state: SectionState<T>, fresh: SectionRead<T>, failed: boolean): SectionState<T> {
    if (ambiguous(state.status) && (failed || fresh.kind !== 'ready')) {
      return { source: state.source, patch: state.patch, status: state.status, refreshRequired: true }
    }
    // A successful ready read replaces the source and retires the old intent.
    // A failed/non-ready read is NOT a successful operation: keep a readable
    // last-confirmed source (and its historical settlement), mark it read-only
    // and reload only once a real current read exists.
    if (failed || fresh.kind !== 'ready') {
      return {
        source: state.source.kind === 'ready' ? state.source : fresh,
        patch: {},
        ...(state.status === undefined ? {} : { status: state.status }),
        refreshRequired: true,
      }
    }
    return { source: fresh, patch: {} }
  }

  discard(): void {
    if (this.disposed || this.saving || this.loading) return
    // A local discard clears ONLY the caller's draft/validation intent. The
    // captured source, its refreshRequired gate and the settlement status stay:
    // discarding a draft can never make a rejected/unknown authority current.
    this.limits.patch = {}
    this.selection.patch = {}
    this.issues = {}
    this.notice = undefined
    this.saved = false
    this.changed()
  }

  private candidateText(field: 'maxDepth' | 'maxActiveSubagents'): string {
    if (this.limits.source.kind !== 'ready') return ''
    const entry = this.limits.patch[field]
    return entry === undefined ? String(this.limits.source.effective[field]) : entry.kind === 'reset' ? '' : String(entry.value)
  }

  /** TRUE business validation only: the raw numeric draft is validated at
   *  Stage time and never becomes long-lived controller state. */
  private validate(): boolean {
    const issues: Partial<Record<SubagentSettingsField, string>> = {}
    const source = this.selection.source
    if (source.kind === 'ready') {
      const enabled = patched(this.selection.patch.enabled, source.effective.enabled, source.inherited.enabled)
      const routes = patched(this.selection.patch.allowedModels, source.effective.allowedModels, source.inherited.allowedModels)
      const seen = new Set<string>()
      for (const route of routes) {
        const key = `${route.provider}\u0000${route.model}`
        if (route.provider === '' || route.model === '' || seen.has(key)) issues.allowedModels = 'Choose distinct non-empty provider/model routes.'
        seen.add(key)
      }
      if (enabled && routes.length === 0) issues.allowedModels = 'Select at least one allowed route before enabling model selection.'
    }
    this.issues = issues
    return Object.keys(issues).length === 0
  }

  save(): void {
    if (this.disposed || this.loading || this.saving || !this.dirty()) return
    this.saved = false
    this.notice = undefined
    if (!this.validate()) { this.changed(); return }
    // The controller independently refuses exactly what the page must not
    // offer: an invalid, non-eligible or settled-ambiguous new Save. A
    // definite stale sibling keeps a current dirty section committable.
    if (!this.canSave()) { this.changed(); return }
    const limits = this.limits.source
    const selection = this.selection.source
    const limitsPatch = { ...this.limits.patch }
    const selectionPatch = { ...this.selection.patch }
    const limitsDirty = hasPatch(limitsPatch)
    const selectionDirty = hasPatch(selectionPatch)
    const initialLimits = this.deps.limits.read()
    const initialSelection = this.deps.selection.read()
    // A revision conflict is local to its section. A replaced Host invalidates
    // the whole intent, including an otherwise independently dirty section.
    const hostChanged = (limitsDirty && limits.kind === 'ready' && initialLimits.kind === 'ready' && limits.generation !== initialLimits.generation)
      || (selectionDirty && selection.kind === 'ready' && initialSelection.kind === 'ready' && selection.generation !== initialSelection.generation)
    if (hostChanged) {
      this.notice = 'Not saved · Host authority changed; refresh to review. Unsaved changes retained.'
      if (limitsDirty) this.limits.status = { kind: 'not-saved', text: this.notice }
      if (selectionDirty) this.selection.status = { kind: 'not-saved', text: this.notice }
      this.changed()
      return
    }
    if (limitsDirty && selectionDirty && limits.kind === 'ready' && selection.kind === 'ready' && limits.generation !== selection.generation) {
      this.notice = 'Not saved · the sections belong to different Host authorities; refresh to review.'
      this.changed()
      return
    }
    const token = ++this.operation
    this.saving = true
    if (limitsDirty) this.limits.status = { kind: 'saving', text: 'Saving…' }
    if (selectionDirty) this.selection.status = { kind: 'saving', text: 'Waiting for Limits…' }
    this.changed() // Publish the latch before an owned callback can run synchronously.
    this.deps.runOwned('subagent settings save', async () => {
      try {
        if (limitsDirty && limits.kind === 'ready') {
          await this.commitSection(this.limits, this.deps.limits, limitsPatch, limits, token)
        }
        if (this.disposed || token !== this.operation) return
        if (selectionDirty && selection.kind === 'ready') {
          // Re-prove the original Host after the first namespace settles. A
          // missing Limits descriptor is a local section loss, not evidence that
          // Selection's Host was replaced: Selection's own current generation is
          // the authority for its dispatch. A contradicting live Limits
          // descriptor still rejects the cross-Host case.
          const live = this.deps.selection.read()
          const firstLive = limitsDirty ? this.deps.limits.read() : undefined
          // Only a CAPTURED Limits descriptor whose live generation changed is
          // evidence of a replaced Host. A Limits descriptor that merely
          // disappeared is a local section loss; Selection's own current
          // generation remains the authority for its dispatch.
          const firstAuthorityChanged = limitsDirty && limits.kind === 'ready'
            && firstLive?.kind === 'ready' && firstLive.generation !== limits.generation
          if (live.kind !== 'ready' || live.generation !== selection.generation || firstAuthorityChanged) {
            this.selection.status = { kind: 'not-saved', text: 'Not saved · Host authority unavailable; refresh before retrying.' }
          } else {
            this.selection.status = { kind: 'saving', text: 'Saving…' }
            this.changed()
            await this.commitSection(this.selection, this.deps.selection, selectionPatch, selection, token)
          }
        }
      } catch (error) {
        if (!this.disposed && token === this.operation) {
          const text = `Outcome unconfirmed · ${safeErrorMessage(error)}; refresh before retrying.`
          if (hasPatch(this.limits.patch)) this.limits.status = { kind: 'outcome-unconfirmed', text }
          if (hasPatch(this.selection.patch)) this.selection.status = { kind: 'outcome-unconfirmed', text }
          this.notice = text
          this.changed()
        }
        throw error
      } finally {
        if (!this.disposed && token === this.operation) {
          this.saving = false
          this.saved = !this.dirty()
          this.changed()
          this.deps.onAuthoritativeChange?.()
        }
      }
    })
  }

  private async commitSection<T extends SubagentLimits | SubagentModelSelection>(
    state: SectionState<T>,
    port: { read(): SectionRead<T>; mutate(patch: SectionPatch<T>, revision: number, generation: object): Promise<SectionMutationOutcome> },
    patch: SectionPatch<T>, base: Ready<T>, token: number,
  ): Promise<void> {
    if (state.refreshRequired === true || !readyCurrent(base, port.read())) {
      state.refreshRequired = true
      state.status = { kind: 'not-saved', text: 'Not saved · settings changed; refresh to review. Unsaved changes retained.' }
      this.changed()
      return
    }
    let outcome: SectionMutationOutcome
    try { outcome = await port.mutate(patch, base.revision, base.generation) }
    catch (error) { outcome = { kind: 'outcome-unconfirmed', reason: safeErrorMessage(error) } }
    if (this.disposed || token !== this.operation) return
    const readback = port.read()
    state.refreshRequired = true
    if (outcome.kind !== 'accepted') {
      state.status = {
        kind: outcome.kind === 'outcome-unconfirmed' ? 'outcome-unconfirmed' : 'not-saved',
        text: outcome.kind === 'outcome-unconfirmed'
          ? `Outcome unconfirmed · ${outcome.reason}; possibly saved; refresh before retrying.`
          : `Not saved · ${outcome.reason}; refresh to review.`,
      }
    } else if (readback.kind !== 'ready' || readback.generation !== base.generation) {
      state.status = { kind: 'unverified', text: 'Unverified · the accepted write has no current Host readback; refresh before retrying.' }
    } else {
      // Reset is verified by accepted official unset + current readback. Never
      // require USER deletion or equality to the page's previous base.
      const setMatches = Object.entries(patch).every(([field, entry]) => {
        const op = entry as FieldPatch<unknown>
        return op.kind === 'reset' || isDeepStrictEqual(readback.effective[field as keyof T], op.value)
      })
      if (setMatches) {
        state.source = readback
        state.patch = {}
        state.refreshRequired = false
        state.status = { kind: 'verified', text: 'Verified' }
      } else state.status = { kind: 'unverified', text: 'Unverified · current Host values differ; refresh to review.' }
    }
    this.changed()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.operation += 1
    // Accepted Host writes keep their ConfigPort lifetime. Only this page's
    // publication rights are retired; no cancellation or replay is claimed.
  }
}
