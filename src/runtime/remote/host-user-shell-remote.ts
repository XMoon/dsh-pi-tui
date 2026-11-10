import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { cancellationError } from '../process/tasks.ts'
import {
  HostUserShellOutcomeUnknownError,
  HostUserShellSandboxRunnerError,
  type HostUserShellAdmission,
  type HostUserShellExecution,
  type HostUserShellOutputChunk,
  type HostUserShellPort,
  type HostUserShellRequest,
  type HostUserShellResult,
} from '../host-user-shell-port.ts'
import {
  HostUserShellFrameSequence,
  type HostUserShellFrame,
  type PiTuiHostUserShellNamespace,
} from './pi-tui-host-user-shell-contract.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'

const REMOTE_OUTSTANDING_FRAME_LIMIT = 8

interface OutputQueueEntry {
  readonly frame: Extract<HostUserShellFrame, { readonly kind: 'output' }>
}

class RemoteOutputQueue {
  private readonly entries: OutputQueueEntry[] = []
  private readonly waiters = new Set<() => void>()
  private ended = false
  private failure: unknown
  private failed = false

  get size(): number { return this.entries.length }

  push(frame: OutputQueueEntry['frame']): void {
    if (this.ended) throw new Error('Remote Host shell output arrived after the queue ended')
    if (this.entries.length >= REMOTE_OUTSTANDING_FRAME_LIMIT) {
      throw new Error('Remote Host shell adapter output queue exceeded the ACK window')
    }
    this.entries.push({ frame })
    this.wake()
  }

  close(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    if (error !== undefined) {
      this.failed = true
      this.failure = error
    }
    this.wake()
  }

  async next(signal: AbortSignal): Promise<OutputQueueEntry['frame'] | undefined> {
    for (;;) {
      signal.throwIfAborted()
      const entry = this.entries.shift()
      if (entry !== undefined) return entry.frame
      if (this.failed) throw this.failure
      if (this.ended) return undefined
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener('abort', abort)
          this.waiters.delete(wake)
          resolve()
        }
        const abort = (): void => {
          signal.removeEventListener('abort', abort)
          this.waiters.delete(wake)
          reject(signal.reason)
        }
        this.waiters.add(wake)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  }

  private wake(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake()
  }
}

class RemoteOutputDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pendingBytes = 0
  private readonly stream: 'stdout' | 'stderr'

  constructor(stream: 'stdout' | 'stderr') {
    this.stream = stream
  }

  write(bytes: Buffer): HostUserShellOutputChunk {
    this.pendingBytes += bytes.length
    const text = this.decoder.write(bytes)
    const consumed = this.pendingBytes
    this.pendingBytes = 0
    return { text, bytes: consumed, stream: this.stream }
  }

  end(): HostUserShellOutputChunk | undefined {
    const text = this.decoder.end()
    if (text === '' && this.pendingBytes === 0) return undefined
    const output = { text, bytes: 0, stream: this.stream }
    this.pendingBytes = 0
    return output
  }
}

/** Remote execution is one authenticated bidirectional Host stream, one output consumer, and no replay. */
export class RemoteHostUserShellPort implements HostUserShellPort {
  readonly availability = { supported: true, policies: ['bypass', 'sandbox'] as const }
  private readonly namespace: PiTuiHostUserShellNamespace
  private readonly generation: RemoteConnectionGenerationSource

  constructor(namespace: PiTuiHostUserShellNamespace, generation: RemoteConnectionGenerationSource) {
    this.namespace = namespace
    this.generation = generation
  }

  async execute(request: HostUserShellRequest): Promise<HostUserShellAdmission> {
    if (request.sessionId === '') throw new TypeError('HostUserShellPort requires a non-empty Session id')
    request.signal.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) {
      return {
        kind: 'unavailable',
        reason: { reason: 'carrier-gap', message: 'Host user-shell execution is unavailable while disconnected — nothing was executed' },
      }
    }

    const requestId = randomUUID()
    const runArguments = {
      sessionId: request.sessionId,
      requestId,
      expectedCwd: request.cwd,
      command: request.command,
      policy: request.policy,
    }
    const handle = this.namespace.run(
      runArguments.sessionId,
      runArguments.requestId,
      runArguments.expectedCwd,
      runArguments.command,
      runArguments.policy,
      request.signal,
    )
    const iterator = handle[Symbol.asyncIterator]()
    const sequence = new HostUserShellFrameSequence(runArguments)
    let first: IteratorResult<HostUserShellFrame>
    try {
      first = await iterator.next()
    } catch (error) {
      handle.dispose()
      if (request.signal.aborted) throw cancellationError('Host shell admission cancelled')
      return {
        kind: 'indeterminate',
        message: 'Host shell admission is indeterminate; the command may have executed — do not retry automatically',
      }
    }
    if (first.done === true) {
      handle.dispose()
      return {
        kind: 'indeterminate',
        message: 'Host shell admission is indeterminate; the command may have executed — do not retry automatically',
      }
    }

