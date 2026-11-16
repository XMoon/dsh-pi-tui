/** Per-open staged numeric drafts for the two FR5-B specialist pages
 * (`Agent loop` and `Shell execution`). The controller owns draft text,
 * validation, the explicit Reset intent and the ONE revision-checked Host
 * write per Save; the Host's official Settings descriptor stays the only
 * authority. */
import { isDeepStrictEqual } from 'node:util'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type {
  FieldPatch,
  SectionMutationOutcome,
  SectionPatch,
  SectionRead,
} from '../../runtime/config-port.ts'

export type HostNumericSettingsStatusKind = 'saving' | 'verified' | 'not-saved' | 'unverified' | 'outcome-unconfirmed'

export interface HostNumericSettingsStatus {
  readonly kind: HostNumericSettingsStatusKind
  readonly text: string
}

export interface HostNumericSettingsField<T extends object> {
  readonly key: keyof T & string
  readonly label: string
  /** The owning field's accepted numeric text. Defaults to the Agent-loop
   *  safe-positive-integer contract. */
  readonly validate?: (text: string) => boolean
  /** The field-specific draft error shown when `validate` rejects the text. */
  readonly invalidHint?: string
}

type Ready<T extends object> = Extract<SectionRead<T>, { kind: 'ready' }>

/** The typed section surface one page consumes. `base` is the exact captured
 *  read that fences the write (the Shell adapter uses its executor identity). */
export interface HostNumericSettingsPort<T extends object> {
  read(): SectionRead<T>
  refresh(): Promise<void>
  mutate(
    patch: SectionPatch<T>,
    expectedRevision: number,
    generation: object,
    base: Ready<T>,
  ): Promise<SectionMutationOutcome>
}

export interface HostNumericSettingsControllerDeps<T extends object> {
  readonly port: HostNumericSettingsPort<T>
  readonly fields: readonly HostNumericSettingsField<T>[]
  readonly requestRender: () => void
  readonly onAuthoritativeChange?: () => void
  readonly runOwned: (label: string, task: () => Promise<void>) => void
}

export interface HostNumericSettingsSnapshot<T extends object> {
  readonly loading: boolean
  readonly saving: boolean
  readonly revision: number
  readonly dirty: boolean
  readonly saved: boolean
  readonly source: SectionRead<T>
  /** The captured source is still the live read (generation + revision). */
  readonly current: boolean
  readonly currentGeneration?: object
  /** Per-field draft text; absent means the field was never edited. */
  readonly texts: Readonly<Partial<Record<keyof T & string, string>>>
  /** Fields with an explicit staged Reset (dirty even when effective = base). */
  readonly resetFields: readonly (keyof T & string)[]
  readonly issues: Readonly<Partial<Record<keyof T & string, string>>>
  readonly status?: HostNumericSettingsStatus
  readonly notice?: string
}

interface SectionState<T extends object> {
  source: SectionRead<T>
  patch: SectionPatch<T>
  refreshRequired?: boolean
  status?: HostNumericSettingsStatus
}

function hasPatch<T extends object>(patch: SectionPatch<T>): boolean {
  return Object.keys(patch).length !== 0
}

function readyCurrent<T extends object>(source: SectionRead<T>, live: SectionRead<T>): boolean {
  return source.kind === 'ready' && live.kind === 'ready'
    && source.generation === live.generation && source.revision === live.revision
}

export class HostNumericSettingsController<T extends object> {
  private readonly deps: HostNumericSettingsControllerDeps<T>
  private state: SectionState<T> = { source: { kind: 'unavailable', reason: 'Loading Host settings…' }, patch: {} }
  private readonly texts = new Map<string, string>()
  private readonly issues = new Map<string, string>()
  private loading = false
  private saving = false
  private saved = false
  private started = false
  private disposed = false
  private revision = 0
  private operation = 0
  private notice: string | undefined

  constructor(deps: HostNumericSettingsControllerDeps<T>) {
    this.deps = deps
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.refresh()
  }

