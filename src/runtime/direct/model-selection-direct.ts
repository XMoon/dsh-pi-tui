/**
 * Direct ownership for Session-local model selection.
 *
 * The Host default-model service supplies only the fallback for an Agent that
 * has no durable Session choice.  Each live Agent gets its own mutable
 * `ModelSelectionRef`; durable `model/selection` and `request/header` events
 * reconstruct the state when the Agent is resumed.  The WeakMap follows Agent
 * lifetime and cannot retain disposed sessions by id.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/model-selection-direct
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import {
  copyModelSelection,
  foldPendingModelSelection,
  normalizeModelSelection,
  sameModelSelection,
  selectionFromRequestHeader,
  type ModelSelectionValue,
} from '../../model-selection.ts'

/** The narrow default-model service surface used by this Direct owner. */
export interface DefaultModelServiceLike {
  currentSelection(): ModelSelection | undefined
}

/** A per-Agent installed selection plus the raw pending-intent consumer. */
export interface InstalledModelSelection extends ModelSelectionRef {
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/** The structural seam consumed by the Direct catalog adapter. */
export interface SessionModelSelectionOwnerLike {
  current(agent: unknown): ModelSelectionValue | undefined
  /** Append durable intent only; throws when the Session cannot record it. */
  appendSelection(agent: unknown, selection: ModelSelectionValue): void
  /** Set only one Agent's in-memory pending choice. */
  setCurrent(agent: unknown, selection: ModelSelectionValue | undefined): void
  selectForNextRequest(agent: unknown, selection: ModelSelectionValue): void
}

function agentSelection(value: ModelSelectionValue | undefined): ModelSelection | undefined {
  // The runtime representation of ReasoningEffortId is a string.  The cast is
  // deliberately local: the pure policy and the semantic DTO remain plain
  // strings, while the DSH Agent listener receives its branded public type.
  return value === undefined
    ? undefined
    : {
        provider: value.provider,
        model: value.model,
        ...value.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: value.reasoningEffort as ModelSelection['reasoningEffort'] },
      }
}

function selectionValue(value: ModelSelection | undefined): ModelSelectionValue | undefined {
  return normalizeModelSelection(value)
}

function requestHeaderOf(agent: Agent): unknown {
  const session = agent.session as unknown as { requestHeader?: () => unknown }
  return typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
}

/**
 * Per-Agent Direct model-selection owner.  `defaultModel.currentSelection()`
 * is read on every fallback access, so a sessionless `/model` update or an
 * external default change is never frozen at runner startup.
 */
export class DirectModelSelectionOwner implements SessionModelSelectionOwnerLike {
  private readonly installed = new WeakMap<Agent, InstalledModelSelection>()
  private readonly defaultModel: DefaultModelServiceLike

  constructor(defaultModel: DefaultModelServiceLike) {
    // Explicit field, never a parameter property: the bundle's tests run
    // .ts files under Node's strip-only loader, which rejects that syntax.
    this.defaultModel = defaultModel
  }

  /** Read the current process default without retaining its object identity. */
  private defaultSelection(): ModelSelection | undefined {
    return agentSelection(selectionValue(this.defaultModel.currentSelection()))
  }

  /** Install the selection for the Agent associated with an unpublished setup context. */
  installForContext(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('model selection setup has no scoped Agent')
    this.installForAgent(agent)
  }

  /** Install once for an Agent and return its own mutable selection reference. */
  installForAgent(agent: Agent): InstalledModelSelection {
    const existing = this.installed.get(agent)
    if (existing !== undefined) return existing

    const folded = foldPendingModelSelection(agent.session.snapshotEvents())
    let picked = agentSelection(folded.pending)
    const owner = this
    const selection: InstalledModelSelection = {
      get current(): ModelSelection | undefined {
        if (picked !== undefined) return picked
        const logged = agentSelection(selectionFromRequestHeader(requestHeaderOf(agent)))
        if (logged !== undefined) return logged
        return owner.defaultSelection()
      },
      set current(next: ModelSelection | undefined) {
        picked = agentSelection(selectionValue(next))
      },
      assembled: undefined,
      consume: (provider, model, reasoningEffort) => {
        const raw = normalizeModelSelection({ provider, model, reasoningEffort })
        if (!sameModelSelection(selectionValue(picked), raw)) return false
        picked = undefined
        return true
      },
    }
    // Install before publishing/starting the Agent.  The setup context is the
    // public DSH seam; no runner-global ref is ever passed to this listener.
    installModelSelection(agent.ctx, selection)
    this.installed.set(agent, selection)
    return selection
  }

  /** Return the current effective selection for one live Agent. */
  current(agent: unknown): ModelSelection | undefined {
    return this.installForAgent(agent as Agent).current
  }

  /** Set only one Agent's next-step selection (used by the TUI facade seam). */
  setCurrent(agent: unknown, selection: ModelSelectionValue | undefined): void {
    this.installForAgent(agent as Agent).current = agentSelection(selection)
  }

  /** Append durable intent only; throws when the Session cannot record it.
   *  The commit point for `/model`: the Agent-local selection is NOT touched
   *  here, so a failed append can never be observed by a request. */
  appendSelection(agent: unknown, selection: ModelSelectionValue): void {
    const normalized = normalizeModelSelection(selection)
    if (normalized === undefined) throw new Error('invalid model selection')
    const session = (agent as Agent).session as unknown as { append?(type: string, data: unknown): unknown }
    if (typeof session.append !== 'function') {
      throw new Error('session cannot record a model selection')
    }
    session.append('model/selection', { ...normalized })
  }

  /** Append durable intent, then update this Agent's in-memory pending choice. */
  selectForNextRequest(agent: unknown, selection: ModelSelectionValue): void {
    const normalized = normalizeModelSelection(selection)
    if (normalized === undefined) throw new Error('invalid model selection')
    const live = agent as Agent
    const session = live.session as unknown as { append?(type: string, data: unknown): unknown }
    // The real dsh Session always appends durably; a structurally-incomplete
    // session (a test double) keeps the in-memory pending choice only, so the
    // first request still uses it.
    if (typeof session.append === 'function') {
      session.append('model/selection', { ...normalized })
    }
    this.installForAgent(live).current = agentSelection(normalized)
  }

  /** Consume only an exact raw request-header selection. */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.installForAgent(agent).consume(provider, model, reasoningEffort)
  }

  /** Observe a durable selection event that arrived outside the `/model` path. */
  observeSelectionEvent(agent: Agent, event: unknown): void {
    const record = typeof event === 'object' && event !== null ? event as { type?: unknown; data?: unknown } : undefined
    if (record?.type !== 'model/selection') return
    const normalized = normalizeModelSelection(record.data)
    if (normalized !== undefined) this.installForAgent(agent).current = agentSelection(normalized)
  }

  /** Expose a detached selection for Direct catalog DTOs. */
  detachedCurrent(agent: unknown): ModelSelectionValue | undefined {
    return copyModelSelection(selectionValue(this.current(agent)))
  }
}
