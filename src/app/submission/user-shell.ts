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

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createBoundedOutput, createFileCapture, formatBytes, formatTruncation, SHELL_OUTPUT_DISK_CAP_BYTES } from '../../bounded-output.ts'
import type { Diag } from '../../diag.ts'
import { runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { interruptAgent, type InterruptAgentLike } from '../../interrupt.ts'
import type { TuiSettingsDoc } from '../../runtime/config-port.ts'
import type { HostUserShellPort } from '../../runtime/host-user-shell-port.ts'
import type { SessionWriter } from '../../runtime/session-writer-port.ts'
import { localShellSandboxPreferenceOf, shellCommandOf, shellModeOf } from '../../shell-context.ts'
import { sessionUnchanged } from '../../steer.ts'
import { submitShell } from '../submission/runtime.ts'
import type { LiveSessionScope } from '../session/scope.ts'
import type { TuiApp } from '../../tui-app.ts'

/** Throttle for re-chaining a RUNNING user-shell card's result to the bounded
 * tail (plan §5.1): the running preview refreshes at most this often, so a
 * high-throughput log cannot rebuild the view per chunk. */
const USER_SHELL_TAIL_FLUSH_MS = 200

/** The narrow capabilities the user shell consumes. */
export interface UserShellDeps<ExactAgent extends InterruptAgentLike> {
  /** The mounted app (shell card + notifications). */
  readonly app: () => TuiApp
  readonly diag: Diag
  readonly isCleanedUp: () => boolean
  /** The exact live Agent of the current owner, or undefined (Direct-only
   * fact; the Remote branch runs the same owner with `undefined` here). */
  readonly liveAgent: () => ExactAgent | undefined
  /** The ownership generation read (the run-start fence). */
  readonly ownership: { generation(): number }
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  readonly session: { withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T> }
  /** The synchronous live-scope capture (the interrupt admission). */
  readonly requireLiveScope: () => LiveSessionScope
  /** The scope-bound writer section (the context-mode shell submit). */
  readonly writerSection: <T>(task: () => Promise<T>) => Promise<T>
  /** The semantic session writer (the interrupt cancel + prompt write). */
  readonly writer: SessionWriter
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
  /** Run one `!` / `!!` command. */
  run(text: string, ackToken: number | undefined): void
  /** Abort the running Host user-shell run and interrupt the live Agent (Esc / cancel). */
  interrupt(): void
  /** Abort the run and remove every retained full-output temp file. */
  dispose(): void
}

/** Format the settled Host run for the card: the bounded tail plus the
 * authoritative exit marker, shared by the streamed and settled paths. */
function formatSettledOutput(output: readonly { readonly text: string }[], exit: string): string {
  const text = output.map(chunk => chunk.text).join('').trim()
  return text === '' ? exit : `${text}\n[${exit}]`
}

/** Create the user-shell owner (plan §A5b-4 + the shell amendment). */
export function createUserShell<ExactAgent extends InterruptAgentLike>(
  deps: UserShellDeps<ExactAgent>,
): UserShellOwner {
  // Abort handle for the currently running Host user-shell run.
  let shellController: AbortController | undefined

  /** Stop the captured live Agent through the SessionWriter seam. The
   * operation barrier keeps the async outcome inside the same session
   * ownership window as other TUI writes. The Agent turn cancel and the
   * Host shell process cancel are DISTINCT semantic operations: this one
   * is the turn cancel only (the process cancel is the controller above). */
  const interruptLiveAgent = (): void => {
    if (deps.isCleanedUp()) return
    shellController?.abort()
    const agent = deps.liveAgent()
    if (agent === undefined) return
    const generation = deps.ownership.generation()
    // The scope-bound writer admission (A3-4): interrupt is NOT a submission
    // write, so its business ownership stays here — only the admission moves
    // through SessionRuntime.withWriter.
    runOwned('agent interrupt', () => deps.session.withWriter(
      deps.requireLiveScope(),
      () => interruptAgent(agent, deps.writer),
    ), {
      diag: deps.diag,
      sessionId: () => deps.liveAgent()?.session.id,
      onResult: (outcome) => {
        if (deps.isCleanedUp() || !sessionUnchanged({ agent, generation }, deps.liveAgent(), deps.ownership.generation())) return
        if (outcome.kind === 'committed' || outcome.kind === 'cancelled') return
        const message = outcome.kind === 'rejected'
          ? outcome.error.message
          : outcome.kind === 'unsupported'
            ? outcome.reason
            : outcome.kind === 'indeterminate'
              ? 'session cancellation result is indeterminate — do not retry automatically'
              : 'session cancellation was cancelled'
        deps.app().notify(message, 'error')
      },
      onError: (error) => {
        if (deps.isCleanedUp() || !sessionUnchanged({ agent, generation }, deps.liveAgent(), deps.ownership.generation())) return
        deps.app().notify(safeErrorMessage(error), 'error')
      },
    })
  }

  // 0600 temp files holding FULL user-shell output (for truncated runs);
  // removed at TUI exit (default), never on their own.
  const shellTempFiles = new Set<string>()

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
  const runUserShell = (text: string, ackToken: number | undefined): void => {
    if (deps.isCleanedUp()) return
    const includeInContext = shellModeOf(text) === 'context'
    const command = shellCommandOf(text)
    if (command === '') return
    // NOTE: the context-mode submit ack is armed AT THE GESTURE in
    // dispatchUserInput (before ensureSession) — NEVER here, or the T0
    // baseline would rebase after the session create. `ackToken` scopes
    // every terminal settle below to THIS gesture: a newer submission
    // (bumped epoch) makes them no-ops.
    const shellTerminalAck = (reason: string): void => {
      if (ackToken === undefined) return
      deps.submission.settleAck(reason, { token: ackToken, terminal: true })
    }
    // The generation the run STARTED under: a session switch while the
    // command runs must not post the output into the new session (the
    // switch already cleared the card; the notify explains what happened).
    const generationAtRun = deps.ownership.generation()
    shellController?.abort()
    shellController = new AbortController()
    const localSignal = shellController.signal
    // The card reference this run owns: settling by identity keeps a
    // settled old run from overwriting a newer run's card (updateLastLocal
    // Message would hit whatever card is newest at settle time). The
    // reference is RE-CHAINED on every in-flight tail update (the array
    // element is replaced, so the old reference would no longer index).
    let card = deps.app().pushLocalMessage({
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
    const submitResult = (result: string): void => {
      submitShell({
        command,
        result,
        generationAtRun,
        isDisposed: () => deps.isCleanedUp(),
        currentGeneration: () => deps.ownership.generation(),
        currentSessionId: () => deps.liveAgent()?.session.id,
        currentAgent: () => deps.liveAgent(),
        terminalAck: shellTerminalAck,
        clearSettledLocalMessages: () => deps.app().clearSettledLocalMessages(),
        notify: (message, kind) => {
          if (deps.isCleanedUp()) return
          deps.app().notify(message, kind)
        },
        markDispatch: (sessionId) => deps.submission.markDispatch(sessionId),
        writerSection: deps.writerSection,
        writer: deps.writer,
        createMessage: (messageText) => createUserMessage({
          content: [{ type: 'text', text: messageText }],
          source: { kind: 'user' },
        }),
        diag: deps.diag,
      })
    }
    // A settled latch: the card must settle EXACTLY once — the first
    // authoritative event wins.
    let settled = false
    const settle = (result: string, status: 'ok' | 'error'): void => {
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
      if (includeInContext && localSignal.aborted) {
        shellTerminalAck('shell run aborted')
      }
      if (includeInContext && !localSignal.aborted) submitResult(result)
    }
    // The Host execution policy from the persisted preference (a policy
    // name, never a locality choice). An unavailable policy fails closed
    // INSIDE the port with a visible message — nothing is executed and the
    // card settles as a failed run.
    const policy = localShellSandboxPreferenceOf(deps.tuiSettings?.get())
    // An owned workflow: the RESULT settles the UI card, so the settle
    // logic stays in onResult and the cancellation/failure semantics stay
    // per-task (runOwned — AGENTS.md). The admission is async because the
    // port owns the Host-side execution start.
    runOwned('user shell', async () => {
      const admission = await deps.shell.execute({
        sessionId: deps.liveAgent()?.session.id ?? '',
        cwd: deps.status.sessionCwd(),
        command,
        policy,
        signal: localSignal,
      })
      if (admission.kind === 'unavailable') {
        releaseController()
        // Fail closed: NOTHING executed. The card settles as a failed run
        // with the port's truthful message; no Session write happens (the
        // settle gate below sees the same terminal-ack path as any other
        // failed run).
        settle(admission.reason.message, 'error')
        return
      }
      const execution = admission.execution
      // Bounded capture: the card keeps only the TAIL (byte- and line-
      // capped, unterminated output included); the FULL output is streamed
      // to a 0600 temp file (disk-capped) so a truncated run still leaves
      // the complete transcript available. Untruncated runs delete the
      // file on settle; the files that remain are removed at TUI exit.
      const bounded = createBoundedOutput()
      const fullPath = join(tmpdir(), `dsh-pi-tui-shell-${process.pid}-${randomUUID()}.log`)
      const full = createFileCapture(fullPath, SHELL_OUTPUT_DISK_CAP_BYTES)
      if (full.active) shellTempFiles.add(fullPath)
      // In-flight tail refresh (plan §5.1): the running card's result is
      // re-chained to the bounded TAIL on a throttle, so a streaming log
      // previews its newest rows instead of an empty body.
      let tailTimer: NodeJS.Timeout | undefined
      const clearTailTimer = (): void => {
        if (tailTimer !== undefined) {
          clearTimeout(tailTimer)
          tailTimer = undefined
        }
      }
      const scheduleTailFlush = (): void => {
        if (deps.isCleanedUp() || tailTimer !== undefined) return
        tailTimer = setTimeout(() => {
          tailTimer = undefined
          if (deps.isCleanedUp()) return
          card = deps.app().updateLocalMessage(card, {
            kind: 'tool',
            turn: Number.POSITIVE_INFINITY,
            name: 'shell',
            args: command,
            result: bounded.tail,
            status: 'running',
          })
        }, USER_SHELL_TAIL_FLUSH_MS)
      }
      // Live output: each chunk feeds the bounded tail AND the full-output
      // capture; the adapter owns the stream, this owner owns the
      // presentation policy only.
      void (async () => {
        for await (const chunk of execution.output()) {
          if (deps.isCleanedUp()) return
          bounded.append(chunk.text, chunk.bytes)
          full.append(Buffer.from(chunk.text, 'utf8'))
          scheduleTailFlush()
        }
      })()
      const result = await execution.result()
      releaseController()
      clearTailTimer()
      if (deps.isCleanedUp()) {
        full.dispose()
        shellTempFiles.delete(fullPath)
        return
      }
      if (result.aborted) {
        // The run was cancelled: the partial capture is noise, delete it.
        full.dispose()
        shellTempFiles.delete(fullPath)
        settle('aborted', 'error')
        return
      }
      if (bounded.truncated) {
        // Keep the full-output file for a truncated run — but only when
        // the capture is actually alive (creation/write failures are
        // never advertised, and a disk-capped file says so).
        if (full.exists) {
          full.close()
        } else {
          full.dispose()
          shellTempFiles.delete(fullPath)
        }
        const output = bounded.tail.trim()
        const lines: string[] = []
        if (output !== '') lines.push(output)
        lines.push(formatTruncation(bounded))
        if (full.exists) {
          lines.push(full.truncated
            ? `full output (disk capture truncated at ${formatBytes(SHELL_OUTPUT_DISK_CAP_BYTES)}): ${fullPath}`
            : `full output: ${fullPath}`)
        }
        const exit = result.exit.kind === 'exit' ? `exit ${result.exit.code}` : `signal ${result.exit.signal}`
        lines.push(`[${exit}]`)
        settle(lines.join('\n'), result.exit.kind === 'exit' && result.exit.code === 0 ? 'ok' : 'error')
        return
      }
      // Untruncated output: no reason to keep a user-invisible temp file
      // around until TUI exit.
      full.dispose()
      shellTempFiles.delete(fullPath)
      const exit = result.exit.kind === 'exit' ? `exit ${result.exit.code}` : `signal ${result.exit.signal}`
      settle(formatSettledOutput(result.output, exit), result.exit.kind === 'exit' && result.exit.code === 0 ? 'ok' : 'error')
    }, {
      diag: deps.diag,
      sessionId: () => deps.liveAgent()?.session.id,
      isCancellation: () => localSignal.aborted,
      onCancel: () => {
        // A cancellation-shaped rejection before the admission settled:
        // release the controller and settle the card as aborted; the ack
        // row must end here (idempotent with the settle gate).
        releaseController()
        settle('aborted', 'error')
        if (includeInContext && !localSignal.aborted) {
          shellTerminalAck('shell run cancelled')
        }
      },
      onError: (error) => {
        releaseController()
        // An infrastructure failure (nothing executed — e.g. an unusable
        // cwd or a spawn failure): settle the card like a failed run. A
        // failure here does NOT run submitResult (only the settled
        // committed path does), so this exit is terminal for the ack row.
        const message = safeErrorMessage(error)
        settle(`failed: ${message}`, 'error')
        if (includeInContext && !localSignal.aborted) {
          shellTerminalAck('shell run failed')
        }
      },
    })
  }

  const dispose = (): void => {
    shellController?.abort()
    for (const file of shellTempFiles) {
      try {
        rmSync(file, { force: true })
      } catch {
        // Best effort.
      }
    }
    shellTempFiles.clear()
  }

  return {
    run: runUserShell,
    interrupt: interruptLiveAgent,
    dispose,
  }
}
