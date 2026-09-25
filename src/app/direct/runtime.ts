/**
 * The Direct application runtime — the application-side composition owner for
 * Direct (plan A1 §8). It owns the Direct resolver POLICY and facades the
 * semantic assembly needs, constructs the ONE `DirectModelSelectionOwner`, wires
 * the Direct assistant-stream install, and delegates the semantic adapter
 * assembly to `runtime/direct/backend-direct.ts` (the single
 * `createDirectRuntimeBackend` owner; no adapter is constructed here).
 *
 * Host-lookup ownership (final Stage-A zoning): `app/direct` is the Direct
 * application coupling owner, so the concrete Host lookups
 * (`agents.get`/`sessions.get`/`agentDefaultModel`) move behind THIS module's
 * Direct composition/factory seam. In A1 they are still supplied BY the runner
 * as narrow resolver callbacks because the session/application composition
 * owners do not exist yet; `app/bootstrap` only constructs/connects/selects
 * owners and must never become a new Host-business-coupling zone.
 *
 * This is the approved zone for Direct coupling (`ctx` forwarding and the
 * `@deepseek-ai/dsh-agent` identity type). It deliberately holds NO mutable
 * current-session truth: `currentDirectAttachment()` projects the ownership
 * core's current owner through this module's registry and
 * `getViewedQueueAgent()` is a live getter into the session runtime's authority
 * (A2 moves that authority into `app/session`), never copied state.
 * @module @xmoon76/dsh-pi-tui/app/direct/runtime
 */

import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Diag } from '../../diag.ts'
import type { AssistantLiveInput } from '../../runtime/assistant-stream-port.ts'
import type { Backend } from '../../runtime/backend.ts'
import type { TuiSettingsConfig } from '../../runtime/config-port.ts'
import {
  createDirectRuntimeBackend,
  type DirectBackendContextLike,
} from '../../runtime/direct/backend-direct.ts'
import {
  installAssistantStreamDirect,
  type AssistantStreamDirectHandle,
} from '../../runtime/direct/assistant-stream-direct.ts'
import {
  DirectModelSelectionOwner,
  type DefaultModelServiceLike,
} from '../../runtime/direct/model-selection-direct.ts'
import type {
  CompositionLike,
  DirectOwnerPoolLike,
} from '../../runtime/direct/session-lifecycle-direct.ts'
import { createDirectOwnerRegistry, type DirectOwnerRegistry } from './owner-registry.ts'
import type { SessionOwnerRef } from '../session/subject.ts'

/** The interactive continuable child currently mounted by a viewer. */
export interface DirectViewedQueueAgent {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly agent: Agent
}

