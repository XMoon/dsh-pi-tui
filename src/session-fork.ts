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
  // The child inherits the parent's recorded preset (official fork
  // semantics: forkComposition = composeAgent(resolveSessionPreset(source))).
  const composition = await host.compose(resolveSessionPreset(source.session))
  const presetId = composition.agentPreset
  return host.agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: {
      cwd: host.sessionCwd(),
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

/** The swap refusal message when the captured surface identity changed while
 * the swap was being prepared: `swapTo` returns it BEFORE mutating anything
 * (the old handle is not yet disposed, the child not yet assigned), and
 * `commitRewind` maps it to the stale outcome plus a ghost-child disposal.
 * A shared constant so the two sides can never drift. */
export const SWAP_STALE_MESSAGE = 'session changed — rewind cancelled'

/** Whether a captured rewind identity still matches the live surface. The
 * swap's commit-boundary gate: a sessionless surface (`sessionId:
 * undefined`) can never match a captured source, so a surface that became
 * sessionless mid-swap is refused just like a switched one. Pure so the
 * race is unit-testable without the runner. */
export function isRewindIdentityCurrent(live: RewindLiveIdentity, expected: RewindLiveIdentity): boolean {
  return live.sessionId === expected.sessionId && live.generation === expected.generation
}

/** The commit host: the fork host plus the swap/dispose/restore seams. */
export interface RewindCommitHost extends ForkAgentHost {
  /** The live surface identity, re-read at every gate. */
  liveIdentity(): RewindLiveIdentity
  /** Swap the live agent to the child (the runner's session-swap chain).
   * `expected` is the surface identity the picker captured: when the swap
   * would commit into a DIFFERENT surface (a switch happened while the
   * swap was being prepared), it must refuse by returning
   * {@link SWAP_STALE_MESSAGE} BEFORE disposing the current handle or
   * assigning the child — the caller then disposes the ghost child. Other
   * failures return an error string (or reject); the caller decides
   * whether the child became live. */
  swapTo(next: AgentHandle, expected?: RewindLiveIdentity): Promise<string | undefined>
  /** Dispose a created-but-not-committed child (stale gate 2, stale swap). */
  disposeAgent(handle: AgentHandle): Promise<void>
  /** Restore the selected prompt into the editor — runs ONLY after the
   * swap committed (a failed create/swap never overwrites the draft). */
  replaceDraft(text: string): void
}

/** The settled outcome of a rewind commit. */
export type RewindCommitOutcome =
  | { kind: 'rewound'; sessionId: string; turn: number; hasNonTextContent: boolean }
  | { kind: 'stale' }
  | { kind: 'failed'; message: string }

/**
 * Commit one rewind selection: fork the source before the candidate's turn,
 * swap to the child, then restore the selected prompt into the editor.
 *
 * Ordering contract (plan §29): create → swap COMMIT → replaceDraft. A
 * failed create or swap keeps the CURRENT session and never touches the
 * editor; the source session is never modified at any point.
 *
 * @param host - the commit host.
 * @param source - the live agent whose session the picker listed.
 * @param candidate - the selected rewind point.
 * @param expected - the source identity captured when the picker opened
 *   (stale gates: the picker's selection must not commit into a surface
 *   another path has switched away from).
 * @returns the outcome; `stale` when the source no longer owns the surface
 *   (a gate-2 stale child is disposed first).
 */
export async function commitRewind(
  host: RewindCommitHost,
  source: Agent,
  candidate: RewindCandidate,
  expected: RewindLiveIdentity,
): Promise<RewindCommitOutcome> {
  // Gate 1: create only while the source still owns the surface.
  const identity = host.liveIdentity()
  if (identity.sessionId !== expected.sessionId || identity.generation !== expected.generation) {
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
  const next = await createForkedAgent(host, source, seed)
  // Gate 2: the swap may commit only into the SAME surface. A child created
  // into a stale surface is disposed through the official handle path —
  // never left behind as a ghost the user never switched to (plan §12).
  const beforeSwap = host.liveIdentity()
  if (beforeSwap.sessionId !== expected.sessionId || beforeSwap.generation !== expected.generation) {
    try {
      await host.disposeAgent(next)
    } catch {
      // Disposal is best-effort; the stale outcome still wins.
    }
    return { kind: 'stale' }
  }
  // The swap itself carries the expected identity (the runner re-checks it
  // inside its commit boundary, after the flush and before any assignment),
  // so a switch racing the swap can still refuse — see the host contract.
  const error = await host.swapTo(next, expected)
  if (error !== undefined) {
    // Whether the child became live decides the cleanup: if the surface
    // still shows the EXPECTED source, the swap never assigned the child —
    // dispose the ghost through the official handle path (plan §12: never
    // leave a rewind child the user did not switch to). If the identity
    // moved (a partial commit — the child may already be live, or another
    // path switched), disposing would kill a live agent: the shared swap
    // failure cleanup (lock repair + the live surface) owns that path.
    const after = host.liveIdentity()
    const committed = after.sessionId !== expected.sessionId || after.generation !== expected.generation
    if (!committed) {
      try {
        await host.disposeAgent(next)
      } catch {
        // Disposal is best-effort; the failure outcome still wins.
      }
    }
    return error === SWAP_STALE_MESSAGE ? { kind: 'stale' } : { kind: 'failed', message: error }
  }
  // The swap COMMITTED: restore the selected prompt (synchronous, cannot
  // fail — the user sees their historic prompt ready to edit and resend).
  host.replaceDraft(candidate.editorText)
  return {
    kind: 'rewound',
    sessionId: next.agent.session.id,
    turn: candidate.turn,
    hasNonTextContent: candidate.hasNonTextContent,
  }
}
