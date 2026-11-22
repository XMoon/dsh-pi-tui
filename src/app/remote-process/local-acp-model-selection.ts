/**
 * Session-only model configuration for the Host-owned ACP Session View.
 *
 * This is the narrow internal Host service behind the ACP v1
 * `session/set_config_option` subset. It reads the official Host model catalog
 * and the exact attached Agent's `model.current()` and writes ONLY the Session's
 * official `model/selection` through `agent.model.select()`. It never calls
 * `sessionController.selectModel` and never touches the profile default model
 * (`agentDefaultModel.saveSelection`), so an ACP model change cannot alter the
 * TUI's "Save as Default" behavior or a later Session's creation fallback.
 *
 * The service owns no durable model map: every read re-reads the Host catalog,
 * every write revalidates the exact Agent/Session identity, the fast-fail idle
 * phase and the selection baseline captured before the catalog await. The
 * `runMaintenance` callback performs no provider I/O or other await: all
 * remote validation happens OUTSIDE the maintenance window so a slow catalog
 * read can never block a real TUI turn behind the Agent's maintenance phase.
 *
 * @module app/remote-process/local-acp-model-selection
 */

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'

/** The stable model-configuration failure codes carried on the ACP wire. */
export type AcpModelErrorCode =
  /** Unknown configId/value shape, boolean request, unknown or placeholder option. */
  | 'LOCAL_ACP_MODEL_INVALID_OPTION'
  /** The Host catalog/LLM service is unavailable or the requested model is offline. */
  | 'LOCAL_ACP_MODEL_UNAVAILABLE'
  /** This ACP View still has an unsettled prompt flight. */
  | 'LOCAL_ACP_MODEL_VIEW_BUSY'
  /** The exact Agent is running or already owns a maintenance window. */
  | 'LOCAL_ACP_MODEL_AGENT_BUSY'
  /** The View, Agent or Session identity changed while the request was in flight. */
  | 'LOCAL_ACP_MODEL_STALE'
  /** Another client committed a different Session model during validation. */
  | 'LOCAL_ACP_MODEL_CONFLICT'

const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_MODEL_UNAVAILABLE = -32042
const JSONRPC_MODEL_BUSY = -32046

/** One classified model-configuration rejection. */
export class AcpModelError extends Error {
  readonly code: AcpModelErrorCode
  readonly rpcCode: number
  readonly data: Readonly<Record<string, unknown>>

  constructor(
    code: AcpModelErrorCode,
    message: string,
    rpcCode: number,
    data: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'AcpModelError'
    this.code = code
    this.rpcCode = rpcCode
    this.data = data
  }
}

/** One detached model selection; absence of effort follows the adapter default. */
export interface AcpModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One adapter-owned reasoning effort from the official Host catalog. */
export interface AcpModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Official selectable reasoning metadata of one exact model route. */
export interface AcpModelReasoning {
  readonly efforts: readonly AcpModelReasoningEffort[]
  readonly defaultEffort?: string
}

/** One model in the official Host provider-grouped catalog. */
export interface AcpModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: AcpModelReasoning
}

/** One successful provider group of the official Host model catalog. */
export interface AcpModelCatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly AcpModelCatalogModel[]
}

/** One provider whose catalog lookup failed; its models are not available now. */
export interface AcpModelCatalogFailure {
  readonly id: string
}

/** The official Host model catalog facts this service reads. */
export interface AcpModelCatalog {
  readonly groups: readonly AcpModelCatalogGroup[]
  readonly failures?: readonly AcpModelCatalogFailure[]
}

