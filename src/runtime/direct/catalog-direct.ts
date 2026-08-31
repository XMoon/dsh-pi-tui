/**
 * The Direct catalog adapter (M1.8) — the in-process implementation of
 * `Catalog` over the dsh `llm` / `agentDefaultModel` / `agentPresets` /
 * `tools` services and the `src/skill-catalog.ts` seam. This is the ONLY
 * module in the catalog-read path that touches `ctx`; consumers
 * (commands.ts, the surface coordinator) depend on the port, and a Remote
 * adapter will implement the same interfaces in a later milestone.
 *
 * The skill sub-domain deliberately keeps the pure catalog logic in
 * `src/skill-catalog.ts` (snapshot-first reads, official invocation
 * policy, stable sort, deep freeze): this adapter only wires Host service
 * discovery and the session-id → live-agent resolution (runner-injected).
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/catalog-direct
 */

import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  copyModelSelection,
  normalizeModelSelection,
} from '../../model-selection.ts'
import type { SessionModelSelectionOwnerLike } from './model-selection-direct.ts'
import {
  readHumanSkillCatalog,
  resolveColdSkillTarget,
  resolveLiveSkillTarget,
  subscribeSkillsChange,
  type SkillCatalogContext,
  type SkillCatalogEventsContext,
  type SkillSummaryLike,
} from '../../skill-catalog.ts'
import type {
  Catalog,
  ModelCatalog,
  ModelDiscoveryRequest,
  ModelInfoSummary,
  ModelReasoningInfo,
  ModelSelectionDto,
  ModelProviderSummary,
  PresetCatalog,
  PresetRosterEntry,
  ProviderDirectoryEntry,
  SkillCatalogCapability,
  SkillDefinitionDto,
  SkillDefinitionResult,
} from '../catalog-port.ts'
import type { StandingSkillRead } from '../../skill-catalog-refresh.ts'
import type { ProviderCatalogEntry } from '../../provider-catalog.ts'
import { resolvePresetRequest } from '../session-preset.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on?(event: string, listener: unknown): unknown
}

/** The structural `llm` service surface the model catalog reads. */
export interface LlmServiceLike {
  listProviders(): readonly { id: string; name: string }[]
  listModels(providerId: string): Promise<readonly { id: string; name?: string }[]>
  resolveModelInfo(providerId: string, modelId: string): Promise<ModelReasoningInfo>
  discoverModels(settingsNs: string, request: ModelDiscoveryRequest): Promise<readonly { id: string; name?: string }[]>
  listConfigurableProviders(): readonly ProviderCatalogEntry[]
}

/** The structural `agentDefaultModel` service surface. */
export interface DefaultModelServiceLike {
  currentSelection(): ModelSelectionDto | undefined
  saveSelection(next: ModelSelectionDto): Promise<unknown>
}

/** The narrow diagnostic surface the model catalog reports fencing
 *  corrections through (structural — the runner's Diag satisfies it). */
export interface ModelDiagLike {
  warn(message: string, fields?: Record<string, unknown>): void
}

/** The structural `agentPresets` service surface. */
export interface AgentPresetsServiceLike {
  list(): Promise<readonly AgentPreset[]>
  resolve(id?: string): Promise<AgentPreset>
  get defaultId(): string
}

/** The structural `tools` service surface for the skill-loader probe. */
export interface ToolsServiceLike {
  get?(name: string, agent: unknown): { execute?: unknown; parameters?: unknown } | undefined
}

/** A live agent as the skill sub-domain reads it (structural projection:
 * the scope context and the workspace cwd). */
export interface LiveAgentLike {
  readonly ctx: unknown
  readonly session: { readonly header: { readonly cwd?: string } }
}

/** The Direct backend's catalog: the `ctx` services behind the semantic
 * `Catalog` interfaces. */
export class DirectCatalogPort implements Catalog {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined

  readonly models: ModelCatalog
  readonly presets: PresetCatalog
  readonly skills: SkillCatalogCapability

  constructor(
    ctx: HostContextLike,
    agentFor: (sessionId: string) => unknown | undefined,
    modelSelections?: SessionModelSelectionOwnerLike,
    diag?: ModelDiagLike,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
    this.models = new DirectModelCatalog(ctx, agentFor, modelSelections, diag)
    this.presets = new DirectPresetCatalog(ctx)
    this.skills = new DirectSkillCatalog(ctx, agentFor)
  }
}

/** The session workspace of one live agent (the header cwd, falling back
 * to the process cwd — in Direct mode the Client machine IS the Host
 * machine). */
function agentCwd(agent: LiveAgentLike): string {
  return agent.session.header.cwd ?? process.cwd()
}

