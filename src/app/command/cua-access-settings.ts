/**
 * The per-open Computer Use settings controller (PR-5 / MAC-09 v2).
 *
 * It owns ONLY transient state of one open `Settings · Tools · Computer Use`
 * page: the open epoch, the latest independent observations, the one
 * serialized write, the action receipt and the transient notice. The official
 * Host/provider remains the only authority for the bundle selection, the two
 * macOS privileges, the helper identity, PTC execution and persisted
 * application decisions.
 *
 * Rules pinned here:
 *
 * - Opening starts ONE read; a refresh retires older results by sequence.
 * - A disabled bundle is NOT queried: its rows are `disabled`, not `denied`.
 * - Each read settles independently; an icon failure never blocks the
 *   permission facts, and a failed read is never coerced into an empty list.
 * - `requested`/`opened` are ACTION receipts, never permission states; only a
 *   later fresh read may observe `Allowed`.
 * - A Connection-generation supersession (`SupersededReadError`) or a closed
 *   page discards the late result; it never overwrites the newer page.
 * - Writes are serialized and never replayed. Closing does not claim that a
 *   Host-side effect was rolled back.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/cua-access-settings
 */

import {
  CuaAccessUnavailableError,
  type CuaAccessPort,
  type CuaApplicationId,
  type CuaApplicationState,
  type CuaPermission,
  type CuaPtcConfiguration,
  type CuaSystemStatus,
} from '../../runtime/cua-access-port.ts'
import type { PresetDefaultConfig } from '../../runtime/config-port.ts'
import type { PluginAvailability, PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'

/** The official bundle this page manages. */
export const CUA_BUNDLE_NAME = '@deepseek-ai/dsh-cua-bundle'

/** One independently settled read. */
export type CuaReadPhase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed' | 'disabled' | 'unknown'

/** The page-facing read state. `value` is absent unless `phase === 'ready'`. */
export interface CuaReadState<T> {
  readonly phase: CuaReadPhase
  readonly value?: T
  readonly reason?: string
}

/** The official bundle's selection/availability facts (never a provider Ready). */
export interface CuaBundleState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'disabled' | 'unknown'
  readonly enabled: boolean
  /** True only when the official provider is selected AND no Host preparation
   *  error is reported; CUA permission reads are queried only then. */
  readonly providerReady: boolean
  readonly availability?: PluginAvailability
  readonly version?: string
  readonly error?: string
  readonly reason?: string
}

/** The saved default agent preset, as the official ConfigPort reports it. */
export interface CuaPresetState {
  readonly phase: 'ready' | 'failed'
  readonly available: boolean
  readonly value?: string
  readonly reason?: string
}

/** The one transient action receipt of this open. */
export type CuaActionKind = 'request' | 'open' | 'persistent-ptc' | 'preset' | 'revoke' | 'retry'

export interface CuaActionReceipt {
  readonly kind: CuaActionKind
  readonly state: 'ok' | 'failed' | 'unknown'
  readonly text: string
  readonly permission?: CuaPermission
  readonly applicationId?: CuaApplicationId
  readonly at: number
}

/** The render-facing snapshot; the page never calls the Host directly. */
export interface CuaAccessSettingsSnapshot {
  readonly epoch: number
  readonly busy: boolean
  readonly bundle: CuaBundleState
  readonly preset: CuaPresetState
  readonly system: CuaReadState<CuaSystemStatus>
  readonly applications: CuaReadState<CuaApplicationState>
  readonly icons: CuaReadState<Readonly<Record<string, string>>>
  readonly ptc: CuaReadState<CuaPtcConfiguration>
  readonly action?: CuaActionReceipt
}

/** The per-open controller's dependencies (all Host authority remains outside). */
export interface CuaAccessSettingsDeps {
  readonly cuaAccess: CuaAccessPort
  readonly pluginManager: PluginManagerPort
  readonly presetDefault: PresetDefaultConfig
  /** The current Client language for the official native guide. */
  readonly locale: () => string
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readReasonOf(error: unknown): { phase: 'unavailable' | 'failed' | 'unknown'; reason: string } {
  if (error instanceof SupersededReadError) return { phase: 'unknown', reason: `the Host connection changed; observation discarded (${error.reason})` }
  if (error instanceof CuaAccessUnavailableError) return { phase: 'unavailable', reason: error.message }
  return { phase: 'failed', reason: reasonOf(error) }
}

const IDLE = <T>(): CuaReadState<T> => ({ phase: 'idle' })

/** ONE per-open controller; constructed when the Settings specialist opens. */
export class CuaAccessSettingsController {
  private readonly deps: CuaAccessSettingsDeps
  private readonly listeners = new Set<() => void>()
  private state: CuaAccessSettingsSnapshot
  private readonly openingEpoch: number
  private epoch: number
  private readSequence = 0
  private readInFlight: Promise<void> = Promise.resolve()
  private closed = false
  private actionInFlight = false
  private observedBasis: unknown
  private unsubscribeObservation: () => void = () => {}
  private unsubscribePlugins: () => void = () => {}
  private tail: Promise<void> = Promise.resolve()
  private disposed: Promise<void> | undefined

