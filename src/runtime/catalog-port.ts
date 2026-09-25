/**
 * The catalog domain port (M1.8, converged in D2.3) — the semantic contract
 * between the TUI and the Host-owned catalogs it READS and, for presets and
 * models, WRITES: models/providers, agent presets and skills. Implemented by
 * `src/runtime/direct/` (Direct) today and by the experimental Remote
 * adapters (D2.3). The port deliberately exposes detached DTOs and semantic
 * operations, never Host service objects (`ctx.llm`, `ctx.agentPresets`,
 * `ctx.skills`, `ctx.tools`, an Agent, a standing-scope object, a setup
 * callback): a consumer sees only serializable catalog data plus the business
 * operations that act on it.
 *
 * Domain split (plan §5): the three sub-domains stay separate narrow
 * interfaces under one `Catalog` assembly — consumers take only the
 * sub-interface they need, never a god object.
 *
 * D2.3 model convergence: the directory read matches the official
 * `session.modelCatalog()` generation snapshot (`default`, routable providers,
 * grouped models, isolated provider failures) instead of N in-process
 * registry calls, and the Session model write settles through the shared
 * `WriteOutcome` vocabulary.
 *
 * D2.3 preset convergence: the roster read carries the Host-effective default
 * beside path-free rows, and the blank-Session selection is one official
 * semantic write.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/catalog-port
 */

import type { HumanSkillCatalog } from '../skill-catalog.ts'
import type { StandingSkillRead } from '../skill-catalog-refresh.ts'
import type { OperationResult, WriteOutcome } from './write-outcome.ts'

/** One model row of the Host-generation model directory (mirrors the official
 * `ModelCatalogModel`). */
export interface ModelDirectoryModelDto {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
    readonly defaultEffort?: string
  }
}

/** One provider group of successfully loaded models. */
export interface ModelDirectoryGroupDto {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelDirectoryModelDto[]
}

/** One provider whose model catalog lookup failed (the isolated failure the
 * official catalog keeps beside the usable groups). */
