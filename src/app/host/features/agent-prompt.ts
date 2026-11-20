/**
 * The Split Host's per-Agent TUI prompt installation (M6 PR-C C3).
 *
 * The Direct branch composes an Agent through `app/direct/composition.ts`, so
 * its TUI sections are installed during that composition. A Split Host does
 * NOT compose TUI Agents: the official Host Session controller creates them
 * (`agents.create` / `resume`), and this module is the Host-side owner that
 * observes those creations and installs the SAME sections on each Agent's own
 * scope.
 *
 * What it installs on every live Agent (and on every later one):
 *
 * ```text
 * app/agent/turn-policy.ts    the per-Turn latch: turn/start samples the
 *                             Session's current verified viewers ONCE, turn/end
 *                             clears it
 * app/agent/prompt-sections.ts the four TUI-owned sections, reading the LIVE
 *                             preference axes and the frozen Turn snapshot
 * ```
 *
 * The sampler is the Host's own `piTuiPromptPresence` fold (C3): the CURRENT
 * records keyed by authenticated Peer identity, never a Client-supplied id.
 * A Host with no presence service answers the honest ineligible snapshot, so
 * a Split Turn degrades to "no TUI policy" instead of a guessed one.
 *
 * Installation is idempotent per Agent lifetime: a re-announced Agent (a
 * cold resume, a replacement after disposal) installs a NEW set on its own
 * scope and the retired scope unwinds the previous one. Nothing is installed
 * twice on one Agent scope.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/agent-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  installTuiPromptSections,
  type SystemPromptLike,
  type TuiPromptLiveStates,
} from '../../agent/prompt-sections.ts'
import { installTuiPromptTurnLatch } from '../../agent/turn-policy.ts'
import type { Diag } from '../../../runtime/process/diagnostics.ts'

/** The structural Agent facts this installer consumes (no Host package import). */
export interface HostAgentLike {
  /** The exact Agent identity (the durable Session id). */
  readonly id: string
  /** The exact durable Session this Agent drives (`agent.session`). */
  readonly session: HostPromptSessionLike
  /** The Agent-scoped Context the sections are installed on. */
  readonly ctx: Context
}

/** The structural Session face the voter fold compares by object identity. */
export interface HostPromptSessionLike {
  /** The exact durable Session id. */
  readonly id: string
  /** The official creation header; `origin === 'subagent'` marks a subagent. */
  readonly header: { readonly origin?: string }
}

/** The live preference axes the Host reads on every assembly. */
export interface HostPromptPreferenceSource {
  /** The current progress-updates cadence (a live read, never a snapshot). */
  progressUpdates(): TuiPromptLiveStates['progressUpdates'] extends () => infer Value ? Value : never
  /** The current response style. */
  responseStyle(): TuiPromptLiveStates['responseStyle'] extends () => infer Value ? Value : never
  /** The current git-attribution mode. */
  gitAttribution(): TuiPromptLiveStates['gitAttribution'] extends () => infer Value ? Value : never
}

/** The voter fold this installer samples once per Turn. */
export interface HostPromptVoterSampler {
  /** Fold the CURRENT verified TUI viewers of one exact Session object. */
  snapshotVoters(session: HostPromptSessionLike): { readonly eligible: boolean; readonly focus: boolean }
}

export interface HostAgentPromptInstallOptions {
  /** The Host Context whose `session/event` plane the latch observes. */
  readonly ctx: Context
  /** The live preference reads (canonical `piTuiPreferences`). */
  readonly preferences: HostPromptPreferenceSource
  /** The voter fold (the Host's own `piTuiPromptPresence` service). */
  readonly voters: HostPromptVoterSampler
  /** Diagnostics for a degraded installation. */
  readonly diag?: Diag
}

/** One installed Agent: its disposers, in installation order. */
interface InstalledAgent {
  readonly sessionId: string
  readonly disposers: readonly (() => void)[]
}

