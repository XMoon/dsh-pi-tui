/**
 * UserShell (A5b-4 + shell amendment M3-4 PR3): the ONE owner of the `!` /
 * `!!` user-shell workflow and the live-Agent interrupt it shares an abort
 * handle with.
 *
 * `!` and `!!` are both Host-side user-shell operations; they differ only in
 * whether the completed result enters Session/model context (`!` submits
 * through the SessionWriter; `!!` stays presentation-only with zero Session
 * write). Execution is Host-owned behind the injected `HostUserShellPort`
 * — this application owner NEVER spawns a process itself, never touches
 * `ctx.shell`, and never holds a `ChildProcess`.
 *
 * The shell card identity / settlement state, the generation fence, the
 * first-settle-wins latch and the temp-file cleanup all move together with
 * the handlers. The module is deliberately neutral: the exact Agent type is
 * a generic parameter, the Host user-shell port arrives as an injected
 * capability, and the submission acknowledgement/latency seams are a narrow
 * late-bound group (the submission controller is built after this owner).
 * @module @xmoon76/dsh-pi-tui/app/submission/user-shell
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { InterruptAgentLike } from '../session/interrupt.ts'
import type { TuiSettingsDoc } from '../../runtime/config-port.ts'
import {
  HostUserShellOutcomeUnknownError,
  type HostUserShellOutput,
  type HostUserShellPolicy,
  type HostUserShellPort,
  type HostUserShellResult,
} from '../../runtime/host-user-shell-port.ts'
import type { SessionWriter, WriteOutcome } from '../../runtime/session-writer-port.ts'
import { localShellSandboxPreferenceOf, shellCommandOf, shellModeOf } from './shell-context.ts'
import { submitShell } from '../submission/runtime.ts'
import type { LiveSessionScope } from '../session/scope.ts'
import type { TuiApp } from '../../tui-app.ts'

/** The narrow capabilities the user shell consumes. */
export interface UserShellDeps<ExactAgent extends InterruptAgentLike> {
  /**
   * The PiTui local-card surface (shell card presentation). The `!`/`!!` run
   * is PiTui-only in PR3-B — the TSP renderer refuses at the submission
   * admission before this owner's `run()` can execute — so this seam stays a
   * `TuiApp` and is never exercised on the TSP branch.
   */
  readonly app: () => TuiApp
  /**
   * The renderer-neutral notice sink (PR3-B §B0-7): every failure/interrupt
   * notification routes through here (`surface.display.notify`), so the Esc
   * interrupt path cannot reach PiTui-only `TuiApp` members when a non-PiTui
   * renderer owns the terminal. The injected implementation never throws on
   * a disposed surface.
   */
  readonly notify: (message: string, kind?: 'error' | 'info') => void
  readonly diag: Diag
  readonly isCleanedUp: () => boolean
  /** The exact live Agent of the current owner, or undefined (Direct-only
   * fact; the Remote branch runs the same owner with `undefined` here). */
  readonly liveAgent: () => ExactAgent | undefined
  /** The ownership generation read (the run-start fence). */
  readonly ownership: { generation(): number }
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  readonly session: {
    withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
    /** The scope-bound CONTROL admission: a busy interrupt must still reach
     *  the exact captured owner while a navigation transition holds the
     *  ordinary-writer barrier. */
    interrupt(scope: LiveSessionScope): Promise<WriteOutcome<undefined>>
  }
  /** The synchronous live-scope capture (throws when no live owner). */
  readonly requireLiveScope: () => LiveSessionScope
  /** The optional live-scope capture (undefined when no live owner) — without
   * a live owner the turn-cancel gesture is a committed no-op. */
  readonly captureLiveScope: () => LiveSessionScope | undefined
  readonly isLiveScopeCurrent: (scope: LiveSessionScope) => boolean
  /** The scope-bound writer section (the context-mode shell submit). */
  readonly writerSection: <T>(scope: LiveSessionScope, task: () => Promise<T>) => Promise<T>
  /** The semantic session writer (the interrupt cancel + prompt write). */
  readonly writer: SessionWriter
  /** Remote-only immutable prompt snapshot builder; Direct keeps createUserMessage. */
  readonly prepareTransportMessage?: (sessionId: string, text: string) => Promise<unknown>
  /** The status owner seam (the shell working directory). */
  readonly status: { sessionCwd(): string }
  /** The TUI-settings facade (the Host user-shell policy), read live. */
  readonly tuiSettings: { get(): TuiSettingsDoc } | undefined
  /** The Host-owned user-shell execution port (the shell amendment's ONE
   * execution authority; never `ctx.shell`, never a Client spawn). */
  readonly shell: HostUserShellPort
  /** The LATE-BOUND submission seams (the controller is built after this
   *  owner): both are read at call time, so neither can go stale. */
  readonly submission: {
    settleAck(reason: string, options: { token?: number; terminal?: boolean }): void
    markDispatch(sessionId: string | undefined): void
  }
}