    let firstFrame: HostUserShellFrame
    try {
      firstFrame = sequence.accept(first.value)
    } catch {
      handle.dispose()
      return {
        kind: 'indeterminate',
        message: 'Host shell response was invalid; the command may have executed — do not retry automatically',
      }
    }
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
      handle.dispose()
      return {
        kind: 'indeterminate',
        message: 'Host shell connection changed before admission settled; the command may have executed — do not retry automatically',
      }
    }
    if (firstFrame.kind === 'refused') {
      try {
        const terminal = await iterator.next()
        if (terminal.done !== true) throw new TypeError('Host shell refusal stream continued after its terminal frame')
        sequence.finish()
        return {
          kind: 'unavailable',
          reason: { reason: firstFrame.reason === 'policy-unavailable' ? 'policy-unavailable' : 'carrier-gap', message: firstFrame.message },
        }
      } catch (error) {
        handle.dispose()
        if (request.signal.aborted) throw cancellationError('Host shell refusal cancelled')
        return {
          kind: 'indeterminate',
          message: 'Host shell refusal could not be verified; do not retry automatically',
        }
      }
    }
    if (firstFrame.kind !== 'started') {
      handle.dispose()
      return {
        kind: 'indeterminate',
        message: 'Host shell admission is indeterminate; the command may have executed — do not retry automatically',
      }
    }

    const queue = new RemoteOutputQueue()
    let outputTaken = false
    const state = { settled: false }
    const isCurrent = (): boolean => Object.is(capturedGeneration, this.generation.getSnapshot())
    const pumpPromise = this.pump(handle, iterator, sequence, queue, request, requestId, isCurrent, state)

    const execution: HostUserShellExecution = {
      result: () => pumpPromise,
      output: () => {
        if (outputTaken) throw new Error('HostUserShellPort output() is single-consumer')
        outputTaken = true
        const drain = async function* (): AsyncIterable<HostUserShellOutputChunk> {
          let previousSeq: number | undefined
          const stdout = new RemoteOutputDecoder('stdout')
          const stderr = new RemoteOutputDecoder('stderr')
          try {
            for (;;) {
              if (previousSeq !== undefined) {
                handle.send({ kind: 'ack', requestId, seq: previousSeq })
                previousSeq = undefined
              }
              const frame = await queue.next(request.signal)
              if (frame === undefined) break
              previousSeq = frame.seq
              const bytes = Buffer.from(frame.base64, 'base64')
              yield frame.stream === 'stdout' ? stdout.write(bytes) : stderr.write(bytes)
            }
            const stdoutTail = stdout.end()
            if (stdoutTail !== undefined) yield stdoutTail
            const stderrTail = stderr.end()
            if (stderrTail !== undefined) yield stderrTail
          } finally {
            if (!state.settled) handle.dispose()
          }
        }
        return drain()
      },
    }
    return { kind: 'executing', execution }
  }

  private async pump(
    handle: ReturnType<PiTuiHostUserShellNamespace['run']>,
    iterator: AsyncIterator<HostUserShellFrame>,
    sequence: HostUserShellFrameSequence,
    queue: RemoteOutputQueue,
    request: HostUserShellRequest,
    requestId: string,
    isCurrent: () => boolean,
    state: { settled: boolean },
  ): Promise<HostUserShellResult> {
    try {
      let terminal: HostUserShellFrame | undefined
      for (;;) {
        if (!isCurrent()) throw new HostUserShellOutcomeUnknownError('Host shell stream belongs to a stale Connection generation')
        const next = await iterator.next()
        if (!isCurrent()) throw new HostUserShellOutcomeUnknownError('Host shell stream belongs to a stale Connection generation')
        if (next.done === true) {
          sequence.finish()
          break
        }
        const frame = sequence.accept(next.value)
        if (frame.kind === 'output') {
          queue.push(frame)
          continue
        }
        if (frame.kind === 'settled' || frame.kind === 'failed') {
          if (queue.size !== 0) throw new TypeError('Host shell terminal frame overtook unconsumed output')
          terminal = frame
          continue
        }
        throw new TypeError(`Host shell unexpected ${frame.kind} frame after started`)
      }
      if (!isCurrent()) throw new HostUserShellOutcomeUnknownError('Host shell result belongs to a stale Connection generation')
      if (terminal === undefined) throw new TypeError('Host shell stream ended without a terminal frame')
      state.settled = true
      queue.close()
      if (terminal.kind === 'settled') return { exit: terminal.exit, aborted: terminal.aborted, sandboxDenied: terminal.sandboxDenied }
      if (terminal.kind !== 'failed') throw new TypeError('Host shell stream terminal frame is invalid')
      if (terminal.phase === 'sandbox-runner') {
        throw new HostUserShellSandboxRunnerError(`Host sandbox runner failed before the user command executed: ${terminal.message}`)
      }
      throw new HostUserShellOutcomeUnknownError(`Host shell infrastructure failed after start: ${terminal.message}`)
    } catch (error) {
      handle.dispose()
      if (request.signal.aborted) {
        const cancellation = cancellationError('Host shell execution cancelled')
        queue.close(cancellation)
        throw cancellation
      }
      const failure = error instanceof HostUserShellOutcomeUnknownError || error instanceof HostUserShellSandboxRunnerError
        ? error
        : new HostUserShellOutcomeUnknownError(`Host shell stream ended without a verified outcome: ${error instanceof Error ? error.message : 'wire failure'}`)
      queue.close(failure)
      throw failure
    } finally {
      if (!state.settled) handle.dispose()
    }
  }
}
