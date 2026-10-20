/**
 * The Settings → Models page (Phase 3C / C2-MA): the ONE in-place surface for
 * provider profiles, API-key references, stored credential records and
 * provider-native authorization attempts. It lives INSIDE the existing
 * Settings workspace lease (the same screen, input route and mouse hit-map
 * discipline as the rest of the workspace) and owns only view/draft state.
 *
 * The page never touches a Host service: every read is a detached DTO and
 * every write is an intent on {@link ModelsWorkspaceSource} (implemented by
 * the app/command layer over the ConfigPort). Secret drafts stay page-local
 * and are dropped on save/cancel/dispose; the masked editor reuses the
 * existing QuestionFlow component.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/models-workspace-page
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { color } from '../theme/runtime.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { QuestionFlow, type QuestionMouseGesture } from '../interaction/question.ts'
import { authorizationFailureText, createAuthorizationFlow } from '../../app/command/authorization.ts'
import type {
  AuthorizationConfig,
  AuthorizationFlowEvent,
  AuthorizationNoticeEvent,
  ProviderConfigGuide,
  ProviderProfileFacts,
} from '../../runtime/config-port.ts'
import type {
  CreateProviderDraft,
  CreateProviderOutcome,
  CredentialClearTarget,
  StoredCredentialRow,
} from '../../app/command/credential-workflow.ts'
import { PROTOCOL_CHOICES, ROUTE_PATTERN } from '../../domain/catalog/provider.ts'

/** One provider row of the Models list (a detached semantic DTO). */
export interface ModelsProviderRow {
  readonly kind: 'reference' | 'authorization'
  /** Stable list/detail identity: `route:<route>` for a reference or
   *  `auth:<flow key>` for a provider-native flow. A route-less flow has no
   *  route, so its key is the only unique identity. */
  readonly identity: string
  readonly route: string
  readonly label: string
  /** The exact credential reference of a reference row. */
  readonly ref?: string
  /** The exact authorization flow key of an authorization row. */
  readonly key?: string
  readonly configured: boolean
  readonly declared: boolean
  readonly namesCredential: boolean
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  readonly inFlight: boolean
  readonly profile: ProviderProfileFacts
}

/** The Account row's current summary. */
export interface ModelsAccountSummary {
  readonly available: boolean
  readonly status?: 'signed-out' | 'credential-stored'
  readonly failure?: string
}

/** One credential presence answer for the list (async, never inferred from a
 * route or a profile). */
export type ModelsCredentialState =
  | { readonly kind: 'known'; readonly configured: boolean; readonly source?: string }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'pending' }

/** The stored-credential snapshot (references + records). */
export interface ModelsStoredCredentials {
  readonly rows: readonly StoredCredentialRow[]
  readonly recordCleanupUnavailable: boolean
  readonly referenceReadFailures: readonly string[]
}

/** The page's intent surface (the app/command owner implements it). */
export interface ModelsWorkspaceSource {
  readonly available: boolean
  rows(): readonly ModelsProviderRow[]
  accountSummary(): Promise<ModelsAccountSummary>
  credentialState(ref: string): Promise<ModelsCredentialState>
  storedCredentials(): Promise<ModelsStoredCredentials>
  describeReference(ref: string): Promise<{ readonly configured: boolean; readonly source?: string }>
  setReference(ref: string, secret: string): Promise<void>
  clearReference(ref: string): Promise<void>
  deleteRecord(key: string): Promise<void>
  beginAuthorization(
    targetKey: string,
    method: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly kind: 'started'; readonly attemptId: string } | { readonly kind: 'unavailable' }>
  authorizationEvents(listener: (event: AuthorizationFlowEvent) => void): () => void
  respondAuthorization(attemptId: string, promptId: string, answer: string | null): Promise<void>
  cancelAuthorization(attemptId: string): Promise<void>
  provisionKeylessProfile(route: string | undefined): Promise<string>
  discoverModels(request: { readonly baseURL: string; readonly api: string; readonly apiKey?: string }): Promise<readonly { readonly id: string }[]>
  createProvider(draft: CreateProviderDraft): Promise<CreateProviderOutcome>
  configGuide(): ProviderConfigGuide
  openUrl(url: string): void
  copy(text: string): void
  /** Run one page-owned async operation through the app's ownership entry. */
  run(label: string, task: () => Promise<void>): void
}

/** The initial page a `/login` / `/logout` deep link opens. */
export type ModelsInitialView =
  | { readonly view: 'list' }
  | { readonly view: 'provider'; readonly route: string }
  | { readonly view: 'reference'; readonly ref: string; readonly label?: string }
  | { readonly view: 'add-provider'; readonly route?: string }
  | { readonly view: 'logout-list' }
  | { readonly view: 'logout'; readonly target: CredentialClearTarget }
  | { readonly view: 'records' }
  | { readonly view: 'guide' }

/** The page's own close/navigation result (the workspace root owns the seat). */
export type ModelsPageExit = 'handled' | 'exit' | 'open-account'

type ModelsView =
  | { readonly kind: 'list' }
  | { readonly kind: 'provider'; readonly identity: string }
  | { readonly kind: 'reference'; readonly ref: string; readonly label: string }
  | { readonly kind: 'add-provider' }
  | { readonly kind: 'review' }
  | { readonly kind: 'records' }
  | { readonly kind: 'logout-list' }
  | { readonly kind: 'logout'; readonly target: CredentialClearTarget }
  | { readonly kind: 'guide' }

interface ClearState {
  readonly phase: 'reading' | 'ready' | 'pending' | 'done' | 'failed'
  readonly configured: boolean
  readonly source?: string
  readonly reason?: string
  readonly result?: string
}

interface AddProviderState {
  readonly step: 'form' | 'review'
  readonly draft: {
    readonly route: string
    readonly api: string
    readonly baseURL: string
    readonly displayName: string
    readonly key: string
    readonly models: readonly string[]
  }
  readonly error?: string
  readonly discovering: boolean
  readonly discoveryNote?: string
  readonly creating?: boolean
  readonly result?: CreateProviderOutcome
}

interface PickerState {
  /** Stable prompt identity: cursor navigation replaces the state object, so
   *  removal must match this token, never the object identity. */
  readonly token: object
  readonly header: string
  readonly items: readonly { readonly value: string; readonly label: string; readonly description?: string }[]
  readonly index: number
  readonly onSelect: (value: string) => void
  readonly onCancel: () => void
}

interface NoticeState {
  readonly message: string
  readonly url?: string
  readonly code?: string
}

interface AuthState {
  readonly targetIdentity: string
  readonly phase: 'starting' | 'running' | 'authorized' | 'cancelled' | 'failed'
  /** A cancellation was requested but the Host may still commit/finish. */
  readonly cancelRequested?: boolean
  readonly attemptId?: string
  readonly status?: string
}

interface EmbeddedQuestion {
  readonly token: object
  readonly flow: QuestionFlow
}

interface HitTarget {
  readonly kind: 'row' | 'action' | 'picker' | 'model-picker'
  readonly id: string
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

interface ActionLine {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
}

interface Projection {
  readonly content: string[]
  readonly actions: readonly ActionLine[]
}

const TITLE = 'Models & Credentials'
const LABEL_WIDTH = 16

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

function credentialWord(state: ModelsCredentialState): { readonly word: string; readonly tone: 'success' | 'warning' | 'muted' } {
  if (state.kind === 'pending') return { word: 'Unknown', tone: 'muted' }
  if (state.kind === 'unknown') return { word: 'Unknown', tone: 'warning' }
  return state.configured
    ? { word: state.source === undefined ? 'Configured' : `Configured · ${state.source}`, tone: 'success' }
    : { word: 'Not set', tone: 'muted' }
}

function paintState(text: string, tone: 'success' | 'warning' | 'muted'): string {
  return tone === 'success' ? color.success(text) : tone === 'warning' ? color.warning(text) : color.textMuted(text)
}

function parseModelIds(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map(part => part.trim()).filter(part => part !== ''))]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The Models page component. Constructed per workspace open. */
export class ModelsWorkspacePage implements Component {
  private readonly source: ModelsWorkspaceSource
  private requestRender: () => void
  private readonly onOpenAccount: () => void
  private view: ModelsView = { kind: 'list' }
  private providerRows: readonly ModelsProviderRow[] = []
  private account: ModelsAccountSummary = { available: false }
  private readonly credentialStates = new Map<string, ModelsCredentialState>()
  private records: ModelsStoredCredentials | undefined
  private clear: ClearState | undefined
  private add: AddProviderState | undefined
  private cursor = 0
  private scroll = 0
  /** Set by keyboard navigation; the next render follows the selected content
   *  row into view. Wheel scrolling clears it so it never fights the user. */
  private followCursor = false
  private picker: PickerState | undefined
  private readonly pickerQueue: PickerState[] = []
  private modelPicker: { items: readonly { readonly id: string }[]; readonly selected: Set<string>; index: number } | undefined
  private question: EmbeddedQuestion | undefined
  private readonly questionQueue: EmbeddedQuestion[] = []
  private notice: string | undefined
  private auth: AuthState | undefined
  private authNotice: NoticeState | undefined
  private authUnsubscribe: (() => void) | undefined
  /** Esc on a provider detail with a live native attempt waits for the Host
   *  settled event (and its prompt cleanup) before returning to the list. */
  private pendingAfterAuth: (() => void) | undefined
  private cancelledAttempt: string | undefined
  private readonly pageController = new AbortController()
  private disposed = false
  private revision = 0
  private paintedTargets: readonly HitTarget[] = []
  private pressed: { readonly target: HitTarget; readonly revision: number; readonly width: number; readonly height: number } | undefined
  private lastWidth = 0
  private lastHeight = 0
  private bodyHeight = 1
  /** The last painted QuestionFlow region (page-local rows) for mouse input. */
  private questionTop = 0
  private questionRows = 0
  /** The embedded QuestionFlow requires an 8-row budget to keep its confirm
   *  hint visible; below it Enter must not submit a clipped form. */
  private questionUsable = true
  private pickerUsable = true
  private questionPress: { readonly gesture: QuestionMouseGesture; readonly revision: number; readonly width: number; readonly height: number; readonly row: number } | undefined
  private copyValue: string | undefined
  private paintedCopy = false
  private referenceEditor: { ref: string; label: string }
  private referencePhase: 'idle' | 'editing' | 'pending' | 'verified' | 'not-saved' | 'unknown' = 'idle'
  private referenceStatus: string | undefined
  private referenceConfigured: boolean | undefined
  private initializing = true
  /** Per-wizard and per-confirmation identities: a late settlement of an
   * abandoned draft/clear target can never mutate a newer one. */
  private addSerial = 0
  private referenceSerial = 0
  private clearSerial = 0
  private refreshSerial = 0
  private recordsSerial = 0
  private referenceReadSerial = 0
  /** Per-reference read generation: a mutation's authoritative re-read must
   *  invalidate an older credentialState answer for the SAME ref without
   *  disturbing other providers' independent reads. */
  private readonly credentialReadSerials = new Map<string, number>()
  private clearReadSerial = 0
  private recordsError: string | undefined
  private addDiscoverySerial = 0

