/**
 * Skill catalog refresh coordinator: the single owner of post-mount
 * surface catalog refreshes. Every refresh is an explicit REQUEST (the
 * caller names the target — the coordinator never guesses from mutable
 * runner state); each request supersedes the previous one (abort + epoch),
 * and only the latest epoch may commit, so a stale live-session, stale
 * preset or stale reload result can never overwrite a newer catalog.
 *
 * Targets (plan §6.4):
 * - AGENT: the live agent's authoritative surface (commands + scoped
 *   commands + skills through the agent-scoped services);
 * - PRESET: the sessionless STANDING skill catalog of the effective preset
 *   — a skills-only install (no Agent, no session, no turn; the standing
 *   scope comes from `agentPresets.standingKeyFor`, never a probe).
 *
 * Lifecycle rules:
 * - a TARGET CHANGE (agent ↔ preset, or a different owner) enters the
 *   revalidating transition FIRST: scoped previews clear and the old skill
 *   wrappers become revalidating transition commands;
 * - a read failure keeps the transition commands and reports `failed` (a
 *   same-target reload retains the last-good catalog);
 * - a standing DEGRADE (the standing key could not be resolved; the read
 *   fell back to the global layer) rides the applied outcome as a
 *   one-shot `notice`;
 * - cancellation is debug-only, never clears a newer installed catalog;
 * - commit happens in one synchronous `installSnapshot` call.
 *
 * The coordinator never imports the runner or the command surface; every
 * dependency arrives as an injected hook.
 *
 * Also exports {@link CoalescingRefreshGate}: the deterministic, timer-free
 * coalescer for invalidation notifications (`skills/change`).
 * @module @xmoon76/dsh-pi-tui/skill-catalog-refresh
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Diag } from './diag.ts'
import { safeErrorMessage } from './error-boundary.ts'
import type { HumanSkillCatalog } from './skill-catalog.ts'
import type { SurfaceCatalogSnapshot } from './surface-catalog.ts'

/** The source that issued one refresh request (diagnostics). */
export type CatalogRefreshSource = 'live-session' | 'preset' | 'reload' | 'invalidation'

/** The refresh target: a live AGENT (key = the bumped chat session
 * generation) or a sessionless PRESET (presetId = the effective preset id;
 * undefined = the deployment default). The caller provides the target
 * explicitly. */
export type CatalogRefreshTarget =
  | { readonly kind: 'agent'; readonly key: number }
  | { readonly kind: 'preset'; readonly presetId: string | undefined }

/** One explicit refresh request. */
export interface CatalogRefreshRequest {
  readonly source: CatalogRefreshSource
  readonly target: CatalogRefreshTarget
  /** The live agent to read (agent target). */
  readonly agent?: Agent
}

/** The settled outcome of one refresh request. */
export type CatalogRefreshOutcome =
  | { readonly kind: 'applied'; readonly snapshot: SurfaceCatalogSnapshot; readonly notice?: string }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'superseded' }

/** One standing (sessionless) skill read result. */
export interface StandingSkillRead {
  readonly catalog: HumanSkillCatalog
  /** One-shot user notice when the standing path degraded to the global
   * layer (absent when nothing degraded). */
  readonly notice?: string
}

/** The surface hooks the coordinator drives (wired by the runner). */
export interface CatalogRefreshHooks {
  /** Read one live agent's effective catalog (agent target). */
  readAgent(agent: Agent, signal: AbortSignal): Promise<SurfaceCatalogSnapshot>
  /** Read the standing skill catalog of one preset (preset target): the
   * adapter's capability-gated cold read, never an Agent probe. */
  readStanding(presetId: string | undefined, signal: AbortSignal): Promise<StandingSkillRead>
  /** One synchronous commit: replace wrappers + merge completions + claims. */
  installSnapshot(snapshot: SurfaceCatalogSnapshot): void
  /** Target change: clear scoped previews, turn old skill wrappers into
   * revalidating transition commands, install the global-only completions. */
  enterCatalogTransition(): void
}

