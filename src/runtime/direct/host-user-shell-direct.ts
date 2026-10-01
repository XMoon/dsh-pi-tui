/**
 * The Direct Host user-shell adapter (shell amendment, M3-4 PR3): the
 * in-process deployment of the SAME Host-owned execution authority. Direct
 * Client and Host share one process today, so the adapter may internally use
 * Node spawn (bypass policy) and the dsh shell executor (`ctx.shell`, sandbox
 * policy) — the contract is that spawn lives behind DIRECT/Host adapter
 * ownership, never in the application/TUI layer. cwd/PATH/env are Host
 * process facts.
 *
 * A sandbox request this composition cannot serve fails closed with a visible
 * `policy-unavailable` admission — it NEVER downgrades to unsandboxed
 * execution (the historical warn-and-fallback behavior is retired).
 *
 * Full contract: docs/client-server-migration.md (user shell section).
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-user-shell-direct
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { safeErrorMessage } from '../../error-boundary.ts'
import type {
  HostUserShellAdmission,
  HostUserShellExecution,
  HostUserShellOutputChunk,
  HostUserShellPort,
  HostUserShellRequest,
  HostUserShellResult,
} from '../host-user-shell-port.ts'

/** The dsh shell executor capability (structural; the composition root maps
 *  the Host executor). Mirrors the seam the previous application owner used. */
export interface DirectShellCapability {
  /** Resolve one request (a synchronous throw is a preparation failure). */
  resolve(request: { readonly command: string; readonly workdir: string; readonly signal: AbortSignal }): unknown
  /** Execute one resolved spec (or reject on an infrastructure failure). */
  execute(spec: unknown): Promise<{ result(): Promise<DirectShellRunResult> }>
}

/** The result of one dsh shell execution (structural). */
export interface DirectShellRunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: { readonly text: string }
  readonly stderr: { readonly text: string }
}

/** The minimal Host context surface the adapter needs (structural). */
export interface DirectShellContextLike {
  get(name: string): unknown
}

/**
 * The Direct backend's Host user-shell port. Bypass runs a plain
 * `spawn(command, { shell: true, cwd })` in the Host process; sandbox runs
 * the dsh shell executor's policy when the composition provides it.
 */
export class DirectHostUserShellPort implements HostUserShellPort {
  private readonly ctx: DirectShellContextLike | undefined
  private readonly shell: () => DirectShellCapability | undefined

  constructor(
    ctx?: DirectShellContextLike,
    shell?: () => DirectShellCapability | undefined,
  ) {
    this.ctx = ctx
    this.shell = shell ?? (() => undefined)
  }

  get availability(): { readonly supported: true; readonly policies: readonly ('bypass' | 'sandbox')[] } {
    // The sandbox policy is served only when the composition provides the dsh
    // shell executor; bypass always is (the Host process itself).
    return this.sandboxServed
      ? { supported: true, policies: ['bypass', 'sandbox'] }
      : { supported: true, policies: ['bypass'] }
  }

  private get sandboxServed(): boolean {
    return this.ctx !== undefined && this.shell() !== undefined
  }

  async execute(request: HostUserShellRequest): Promise<HostUserShellAdmission> {
    if (request.policy === 'sandbox') {
      const shell = this.sandboxServed ? this.shell() : undefined
      if (shell === undefined) {
        // Fail closed: a sandbox request this composition cannot serve must
        // never run unsandboxed (shell amendment; the Direct branch is no
        // exception).
        return {
          kind: 'unavailable',
          reason: {
            reason: 'policy-unavailable',
            message: 'user shell sandbox policy is unavailable in this composition — nothing was executed',
          },
        }
      }
      return { kind: 'executing', execution: executeViaShellCapability(shell, request) }
    }
    return { kind: 'executing', execution: executeViaSpawn(request) }
  }
}

/**
 * The single-consumer output queue with UPSTREAM BACKPRESSURE: the buffer
 * holds at most OUTPUT_BUFFER_CHUNKS chunks; when it is full the producer
 * (the child's stream readers) is PAUSED via the supplied pause/resume
 * hooks, and it resumes once the consumer drains below the watermark —
 * bounded adapter memory with ZERO silent loss (the Host process itself
 * blocks in its full pipe, which is the OS's own backpressure). Exactly one
 * stream() consumer is supported (the port contract); a second call throws.
 */
