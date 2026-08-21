/**
 * `!` shell context submission (kimi parity): a completed local shell run
 * is submitted to the session as an ordinary guarded user message, so the
 * model sees the command AND its output on the next turn. `!!` runs stay
 * purely local — no session write, no model visibility (pi's
 * excluded-from-context semantics). Extracted from the runner so the
 * guard/TOCTOU races are testable headless, exactly like steer.ts:
 *
 * - The agent/generation identity is captured BEFORE the guard runs.
 * - AFTER the guard returns, the identity is re-validated: same agent
 *   object, same session generation. A switch while the guard read the
 *   file aborts (`stale`) — the output is never written to a session the
 *   guard did not check.
 * - A blocked write keeps the caller's card visible (the output is not
 *   lost) and the identical `!` re-run can force through its one-time
 *   guard token.
 * @module @xmoon76/dsh-pi-tui/shell-context
 */

import { sessionUnchanged } from './steer.ts'

/** The minimal agent surface the shell submit needs (the runner's live agent). */
export interface ShellSubmitAgentLike {
  session: { id: string }
  followup(message: unknown): void
}

/** The guard surface: run the divergence check for one write action. */
export interface ShellSubmitGuard {
  /** Run the divergence guard; `blocked` carries the divergence kind. */
  run(identity: string): Promise<
    | { kind: 'ok' | 'forced' }
    | { kind: 'blocked'; reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed' }
  >
}

export type ShellSubmitOutcome = 'ok' | 'blocked' | 'stale'

/** Injectable dependencies of {@link submitShellResult}. */
export interface ShellSubmitDeps {
  /** Current live agent, re-read on every access (TOCTOU detection). */
  currentAgent(): ShellSubmitAgentLike | undefined
  /** Current session generation, re-read (session switch detection). */
  currentGeneration(): number
  guard: ShellSubmitGuard
  notify(message: string, kind: 'info' | 'error'): void
  /** Divergence notice for one block reason ('submit' action wording). */
  blockedNotice(reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed'): string
  /** Notice for a forced (token-bypassed) write. */
  forcedNotice(): string
  /** Notice for a session switch detected after the guard. */
  staleNotice(): string
  /** Build the user message (runner-side creation, keeps this module dsh-free). */
  createMessage(text: string): unknown
  /** Called once the message was accepted by the agent (followup sent). */
  onSubmitted(): void
}

/**
 * Submit a completed `!` shell run's command+output to the session:
 * capture identity → guard → re-validate → followup. No-op without an
 * agent. `blocked` keeps the caller's card (the output stays visible; the
 * identical `!` re-run can force through its one-time token); `stale`
 * aborts for a retry against the new session.
 */
export async function submitShellResult(deps: ShellSubmitDeps, text: string): Promise<ShellSubmitOutcome> {
  const agent = deps.currentAgent()
  if (agent === undefined) return 'ok'
  const generation = deps.currentGeneration()
  const verdict = await deps.guard.run(text)
  if (verdict.kind === 'blocked') {
    deps.notify(deps.blockedNotice(verdict.reason), 'error')
    return 'blocked'
  }
  // TOCTOU re-validation: the session must be the exact one the guard
  // checked, or the submission is aborted for a retry against the new
  // session (which needs its own guard).
  if (!sessionUnchanged({ agent, generation }, deps.currentAgent(), deps.currentGeneration())) {
    deps.notify(deps.staleNotice(), 'error')
    return 'stale'
  }
  if (verdict.kind === 'forced') deps.notify(deps.forcedNotice(), 'error')
  agent.followup(deps.createMessage(text))
  deps.onSubmitted()
  return 'ok'
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
 * The model-facing submission text: the command echoed `$`-style (kimi
 * ShellExecution parity) followed by the settled card result (output +
 * `[exit N]` / truncation lines).
 */
export function formatShellSubmitText(command: string, result: string): string {
  return `$ ${command}\n${result}`
}
