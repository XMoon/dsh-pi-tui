/**
 * LocalShell (A5b-4, plan §A5b-4): the ONE owner of the `!` / `!!` local
 * shell workflow and the live-Agent interrupt it shares an abort handle with.
 *
 * The shell card identity / settlement state, the generation fence, the
 * first-settle-wins latch and the temp-file cleanup all move together with the
 * handlers. The module is deliberately neutral: the exact Agent type is a
 * generic parameter, the dsh shell executor and the dsh environment arrive as
 * injected capabilities, and the submission acknowledgement/latency seams are a
 * narrow late-bound group (the submission controller is built after this
 * owner).
 * @module @xmoon76/dsh-pi-tui/app/submission/local-shell
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createBoundedOutput, createFileCapture, formatBytes, formatTruncation, SHELL_OUTPUT_DISK_CAP_BYTES } from '../../bounded-output.ts'
import type { Diag } from '../../diag.ts'
import { runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { interruptAgent, type InterruptAgentLike } from '../../interrupt.ts'
import type { TuiSettingsDoc } from '../../runtime/config-port.ts'
import type { SessionWriter } from '../../runtime/session-writer-port.ts'
import { localShellSandboxPreferenceOf, shellCommandOf, shellModeOf } from '../../shell-context.ts'
import { sessionUnchanged } from '../../steer.ts'
import { submitShell } from '../submission/runtime.ts'
import type { LiveSessionScope } from '../session/scope.ts'
import type { TuiApp } from '../../tui-app.ts'

/** Throttle for re-chaining a RUNNING local shell card's result to the bounded
 * tail (plan §5.1): the running preview refreshes at most this often, so a
 * high-throughput log cannot rebuild the view per chunk. */
const LOCAL_SHELL_TAIL_FLUSH_MS = 200

/** The result of one dsh shell execution (structural). */
export interface LocalShellRunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: { readonly text: string }
  readonly stderr: { readonly text: string }
}

/** The dsh shell executor capability (structural; the composition root maps
 *  the Host executor). */
export interface LocalShellCapability {
  /** Resolve one request (a synchronous throw is a preparation failure). */
  resolve(request: { readonly command: string; readonly workdir: string; readonly signal: AbortSignal }): unknown
  /** Execute one resolved spec (or reject on an infrastructure failure). */
  execute(spec: unknown): Promise<{ result(): Promise<LocalShellRunResult> }>
}

/** The narrow capabilities the local shell consumes. */
export interface LocalShellDeps<ExactAgent extends InterruptAgentLike> {
  /** The mounted app (shell card + notifications). */
  readonly app: () => TuiApp
  readonly diag: Diag
  readonly isCleanedUp: () => boolean
  /** The exact live Agent of the current owner, or undefined. */
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
  /** The Direct TUI-settings facade (the sandbox preference), read live. */
  readonly tuiSettings: { get(): TuiSettingsDoc } | undefined
  /** The dsh shell executor, resolved live (undefined = spawn fallback). */
  readonly resolveShell: () => LocalShellCapability | undefined
  /** The LATE-BOUND submission seams (the controller is built after this
   *  owner): both are read at call time, so neither can go stale. */
  readonly submission: {
    settleAck(reason: string, options: { token?: number; terminal?: boolean }): void
    markDispatch(sessionId: string | undefined): void
  }
}

/** The local-shell owner as the rest of the application consumes it. */
export interface LocalShellOwner {
  /** Run one `!` / `!!` command. */
  run(text: string, ackToken: number | undefined): void
  /** Abort the running shell and interrupt the live Agent (Esc / cancel). */
  interrupt(): void
  /** Abort the shell and remove every retained full-output temp file. */
  dispose(): void
}