/** The exact live Agent surface this service is allowed to touch. */
export interface AcpModelAgent {
  /** The live Agent id (== the Session id). */
  readonly id: string
  readonly model: {
    current(): AcpModelSelection | undefined
    select(selection: AcpModelSelection): void
  }
  readonly status: 'idle' | 'running'
  /** Official maintenance phase admission; throws synchronously when not idle. */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/**
 * The official Host seams bound once by `local-host-entry.ts`. This module
 * never receives a Context, a registry or a generic config editor.
 */
export interface AcpModelHost {
  modelCatalog(): Promise<AcpModelCatalog>
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(providerId: string): Promise<readonly { readonly id: string; readonly name: string }[]>
  resolveCallConfig(selection: AcpModelSelection, signal?: AbortSignal): Promise<AcpModelSelection>
  currentAgent(sessionId: string): AcpModelAgent | undefined
  currentSession(sessionId: string): object | undefined
}

/** One ACP `session/set_config_option` selection request. */
export interface AcpModelOptionRequest {
  readonly configId: string
  /** The SDK's optional `type:'boolean'` discriminator (always rejected here). */
  readonly type?: string
  readonly value: unknown
}

/**
 * The exact attached-View admission result for one model write:
 * `view-busy` means this View already owns an unsettled prompt obligation;
 * `stale` means the original claim/Agent/Session identity is gone.
 */
export type AcpModelCurrentness = 'current' | 'view-busy' | 'stale'

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'
const MODEL_OPTION_NAME = 'Model'
const THOUGHT_LEVEL_OPTION_NAME = 'Reasoning effort'
const MODEL_DEFAULT_EFFORT_NAME = 'Model default'
const CURRENT_MODEL_PLACEHOLDER = 'Current (unavailable) — choose another model'
const CURRENT_EFFORT_PLACEHOLDER = 'Current effort (unavailable)'
const NO_MODEL_PLACEHOLDER = 'No model selected'
const UNAVAILABLE_GROUP_NAME = 'Unavailable'

/** Encode one exact model route as an opaque ACP select value. */
function modelValue(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId])
}

/** Encode the "omit explicit effort, use the adapter default" choice. */
function defaultEffortValue(): string {
  return JSON.stringify(['default'])
}

/** Encode one explicit official reasoning effort id. */
function effortValue(effortId: string): string {
  return JSON.stringify(['effort', effortId])
}

/** Presentation-only selector value for a current effort the catalog no longer advertises. */
function unavailableEffortValue(effortId: string): string {
  return JSON.stringify(['unavailable', effortId])
}

/** The one internal presentation-only value that no valid model route uses. */
const UNSET_MODEL_VALUE = JSON.stringify(['unset'])

function invalidOption(message: string): AcpModelError {
  return new AcpModelError('LOCAL_ACP_MODEL_INVALID_OPTION', message, JSONRPC_INVALID_PARAMS)
}

function modelUnavailable(message: string): AcpModelError {
  return new AcpModelError('LOCAL_ACP_MODEL_UNAVAILABLE', message, JSONRPC_MODEL_UNAVAILABLE)
}

function agentBusy(): AcpModelError {
  return new AcpModelError('LOCAL_ACP_MODEL_AGENT_BUSY', 'the session agent is busy', JSONRPC_MODEL_BUSY)
}

function viewBusy(): AcpModelError {
  return new AcpModelError(
    'LOCAL_ACP_MODEL_VIEW_BUSY',
    'a prompt is already in flight for this session view',
    JSONRPC_MODEL_BUSY,
  )
}

function staleSelection(): AcpModelError {
  return new AcpModelError('LOCAL_ACP_MODEL_STALE', 'the attached session changed during the model request', JSONRPC_MODEL_UNAVAILABLE)
}

function conflictingSelection(): AcpModelError {
  return new AcpModelError('LOCAL_ACP_MODEL_CONFLICT', 'the session model changed during the request', JSONRPC_MODEL_BUSY)
}