/** The user-shell owner as the rest of the application consumes it. */
export interface UserShellOwner {
  /**
   * Run one `!` / `!!` command.
   * `endWrite` releases the gesture's accepted business-write lifetime; it is
   * called EXACTLY once at this run's terminal settlement (including the
   * context-mode `!` Session write), never on a timer.
   */
  run(text: string, ackToken: number | undefined, endWrite: () => void): void
  /** Abort the running Host user-shell run and interrupt the live Agent (Esc / cancel). */
  interrupt(): void
  /** Abort the active Host Shell run only; false means no cancellable run exists. */
  cancelRun(): boolean
  /** Abort the active Host Shell run. */
  dispose(): void
}

/**
 * The short, terminal truncation marker for one settled stream. It deliberately
 * carries no byte count and no spill path: the card keeps this line at the very
 * end of its visible tail, where long raw output and long Host paths cannot
 * push a required marker out of view.
 */
function formatTruncation(stream: 'stdout' | 'stderr'): string {
  return `${stream} truncated`
}

/**
 * The optional Host-local spill detail for one truncated stream. It is a
 * separate line placed BEFORE the short marker so the marker remains the last
 * truncation fact even when the path is long or clipped.
 */
function formatSpill(stream: 'stdout' | 'stderr', output: HostUserShellOutput): string | undefined {
  if (!output.truncated || output.spillPath === undefined) return undefined
  return `${stream} spill (Host-local): ${output.spillPath}`
}

/** Format the settled one-shot Host run for the card: the two bounded streams,
 * their truthful truncation lines and the authoritative exit marker.
 *
 * Official bounded-tail diagnostic semantics: a sandbox nonzero exit with
 * truncated stderr always has an unknown failure reason. A denial or higher-
 * priority runner-fatal signature may have been dropped, even if the retained
 * tail appears to match one. The card preserves the exit and truncation facts,
 * but never claims a definite denial or runner failure from incomplete stderr.
 * A positive runner-failure classification on complete diagnostics is returned
 * before this formatter. */
export function formatHostUserShellResult(result: HostUserShellResult, policy: HostUserShellPolicy): string {
  const lines: string[] = []
  // A nonzero sandbox exit with truncated stderr cannot prove whether a
  // higher-priority runner-fatal line was dropped. That is a reason-unknown
  // settlement: never claim a definite denial or an ordinary command failure.
  const failureReasonUnknown = policy === 'sandbox'
    && result.exit.kind === 'exit'
    && result.exit.code !== 0
    && result.stderr.truncated
  if (result.sandboxDenied && !failureReasonUnknown) lines.push('sandbox denied')
  const stdout = result.stdout.text.trim()
  if (stdout !== '') lines.push(stdout)
  const stderr = result.stderr.text.trim()
  if (stderr !== '') lines.push(`[stderr]\n${stderr}`)
  const stdoutSpill = formatSpill('stdout', result.stdout)
  if (stdoutSpill !== undefined) lines.push(stdoutSpill)
  const stderrSpill = formatSpill('stderr', result.stderr)
  if (stderrSpill !== undefined) lines.push(stderrSpill)
  // Short markers stay AFTER the raw tails and the optional long spill paths,
  // so row/width compaction can never hide the explicit truncation fact.
  if (result.stdout.truncated) lines.push(formatTruncation('stdout'))
  if (result.stderr.truncated) lines.push(formatTruncation('stderr'))
  if (failureReasonUnknown) {
    lines.push('stderr truncated; failure reason cannot be determined, command may have executed; do not retry automatically')
  }
  if (result.timedOut) lines.push('[timed out]')
  lines.push(result.exit.kind === 'exit' ? `[exit ${result.exit.code}]` : `[signal ${result.exit.signal}]`)
  return lines.join('\n')
}

