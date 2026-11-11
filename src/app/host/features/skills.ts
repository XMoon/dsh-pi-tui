/**
 * Host-owned standing Skill metadata and the Host Skills invalidation stream.
 * The official registry, preset lease and Workspace registry remain the only
 * authorities; this service exposes no Skill body or Host path.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isUserInvocableSkill, type SkillSummaryLike } from '../../../domain/catalog/skill.ts'
import {
  PI_TUI_SKILLS_NAMESPACE,
  type PiTuiSkillsInvalidationFrame,
  type PiTuiSkillsStandingRequest,
  type PiTuiSkillsStandingResult,
} from '../../../runtime/remote/pi-tui-skills-contract.ts'

export interface SkillRegistryLike {
  snapshot(options: {
    readonly cwd: string
    readonly scope?: object
    readonly signal: AbortSignal
  }): Promise<{ readonly skills: readonly SkillSummaryLike[]; readonly complete: boolean }>
}

export interface WorkspaceRegistryLike {
  get(id: string): { readonly path: string } | undefined
}

export interface AgentPresetRegistryLike {
  acquireScope(id?: string): Promise<{ readonly key: object } & AsyncDisposable>
}

/** The narrow Host services this row resolves PER CALL (the built-in Host
 *  Runtime owns the `ctx.reflect` lookups, so this module has no direct Host
 *  coupling of its own). */
export interface PiTuiSkillsHostDeps {
  workspaces(): WorkspaceRegistryLike | undefined
  skills(): SkillRegistryLike | undefined
  agentPresets(): AgentPresetRegistryLike | undefined
}

export class PiTuiSkillsHostService extends TypertRemoteService {
  static readonly inject = ['typert', 'workspaceRegistry', 'skills', 'agentPresets']

  private readonly deps: PiTuiSkillsHostDeps
  private readonly activeWakes = new Set<() => void>()
  private disposed = false

  /** The live Host-side invalidation subscriptions (qualification evidence:
   *  a Client teardown must return this to its baseline, never accumulate). */
  get activeSubscriptions(): number {
    return this.activeWakes.size
  }

  constructor(ctx: Context, deps: PiTuiSkillsHostDeps) {
    super(ctx, PI_TUI_SKILLS_NAMESPACE)
    this.deps = deps
    ctx.effect(() => () => {
      this.disposed = true
      for (const wake of [...this.activeWakes]) wake()
    }, 'pi-tui-skills-watchers')
  }

  async standing(
    request: PiTuiSkillsStandingRequest,
    signal: AbortSignal,
  ): Promise<PiTuiSkillsStandingResult> {
    signal.throwIfAborted()
    const workspaces = this.deps.workspaces()
    if (workspaces === undefined) throw new Error('Host workspace registry is unavailable')
    const workspace = workspaces.get(request.workspaceId)
    if (workspace === undefined) throw new Error('Host workspace is unavailable')
    const skills = this.deps.skills()
    if (skills === undefined) throw new Error('Host skills registry is unavailable')
    const agentPresets = this.deps.agentPresets()
    if (agentPresets === undefined) throw new Error('Host preset registry is unavailable')

    let lease: Awaited<ReturnType<AgentPresetRegistryLike['acquireScope']>>
    try {
      lease = await agentPresets.acquireScope(request.presetId)
    } catch (error) {
      signal.throwIfAborted()
      const snapshot = await skills.snapshot({ cwd: workspace.path, signal })
      signal.throwIfAborted()
      return {
        ...this.project(snapshot),
        notice: 'Preset scope is unavailable; showing global skills.',
      }
    }

    try {
      signal.throwIfAborted()
      const snapshot = await skills.snapshot({ cwd: workspace.path, scope: lease.key, signal })
      signal.throwIfAborted()
      return this.project(snapshot)
    } finally {
      await lease[Symbol.asyncDispose]()
    }
  }

  async *watchInvalidations(signal: AbortSignal): AsyncGenerator<PiTuiSkillsInvalidationFrame> {
    signal.throwIfAborted()
    let pending = true
    let wake: (() => void) | undefined
    const notify = (): void => {
      pending = true
      const resume = wake
      wake = undefined
      resume?.()
    }
    const stopWaiting = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const unsubscribe = this.ctx.on('skills/change', notify)
    this.activeWakes.add(stopWaiting)
    signal.addEventListener('abort', stopWaiting, { once: true })
    try {
      while (!signal.aborted && !this.disposed) {
        if (!pending) await new Promise<void>(resolve => { wake = resolve })
        if (signal.aborted || this.disposed) return
        pending = false
        yield { kind: 'invalidated' }
      }
    } finally {
      signal.removeEventListener('abort', stopWaiting)
      unsubscribe()
      this.activeWakes.delete(stopWaiting)
    }
  }

  private project(snapshot: { readonly skills: readonly SkillSummaryLike[]; readonly complete: boolean }): PiTuiSkillsStandingResult {
    const skills = snapshot.skills
      .filter(skill => isUserInvocableSkill(skill))
      .map(skill => ({
        name: skill.name as string,
        description: skill.description as string,
        ...(typeof skill.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}),
        modelInvocable: skill.invocation?.modelInvocable === true,
      }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    return { skills, complete: snapshot.complete }
  }
}