/** A detached copy so a later Agent mutation can never rewrite the baseline. */
function copySelection(selection: AcpModelSelection | undefined): AcpModelSelection | undefined {
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/** Compare the complete selection; an absent effort is its own value. */
function sameSelection(left: AcpModelSelection | undefined, right: AcpModelSelection | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function parseModelValue(value: unknown): { readonly provider: string; readonly model: string } | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const [provider, model] = parsed
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

type ParsedEffortValue =
  | { readonly kind: 'default' }
  | { readonly kind: 'effort'; readonly effortId: string }

function parseEffortValue(value: unknown): ParsedEffortValue | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  if (parsed.length === 1 && parsed[0] === 'default') return { kind: 'default' }
  if (parsed.length === 2 && parsed[0] === 'effort' && typeof parsed[1] === 'string' && parsed[1].length > 0) {
    return { kind: 'effort', effortId: parsed[1] }
  }
  return undefined
}

/** The one detached projection of a catalog read; no caller may mutate it. */
interface ProjectedModelState {
  readonly options: SessionConfigOption[]
  /** Selectable model values mapped to their exact detached route. */
  readonly modelChoices: ReadonlyMap<string, AcpModelSelection>
  /** Reasoning metadata by exact model value. */
  readonly reasoningByModel: ReadonlyMap<string, AcpModelReasoning>
  /** Presentation-only values (current placeholders) that must never be submitted. */
  readonly presentationOnlyValues: ReadonlySet<string>
}

/**
 * Project one official catalog plus the exact current selection into the full
 * standard ACP option list. Pure and detached: every call re-reads the caller's
 * catalog snapshot and never remembers a previous option table.
 */
function projectModelState(catalog: AcpModelCatalog, current: AcpModelSelection | undefined): ProjectedModelState {
  const groups: SessionConfigSelectGroup[] = []
  const modelChoices = new Map<string, AcpModelSelection>()
  const reasoningByModel = new Map<string, AcpModelReasoning>()
  const presentationOnlyValues = new Set<string>()
  for (const group of catalog.groups) {
    const entries: SessionConfigSelectOption[] = []
    for (const model of group.models) {
      const value = modelValue(group.id, model.id)
      modelChoices.set(value, { provider: group.id, model: model.id })
      if (model.reasoning !== undefined && model.reasoning.efforts.length > 0) {
        reasoningByModel.set(value, model.reasoning)
      }
      entries.push({
        value,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })
    }
    if (entries.length > 0) {
      groups.push({ group: `group:${group.id}`, name: group.name, options: entries })
    }
  }

  let currentModelValue: string
  if (current === undefined) {
    currentModelValue = UNSET_MODEL_VALUE
    presentationOnlyValues.add(currentModelValue)
    groups.push({
      group: 'group:unavailable',
      name: UNAVAILABLE_GROUP_NAME,
      options: [{ value: currentModelValue, name: NO_MODEL_PLACEHOLDER }],
    })
  } else {
    currentModelValue = modelValue(current.provider, current.model)
    if (!modelChoices.has(currentModelValue)) {
      presentationOnlyValues.add(currentModelValue)
      const groupId = `group:${current.provider}`
      let group = groups.find(candidate => candidate.group === groupId)
      if (group === undefined) {
        group = { group: groupId, name: current.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentModelValue, name: CURRENT_MODEL_PLACEHOLDER })
    }
  }

  const options: SessionConfigOption[] = [{
    id: MODEL_CONFIG_ID,
    name: MODEL_OPTION_NAME,
    category: 'model',
    type: 'select',
    currentValue: currentModelValue,
    options: groups,
  }]

  if (current !== undefined) {
    const reasoning = reasoningByModel.get(modelValue(current.provider, current.model))
    if (reasoning !== undefined && reasoning.efforts.length > 0) {
      const thoughtOptions: SessionConfigSelectOption[] = [{
        value: defaultEffortValue(),
        name: MODEL_DEFAULT_EFFORT_NAME,
      }]
      for (const effort of reasoning.efforts) {
        thoughtOptions.push({
          value: effortValue(effort.id),
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        })
      }
      let currentThoughtValue: string
      if (current.reasoningEffort === undefined) {
        currentThoughtValue = defaultEffortValue()
      } else if (reasoning.efforts.some(effort => effort.id === current.reasoningEffort)) {
        currentThoughtValue = effortValue(current.reasoningEffort)
      } else {
        currentThoughtValue = unavailableEffortValue(current.reasoningEffort)
        presentationOnlyValues.add(currentThoughtValue)
        thoughtOptions.unshift({ value: currentThoughtValue, name: CURRENT_EFFORT_PLACEHOLDER })
      }
      options.push({
        id: THOUGHT_LEVEL_CONFIG_ID,
        name: THOUGHT_LEVEL_OPTION_NAME,
        category: 'thought_level',
        type: 'select',
        currentValue: currentThoughtValue,
        options: thoughtOptions,
      })
    }
  }

  return { options, modelChoices, reasoningByModel, presentationOnlyValues }
}

/** Read one stable host error code without exposing its message or stack. */
function hostErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return undefined
}

/**
 * The internal Session-only model service bound once per Host ACP access.
 * It owns no persistent state: every request re-reads the Host authority.
 */
export class AcpSessionModelService {
  private readonly host: AcpModelHost

  constructor(host: AcpModelHost) {
    this.host = host
  }

  /**
   * Read the complete standard option state for one exact attached Agent.
   * A missing catalog is a real failure; the caller may omit optional display.
   */
  async readOptions(expectedAgent: AcpModelAgent, expectedSession: object): Promise<SessionConfigOption[]> {
    this.assertExact(expectedAgent, expectedSession)
    try {
      const catalog = await this.readCatalog()
      this.assertExact(expectedAgent, expectedSession)
      return projectModelState(catalog, copySelection(expectedAgent.model.current())).options
    } catch (error) {
      // A rejection is not allowed to outrun the exact identity fence: a
      // catalog failure after a replaced Agent/Session must stay STALE, never
      // become a tolerable optional-catalog omission for a new View.
      this.assertExact(expectedAgent, expectedSession)
      throw error
    }
  }

