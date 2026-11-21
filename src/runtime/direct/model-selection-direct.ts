/**
 * Direct ownership for Session-local model selection.
 *
 * DSH 0.2.2 moved model-selection authority INTO the Agent: the agent loop
 * registers the `modelSelection` session projection itself and constructs the
 * upstream `AgentModel`, whose `current()` / `select()` are the only reads and
 * writes of a Session's durable choice (`model/selection` appended, the
 * projection retiring a matching choice on the next `request/header`). This
 * adapter therefore owns NO selection state of its own: it normalizes the
 * upstream read into the TUI's semantic DTO, records through
 * `agent.model.select()`, installs the official model-switch notice once per
 * Agent, and keeps the two Direct-only capabilities the TUI still needs —
 * the per-Agent admission serialization window and the Session's own
 * `requestHeader()` read for compositions whose projection registry does not
 * carry the official `modelSelection` unit.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/model-selection-direct
 */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  normalizeModelSelection,
  rawSelectionFromRequestHeader,
  type ModelSelectionValue,
} from '../../domain/session/model-selection.ts'

/** The exact Session fact the Direct durable model-selection read needs: the
 *  Session's OWN incrementally maintained latest-request cache. Structural, so no
 *  Host Session type enters this dependency. */
export interface DurableModelSelectionSessionLike {
  requestHeader(): unknown
}

/** The official `modelSelection` wire shape: `lastUsed` is the latest request
 *  header's route, `next` is the unconsumed intent when one exists. Both are
 *  `null` when the Session carries no durable selection fact yet. */
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
 * It exists because the upstream `modelSelection` unit is registered by the
 * agent loop's own agent-scoped registry, not by the TUI profile's Host
 * registry: the registry then omits the key entirely, and the official read
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
  /** Append the complete selection durably through the upstream AgentModel.
   *  Throws when the Session cannot record it. */
  select(agent: unknown, selection: ModelSelectionValue): void
  /** Run one operation inside the Agent's shared model-selection / image
   *  prompt-admission serialization window. */
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

/**
 * Per-Agent Direct model-selection adapter. It holds no selection state: the
 * live Agent's own `model` (the upstream `AgentModel` over the `modelSelection`
 * projection) is the ONE authority for reads and durable writes.
 */
export class DirectModelSelectionOwner implements SessionModelSelectionOwnerLike, DurableModelSelectionReader {
  /** The per-Agent model-selection / image prompt-admission chain (the
   *  official `ApiSessionAgentController.serializeImageAdmission` shape).
   *  Overlapping model selections and image-bearing prompt admissions
   *  therefore apply in call order instead of racing each other. */
  private readonly admissionChains = new WeakMap<Agent, Promise<void>>()
  /** The Agents whose official model-switch notice listener is installed. */
  private readonly noticeInstalled = new WeakSet<Agent>()

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

  /**
   * Install the official model-switch notice listener once for this Agent.
   * The TUI profile mounts no API session-controller row (its only other
   * installer), and the loop itself already owns the projection registration
   * that makes `agent.model` work.
   */
  installForAgent(agent: Agent): void {
    if (this.noticeInstalled.has(agent)) return
    this.noticeInstalled.add(agent)
    // Install before publishing/starting the Agent.  The setup context is the
    // public DSH seam; no runner-global state is ever passed to this listener.
    installModelSelection(agent.ctx)
  }

  /** Return the current effective selection for one live Agent (a detached
   *  copy, never the AgentModel's own object). */
  current(agent: unknown): ModelSelection | undefined {
    return agentSelection(normalizeModelSelection((agent as Agent).model.current()))
  }

  /** Append this Agent's next-step selection durably (upstream commit point). */
  select(agent: unknown, selection: ModelSelectionValue): void {
    const normalized = normalizeModelSelection(selection)
    if (normalized === undefined) throw new Error('invalid model selection')
    ;(agent as Agent).model.select(agentSelection(normalized) as ModelSelection)
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
}