  constructor(deps: CuaAccessSettingsDeps) {
    this.deps = deps
    this.epoch = 0
    this.openingEpoch = this.epoch
    this.state = {
      epoch: this.epoch,
      busy: false,
      bundle: { phase: 'idle', enabled: false, providerReady: false },
      preset: this.readPreset(),
      system: IDLE(),
      applications: IDLE(),
      icons: IDLE(),
      ptc: IDLE(),
    }
    // The Split connection generation (or a Direct bundle-service change) is a
    // real observation boundary: an older Allowed/application list must not
    // remain actionable or paintable after it. The callback invalidates the
    // current read epoch and immediately performs ONE fresh read.
    this.observedBasis = deps.cuaAccess.observation.readSnapshot()
    this.unsubscribeObservation = deps.cuaAccess.observation.subscribe(() => { void this.invalidateObservation() })
    // The official Plugin Manager is the Direct bundle-change authority (and
    // also observes same-connection Remote changes). A bundle enable/disable is
    // an observation boundary even when the CUA service object is unchanged.
    this.unsubscribePlugins = typeof deps.pluginManager.subscribeInvalidation === 'function'
      ? deps.pluginManager.subscribeInvalidation(() => { void this.invalidateObservation() })
      : () => {}
  }

  getSnapshot(): CuaAccessSettingsSnapshot {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The opening epoch; a page token may compare it across async completions. */
  get epochValue(): number {
    return this.openingEpoch
  }

  /**
   * Re-read the bundle, the preset and (only while the bundle is enabled) the
   * four CUA groups. The latest refresh wins; older results are discarded.
   */
  async refresh(): Promise<void> {
    if (this.closed) return
    const epoch = this.epoch
    const sequence = ++this.readSequence
    this.patch({
      busy: true,
      bundle: { ...this.state.bundle, phase: 'loading' },
      system: this.state.bundle.phase === 'disabled' ? this.state.system : { phase: 'loading' },
      applications: this.state.bundle.phase === 'disabled' ? this.state.applications : { phase: 'loading' },
      icons: this.state.bundle.phase === 'disabled' ? this.state.icons : { phase: 'loading' },
      ptc: this.state.bundle.phase === 'disabled' ? this.state.ptc : { phase: 'loading' },
      preset: this.readPreset(),
    })
    const run = (async () => {
      const bundle = await this.readBundle(epoch, sequence)
      if (!this.current(epoch, sequence)) return
      this.patch({ bundle })
      if (bundle.phase !== 'ready' || !bundle.enabled || !bundle.providerReady) {
        const disabledPhase = bundle.phase === 'disabled'
          ? 'disabled'
          : bundle.phase === 'ready'
            ? 'unavailable'
            : 'unknown'
        const reason = bundle.error ?? bundle.reason ?? (bundle.phase === 'disabled' ? 'the official Computer Use bundle is disabled' : 'the official CUA provider is not ready')
        this.patch({
          system: { phase: disabledPhase, reason },
          applications: { phase: disabledPhase, reason },
          icons: { phase: disabledPhase, reason },
          ptc: { phase: disabledPhase, reason },
          busy: this.actionInFlight,
        })
        return
      }
      this.patch({
        system: { phase: 'loading' },
        applications: { phase: 'loading' },
        icons: { phase: 'loading' },
        ptc: { phase: 'loading' },
      })
      await Promise.all([
        this.readGroup(epoch, sequence, 'system', () => this.deps.cuaAccess.readSystemStatus()),
        this.readGroup(epoch, sequence, 'applications', () => this.deps.cuaAccess.readApplications()),
        this.readGroup(epoch, sequence, 'icons', () => this.deps.cuaAccess.readApplicationIcons()),
        this.readGroup(epoch, sequence, 'ptc', () => this.deps.cuaAccess.readPtcConfiguration()),
      ])
      if (this.current(epoch, sequence)) {
        // The settled read is the page's NEW basis: a provider replacement that
        // triggered this refresh must not keep refusing the next action against
        // the old snapshot. A further change during the read re-invalidates the
        // epoch (the subscribe path), so this assignment still cannot bless a
        // stale generation.
        this.observedBasis = this.deps.cuaAccess.observation.readSnapshot()
        this.patch({ busy: this.actionInFlight })
      }
    })()
    this.readInFlight = run.catch(() => {})
    await this.readInFlight
  }

  /** Request one macOS privilege through the official native guide. */
  async requestPermission(permission: CuaPermission): Promise<void> {
    await this.runAction('request',
      { kind: 'request', permission, text: 'Request sent. Complete the guidance on the Host Mac, then Refresh; this action does not grant permission.' },
      async () => { await this.deps.cuaAccess.requestPermission(permission, this.deps.locale()) })
  }

  /** Open the Host's macOS privacy pane (an action, not a permission grant). */
  async openSettings(permission: CuaPermission): Promise<void> {
    await this.runAction('open',
      { kind: 'open', permission, text: 'Opened the Host System Settings attempt. No permission is granted by this action; confirm the exact helper there.' },
      async () => { await this.deps.cuaAccess.openSettings(permission, this.deps.locale()) })
  }

  /** Persist PTC execution; the official runtime may reload. */
  async enablePersistentPtc(): Promise<void> {
    await this.runAction('persistent-ptc',
      { kind: 'persistent-ptc', text: 'Persistent PTC requested. The official runtime may reload; refresh to observe the new state.' },
      async () => { await this.deps.cuaAccess.enablePersistentPtc() })
  }

  /** Set the saved default preset for NEW Sessions (never the live Session). */
  async setPtcDefault(): Promise<void> {
    await this.runAction('preset',
      { kind: 'preset', text: 'Default preset set to PTC for new Sessions. An existing Session keeps its own preset.' },
      async () => { await this.deps.presetDefault.set('ptc') })
  }

  /** Revoke the exact painted application decision; the page confirms first. */
  async revoke(id: CuaApplicationId): Promise<void> {
    await this.runAction('revoke',
      { kind: 'revoke', applicationId: id, text: 'Application access revoked. Affected Computer Use work may stop; dispatched input is not undone.' },
      async () => { await this.deps.cuaAccess.revoke(id) })
  }

  /** Clear refusals so the next selection may ask again; it grants nothing. */
  async retryApproval(id: CuaApplicationId): Promise<void> {
    await this.runAction('retry',
      { kind: 'retry', applicationId: id, text: 'Refusal record cleared. The next selection will ask again; this action grants no access.' },
      async () => { await this.deps.cuaAccess.retryApproval(id) })
  }

  /**
   * Synchronously close this open's state. In-flight reads are discarded by
   * their epoch check; a Host-side effect already dispatched is not undone.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.epoch++
    this.unsubscribeObservation()
    this.unsubscribePlugins()
    this.listeners.clear()
  }

  /** Close and wait for the already-started local reads/writes to settle. */
  async dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    this.close()
    this.disposed = Promise.all([this.readInFlight, this.tail]).then(() => {})
    await this.disposed
  }