  constructor(
    source: ModelsWorkspaceSource,
    requestRender: () => void,
    initial: ModelsInitialView,
    onOpenAccount: () => void,
  ) {
    this.source = source
    this.requestRender = requestRender
    this.onOpenAccount = onOpenAccount
    this.providerRows = source.rows()
    this.referenceEditor = initial.view === 'reference'
      ? { ref: initial.ref, label: initial.label ?? initial.ref }
      : { ref: '', label: '' }
    this.applyInitial(initial)
    this.refresh()
  }

  private applyInitial(initial: ModelsInitialView): void {
    switch (initial.view) {
      case 'list':
      case 'records':
      case 'logout-list':
      case 'guide':
      case 'add-provider':
        if (initial.view === 'add-provider') this.startAddProvider(initial.route)
        else this.view = { kind: initial.view }
        return
      case 'provider':
        this.view = { kind: 'provider', identity: this.identityOfRoute(initial.route) }
        return
      case 'reference':
        this.view = { kind: 'reference', ref: initial.ref, label: initial.label ?? initial.ref }
        return
      case 'logout':
        this.openClear(initial.target)
        return
    }
  }

  // ── data refresh ─────────────────────────────────────────────────────────

  /** Re-read every page-owned authority. All reads are intents that settle on
   * this page only; a late settlement after dispose is ignored by `settle`. */
  private refresh(): void {
    if (this.disposed) return
    const serial = ++this.refreshSerial
    this.providerRows = this.source.rows()
    for (const row of this.providerRows) {
      if (row.kind !== 'reference' || row.ref === undefined) continue
      const ref = row.ref
      const refSerial = (this.credentialReadSerials.get(ref) ?? 0) + 1
      this.credentialReadSerials.set(ref, refSerial)
      this.source.run('models credential read', async () => {
        let state: ModelsCredentialState
        try {
          state = await this.source.credentialState(ref)
        } catch (error) {
          state = { kind: 'unknown', reason: errorText(error) }
        }
        this.settle(() => {
          if (this.credentialReadSerials.get(ref) !== refSerial) return
          this.credentialStates.set(ref, state)
        })
      })
    }
    this.source.run('models account read', async () => {
      let summary: ModelsAccountSummary
      try {
        summary = await this.source.accountSummary()
      } catch (error) {
        summary = { available: true, failure: errorText(error) }
      }
      this.settle(() => {
        if (serial !== this.refreshSerial) return
        this.account = summary
        this.initializing = false
      })
    })
    // Record presence is authoritative state for the authorization rows on the
    // MODELS HOME too, not only for the Stored credentials view.
    this.refreshRecords()
    if (this.view.kind === 'logout' || this.view.kind === 'reference') this.readReferenceState()
    this.requestRender()
  }

  private refreshRecords(): void {
    const serial = ++this.recordsSerial
    // A read in flight has no current record presence: do not keep painting
    // the previous snapshot as if it were the Host's current fact.
    this.records = undefined
    this.recordsError = undefined
    this.source.run('models records read', async () => {
      try {
        const records = await this.source.storedCredentials()
        this.settle(() => {
          if (serial !== this.recordsSerial) return
          this.records = records
          this.recordsError = undefined
          if (this.notice?.startsWith('the stored credentials could not be read') === true) this.notice = undefined
        })
      } catch (error) {
        this.settle(() => {
          if (serial !== this.recordsSerial) return
          this.records = undefined
          this.recordsError = errorText(error)
          this.notice = `the stored credentials could not be read: ${errorText(error)}`
        })
      }
    })
  }

  private invalidateCredentialRead(ref: string): void {
    this.credentialReadSerials.set(ref, (this.credentialReadSerials.get(ref) ?? 0) + 1)
  }

  private readReferenceState(): void {
    const view = this.view
    const ref = view.kind === 'reference' ? view.ref : view.kind === 'logout' && view.target.kind === 'reference' ? view.target.ref : undefined
    if (ref === undefined) return
    const clearSerial = view.kind === 'logout' ? this.clearSerial : undefined
    const readSerial = ++this.referenceReadSerial
    this.source.run('models reference read', async () => {
      try {
        const info = await this.source.describeReference(ref)
        this.settle(() => {
          if (readSerial !== this.referenceReadSerial) return
          const current = this.view
          if (current.kind === 'reference') {
            if (current.ref !== ref) return
          } else if (current.kind === 'logout') {
            if (current.target.kind !== 'reference' || current.target.ref !== ref) return
          } else return
          if (current.kind === 'logout' && this.clear !== undefined
            && this.clear.phase !== 'reading' && this.clear.phase !== 'ready') return
          this.referenceConfigured = info.configured
          this.credentialStates.set(ref, {
            kind: 'known',
            configured: info.configured,
            ...(info.source === undefined ? {} : { source: info.source }),
          })
          if (current.kind === 'logout' && this.clear !== undefined && clearSerial === this.clearSerial) {
            this.clear = {
              phase: 'ready',
              configured: info.configured,
              ...(info.source === undefined ? {} : { source: info.source }),
            }
          }
        })
      } catch (error) {
        this.settle(() => {
          if (readSerial !== this.referenceReadSerial) return
          const current = this.view
          if (current.kind === 'reference') {
            if (current.ref !== ref) return
          } else if (current.kind === 'logout') {
            if (current.target.kind !== 'reference' || current.target.ref !== ref) return
          } else return
          if (current.kind === 'logout' && this.clear !== undefined
            && this.clear.phase !== 'reading' && this.clear.phase !== 'ready') return
          if (current.kind === 'logout' && clearSerial === this.clearSerial) {
            this.clear = { phase: 'failed', configured: false, reason: errorText(error) }
          } else if (current.kind === 'reference') {
            this.notice = `the credential store could not be read: ${errorText(error)}`
          }
        })
      }
    })
  }

  /** Apply one async settlement only while this page instance is alive. */
  private settle(apply: () => void): void {
    if (this.disposed) return
    apply()
    this.revision += 1
    this.requestRender()
  }

  invalidate(): void {
    this.question?.flow.invalidate()
  }

  // ── navigation ──────────────────────────────────────────────────────────

  private enter(view: ModelsView): void {
    if (view.kind === 'reference') this.referenceSerial += 1
    this.view = view
    this.cursor = 0
    this.scroll = 0
    this.followCursor = false
    this.notice = undefined
    this.revision += 1
    if (view.kind === 'records' || view.kind === 'logout-list') this.refreshRecords()
    if (view.kind === 'reference') {
      this.referencePhase = 'idle'
      this.referenceStatus = undefined
      this.referenceConfigured = undefined
      this.readReferenceState()
    }
    this.requestRender()
  }

  private identityOfRoute(route: string): string {
    return this.providerRows.find(candidate => candidate.route === route)?.identity ?? `route:${route}`
  }

  private selectProvider(identity: string): void {
    this.auth = undefined
    this.authNotice = undefined
    this.enter({ kind: 'provider', identity })
  }

  // ── API key reference ────────────────────────────────────────────────────

  private beginReferenceEditor(): void {
    if (this.view.kind !== 'reference' || this.referencePhase === 'pending') return
    this.referencePhase = 'editing'
    const ref = this.view.ref
    const label = this.view.label
    const serial = this.referenceSerial
    const isCurrent = (): boolean => serial === this.referenceSerial && this.view.kind === 'reference' && this.view.ref === ref
    const question = this.createQuestion({
      header: `API key · ${label}`,
      question: `Enter the API key for ${label} (${ref}):`,
      masked: true,
      onAnswer: value => {
        this.removeQuestion(question)
        const secret = value?.trim() ?? ''
        if (secret === '') {
          this.referencePhase = 'idle'
          this.referenceStatus = 'empty key; nothing set'
          this.requestRender()
          return
        }
        this.referencePhase = 'pending'
        this.referenceStatus = 'saving — the Host has not confirmed yet'
        this.referenceReadSerial += 1
        this.invalidateCredentialRead(ref)
        this.requestRender()
        this.source.run('models API key write', async () => {
          try {
            await this.source.setReference(ref, secret)
          } catch (error) {
            this.settle(() => {
              if (!isCurrent()) return
              this.referencePhase = 'not-saved'
              this.referenceStatus = error instanceof Error && error.name === 'SupersededReadError'
                ? 'Not sent — the key never left the client'
                : errorText(error)
              this.referenceReadSerial += 1
              this.invalidateCredentialRead(ref)
              this.credentialStates.set(ref, { kind: 'unknown', reason: this.referenceStatus })
            })
            return
          }
          try {
            const info = await this.source.describeReference(ref)
            this.settle(() => {
              if (!isCurrent()) return
              this.referencePhase = info.configured ? 'verified' : 'unknown'
              this.referenceStatus = info.configured
                ? info.source === undefined ? 'Verified' : `Verified · source: ${info.source}`
                : 'the write returned, but the credential store still reports it unset'
              this.referenceConfigured = info.configured
              this.referenceReadSerial += 1
              this.invalidateCredentialRead(ref)
              this.credentialStates.set(ref, {
                kind: 'known',
                configured: info.configured,
                ...(info.source === undefined ? {} : { source: info.source }),
              })
            })
          } catch (error) {
            this.settle(() => {
              if (!isCurrent()) return
              this.referencePhase = 'unknown'
              this.referenceStatus = `the write returned; the store could not be re-read: ${errorText(error)}`
              this.referenceReadSerial += 1
              this.invalidateCredentialRead(ref)
              this.credentialStates.set(ref, { kind: 'unknown', reason: this.referenceStatus })
            })
          }
        })
      },
    })
    this.setQuestion(question)
    this.requestRender()
  }

  // ── clear confirmation (logout) ──────────────────────────────────────────

  private openClear(target: CredentialClearTarget): void {
    this.clearSerial += 1
    this.view = { kind: 'logout', target }
    this.cursor = 0
    this.scroll = 0
    if (target.kind === 'record') {
      this.clear = { phase: 'ready', configured: true }
      this.readClearRecord()
    } else {
      this.clear = { phase: 'reading', configured: false }
      this.readReferenceState()
    }
    this.revision += 1
    this.requestRender()
  }

  private readClearRecord(): void {
    if (this.view.kind !== 'logout' || this.view.target.kind !== 'record') return
    const key = this.view.target.key
    const serial = this.clearSerial
    const readSerial = ++this.clearReadSerial
    this.clear = { phase: 'reading', configured: false }
    this.source.run('models clear target read', async () => {
      try {
        const records = await this.source.storedCredentials()
        const present = records.rows.some(row => row.kind === 'record' && row.key === key)
        this.settle(() => {
          if (readSerial !== this.clearReadSerial || serial !== this.clearSerial || this.view.kind !== 'logout' || this.view.target.kind !== 'record' || this.view.target.key !== key) return
          this.clear = { phase: 'ready', configured: present }
        })
      } catch (error) {
        this.settle(() => {
          if (readSerial !== this.clearReadSerial || serial !== this.clearSerial || this.view.kind !== 'logout' || this.view.target.kind !== 'record' || this.view.target.key !== key) return
          this.clear = { phase: 'failed', configured: false, reason: errorText(error) }
        })
      }
    })
  }