  snapshot(): HostNumericSettingsSnapshot<T> {
    const live = this.deps.port.read()
    return {
      loading: this.loading,
      saving: this.saving,
      revision: this.revision,
      dirty: this.dirty(),
      saved: this.saved,
      source: this.state.source,
      current: this.state.refreshRequired !== true && readyCurrent(this.state.source, live),
      ...(live.kind === 'ready' ? { currentGeneration: live.generation } : {}),
      texts: Object.fromEntries(this.texts) as Readonly<Partial<Record<keyof T & string, string>>>,
      resetFields: this.resetFields(),
      issues: Object.fromEntries(this.issues) as Readonly<Partial<Record<keyof T & string, string>>>,
      ...(this.state.status === undefined ? {} : { status: this.state.status }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    }
  }

  /** The user's CURRENT draft value for display (a staged Reset paints as
   *  `Reset staged`; the last effective value is never repainted as the draft). */
  textOf(key: keyof T & string): string | undefined {
    return this.texts.get(key)
  }

  private resetFields(): readonly (keyof T & string)[] {
    const reset: (keyof T & string)[] = []
    for (const field of this.deps.fields) {
      if (this.state.patch[field.key]?.kind === 'reset') reset.push(field.key)
    }
    return reset
  }

  private dirty(): boolean {
    return hasPatch(this.state.patch)
  }

  private changed(): void {
    this.revision += 1
    this.deps.requestRender()
  }

  private editable(): boolean {
    if (this.disposed || this.loading || this.saving) return false
    const live = this.deps.port.read()
    if (this.state.refreshRequired === true || !readyCurrent(this.state.source, live)) {
      this.notice = 'Host settings changed or are unavailable; refresh before editing.'
      this.changed()
      return false
    }
    return true
  }

  setNumber(key: keyof T & string, text: string): void {
    if (!this.editable()) return
    const source = this.state.source as Ready<T>
    this.saved = false
    this.notice = undefined
    this.texts.set(key, text)
    // The controller only ever serves number fields; the typed section patch is
    // narrowed to the one number entry this page can stage.
    const patch = { ...this.state.patch } as Record<string, FieldPatch<number>>
    if (text.trim() === '') patch[key] = { kind: 'reset' }
    else {
      const value = Number(text)
      if (value === source.effective[key] && this.numberValid(key, text)) delete patch[key]
      else patch[key] = { kind: 'set', value }
    }
    this.state.patch = patch as SectionPatch<T>
    this.state.status = undefined
    this.validate()
    this.changed()
  }

  /** An explicit Reset is an INTENT even when the effective value already
   *  matches the inherited one: the official `unset` is dispatched again. */
  reset(key: keyof T & string): void {
    if (!this.editable()) return
    this.saved = false
    this.notice = undefined
    this.texts.set(key, '')
    this.state.patch = { ...this.state.patch, [key]: { kind: 'reset' } }
    this.state.status = undefined
    this.validate()
    this.changed()
  }

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
    this.deps.runOwned('host numeric settings refresh', async () => {
      let failure: string | undefined
      try {
        await this.deps.port.refresh()
      } catch (error) {
        failure = safeErrorMessage(error)
      }
      try {
        if (this.disposed || token !== this.operation) return
        this.state = { source: this.deps.port.read(), patch: {}, ...(failure === undefined ? {} : { refreshRequired: true }) }
        this.notice = failure === undefined ? undefined : `Refresh failed: ${failure}`
        this.syncTexts()
        this.issues.clear()
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

  discard(): void {
    if (this.disposed || this.saving || this.loading) return
    this.state.patch = {}
    this.state.status = undefined
    this.issues.clear()
    this.notice = undefined
    this.saved = false
    this.syncTexts()
    this.changed()
  }

  private syncTexts(): void {
    this.texts.clear()
    const source = this.state.source
    if (source.kind !== 'ready') return
    for (const field of this.deps.fields) this.texts.set(field.key, String(source.effective[field.key]))
  }

  private numberValid(key: keyof T & string, text: string): boolean {
    if (text.trim() === '') return false
    const field = this.deps.fields.find(candidate => candidate.key === key)
    if (field?.validate !== undefined) return field.validate(text)
    if (!/^\d+$/u.test(text.trim())) return false
    const value = Number(text)
    return Number.isSafeInteger(value) && value >= 1
  }

  private validate(): boolean {
    this.issues.clear()
    if (this.state.source.kind !== 'ready') return false
    for (const field of this.deps.fields) {
      const text = this.texts.get(field.key)
      if (text === undefined || text.trim() === '') continue
      if (!this.numberValid(field.key, text)) {
        this.issues.set(field.key, field.invalidHint ?? 'Enter a safe positive integer (1 or greater).')
      }
    }
    return this.issues.size === 0
  }

  save(): void {
    if (this.disposed || this.loading || this.saving || !this.dirty()) return
    this.saved = false
    this.notice = undefined
    if (!this.validate()) {
      this.changed()
      return
    }
    const base = this.state.source
    if (base.kind !== 'ready') return
    const patch = { ...this.state.patch }
    const live = this.deps.port.read()
    if (this.state.refreshRequired === true || !readyCurrent(base, live)) {
      this.state.status = { kind: 'not-saved', text: 'Not saved · Host settings changed; refresh to review. Unsaved changes retained.' }
      this.changed()
      return
    }
    const token = ++this.operation
    this.saving = true
    this.state.status = { kind: 'saving', text: 'Saving…' }
    this.changed() // publish the latch before an owned callback can run synchronously

    this.deps.runOwned('host numeric settings save', async () => {
      try {
        let outcome: SectionMutationOutcome
        try {
          outcome = await this.deps.port.mutate(patch, base.revision, base.generation, base)
        } catch (error) {
          outcome = { kind: 'outcome-unconfirmed', reason: safeErrorMessage(error) }
        }
        if (this.disposed || token !== this.operation) return
        const readback = this.deps.port.read()
        if (outcome.kind !== 'accepted') {
          this.state.refreshRequired = true
          this.state.status = {
            kind: outcome.kind === 'outcome-unconfirmed' ? 'outcome-unconfirmed' : 'not-saved',
            text: outcome.kind === 'outcome-unconfirmed'
              ? `Outcome unconfirmed · ${outcome.reason}; possibly saved; refresh before retrying.`
              : `Not saved · ${outcome.reason}; refresh to review.`,
          }
        } else if (readback.kind !== 'ready' || readback.generation !== base.generation) {
          this.state.refreshRequired = true
          this.state.status = { kind: 'unverified', text: 'Unverified · the accepted write has no current Host readback; refresh before retrying.' }
        } else {
          const setMatches = Object.entries(patch).every(([field, entry]) => {
            const op = entry as FieldPatch<unknown>
            return op.kind === 'reset' || isDeepStrictEqual(readback.effective[field as keyof T], op.value)
          })
          if (setMatches) {
            this.state = { source: readback, patch: {} }
            this.syncTexts()
            this.state.status = { kind: 'verified', text: 'Verified' }
            this.saved = true
          } else {
            this.state.refreshRequired = true
            this.state.status = { kind: 'unverified', text: 'Unverified · current Host values differ; refresh to review.' }
          }
        }
      } finally {
        if (!this.disposed && token === this.operation) {
          this.saving = false
          if (!this.dirty()) this.saved = true
          this.changed()
          this.deps.onAuthoritativeChange?.()
        }
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.operation += 1
    // Accepted Host writes keep their ConfigPort lifetime; this page only
    // retires its own publication rights.
  }
}