/** The Direct model/provider catalog (`ctx.llm` + `ctx.agentDefaultModel`). */
export class DirectModelCatalog implements ModelCatalog {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined
  private readonly modelSelections: SessionModelSelectionOwnerLike | undefined
  private readonly diag: ModelDiagLike | undefined
  /** Fence overlapping default writes so the newest choice wins persistence. */
  private defaultWriteGeneration = 0
  /** The generation of the newest SUCCESSFULLY committed default. Any
   *  successful write with a NEWER generation advances it, so a failed
   *  newer attempt never erases an older success (the correction target
   *  stays the newest committed value). */
  private committedGeneration = 0
  /** The newest SUCCESSFULLY committed default (the correction target). A
   *  failed attempt is never recorded here, so a failed choice can never be
   *  resurrected by a stale-write correction. */
  private latestCommitted: ModelSelectionDto | undefined
  private latestWrite: Promise<unknown> = Promise.resolve()

  constructor(
    ctx: HostContextLike,
    agentFor: (sessionId: string) => unknown | undefined = () => undefined,
    modelSelections?: SessionModelSelectionOwnerLike,
    diag?: ModelDiagLike,
  ) {
    this.ctx = ctx
    this.agentFor = agentFor
    this.modelSelections = modelSelections
    this.diag = diag
  }

  private llm(): LlmServiceLike | undefined {
    return this.ctx.get('llm') as LlmServiceLike | undefined
  }

  private defaultModel(): DefaultModelServiceLike | undefined {
    return this.ctx.get('agentDefaultModel') as DefaultModelServiceLike | undefined
  }

  available(): boolean {
    return this.llm() !== undefined && this.defaultModel() !== undefined
  }

  listProviders(): readonly ModelProviderSummary[] {
    // Detached copies — the provider registry's array is Host-owned.
    return (this.llm()?.listProviders() ?? []).map(provider => ({
      id: provider.id,
      name: provider.name,
    }))
  }

  listModels(providerId: string): Promise<readonly ModelInfoSummary[]> {
    const llm = this.llm()
    if (llm === undefined) return Promise.resolve([])
    return llm.listModels(providerId).then(models => models.map(model => ({
      id: model.id,
      ...typeof model.name === 'string' ? { name: model.name } : {},
    })))
  }

  async resolveModelInfo(providerId: string, modelId: string): Promise<ModelReasoningInfo> {
    const llm = this.llm()
    if (llm === undefined) return {}
    const info = await llm.resolveModelInfo(providerId, modelId)
    // Detached copy of the reasoning metadata.
    const efforts = info.reasoning?.efforts
    if (efforts === undefined) return {}
    return { reasoning: { efforts: efforts.map(effort => ({
      id: effort.id,
      name: effort.name,
      ...typeof effort.description === 'string' ? { description: effort.description } : {},
    })) } }
  }

  defaultSelection(): ModelSelectionDto | undefined {
    const selection = this.defaultModel()?.currentSelection()
    return copyModelSelection(normalizeModelSelection(selection))
  }

