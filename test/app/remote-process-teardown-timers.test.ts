/**
 * B3: the transport/Fiber teardown races keep their ORIGINAL hang deadlines,
 * but a normally settled disposal must not leave the losing timer referenced.
 *
 * Evidence level: L2 component contract. The timers are observed through a
 * local adapter that records creation/cancellation for the exact operation
 * under test (never `process._getActiveHandles()` as the sole proof). The real
 * Client OS exit is qualified by the packed split-process lane.
 * @module @xmoon76/dsh-pi-tui/remote-process-teardown-timers.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import WebSocket from 'ws'
import {
  closeRemainingSockets,
  disposeFiberWithinDeadline,
} from '../../src/app/remote-process/local-transport.ts'

/** The recorded diag lines (the timer outcome must be observable). */
function recordingDiag(): { debug: (message: string, fields?: Record<string, unknown>) => void; records: Array<{ message: string; fields?: Record<string, unknown> }> } {
  const records: Array<{ message: string; fields?: Record<string, unknown> }> = []
  return { debug: (message, fields) => { records.push({ message, fields }) }, records }
}

/**
 * Track timers created/cancelled during ONE operation. This is a local adapter
 * around the real global functions: every timer the operation installs appears
 * in `live`, and a cleared timer disappears immediately.
 */
function trackTimers(): { live(): number; restore(): void } {
  const live = new Set<ReturnType<typeof setTimeout>>()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = ((handler: (...args: never[]) => void, timeout?: number, ...args: never[]) => {
    const handle = realSetTimeout(handler as never, timeout, ...args)
    live.add(handle)
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout> | number | string) => {
    if (handle !== undefined) live.delete(handle as ReturnType<typeof setTimeout>)
    return realClearTimeout(handle as ReturnType<typeof setTimeout>)
  }) as unknown as typeof clearTimeout
  return {
    live: () => live.size,
    restore: () => {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
  }
}

/** One structural socket whose close is either asynchronous or never. */
function fakeSocket(close: 'async' | 'never'): WebSocket {
  const listeners: Array<() => void> = []
  const socket = {
    readyState: WebSocket.OPEN as number,
    terminate(): void {
      if (close === 'never') return
      setImmediate(() => {
        socket.readyState = WebSocket.CLOSED
        for (const listener of listeners) listener()
      })
    },
    once(event: string, listener: () => void): void {
      if (event === 'close') listeners.push(listener)
    },
  }
  return socket as unknown as WebSocket
}

test('B3-U1: a socket that closes early leaves NO referenced 2s deadline', async () => {
  const timers = trackTimers()
  const diag = recordingDiag()
  try {
    await closeRemainingSockets(new Set([fakeSocket('async')]), diag as never)
    assert.equal(timers.live(), 0, 'the losing 2s timer must be cancelled after the close won')
    assert.equal(diag.records.length, 1, 'the settled close is still observable')
    assert.match(diag.records[0]?.message ?? '', /remaining sockets settled/u)
  } finally {
    timers.restore()
  }
})

test('B3-U1-NEG: a genuinely hung socket close is still bounded and reports the timeout duration', async () => {
  const timers = trackTimers()
  const diag = recordingDiag()
  try {
    const startedAt = performance.now()
    await closeRemainingSockets(new Set([fakeSocket('never')]), diag as never, 20)
    const elapsed = performance.now() - startedAt
    assert.ok(elapsed >= 15, `the 20ms hang bound must actually apply (saw ${elapsed}ms)`)
    assert.equal(timers.live(), 0, 'the deadline timer is released even when IT is the winner')
    assert.ok((diag.records[0]?.fields?.durationMs as number) >= 10,
      'the settle record carries the real duration')
  } finally {
    timers.restore()
  }
})

test('B3-U2: an early Fiber disposal owns no referenced 5s deadline', async () => {
  const timers = trackTimers()
  const diag = recordingDiag()
  try {
    await disposeFiberWithinDeadline({ dispose: async () => undefined }, 'gateway', diag as never)
    assert.equal(timers.live(), 0, 'the losing 5s timer must be cancelled after the Fiber settled')
    assert.equal(diag.records[0]?.fields?.timedOut, false)
  } finally {
    timers.restore()
  }
})

test('B3-U2-ERR: a rejected Fiber disposal preserves the error and cancels the deadline', async () => {
  const timers = trackTimers()
  const diag = recordingDiag()
  const failure = new Error('fiber dispose failed')
  try {
    await assert.rejects(
      disposeFiberWithinDeadline({ dispose: async () => { throw failure } }, 'connection', diag as never),
      (error: unknown) => error === failure,
    )
    assert.equal(timers.live(), 0, 'the deadline is cancelled on the rejection path too')
    assert.equal(diag.records[0]?.fields?.timedOut, false)
  } finally {
    timers.restore()
  }
})

test('B3-U2-TIMEOUT: a hung Fiber still fails with the ORIGINAL timeout error after the deadline', async () => {
  const timers = trackTimers()
  const diag = recordingDiag()
  try {
    await assert.rejects(
      disposeFiberWithinDeadline({ dispose: () => new Promise<never>(() => {}) }, 'typert', diag as never, 20),
      /local transport: typert disposal timed out/u,
    )
    assert.equal(timers.live(), 0, 'the fired deadline is released after the race settled')
    assert.equal(diag.records[0]?.fields?.timedOut, true,
      'the record distinguishes the real timeout from a normal settle')
  } finally {
    timers.restore()
  }
})