/** Whether two targets are the same owner (no transition needed). The
 * preset identity is the caller-provided presetId compared EXACTLY —
 * `undefined` (the deployment default) never conflates with a user preset
 * literally named `'default'`, and a resolved id never conflates with the
 * raw id it came from (the worst case is a benign extra transition). */
function sameTarget(left: CatalogRefreshTarget | undefined, right: CatalogRefreshTarget): boolean {
  if (left === undefined) return false
  if (left.kind !== right.kind) return false
  return left.kind === 'agent'
    ? left.key === (right as { key: number }).key
    : left.presetId === (right as { presetId: string | undefined }).presetId
}

/**
 * The coordinator. One instance per runner; `dispose()` aborts the active
 * refresh on teardown.
 */
export class CatalogRefreshCoordinator {
  private epoch = 0
  private active: { epoch: number; controller: AbortController } | undefined
  private appliedTarget: CatalogRefreshTarget | undefined
  private snapshot: SurfaceCatalogSnapshot | undefined

  // Explicit fields, not constructor parameter properties: Node's strip-only
  // mode rejects `constructor(private readonly x: T)`.
  private readonly hooks: CatalogRefreshHooks
  private readonly lifecycleSignal: AbortSignal
  private readonly diag: Diag

  constructor(hooks: CatalogRefreshHooks, lifecycleSignal: AbortSignal, diag: Diag) {
    this.hooks = hooks
    this.lifecycleSignal = lifecycleSignal
    this.diag = diag
  }

  /** The last applied snapshot (for same-target partial merges and the
   * `/reload` report). */
  get currentSnapshot(): SurfaceCatalogSnapshot | undefined {
    return this.snapshot
  }

  /**
   * Run one refresh request. A new request aborts the active one; only the
   * LATEST epoch may commit. Returns the settled outcome; never rejects
   * (failures and supersessions are outcomes, not exceptions).
   */
  async refresh(request: CatalogRefreshRequest): Promise<CatalogRefreshOutcome> {
    this.active?.controller.abort()
    const epoch = ++this.epoch
    const controller = new AbortController()
    const signal = AbortSignal.any([this.lifecycleSignal, controller.signal])
    this.active = { epoch, controller }
    const targetChanged = !sameTarget(this.appliedTarget, request.target)
    try {
      // Target change: the revalidating transition is entered BEFORE the
      // read so no new input can be served a stale scoped preview
      // mid-flight. It is INSIDE the try so a throwing transition hook
      // still settles as a `failed` outcome — refresh() never rejects.
      if (targetChanged) this.hooks.enterCatalogTransition()
      const committed = request.target.kind === 'agent'
        ? { snapshot: await this.hooks.readAgent(request.agent!, signal) }
        : await this.readStandingSnapshot(request.target.presetId, signal)
      // Latest-only commit: the lifecycle signal, the epoch and the target
      // owner must all still hold.
      if (signal.aborted || epoch !== this.epoch) {
        this.diag.debug('catalog refresh superseded', { epoch, source: request.source })
        return { kind: 'superseded' }
      }
      const merged = targetChanged ? committed.snapshot : this.mergePartial(committed.snapshot)
      this.hooks.installSnapshot(merged)
      this.snapshot = merged
      this.appliedTarget = request.target
      this.diag.info('catalog applied', {
        epoch,
        source: request.source,
        commands: merged.commands.length,
        scopedCommands: merged.scopedCommands.length,
        skills: merged.skills.length,
        issues: merged.issues.length,
      })
      return { kind: 'applied', snapshot: merged, ...committed.notice === undefined ? {} : { notice: committed.notice } }
    } catch (error) {
      if (signal.aborted || epoch !== this.epoch) {
        this.diag.debug('catalog refresh superseded', { epoch, source: request.source })
        return { kind: 'superseded' }
      }
      const message = safeErrorMessage(error)
      this.diag.warn('catalog unavailable', { epoch, source: request.source, error: message })
      return { kind: 'failed', error: message }
    } finally {
      if (this.active?.epoch === epoch) this.active = undefined
    }
  }