  saveDefaultSelection(selection: ModelSelectionDto): Promise<unknown> {
    const next = normalizeModelSelection(selection)
    if (next === undefined) return Promise.reject(new Error('invalid model selection'))
    const defaultModel = this.defaultModel()
    if (defaultModel === undefined) return Promise.reject(new Error('model selection service unavailable'))

    const generation = ++this.defaultWriteGeneration
    // Start immediately rather than serializing behind a hung older write. If
    // an older write settles after a newer one, its completion fences and
    // reasserts the newest COMMITTED value after all newer writes have settled.
    const write = Promise.resolve().then(() => defaultModel.saveSelection({ ...next }))
    this.latestWrite = write
    const fence = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): Promise<unknown> => {
      // Any successful write advances the committed target when its
      // generation is NEWER than the current committed one: a failed newer
      // attempt must never erase an older success, and a stale write's
      // success must never mark an older value as the committed target.
      if (outcome.ok && generation > this.committedGeneration) {
        this.committedGeneration = generation
        this.latestCommitted = { ...next }
      }
      // Reassert asynchronously: the caller must observe this write's own
      // result promptly, while the detached correction protects persistence
      // when an older write settles after a newer one.
      void this.reassertLatest(generation).catch(() => undefined) // allowlist: fenced latest-write correction
      return outcome.ok ? Promise.resolve(outcome.value) : Promise.reject(outcome.error)
    }
    return write.then(
      value => fence({ ok: true, value }),
      error => fence({ ok: false, error }),
    )
  }

  private async reassertLatest(generation: number): Promise<void> {
    while (generation !== this.defaultWriteGeneration) {
      const observedGeneration = this.defaultWriteGeneration
      const observedWrite = this.latestWrite
      await observedWrite.catch(() => undefined)
      if (observedGeneration !== this.defaultWriteGeneration) continue
      const latest = this.latestCommitted
      const defaultModel = this.defaultModel()
      if (latest === undefined || defaultModel === undefined) return
      try {
        await defaultModel.saveSelection({ ...latest })
      } catch (error) {
        // A failed correction leaves the durable default stale until the
        // next save reasserts it; report the failure instead of swallowing
        // it (the caller still observes its own write's result).
        this.diag?.warn('model default correction failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      // Mark the generation we just reasserted as observed. A newer selection
      // could have started while the correction was in flight; the loop then
      // observes that newer generation and reasserts it instead.
      generation = observedGeneration
    }
  }

  sessionSelection(sessionId: string): ModelSelectionDto | undefined {
    const agent = this.agentFor(sessionId)
    if (agent === undefined || this.modelSelections === undefined) return undefined
    return copyModelSelection(normalizeModelSelection(this.modelSelections.current(agent)))
  }

  async selectSessionModel(sessionId: string, selection: ModelSelectionDto): Promise<ModelSelectionDto> {
    const next = normalizeModelSelection(selection)
    if (next === undefined) throw new Error('invalid model selection')
    const agent = this.agentFor(sessionId)
    if (agent === undefined) throw new Error('session model selection unavailable')
    if (this.modelSelections === undefined) {
      // Without the Direct owner there is no safe Session projection to
      // mutate: fail loudly instead of silently saving only the global
      // default (which would make the caller believe the Session changed).
      throw new Error('session model selection unavailable')
    }
    // The durable append is the commit point: it throws on failure and the
    // Agent-local selection is untouched, so a failed choice can never be
    // observed by a request. Only after the append commits does the choice
    // become the Agent's pending selection; the global-default write is
    // best-effort and never undoes the durable Session choice.
    this.modelSelections.appendSelection(agent, next)
    this.modelSelections.setCurrent(agent, next)
    await this.saveDefaultSelection(next)
    return { ...next }
  }

  /** @deprecated Use {@link defaultSelection}. */
  currentSelection(): ModelSelectionDto | undefined {
    return this.defaultSelection()
  }

  /** @deprecated Use {@link saveDefaultSelection}. */
  saveSelection(selection: ModelSelectionDto): Promise<unknown> {
    return this.saveDefaultSelection(selection)
  }

  discoverModels(request: ModelDiscoveryRequest): Promise<readonly ModelInfoSummary[]> {
    const llm = this.llm()
    if (llm === undefined) return Promise.resolve([])
    // The llm-pi-ai settings namespace is adapter-owned schema knowledge —
    // the wizard never names it (plan §6.3).
    return llm.discoverModels('llm-pi-ai', request).then(models => models.map(model => ({
      id: model.id,
      ...typeof model.name === 'string' ? { name: model.name } : {},
    })))
  }

  listConfigurableProviders(): readonly ProviderDirectoryEntry[] | undefined {
    // Detached SEMANTIC copies — the provider id/display name/declared
    // state only; the settings namespace/path layout never crosses the
    // catalog contract (the config adapter owns the Host schema, M1.9).
    return this.llm()?.listConfigurableProviders().map(entry => ({
      id: entry.provider,
      displayName: entry.displayName,
      ...entry.declared === undefined ? {} : { declared: entry.declared },
    }))
  }
}

/** The Direct agent-preset catalog (`ctx.agentPresets`, read side only). */
export class DirectPresetCatalog implements PresetCatalog {
  private readonly ctx: HostContextLike

  constructor(ctx: HostContextLike) {
    this.ctx = ctx
  }

  private presets(): AgentPresetsServiceLike | undefined {
    return this.ctx.get('agentPresets') as AgentPresetsServiceLike | undefined
  }

  available(): boolean {
    return this.presets() !== undefined
  }

  async list(): Promise<readonly PresetRosterEntry[]> {
    const presets = this.presets()
    if (presets === undefined) return []
    const roster = await presets.list()
    return roster.map(preset => ({
      id: preset.id,
      trust: preset.trust,
      ...preset.name === undefined ? {} : { name: preset.name },
      ...preset.description === undefined ? {} : { description: preset.description },
      ...preset.broken === undefined ? {} : { broken: preset.broken },
    }))
  }

  async resolve(id?: string): Promise<{ readonly id?: string }> {
    const presets = this.presets()
    // Rosterless deployment: no preset identity to record (the old compose
    // path returned `agentPreset: undefined`).
    if (presets === undefined) {
      if (id === 'code') throw new Error('preset "code" is unavailable in this deployment; use a configured preset')
      return {}
    }
    // An omitted id means "use the persisted deployment default". DSH allows
    // a user preset literally named `code`, so probe that real roster entry
    // before applying the old pi-tui default-data compatibility mapping.
    const preset = await resolvePresetRequest(presets, id)
    return { id: preset.id }
  }

  defaultId(): string | undefined {
    // This synchronous projection cannot inspect the async roster. Preserve a
    // literal `code`; callers resolving a persisted default use resolve(),
    // which disambiguates a real custom entry from old TUI data.
    return this.presets()?.defaultId
  }
}

/** The Direct skill catalog (`ctx.skills` / `ctx.agentPresets` /
 * `ctx.tools` behind the `src/skill-catalog.ts` seam). */
export class DirectSkillCatalog implements SkillCatalogCapability {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => unknown | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  private liveAgent(sessionId: string): LiveAgentLike | undefined {
    return this.agentFor(sessionId) as LiveAgentLike | undefined
  }

  async standing(presetId: string | undefined, cwd: string, signal?: AbortSignal): Promise<StandingSkillRead> {
    const resolution = await resolveColdSkillTarget(this.ctx as unknown as SkillCatalogContext, presetId, cwd)
    const target = resolution.target
    if (target === undefined) throw new Error('skill service unavailable')
    const catalog = await readHumanSkillCatalog(target.registry, { cwd: target.cwd, scope: target.scope, signal })
    return { catalog, ...resolution.degraded === undefined ? {} : { notice: resolution.degraded } }
  }

  async listHumanSkills(sessionId: string, signal?: AbortSignal): Promise<import('../../skill-catalog.ts').HumanSkillCatalog | undefined> {
    const agent = this.liveAgent(sessionId)
    if (agent === undefined) return undefined
    const target = resolveLiveSkillTarget(this.ctx as unknown as SkillCatalogContext, agent, agentCwd(agent))
    if (target === undefined) return undefined
    return readHumanSkillCatalog(target.registry, { cwd: target.cwd, scope: target.scope, signal })
  }

  async resolveSkill(sessionId: string, name: string): Promise<SkillDefinitionResult> {
    const agent = this.liveAgent(sessionId)
    if (agent === undefined) return { kind: 'unavailable' }
    const target = resolveLiveSkillTarget(this.ctx as unknown as SkillCatalogContext, agent, agentCwd(agent))
    if (target === undefined) return { kind: 'unavailable' }
    const skill = await target.registry.get?.(name, { cwd: target.cwd, scope: target.scope })
    if (skill === undefined) return { kind: 'unknown' }
    const definition = toSkillDefinitionDto(skill)
    if (definition === undefined) return { kind: 'malformed' }
    return { kind: 'found', skill: definition }
  }

  hostLoadsSkillBody(sessionId: string): boolean {
    const agent = this.liveAgent(sessionId)
    if (agent === undefined) return false
    const tools = this.ctx.get('tools') as ToolsServiceLike | undefined
    const loader = tools?.get?.('skill', agent)
    return loader !== undefined && typeof loader.execute === 'function'
  }

  onSkillsChange(listener: () => void): void {
    subscribeSkillsChange(this.ctx as unknown as SkillCatalogEventsContext, listener)
  }
}

/** Copy ONE loaded skill into the detached definition DTO — only the
 * fields the invocation path reads, never the registry object. Returns
 * undefined for a malformed definition (the consumer's hostile-field
 * guard: only string display fields may cross; nothing is coerced). */
function toSkillDefinitionDto(skill: SkillSummaryLike): SkillDefinitionDto | undefined {
  if (typeof skill.name !== 'string' || skill.name === '' || typeof skill.description !== 'string') return undefined
  return {
    name: skill.name,
    description: skill.description,
    ...typeof skill.content === 'string' ? { content: skill.content } : {},
    ...typeof skill.provider === 'string' ? { provider: skill.provider } : {},
    ...skill.resourceBase === undefined ? {} : { resourceBase: detachedResourceBase(skill.resourceBase) },
    ...skill.invocation === undefined ? {} : { invocation: detachedInvocation(skill.invocation) },
  }
}

/** Detached copy of the opaque resource base (the consumer validates the
 * shape). Resource metadata may contain nested provider-owned objects, so a
 * shallow spread is insufficient for the DTO boundary. Non-JSON values are
 * refused rather than leaking a live Host object. */
function detachedResourceBase(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/** Detached copy of the invocation policy flags. Only booleans are valid
 * policy values; refusing arbitrary objects also prevents nested aliasing. */
function detachedInvocation(value: unknown): { modelInvocable?: unknown; userInvocable?: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return {
    ...typeof record.modelInvocable === 'boolean' ? { modelInvocable: record.modelInvocable } : {},
    ...typeof record.userInvocable === 'boolean' ? { userInvocable: record.userInvocable } : {},
  }
}
