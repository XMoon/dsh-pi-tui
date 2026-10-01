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

/** One live output fan-out: bounded pushback is impossible (the adapter keeps
 *  every chunk in memory until settle; the bounded TAIL is the caller's
 *  presentation policy, built on top of this stream). */
class OutputBus {
  private readonly chunks: HostUserShellOutputChunk[] = []
  private waiters: Array<() => void> = []
  private ended = false

  push(chunk: HostUserShellOutputChunk): void {
    if (this.ended) return
    this.chunks.push(chunk)
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  end(): void {
    this.ended = true
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
  }

  get settled(): boolean {
    return this.ended
  }

  get all(): readonly HostUserShellOutputChunk[] {
    return this.chunks
  }

  /** Async iteration over the chunks in arrival order; ends at settle. */
  async *stream(): AsyncIterable<HostUserShellOutputChunk> {
    let index = 0
    for (;;) {
      while (index < this.chunks.length) {
        yield this.chunks[index]!
        index += 1
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

  constructor(private readonly stream: 'stdout' | 'stderr') {}
}

/** The bypass policy: plain Host-process spawn with shell interpolation. */
function executeViaSpawn(request: HostUserShellRequest): HostUserShellExecution {
  const bus = new OutputBus()
  const resultPromise = new Promise<HostUserShellResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(request.command, {
        cwd: request.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      })
    } catch (error) {
      // Nothing executed: an infrastructure failure rejects (the caller knows
      // no Host process ran).
      bus.end()
      reject(error instanceof Error ? error : new Error(safeErrorMessage(error)))
      return
    }
    const stdout = new StreamDecoder('stdout')
    const stderr = new StreamDecoder('stderr')
    const onAbort = (): void => { child.kill() }
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
      const stdoutTail = stdout.end()
      if (stdoutTail !== undefined) bus.push(stdoutTail)
      const stderrTail = stderr.end()
      if (stderrTail !== undefined) bus.push(stderrTail)
      bus.end()
      resolve({
        exit: code !== null ? { kind: 'exit', code } : { kind: 'signal', signal: childSignal ?? 'unknown' },
        output: bus.all.filter(chunk => chunk.text !== ''),
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
  const bus = new OutputBus()
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
      output: bus.all,
      aborted: request.signal.aborted,
    }
  })()
  // A rejected preparation/execution must still end the bus so a streaming
  // subscriber cannot hang; the rejection itself surfaces through result().
  void resultPromise.catch(() => bus.end())
  return {
    result: () => resultPromise,
    output: () => bus.stream(),
  }
}
