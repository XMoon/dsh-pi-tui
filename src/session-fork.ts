/**
 * Shared forked-agent creation for `/fork` and conversation rewind.
 *
 * Both features create a child session from a seed through ONE chain
 * (plan §6.2): resolve the source's recorded preset → compose → agents.create
 * with `parentSession` + `seedLength` metadata → the caller swaps to it.
 * Only the seed computation differs (`forkSeed` for `/fork`, `rewindSeed`
 * for rewind), so the metadata, preset/provider/model inheritance and cwd
 * rules can never drift between the two surfaces.
 *
 * `commitRewind` is the rewind selection workflow (create → swap COMMIT →
 * restore the prompt), with the two stale-selection gates from plan §12:
 * the source must still own the surface before creation (gate 1) and before
 * the swap (gate 2 — a child created into a stale surface is disposed, never
 * left behind as a ghost).
 * @module @xmoon76/dsh-pi-tui/session-fork
 */

import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { rewindSeed, type RewindCandidate } from './rewind.ts'
import { safeErrorMessage } from './error-boundary.ts'

/** The narrow host surface child creation needs (plan §23) — the runner
 * satisfies it structurally. */
export interface ForkAgentHost {
  /** The live session's workspace (its header cwd), never a captured value. */
  sessionCwd(): string
  /** Compose one preset (undefined = the deployment default). */
  compose(presetId?: string): Promise<{
    agentPreset?: string
    setup: (agentCtx: import('@deepseek-ai/cordis').Context) => Promise<void> | void
  }>
  /** The agents service `/new` and `/fork` create sessions through. */
  agents: {
    create(options: {
      sessionId: SessionId
      meta: Record<string, unknown>
      agentOptions: { provider?: string; model?: string }
      setup: (agentCtx: import('@deepseek-ai/cordis').Context) => Promise<void> | void
      seed?: readonly SessionEvent[]
      signal?: AbortSignal
    }): Promise<AgentHandle>
  }
}

/**
 * Create one forked agent: the source's recorded preset, the live session's
 * cwd, the source's provider/model, and `parentSession` + `seedLength`
 * metadata (the exact chain `/fork` used before the extraction).
 * @param host - the fork host surface.
 * @param source - the session being forked from (never modified).
 * @param seed - the child's seed events (completed-turn prefix).
 * @returns the created agent handle (NOT yet swapped to).
 */
export async function createForkedAgent(
  host: ForkAgentHost,
  source: Agent,
  seed: readonly SessionEvent[],
): Promise<AgentHandle> {
  // Source-deterministic cwd, captured BEFORE the first await: a concurrent
  // surface switch between the compose await and the create must never mix
  // parent=A with cwd=B (review P2). The SOURCE's own workspace wins (the
  // child is a branch of that session); an empty/missing header cwd falls
  // back to the live surface cwd — inside the transition gate the two are
  // identical anyway, which makes the helper independent of that invariant.
  const cwd = source.session.header.cwd || host.sessionCwd()
  // The child inherits the parent's recorded preset (official fork
  // semantics: forkComposition = composeAgent(resolveSessionPreset(source))).
  const composition = await host.compose(resolveSessionPreset(source.session))
  const presetId = composition.agentPreset
  return host.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: {
      cwd,
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
      parentSession: source.session.id,
      seedLength: seed.length,
    },
    agentOptions: { provider: source.options.provider, model: source.options.model },
    setup: composition.setup,
    seed,
  })
}

/** The live surface identity a rewind commit checks against (stale gates). */
export interface RewindLiveIdentity {
  sessionId: string | undefined
  generation: number
}

/** Whether a captured rewind identity still matches the live surface: a
 * sessionless surface (`sessionId: undefined`) can never match a captured
 * source, so a surface that became sessionless is refused just like a
 * switched one. Pure so the race is unit-testable without the runner. */
export function isRewindIdentityCurrent(live: RewindLiveIdentity, expected: RewindLiveIdentity): boolean {
  return live.sessionId === expected.sessionId && live.generation === expected.generation
}

