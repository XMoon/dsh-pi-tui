/**
 * The per-open Computer Use settings controller (PR-5 / MAC-09 v2, SUX-08).
 *
 * It owns ONLY transient state of one open `Settings · Tools · Computer Use`
 * page: the current observation identity, the latest independent observations,
 * the one serialized action, the action receipt and the transient notice. The
 * official Host/provider remains the only authority for the bundle selection,
 * the two macOS privileges, the helper identity, PTC execution, the persisted
 * application decisions and the saved preset default.
 *
 * Rules pinned here:
 *
 * - Opening starts ONE read; a newer refresh/invalidation supersedes the older
 *   one, and the PUBLISHED observation identity (`epoch`) moves with it so a
 *   capture taken from an older frame can never be re-authorized by a newer
 *   read that happens to expose the same application id.
 * - A disabled bundle is NOT queried: its rows are `disabled`, not `denied`.
 * - Each read settles independently; a failed system read never blocks the
 *   application/PTC facts, and a failed read is never coerced into an empty list.
 * - `requested`/`opened` are ACTION receipts, never permission states; only a
 *   later fresh read may observe `Allowed`.
 * - An accepted action owns the page until its own settlement (`busy`), while a
 *   read-only `reading` state never blocks leaving.
 * - A Connection/provider supersession (`SupersededReadError`), a changed
 *   authority basis or a closed page discards the late result; it never
 *   overwrites the newer page.
 * - Actions are serialized and never replayed. Every action carries the capture
 *   it was painted against and is re-proved here against the CURRENT published
 *   observation both at admission and at the queue head before dispatch.
 * - The Computer Use "Set new Sessions to PTC" action is the ONLY guarded
 *   preset-default writer: it dispatches against the exact captured
 *   generation/revision and paints a confirmed result only from a fresh
 *   same-authority observation. The ordinary one-argument preset write remains
 *   untouched for its own callers.
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
import type { PresetDefaultConfig, PresetDefaultDecision } from '../../runtime/config-port.ts'
import type { PluginAvailability, PluginManagerPort } from '../../runtime/plugin-manager-port.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
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
  /** The exact guarded decision this observation captured, when the authority
   *  could prove a settings generation, a descriptor revision and the
   *  effective default. Absent = no write may be offered. */
  readonly decision?: PresetDefaultDecision
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

/**
 * The EXACT painted decision one action was admitted against (SUX-08 §6.3).
 *
 * It carries the observation identity that painted the action plus the target
 * fact the page showed. The controller re-proves it against the CURRENT
 * published observation at admission and again at the queue head, so a newer
 * read/refresh/invalidation with the same application id (or the same
 * permission row) can never execute an older confirmation.
 */
export interface CuaActionCapture {
  readonly epoch: number
  readonly kind: CuaActionKind
  readonly permission?: CuaPermission
  readonly applicationId?: CuaApplicationId
  /** The exact group the painted application row belonged to. */
  readonly applicationGroup?: 'allowed' | 'refused'
}

/** The render-facing snapshot; the page never calls the Host directly. */
export interface CuaAccessSettingsSnapshot {
  /** The current observation identity. Every superseding refresh or
   *  invalidation MOVES it and therefore retires older painted captures. */
  readonly epoch: number
  /** An accepted action owns the page until its own terminal settlement. */
  readonly busy: boolean
  /** A read-only observation is in flight (safe to leave; never Waiting). */
  readonly reading: boolean
  readonly bundle: CuaBundleState
  readonly preset: CuaPresetState
  readonly system: CuaReadState<CuaSystemStatus>
  readonly applications: CuaReadState<CuaApplicationState>
  readonly ptc: CuaReadState<CuaPtcConfiguration>
  readonly action?: CuaActionReceipt
}