/** The narrow model-selection operations the runner still needs. */
export interface DirectModelSelectionFacade {
  current(agent: unknown): ModelSelection | undefined
  setCurrent(agent: unknown, selection: ModelSelection | undefined): void
  installForAgent(agent: Agent): void
  observeSelectionEvent(agent: Agent, event: unknown): void
  consumeSelection(agent: Agent, provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/** The Host Session/Agent accessors the Direct session reader projects. */
export interface DirectHostResolvers {
  sessionOf(sessionId: string): unknown | undefined
  agentOf(sessionId: string): unknown | undefined
  flushSession(session: unknown): Promise<void>
}

/** Explicit Direct application composition dependencies. */
export interface DirectApplicationRuntimeDeps {
  /**
   * The Host context, forwarded to the Direct adapters and the stream
   * installer. A1 performs no Direct application lookup here: the runner
   * supplies every resolver callback in this deps object. By A5 the Direct Host
   * lookups (`agents`/`sessions`/`agentDefaultModel`) move behind this module's
   * composition seam; `app/bootstrap` only connects owners.
   */
  readonly ctx: DirectBackendContextLike
  readonly diag: Diag
  /** The persisted TUI-settings facade (absent without the Settings service). */
  readonly tuiSettings: TuiSettingsConfig | undefined
  /** The persisted default-model service. */
  readonly defaultModel: DefaultModelServiceLike
  /**
   * The ownership core's owner-release seam. The Direct owner pool is built and
   * owned HERE; it reads the ONE ledger through this callback.
   */
  readonly waitForRelease: (sessionId: string) => Promise<void>
  /**
   * The ownership core's current opaque owner (read-only). The owner registry
   * uses it for the A2-transitional `currentDirectAttachment()` projection.
   */
  readonly currentOwner: () => SessionOwnerRef | undefined
  /**
   * Build one preset composition, installing the runtime's Agent-scoped model
   * selection during setup. The runner supplies its `composeAgent` closure; the
   * runtime owns the model-selection install.
   */
  readonly compose: (
    installSelection: (agentCtx: unknown, agent: Agent) => void,
    presetId?: string,
  ) => Promise<CompositionLike>
  /** The interactive continuable child currently viewed, if any (live record). */
  readonly getViewedQueueAgent: () => DirectViewedQueueAgent | undefined
  /** The registered Host Agent for a session id (exact identity comparison). */
  readonly registeredAgentFor: (sessionId: string) => Agent | undefined
  /** The Host Session/Agent accessors the Direct session reader projects. */
  readonly resolvers: DirectHostResolvers
}

/** The Direct application runtime consumed by the runner. */
export interface DirectApplicationRuntime {
  readonly backend: Backend
  readonly modelSelections: DirectModelSelectionFacade
  /** Build one preset composition with the runtime's model-selection install. */
  readonly compose: (presetId?: string) => Promise<CompositionLike>
  /** The exact live Agent of one Session, or undefined when not mounted. */
  readonly agentFor: (sessionId: string) => Agent | undefined
  /** The live Agent plus the interactive continuable child currently viewed. */
  readonly queueAgentFor: (sessionId: string) => Agent | undefined
  /** The registered Host Agent for a session id (exact identity comparison). */
  readonly registeredAgentFor: (sessionId: string) => Agent | undefined
  /** The shared per-Agent model-selection / image prompt-admission window. */
  readonly withPromptAdmission: <T>(agent: Agent, hasImage: boolean, operation: () => Promise<T>) => Promise<T>
  /** Install the Direct live assistant-stream listener (returns its handle). */
  readonly installAssistantStream: (hooks: {
    readonly isCurrentAgent: (agent: unknown) => boolean
    readonly onInput: (input: AssistantLiveInput) => void
  }) => AssistantStreamDirectHandle
  /** The Direct Session ownership pool (lifecycle retirement/claim). */
  readonly ownerPool: DirectOwnerPoolLike
  /** The Direct Agent↔OwnerRef registry (opaque owner mapping + A2 escapes). */
  readonly owners: DirectOwnerRegistry
  /** Whether any Direct owner handle is currently parked for a future reopen. */
  hasParkedOwners(): boolean
  /** Drain every parked Direct owner for the exit retirement (Direct-only). */
  takeAllParkedOwners(): Array<{ agent: Agent; handle: AgentHandle }>
}

/**
 * Compose the Direct application runtime. Behavior-preserving relocation of the
 * runner's Direct construction block: the model-selection owner, the Direct
 * resolvers and the semantic Backend are still built in this order, with the
 * same per-Agent admission serialization and the same live-agent authority.
 */
export function createDirectApplicationRuntime(deps: DirectApplicationRuntimeDeps): DirectApplicationRuntime {
  const modelSelections = new DirectModelSelectionOwner(deps.defaultModel)

  const installSessionModelSelection = (_agentCtx: unknown, agent: Agent): void => {
    modelSelections.installForAgent(agent)
  }
  const compose = (presetId?: string): Promise<CompositionLike> =>
    deps.compose(installSessionModelSelection, presetId)

  const agentFor = (sessionId: string): Agent | undefined => {
    // The registry projects the ownership core's CURRENT owner; the runtime
    // never holds a second current-agent truth.
    const live = owners.currentDirectAttachment()
    return live?.session.id === sessionId ? live : undefined
  }

  // Queue occurrence operations have a narrower, separate child authority:
  // only the exact live Agent currently mounted by an interactive continuable
  // viewer may be addressed. Ordinary prompt/cancel/title verbs continue using
  // agentFor, so resolving a child here cannot bypass SubagentPort's
  // parent-authorized prompt path.
  const queueAgentFor = (sessionId: string): Agent | undefined => {
    const live = owners.currentDirectAttachment()
    if (live?.session.id === sessionId) return live
    const viewed = deps.getViewedQueueAgent()
    if (viewed === undefined || viewed.childSessionId !== sessionId) return undefined
    if (live?.session.id !== viewed.parentSessionId) return undefined
    const agent = deps.registeredAgentFor(sessionId)
    if (agent === undefined || agent !== viewed.agent || agent.session.id !== sessionId) return undefined
    if (agent.session.header.parentSession !== viewed.parentSessionId) return undefined
    return agent
  }

  const liveResolvers = {
    sessionOf: (sessionId: string): unknown | undefined => deps.resolvers.sessionOf(sessionId),
    agentOf: (sessionId: string): unknown | undefined => deps.resolvers.agentOf(sessionId),
    flushSession: (session: unknown): Promise<void> => deps.resolvers.flushSession(session),
  }

  // The Direct owner pool is built and owned HERE (plan A2 §3.3): it keeps the
  // parked AgentHandle map and reads the ONE release ledger through the core's
  // `waitForRelease` seam. The runner never sees the pool's storage.
  const parkedDirectOwners = new Map<string, AgentHandle>()
  const ownerPool: DirectOwnerPoolLike = {
    claim: sessionId => {
      const handle = parkedDirectOwners.get(sessionId)
      if (handle !== undefined) parkedDirectOwners.delete(sessionId)
      return handle
    },
    park: handle => {
      const sessionId = String(handle.agent.session.id)
      const previous = parkedDirectOwners.get(sessionId)
      if (previous !== undefined && previous !== handle) throw new Error(`duplicate parked Direct owner for session "${sessionId}"`)
      parkedDirectOwners.set(sessionId, handle)
    },
    waitForRelease: deps.waitForRelease,
  }
  // The ONE Direct Agent↔OwnerRef registry. `currentDirectAttachment()` reads
  // the core's current owner live on every call (A2 transitional projection).
  const owners = createDirectOwnerRegistry(deps.currentOwner)

  const backend = createDirectRuntimeBackend({
    ctx: deps.ctx,
    diag: deps.diag,
    tuiSettings: deps.tuiSettings,
    modelSelections,
    ownerPool,
    compose: (presetId) => compose(presetId),
    agentFor,
    queueAgentFor,
    liveResolvers,
  })

  const modelSelectionFacade: DirectModelSelectionFacade = {
    current: (agent) => modelSelections.current(agent),
    setCurrent: (agent, selection) => { modelSelections.setCurrent(agent, selection) },
    installForAgent: (agent) => { modelSelections.installForAgent(agent) },
    observeSelectionEvent: (agent, event) => { modelSelections.observeSelectionEvent(agent, event) },
    consumeSelection: (agent, provider, model, reasoningEffort) =>
      modelSelections.consumeSelection(agent, provider, model, reasoningEffort),
  }

  const withPromptAdmission = <T>(agent: Agent, hasImage: boolean, operation: () => Promise<T>): Promise<T> =>
    hasImage ? modelSelections.serializeImageAdmission(agent, operation) : operation()

  const installAssistantStream = (hooks: {
    readonly isCurrentAgent: (agent: unknown) => boolean
    readonly onInput: (input: AssistantLiveInput) => void
  }): AssistantStreamDirectHandle => installAssistantStreamDirect({
    ctx: deps.ctx,
    isCurrentAgent: hooks.isCurrentAgent,
    onInput: hooks.onInput,
  })

  return {
    backend,
    modelSelections: modelSelectionFacade,
    compose,
    agentFor,
    queueAgentFor,
    registeredAgentFor: deps.registeredAgentFor,
    withPromptAdmission,
    installAssistantStream,
    ownerPool,
    owners,
    hasParkedOwners: () => parkedDirectOwners.size > 0,
    takeAllParkedOwners: () => {
      const drained: Array<{ agent: Agent; handle: AgentHandle }> = []
      for (const [sessionId, handle] of parkedDirectOwners) {
        drained.push({ agent: handle.agent, handle })
        parkedDirectOwners.delete(sessionId)
      }
      return drained
    },
  }
}
