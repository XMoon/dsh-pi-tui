/**
 * Test-only adapter that projects a stub runner's live session state onto the
 * A3-0/A3-2 `TuiCommandRunner` SCOPE + FACADE members. It wires the REAL
 * production authorities (`createSessionSubjectAuthority` +
 * `createSessionScopeAuthority`) over the same mutable stub state, so a capture
 * is invalidated by an Agent swap and by a generation bump exactly like
 * production — never by a hand-rolled test approximation.
 *
 * The generic facade implementations are derived from `currentAgent` and the
 * REAL scope authority (so a stale scope throws `SupersededReadError`, exactly
 * like the production providers). A specific suite overrides the members whose
 * behavior it asserts by declaring them AFTER the spread.
 *
 * `currentSessionId` is deliberately NOT supplied: spreading this helper would
 * evaluate such a getter ONCE and freeze it to the stub-construction value. A
 * stub must expose `currentSessionId` from its OWN live state instead. The
 * facade members are FUNCTIONS, so spreading them can never freeze live state.
 *
 * This module is intentionally NOT `*.test.ts`: `pnpm test:product` globs
 * `test/*.test.ts` and must not execute it as a suite.
 * @module @xmoon76/dsh-pi-tui/session-scope-facts
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  createSessionScopeAuthority,
  type LiveSessionScope,
  type SessionScope,
  type SessionScopeAuthority,
} from '../src/app/session/scope.ts'
import {
  createSessionSubjectAuthority,
  type SessionOwnerRef,
} from '../src/app/session/subject.ts'
import { SupersededReadError } from '../src/runtime/read-error.ts'
import type { SkillDefinitionResult } from '../src/runtime/catalog-port.ts'
import type { HumanSkillCatalog } from '../src/skill-catalog.ts'
import type { CatalogRefreshOutcome, CatalogRefreshSource } from '../src/skill-catalog-refresh.ts'
import { computeStats, type SessionStats } from '../src/stats.ts'
import type { SurfaceCommandSummary } from '../src/surface-catalog.ts'

/** The subset of `TuiCommandRunner` the scope helper supplies: the CAPTURE
 * members plus the A3-2 scope-bound facades. A stub must also expose
 * `currentSessionId` from its OWN live state (a live getter, or `undefined`
 * for a sessionless stub). */
