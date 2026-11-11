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

interface SkillRegistryLike {
  snapshot(options: {
    readonly cwd: string
    readonly scope?: object
    readonly signal: AbortSignal
  }): Promise<{ readonly skills: readonly SkillSummaryLike[]; readonly complete: boolean }>
}

interface WorkspaceRegistryLike {
  get(id: string): { readonly path: string } | undefined
}

interface AgentPresetRegistryLike {
  acquireScope(id?: string): Promise<{ readonly key: object } & AsyncDisposable>
}

export class PiTuiSkillsHostService extends TypertRemoteService {
  static readonly inject = ['typert', 'workspaceRegistry', 'skills', 'agentPresets']

  private readonly workspaces: WorkspaceRegistryLike
  private readonly skills: SkillRegistryLike
  private readonly agentPresets: AgentPresetRegistryLike
  private readonly activeWakes = new Set<() => void>()
  private disposed = false

  constructor(ctx: Context) {
    super(ctx, PI_TUI_SKILLS_NAMESPACE)
    this.workspaces = ctx.workspaceRegistry as unknown as WorkspaceRegistryLike
    this.skills = ctx.skills as unknown as SkillRegistryLike
    this.agentPresets = ctx.agentPresets as unknown as AgentPresetRegistryLike
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
    const workspace = this.workspaces.get(request.workspaceId)
    if (workspace === undefined) throw new Error('Host workspace is unavailable')

    let lease: Awaited<ReturnType<AgentPresetRegistryLike['acquireScope']>>
    try {
      lease = await this.agentPresets.acquireScope(request.presetId)
    } catch (error) {
      signal.throwIfAborted()
      const snapshot = await this.skills.snapshot({ cwd: workspace.path, signal })
      signal.throwIfAborted()
      return {
        ...this.project(snapshot),
        notice: 'Preset scope is unavailable; showing global skills.',
      }
    }

    try {
      signal.throwIfAborted()
      const snapshot = await this.skills.snapshot({ cwd: workspace.path, scope: lease.key, signal })
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