  /**
   * Validate and commit one Session-only model/effort selection.
   *
   * All provider/catalog reads happen BEFORE `runMaintenance`. The maintenance
   * callback itself performs only synchronous identity, baseline and abort
   * checks followed by the official `agent.model.select()` and a readback; it
   * never awaits provider I/O, so a slow catalog cannot block a TUI turn.
   */
  async selectSessionOnly(
    expectedAgent: AcpModelAgent,
    expectedSession: object,
    request: AcpModelOptionRequest,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ): Promise<SessionConfigOption[]> {
    this.validateRequestShape(request)
    this.assertCurrent(expectedAgent, expectedSession, signal, stillCurrent)
    const baseline = copySelection(expectedAgent.model.current())
    if (expectedAgent.status !== 'idle') throw agentBusy()

    const catalog = await this.readCatalog()
    this.assertCurrent(expectedAgent, expectedSession, signal, stillCurrent)
    const projected = projectModelState(catalog, baseline)

    let intended: AcpModelSelection
    if (request.configId === MODEL_CONFIG_ID) {
      if (typeof request.value !== 'string' || projected.presentationOnlyValues.has(request.value)) {
        throw invalidOption('the requested model option is not selectable')
      }
      const choice = projected.modelChoices.get(request.value)
      if (choice === undefined) {
        const parsed = parseModelValue(request.value)
        if (parsed !== undefined && this.catalogKnowsProvider(catalog, parsed.provider)) {
          throw modelUnavailable('the requested model is not available from the Host')
        }
        throw invalidOption('the requested model option is unknown')
      }
      await this.assertModelRoutable(choice.provider, choice.model, signal)
      this.assertCurrent(expectedAgent, expectedSession, signal, stillCurrent)
      intended = baseline !== undefined
        && baseline.provider === choice.provider
        && baseline.model === choice.model
        // Re-selecting the SAME route is not a model switch: keep its explicit
        // effort instead of silently dropping it. Choosing the model default is
        // the separate `thought_level` selection.
        ? copySelection(baseline) as AcpModelSelection
        : { provider: choice.provider, model: choice.model }
    } else {
      const baselineSelection = baseline
      if (baselineSelection === undefined) {
        throw invalidOption('no model is selected for this session')
      }
      const reasoning = projected.reasoningByModel.get(modelValue(baselineSelection.provider, baselineSelection.model))
      if (reasoning === undefined || reasoning.efforts.length === 0) {
        throw invalidOption('the selected model declares no reasoning efforts')
      }
      const parsed = parseEffortValue(request.value)
      if (parsed === undefined) throw invalidOption('the requested reasoning effort is unknown')
      if (parsed.kind === 'effort' && !reasoning.efforts.some(effort => effort.id === parsed.effortId)) {
        throw invalidOption('the requested reasoning effort is not available for this model')
      }
      intended = {
        provider: baselineSelection.provider,
        model: baselineSelection.model,
        ...(parsed.kind === 'effort' ? { reasoningEffort: parsed.effortId } : {}),
      }
      await this.assertModelRoute(intended, signal)
      this.assertCurrent(expectedAgent, expectedSession, signal, stillCurrent)
    }

    const committed = await this.commitIfCurrent(expectedAgent, expectedSession, intended, baseline, signal, stillCurrent)
    // The response reflects the OFFICIAL readback, never the pre-write snapshot.
    return projectModelState(catalog, committed).options
  }

  /** Reject everything outside the standard select subset for the two known config ids. */
  private validateRequestShape(request: AcpModelOptionRequest): void {
    if (request.type === 'boolean') throw invalidOption('boolean session config options are not supported')
    if (request.configId !== MODEL_CONFIG_ID && request.configId !== THOUGHT_LEVEL_CONFIG_ID) {
      throw invalidOption('unknown session config option')
    }
    if (typeof request.value !== 'string' || request.value.length === 0) {
      throw invalidOption('the session config option requires a non-empty select value')
    }
  }