const OUTPUT_BUFFER_CHUNKS = 256

/** Exported for the backpressure contract tests (pause/resume proof). */
export class OutputBus {
  private readonly buffer: HostUserShellOutputChunk[] = []
  private waiters: Array<() => void> = []
  private ended = false
  private consumerTaken = false

  private readonly pauseProducer: () => void
  private readonly resumeProducer: () => void

  constructor(pauseProducer: () => void, resumeProducer: () => void) {
    this.pauseProducer = pauseProducer
    this.resumeProducer = resumeProducer
  }

  push(chunk: HostUserShellOutputChunk): void {
    if (this.ended) return
    this.buffer.push(chunk)
    if (this.buffer.length >= OUTPUT_BUFFER_CHUNKS) this.pauseProducer()
    this.wake()
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.resumeProducer()
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  /** The one consumer's iteration: FIFO chunks, zero loss, ends at settle. */
  async *stream(): AsyncIterable<HostUserShellOutputChunk> {
    if (this.consumerTaken) throw new Error('HostUserShellPort output() is single-consumer')
    this.consumerTaken = true
    while (true) {
      if (this.buffer.length > 0) {
        const chunk = this.buffer.shift()!
        if (this.buffer.length < OUTPUT_BUFFER_CHUNKS / 2) this.resumeProducer()
        yield chunk
        continue
      }
      if (this.ended) return
      await new Promise<void>(resolve => { this.waiters.push(resolve) })
    }
  }
}

function chunkOf(text: string, bytes: number, stream: 'stdout' | 'stderr'): HostUserShellOutputChunk {
  return { text, bytes, stream }
}

/** Decode one stream's bytes through its OWN StringDecoder (a multi-byte
 *  sequence split across streams must never interleave). */
class StreamDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pendingBytes = 0

  /** Returns the decoded text plus the wire byte count consumed. */
  write(buffer: Buffer): HostUserShellOutputChunk {
    this.pendingBytes += buffer.length
    const text = this.decoder.write(buffer)
    const bytes = this.pendingBytes
    this.pendingBytes = 0
    return chunkOf(text, bytes, this.stream)
  }

  end(): HostUserShellOutputChunk | undefined {
    const tail = this.decoder.end()
    if (tail === '' && this.pendingBytes === 0) return undefined
    const chunk = chunkOf(tail, this.pendingBytes, this.stream)
    this.pendingBytes = 0
    return chunk
  }

  private readonly stream: 'stdout' | 'stderr'

  constructor(stream: 'stdout' | 'stderr') {
    this.stream = stream
  }
}