export interface ModelDirectoryFailureDto {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** The Host-generation model directory — the semantic equivalent of the
 * official `session.modelCatalog()` value. */
export interface ModelDirectoryDto {
  /** The selection an unconfigured Session observes. */
  readonly default: ModelSelectionDto
  /** Provider routes currently able to serve a request, including empty
   * catalogs (advisory: a route may serve a model it stopped advertising). */
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelDirectoryGroupDto[]
  readonly failures: readonly ModelDirectoryFailureDto[]
}

/** A detached provider/model/effort selection value. The meaning is
 * explicit at each port method: it is either the global default used as a
 * fallback for new Sessions or the effective selection of one Session.
 * `reasoningEffort` is a plain string in the DTO — the caller's branded
 * effort id is structurally assignable. */
export interface ModelSelectionDto {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One model row returned by provider discovery (the add-provider wizard). */
export interface ModelInfoSummary {
  readonly id: string
  readonly name?: string
}

/** The endpoint probe request the add-provider wizard performs (a
 *  one-shot discovery call; the apiKey is a deliberate write-side request
 *  parameter — it never appears in any returned DTO). */
export interface ModelDiscoveryRequest {
  readonly provider?: string
  readonly baseURL?: string
  readonly api?: string
  readonly apiKey?: string
  readonly signal?: AbortSignal
}

/** One provider row for the provider-discovery capability. */
export interface ModelProviderSummary {
  readonly id: string
  readonly name: string
}

/** The model/provider catalog sub-domain: the `/model` directory read, the
 *  Session-local selection write, the provider directory the `/login` merge
 *  reads, and the add-provider endpoint probe. */
export interface ModelCatalog {
  /** Whether the model services are available at all (the /model
   *  unavailability gate: both the llm and the default-model service). */
  available(): boolean
  /** Load the Host-generation model directory (one semantic read matching
   *  the official `session.modelCatalog()`), including the deployment default
   *  used by a Session with no local selection. */
  loadDirectory(signal?: AbortSignal): Promise<ModelDirectoryDto>
  /** Provider-discovery capability (the subagent allowlist picker and the
   *  `/login` merge), DISTINCT from the `/model` directory read: it
   *  enumerates routable providers one call at a time. */
  listProviders(): readonly ModelProviderSummary[]
  /** One provider's models for provider-discovery consumers. */
  listModels(providerId: string): Promise<readonly ModelInfoSummary[]>
  /** The global default used only when a Session has no local selection. */
  defaultSelection(): ModelSelectionDto | undefined
  /** Persist the global default (`agentDefaultModel.saveSelection`) as a
   *  semantic settlement: a proven pre-write refusal is `rejected`, an
   *  ambiguous write failure is `indeterminate`, and the Remote backend (which
   *  has no TUI global-default write) is `unsupported`. */
  saveDefaultSelection(selection: ModelSelectionDto): Promise<WriteOutcome<void>>
  /** The effective selection of one currently live ordinary Session. */
  sessionSelection(sessionId: string): ModelSelectionDto | undefined
  /** Select the next model for one Session. The Host owns provider/model
   *  validation, reasoning-effort normalization, the durable Session-local
   *  commit and the best-effort global-default save; a failed default save
   *  does NOT undo a committed Session selection. */
  selectSessionModel(sessionId: string, selection: ModelSelectionDto, signal?: AbortSignal): Promise<OperationResult<ModelSelectionDto>>
  /** Probe an endpoint for its advertised models (the add wizard). */
  discoverModels(request: ModelDiscoveryRequest): Promise<readonly ModelInfoSummary[]>
  /** The configurable-provider directory the /login merge reads
   *  (`llm.listConfigurableProviders()`); undefined = the llm service is
   *  absent (the merge falls back to the settings-only reader). The DTO is
   *  SEMANTIC — the settings namespace/path layout (WHERE a profile
   *  lives) is config schema knowledge, owned by the config adapter
   *  (migration M1.9), never a shared catalog concern. */
  listConfigurableProviders(): readonly ProviderDirectoryEntry[] | undefined
}

/** One configurable-provider directory row (detached semantic DTO —
 * never a settings namespace/path: the catalog consumer only asks WHICH
 * providers exist; the config adapter owns the Host schema layout). */
export interface ProviderDirectoryEntry {
  readonly id: string
  readonly displayName: string
  readonly declared?: boolean
}

/** One roster row of the `/preset` picker (detached display metadata). */
export interface PresetRosterEntry {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Why the preset cannot compose a session (absent when it can). */
  readonly broken?: string
}

/** The agent-preset roster read: path-free rows beside the Host-effective
 * default (mirrors the official rc.2 `agentPresets.list` roster, which no
 * longer declares a deployment mode-selection policy). */
export interface PresetRosterDto {
  readonly presets: readonly PresetRosterEntry[]
  /** The preset id a caller naming none composes on. */
  readonly defaultId?: string
}

/** The agent-preset catalog sub-domain: what exists, what resolves, what the
 *  deployment default is, and the blank-Session selection write. Composition
 *  (`compose`/`setup`) is NOT here — the Direct session lifecycle resolves the
 *  setup internally from the preset id (M1.5), and command handlers only ever
 *  need the concrete preset identity. */
export interface PresetCatalog {
  /** Whether the deployment composes a preset roster at all. */
  available(): boolean
  /** Every preset the configured roots currently supply, beside the
   *  Host-effective default. */
  roster(signal?: AbortSignal): Promise<PresetRosterDto>
  /** Resolve one preset id (undefined = the deployment default). Returns
   *  the CONCRETE id (undefined ONLY when the deployment composes no
   *  roster — the /new meta then carries no preset, exactly like the old
   *  compose path); a composition setup callback never crosses the port.
   *  Throws when the roster exists but no configured root supplies the
   *  id. */
  resolve(id?: string, signal?: AbortSignal): Promise<{ readonly id?: string }>
  /** The preset id mounted when a caller names none. */
  defaultId(): string | undefined
  /** Select the preset for one still-blank Session. The Host owns the blank
   *  check, the serialized recompose transaction and the durable
   *  `agent-preset/selected` commit. */
  selectSessionPreset(sessionId: string, presetId: string, signal?: AbortSignal): Promise<OperationResult<{ readonly preset: string }>>
}

/** The loaded definition of one skill, detached to the fields the
 *  invocation path reads (display, the injected body, the invocation
 *  policy). `resourceBase` is opaque (validated by the consumer); the
 *  `invocation` policy rides along so the consumer can RE-check the
 *  user-invocation rule at execution time. */
export interface SkillDefinitionDto {
  readonly name: string
  readonly description: string
  readonly content?: string
  readonly provider?: string
  readonly resourceBase?: unknown
  readonly invocation?: { readonly modelInvocable?: unknown; readonly userInvocable?: unknown }
}

/** The outcome of loading ONE skill for execution (each kind maps to the
 *  user-facing text of the current /skill path). */
export type SkillDefinitionResult =
  | { readonly kind: 'found'; readonly skill: SkillDefinitionDto }
  /** No skill registry is reachable for the session. */
  | { readonly kind: 'unavailable' }
  /** The registry is reachable but knows no such skill. */
  | { readonly kind: 'unknown' }
  /** The loaded definition is malformed (hostile/adapter data refused). */
  | { readonly kind: 'malformed' }

/** The skill catalog sub-domain: sessionless standing reads, live agent
 *  reads, the loaded-definition path and the host-vs-fallback injection
 *  decision. The pure catalog logic stays in `src/skill-catalog.ts`; the
 *  Direct adapter owns the Host service discovery and the session-id →
 *  live-agent resolution. */
export interface SkillCatalogCapability {
  /** The sessionless STANDING skill catalog of one preset (the deferred
   *  start, `/reload` and the `/preset` standing refresh). Never creates
   *  an Agent/session/turn. */
  standing(presetId: string | undefined, cwd: string, signal?: AbortSignal): Promise<StandingSkillRead>
  /** The live agent's human-invocable skill catalog (the `/skill` picker).
   *  `undefined` = no skill registry reachable for the session. */
  listHumanSkills(sessionId: string, signal?: AbortSignal): Promise<HumanSkillCatalog | undefined>
  /** Load ONE skill definition for the live session (the execution path;
   *  the caller RE-checks the invocation policy on the returned DTO). */
  resolveSkill(sessionId: string, name: string): Promise<SkillDefinitionResult>
  /** Whether the HOST's pre-step skill loader is visible to the session's
   *  agent (the double-injection guard: when true, the TUI leaves the
   *  body injection to the host; when false, the TUI falls back). */
  hostLoadsSkillBody(sessionId: string): boolean
  /** Subscribe to the dsh-skill invalidation notification (the adapter
   *  owns the event wiring; a throwing subscribe may propagate — the
   *  caller degrades to no subscription). */
  onSkillsChange(listener: () => void): void
}

/** The catalog assembly — one narrow sub-interface per catalog domain.
 *  Consumers depend on the sub-interface they use, never on the whole
 *  assembly. */
export interface Catalog {
  readonly models: ModelCatalog
  readonly presets: PresetCatalog
  readonly skills: SkillCatalogCapability
}