/**
 * Install the TUI prompt policy on ONE live Agent's scope.
 *
 * A subagent-origin Session gets NOTHING (the plan's "register scoped
 * sections only for ordinary Agents"): subagent turns keep the official
 * prompt and must never acquire a Git trailer or TUI communication narration.
 *
 * The sections are installed even when the Agent currently has no viewer:
 * their text is empty outside an eligible Turn, and a later Turn can become
 * eligible without re-composition.
 *
 * @returns the disposers, or an empty list when the Agent has no scoped
 *   `systemPrompt` service (a Host composition without the prompt registry).
 */
export function installHostAgentPrompt(
  agent: HostAgentLike,
  options: HostAgentPromptInstallOptions,
): readonly (() => void)[] {
  if (agent.session.header.origin === 'subagent') return []
  const systemPrompt = agent.ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt === undefined) {
    options.diag?.warn('host agent prompt unavailable', {
      reason: 'systemPrompt service missing on the Agent scope',
      session: agent.session.id,
    })
    return []
  }
  const sessionId = agent.session.id
  const latch = installTuiPromptTurnLatch(
    {
      on: (_event, listener, listenerOptions) => options.ctx.on('session/event', listener, listenerOptions),
    },
    agent.session,
    () => options.voters.snapshotVoters(agent.session),
  )
  const live: TuiPromptLiveStates = {
    progressUpdates: () => options.preferences.progressUpdates(),
    responseStyle: () => options.preferences.responseStyle(),
    gitAttribution: () => options.preferences.gitAttribution(),
  }
  // The latch disposes BEFORE the sections so a late `turn/end` can never
  // evaluate a section that is already unwinding.
  const sectionDisposers = installTuiPromptSections({ systemPrompt, turn: latch, live })
  return [() => { latch.dispose() }, ...sectionDisposers]
}

/**
 * The Host-side observer that installs the policy on every live Agent and on
 * every later one. ONE instance per built-in Host Runtime.
 *
 * Ordering: `agent/created` is awaited by the official registry BEFORE queued
 * work is released, and the creation dispatch is serial, so an Agent is always
 * installed on before its first `systemPrompt.assemble()`. Already-live Agents
 * at construction are installed through `agents.list()`.
 */
export class HostAgentPromptOwner {
  private readonly ctx: Context
  private readonly options: HostAgentPromptInstallOptions
  private readonly installed = new Map<string, InstalledAgent>()
  private readonly lifecycle = new AbortController()
  private readonly disposeCreated: () => void
  private readonly disposeDisposed: () => void

  constructor(ctx: Context, options: HostAgentPromptInstallOptions) {
    this.ctx = ctx
    this.options = options
    this.disposeCreated = ctx.on('agent/created', ({ agent }) => {
      this.install(agent as unknown as HostAgentLike)
      return undefined
    }, { global: true })
    this.disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.retire((agent as unknown as HostAgentLike).id)
    }, { global: true })
    ctx.effect(() => () => this.dispose(), 'pi-tui-host-agent-prompt')
  }

  /** Install on every Agent that is already live (a late-created Host row). */
  installLiveAgents(): void {
    const registry = this.ctx.reflect.get('agents') as
      | { list(): readonly HostAgentLike[] }
      | undefined
    if (registry === undefined) return
    for (const agent of registry.list()) this.install(agent)
  }

  /** The Agent ids this owner currently holds an installation for. */
  installedSessionIds(): readonly string[] {
    return [...this.installed.keys()]
  }

  /** Install on one Agent exactly once per Agent lifetime. */
  install(agent: HostAgentLike): void {
    if (this.lifecycle.signal.aborted) return
    if (this.installed.has(agent.id)) return
    const disposers = installHostAgentPrompt(agent, this.options)
    if (disposers.length === 0) return
    this.installed.set(agent.id, { sessionId: agent.session.id, disposers })
  }

  /** Dispose one Agent's installation (its scope unwinds it too). */
  private retire(agentId: string): void {
    const entry = this.installed.get(agentId)
    if (entry === undefined) return
    this.installed.delete(agentId)
    for (const dispose of entry.disposers) dispose()
  }

  /** Remove the Host listeners and unwrap every installation. */
  dispose(): void {
    if (this.lifecycle.signal.aborted) return
    this.lifecycle.abort()
    this.disposeCreated()
    this.disposeDisposed()
    for (const entry of this.installed.values()) {
      for (const dispose of entry.disposers) dispose()
    }
    this.installed.clear()
  }
}