  /** Abort the active refresh (app teardown). Late results are dropped. */
  dispose(): void {
    this.active?.controller.abort()
  }

  /** Same-target partial failure: a provider issue keeps the OLD field for
   * that provider (the old snapshot is still more useful than a blank
   * catalog); the successful providers update as usual. */
  private mergePartial(snapshot: SurfaceCatalogSnapshot): SurfaceCatalogSnapshot {
    const old = this.snapshot
    if (old === undefined) return snapshot
    const commandsFailed = snapshot.issues.some(issue => issue.provider === 'commands')
    const skillsFailed = snapshot.issues.some(issue => issue.provider === 'skills')
    if (!commandsFailed && !skillsFailed) return snapshot
    return Object.freeze({
      commands: commandsFailed ? old.commands : snapshot.commands,
      scopedCommands: commandsFailed ? old.scopedCommands : snapshot.scopedCommands,
      skills: skillsFailed ? old.skills : snapshot.skills,
      issues: snapshot.issues,
    })
  }

  /** One standing read wrapped into a skills-only surface snapshot: the
   * sessionless view has no agent-scoped commands, and the global commands
   * layer is already registered — only the skill wrappers are installed.
   * An INCOMPLETE observation (`complete !== true`) is never an
   * authoritative blank catalog: it carries a detached skills issue, so a
   * same-target reload keeps the last-good skills (mergePartial) and a
   * target change keeps the revalidating transition wrappers
   * (installSurfaceSnapshot's skillsFailed guard). */
  private async readStandingSnapshot(
    presetId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ snapshot: SurfaceCatalogSnapshot; notice?: string }> {
    const read = await this.hooks.readStanding(presetId, signal)
    const incomplete = read.catalog.complete !== true
    const snapshot: SurfaceCatalogSnapshot = Object.freeze({
      commands: Object.freeze([]),
      scopedCommands: Object.freeze([]),
      skills: read.catalog.skills,
      issues: Object.freeze(incomplete
        ? [Object.freeze({ provider: 'skills', message: 'incomplete skill observation' })]
        : []),
    })
    return { snapshot, ...read.notice === undefined ? {} : { notice: read.notice } }
  }
}

/**
 * The deterministic, timer-free coalescer for invalidation notifications
 * (`skills/change`): while one refresh is in flight, further notifications
 * mark the gate DIRTY; when the in-flight refresh settles, ONE more refresh
 * runs if the gate is dirty. A burst therefore costs at most two reads, and
 * the re-run always observes the CURRENT ownership because the runner's
 * `start` callback reads live state at run time.
 */
export class CoalescingRefreshGate {
  private inFlight = false
  private dirty = false

  // Explicit field, not a constructor parameter property: Node's strip-only
  // mode rejects `constructor(private readonly x: T)`.
  private readonly start: () => void

  /** @param start - invoked synchronously to START one owned refresh. Must
   * never throw and must not itself be re-entrant (the gate owns the
   * in-flight bookkeeping; `start` only launches the owned task). */
  constructor(start: () => void) {
    this.start = start
  }

  /** One invalidation notification arrived. */
  notify(): void {
    if (this.inFlight) {
      this.dirty = true
      return
    }
    this.inFlight = true
    this.start()
  }

  /** Terminal settle of the in-flight refresh (called from EVERY terminal
   * runOwned callback: onResult / onCancel / onError). Clears the in-flight
   * flag; a dirty gate starts exactly one follow-up refresh. IDEMPOTENT: a
   * second settle (e.g. onResult throws and runOwned routes to onError)
   * must not clear the in-flight flag of a follow-up refresh it did not
   * start. */
  settled(): void {
    if (!this.inFlight) return
    this.inFlight = false
    if (this.dirty) {
      this.dirty = false
      this.notify()
    }
  }
}