  private confirmClear(): void {
    const view = this.view
    const clear = this.clear
    if (view.kind !== 'logout' || clear === undefined || clear.phase !== 'ready' || !clear.configured) return
    const target = view.target
    const serial = this.clearSerial
    const isCurrent = (): boolean => serial === this.clearSerial
      && this.view.kind === 'logout'
      && this.view.target.kind === target.kind
      && (target.kind === 'reference'
        ? this.view.target.kind === 'reference' && this.view.target.ref === target.ref
        : this.view.target.kind === 'record' && this.view.target.key === target.key)
    this.clear = { ...clear, phase: 'pending' }
    // A refresh/read started before this dispatch must never reset the clear
    // to ready while the Host mutation is in flight.
    this.clearReadSerial += 1
    this.referenceReadSerial += 1
    if (target.kind === 'reference') this.invalidateCredentialRead(target.ref)
    else this.recordsSerial += 1
    this.requestRender()
    this.source.run('models credential clear', async () => {
      try {
        if (target.kind === 'reference') await this.source.clearReference(target.ref)
        else await this.source.deleteRecord(target.key)
      } catch (error) {
        this.settle(() => {
          if (!isCurrent()) return
          this.clear = { phase: 'failed', configured: true, reason: errorText(error) }
        })
        return
      }
      if (target.kind === 'reference') {
        const readSerial = ++this.clearReadSerial
        try {
          const info = await this.source.describeReference(target.ref)
          this.settle(() => {
            if (!isCurrent() || readSerial !== this.clearReadSerial) return
            this.clear = info.configured
              ? { phase: 'failed', configured: true, reason: 'the credential store still reports this reference as configured' }
              : { phase: 'done', configured: false, result: `API key ${target.ref} cleared` }
            this.referenceReadSerial += 1
            this.invalidateCredentialRead(target.ref)
            this.credentialStates.set(target.ref, {
              kind: 'known',
              configured: info.configured,
              ...(info.source === undefined ? {} : { source: info.source }),
            })
            // The first authoritative describeReference() is the completion
            // read. Do NOT start a second one: a later answer must not regress
            // the confirmed done state.
          })
        } catch (error) {
          this.settle(() => {
            if (!isCurrent() || readSerial !== this.clearReadSerial) return
            this.clear = { phase: 'failed', configured: true, reason: `the clear returned; the store could not be re-read: ${errorText(error)}` }
            this.referenceReadSerial += 1
            this.invalidateCredentialRead(target.ref)
            this.credentialStates.set(target.ref, { kind: 'unknown', reason: errorText(error) })
          })
        }
        return
      }
      const readSerial = ++this.clearReadSerial
      try {
        const records = await this.source.storedCredentials()
        const present = records.rows.some(row => row.kind === 'record' && row.key === target.key)
        this.settle(() => {
          if (!isCurrent() || readSerial !== this.clearReadSerial) return
          this.recordsSerial += 1
          this.records = records
          this.clear = present
            ? { phase: 'failed', configured: true, reason: 'the stored record is still present after the clear' }
            : { phase: 'done', configured: false, result: `${target.label} signed out locally — stored credential cleared` }
        })
      } catch (error) {
        this.settle(() => {
          if (!isCurrent() || readSerial !== this.clearReadSerial) return
          // The authoritative re-read failed. Fence any older refreshRecords
          // answer and drop the old snapshot: record presence is Unknown, never
          // the pre-delete list.
          this.recordsSerial += 1
          this.records = undefined
          this.clear = { phase: 'failed', configured: true, reason: `the clear returned; the record list could not be re-read: ${errorText(error)}` }
        })
      }
    })
  }

  // ── add provider ────────────────────────────────────────────────────────

  private startAddProvider(route?: string): void {
    this.addSerial += 1
    this.addDiscoverySerial += 1
    this.add = {
      step: 'form',
      draft: { route: route ?? '', api: PROTOCOL_CHOICES[0], baseURL: '', displayName: '', key: '', models: [] },
      discovering: false,
    }
    this.view = { kind: 'add-provider' }
    this.cursor = 0
    this.scroll = 0
    this.requestRender()
  }

  private updateAddDraft(patch: Partial<AddProviderState['draft']>): void {
    const add = this.add
    if (add === undefined) return
    const invalidatesDiscovery = 'baseURL' in patch || 'api' in patch || 'key' in patch
    if (invalidatesDiscovery) this.addDiscoverySerial += 1
    this.add = {
      ...add,
      draft: { ...add.draft, ...patch },
      error: undefined,
      ...(invalidatesDiscovery ? { discovering: false, discoveryNote: undefined } : {}),
    }
    this.requestRender()
  }

  private editAddField(index: number): void {
    const add = this.add
    if (add === undefined) return
    const field = ADD_FIELDS[index]
    if (field === undefined) return
    if (field.id === 'api') {
      this.picker = {
        token: {},
        header: 'Wire protocol',
        items: PROTOCOL_CHOICES.map(choice => ({ value: choice, label: choice })),
        index: Math.max(0, PROTOCOL_CHOICES.indexOf(add.draft.api as typeof PROTOCOL_CHOICES[number])),
        onSelect: value => {
          this.picker = undefined
          this.updateAddDraft({ api: value })
        },
        onCancel: () => { this.picker = undefined; this.requestRender() },
      }
      this.requestRender()
      return
    }
    if (field.id === 'models') {
      this.beginModelDiscovery()
      return
    }
    const current = add.draft[field.id]
    const question = this.createQuestion({
      header: `Add provider · ${field.label}`,
      question: field.question,
      masked: field.id === 'key',
      ...(field.id === 'key' ? { allowEmpty: true } : {}),
      initial: current,
      onAnswer: value => {
        this.removeQuestion(question)
        if (value === undefined) return
        this.updateAddDraft({ [field.id]: value.trim() })
      },
    })
    this.setQuestion(question)
    this.requestRender()
  }

  private beginModelDiscovery(): void {
    const add = this.add
    if (add === undefined || add.discovering) return
    if (add.draft.baseURL.trim() === '') {
      this.add = { ...add, error: 'enter the base URL first' }
      this.requestRender()
      return
    }
    this.add = { ...add, discovering: true, error: undefined }
    const serial = ++this.addDiscoverySerial
    this.requestRender()
    this.source.run('models model discovery', async () => {
      let discovery: readonly { id: string }[] = []
      let note: string
      try {
        discovery = await this.source.discoverModels({
          baseURL: add.draft.baseURL.trim(),
          api: add.draft.api,
          ...(add.draft.key.trim() === '' ? {} : { apiKey: add.draft.key.trim() }),
        })
        note = discovery.length > 0
          ? `probed ${discovery.length} model${discovery.length > 1 ? 's' : ''}`
          : 'the probe advertised no models — enter ids by hand'
      } catch {
        note = 'model probe failed — enter model ids by hand'
      }
      this.settle(() => {
        if (serial !== this.addDiscoverySerial) return
        const current = this.add
        if (current === undefined) return
        this.add = { ...current, discovering: false, discoveryNote: note }
        if (discovery.length === 0) {
          this.beginManualModels()
          return
        }
        this.modelPicker = {
          items: discovery,
          selected: new Set(current.draft.models.filter(id => discovery.some(model => model.id === id))),
          index: 0,
        }
      })
    })
  }

  private beginManualModels(): void {
    const add = this.add
    if (add === undefined) return
    const question = this.createQuestion({
      header: 'Add provider · model ids',
      question: 'Model ids this route serves (comma or space separated):',
      masked: false,
      initial: add.draft.models.join(', '),
      onAnswer: value => {
        this.removeQuestion(question)
        if (value !== undefined) this.updateAddModels(parseModelIds(value))
      },
    })
    this.setQuestion(question)
    this.requestRender()
  }

  private updateAddModels(models: readonly string[]): void {
    const add = this.add
    if (add === undefined) return
    this.add = { ...add, draft: { ...add.draft, models }, error: undefined }
    this.requestRender()
  }

  private reviewAdd(): void {
    const add = this.add
    if (add === undefined) return
    const route = add.draft.route.trim().toLowerCase()
    if (!ROUTE_PATTERN.test(route)) {
      this.add = { ...add, error: 'invalid route — lowercase letters, digits and dashes only, no leading digit' }
      this.requestRender()
      return
    }
    if (add.draft.baseURL.trim() === '') {
      this.add = { ...add, error: 'base URL is required for a hand-declared provider route' }
      this.requestRender()
      return
    }
    if (add.draft.models.length === 0) {
      this.add = { ...add, error: 'at least one model id is required' }
      this.requestRender()
      return
    }
    this.add = { ...add, step: 'review', error: undefined }
    this.view = { kind: 'review' }
    this.cursor = 0
    this.requestRender()
  }

  private createProvider(): void {
    const add = this.add
    if (add === undefined || add.step !== 'review' || add.result !== undefined || add.creating === true) return
    const serial = this.addSerial
    this.add = { ...add, creating: true }
    this.requestRender()
    this.source.run('models add provider', async () => {
      let outcome: CreateProviderOutcome
      try {
        outcome = await this.source.createProvider({
          route: add.draft.route,
          api: add.draft.api,
          baseURL: add.draft.baseURL,
          displayName: add.draft.displayName,
          models: add.draft.models,
          apiKey: add.draft.key,
        })
      } catch (error) {
        outcome = { kind: 'rejected', text: `could not add provider: ${errorText(error)}` }
      }
      this.settle(() => {
        if (serial !== this.addSerial) return
        const current = this.add
        if (current === undefined) return
        // The key draft dies with its single dispatch: a failed/partial write is
        // never retried with a cached secret.
        this.add = { ...current, creating: false, result: outcome, draft: { ...current.draft, key: '' } }
        if (outcome.kind === 'created' || outcome.kind === 'profile-written-key-failed') {
          this.providerRows = this.source.rows()
          // A persisted profile is a real new Provider row even when its key
          // write failed; refresh its authority without changing the partial
          // outcome copy.
          this.refresh()
        }
      })
    })
  }

  // ── provider authorization ──────────────────────────────────────────────

  private startAuthorization(row: ModelsProviderRow): void {
    if (row.kind !== 'authorization' || row.key === undefined || row.inFlight) return
    if (this.auth?.phase === 'starting' || this.auth?.phase === 'running') {
      this.notice = 'another provider sign-in is in progress — cancel it before starting a new one'
      this.requestRender()
      return
    }
    if (row.methods.length > 1) {
      this.picker = {
        token: {},
        header: `Sign in method · ${row.label}`,
        items: row.methods.map(method => ({ value: method.id, label: method.label })),
        index: 0,
        onSelect: method => {
          this.picker = undefined
          this.beginAuthorization(row, method)
        },
        onCancel: () => { this.picker = undefined; this.requestRender() },
      }
      this.requestRender()
      return
    }
    this.beginAuthorization(row, row.methods[0]?.id)
  }

