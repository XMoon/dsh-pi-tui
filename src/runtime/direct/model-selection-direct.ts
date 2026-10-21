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

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import {
  copyModelSelection,
  foldPendingModelSelection,
  normalizeModelSelection,
  rawSelectionFromRequestHeader,
  sameModelSelection,
  selectionFromRequestHeader,
  type ModelSelectionValue,
} from '../../domain/session/model-selection.ts'

/** The narrow default-model service surface used by this Direct owner. */
export interface DefaultModelServiceLike {
  currentSelection(): ModelSelection | undefined
}

/** A per-Agent installed selection plus the raw pending-intent consumer. */
export interface InstalledModelSelection extends ModelSelectionRef {
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/** The exact Session fact the Direct durable model-selection read needs: the
 *  Session's OWN incrementally maintained latest-request cache. Structural, so no
 *  Host Session type enters this dependency. */
export interface DurableModelSelectionSessionLike {
  requestHeader(): unknown
}

/** The official rc.2 `modelSelection` wire shape: `lastUsed` is the latest
 *  request header's route, `next` is the unconsumed intent when one exists. Both
 *  are `null` when the Session carries no durable selection fact yet. */
export interface DurableModelSelectionProjection {
  readonly lastUsed: ModelSelectionValue | null
  readonly next: ModelSelectionValue | null
}

/**
 * The Direct-only read of one exact Session's own durable model-selection facts,
 * in the official `modelSelection` wire shape. It is deliberately SEPARATE from
 * {@link SessionModelSelectionOwnerLike} (the catalog WRITE seam): only the
 * session reader consumes it, and it is read-only.
 *
 * It exists because the upstream `modelSelection` unit is registered by the API
 * SessionController row alone, which the `dsh-base` + TUI profile does not
 * compose: the registry then omits the key entirely, and the official read
 * answers "unavailable" while the Session has in fact recorded its route.
 */
export interface DurableModelSelectionReader {
  /**
   * The exact Session's own latest used route. It reads that Session's own
   * request header only — never the Agent's current choice, the global default
   * or another Session — and it neither installs a request listener nor appends
   * an event.
   */
  durableProjectionForSession(session: DurableModelSelectionSessionLike): DurableModelSelectionProjection
}

/** The structural seam consumed by the Direct catalog adapter. */
export interface SessionModelSelectionOwnerLike {
  current(agent: unknown): ModelSelectionValue | undefined
  /** Append durable intent only; throws when the Session cannot record it. */
  appendSelection(agent: unknown, selection: ModelSelectionValue): void
  /** Set only one Agent's in-memory pending choice. */
  setCurrent(agent: unknown, selection: ModelSelectionValue | undefined): void
  selectForNextRequest(agent: unknown, selection: ModelSelectionValue): void
  /** Run one operation inside the Agent's shared model-selection / image
   *  prompt-admission serialization window (rc.2 `serializeImageAdmission`). */
  serializeImageAdmission<Value>(agent: unknown, operation: () => Promise<Value>): Promise<Value>
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
export class DirectModelSelectionOwner implements SessionModelSelectionOwnerLike, DurableModelSelectionReader {
  private readonly installed = new WeakMap<Agent, InstalledModelSelection>()
  /** The per-Agent model-selection / image prompt-admission chain (rc.2
   *  `ApiSessionAgentController.serializeImageAdmission`). Overlapping model
   *  selections and image-bearing prompt admissions therefore apply in call
   *  order instead of racing each other. */
  private readonly admissionChains = new WeakMap<Agent, Promise<void>>()
  private readonly defaultModel: DefaultModelServiceLike

  constructor(defaultModel: DefaultModelServiceLike) {
    // Explicit field, never a parameter property: the bundle's tests run
    // .ts files under Node's strip-only loader, which rejects that syntax.
    this.defaultModel = defaultModel
  }

  /**
   * Run one operation inside the Agent's serialization window. The chain
   * swallows each settled result so a failed operation never poisons the
   * queue, while the returned promise still rejects to its own caller.
   */
  serializeImageAdmission<Value>(agent: unknown, operation: () => Promise<Value>): Promise<Value> {
    const live = agent as Agent
    const result = (this.admissionChains.get(live) ?? Promise.resolve()).then(operation)
    this.admissionChains.set(live, result.then(() => undefined, () => undefined))
    return result
  }

  /** Read the current process default without retaining its object identity. */
  private defaultSelection(): ModelSelection | undefined {
    return agentSelection(selectionValue(this.defaultModel.currentSelection()))
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

  /**
   * The exact Session's OWN latest used route, in the official `modelSelection`
   * wire shape, for the compositions whose Session projection registry does not
   * register the upstream unit. Purely synchronous and read-only: it installs no
   * request listener, appends no event, and reads no Agent choice, no global
   * default and no other Session.
   *
   * SCOPE (owner-approved revision, 2026-10-08): only `lastUsed` is restored,
   * from the Session's own incrementally maintained `requestHeader()` — never a
   * log scan, so this compat source adds no deprecated synchronous history-reader
   * call site and does not touch the frozen debt baseline. The upstream
   * `next = pending ?? lastUsed` slot therefore reads as `lastUsed`: an
   * unconsumed pending `model/selection` intent is deliberately NOT reproduced
   * here, so this source must never be described as the complete official
   * semantic. `lastUsed` keeps the upstream's RAW `config.reasoningEffort`
   * (the Agent-restore policy, which strips an adapter default, would disagree
   * with the official wire value).
   */
  durableProjectionForSession(session: DurableModelSelectionSessionLike): DurableModelSelectionProjection {
    const lastUsed = rawSelectionFromRequestHeader(session.requestHeader())
    return { lastUsed: lastUsed ?? null, next: lastUsed ?? null }
  }

  /** Expose a detached selection for Direct catalog DTOs. */
  detachedCurrent(agent: unknown): ModelSelectionValue | undefined {
    return copyModelSelection(selectionValue(this.current(agent)))
  }
}