  private async invalidateObservation(): Promise<void> {
    if (this.closed) return
    this.epoch += 1
    this.readSequence += 1
    this.observedBasis = this.deps.cuaAccess.observation.readSnapshot()
    this.patch({
      system: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      applications: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      icons: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      ptc: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      // An already-dispatched write is still in flight: keep the admission
      // visible (actions disabled) until it settles, then publish its unknown
      // outcome. A read-only refresh may proceed independently.
      busy: this.actionInFlight,
    })
    await this.refresh()
  }

  private async readBundle(epoch: number, sequence: number): Promise<CuaBundleState> {
    try {
      const snapshot = await this.deps.pluginManager.snapshot()
      if (!this.current(epoch, sequence)) return this.state.bundle
      const bundle = snapshot.bundles.find(candidate => candidate.name === CUA_BUNDLE_NAME)
      if (bundle === undefined) {
        return { phase: 'unknown', enabled: false, providerReady: false, reason: `the Host roster does not contain ${CUA_BUNDLE_NAME}` }
      }
      const error = bundle.error === undefined
        ? undefined
        : [bundle.error.code, bundle.error.diagnostic].filter(part => part !== undefined && part !== '').join(' — ')
      const providerReady = bundle.enabled && bundle.availability !== 'missing' && error === undefined
      if (!bundle.enabled) {
        return {
          phase: 'disabled', enabled: false, providerReady: false,
          availability: bundle.availability,
          ...(bundle.version === undefined ? {} : { version: bundle.version }),
          ...(error === undefined ? {} : { error }),
          reason: error ?? 'The Computer Use bundle is disabled in this profile.',
        }
      }
      if (!providerReady) {
        return {
          phase: 'ready', enabled: true, providerReady: false,
          availability: bundle.availability,
          ...(bundle.version === undefined ? {} : { version: bundle.version }),
          ...(error === undefined ? {} : { error }),
          reason: error ?? 'The official CUA provider is not installed for this profile.',
        }
      }
      return {
        phase: 'ready', enabled: true, providerReady: true,
        availability: bundle.availability,
        ...(bundle.version === undefined ? {} : { version: bundle.version }),
      }
    } catch (error) {
      return { phase: 'unknown', enabled: false, providerReady: false, reason: reasonOf(error) }
    }
  }