  private beginAuthorization(row: ModelsProviderRow, method: string | undefined): void {
    if (row.key === undefined) return
    this.cancelledAttempt = undefined
    this.auth = { targetIdentity: row.identity, phase: 'starting' }
    this.authNotice = undefined
    this.authUnsubscribe?.()
    const flow = createAuthorizationFlow(this.authorizationSurface(), {
      respond: (attemptId, promptId, answer) => this.source.respondAuthorization(attemptId, promptId, answer),
      cancel: attemptId => this.source.cancelAuthorization(attemptId),
    })
    const off = this.source.authorizationEvents(flow.onEvent)
    this.authUnsubscribe = off
    this.source.run('models provider sign-in', async () => {
      try {
        let started: Awaited<ReturnType<ModelsWorkspaceSource['beginAuthorization']>>
        try {
          started = await this.source.beginAuthorization(row.key!, method, this.pageController.signal)
        } catch (error) {
          this.settle(() => {
            this.auth = {
              targetIdentity: row.identity,
              phase: 'failed',
              status: authorizationFailureText(error, errorText(error)),
            }
            if (this.pendingAfterAuth !== undefined) this.runPendingAfterAuth()
          })
          return
        }
        if (started.kind !== 'started') {
          this.settle(() => {
            this.auth = { targetIdentity: row.identity, phase: 'failed', status: 'authorization service unavailable' }
            if (this.pendingAfterAuth !== undefined) this.runPendingAfterAuth()
          })
          return
        }
      flow.bind(started.attemptId)
      this.settle(() => {
        if (this.auth !== undefined) this.auth = { ...this.auth, phase: 'running', attemptId: started.attemptId }
      })
      if (this.pendingAfterAuth !== undefined || this.auth?.cancelRequested === true) this.cancelAuthorization()
      const outcome = await flow.outcome
      if (outcome.status === 'authorized') {
        const note = await this.source.provisionKeylessProfile(row.route)
        this.settle(() => {
          this.auth = { targetIdentity: row.identity, phase: 'authorized', attemptId: started.attemptId, status: `signed in to ${row.label}${note}` }
          this.refresh()
          if (this.pendingAfterAuth !== undefined) this.runPendingAfterAuth()
        })
      } else if (outcome.status === 'cancelled') {
        this.settle(() => {
          this.auth = { targetIdentity: row.identity, phase: 'cancelled', attemptId: started.attemptId, status: 'sign-in cancelled' }
          if (this.pendingAfterAuth !== undefined) this.runPendingAfterAuth()
        })
      } else {
        this.settle(() => {
          this.auth = {
            targetIdentity: row.identity,
            phase: 'failed',
            attemptId: started.attemptId,
            status: `sign-in failed${outcome.code === undefined ? '' : ` (${outcome.code})`}: ${authorizationFailureText({ code: outcome.code }, outcome.message ?? 'login failed')}`,
          }
          if (this.pendingAfterAuth !== undefined) this.runPendingAfterAuth()
        })
      }
      } finally {
        off()
        if (this.authUnsubscribe === off) this.authUnsubscribe = undefined
      }
    })
  }

  /** ONE policy for every in-page navigation that would leave the Provider
   *  detail while a native attempt is starting/running: cancel the exact Host
   *  attempt and run the intended navigation only after its settlement. */
  private deferProviderNavigation(run: () => void): void {
    if (this.disposed) return
    if (this.auth?.phase !== 'starting' && this.auth?.phase !== 'running') {
      run()
      return
    }
    this.pendingAfterAuth = run
    this.cancelAuthorization()
  }

  private runPendingAfterAuth(): void {
    const run = this.pendingAfterAuth
    this.pendingAfterAuth = undefined
    if (this.disposed) return
    this.auth = undefined
    this.authNotice = undefined
    run?.()
  }

  private finishAuthorization(): void {
    this.authUnsubscribe?.()
    this.authUnsubscribe = undefined
  }

  private cancelAuthorization(): void {
    const auth = this.auth
    if (auth === undefined || (auth.phase !== 'starting' && auth.phase !== 'running')) return
    if (auth.cancelRequested !== true) {
      this.auth = {
        ...auth,
        cancelRequested: true,
        status: 'cancellation requested — the Host may still complete the sign-in',
      }
      this.requestRender()
    }
    const attemptId = auth.attemptId
    if (attemptId === undefined || this.cancelledAttempt === attemptId) return
    this.cancelledAttempt = attemptId
    this.source.run('models cancel sign-in', async () => {
      try {
        await this.source.cancelAuthorization(attemptId)
      } catch (error) {
        this.settle(() => {
          this.notice = `cancel failed: ${errorText(error)}`
          if (this.auth !== undefined) this.auth = { ...this.auth, cancelRequested: false, status: 'cancel request failed — the sign-in may still be running' }
          this.cancelledAttempt = undefined
        })
      }
    })
  }

  /** The page-local authorization surface. `createAuthorizationFlow` owns the
   * attempt state machine; this adapter only presents its notice and prompts. */
  private authorizationSurface(): Parameters<typeof createAuthorizationFlow>[0] {
    return {
      openOutputViewer: options => this.showNotice({ message: options.refresh() }),
      showNotice: notice => this.showNotice(notice),
      updateNotice: notice => this.updateNotice(notice),
      askQuestions: (questions, signal) => this.askPageQuestion(questions[0], signal),
      openPicker: (items, onSelect, onCancel, options) => this.openPagePicker(
        options?.header ?? 'Sign in',
        items,
        onSelect,
        onCancel,
      ),
    }
  }

  private showNotice(notice: NoticeState): () => void {
    if (this.disposed) return () => {}
    const token = {}
    this.noticeToken = token
    this.settle(() => { this.authNotice = notice })
    return () => {
      if (this.noticeToken !== token) return
      this.noticeToken = undefined
      this.settle(() => { this.authNotice = undefined })
    }
  }

  private noticeToken: object | undefined

  private updateNotice(notice: NoticeState): void {
    if (this.disposed) return
    this.settle(() => { this.authNotice = notice })
  }

  private askPageQuestion(
    question: { readonly id: string; readonly question: string; readonly placeholder?: string; readonly masked?: boolean } | undefined,
    signal: AbortSignal | undefined,
  ): Promise<readonly { readonly id: string; readonly selected: string[]; readonly custom?: string }[]> {
    if (question === undefined) return Promise.resolve([])
    if (this.disposed) return Promise.reject(new Error('the authorization page was closed'))
    return new Promise((resolve, reject) => {
      let settled = false
      let embedded: EmbeddedQuestion | undefined
      const answer = (custom: string | undefined): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (embedded !== undefined) this.removeQuestion(embedded)
        resolve([{ id: question.id, selected: [], ...(custom === undefined ? {} : { custom }) }])
        this.requestRender()
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        if (embedded !== undefined) this.removeQuestion(embedded)
        reject(new Error('authorization prompt withdrawn'))
        this.requestRender()
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      embedded = this.createQuestion({
        header: 'Sign in',
        question: question.question,
        masked: question.masked === true,
        ...(question.placeholder === undefined ? {} : { placeholder: question.placeholder }),
        onAnswer: answer,
      })
      this.setQuestion(embedded)
      this.requestRender()
    })
  }

  private openPagePicker(
    header: string,
    items: readonly { readonly value: string; readonly label?: string; readonly description?: string }[],
    onSelect: (value: string) => void,
    onCancel: () => void,
  ): { close?: () => void } {
    if (this.disposed) return {}
    const picker: PickerState = {
      token: {},
      header,
      items: items.map(item => ({
        value: item.value,
        label: item.label ?? item.value,
        ...(item.description === undefined ? {} : { description: item.description }),
      })),
      index: 0,
      onSelect,
      onCancel,
    }
    this.setPicker(picker)
    return { close: () => { this.removePicker(picker) } }
  }

  // ── embedded question ───────────────────────────────────────────────────

  private createQuestion(options: {
    readonly header: string
    readonly question: string
    readonly masked: boolean
    readonly initial?: string
    readonly placeholder?: string
    readonly allowEmpty?: boolean
    readonly onAnswer: (value: string | undefined) => void
  }): EmbeddedQuestion {
    let settled = false
    const flow = new QuestionFlow(
      [{ id: 'answer', question: options.question, header: options.header, masked: options.masked }],
      answers => {
        if (settled) return
        settled = true
        const value = answers[0]?.custom ?? ''
        if (value.trim() === '' && options.allowEmpty !== true) {
          options.onAnswer(undefined)
          return
        }
        options.onAnswer(value)
      },
      () => {
        if (settled) return
        settled = true
        options.onAnswer(undefined)
      },
    )
    flow.focused = true
    if (options.initial !== undefined && options.initial !== '' && options.masked !== true) {
      for (const character of options.initial) flow.handleInput(character)
    }
    return { token: {}, flow }
  }

  private setQuestion(question: EmbeddedQuestion): void {
    if (this.question === undefined) {
      this.question = question
      this.questionUsable = false
    } else this.questionQueue.push(question)
    this.question.flow.focused = true
    this.revision += 1
  }

  /** Retire EXACTLY one prompt's UI. A withdrawn older prompt can never close a
   * newer prompt that now owns the single visible question slot. */
  private removeQuestion(question: EmbeddedQuestion): void {
    this.questionPress = undefined
    if (this.question === question) {
      this.question = this.questionQueue.shift()
      if (this.question !== undefined) {
        this.question.flow.focused = true
        this.questionUsable = false
      }
    } else {
      const index = this.questionQueue.indexOf(question)
      if (index >= 0) this.questionQueue.splice(index, 1)
    }
    this.revision += 1
    this.requestRender()
  }

  private clearQuestions(): void {
    this.question = undefined
    this.questionQueue.length = 0
    this.questionPress = undefined
  }

  // ── rendering ────────────────────────────────────────────────────────────

  /** The Settings root sets the live body height before each render. */
  setBodyHeight(rows: number): void {
    const next = Math.max(1, rows)
    // A resize invalidates the last painted form budget BEFORE the resize
    // frame: Enter arriving in that gap must not submit a clipped form.
    if (next !== this.bodyHeight && this.question !== undefined) this.questionUsable = false
    this.bodyHeight = next
  }