/** The per-open controller's dependencies (all Host authority remains outside). */
export interface CuaAccessSettingsDeps {
  readonly cuaAccess: CuaAccessPort
  readonly pluginManager: PluginManagerPort
  readonly presetDefault: PresetDefaultConfig
  /** The runner's diagnostics channel: it owns every read this controller STARTS. */
  readonly diag: Diag
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

/**
 * The ONE semantic admission question: may this painted capture run against
 * THIS published observation?
 *
 * Authority: the published controller snapshot (the projection of the latest
 * official observation). Callers: the page (action enablement and confirmation)
 * and the controller (admission + queue-head re-proof). It is NOT a second
 * permission store: every fact it reads belongs to the official Host/provider
 * projection in the snapshot.
 */
export function cuaActionAdmitted(
  snapshot: CuaAccessSettingsSnapshot,
  capture: CuaActionCapture,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (capture.epoch !== snapshot.epoch) {
    return { ok: false, reason: 'The Host observation changed; the action was discarded. Review the current state and act again.' }
  }
  const bundle = snapshot.bundle
  if (bundle.phase !== 'ready' || !bundle.enabled || !bundle.providerReady) {
    return { ok: false, reason: bundle.error ?? bundle.reason ?? 'The official Computer Use provider is not ready.' }
  }
  switch (capture.kind) {
    case 'request':
    case 'open': {
      const system = snapshot.system.phase === 'ready' ? snapshot.system.value : undefined
      if (system?.platform !== 'darwin') {
        return { ok: false, reason: snapshot.system.reason ?? 'The official macOS permission observation is not current.' }
      }
      if (capture.permission === undefined) return { ok: false, reason: 'The permission target is missing.' }
      return { ok: true }
    }
    case 'preset': {
      if (snapshot.preset.phase !== 'ready' || !snapshot.preset.available) {
        return { ok: false, reason: snapshot.preset.reason ?? 'The saved default preset is not readable right now.' }
      }
      if (snapshot.preset.decision === undefined) {
        return { ok: false, reason: 'The Host preset authority cannot be proven; no change can be saved.' }
      }
      if (snapshot.preset.value === 'ptc') return { ok: false, reason: 'PTC is already the saved default preset.' }
      return { ok: true }
    }
    case 'persistent-ptc': {
      const ptc = snapshot.ptc.phase === 'ready' ? snapshot.ptc.value : undefined
      if (ptc === undefined) return { ok: false, reason: snapshot.ptc.reason ?? 'The Host PTC execution state is not readable right now.' }
      if (ptc.persistent || !ptc.writable) return { ok: false, reason: 'Persistent PTC is already active or read-only.' }
      return { ok: true }
    }
    case 'revoke':
    case 'retry': {
      // The persisted application decisions are an independent Host policy
      // surface: a failed systemStatus() read must not freeze an existing
      // decision's revoke/retry.
      const applications = snapshot.applications.phase === 'ready' ? snapshot.applications.value : undefined
      if (applications === undefined) {
        return { ok: false, reason: snapshot.applications.reason ?? 'The official application list is not current.' }
      }
      if (capture.applicationId === undefined || capture.applicationGroup === undefined) {
        return { ok: false, reason: 'The application target is missing.' }
      }
      const list = capture.applicationGroup === 'allowed' ? applications.allowedApps : applications.blockedApps
      if (capture.kind === 'revoke' && capture.applicationGroup !== 'allowed') {
        return { ok: false, reason: 'That application is not in the always-allowed group.' }
      }
      if (capture.kind === 'retry' && capture.applicationGroup !== 'refused') {
        return { ok: false, reason: 'That application is not in the refused group.' }
      }
      if (!list.some(application => application.id === capture.applicationId)) {
        return { ok: false, reason: 'That application decision is no longer in the official list; refresh before acting.' }
      }
      return { ok: true }
    }
  }
}

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
      reading: false,
      bundle: { phase: 'idle', enabled: false, providerReady: false },
      preset: this.readPreset(),
      system: IDLE(),
      applications: IDLE(),
      ptc: IDLE(),
    }
    // The Split connection generation (or a Direct bundle-service change) is a
    // real observation boundary: an older Allowed/application list must not
    // remain actionable or paintable after it. The callback invalidates the
    // current read epoch and immediately performs ONE fresh read.
    this.observedBasis = deps.cuaAccess.observation.readSnapshot()
    this.unsubscribeObservation = deps.cuaAccess.observation.subscribe(() => { this.startInvalidate() })
    // The official Plugin Manager is the Direct bundle-change authority (and
    // also observes same-connection Remote changes). A bundle enable/disable is
    // an observation boundary even when the CUA service object is unchanged.
    this.unsubscribePlugins = typeof deps.pluginManager.subscribeInvalidation === 'function'
      ? deps.pluginManager.subscribeInvalidation(() => { this.startInvalidate() })
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
   * three CUA groups. The latest refresh wins; older results are discarded, and
   * the published observation identity moves so older painted captures are
   * retired.
   */
  async refresh(): Promise<void> {
    if (this.closed) return
    const epoch = ++this.epoch
    const sequence = ++this.readSequence
    this.patch({
      epoch,
      reading: true,
      bundle: { ...this.state.bundle, phase: 'loading' },
      system: this.state.bundle.phase === 'disabled' ? this.state.system : { phase: 'loading' },
      applications: this.state.bundle.phase === 'disabled' ? this.state.applications : { phase: 'loading' },
      ptc: this.state.bundle.phase === 'disabled' ? this.state.ptc : { phase: 'loading' },
      preset: this.readPreset(),
    })
    // The basis this ENTIRE read belongs to. A provider replacement during the
    // read makes every collected value belong to the old generation, so it can
    // never be adopted as the new page snapshot.
    const basisAtStart = this.deps.cuaAccess.observation.readSnapshot()
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
          ptc: { phase: disabledPhase, reason },
          busy: this.actionInFlight,
          reading: false,
        })
        return
      }
      this.patch({
        system: { phase: 'loading' },
        applications: { phase: 'loading' },
        ptc: { phase: 'loading' },
      })
      await Promise.all([
        this.readGroup(epoch, sequence, 'system', basisAtStart, () => this.deps.cuaAccess.readSystemStatus()),
        this.readGroup(epoch, sequence, 'applications', basisAtStart, () => this.deps.cuaAccess.readApplications()),
        this.readGroup(epoch, sequence, 'ptc', basisAtStart, () => this.deps.cuaAccess.readPtcConfiguration()),
      ])
      if (!this.current(epoch, sequence)) return
      const basisAtEnd = this.deps.cuaAccess.observation.readSnapshot()
      if (!Object.is(basisAtStart, basisAtEnd)) {
        // The read CROSSED a provider replacement: these values describe the old
        // service and must not be painted or adopted as the current generation.
        // Publish the unknown state and read once more at the settled basis.
        this.observedBasis = basisAtEnd
        this.epoch += 1
        this.readSequence += 1
        this.patch({
          epoch: this.epoch,
          system: { phase: 'unknown', reason: 'The Host CUA provider changed during the read; refresh again to read the new generation.' },
          applications: { phase: 'unknown', reason: 'The Host CUA provider changed during the read; refresh again to read the new generation.' },
          ptc: { phase: 'unknown', reason: 'The Host CUA provider changed during the read; refresh again to read the new generation.' },
          busy: this.actionInFlight,
          reading: false,
        })
        this.readInFlight = this.refresh().catch(() => {})
        return
      }
      // The settled read is the page's NEW basis.
      this.observedBasis = basisAtEnd
      this.patch({ busy: this.actionInFlight, reading: false })
    })()
    this.readInFlight = run.catch(() => {})
    await this.readInFlight
  }

  /** Request one macOS privilege through the official native guide. */
  async requestPermission(capture: CuaActionCapture): Promise<void> {
    await this.runAction(capture,
      { kind: 'request', permission: capture.permission, text: 'Request sent. Complete the guidance on the Host Mac, then Refresh; this action does not grant permission.' },
      async () => { await this.deps.cuaAccess.requestPermission(capture.permission!, this.deps.locale()) })
  }

  /** Open the Host's macOS privacy pane (an action, not a permission grant). */
  async openSettings(capture: CuaActionCapture): Promise<void> {
    await this.runAction(capture,
      { kind: 'open', permission: capture.permission, text: 'Opened the Host System Settings attempt. No permission is granted by this action; confirm the exact helper there.' },
      async () => { await this.deps.cuaAccess.openSettings(capture.permission!, this.deps.locale()) })
  }

  /** Persist PTC execution; the official runtime may reload. */
  async enablePersistentPtc(capture: CuaActionCapture): Promise<void> {
    await this.runAction(capture,
      { kind: 'persistent-ptc', text: 'Persistent PTC requested. The official runtime may reload; refresh to observe the new state.' },
      async () => { await this.deps.cuaAccess.enablePersistentPtc() })
  }

  /**
   * Set the saved default preset for NEW Sessions (never the live Session).
   * The ONE guarded preset write: it dispatches against the exact decision the
   * painted frame captured and paints a confirmed result only from a fresh
   * same-authority observation.
   */
  async setPtcDefault(capture: CuaActionCapture): Promise<void> {
    await this.runAction(capture,
      { kind: 'preset', text: 'Default preset set to PTC for new Sessions. An existing Session keeps its own preset.' },
      async () => {
        const decision = this.state.preset.decision
        const guarded = this.deps.presetDefault.setGuarded
        if (decision === undefined || guarded === undefined) {
          return { state: 'failed' as const, text: 'The Host preset authority cannot be proven; nothing was saved. Refresh and act again.' }
        }
        const outcome = await guarded.call(this.deps.presetDefault, 'ptc', decision)
        if (outcome.kind === 'rejected' || outcome.kind === 'conflict') {
          return { state: 'failed' as const, text: `Could not save: ${outcome.reason}` }
        }
        if (outcome.kind === 'outcome-unconfirmed') {
          return { state: 'unknown' as const, text: `Could not confirm save: ${outcome.reason}. Refresh and check.` }
        }
        // Accepted: only a FRESH same-authority read that carries `ptc` proves
        // the requested change. An ACK or a replacement authority's value is
        // not attribution of THIS write.
        const fresh = this.readPreset()
        const current = fresh.decision
        if (fresh.phase !== 'ready' || current === undefined
          || !Object.is(current.generation, decision.generation)
          || current.value !== 'ptc') {
          return { state: 'unknown' as const, text: 'Could not confirm save. The change may have been saved. Refresh and check.' }
        }
        return { state: 'ok' as const, text: 'Default preset set to PTC for new Sessions (confirmed by the current Host). An existing Session keeps its own preset.' }
      })
  }

  /** Revoke the exact painted application decision; the page confirms first. */
  async revoke(capture: CuaActionCapture): Promise<void> {
    await this.runAction(capture,
      { kind: 'revoke', applicationId: capture.applicationId, text: 'Application access revoked. Affected Computer Use work may stop; dispatched input is not undone.' },
      async () => { await this.deps.cuaAccess.revoke(capture.applicationId!) })
  }

  /** Clear refusals so the next selection may ask again; it grants nothing. */
  async retryApproval(capture: CuaActionCapture): Promise<void> {
    await this.runAction(capture,
      { kind: 'retry', applicationId: capture.applicationId, text: 'Refusal record cleared. The next selection will ask again; this action grants no access.' },
      async () => { await this.deps.cuaAccess.retryApproval(capture.applicationId!) })
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

  /**
   * Start ONE invalidation read from an observation callback. The callback
   * cannot await, so the read is a detached task with a real owner: failures
   * reach the runner diagnostics instead of becoming an unhandled rejection.
   */
  private startInvalidate(): void {
    runDetached('cua observation invalidation', () => this.invalidateObservation(), { diag: this.deps.diag })
  }

  private async invalidateObservation(): Promise<void> {
    if (this.closed) return
    // The superseded observation identity retires every older painted capture
    // immediately, before the replacement read answers. `refresh()` moves it
    // again; either way no old confirmation survives the boundary.
    this.epoch += 1
    this.readSequence += 1
    this.observedBasis = this.deps.cuaAccess.observation.readSnapshot()
    this.patch({
      epoch: this.epoch,
      system: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      applications: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      ptc: { phase: 'unknown', reason: 'The Host observation basis changed; refresh to read the new generation.' },
      // An already-dispatched action is still in flight: keep the admission
      // visible until it settles, then publish its unknown outcome. A read-only
      // refresh may proceed independently.
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

  /**
   * ONE independently settled group read. Its value is published only while the
   * SAME observation basis the whole read started under is still current: a
   * Direct provider replacement during the read cannot leak an old-generation
   * fact into the page even briefly (the end-of-read fence then re-reads).
   */
  private async readGroup<T>(
    epoch: number,
    sequence: number,
    key: 'system' | 'applications' | 'ptc',
    basisAtStart: unknown,
    read: () => Promise<T>,
  ): Promise<void> {
    try {
      const value = await read()
      if (!this.current(epoch, sequence)) return
      if (!Object.is(this.deps.cuaAccess.observation.readSnapshot(), basisAtStart)) return
      this.patch({ [key]: { phase: 'ready', value } } as Partial<CuaAccessSettingsSnapshot>)
    } catch (error) {
      if (!this.current(epoch, sequence)) return
      if (!Object.is(this.deps.cuaAccess.observation.readSnapshot(), basisAtStart)) return
      this.patch({ [key]: readReasonOf(error) } as Partial<CuaAccessSettingsSnapshot>)
    }
  }

  private readPreset(): CuaPresetState {
    try {
      const available = this.deps.presetDefault.available()
      const value = this.deps.presetDefault.get()
      const decision = this.deps.presetDefault.readDecision?.()
      return { phase: 'ready', available, value, ...(decision === undefined ? {} : { decision }) }
    } catch (error) {
      return { phase: 'failed', available: false, reason: reasonOf(error) }
    }
  }

  private current(epoch: number, sequence: number): boolean {
    return !this.closed && epoch === this.epoch && sequence === this.readSequence
  }

  private async runAction(
    capture: CuaActionCapture,
    receipt: Omit<CuaActionReceipt, 'state' | 'at'>,
    run: () => Promise<void | { readonly state: 'ok' | 'failed' | 'unknown'; readonly text?: string }>,
  ): Promise<void> {
    return await this.admitAction(capture, receipt, run)
  }

  /**
   * ADMIT one action against the CURRENT published observation, then dispatch
   * it exactly once.
   *
   * The stale-basis branch must never carry a pre-refresh closure into the new
   * provider generation: the capture was built from the old page's painted
   * target (an application id, a permission row, a confirmation grant), so
   * reusing it after the refresh is exactly the "old confirmation writes the new
   * service" defect. Admission therefore RE-ENTERS only after a fresh
   * observation, and the caller is told nothing was dispatched.
   */
  private async admitAction(
    capture: CuaActionCapture,
    receipt: Omit<CuaActionReceipt, 'state' | 'at'>,
    run: () => Promise<void | { readonly state: 'ok' | 'failed' | 'unknown'; readonly text?: string }>,
  ): Promise<void> {
    // ONE accepted action at a time: a second buffered Enter/click is refused
    // before it can enter the serial tail. The page also disables its actions
    // while busy, but this admission is the authority.
    if (this.closed || this.actionInFlight) return
    const refused = cuaActionAdmitted(this.state, capture)
    if (!refused.ok) {
      this.publishRefusal(receipt, refused.reason)
      return
    }
    // Consume the observation basis before any dispatch: a page action painted
    // against an older generation is refused and the new generation is read.
    const basis = this.deps.cuaAccess.observation.readSnapshot()
    if (!Object.is(basis, this.observedBasis)) {
      await this.invalidateObservation()
      this.patch({
        action: {
          ...receipt,
          kind: capture.kind,
          state: 'unknown',
          text: 'The Host CUA provider changed; the page was refreshed and the action was NOT dispatched. Review the new state and act again.',
          at: Date.now(),
        },
        busy: false,
      })
      return
    }
    this.actionInFlight = true
    const epoch = this.epoch
    // The provider this action was ADMITTED against. Direct's observation
    // subscription is a no-op, so a replacement between admission and the
    // queued dispatch is invisible to `epoch`: the identity must be re-read at
    // the dispatch boundary and again at settlement.
    const admittedBasis = basis
    // The ONE currentness judgment for a dispatched CUA write. A provider
    // replacement during the write is invisible to `epoch` on Direct; both the
    // success and the error settlement use this same judgment — an error raised
    // by a replaced provider is not a property of the current one.
    const stillCurrent = (): boolean => !this.closed
      && epoch === this.epoch
      && Object.is(this.deps.cuaAccess.observation.readSnapshot(), admittedBasis)
    const task = this.tail.then(async () => {
      if (this.closed) return
      // The queue head re-proves the EXACT painted capture (observation
      // identity and target facts) and the provider identity before dispatch.
      const live = cuaActionAdmitted(this.state, capture)
      if (!live.ok) {
        this.publishRefusal(receipt, live.reason)
        return
      }
      this.patch({ busy: true })
      if (!Object.is(this.deps.cuaAccess.observation.readSnapshot(), admittedBasis)) {
        // Replaced before dispatch: the target the user acted on belongs to the
        // old provider, so nothing is dispatched.
        this.patch({
          action: {
            ...receipt,
            kind: capture.kind,
            state: 'unknown',
            text: 'The Host CUA provider changed before the action was dispatched; nothing was sent. Refresh and act again.',
            at: Date.now(),
          },
          busy: false,
        })
        return
      }
      try {
        const result = await run()
        // The guarded preset write proves its OWN config authority through its
        // same-generation readback; the CUA provider basis is not that
        // authority and must not turn a proven preset write into an unknown.
        const attributable = capture.kind === 'preset' || stillCurrent()
        if (!attributable) {
          this.publishUnknown(receipt, capture.kind)
          return
        }
        if (result !== undefined && result.state !== 'ok') {
          this.patch({
            action: {
              ...receipt,
              kind: capture.kind,
              state: result.state,
              text: result.text ?? receipt.text,
              at: Date.now(),
            },
            busy: this.actionInFlight,
          })
          await this.refresh()
          return
        }
        this.patch({
          action: {
            ...receipt,
            kind: capture.kind,
            state: 'ok',
            text: result?.text ?? receipt.text,
            at: Date.now(),
          },
        })
        await this.refresh()
      } catch (error) {
        if (!stillCurrent() && capture.kind !== 'preset') {
          // The rejection belongs to the replaced provider: the CURRENT one has
          // no attributable outcome, so the truthful state is unknown, not the
          // old provider's failure.
          this.publishUnknown(receipt, capture.kind)
          return
        }
        const unknown = error instanceof SupersededReadError
        this.patch({
          action: {
            ...receipt,
            kind: capture.kind,
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

  private publishRefusal(
    receipt: Omit<CuaActionReceipt, 'state' | 'at'>,
    reason: string,
  ): void {
    this.patch({
      action: { ...receipt, state: 'failed', text: reason, at: Date.now() },
      busy: this.actionInFlight,
    })
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
