/**
 * Catalog refresh coordinator: the single owner of post-mount surface
 * catalog refreshes. Every refresh is an explicit REQUEST (the caller names
 * the target — the coordinator never guesses from mutable runner state);
 * each request supersedes the previous one (abort + epoch), and only the
 * latest epoch may commit, so a stale probe, stale live session or stale
 * preset result can never overwrite a newer catalog.
 *
 * Lifecycle rules (see the plan §6.5):
 * - a TARGET CHANGE (composition ↔ live agent, or a different owner) enters
 *   the revalidating transition FIRST: scoped previews clear and the old
 *   skill wrappers become revalidating transition commands;
 * - a read failure keeps the transition commands and reports `failed`;
 * - a same-target refresh with a provider issue keeps the OLD field for the
 *   failed provider (partial failure), never a blank catalog;
 * - cancellation is debug-only, never clears a newer installed catalog;
 * - commit happens in one synchronous `installSnapshot` call.
 *
 * The coordinator never imports the runner or the command surface; every
 * dependency arrives as an injected hook.
 * @module @xmoon76/dsh-pi-tui/catalog-refresh
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Diag } from './diag.ts'
import { safeErrorMessage } from './error-boundary.ts'
import type { SurfaceCatalogSnapshot } from './surface-catalog.ts'

/** The source that issued one refresh request (diagnostics). */
export type CatalogRefreshSource = 'live-session' | 'preset' | 'reload'

/** The refresh target: a live AGENT (key = the bumped chat session
 * generation) or a sessionless COMPOSITION (key = the resolved preset id or
 * `default`). The caller provides the target explicitly. */
export type CatalogRefreshTarget =
  | { readonly kind: 'composition'; readonly key: string }
  | { readonly kind: 'agent'; readonly key: number }

/** One explicit refresh request. */
export interface CatalogRefreshRequest {
  readonly source: CatalogRefreshSource
  readonly target: CatalogRefreshTarget
  /** The live agent to read (agent target). */
  readonly agent?: Agent
  /** The composition to probe (composition target). */
  readonly composition?: { agentPreset?: string; setup(agentCtx: unknown): Promise<void> | void }
}

/** The settled outcome of one refresh request. */
export type CatalogRefreshOutcome =
  | { readonly kind: 'applied'; readonly snapshot: SurfaceCatalogSnapshot }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'superseded' }

/** The surface hooks the coordinator drives (wired by the runner). */
export interface CatalogRefreshHooks {
  /** Read one live agent's effective catalog. */
  readAgent(agent: Agent, signal: AbortSignal): Promise<SurfaceCatalogSnapshot>
  /** Probe one composition (sessionless target). */
  probeComposition(composition: NonNullable<CatalogRefreshRequest['composition']>, signal: AbortSignal): Promise<SurfaceCatalogSnapshot>
  /** One synchronous commit: replace wrappers + merge completions + claims. */
  installSnapshot(snapshot: SurfaceCatalogSnapshot): void
  /** Target change: clear scoped previews, turn old skill wrappers into
   * revalidating transition commands, install the global-only completions. */
  enterCatalogTransition(): void
}

/** Whether two targets are the same owner (no transition needed). */
function sameTarget(left: CatalogRefreshTarget | undefined, right: CatalogRefreshTarget): boolean {
  if (left === undefined) return false
  return left.kind === right.kind && left.key === right.key
}

/**
 * The coordinator. One instance per runner; `dispose()` aborts the active
 * refresh on teardown.
 */
export class CatalogRefreshCoordinator {
  private epoch = 0
  private appliedEpoch = 0
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
    // Target change: the revalidating transition is entered BEFORE the read
    // so no new input can be served a stale scoped preview mid-flight.
    if (targetChanged) this.hooks.enterCatalogTransition()
    try {
      const snapshot = request.target.kind === 'agent'
        ? await this.hooks.readAgent(request.agent!, signal)
        : await this.hooks.probeComposition(request.composition!, signal)
      // Latest-only commit: the lifecycle signal, the epoch and the target
      // owner must all still hold.
      if (signal.aborted || epoch !== this.epoch) {
        this.diag.debug('catalog refresh superseded', { epoch, source: request.source })
        return { kind: 'superseded' }
      }
      const merged = targetChanged ? snapshot : this.mergePartial(snapshot)
      this.hooks.installSnapshot(merged)
      this.snapshot = merged
      this.appliedEpoch = epoch
      this.appliedTarget = request.target
      this.diag.info('catalog applied', {
        epoch,
        source: request.source,
        commands: merged.commands.length,
        scopedCommands: merged.scopedCommands.length,
        skills: merged.skills.length,
        issues: merged.issues.length,
      })
      return { kind: 'applied', snapshot: merged }
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
}