  render(width: number): string[] {
    if (this.disposed) return []
    this.lastWidth = width
    this.lastHeight = this.bodyHeight
    const height = Math.max(1, this.bodyHeight)
    const lines: string[] = []
    const targets: HitTarget[] = []
    if (this.question !== undefined) {
      const notice = this.renderAuthNotice(width)
      const questionRows = Math.max(1, height - 1 - notice.length)
      const usable = questionRows >= 8
      this.questionUsable = usable
      this.question.flow.setMaxRows(Math.max(8, questionRows))
      lines.push(...notice.map(line => fit(line, width)))
      this.questionTop = lines.length
      this.questionRows = usable ? questionRows : 0
      if (usable) {
        lines.push(...this.question.flow.render(width).slice(0, questionRows).map(line => fit(line, width)))
      } else {
        lines.push(color.warning('Resize the terminal: the full form and its confirm hint need at least 8 rows. Enter is disabled.'))
      }
      lines.push(color.textMuted(renderActionBarRow([
        { text: 'type to edit', priority: 5 },
        { text: usable ? 'Enter continue' : 'Enter disabled', priority: 6 },
        { text: 'Esc back', priority: 8 },
      ], width)))
      this.paintedCopy = false
      this.copyValue = undefined
      this.paintedTargets = []
      return this.pad(lines, height, width)
    }
    if (this.modelPicker !== undefined) {
      const notice = this.renderAuthNotice(width)
      const required = notice.length + 2
      this.pickerUsable = required <= height
      if (!this.pickerUsable) {
        lines.push(color.warning(`Resize the terminal: the authorization notice, model choices and actions need ${required} rows.`))
        lines.push(color.textMuted(renderActionBarRow([{ text: 'Esc cancel', priority: 8 }], width)))
        this.paintedCopy = false
        this.paintedTargets = []
        return this.pad(lines, height, width)
      }
      lines.push(...notice.map(line => fit(line, width)))
      const pickerRows = Math.max(1, height - 1 - notice.length)
      const targetStart = targets.length
      lines.push(...this.renderModelPicker(width, pickerRows, targets))
      for (let index = targetStart; index < targets.length; index += 1) {
        const target = targets[index]!
        targets[index] = { ...target, row: target.row + notice.length }
      }
      lines.push(color.textMuted(renderActionBarRow([
        { text: 'Space toggle', priority: 5 },
        { text: 'Enter apply', priority: 6 },
        { text: 'm manual', priority: 4 },
        { text: 'Esc cancel', priority: 8 },
      ], width)))
      this.paintedCopy = false
      this.paintedTargets = targets
      return this.pad(lines, height, width)
    }
    if (this.picker !== undefined) {
      const notice = this.renderAuthNotice(width)
      const required = notice.length + 2
      this.pickerUsable = required <= height
      if (!this.pickerUsable) {
        lines.push(color.warning(`Resize the terminal: the authorization notice, sign-in choices and actions need ${required} rows.`))
        lines.push(color.textMuted(renderActionBarRow([{ text: 'Esc cancel', priority: 8 }], width)))
        this.paintedCopy = false
        this.paintedTargets = []
        return this.pad(lines, height, width)
      }
      lines.push(...notice.map(line => fit(line, width)))
      const targetStart = targets.length
      lines.push(...this.renderPicker(width, Math.max(1, height - 1 - notice.length), targets))
      for (let index = targetStart; index < targets.length; index += 1) {
        const target = targets[index]!
        targets[index] = { ...target, row: target.row + notice.length }
      }
      lines.push(color.textMuted(renderActionBarRow([
        { text: 'Up/Down choose', priority: 5 },
        { text: 'Enter select', priority: 6 },
        { text: 'Esc cancel', priority: 8 },
      ], width)))
      this.paintedCopy = false
      this.paintedTargets = targets
      return this.pad(lines, height, width)
    }
    const projection = this.project(width)
    const rowCount = this.rowOrder.length
    if (projection.actions.length >= height) {
      this.paintedRowIds.clear()
      this.paintedActionIds.clear()
      this.paintedCopy = false
      this.paintedTargets = []
      return this.pad([fit(color.warning('Resize the terminal to show the page actions.'), width)], height, width)
    }
    this.paintedRowIds.clear()
    this.paintedActionIds.clear()
    const actionLines = projection.actions.map((action, index) => this.paintAction(action, rowCount + index))
    const contentRows = Math.max(0, height - 1 - actionLines.length)
    if (this.followCursor && this.cursor < rowCount && contentRows > 0) {
      const selectedId = this.rowOrder[this.cursor]
      for (const [contentRow, id] of this.rowIds) {
        if (id !== selectedId) continue
        if (contentRow < this.scroll) this.scroll = contentRow
        else if (contentRow >= this.scroll + contentRows) this.scroll = contentRow - contentRows + 1
        break
      }
    }
    this.followCursor = false
    this.scroll = Math.min(this.scroll, Math.max(0, projection.content.length - contentRows))
    for (let index = 0; index < contentRows; index += 1) {
      const lineIndex = this.scroll + index
      const content = projection.content[lineIndex]
      if (content === undefined) break
      lines.push(fit(content, width))
      const target = this.rowTargetOf(content, lineIndex)
      if (target !== undefined) {
        targets.push({ ...target, row: lines.length - 1 })
        this.paintedRowIds.add(target.id)
      }
    }
    while (lines.length < height - 1 - actionLines.length) lines.push(fit('', width))
    lines.push(...actionLines.map(line => fit(line, width)))
    for (const [index, action] of projection.actions.entries()) {
      targets.push({
        kind: 'action',
        id: action.id,
        row: height - 1 - actionLines.length + index,
        startCol: 0,
        endCol: width,
      })
      if (action.enabled) this.paintedActionIds.add(action.id)
    }
    lines.push(this.actionBar(width, projection.actions))
    this.paintedTargets = targets
    return this.pad(lines, height, width)
  }

  private pad(lines: string[], height: number, width: number): string[] {
    const out = lines.slice(0, height)
    while (out.length < height) out.push(fit('', width))
    return out
  }

  /** The row projection of the active view. Content rows carry an optional
   * target id in `rowTargets`; actions are always painted last. */
  private rowIds = new Map<number, string>()
  private rowTargets = new Map<number, HitTarget>()
  private readonly rowOrder: string[] = []
  private readonly paintedRowIds = new Set<string>()
  private readonly paintedActionIds = new Set<string>()

  private rowTargetOf(_content: string, index: number): HitTarget | undefined {
    const id = this.rowIds.get(index)
    const target = this.rowTargets.get(index)
    return id === undefined || target === undefined ? undefined : target
  }

  private project(width: number): Projection {
    this.rowIds.clear()
    this.rowTargets.clear()
    this.rowOrder.length = 0
    this.copyValue = undefined
    if (!this.source.available) {
      return {
        content: [
          color.textStrong(TITLE),
          '',
          color.error('The Host settings/credential authority is unavailable on this backend.'),
          '',
          color.textDim('No provider or credential can be read or changed here.'),
        ],
        actions: [
          { id: 'page:back', label: '← Back', enabled: true },
        ],
      }
    }
    switch (this.view.kind) {
      case 'list': return this.projectList(width)
      case 'provider': return this.projectProvider(width)
      case 'reference': return this.projectReference(width)
      case 'add-provider': return this.projectAddProvider(width)
      case 'review': return this.projectReview(width)
      case 'records': return this.projectRecords(width)
      case 'logout-list': return this.projectRecords(width)
      case 'logout': return this.projectClear(width)
      case 'guide': return this.projectGuide(width)
    }
  }

  private addRow(content: string[], text: string, id: string, width: number, kind: 'row' | 'action' = 'row'): void {
    const row = content.length
    content.push(text)
    this.rowIds.set(row, id)
    this.rowOrder.push(id)
    this.rowTargets.set(row, { kind, id, row, startCol: 0, endCol: width })
  }

  private projectList(width: number): Projection {
    const content: string[] = [color.textStrong(TITLE), '']
    const accountState = sanitizedPhysicalLine(!this.account.available
      ? 'Unavailable'
      : this.account.failure !== undefined
        ? `Unavailable · ${this.account.failure}`
        : this.account.status === 'credential-stored' ? 'Signed in' : this.account.status === 'signed-out' ? 'Signed out' : 'Loading…')
    const accountTone = accountState === 'Signed in' ? 'success' : accountState === 'Signed out' ? 'muted' : 'warning'
    this.addRow(content, this.selectionLine(0, 'DeepSeek Account', accountState, accountTone, width), 'account', width)
    let interactive = 1
    for (const row of this.providerRows) {
      const state = this.credentialStateOf(row)
      const painted = credentialWord(state)
      const text = this.selectionLine(interactive, row.label, painted.word, painted.tone, width)
      this.addRow(content, text, `provider:${row.identity}`, width)
      interactive += 1
    }
    const actions: ActionLine[] = [
      { id: 'list:add', label: 'Add Provider…', enabled: true },
      { id: 'list:records', label: 'Credential records', enabled: true },
      { id: 'list:guide', label: 'Guide: edit complex model config manually', enabled: true },
    ]
    if (this.initializing) content.push(color.textMuted('Reading Host credentials…'))
    if (this.notice !== undefined) content.push(color.warning(this.notice))
    this.copyValue = undefined
    return { content, actions }
  }

  private selectionLine(index: number, label: string, value: string, tone: 'success' | 'warning' | 'muted', width: number): string {
    const selected = index === this.cursor
    const cursor = selected ? color.primary('> ') : '  '
    const painted = sanitizedPhysicalLine(label)
    const valueText = paintState(sanitizedPhysicalLine(value), tone)
    const room = Math.max(1, width - 2 - visibleWidth(painted) - visibleWidth(value) - 1)
    return `${cursor}${selected ? color.textStrong(painted) : color.text(painted)}${' '.repeat(room)}${valueText}`
  }

  private credentialStateOf(row: ModelsProviderRow): ModelsCredentialState {
    if (row.kind === 'reference' && row.ref !== undefined) {
      return this.credentialStates.get(row.ref) ?? { kind: 'pending' }
    }
    if (row.kind === 'authorization') {
      const records = this.records
      if (records === undefined) return { kind: 'pending' }
      if (records.recordCleanupUnavailable) return { kind: 'unknown', reason: 'this backend cannot enumerate stored records' }
      return { kind: 'known', configured: records.rows.some(entry => entry.kind === 'record' && entry.key === row.key) }
    }
    return { kind: 'known', configured: row.configured }
  }

  private projectProvider(width: number): Projection {
    const view = this.view
    if (view.kind !== 'provider') return { content: [], actions: [] }
    const row = this.providerRows.find(candidate => candidate.identity === view.identity)
    if (row === undefined) {
      return { content: [color.error(`provider entry ${view.identity} is no longer available`), '', color.textMuted('Esc goes back.')], actions: [] }
    }
    const content: string[] = [color.textStrong(`Provider · ${sanitizedPhysicalLine(row.label)}`), '']
    content.push(...this.fact('Route', row.route, width))
    content.push(...this.fact('Profile', row.profile.configured ? 'configured' : 'not configured', width))
    content.push(...this.fact('API protocol', row.profile.api ?? 'unknown', width))
    content.push(...this.fact('Endpoint', row.profile.baseURL ?? 'unknown', width))
    content.push(...this.fact('Models', row.profile.models.length === 0 ? 'none listed' : row.profile.models.join(', '), width))
    content.push(...this.fact('Auth kind', row.kind === 'authorization' ? 'provider-native authorization' : 'API key reference', width))
    const state = this.credentialStateOf(row)
    content.push(...this.fact('Credential', credentialWord(state).word, width))
    content.push('', color.textDim('Credential presence only — not a connection test.'))
    if (this.auth !== undefined && this.auth.targetIdentity === row.identity) {
      content.push('', color.textStrong('Sign-in'))
      content.push(color.text(sanitizedPhysicalLine(this.auth.status ?? this.auth.phase)))
      if (this.authNotice !== undefined) {
        content.push(color.text(sanitizedPhysicalLine(this.authNotice.message)))
        if (this.authNotice.url !== undefined) {
          content.push(color.text(sanitizedPhysicalLine(this.authNotice.url)))
          this.copyValue = this.authNotice.url
        } else this.copyValue = undefined
        if (this.authNotice.code !== undefined) content.push(color.text(sanitizedPhysicalLine(`Code: ${this.authNotice.code}`)))
      } else this.copyValue = undefined
    } else this.copyValue = undefined
    if (this.notice !== undefined) content.push('', color.warning(sanitizedPhysicalLine(this.notice)))
    const actions: ActionLine[] = []
    if (row.kind === 'authorization' && row.methods.length > 0) {
      actions.push({
        id: 'provider:auth',
        label: row.inFlight ? 'Sign-in in progress' : this.auth?.targetIdentity === row.identity && this.auth.phase === 'authorized' ? 'Sign in again (provider)' : 'Sign in (provider)',
        enabled: !row.inFlight && (this.auth === undefined || this.auth.phase === 'authorized' || this.auth.phase === 'cancelled' || this.auth.phase === 'failed'),
      })
    }
    if (row.kind === 'reference' || (row.ref !== undefined && row.namesCredential)) {
      actions.push({ id: 'provider:reference', label: 'Configure API Key…', enabled: true })
    }
    const clearTarget = this.clearTargetOf(row)
    const hasStored = state.kind === 'known' ? state.configured : true
    actions.push({ id: 'provider:clear', label: hasStored ? 'Clear stored credential…' : 'Nothing stored to clear', enabled: clearTarget !== undefined && hasStored })
    actions.push({ id: 'provider:guide', label: 'View model config guide', enabled: true })
    if (this.auth?.targetIdentity === row.identity && (this.auth.phase === 'running' || this.auth.phase === 'starting')) {
      actions.push({
        id: 'provider:cancel',
        label: this.auth.cancelRequested === true ? 'Cancellation requested…' : 'Cancel current attempt',
        enabled: this.auth.cancelRequested !== true,
      })
    }
    actions.push({ id: 'provider:back', label: '← Providers', enabled: true })
    return { content, actions }
  }