/** The bypass policy: plain Host-process spawn with shell interpolation. */
function executeViaSpawn(request: HostUserShellRequest): HostUserShellExecution {
  // The pause/resume pair wired to the child's readable streams once they
  // exist (before that, pausing is a no-op): the OS pipe blocks the child
  // while both streams are paused, which is the upstream backpressure.
  let childRef: ReturnType<typeof spawn> | undefined
  const pause = (): void => {
    childRef?.stdout?.pause()
    childRef?.stderr?.pause()
  }
  const resume = (): void => {
    childRef?.stdout?.resume()
    childRef?.stderr?.resume()
  }
  const bus = new OutputBus(pause, resume)
  const resultPromise = new Promise<HostUserShellResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(request.command, {
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        // POSIX process GROUP: the shell wrapper and every pipeline child
        // share one killable group — `kill(-pid)` reaches the WHOLE command
        // tree, so an Esc cannot leave a `sleep`/pipeline child running to
        // natural exit while holding the stdio (§16/§23 Host process
        // cancellation owns the full run).
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      // Nothing executed: an infrastructure failure rejects (the caller knows
      // no Host process ran).
      bus.end()
      reject(error instanceof Error ? error : new Error(safeErrorMessage(error)))
      return
    }
    childRef = child
    const stdout = new StreamDecoder('stdout')
    const stderr = new StreamDecoder('stderr')
    // Kill the PROCESS GROUP on POSIX (the wrapper's children included); a
    // bare child.kill() would only reach the shell wrapper and let pipeline
    // children keep running (and hold the streams) after the cancel.
    //
    // PLATFORM SCOPE: whole-tree cancellation is POSIX-only. On win32 this
    // build does NOT claim tree cancellation — child.kill() reaches only the
    // shell wrapper (grandchildren survive until their own exit), which is an
    // EXPLICIT unsupported-cancellation limitation: the TUI has no Windows
    // support contract at all (CI/test matrices are Linux-only), and closing
    // the gap would need a Job Object / taskkill /T owner of its own.
    const killTree = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      // Drop the host-side pipe readers FIRST: a full pipe keeps the killed
      // writer blocked (it can never drain once the consumer is gone), and a
      // paused Node stream never emits 'end' — `close` (and therefore the
      // result join) would deadlock. Destroying the readers releases both.
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (child.pid === undefined) { child.kill(signal); return }
      if (process.platform === 'win32') {
        child.kill(signal)
        return
      }
      try {
        process.kill(-child.pid, signal)
      } catch {
        // The group leader may already be gone; fall back to the direct child.
        child.kill(signal)
      }
    }
    const onAbort = (): void => { killTree() }
    request.signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (buffer: Buffer) => bus.push(stdout.write(buffer)))
    child.stderr?.on('data', (buffer: Buffer) => bus.push(stderr.write(buffer)))
    child.on('error', (error) => {
      request.signal.removeEventListener('abort', onAbort)
      bus.end()
      reject(error instanceof Error ? error : new Error(safeErrorMessage(error)))
    })
    child.on('close', (code, childSignal) => {
      request.signal.removeEventListener('abort', onAbort)
      childRef = undefined
      const stdoutTail = stdout.end()
      if (stdoutTail !== undefined) bus.push(stdoutTail)
      const stderrTail = stderr.end()
      if (stderrTail !== undefined) bus.push(stderrTail)
      bus.end()
      // Release the dead pipes' references so a run without a consumer (or
      // with one that stopped early) cannot hold the host event loop through
      // paused streams that will never be read again.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        exit: code !== null ? { kind: 'exit', code } : { kind: 'signal', signal: childSignal ?? 'unknown' },
        aborted: request.signal.aborted,
      })
    })
  })
  return {
    result: () => resultPromise,
    output: () => bus.stream(),
  }
}

/** The sandbox policy: the dsh shell executor's Host sandbox. Output arrives
 *  as one settled stdout/stderr pair (no live stream; the executor's contract
 *  resolves only at settle). */
function executeViaShellCapability(shell: DirectShellCapability, request: HostUserShellRequest): HostUserShellExecution {
  // The executor's output arrives settled (no live stream to pause).
  const bus = new OutputBus(() => {}, () => {})
  const resultPromise = (async (): Promise<HostUserShellResult> => {
    // A synchronous resolve throw is a preparation failure: nothing executed.
    const spec = shell.resolve({ command: request.command, workdir: request.cwd, signal: request.signal })
    const result = await shell.execute(spec).then(execution => execution.result())
    const stdoutText = result.stdout.text
    const stderrText = result.stderr.text
    if (stdoutText !== '') bus.push(chunkOf(stdoutText, Buffer.byteLength(stdoutText), 'stdout'))
    if (stderrText !== '') bus.push(chunkOf(stderrText, Buffer.byteLength(stderrText), 'stderr'))
    bus.end()
    return {
      exit: result.exitCode !== null
        ? { kind: 'exit', code: result.exitCode }
        : { kind: 'signal', signal: result.signal ?? 'unknown' },
      aborted: request.signal.aborted,
    }
  })()
  // A rejected preparation/execution must still end the bus so a streaming
  // subscriber cannot hang; the rejection itself surfaces through result().
  // The side-channel settlement rides the SAME promise chain the caller
  // observes (no discarded branch): when the caller awaits result(), the
  // bus has ended either way; when the caller never awaits, the chained
  // handler still ran because the chain is attached here.
  resultPromise.catch(() => bus.end()).catch(() => {
    // bus.end() cannot reject; this arm exists only to satisfy the chain.
  })
  return {
    result: () => resultPromise,
    output: () => bus.stream(),
  }
}