  private async readGroup<T>(
    epoch: number,
    sequence: number,
    key: 'system' | 'applications' | 'icons' | 'ptc',
    read: () => Promise<T>,
  ): Promise<void> {
    try {
      const value = await read()
      if (!this.current(epoch, sequence)) return
      this.patch({ [key]: { phase: 'ready', value } } as Partial<CuaAccessSettingsSnapshot>)
    } catch (error) {
      if (!this.current(epoch, sequence)) return
      this.patch({ [key]: readReasonOf(error) } as Partial<CuaAccessSettingsSnapshot>)
    }
  }

  private readPreset(): CuaPresetState {
    try {
      return { phase: 'ready', available: this.deps.presetDefault.available(), value: this.deps.presetDefault.get() }
    } catch (error) {
      return { phase: 'failed', available: false, reason: reasonOf(error) }
    }
  }

  private current(epoch: number, sequence: number): boolean {
    return !this.closed && epoch === this.epoch && sequence === this.readSequence
  }

  private async runAction(
    kind: CuaActionKind,
    receipt: Omit<CuaActionReceipt, 'state' | 'at'>,
    run: () => Promise<void>,
  ): Promise<void> {
    // ONE side effect per open/operation: a second buffered Enter/click is
    // refused before it can enter the serial queue. The page also disables its
    // actions while busy, but this admission is the authority.
    if (this.closed || this.actionInFlight) return
    // Consume the observation basis before any dispatch: a page action painted
    // against an older generation is refused and the new generation is read.
    const basis = this.deps.cuaAccess.observation.readSnapshot()
    if (!Object.is(basis, this.observedBasis)) {
      // The page was opened against an older provider generation. Refresh
      // FIRST and retry only when the settled read's own basis still matches;
      // a provider that changes again during the read keeps the action
      // refused (the genuine fail-closed case).
      await this.invalidateObservation()
      // A page read can itself surface a provider status event that replaces
      // the basis once more; refusing forever after that turns a fresh action
      // into an unrecoverable NOT-dispatched receipt. The action is admissible
      // while the provider still EXISTS; an absent provider is the genuine
      // fail-closed case. The adopted basis is this dispatch's own generation.
      const settled = this.deps.cuaAccess.observation.readSnapshot()
      if (settled === undefined) {
        this.patch({
          action: {
            ...receipt,
            kind,
            state: 'unknown',
            text: 'The Host CUA provider is gone; the action was NOT dispatched. Refresh before retrying.',
            at: Date.now(),
          },
          busy: false,
        })
        return
      }
      this.observedBasis = settled
    }
    this.actionInFlight = true
    const epoch = this.epoch
    const task = this.tail.then(async () => {
      if (this.closed || epoch !== this.epoch) return
      this.patch({ busy: true })
      try {
        await run()
        if (this.closed) return
        if (epoch !== this.epoch) {
          this.publishUnknown(receipt, kind)
          return
        }
        this.patch({ action: { ...receipt, kind, state: 'ok', at: Date.now() } })
        await this.refresh()
      } catch (error) {
        if (this.closed) return
        if (epoch !== this.epoch) {
          this.publishUnknown(receipt, kind)
          return
        }
        const unknown = error instanceof SupersededReadError
        this.patch({
          action: {
            ...receipt,
            kind,
            state: unknown ? 'unknown' : 'failed',
            text: unknown
              ? 'The Host connection changed; the action outcome is unconfirmed. Refresh before retrying.'
              : reasonOf(error),
            at: Date.now(),
          },
          busy: false,
        })
      }
    })
    this.tail = task.catch(() => {})
    try {
      await task
    } finally {
      this.actionInFlight = false
      if (!this.closed && this.state.busy) this.patch({ busy: false })
    }
  }

  private publishUnknown(
    receipt: Omit<CuaActionReceipt, 'state' | 'at'>,
    kind: CuaActionKind,
  ): void {
    this.patch({
      action: {
        ...receipt,
        kind,
        state: 'unknown',
        text: 'The Host observation basis changed while the action was in flight; the outcome is unconfirmed. Refresh before retrying.',
        at: Date.now(),
      },
      busy: this.actionInFlight,
    })
  }

  private patch(partial: Partial<CuaAccessSettingsSnapshot>): void {
    if (this.closed) return
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener()
  }
}