  private clearTargetOf(row: ModelsProviderRow): CredentialClearTarget | undefined {
    if (row.kind === 'authorization') {
      return row.key === undefined ? undefined : { kind: 'record', key: row.key, label: row.label, ...(row.route === '' ? {} : { route: row.route }) }
    }
    if (row.ref === undefined) return undefined
    if (row.namesCredential === false && row.configured) {
      const flowKey = row.key ?? this.records?.rows.find(entry => entry.kind === 'record' && entry.route === row.route)?.key
      if (flowKey !== undefined) return { kind: 'record', key: flowKey, label: row.label, ...(row.route === '' ? {} : { route: row.route }) }
    }
    return { kind: 'reference', ref: row.ref, label: row.label, ...(row.route === '' ? {} : { route: row.route }) }
  }

  private fact(label: string, value: string, width: number): string[] {
    const bodyWidth = Math.max(1, width - LABEL_WIDTH)
    const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(value), bodyWidth)
    const parts = wrapped.length === 0 ? [''] : wrapped
    return [
      `${fit(color.textDim(sanitizedPhysicalLine(label)), LABEL_WIDTH)}${color.text(parts[0]!)}`,
      ...parts.slice(1).map(extra => `${' '.repeat(LABEL_WIDTH)}${color.text(extra)}`),
    ]
  }

  private projectReference(width: number): Projection {
    const view = this.view
    if (view.kind !== 'reference') return { content: [], actions: [] }
    const content: string[] = [color.textStrong(`API Key Reference · ${sanitizedPhysicalLine(view.label)}`), '']
    content.push(...this.fact('Reference', view.ref, width))
    content.push(...this.fact('Stored', this.referenceConfigured === undefined ? 'reading…' : this.referenceConfigured ? 'Configured' : 'Not set', width))
    if (this.referenceStatus !== undefined) content.push(...this.fact('Status', this.referenceStatus, width))
    content.push('', color.textDim('The value is written directly to the Host credential store; it is never shown, logged or written to the transcript. Verified requires the store to report the reference configured after the write.'))
    if (this.notice !== undefined) content.push('', color.warning(sanitizedPhysicalLine(this.notice)))
    this.copyValue = view.ref
    const actions: ActionLine[] = []
    if (this.referencePhase !== 'pending' && this.referencePhase !== 'editing') {
      actions.push({ id: 'reference:edit', label: 'Configure API Key…', enabled: true })
    }
    if (this.referencePhase !== 'pending') actions.push({ id: 'reference:back', label: '← Back', enabled: true })
    return { content, actions }
  }

  private projectAddProvider(width: number): Projection {
    const add = this.add
    if (add === undefined) return { content: [], actions: [] }
    const content: string[] = [color.textStrong('Add Provider'), '', color.textDim('Draft only — nothing is persisted until Review → Create.')]
    for (const [index, field] of ADD_FIELDS.entries()) {
      const selected = index === this.cursor
      const raw = field.id === 'models'
        ? add.draft.models.length === 0 ? '—' : add.draft.models.join(', ')
        : field.id === 'key'
          ? add.draft.key === '' ? '— (provider-native auth)' : '••••••'
          : add.draft[field.id]
      this.addRow(
        content,
        `${selected ? color.primary('> ') : '  '}${selected ? color.textStrong(field.label) : color.text(field.label)}: ${color.textDim(raw === '' ? '—' : sanitizedPhysicalLine(raw))}`,
        `add-field:${field.id}`,
        width,
      )
    }
    if (add.discovering) content.push('', color.textMuted('Probing the endpoint for models…'))
    if (add.discoveryNote !== undefined) content.push(color.textDim(add.discoveryNote))
    if (add.error !== undefined) content.push('', color.error(sanitizedPhysicalLine(add.error)))
    if (add.result !== undefined) {
      content.push('', add.result.kind === 'created' ? color.success(sanitizedPhysicalLine(add.result.text)) : color.error(sanitizedPhysicalLine(add.result.text)))
    }
    this.copyValue = undefined
    const actions: ActionLine[] = add.result !== undefined
      ? [{ id: 'add:done', label: '← Back to providers', enabled: true }]
      : [
          { id: 'add:review', label: 'Review & create', enabled: !add.discovering },
          { id: 'add:cancel', label: 'Cancel', enabled: true },
        ]
    return { content, actions }
  }

  private projectReview(width: number): Projection {
    const add = this.add
    if (add === undefined) return { content: [], actions: [] }
    const content: string[] = [color.textStrong('Review provider'), '']
    content.push(...this.fact('Route', add.draft.route, width))
    content.push(...this.fact('Protocol', add.draft.api, width))
    content.push(...this.fact('Base URL', add.draft.baseURL, width))
    content.push(...this.fact('Display name', add.draft.displayName === '' ? add.draft.route : add.draft.displayName, width))
    content.push(...this.fact('Models', add.draft.models.join(', '), width))
    content.push(...this.fact('API key', add.draft.key === '' ? 'not stored (provider-native authentication)' : 'will be stored in the credential store', width))
    content.push('', color.textDim('Create persists the provider profile; a stored key is a separate Host write whose failure is reported separately.'))
    if (add.result !== undefined) content.push('', add.result.kind === 'created' ? color.success(sanitizedPhysicalLine(add.result.text)) : color.error(sanitizedPhysicalLine(add.result.text)))
    if (add.creating === true && add.result === undefined) {
      content.push('', color.textMuted('Creating — one Host write at a time; Esc reports the in-flight write instead of leaving. The dispatched write is not retried.'))
    }
    if (this.notice !== undefined) content.push('', color.warning(sanitizedPhysicalLine(this.notice)))
    this.copyValue = undefined
    if (add.result !== undefined) {
      return { content, actions: [{ id: 'review:done', label: '← Back to providers', enabled: true }] }
    }
    if (add.creating === true) return { content, actions: [] }
    return {
      content,
      actions: [
        { id: 'review:create', label: 'Create', enabled: true },
        { id: 'review:back', label: 'Back to edit', enabled: true },
      ],
    }
  }

  private projectRecords(width: number): Projection {
    const content: string[] = [color.textStrong('Stored credentials'), '']
    const records = this.records
    if (records === undefined) {
      if (this.recordsError !== undefined) {
        content.push(color.error(`the stored credentials could not be read: ${sanitizedPhysicalLine(this.recordsError)}`))
        content.push(color.textMuted('Press r to retry.'))
      } else {
        content.push(color.textMuted('Reading the credential store…'))
      }
      return { content, actions: [{ id: 'records:back', label: '← Back', enabled: true }] }
    }
    if (records.recordCleanupUnavailable) content.push(color.warning('Stored credential records cannot be enumerated or removed on this backend.'))
    for (const failure of records.referenceReadFailures) content.push(color.warning(`Reference read failed: ${sanitizedPhysicalLine(failure)}`))
    if (records.rows.length === 0) {
      content.push(color.textMuted('Nothing to sign out.'))
      return { content, actions: [{ id: 'records:back', label: '← Back', enabled: true }] }
    }
    for (const [index, row] of records.rows.entries()) {
      const kind = row.kind === 'reference' ? 'API key' : 'stored record'
      const suffix = row.source === undefined ? '' : ` · source: ${sanitizedPhysicalLine(row.source)}`
      const hint = row.kindHint === undefined ? '' : ` (${sanitizedPhysicalLine(row.kindHint)})`
      this.addRow(
        content,
        `${index === this.cursor ? color.primary('> ') : '  '}${color.text(sanitizedPhysicalLine(row.label))}${color.textMuted(` — ${kind}${hint} · ${sanitizedPhysicalLine(row.key)}${suffix}`)}`,
        `stored:${row.kind}:${row.key}`,
        width,
      )
    }
    this.copyValue = undefined
    return { content, actions: [{ id: 'records:back', label: '← Back', enabled: true }] }
  }

  private projectClear(width: number): Projection {
    const view = this.view
    const clear = this.clear
    if (view.kind !== 'logout' || clear === undefined) return { content: [], actions: [] }
    const content: string[] = [color.textStrong('Clear stored credential'), '']
    if (view.target.kind === 'reference') {
      content.push(...this.fact('API key reference', view.target.ref, width))
      content.push(...this.fact('Provider', view.target.route ?? view.target.label, width))
    } else {
      content.push(...this.fact('Stored record', view.target.key, width))
      content.push(...this.fact('Provider', view.target.route ?? view.target.label, width))
    }
    content.push('')
    if (clear.phase === 'reading') content.push(color.textMuted('Reading the credential store…'))
    else if (clear.phase === 'failed') content.push(color.error(`Not cleared: ${sanitizedPhysicalLine(clear.reason ?? 'the clear could not be verified')}`))
    else if (clear.phase === 'pending') content.push(color.textMuted('Clearing — the Host has not confirmed yet.'))
    else if (clear.phase === 'done') content.push(color.success(sanitizedPhysicalLine(clear.result ?? 'cleared')))
    else if (!clear.configured) content.push(color.textMuted('Nothing stored for this target — nothing will be cleared.'))
    else content.push(color.warning('This removes the locally stored credential. The current model is not switched.'))
    if (this.notice !== undefined) content.push('', color.warning(sanitizedPhysicalLine(this.notice)))
    this.copyValue = undefined
    const actions: ActionLine[] = []
    if (clear.phase === 'ready' && clear.configured) actions.push({ id: 'clear:confirm', label: 'Clear credential', enabled: true })
    if (clear.phase !== 'pending') actions.push({ id: 'clear:back', label: '← Back', enabled: true })
    return { content, actions }
  }

  private projectGuide(width: number): Projection {
    const guide = this.source.configGuide()
    const content: string[] = [color.textStrong('Model configuration guide'), '']
    content.push(color.text('Complex model options are edited manually in the profile patch file; this UI does not rewrite them.'))
    content.push('')
    content.push(...this.fact('Profile patch', guide.profilePatchPath ?? 'unavailable — this composition has no profile patch file', width))
    content.push('')
    content.push(color.textDim('Fields inside llm-pi-ai.providers.<route>: api, baseURL, displayName, models, apiKeyEnv. Keep the YAML valid; changes apply on the next launch. The credential store remains the only owner of key values.'))
    this.copyValue = guide.profilePatchPath
    return { content, actions: [{ id: 'guide:back', label: '← Back', enabled: true }] }
  }

  /** The persistent authorization notice above an in-page prompt/picker: the
   * message and the browser URL/code must stay visible while the human acts. */
  private renderAuthNotice(width: number): string[] {
    const notice = this.authNotice
    if (notice === undefined) return []
    const lines = [color.text(sanitizedPhysicalLine(notice.message))]
    if (notice.url !== undefined) lines.push(color.text(sanitizedPhysicalLine(notice.url)))
    if (notice.code !== undefined) lines.push(color.text(sanitizedPhysicalLine(`Code: ${notice.code}`)))
    return lines.slice(0, 4).map(line => fit(line, width))
  }

  /** The endpoint-discovered model list: a true multi-select page-local list.
   * Manual ids remain one keystroke away. */
  private renderModelPicker(width: number, rows: number, targets: HitTarget[]): string[] {
    const picker = this.modelPicker
    if (picker === undefined) return []
    const cappedRows = Math.max(1, rows)
    const heading = cappedRows >= 4 ? [color.textStrong('Models advertised by the endpoint'), ''] : []
    const viewport = Math.max(1, cappedRows - heading.length - 1)
    const offset = Math.min(Math.max(0, picker.index - viewport + 1), Math.max(0, picker.items.length + 1 - viewport))
    const lines: { text: string; id: string }[] = picker.items.map((model, index) => ({
      id: `model-picker:${index}`,
      text: `${index === picker.index ? color.primary('> ') : '  '}${picker.selected.has(model.id) ? '[x]' : '[ ]'} ${index === picker.index ? color.textStrong(sanitizedPhysicalLine(model.id)) : color.text(sanitizedPhysicalLine(model.id))}`,
    }))
    lines.push({
      id: 'model-picker:manual',
      text: `${picker.index === picker.items.length ? color.primary('> ') : '  '}${color.text('Enter ids by hand…')}`,
    })
    const content: string[] = [...heading]
    for (const [index, line] of lines.entries()) {
      if (index < offset || index >= offset + viewport) continue
      content.push(line.text)
      targets.push({ kind: 'model-picker', id: line.id, row: content.length - 1, startCol: 0, endCol: width })
    }
    return content.slice(0, cappedRows)
  }

  private renderPicker(width: number, rows: number, targets: HitTarget[]): string[] {
    const picker = this.picker
    if (picker === undefined) return []
    const cappedRows = Math.max(1, rows)
    // A 1-2 row budget keeps the SELECTED row visible instead of spending both
    // rows on the header; the action bar outside this method still owns the
    // final hint row.
    const heading = cappedRows >= 3 ? [color.textStrong(sanitizedPhysicalLine(picker.header)), ''] : []
    const viewport = Math.max(1, cappedRows - heading.length)
    const offset = Math.min(Math.max(0, picker.index - viewport + 1), Math.max(0, picker.items.length - viewport))
    const content: string[] = [...heading]
    for (const [index, item] of picker.items.entries()) {
      if (index < offset || index >= offset + viewport) continue
      const selected = index === picker.index
      content.push(`${selected ? color.primary('> ') : '  '}${selected ? color.textStrong(sanitizedPhysicalLine(item.label)) : color.text(sanitizedPhysicalLine(item.label))}${item.description === undefined ? '' : color.textDim(` — ${sanitizedPhysicalLine(item.description)}`)}`)
      targets.push({ kind: 'picker', id: String(index), row: content.length - 1, startCol: 0, endCol: width })
    }
    return content.slice(0, cappedRows)
  }

  private paintAction(action: ActionLine, index: number): string {
    const selected = index === this.cursor
    if (!action.enabled) return `  ${color.textMuted(action.label)}`
    return `${selected ? color.primary('> ') : '  '}${selected ? color.textStrong(action.label) : color.text(action.label)}`
  }

  private actionBar(width: number, actions: readonly ActionLine[]): string {
    const segments: ActionBarSegment[] = []
    if (this.copyValue !== undefined) segments.push({ text: 'c copy', priority: 3 })
    if (actions.length > 0) segments.push({ text: 'Up/Down select', priority: 5 }, { text: 'Enter select', priority: 6 })
    if (this.view.kind === 'list' || this.view.kind === 'records' || this.view.kind === 'logout-list') {
      segments.unshift({ text: 'r refresh', priority: 2 })
    }
    segments.push({ text: 'Esc back', priority: 8 })
    const rendered = renderActionBarRow(segments, width)
    this.paintedCopy = rendered.includes('c copy')
    return color.textMuted(rendered)
  }

  // ── input ────────────────────────────────────────────────────────────────

  /** Re-evaluate the live form budget from the CURRENT notice and body height,
   *  not the last painted frame: an authNotice can gain URL/code lines without
   *  changing the terminal height. */
  private questionFits(): boolean {
    if (!this.questionUsable) return false
    const noticeLines = this.renderAuthNotice(this.lastWidth).length
    return Math.max(1, this.bodyHeight - 1 - noticeLines) >= 8
  }

  handleInput(data: string): ModelsPageExit {
    if (this.disposed) return 'handled'
    if (this.question !== undefined) {
      if (!this.questionFits()) {
        if (matchesKey(data, 'escape')) this.question.flow.handleInput(data)
        else {
          this.notice = 'resize the terminal to show the full form before submitting'
          this.requestRender()
        }
        return 'handled'
      }
      this.question.flow.handleInput(data)
      return 'handled'
    }
    if (this.modelPicker !== undefined) {
      this.handleModelPickerInput(data)
      return 'handled'
    }
    if (this.picker !== undefined) {
      this.handlePickerInput(data)
      return 'handled'
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) return this.back()
    if (matchesKey(data, 'up')) return this.move(-1)
    if (matchesKey(data, 'down')) return this.move(1)
    if (matchesKey(data, 'pageUp')) return this.page(-1)
    if (matchesKey(data, 'pageDown')) return this.page(1)
    if (matchesKey(data, 'home')) return this.jump(-1)
    if (matchesKey(data, 'end')) return this.jump(1)
    if (matchesKey(data, 'enter')) return this.confirm()
    if (data === 'r' || data === 'R') {
      this.refresh()
      return 'handled'
    }
    if (matchesKey(data, 'c') || matchesKey(data, Key.shift('c'))) {
      if (this.paintedCopy && this.copyValue !== undefined) this.source.copy(this.copyValue)
      return 'handled'
    }
    if (data === 'o' || data === 'O') {
      const url = this.authNotice?.url
      if (url !== undefined) this.source.openUrl(url)
      return 'handled'
    }
    return 'handled'
  }

  private handleModelPickerInput(data: string): void {
    const picker = this.modelPicker
    if (picker === undefined) return
    if (!this.pickerFits()) {
      if (matchesKey(data, 'escape')) this.modelPicker = undefined
      this.requestRender()
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace') || data === 'm' || data === 'M') {
      this.modelPicker = undefined
      if (data === 'm' || data === 'M') this.beginManualModels()
      else this.requestRender()
      return
    }
    if (matchesKey(data, 'up')) {
      this.modelPicker = { ...picker, index: Math.max(0, picker.index - 1) }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      this.modelPicker = { ...picker, index: Math.min(picker.items.length, picker.index + 1) }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'home') || matchesKey(data, 'end')) {
      this.modelPicker = { ...picker, index: matchesKey(data, 'home') ? 0 : picker.items.length }
      this.requestRender()
      return
    }
    if (data === ' ') {
      const model = picker.items[picker.index]
      if (model === undefined) return
      const selected = new Set(picker.selected)
      if (selected.has(model.id)) selected.delete(model.id)
      else selected.add(model.id)
      this.modelPicker = { ...picker, selected }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      if (picker.index >= picker.items.length) {
        this.modelPicker = undefined
        this.beginManualModels()
        return
      }
      if (picker.selected.size === 0) {
        this.notice = 'select at least one model, or press m to enter ids by hand'
        this.requestRender()
        return
      }
      this.modelPicker = undefined
      this.updateAddModels([...picker.selected])
      return
    }
  }

  private setPicker(picker: PickerState): void {
    if (this.picker === undefined) this.picker = picker
    else this.pickerQueue.push(picker)
    this.revision += 1
    this.requestRender()
  }

  /** Retire EXACTLY one select prompt. A withdrawn/answered older prompt can
   *  never clear a newer one that now owns the single visible picker slot. */
  private removePicker(picker: PickerState): void {
    const token = picker.token
    if (this.picker?.token === token) {
      this.picker = this.pickerQueue.shift()
    } else {
      const index = this.pickerQueue.findIndex(candidate => candidate.token === token)
      if (index >= 0) this.pickerQueue.splice(index, 1)
    }
    this.revision += 1
    this.requestRender()
  }

  private pickerFits(): boolean {
    if (!this.pickerUsable) return false
    return this.renderAuthNotice(this.lastWidth).length + 2 <= this.bodyHeight
  }

  private handlePickerInput(data: string): void {
    const picker = this.picker
    if (picker === undefined) return
    if (!this.pickerFits()) {
      if (matchesKey(data, 'escape')) this.picker = undefined
      this.requestRender()
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'backspace')) {
      this.removePicker(picker)
      picker.onCancel()
      return
    }
    if (matchesKey(data, 'up')) {
      this.picker = { ...picker, index: Math.max(0, picker.index - 1) }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      this.picker = { ...picker, index: Math.min(picker.items.length - 1, picker.index + 1) }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'home')) {
      this.picker = { ...picker, index: 0 }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'end')) {
      this.picker = { ...picker, index: picker.items.length - 1 }
      this.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      const item = picker.items[picker.index]
      if (item === undefined) return
      this.removePicker(picker)
      picker.onSelect(item.value)
    }
  }

  private interactiveCount(): number {
    const projection = this.project(this.lastWidth)
    return this.rowOrder.length + projection.actions.length
  }

  private move(delta: number): ModelsPageExit {
    const count = this.interactiveCount()
    this.cursor = Math.min(Math.max(0, this.cursor + delta), Math.max(0, count - 1))
    this.followCursor = true
    this.revision += 1
    this.requestRender()
    return 'handled'
  }

  private page(direction: -1 | 1): ModelsPageExit {
    const step = Math.max(1, this.lastHeight - 3)
    this.scroll = Math.max(0, this.scroll + direction * step)
    this.revision += 1
    this.requestRender()
    return 'handled'
  }

  private jump(direction: 1 | -1): ModelsPageExit {
    this.cursor = direction < 0 ? 0 : Math.max(0, this.interactiveCount() - 1)
    this.followCursor = true
    this.revision += 1
    this.requestRender()
    return 'handled'
  }

  private confirm(): ModelsPageExit {
    const projection = this.project(this.lastWidth)
    const rowCount = this.rowOrder.length
    if (this.cursor < rowCount) {
      const id = this.rowOrder[this.cursor]
      if (id === undefined || !this.paintedRowIds.has(id)) return 'handled'
      return this.activateRow(id)
    }
    const action = projection.actions[this.cursor - rowCount]
    if (action === undefined || !action.enabled || !this.paintedActionIds.has(action.id)) return 'handled'
    return this.activateAction(action.id)
  }

  private activateRow(id: string): ModelsPageExit {
    if (id === 'account') {
      this.onOpenAccount()
      return 'open-account'
    }
    if (id.startsWith('provider:')) {
      this.selectProvider(id.slice('provider:'.length))
      return 'handled'
    }
    if (id.startsWith('stored:')) {
      const [, kind, ...rest] = id.split(':')
      const key = rest.join(':')
      const row = this.records?.rows.find(candidate => candidate.key === key && candidate.kind === kind)
      if (row !== undefined) {
        this.openClear(row.kind === 'reference'
          ? { kind: 'reference', ref: row.key, label: row.label, ...(row.route === undefined ? {} : { route: row.route }) }
          : { kind: 'record', key: row.key, label: row.label, ...(row.route === undefined ? {} : { route: row.route }) })
      }
      return 'handled'
    }
    if (id.startsWith('add-field:')) {
      const index = ADD_FIELDS.findIndex(field => field.id === id.slice('add-field:'.length))
      if (index >= 0) this.editAddField(index)
      return 'handled'
    }
    if (id === 'list:add') {
      this.startAddProvider()
      return 'handled'
    }
    if (id === 'list:records') {
      this.enter({ kind: 'records' })
      return 'handled'
    }
    if (id === 'list:guide') {
      this.enter({ kind: 'guide' })
      return 'handled'
    }
    return 'handled'
  }

  private activateAction(id: string): ModelsPageExit {
    switch (id) {
      case 'list:add': this.startAddProvider(); return 'handled'
      case 'list:records': this.enter({ kind: 'records' }); return 'handled'
      case 'list:guide': this.enter({ kind: 'guide' }); return 'handled'
      case 'provider:auth': {
        const view = this.view
        if (view.kind === 'provider') {
          const row = this.providerRows.find(candidate => candidate.identity === view.identity)
          if (row !== undefined) this.startAuthorization(row)
        }
        return 'handled'
      }
      case 'provider:reference': {
        const view = this.view
        if (view.kind === 'provider') {
          const row = this.providerRows.find(candidate => candidate.identity === view.identity)
          if (row?.ref !== undefined) {
            const ref = row.ref
            const label = row.label
            this.deferProviderNavigation(() => {
              this.referenceEditor.ref = ref
              this.referenceEditor.label = label
              this.enter({ kind: 'reference', ref, label })
            })
          }
        }
        return 'handled'
      }
      case 'provider:clear': {
        const view = this.view
        if (view.kind === 'provider') {
          const row = this.providerRows.find(candidate => candidate.identity === view.identity)
          const target = row === undefined ? undefined : this.clearTargetOf(row)
          if (target !== undefined) this.deferProviderNavigation(() => this.openClear(target))
        }
        return 'handled'
      }
      case 'provider:guide': this.deferProviderNavigation(() => this.enter({ kind: 'guide' })); return 'handled'
      case 'provider:cancel': this.cancelAuthorization(); return 'handled'
      case 'provider:back': return this.back()
      case 'reference:edit': this.beginReferenceEditor(); return 'handled'
      case 'reference:back': this.enter({ kind: 'list' }); return 'handled'
      case 'add:review': this.reviewAdd(); return 'handled'
      case 'add:cancel': this.addSerial += 1; this.add = undefined; this.enter({ kind: 'list' }); return 'handled'
      case 'add:done': this.addSerial += 1; this.add = undefined; this.enter({ kind: 'list' }); return 'handled'
      case 'review:create': this.createProvider(); return 'handled'
      case 'review:back': {
        const add = this.add
        if (add !== undefined) { this.add = { ...add, step: 'form', result: undefined }; this.enter({ kind: 'add-provider' }) }
        return 'handled'
      }
      case 'review:done': this.addSerial += 1; this.add = undefined; this.enter({ kind: 'list' }); return 'handled'
      case 'records:back': this.enter({ kind: 'list' }); return 'handled'
      case 'clear:confirm': this.confirmClear(); return 'handled'
      case 'clear:back': this.clear = undefined; this.enter({ kind: 'list' }); return 'handled'
      case 'guide:back': this.enter({ kind: 'list' }); return 'handled'
      case 'page:back': return 'exit'
      default: return 'handled'
    }
  }

  private back(): ModelsPageExit {
    switch (this.view.kind) {
      case 'list':
        return 'exit'
      case 'provider':
        if (this.auth?.phase === 'starting' || this.auth?.phase === 'running') {
          // Esc is an explicit abandonment of the native attempt: cancel it and
          // wait for the Host's settled event, which closes the page-local
          // prompt before returning to the list.
          this.deferProviderNavigation(() => this.enter({ kind: 'list' }))
          return 'handled'
        }
        this.auth = undefined
        this.authNotice = undefined
        this.finishAuthorization()
        this.enter({ kind: 'list' })
        return 'handled'
      case 'reference':
        if (this.referencePhase === 'pending') {
          this.notice = 'the API-key write is in flight — wait for the Host outcome'
          this.requestRender()
          return 'handled'
        }
        this.referencePhase = 'idle'
        this.referenceStatus = undefined
        this.enter({ kind: 'list' })
        return 'handled'
      case 'review':
        if (this.add?.creating === true) {
          this.notice = 'the provider write is in flight — wait for the Host outcome'
          this.requestRender()
          return 'handled'
        }
        this.addSerial += 1
        this.add = undefined
        this.enter({ kind: 'list' })
        return 'handled'
      case 'add-provider':
        this.addSerial += 1
        this.add = undefined
        this.enter({ kind: 'list' })
        return 'handled'
      case 'records':
      case 'logout-list':
      case 'guide':
        this.clear = undefined
        this.enter({ kind: 'list' })
        return 'handled'
      case 'logout':
        if (this.clear?.phase === 'pending') {
          this.notice = 'the credential clear is in flight — wait for the Host outcome'
          this.requestRender()
          return 'handled'
        }
        this.clear = undefined
        this.enter({ kind: 'list' })
        return 'handled'
    }
  }

  // ── mouse ────────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    this.scroll = Math.max(0, this.scroll + delta)
    this.followCursor = false
    this.revision += 1
    this.requestRender()
    return { handled: true }
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    if (this.question !== undefined) {
      if (!this.questionFits()) return
      const row = y - this.questionTop
      const gesture = row >= 0 && row < this.questionRows ? this.question.flow.beginMousePress(row) : undefined
      this.questionPress = gesture === undefined
        ? undefined
        : { gesture, revision: this.revision, width: this.lastWidth, height: this.lastHeight, row }
      return
    }
    const target = this.paintedTargets.find(candidate => candidate.row === y && x >= candidate.startCol && x < candidate.endCol)
    this.pressed = target === undefined ? undefined : { target, revision: this.revision, width: this.lastWidth, height: this.lastHeight }
  }

  onCellClick(x: number, y: number): ModelsPageExit {
    if (this.disposed) return 'handled'
    if (this.question !== undefined) {
      if (!this.questionFits()) return 'handled'
      const pressed = this.questionPress
      this.questionPress = undefined
      const row = y - this.questionTop
      if (pressed === undefined
        || row !== pressed.row
        || pressed.revision !== this.revision
        || pressed.width !== this.lastWidth
        || pressed.height !== this.lastHeight) return 'handled'
      this.question.flow.completeMouseClick(pressed.gesture, row, x)
      this.requestRender()
      return 'handled'
    }
    const pressed = this.pressed
    this.pressed = undefined
    const target = this.paintedTargets.find(candidate => candidate.row === y && x >= candidate.startCol && x < candidate.endCol)
    if (pressed === undefined || target === undefined) return 'handled'
    if (pressed.revision !== this.revision
      || pressed.width !== this.lastWidth
      || pressed.height !== this.lastHeight
      || target.kind !== pressed.target.kind
      || target.id !== pressed.target.id
      || target.row !== pressed.target.row) return 'handled'
    if (target.kind === 'row') {
      // The painted row IS the action, independent of the keyboard cursor.
      this.cursor = this.rowIndexInProjection(target.id)
      return this.activateRow(target.id)
    } else if (target.kind === 'action') {
      if (!this.paintedActionIds.has(target.id)) return 'handled'
      const rowCount = this.rowOrder.length
      const projection = this.project(this.lastWidth)
      const action = projection.actions.find(candidate => candidate.id === target.id)
      if (action === undefined || !action.enabled) return 'handled'
      this.cursor = rowCount + projection.actions.indexOf(action)
      return this.activateAction(action.id)
    } else if (target.kind === 'picker') {
      const index = Number(target.id)
      const picker = this.picker
      const item = picker?.items[index]
      if (picker !== undefined && item !== undefined) {
        this.removePicker(picker)
        picker.onSelect(item.value)
      }
      return 'handled'
    } else if (target.kind === 'model-picker') {
      const picker = this.modelPicker
      if (picker === undefined) return 'handled'
      if (target.id === 'model-picker:manual') {
        this.modelPicker = undefined
        this.beginManualModels()
        return 'handled'
      }
      const index = Number(target.id.slice('model-picker:'.length))
      const model = picker.items[index]
      if (model === undefined) return 'handled'
      const selected = new Set(picker.selected)
      if (selected.has(model.id)) selected.delete(model.id)
      else selected.add(model.id)
      this.modelPicker = { ...picker, index, selected }
      this.requestRender()
      return 'handled'
    }
    return 'handled'
  }

  private rowIndexInProjection(id: string): number {
    const index = this.rowOrder.indexOf(id)
    return index < 0 ? 0 : index
  }

  private actionIndexOf(id: string): number {
    const projection = this.project(this.lastWidth)
    const index = projection.actions.findIndex(action => action.id === id)
    return index < 0 ? 0 : index
  }

  /** Revoke the press state when the Settings root hands the gesture to the
   *  category rail or another owner. */
  cancelPointer(): void {
    this.pressed = undefined
    this.questionPress = undefined
  }

  pendingMutation(): boolean {
    if (this.referencePhase === 'pending') return true
    if (this.add?.creating === true) return true
    if (this.clear?.phase === 'pending') return true
    return this.auth?.phase === 'starting' || this.auth?.phase === 'running'
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Abort the page-owned signal FIRST: the Direct adapter uses this forced
    // caller-abort path to release prompt bridges whose UI is about to be
    // destroyed. Doing the ordinary cancel first could dispose that listener
    // and strand a flow awaiting a lost prompt.
    this.pageController.abort()
    const attemptId = this.auth?.attemptId
    if (attemptId !== undefined) {
      // A native attempt must not outlive the page with an open prompt. The
      // account browser attempt is deliberately NOT cancelled here (it is the
      // Host's, not this page's). Keep the subscription alive until the Host
      // settles so its outcome cannot hang on a dropped settled event.
      this.source.run('models cancel sign-in on close', async () => {
        await this.source.cancelAuthorization(attemptId)
      })
    }
    this.clearQuestions()
    this.pendingAfterAuth = undefined
    this.picker = undefined
    this.pickerQueue.length = 0
    this.modelPicker = undefined
    this.referencePhase = 'idle'
    this.referenceStatus = undefined
    this.add = undefined
    this.clear = undefined
    this.paintedTargets = []
    this.pressed = undefined
    this.requestRender = () => {}
  }
}

const ADD_FIELDS = [
  { id: 'route', label: 'Route', question: 'Provider route (lowercase letters, digits and dashes)', masked: false },
  { id: 'api', label: 'Wire protocol', question: 'Wire protocol', masked: false },
  { id: 'baseURL', label: 'Base URL', question: 'Base URL (absolute http(s) URL)', masked: false },
  { id: 'displayName', label: 'Display name', question: 'Display name (optional; defaults to the route)', masked: false },
  { id: 'key', label: 'API key', question: 'API key (leave empty for provider-native authentication)', masked: true },
  { id: 'models', label: 'Models', question: 'Model ids', masked: false },
] as const