/** Create the local-shell owner (plan §A5b-4). */
export function createLocalShell<ExactAgent extends InterruptAgentLike>(
  deps: LocalShellDeps<ExactAgent>,
): LocalShellOwner {
  // Abort handle for the currently running `!` shell command.
  
  let localShellController: AbortController | undefined

  /** Stop the captured live Agent through the SessionWriter seam. The
   * operation barrier keeps the async outcome inside the same session
   * ownership window as other TUI writes. */
  
  const interruptLiveAgent = (): void => {
    if (deps.isCleanedUp()) return
    localShellController?.abort()
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

  // 0600 temp files holding FULL local-shell output (for truncated runs);
  // removed at TUI exit (default), never on their own.
  
  const shellTempFiles = new Set<string>()

  /**
   * Run a `!` shell command. `!` (context mode) runs the command and then
   * submits the completed command+output to the session as an ordinary
   * user message (kimi parity: the model sees both on the next
   * turn; the result wakes a turn but is never steered into a running
   * one); `!!` (local mode) runs purely off-session — the card is the
   * only record (pi's excluded-from-context escape hatch).
   */
  
  const runLocalShell = (text: string, ackToken: number | undefined): void => {
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
    // switch already cleared the card; the notify explains what happened).
    const generationAtRun = deps.ownership.generation()
    localShellController?.abort()
    localShellController = new AbortController()
    const localSignal = localShellController.signal
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
      if (localShellController?.signal === localSignal) localShellController = undefined
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
        createMessage: (text) => createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
        diag: deps.diag,
      })
    }
    // A settled latch: `error` and `close` can both fire (a spawn failure
    // usually closes with a non-zero code), and the card must settle
    // EXACTLY once — the first event wins.
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
      //
      // EVERY settle caller funnels through HERE — including the
      // synchronous `shell.resolve`/`spawn` catches and the child
      // `error` handler — so no additional ack settle is needed at
      // those sites: a non-abort failure continues into submitResult →
      // submitShellResult, whose onResult/onError/onCancel sinks end
      // the ack (or the authoritative event does), and an abort ends
      // it through the gate below. Adding token settles at the catch
      // sites instead would pre-clear the row and break the "ack
      // survives until the authoritative event" contract.
      if (includeInContext && localSignal.aborted) {
        shellTerminalAck('shell run aborted')
      }
      if (includeInContext && !localSignal.aborted) submitResult(result)
    }
    const sandboxPreference = localShellSandboxPreferenceOf(deps.tuiSettings?.get())
    const shell = sandboxPreference === 'sandbox' ? deps.resolveShell() : undefined
    if (shell === undefined && sandboxPreference === 'sandbox') {
      // The user explicitly opted into the sandbox but the composition
      // provides no shell capability: running unsandboxed SILENTLY would
      // violate the preference, so the downgrade is surfaced every time.
      deps.app().notify('local shell sandbox unavailable in this composition — running unsandboxed', 'error')
    }
    if (shell !== undefined) {
      // The dsh shell capability (sandbox policy + DSH env) when the
      // composition provides it AND the local-shell sandbox preference
      // opts in ('sandbox'); completion-based like the spawn fallback.
      // The default ('bypass') runs user-typed commands through the plain
      // spawn path below — pi/kimi parity: the sandbox guards the model's
      // autonomous commands, not commands the user typed and chose to run.
      // A synchronous resolve throw must not escape with the ack row
      // armed: settle the card (and the terminal ack) exactly like a
      // failed run (plan D exit enumeration).
      let spec: ReturnType<typeof shell.resolve>
      try {
        spec = shell.resolve({ command, workdir: deps.status.sessionCwd(), signal: localSignal })
      } catch (error) {
        releaseController()
        settle(`failed: ${safeErrorMessage(error)}`, 'error')
        return
      }
      // An owned workflow: the RESULT settles the UI card, so the settle
      // logic stays in onResult and the cancellation/failure semantics
      // stay per-task (runOwned — AGENTS.md); the classification
      // diagnostics (cancellation → debug, failure → error) are recorded
      // by runOwned itself. DSH 0.1.7 execute/result contract: execute()
      // publishes the handle after preparation (throwing on preparation
      // failure or caller cancellation before the process exists) and
      // result() is the foreground projection — nonzero exits, timeout
      // kills, and abort kills RESOLVE with a descriptive result, and
      // only infrastructure failures reject. The dsh shell may still
      // reject an abort with a plain Error, so the task-local classifier
      // routes it to onCancel instead of a false ERROR line. Never a
      // bare void.
      runOwned('local shell', async () => {
        const execution = await shell.execute(spec)
        return execution.result()
      }, {
        diag: deps.diag,
        sessionId: () => deps.liveAgent()?.session.id,
        isCancellation: () => localSignal.aborted,
        onResult: (result) => {
          releaseController()
          if (localSignal.aborted) {
            settle('aborted', 'error')
            return
          }
          const output = [result.stdout.text.trim(), result.stderr.text.trim()].filter(Boolean).join('\n')
          const exit = result.exitCode !== null ? `exit ${result.exitCode}` : `signal ${result.signal ?? '?'}`
          settle(output === '' ? exit : `${output}\n[${exit}]`, result.exitCode === 0 ? 'ok' : 'error')
        },
        onCancel: (error) => {
          // An abort-triggered rejection is a cancellation: settle the
          // card as aborted like the resolved path does. runOwned routes
          // cancellations EXCLUSIVELY here — a cancellation-shaped
          // rejection WITHOUT the signal aborted skips the aborted gate
          // inside settle(), so the ack row must be settled terminally
          // HERE too (idempotent with it).
          releaseController()
          settle('aborted', 'error')
          if (includeInContext && !localSignal.aborted) {
            shellTerminalAck('shell run cancelled')
          }
          void error
        },
        onError: (error) => {
          releaseController()
          const message = safeErrorMessage(error)
          settle(`failed: ${message}`, 'error')
          // A sandbox execution failure does NOT run submitResult (only
          // onResult does), so this exit is terminal for the ack row:
          // nothing will be written — the pending row must end here
          // (plan D exit enumeration). An abort settles through the
          // unified aborted gate above instead.
          if (includeInContext && !localSignal.aborted) {
            shellTerminalAck('shell sandbox run failed')
          }
        },
      })
      return
    }
    // A synchronous spawn throw must not escape with the ack row armed:
    // settle the card (and the terminal ack) exactly like a failed run
    // (plan D exit enumeration).
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, { cwd: deps.status.sessionCwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    } catch (error) {
      releaseController()
      settle(`failed: ${safeErrorMessage(error)}`, 'error')
      return
    }
    // Bounded capture: the card keeps only the TAIL (byte- and line-
    // capped, unterminated output included); the FULL output is streamed
    // to a 0600 temp file (disk-capped) so a truncated run still leaves
    // the complete transcript available. Untruncated runs delete the file
    // on close; the files that remain are removed at TUI exit (cleanup).
    const bounded = createBoundedOutput()
    const fullPath = join(tmpdir(), `dsh-pi-tui-shell-${process.pid}-${randomUUID()}.log`)
    const full = createFileCapture(fullPath, SHELL_OUTPUT_DISK_CAP_BYTES)
    if (full.active) shellTempFiles.add(fullPath)
    // ONE StringDecoder PER stream: stdout and stderr are independent
    // byte streams, so a character split across them would interleave
    // and corrupt — each stream's decoder buffers only its own partial
    // sequences and decodes across that stream's chunk boundaries.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    // In-flight tail refresh (plan §5.1): the running card's result is
    // re-chained to the bounded TAIL on a throttle, so a streaming log
    // previews its newest rows instead of an empty body. The throttle
    // keeps high-throughput output from rebuilding the whole view per
    // chunk; settle/close clears the timer (dispose contract).
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
      }, LOCAL_SHELL_TAIL_FLUSH_MS)
    }
    const onData = (decoder: StringDecoder, chunk: Buffer): void => {
      if (deps.isCleanedUp()) return
      // The wire byte count rides along: an incomplete multi-byte
      // sequence buffered by the decoder produces no text yet, but its
      // bytes are real and must count toward the totals.
      bounded.append(decoder.write(chunk), chunk.length)
      full.append(chunk)
      scheduleTailFlush()
    }
    child.stdout?.on('data', (chunk) => onData(stdoutDecoder, chunk))
    child.stderr?.on('data', (chunk) => onData(stderrDecoder, chunk))
    localSignal.addEventListener('abort', () => child.kill(), { once: true })
    child.on('error', (error) => {
      releaseController()
      clearTailTimer()
      // A spawn failure leaves nothing worth keeping: drop the capture.
      full.dispose()
      shellTempFiles.delete(fullPath)
      if (deps.isCleanedUp()) return
      settle(`failed: ${error.message}`, 'error')
    })
    child.on('close', (code, childSignal) => {
      releaseController()
      clearTailTimer()
      if (deps.isCleanedUp()) {
        full.dispose()
        shellTempFiles.delete(fullPath)
        return
      }
      // Flush each decoder's remaining partial sequence. An incomplete
      // trailing multi-byte character surfaces as U+FFFD from end() — it
      // is shown as-is (the bytes were real); its wire bytes were already
      // counted by append's wireBytes, so pass 0 to avoid double counting.
      for (const decoder of [stdoutDecoder, stderrDecoder]) {
        const tail = decoder.end()
        if (tail !== '') bounded.append(tail, 0)
      }
      if (localSignal.aborted) {
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
        const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
        lines.push(`[${exit}]`)
        settle(lines.join('\n'), code === 0 ? 'ok' : 'error')
      } else {
        // Untruncated output: no reason to keep a user-invisible temp
        // file around until TUI exit.
        full.dispose()
        shellTempFiles.delete(fullPath)
        const output = bounded.tail.trim()
        const exit = code !== null ? `exit ${code}` : `signal ${childSignal ?? '?'}`
        settle(output === '' ? exit : `${output}\n[${exit}]`, code === 0 ? 'ok' : 'error')
      }
    })
  }


  const dispose = (): void => {
    localShellController?.abort()
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
    run: runLocalShell,
    interrupt: interruptLiveAgent,
    dispose,
  }
}