/** Create the user-shell owner (plan §A5b-4 + the shell amendment). */
export function createUserShell<ExactAgent extends InterruptAgentLike>(
  deps: UserShellDeps<ExactAgent>,
): UserShellOwner {
  // Abort handle for the currently running Host user-shell run.
  let shellController: AbortController | undefined

  /** Cancel only an active Host Shell process; idle Escape uses this path. */
  const cancelRun = (): boolean => {
    const controller = shellController
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** The busy Agent-turn/cancel-activity gesture: stop Shell work and the exact live Session turn. */
  const interrupt = (): void => {
    if (deps.isCleanedUp()) return
    cancelRun()
    const scope = deps.captureLiveScope()
    if (scope === undefined) return
    const generation = deps.ownership.generation()
    // The control admission captures the exact owner synchronously and is not
    // refused by a frozen transitional barrier. The business ownership stays
    // here: the outcome/notice gates below belong to this gesture.
    runOwned('agent interrupt', () => deps.session.interrupt(scope), {
      diag: deps.diag,
      sessionId: () => scope.sessionId,
      onResult: (outcome) => {
        if (deps.isCleanedUp() || deps.ownership.generation() !== generation) return
        if (outcome.kind === 'committed' || outcome.kind === 'cancelled') return
        const message = outcome.kind === 'rejected'
          ? outcome.error.message
          : outcome.kind === 'unsupported'
            ? outcome.reason
            : 'session cancellation result is indeterminate — do not retry automatically'
        deps.notify(message, 'error')
      },
      onError: (error) => {
        if (deps.isCleanedUp() || deps.ownership.generation() !== generation) return
        deps.notify(safeErrorMessage(error), 'error')
      },
    })
  }

  /**
   * Run a `!` / `!!` shell command. `!` (context mode) runs the command on
   * the Host and then submits the completed command+output to the session as
   * an ordinary user message (kimi parity: the model sees both on the next
   * turn; the result wakes a turn but is never steered into a running one);
   * `!!` (Session-excluded mode) runs on the Host with the SAME execution
   * locality and routing — the card is the only record (pi's
   * excluded-from-context escape hatch): zero SessionWriter.prompt, zero
   * context message, zero model visibility.
   */
  const runUserShell = (text: string, ackToken: number | undefined, endWrite: () => void): void => {
    // The gesture's accepted business-write lifetime: exactly one release at
    // this run's terminal settlement (M4 PR4 `/reload-client` safety).
    let writeSettled = false
    const settleWrite = (): void => {
      if (writeSettled) return
      writeSettled = true
      endWrite()
    }
    if (deps.isCleanedUp()) {
      settleWrite()
      return
    }
    const includeInContext = shellModeOf(text) === 'context'
    const command = shellCommandOf(text)
    if (command === '') {
      settleWrite()
      return
    }
    const shellTerminalAck = (reason: string): void => {
      if (ackToken === undefined) return
      deps.submission.settleAck(reason, { token: ackToken, terminal: true })
    }
    const scope = deps.captureLiveScope()
    if (scope === undefined) {
      deps.notify('user shell requires a live Session', 'error')
      shellTerminalAck('host user shell refused without a live Session')
      settleWrite()
      return
    }
    shellController?.abort()
    shellController = new AbortController()
    const localSignal = shellController.signal
    // The card reference this run owns: settling by identity keeps a
    // settled old run from overwriting a newer run's card (updateLastLocal
    // Message would hit whatever card is newest at settle time).
    const card = deps.app().pushLocalMessage({
      kind: 'tool',
      turn: Number.POSITIVE_INFINITY,
      name: 'shell',
      args: command,
      result: '',
      status: 'running',
    })
    /** Release the controller only when it still guards THIS run. */
    const releaseController = (): void => {
      if (shellController?.signal === localSignal) shellController = undefined
    }
    /**
     * Submit the completed run to the session (context mode only):
     * re-validate → followup. Accepted clears the settled card — the
     * transcript's user row becomes the record. The submission runtime owns
     * the ordered write, its outcome settlement and the card dismissal; the
     * runner supplies the narrow TUI hooks.
     */
    const prepareTransportMessage = deps.prepareTransportMessage
    const submitResult = (result: string): void => {
      submitShell({
        command,
        result,
        scope,
        isDisposed: () => deps.isCleanedUp(),
        isScopeCurrent: captured => deps.isLiveScopeCurrent(captured),
        terminalAck: shellTerminalAck,
        clearSettledLocalMessages: () => deps.app().clearSettledLocalMessages(),
        notify: (message, kind) => {
          if (deps.isCleanedUp()) return
          deps.notify(message, kind)
        },
        markDispatch: (sessionId) => deps.submission.markDispatch(sessionId),
        writerSection: deps.writerSection,
        writer: deps.writer,
        ...(prepareTransportMessage === undefined ? {} : {
          prepareMessage: (captured, messageText) => prepareTransportMessage(captured.sessionId, messageText),
        }),
        createMessage: (messageText) => createUserMessage({
          content: [{ type: 'text', text: messageText }],
          source: { kind: 'user' },
        }),
        diag: deps.diag,
        onSettled: settleWrite,
      })
    }
    // A settled latch: the card must settle EXACTLY once — the first
    // authoritative event wins.
    let settled = false
    const settle = (result: string, status: 'ok' | 'error', submitContext = true): void => {
      if (deps.isCleanedUp() || settled) return
      settled = true
      deps.app().updateLocalMessage(card, {
        kind: 'tool',
        turn: Number.POSITIVE_INFINITY,
        name: 'shell',
        args: command,
        result,
        status,
      })
      // Context mode submits every settled outcome except an abort (the
      // run was cancelled; the partial output is noise). An aborted run
      // is also TERMINAL for the submit acknowledgement (plan D exit
      // enumeration): the aborted gate suppresses submitResult, so the
      // pending row would otherwise outlive the gesture forever.
      // The aborted gate is TERMINAL for the ack in BOTH modes: `!!` arms
      // the same gesture token (the amendment made sessionless `!!` an
      // ensure-Session gesture), so its Submitting row must settle too.
      if (localSignal.aborted) {
        shellTerminalAck('shell run aborted')
        settleWrite()
      }
      if (includeInContext && submitContext && !localSignal.aborted) submitResult(result)
      else settleWrite()
    }
    // The Host execution policy from the persisted preference (a policy
    // name, never a locality choice). An unavailable policy fails closed
    // INSIDE the port with a visible message — nothing is executed and the
    // card settles as a failed run.
    const policy = localShellSandboxPreferenceOf(deps.tuiSettings?.get())
    // An owned workflow: one Host one-shot result settles the UI card, so
    // the settle logic stays in onResult and the cancellation/failure
    // semantics stay per-task (runOwned — AGENTS.md).
    runOwned('user shell', async () => {
      const outcome = await deps.shell.execute({
        sessionId: scope.sessionId,
        cwd: deps.status.sessionCwd(),
        command,
        policy,
        signal: localSignal,
      })
      if (outcome.kind === 'unavailable') {
        releaseController()
        // Fail closed: NOTHING executed. The card settles as a failed run
        // with the port's truthful message; no Session write happens. This
        // exit is TERMINAL for the gesture's ack row in BOTH modes (nothing
        // downstream — no submitResult — will settle it), so it settles here.
        settle(outcome.reason.message, 'error', false)
        shellTerminalAck('host user-shell unavailable')
        return
      }
      if (outcome.kind === 'indeterminate') {
        releaseController()
        settle(outcome.message, 'error', false)
        shellTerminalAck('host user-shell outcome is indeterminate')
        return
      }
      releaseController()
      if (deps.isCleanedUp()) return
      if (outcome.result.aborted) {
        if (localSignal.aborted) {
          // The CALLER cancelled (Esc): the bounded partial output is transient.
          settle('aborted', 'error')
          return
        }
        // The Host terminated the managed range because the transport went
        // away, NOT because the caller cancelled. The run was started and its
        // terminal fact is lost, so this is a transport-level UNKNOWN outcome:
        // say the command may have executed, write no Session result, and end
        // the gesture's ack row here (nothing downstream settles it).
        settle('The command may have executed — do not retry automatically', 'error', false)
        shellTerminalAck('host user-shell transport abort')
        return
      }
      settle(
        formatHostUserShellResult(outcome.result, policy),
        outcome.result.exit.kind === 'exit' && outcome.result.exit.code === 0 ? 'ok' : 'error',
      )
    }, {
      diag: deps.diag,
      sessionId: () => scope.sessionId,
      isCancellation: () => localSignal.aborted,
      onCancel: () => {
        // A cancellation-shaped rejection before the admission settled:
        // release the controller and settle the card as aborted; the ack
        // row must end here (idempotent with the settle gate).
        releaseController()
        settle('aborted', 'error')
        if (!localSignal.aborted) {
          shellTerminalAck('shell run cancelled')
        }
      },
      onError: (error) => {
        releaseController()
        if (error instanceof HostUserShellOutcomeUnknownError) {
          settle(`${error.message}\nThe command may have executed — do not retry automatically`, 'error', false)
          if (!localSignal.aborted) shellTerminalAck('host user-shell outcome unknown — do not retry automatically')
          return
        }
        const message = safeErrorMessage(error)
        settle(`failed: ${message}`, 'error', false)
        if (!localSignal.aborted) shellTerminalAck('shell run failed')
      },
    })
  }

  const dispose = (): void => {
    shellController?.abort()
  }

  return {
    run: runUserShell,
    interrupt,
    cancelRun,
    dispose,
  }
}