/** The commit host: the fork host plus the unified transition seam. */
export interface RewindCommitHost extends ForkAgentHost {
  /** The live surface identity, re-read at every gate. */
  liveIdentity(): RewindLiveIdentity
  /**
   * The unified session-transition transaction (the runner's
   * `transitionTo`): the OLD session is flushed BEFORE `create` runs, the
   * commit is a synchronous critical section, and once `create` succeeds
   * the child is published — there is NO failure path afterwards that may
   * be interpreted as "the child never happened" (there is no durable
   * rollback primitive; `dispose()` stops an agent but never deletes a
   * persisted session). Failures can therefore only occur BEFORE the
   * create: `prepare` throws (the caller's own gates — e.g. the stale
   * identity check) or `create` throws.
   */
  transitionTo<T extends AgentHandle>(steps: {
    prepare?: () => Promise<void> | void
    create: () => Promise<T>
  }): Promise<{ ok: true; next: T } | { ok: false; message: string }>
  /** Restore the selected prompt into the editor — runs ONLY after the
   * transaction committed (a failed prepare/create never overwrites the
   * draft). */
  replaceDraft(text: string): void
}

/** The settled outcome of a rewind commit. */
export type RewindCommitOutcome =
  | { kind: 'rewound'; sessionId: string; turn: number; hasNonTextContent: boolean }
  | { kind: 'stale' }
  | { kind: 'failed'; message: string }

/**
 * Commit one rewind selection: fork the source before the candidate's turn,
 * commit the child, then restore the selected prompt into the editor.
 *
 * Transaction contract (review round 2 — the durable-ghost blocker): the
 * stale check and the seed derivation run BEFORE anything is created; the
 * create itself happens inside the runner's unified transaction, which
 * flushes the old session first, commits synchronously, and never rolls a
 * published child back. A stale selection therefore never creates a child
 * at all, a failed create leaves the source untouched, and once the child
 * exists it IS the surface. The source session is never modified at any
 * point.
 *
 * MUST run inside the caller's session-transition gate (the runner wraps
 * the commit in the gate): with the gate held, no other transition can
 * interleave, so the pre-create stale check is authoritative.
 *
 * @param host - the commit host.
 * @param source - the live agent whose session the picker listed.
 * @param candidate - the selected rewind point.
 * @param expected - the source identity captured when the picker opened
 *   (a selection must not commit into a surface another path has switched
 *   away from).
 * @returns the outcome; `stale` when the source no longer owns the surface
 *   (detected before any child is created).
 */
export async function commitRewind(
  host: RewindCommitHost,
  source: Agent,
  candidate: RewindCandidate,
  expected: RewindLiveIdentity,
): Promise<RewindCommitOutcome> {
  // Stale gate BEFORE anything is created (inside the transition gate a
  // switch cannot interleave, so this is authoritative): a stale selection
  // never creates — and therefore never publishes — a child.
  const identity = host.liveIdentity()
  if (!isRewindIdentityCurrent(identity, expected)) {
    return { kind: 'stale' }
  }
  let seed: readonly SessionEvent[]
  try {
    seed = rewindSeed(source.session.events, candidate)
  } catch (error) {
    // The point vanished or the log turned malformed since the picker
    // opened: report, never create a child.
    return { kind: 'failed', message: safeErrorMessage(error) }
  }
  // The unified transaction: old-session flush → create → synchronous
  // commit → best-effort retire. Failures can only happen before the
  // create; once it succeeds the child IS the surface (no ghost, no
  // rollback).
  const result = await host.transitionTo({
    create: () => createForkedAgent(host, source, seed),
  })
  if (!result.ok) return { kind: 'failed', message: result.message }
  // The transaction COMMITTED: restore the selected prompt (synchronous,
  // cannot fail — the user sees their historic prompt ready to edit and
  // resend).
  host.replaceDraft(candidate.editorText)
  return {
    kind: 'rewound',
    sessionId: result.next.agent.session.id,
    turn: candidate.turn,
    hasNonTextContent: candidate.hasNonTextContent,
  }
}
