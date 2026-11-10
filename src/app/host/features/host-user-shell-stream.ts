import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { Readable } from 'node:stream'
import { MAX_HOST_USER_SHELL_FRAME_BYTES, parseHostUserShellAck, type HostUserShellAck } from '../../../runtime/remote/pi-tui-host-user-shell-contract.ts'

export const HOST_USER_SHELL_ACK_WINDOW = 8

interface OutputReader {
  readonly stream: 'stdout' | 'stderr'
  readonly iterator: AsyncIterator<Uint8Array>
  ended: boolean
  pending: Promise<{ readonly index: number; readonly result: IteratorResult<Uint8Array> }> | undefined
  chunk: Buffer | undefined
  offset: number
}

/** One bounded, single-read-per-stream mux over the two Host pipes. */
export class HostUserShellOutputMux {
  private readonly readers: OutputReader[]
  private readonly ready: number[] = []

  constructor(stdout: Readable, stderr: Readable) {
    this.readers = [
      { stream: 'stdout', iterator: stdout[Symbol.asyncIterator](), ended: false, pending: undefined, chunk: undefined, offset: 0 },
      { stream: 'stderr', iterator: stderr[Symbol.asyncIterator](), ended: false, pending: undefined, chunk: undefined, offset: 0 },
    ]
  }

  async next(signal: AbortSignal): Promise<{ readonly stream: 'stdout' | 'stderr'; readonly bytes: Buffer } | undefined> {
    for (;;) {
      signal.throwIfAborted()
      const readyIndex = this.ready.shift()
      if (readyIndex !== undefined) {
        const reader = this.readers[readyIndex]!
        const chunk = reader.chunk!
        const end = Math.min(chunk.length, reader.offset + MAX_HOST_USER_SHELL_FRAME_BYTES)
        const bytes = Buffer.from(chunk.subarray(reader.offset, end))
        reader.offset = end
        if (end < chunk.length) this.ready.unshift(readyIndex)
        else {
          reader.chunk = undefined
          reader.offset = 0
        }
        return { stream: reader.stream, bytes }
      }

      for (let index = 0; index < this.readers.length; index += 1) {
        const reader = this.readers[index]!
        if (!reader.ended && reader.pending === undefined) {
          reader.pending = reader.iterator.next().then(result => ({ index, result }))
        }
      }
      const pending = this.readers.flatMap(reader => reader.pending === undefined ? [] : [reader.pending])
      if (pending.length === 0) return undefined
      const { index, result } = await Promise.race(pending)
      const reader = this.readers[index]!
      reader.pending = undefined
      if (result.done === true) {
        reader.ended = true
        continue
      }
      const bytes = Buffer.from(result.value)
      if (bytes.length === 0) continue
      reader.chunk = bytes
      reader.offset = 0
      this.ready.push(index)
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled(this.readers.map(reader => reader.iterator.return?.()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Host shell output mux close failed')
  }
}

/** One run's cumulative, eight-frame consumption window. */
export class HostUserShellAckWindow {
  private readonly requestId: string
  private sent = -1
  private acked = -1
  private failure: unknown
  private failed = false
  private closed = false
  private readonly waiters = new Set<() => void>()

  constructor(requestId: string) {
    this.requestId = requestId
  }

  get lastSentSeq(): number { return this.sent }
  get lastAckedSeq(): number { return this.acked }
  get outstanding(): number { return this.sent - this.acked }

  async waitForCapacity(signal: AbortSignal): Promise<void> {
    while (this.outstanding >= HOST_USER_SHELL_ACK_WINDOW) await this.waitForChange(signal)
    this.assertOpen()
  }

  markSent(): number {
    this.assertOpen()
    if (this.outstanding >= HOST_USER_SHELL_ACK_WINDOW) {
      throw new Error('Host shell ACK window capacity was not reserved')
    }
    this.sent += 1
    return this.sent
  }

  accept(value: unknown): HostUserShellAck {
    this.assertOpen()
    const ack = parseHostUserShellAck(value)
    if (ack.requestId !== this.requestId) throw new TypeError('Host shell ACK requestId does not match this run')
    if (ack.seq <= this.acked || ack.seq > this.sent) {
      throw new TypeError('Host shell ACK sequence is repeated, decreasing, or beyond the last sent frame')
    }
    this.acked = ack.seq
    this.wake()
    return ack
  }

  async waitForDrain(signal: AbortSignal): Promise<void> {
    while (this.acked !== this.sent) await this.waitForChange(signal)
    this.assertOpen()
  }

  fail(error: unknown): void {
    if (this.closed || this.failed) return
    this.failed = true
    this.failure = error
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private assertOpen(): void {
    if (this.failed) throw this.failure
    if (this.closed) throw new Error('Host shell ACK window is closed')
  }

  private wake(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiters) wake()
  }

  private async waitForChange(signal: AbortSignal): Promise<void> {
    this.assertOpen()
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(finish)
        resolve()
      }
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        this.waiters.delete(finish)
        reject(signal.reason)
      }
      this.waiters.add(finish)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    this.assertOpen()
    signal.throwIfAborted()
  }
}

/** Continuously drain this invocation's ACK uplink under the run owner. */
export function startHostUserShellAckPump(
  invocation: RemoteInvocation,
  window: HostUserShellAckWindow,
  onFailure?: (error: unknown) => void,
): { readonly done: Promise<void>; stop(): Promise<void> } {
  const iterator = invocation.uplink<unknown>()[Symbol.asyncIterator]()
  let stopped = false
  let resolveStop!: () => void
  const stopSignal = new Promise<void>(resolve => { resolveStop = resolve })
  const fail = (error: unknown): void => {
    window.fail(error)
    onFailure?.(error)
  }
  const done = (async (): Promise<void> => {
    try {
      while (!stopped) {
        const next = await Promise.race([
          iterator.next().then(result => ({ kind: 'item' as const, result })),
          stopSignal.then(() => ({ kind: 'stop' as const })),
        ])
        if (next.kind === 'stop') return
        if (next.result.done === true) {
          if (!stopped && !invocation.signal.aborted) fail(new Error('Host shell ACK uplink ended before the run'))
          return
        }
        window.accept(next.result.value)
      }
    } catch (error) {
      if (!stopped && !invocation.signal.aborted) fail(error)
    }
  })()
  return {
    done,
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true
        resolveStop()
      }
      const result = await iterator.return?.()
      await done
      if (result !== undefined && result.done !== true) {
        throw new Error('Host shell ACK uplink did not close')
      }
    },
  }
}
