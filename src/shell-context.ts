/**
 * `!` shell context submission (kimi parity): a completed local shell run
 * is submitted to the session as an ordinary user message, so the
 * model sees the command AND its output on the next turn. `!!` runs stay
 * purely local — no session write, no model visibility (pi's
 * excluded-from-context semantics). Extracted from the runner so the
 * TOCTOU races are testable headless, exactly like steer.ts:
 *
 * - The agent/generation identity is captured BEFORE the awaited write
 *   window.
 * - Before the followup, the identity is re-validated: same agent
 *   object, same session generation. A switch mid-send aborts
 *   (`stale`) — the output is never written to a session the identity
 *   did not verify.
 * @module @xmoon76/dsh-pi-tui/shell-context
 */

import { cancellationError } from './detached.ts'
import { sessionUnchanged } from './steer.ts'
import type { SessionWriter } from './runtime/session-writer-port.ts'
import { SessionOperationBarrier, TransitionInProgressError } from './session-operation-barrier.ts'

/** The minimal agent surface the shell submit needs (the runner's live agent). */
export interface ShellSubmitAgentLike {
  session: { id: string }
}

export type ShellSubmitOutcome = 'ok' | 'stale' | 'indeterminate'

/** Injectable dependencies of {@link submitShellResult}. */
export interface ShellSubmitDeps {
  /** Current live agent, re-read on every access (TOCTOU detection). */
  currentAgent(): ShellSubmitAgentLike | undefined
  /** Current session generation, re-read (session switch detection). */
  currentGeneration(): number
  notify(message: string, kind: 'info' | 'error'): void
  /** Notice for a session switch detected mid-send. */
  staleNotice(): string
  /**
   * The session-transition write fence: returns true while a session
   * transition is in flight (quiesce → commit) — a followup in that
   * window would target a session whose lock is about to be released
   * (the old agent may be woken again between whenIdle and the lock
   * handover). Optional; absent keeps the historical behavior.
   */
  fence?: () => boolean
  /** The fence refusal notice (defaults to {@link staleNotice}). */
  fenceNotice?: () => string
  /**
   * The session operation barrier (convergence plan phase 3): the shell
   * write runs inside `runWriter`, so a transition started while the
   * shell result awaits drains it first.
   */
  barrier?: SessionOperationBarrier
  /** Deliver the shell result through the semantic session writer. */
  writer: Pick<SessionWriter, 'prompt'>
  /** Build the user message (runner-side creation, keeps this module dsh-free). */
  createMessage(text: string): unknown
  /** Called once the message was accepted by the agent (followup sent). */
  onSubmitted(): void
}

/**
 * Submit a completed `!` shell run's command+output to the session:
 * barrier → capture identity → re-validate → followup. No-op without an
 * agent. `stale` aborts for a retry against the new session (the
 * caller's card keeps the output visible either way).
 */
export async function submitShellResult(deps: ShellSubmitDeps, text: string): Promise<ShellSubmitOutcome> {
  // Capture before entering the barrier: a delayed shell result belongs to
  // the session that was current when this submit began, never whichever
  // Agent happens to be live after a transition drains.
  const agent = deps.currentAgent()
  if (agent === undefined) return 'ok'
  const generation = deps.currentGeneration()
  const barrier = deps.barrier
  if (barrier !== undefined) {
    try {
      return await barrier.runWriter(agent.session.id, async () => submitShellResultCore(deps, text, agent, generation))
    } catch (error) {
      if (error instanceof TransitionInProgressError) {
        deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
        return 'stale'
      }
      throw error
    }
  }
  return submitShellResultCore(deps, text, agent, generation)
}

async function submitShellResultCore(
  deps: ShellSubmitDeps,
  text: string,
  agent: ShellSubmitAgentLike,
  generation: number,
): Promise<ShellSubmitOutcome> {
  // TOCTOU re-validation: the session must still be the exact one the
  // identity was captured from, or the submission is aborted for a retry
  // against the new session.
  if (!sessionUnchanged({ agent, generation }, deps.currentAgent(), deps.currentGeneration())) {
    deps.notify(deps.staleNotice(), 'error')
    return 'stale'
  }
  // The session-transition write fence: while a transition is in flight
  // the old agent may be woken again — writing would target a session
  // whose lock is about to be released (the two-writers race). The
  // caller's card keeps the output visible; the `!` line can be re-run
  // after the transition settles.
  if (deps.fence?.() === true) {
    deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
    return 'stale'
  }
  const outcome = await deps.writer.prompt(agent.session.id, deps.createMessage(text), 'queue')
  if (outcome.kind === 'committed') {
    deps.onSubmitted()
    return 'ok'
  }
  if (outcome.kind === 'cancelled') throw cancellationError('shell session write cancelled')
  if (outcome.kind === 'indeterminate') {
    deps.notify('shell session write result is indeterminate — do not retry automatically', 'error')
    return 'indeterminate'
  }
  deps.notify(outcome.kind === 'rejected' ? outcome.error.message : outcome.reason, 'error')
  return 'stale'
}

/**
 * Classify one `!` line: 'context' submits the command+output to the
 * session (kimi parity), 'local' runs purely off-session (pi's `!!`
 * escape hatch). Returns undefined for a non-`!` line.
 */
export function shellModeOf(text: string): 'context' | 'local' | undefined {
  if (!text.startsWith('!')) return undefined
  return text.startsWith('!!') ? 'local' : 'context'
}

/** Extract the command after the `!` prefix ('' when nothing follows). */
export function shellCommandOf(text: string): string {
  return text.replace(/^!+/, '').trim()
}

/**
 * The local-shell sandbox preference for user-typed `!`/`!!` commands:
 * 'sandbox' routes them through the dsh shell capability's policy,
 * anything else (including an absent settings document) is 'bypass' — the
 * pi/kimi default that runs the user's own commands outside the sandbox
 * (the sandbox guards the model's autonomous commands, not the user's).
 * @param settings - the TUI settings document's fields, when present.
 */
export function localShellSandboxPreferenceOf(settings: { localShellSandbox?: string } | undefined): 'bypass' | 'sandbox' {
  return settings?.localShellSandbox === 'sandbox' ? 'sandbox' : 'bypass'
}

/**
 * The model-facing submission text: the command echoed `$`-style (kimi
 * ShellExecution parity) followed by the settled card result (output +
 * `[exit N]` / truncation lines).
 */
export function formatShellSubmitText(command: string, result: string): string {
  return `$ ${command}\n${result}`
}