  /** The exact live Agent/Session must still be the ones this View attached. */
  private assertExact(expectedAgent: AcpModelAgent, expectedSession: object): void {
    const sessionId = expectedAgent.id
    if (this.host.currentAgent(sessionId) !== expectedAgent || this.host.currentSession(sessionId) !== expectedSession) {
      throw staleSelection()
    }
  }

  /** Exact identity + View claim + request abort fence after an await. */
  private assertCurrent(
    expectedAgent: AcpModelAgent,
    expectedSession: object,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ): void {
    if (signal.aborted) throw staleSelection()
    const currentness = stillCurrent()
    if (currentness === 'view-busy') throw viewBusy()
    if (currentness !== 'current') throw staleSelection()
    this.assertExact(expectedAgent, expectedSession)
  }

  /** Read the official Host catalog; any failure is the stable unavailable class. */
  private async readCatalog(): Promise<AcpModelCatalog> {
    try {
      return await this.host.modelCatalog()
    } catch {
      throw modelUnavailable('the Host model catalog is unavailable')
    }
  }

  /** Whether the provider is a real catalog route that currently failed or holds no such model. */
  private catalogKnowsProvider(catalog: AcpModelCatalog, providerId: string): boolean {
    return catalog.groups.some(group => group.id === providerId)
      || (catalog.failures ?? []).some(failure => failure.id === providerId)
  }

  /** Model selection validation: the fresh provider/model directory plus adapter defaults. */
  private async assertModelRoutable(
    providerId: string,
    modelId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.assertModelRoute({ provider: providerId, model: modelId }, signal)
  }

  /**
   * Validate one exact route against the live LLM registry. A missing route is
   * `UNAVAILABLE`; an unsupported explicit effort is `INVALID_OPTION` because it
   * is the caller's option value that is wrong for the model, not a vanished
   * provider.
   */
  private async assertModelRoute(
    route: AcpModelSelection,
    signal: AbortSignal,
  ): Promise<void> {
    let providers: readonly { readonly id: string; readonly name: string }[]
    try {
      providers = this.host.listProviders()
    } catch {
      throw modelUnavailable('the Host model provider list is unavailable')
    }
    if (!providers.some(provider => provider.id === route.provider)) {
      throw modelUnavailable('the requested model provider is not available')
    }
    let models: readonly { readonly id: string; readonly name: string }[]
    try {
      models = await this.host.listModels(route.provider)
    } catch {
      throw modelUnavailable('the requested model provider catalog is unavailable')
    }
    if (signal.aborted) throw staleSelection()
    if (!models.some(model => model.id === route.model)) {
      throw modelUnavailable('the requested model is not available')
    }
    try {
      await this.host.resolveCallConfig(route, signal)
    } catch (error) {
      if (route.reasoningEffort !== undefined && hostErrorCode(error) === 'UNSUPPORTED_REASONING_EFFORT') {
        throw invalidOption('the requested reasoning effort is not supported by this model')
      }
      throw modelUnavailable('the requested model configuration is not available')
    }
    if (signal.aborted) throw staleSelection()
  }

  /**
   * Claim the true idle phase, re-check every currentness fence synchronously,
   * then perform the one official Session-only write and an authority readback.
   */
  private async commitIfCurrent(
    expectedAgent: AcpModelAgent,
    expectedSession: object,
    intended: AcpModelSelection,
    baseline: AcpModelSelection | undefined,
    signal: AbortSignal,
    stillCurrent: () => AcpModelCurrentness,
  ): Promise<AcpModelSelection> {
    const sessionId = expectedAgent.id
    let maintenance: Promise<AcpModelSelection>
    try {
      maintenance = expectedAgent.runMaintenance(async maintenanceSignal => {
        if (signal.aborted || maintenanceSignal.aborted) throw staleSelection()
        const currentness = stillCurrent()
        if (currentness === 'view-busy') throw viewBusy()
        if (currentness !== 'current') throw staleSelection()
        if (this.host.currentAgent(sessionId) !== expectedAgent || this.host.currentSession(sessionId) !== expectedSession) {
          throw staleSelection()
        }
        if (!sameSelection(expectedAgent.model.current(), baseline)) throw conflictingSelection()
        expectedAgent.model.select(intended)
        const committed = expectedAgent.model.current()
        if (!sameSelection(committed, intended)) {
          throw staleSelection()
        }
        return copySelection(committed) as AcpModelSelection
      })
    } catch {
      // `runMaintenance` throws synchronously when a turn or another maintenance
      // already owns the real idle phase. Never queue behind it.
      throw agentBusy()
    }
    return await maintenance
  }
}
