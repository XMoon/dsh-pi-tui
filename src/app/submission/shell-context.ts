/**
 * `!` shell context submission (kimi parity): a completed Host user-shell
 * run is submitted to the session as an ordinary user message, so the
 * model sees the command AND its output on the next turn. `!!` results
 * stay Session/model-excluded — presentation-only, no session write, no
 * model visibility (pi's excluded-from-context semantics); execution is
 * still Host-side on both gestures (M3-4 PR3). Extracted from the runner
 * so the TOCTOU races are testable headless, exactly like app/submission/steer.ts:
 *
 * - The agent/generation identity is captured BEFORE the awaited write
 *   window.
 * - Before the followup, the identity is re-validated: same agent
 *   object, same session generation. A switch mid-send aborts
 *   (`stale`) — the output is never written to a session the identity
 *   did not verify.
 * @module @xmoon76/dsh-pi-tui/app/submission/shell-context
 */

import { cancellationError } from '../../runtime/process/tasks.ts'
import type { SessionWriter } from '../../runtime/session-writer-port.ts'
import { TransitionInProgressError } from '../session/operation-barrier.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../session/scope.ts'

export type ShellSubmitOutcome = 'ok' | 'stale' | 'indeterminate'

/** Injectable dependencies of {@link submitShellResult}. */
export interface ShellSubmitDeps {
  /** The exact live Session captured synchronously by this shell gesture. */
  readonly scope: LiveSessionScope
  /** Read the existing SessionScopeAuthority; no Client Agent is required. */
  readonly isScopeCurrent: (scope: LiveSessionScope) => boolean
  notify(message: string, kind: 'info' | 'error'): void
  staleNotice(): string
  fence?: () => boolean
  fenceNotice?: () => string
  /** The writer section must admit this captured scope, not a later current scope. */
  writerSection?: <T>(scope: LiveSessionScope, task: () => Promise<T>) => Promise<T>
  writer: Pick<SessionWriter, 'prompt'>
  /** Remote must build the immutable transport snapshot for the captured exact Session. */
  prepareMessage?: (scope: LiveSessionScope, text: string) => Promise<unknown>
  /** Direct's existing message builder; used when no transport preparer is composed. */
  createMessage: (text: string) => unknown
  onSubmitted(): void
}

export async function submitShellResult(deps: ShellSubmitDeps, text: string): Promise<ShellSubmitOutcome> {
  const { scope } = deps
  const writerSection = deps.writerSection
  if (writerSection !== undefined) {
    try {
      return await writerSection(scope, async () => submitShellResultCore(deps, text))
    } catch (error) {
      if (error instanceof TransitionInProgressError) {
        deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
        return 'stale'
      }
      if (error instanceof SessionScopeSupersededError) {
        deps.notify(deps.staleNotice(), 'info')
        return 'stale'
      }
      throw error
    }
  }
  return submitShellResultCore(deps, text)
}

async function submitShellResultCore(deps: ShellSubmitDeps, text: string): Promise<ShellSubmitOutcome> {
  if (!deps.isScopeCurrent(deps.scope)) {
    deps.notify(deps.staleNotice(), 'error')
    return 'stale'
  }
  if (deps.fence?.() === true) {
    deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
    return 'stale'
  }
  const message = deps.prepareMessage === undefined
    ? deps.createMessage(text)
    : await deps.prepareMessage(deps.scope, text)
  if (!deps.isScopeCurrent(deps.scope)) {
    deps.notify(deps.staleNotice(), 'error')
    return 'stale'
  }
  if (deps.fence?.() === true) {
    deps.notify(deps.fenceNotice !== undefined ? deps.fenceNotice() : deps.staleNotice(), 'info')
    return 'stale'
  }
  const outcome = await deps.writer.prompt(deps.scope.sessionId, message, 'queue')
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
 * The user-shell sandbox policy preference for user-typed `!`/`!!`
 * commands: 'sandbox' routes them through the dsh shell capability's
 * policy, anything else (including an absent settings document) is
 * 'bypass' — the pi/kimi default that runs the user's own commands
 * outside the sandbox (the sandbox guards the model's autonomous
 * commands, not the user's).
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