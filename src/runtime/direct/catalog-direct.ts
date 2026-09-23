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

import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import { safeErrorMessage } from '../../error-boundary.ts'
import {
  copyModelSelection,
  normalizeModelSelection,
} from '../../model-selection.ts'
import type { OperationOwnership, OperationResult, WriteOutcome } from '../write-outcome.ts'
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
  ModelDirectoryDto,
  ModelDirectoryFailureDto,
  ModelDirectoryGroupDto,
  ModelDiscoveryRequest,
  ModelInfoSummary,
  ModelProviderSummary,
  ModelSelectionDto,
  PresetCatalog,
  PresetRosterDto,
  ProviderDirectoryEntry,
  SkillCatalogCapability,
  SkillDefinitionDto,
  SkillDefinitionResult,
} from '../catalog-port.ts'
import type { StandingSkillRead } from '../../skill-catalog-refresh.ts'
import type { ProviderCatalogEntry } from '../../provider-catalog.ts'
import { selectBlankSessionPreset } from './session-preset-direct.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on?(event: string, listener: unknown): unknown
}

/** The structural `llm` service surface the model directory reads. */
export interface LlmServiceLike {
  listProviders(): readonly { id: string; name: string }[]
  listModels(providerId: string): Promise<readonly { id: string; name?: string; description?: string }[]>
  resolveModelInfo(providerId: string, modelId: string): Promise<{
    readonly reasoning?: {
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }
  }>
  /** The official Host call-config resolution: provider/model validation plus
   *  reasoning-effort normalization. The Direct Session model write delegates
   *  validation and normalization to this Host-owned operation. */
  resolveCallConfig(config: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<{ readonly provider: string; readonly model: string; readonly reasoningEffort?: string }>
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

/** The structural `agentPresets` service surface (the 0.1.7 declarative
 * registry). `remoteExportList` is the PUBLIC official roster projection
 * (the `@Remote('list')` method — path-free rows, the Host-effective
 * default and the mode-selection policy from one snapshot); `select` is
 * the official blank-Session write. Identity is id-only: `trust`/`path`/
 * `authorable` are retired upstream and deliberately absent here. */
export interface AgentPresetsServiceLike {
  resolve(id?: string): Promise<AgentPreset>
  get defaultId(): string
  /** The public official roster projection: path-free rows + the
   *  Host-effective default + the deployment's mode-selection policy, read
   *  from ONE settings snapshot. */
  remoteExportList(): Promise<{
    readonly presets: readonly {
      readonly id: string
      readonly isDefault: boolean
      readonly name?: string
      readonly description?: string
      readonly broken?: string
    }[]
    readonly modeSelectionEnabled: boolean
  }>
  select?(agent: unknown, agentPreset: string): Promise<string>
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
    this.presets = new DirectPresetCatalog(ctx, agentFor)
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

  async loadDirectory(signal?: AbortSignal): Promise<ModelDirectoryDto> {
    // Direct read-abort parity (v2 §0.5): the caller-owned signal is honored
    // before any in-process registry work (the official registry calls are
    // signal-less, so this is an admission check).
    signal?.throwIfAborted()
    const llm = this.llm()
    // The deployment default is the one value the directory always carries
    // (official `buildModelCatalog` semantics): a Session with no local
    // selection observes it.
    const fallback = this.defaultSelection() ?? { provider: '', model: '' }
    if (llm === undefined) {
      return { default: fallback, routableProviders: [], groups: [], failures: [] }
    }
    const providers = llm.listProviders()
    // Providers load independently: one failing route becomes an isolated
    // failure row and never removes the successfully loaded groups.
    const loaded = await Promise.all(providers.map(async (provider): Promise<
      | { readonly kind: 'group'; readonly group: ModelDirectoryGroupDto }
      | { readonly kind: 'failure'; readonly failure: ModelDirectoryFailureDto }
    > => {
      try {
        const models = await llm.listModels(provider.id)
        const entries = await Promise.all(models.map(async model => {
          const info = await llm.resolveModelInfo(provider.id, model.id)
          const efforts = info.reasoning?.efforts
          const reasoning = efforts === undefined
            ? undefined
            : {
              efforts: efforts.map(effort => ({
                id: effort.id,
                name: effort.name,
                ...effort.description === undefined ? {} : { description: effort.description },
              })),
              ...info.reasoning?.defaultEffort === undefined
                ? {}
                : { defaultEffort: info.reasoning.defaultEffort },
            }
          return {
            id: model.id,
            name: model.name ?? model.id,
            ...model.description === undefined ? {} : { description: model.description },
            ...reasoning === undefined ? {} : { reasoning },
          }
        }))
        return { kind: 'group', group: { id: provider.id, name: provider.name, models: entries } }
      } catch (error) {
        // An abort is NOT a provider failure row: propagate the cancellation
        // so the read never returns a success DTO after the caller cancelled
        // (v2 §0.2.3).
        signal?.throwIfAborted()
        return {
          kind: 'failure',
          failure: { id: provider.id, name: provider.name, message: safeErrorMessage(error) },
        }
      }
    }))
    // Fence AFTER the batch await: a cancellation mid-read never publishes.
    signal?.throwIfAborted()
    return {
      default: fallback,
      routableProviders: providers.map(provider => provider.id),
      groups: loaded.flatMap(item => item.kind === 'group' ? [item.group] : [])
        .filter(group => group.models.length > 0),
      failures: loaded.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
    }
  }

  listProviders(): readonly ModelProviderSummary[] {
    // Provider-discovery capability: detached copies of the provider registry.
    return (this.llm()?.listProviders() ?? []).map(provider => ({ id: provider.id, name: provider.name }))
  }

  listModels(providerId: string): Promise<readonly ModelInfoSummary[]> {
    const llm = this.llm()
    if (llm === undefined) return Promise.resolve([])
    return llm.listModels(providerId).then(models => models.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
    })))
  }

  defaultSelection(): ModelSelectionDto | undefined {
    const selection = this.defaultModel()?.currentSelection()
    return copyModelSelection(normalizeModelSelection(selection))
  }

  saveDefaultSelection(selection: ModelSelectionDto): Promise<WriteOutcome<void>> {
    const next = normalizeModelSelection(selection)
    if (next === undefined) {
      return Promise.resolve({ kind: 'rejected', error: { code: 'session/model-invalid', message: 'invalid model selection' } })
    }
    const defaultModel = this.defaultModel()
    if (defaultModel === undefined) {
      return Promise.resolve({ kind: 'rejected', error: { code: 'session/model-unavailable', message: 'model selection service unavailable' } })
    }

    const generation = ++this.defaultWriteGeneration
    // Start immediately rather than serializing behind a hung older write. If
    // an older write settles after a newer one, its completion fences and
    // reasserts the newest COMMITTED value after all newer writes have settled.
    const write = Promise.resolve().then(() => defaultModel.saveSelection({ ...next }))
    this.latestWrite = write
    const fence = (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): Promise<WriteOutcome<void>> => {
      // Any successful write advances the committed target when its
      // generation is NEWER than the current committed one: a failed newer
      // attempt must never erase an older success, and a stale write's
      // success must never mark an older value as the committed target.
      if (outcome.ok && generation > this.committedGeneration) {
        this.committedGeneration = generation
        this.latestCommitted = { ...next }
      }
      // The correction is AWAITED as part of THIS write's settlement (never a
      // detached fire-and-forget): the caller that observes this promise knows
      // the newest committed value has been re-asserted, so a following
      // fresh-create admission can never read an older stale completion.
      return this.reassertLatest(generation).then((): WriteOutcome<void> => {
        if (outcome.ok) return { kind: 'committed', value: undefined }
        // A failed settings write may or may not have landed; the durable
        // commit state is not provable, so it stays indeterminate (never a
        // false rejection that would let a caller retry blind).
        return {
          kind: 'indeterminate',
          error: { code: 'session/model-default-indeterminate', message: safeErrorMessage(outcome.error) },
        }
      })
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

  async selectSessionModel(sessionId: string, selection: ModelSelectionDto, signal?: AbortSignal): Promise<OperationResult<ModelSelectionDto>> {
    const outcome = await this.selectSessionModelOutcome(sessionId, selection, signal)
    // Direct has no connection generation, but the caller abort IS its ownership
    // axis (v2 §0.2.1/§0.2.4): a PRE-commit abort is `cancelled + current`; a
    // proven settlement followed by an abort keeps the settlement and loses
    // local ownership (`committed|rejected|indeterminate + superseded`).
    return { ownership: ownershipOf(signal, outcome.kind), outcome }
  }

  private async selectSessionModelOutcome(sessionId: string, selection: ModelSelectionDto, signal?: AbortSignal): Promise<WriteOutcome<ModelSelectionDto>> {
    // A client-local cancellation BEFORE the durable append provably did not
    // commit (v2 §0.2.4).
    if (Boolean(signal?.aborted)) return { kind: 'cancelled' }
    const llm = this.llm()
    const agent = this.agentFor(sessionId)
    if (agent === undefined || this.modelSelections === undefined || llm === undefined) {
      // Without a live Agent / Direct owner there is no safe Session
      // projection to mutate: refuse instead of saving only the global
      // default (which would make the caller believe the Session changed).
      return {
        kind: 'rejected',
        error: { code: 'session/model-unavailable', message: 'session model selection unavailable' },
      }
    }
    // The Host owns provider/model validation and reasoning-effort
    // normalization (official `session.selectModel` semantics): resolve the
    // call config FIRST and commit the NORMALIZED result. An unavailable
    // model/effort is refused before any Session mutation.
    let resolved: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
    try {
      resolved = await llm.resolveCallConfig({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })
    } catch (error) {
      // An abort during normalization is a PROVEN PRE-commit cancellation (the
      // durable append has not happened) — never a bogus rejection.
      if (Boolean(signal?.aborted)) return { kind: 'cancelled' }
      return {
        kind: 'rejected',
        error: { code: 'session/model-unavailable', message: safeErrorMessage(error) },
      }
    }
    // Re-check AFTER the normalization await and BEFORE the durable append:
    // an abort during resolution provably did not commit.
    if (Boolean(signal?.aborted)) return { kind: 'cancelled' }
    const next = normalizeModelSelection({
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    })
    if (next === undefined) {
      return { kind: 'rejected', error: { code: 'session/model-invalid', message: 'invalid model selection' } }
    }
    // The durable append is the commit point: it throws on failure and the
    // Agent-local selection is untouched, so a failed choice can never be
    // observed by a request. Only after the append commits does the choice
    // become the Agent's pending selection.
    try {
      this.modelSelections.appendSelection(agent, next)
    } catch (error) {
      return {
        kind: 'rejected',
        error: { code: 'session/model-unavailable', message: safeErrorMessage(error) },
      }
    }
    this.modelSelections.setCurrent(agent, next)
    // The global-default save is best-effort and NEVER undoes the durable
    // Session choice (pinned official `session.selectModel` semantics: the
    // Host logs a default-save failure and still succeeds). A diagnostic is
    // recorded instead of a rejection.
    const defaultOutcome = await this.saveDefaultSelection(next)
    if (defaultOutcome.kind !== 'committed') {
      this.diag?.warn('model default save did not commit after the Session selection', {
        session: sessionId,
        kind: defaultOutcome.kind,
        ...defaultOutcome.kind === 'rejected' || defaultOutcome.kind === 'indeterminate'
          ? { error: defaultOutcome.error.message }
          : {},
      })
    }
    return { kind: 'committed', value: { ...next } }
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

/** The Direct agent-preset catalog (`ctx.agentPresets`): the roster read and
 * the official blank-Session selection write. */
export class DirectPresetCatalog implements PresetCatalog {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => unknown | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => unknown | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  private presets(): AgentPresetsServiceLike | undefined {
    return this.ctx.get('agentPresets') as AgentPresetsServiceLike | undefined
  }

  available(): boolean {
    return this.presets() !== undefined
  }

  async roster(signal?: AbortSignal): Promise<PresetRosterDto> {
    signal?.throwIfAborted()
    const presets = this.presets()
    if (presets === undefined) return { presets: [], modeSelectionEnabled: false }
    // The PUBLIC official roster projection (the `@Remote('list')` method):
    // path-free rows, the Host-effective default and the mode-selection
    // policy from ONE settings snapshot.
    const roster = await presets.remoteExportList()
    signal?.throwIfAborted()
    const defaultId = roster.presets.find(preset => preset.isDefault === true)?.id
    return {
      presets: roster.presets.map(preset => ({
        id: preset.id,
        ...preset.name === undefined ? {} : { name: preset.name },
        ...preset.description === undefined ? {} : { description: preset.description },
        ...preset.broken === undefined ? {} : { broken: preset.broken },
      })),
      ...defaultId === undefined ? {} : { defaultId },
      modeSelectionEnabled: roster.modeSelectionEnabled,
    }
  }

  async resolve(id?: string, signal?: AbortSignal): Promise<{ readonly id?: string }> {
    signal?.throwIfAborted()
    const presets = this.presets()
    // Rosterless deployment: no preset identity to record (the old compose
    // path returned `agentPreset: undefined`).
    if (presets === undefined) return {}
    // The official registry owns identity resolution: an unknown id is
    // refused by `resolve` itself, but a DECLARED preset whose activation
    // failed resolves successfully carrying `broken` — the official
    // `agent-preset/invalid` refusal only happens at mount/retain time.
    // This seam is the TUI's selectability gate (default saves, sessionless
    // staging, migration validation), so a broken row is refused HERE with
    // the official invalid semantics. A requested id — `code` included — is
    // an ordinary preset id; there is deliberately NO legacy alias.
    const preset = await presets.resolve(id)
    signal?.throwIfAborted()
    if (preset.broken !== undefined) {
      throw Object.assign(new Error(preset.broken), { code: 'agent-preset/invalid' })
    }
    return { id: preset.id }
  }

  defaultId(): string | undefined {
    // The registry's own merged policy (deployment default +
    // selectedDefault + mode selection) — never recomputed TUI-side.
    return this.presets()?.defaultId
  }

  async selectSessionPreset(sessionId: string, presetId: string, signal?: AbortSignal): Promise<OperationResult<{ readonly preset: string }>> {
    const outcome = await this.selectSessionPresetOutcome(sessionId, presetId, signal)
    return { ownership: ownershipOf(signal, outcome.kind), outcome }
  }

  private async selectSessionPresetOutcome(sessionId: string, presetId: string, signal?: AbortSignal): Promise<WriteOutcome<{ readonly preset: string }>> {
    // A client-local cancellation BEFORE the switch dispatch provably did not
    // commit (v2 §0.2.4/§0.5).
    if (Boolean(signal?.aborted)) return { kind: 'cancelled' }
    const presets = this.presets()
    if (presets === undefined || typeof presets.select !== 'function') {
      return {
        kind: 'rejected',
        error: { code: 'agent-preset/unavailable', message: 'agent presets unavailable in this deployment' },
      }
    }
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      return {
        kind: 'rejected',
        error: { code: 'session/not-found', message: `session "${sessionId}" is not live` },
      }
    }
    // The official in-process service owns the serialized switch, the blank
    // re-check, the recompose transaction and the durable
    // `agent-preset/selected` commit. Only an EXACT proven pre-commit refusal
    // code is `rejected`; an arbitrary failure (e.g. the durable append
    // throwing after the recompose already ran) is `indeterminate` — the
    // composition may have changed without the durable event landing.
    try {
      const preset = await selectBlankSessionPreset(this.ctx, agent, presetId)
      return { kind: 'committed', value: { preset } }
    } catch (error) {
      const code = presetErrorCode(error)
      if (code !== undefined && DIRECT_PRESET_REFUSAL_CODES.has(code)) {
        return { kind: 'rejected', error: { code, message: safeErrorMessage(error) } }
      }
      return {
        kind: 'indeterminate',
        error: { code: code ?? 'agent-preset/select-indeterminate', message: safeErrorMessage(error) },
      }
    }
  }
}

/** The Direct ownership axis: an abort AFTER a proven settlement leaves the
 *  settlement intact while the local surface is no longer owned. A pre-commit
 *  `cancelled` outcome already IS the cancellation, so it stays `current`. */
function ownershipOf(signal: AbortSignal | undefined, kind: WriteOutcome<unknown>['kind']): OperationOwnership {
  return signal?.aborted === true && kind !== 'cancelled' ? 'superseded' : 'current'
}

/** The official preset-switch refusal codes that PROVE no durable commit
 *  happened (blank re-check, id validation, roster resolution). */
const DIRECT_PRESET_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'agent-preset/locked',
  'agent-preset/not-found',
  'agent-preset/invalid',
  'gateway/bad-request',
])

/** Read the official `RemoteError` code off a refused preset write. */
function presetErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
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
    try {
      const catalog = await readHumanSkillCatalog(target.registry, { cwd: target.cwd, scope: target.scope, signal })
      return { catalog, ...resolution.degraded === undefined ? {} : { notice: resolution.degraded } }
    } finally {
      // The standing scope rides the official revision lease: release it
      // once the read settles, on every path.
      await resolution.release?.()
    }
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