export interface SessionScopeFacts {
  captureSessionScope(): SessionScope
  captureLiveSessionScope(): LiveSessionScope | undefined
  isSessionScopeCurrent(scope: SessionScope): boolean
  requireLiveSessionScope(): Promise<LiveSessionScope>
  listScopedCommands(): readonly SurfaceCommandSummary[]
  resolveScopedSkill(scope: LiveSessionScope, name: string): Promise<SkillDefinitionResult>
  hostLoadsSkillBody(scope: LiveSessionScope): boolean
  listScopedSkills(scope: LiveSessionScope, signal?: AbortSignal): Promise<HumanSkillCatalog | undefined>
  currentSessionActivity(scope: LiveSessionScope): { readonly running: boolean }
  currentSessionRouting(scope: LiveSessionScope): {
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly cwd: string
  }
  currentApprovalOverride(scope: LiveSessionScope): 'ask' | 'never' | undefined
  currentSessionStats(scope: LiveSessionScope): SessionStats | undefined
  lastAssistantText(scope: LiveSessionScope): string | undefined
  refreshSessionCatalog(scope: SessionScope, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  refreshStandingCatalog(presetId: string | undefined, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  applyPermissionPreset(
    scope: LiveSessionScope,
    presetId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'applied' } | { kind: 'unavailable'; cause: 'commands' | 'permission' } | { kind: 'superseded' }>
  setSessionApprovalPolicy(scope: LiveSessionScope, value: 'ask' | 'never'): 'applied' | 'superseded'
}

/** The skill catalog capability the scope-bound skill facades read through. */
export interface ScopedSkillSource {
  resolveSkill(sessionId: string, name: string): Promise<SkillDefinitionResult>
  hostLoadsSkillBody(sessionId: string): boolean
  listHumanSkills(sessionId: string, signal?: AbortSignal): Promise<HumanSkillCatalog | undefined>
}

/**
 * Build the scope CAPTURE members and the scope-bound facades over a stub's
 * live state.
 *
 * @param currentAgent - re-reads the stub's live agent (its OWNER is the agent
 *   object itself, so swapping the agent invalidates a capture).
 * @param currentGeneration - re-reads the stub's current generation.
 * @param skills - the stub's REAL skill catalog port, when a suite exercises
 *   the /skill paths (omitted stubs fail closed).
 */
export function sessionScopeFacts(
  currentAgent: () => Agent | undefined,
  currentGeneration: () => number,
  skills?: ScopedSkillSource,
): SessionScopeFacts {
  const subjectAuthority = createSessionSubjectAuthority(() => {
    const agent = currentAgent()
    if (agent === undefined) return undefined
    return { owner: agent as unknown as SessionOwnerRef, generation: currentGeneration() }
  })

  const scopeAuthority: SessionScopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = subjectAuthority.capture()
      if (subject === undefined) {
        return { subject: undefined, sessionId: undefined, generation: currentGeneration() }
      }
      const agent = currentAgent()
      if (agent === undefined) throw new Error('a live ownership subject must carry a session id')
      return { subject, sessionId: agent.session.id, generation: currentGeneration() }
    },
    isSubjectCurrent: (subject) => subjectAuthority.isCurrent(subject),
  })

  /** The exact agent of a live scope, validated like the production provider. */
  const agentForLiveScope = (scope: LiveSessionScope): Agent => {
    if (!scopeAuthority.isCurrent(scope)) {
      throw new SupersededReadError('the session changed before the read')
    }
    const agent = currentAgent()
    if (agent === undefined || agent.session.id !== scope.sessionId) {
      throw new Error('a current live scope must resolve its exact Direct owner')
    }
    return agent
  }

  return {
    captureSessionScope: () => scopeAuthority.capture(),
    captureLiveSessionScope: () => scopeAuthority.captureLive(),
    isSessionScopeCurrent: (scope) => scopeAuthority.isCurrent(scope),
    requireLiveSessionScope: async () => {
      const scope = scopeAuthority.captureLive()
      if (scope === undefined) throw new Error('session could not be created')
      return scope
    },
    // The generic scoped view is empty; a suite that asserts scoped-command
    // collisions overrides this from its own commands registry.
    listScopedCommands: () => [],
    // The skill catalog reads mirror the production validate-before-dispatch /
    // re-validate-after-await shape; they delegate to the stub's real catalog
    // port when one is wired, and fail closed otherwise.
    resolveScopedSkill: async (scope, name) => {
      agentForLiveScope(scope)
      const resolved = skills === undefined ? { kind: 'unknown' as const } : await skills.resolveSkill(scope.sessionId, name)
      if (!scopeAuthority.isCurrent(scope)) {
        throw new SupersededReadError('the session changed while loading the skill')
      }
      return resolved
    },
    hostLoadsSkillBody: (scope) => {
      agentForLiveScope(scope)
      return skills === undefined ? false : skills.hostLoadsSkillBody(scope.sessionId)
    },
    listScopedSkills: async (scope, signal) => {
      agentForLiveScope(scope)
      const catalog = skills === undefined ? undefined : await skills.listHumanSkills(scope.sessionId, signal)
      if (!scopeAuthority.isCurrent(scope)) {
        throw new SupersededReadError('the session changed while reading the skill catalog')
      }
      return catalog
    },
    currentSessionActivity: (scope) => ({ running: agentForLiveScope(scope).status === 'running' }),
    currentSessionRouting: (scope) => {
      const agent = agentForLiveScope(scope)
      // `provider`/`model` stay OPTIONAL, exactly like the DSH contract.
      return {
        provider: agent.options.provider,
        model: agent.options.model,
        cwd: agent.session.header.cwd ?? '',
      }
    },
    currentApprovalOverride: (scope) => {
      agentForLiveScope(scope)
      return undefined
    },
    currentSessionStats: (scope) => computeStats(agentForLiveScope(scope).session.snapshotEvents()),
    lastAssistantText: (scope) => {
      const session = agentForLiveScope(scope).session
      for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(SessionSeq(seq))
        if (event?.type !== 'assistant/message') continue
        return event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
      }
      return undefined
    },
    // Catalog refreshes are suite-specific; the default reports "not wired".
    refreshSessionCatalog: async (scope) => {
      if (!scopeAuthority.isCurrent(scope)) throw new SupersededReadError('the session changed before the read')
      return { kind: 'failed', error: 'catalog refresh not wired in tests' }
    },
    refreshStandingCatalog: async () => ({ kind: 'failed', error: 'catalog refresh not wired in tests' }),
    // The writes mirror the production stale-before-dispatch refusal.
    applyPermissionPreset: async (scope) => {
      if (!scopeAuthority.isCurrent(scope)) return { kind: 'superseded' as const }
      agentForLiveScope(scope)
      if (!scopeAuthority.isCurrent(scope)) return { kind: 'superseded' as const }
      return { kind: 'applied' as const }
    },
    setSessionApprovalPolicy: (scope) => {
      if (!scopeAuthority.isCurrent(scope)) return 'superseded' as const
      agentForLiveScope(scope)
      return 'applied' as const
    },
  }
}
