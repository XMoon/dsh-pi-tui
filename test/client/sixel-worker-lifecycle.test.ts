/**
 * Image-8 / I8-1C — the single SIXEL encode lane's failure and lifecycle
 * contract.
 *
 * These cases use the real encoder (real `sharp`, real worker) because the
 * claims are about ordering, ownership and recovery: a mocked pipeline could
 * not show that a cancelled job really releases the lane before the next one
 * starts.
 *
 * Deliberately NOT covered here, with the reason:
 * - codec crash: the pinned codec only fails on resource exhaustion, so no
 *   deterministic trigger exists through the public contract;
 * - output overflow (>8 MiB): the raster caps (800x600, 256 colors) bound the
 *   payload far below the 8 MiB guard, so the guard is unreachable by design.
 * @module @xmoon76/dsh-pi-tui/client/sixel-worker-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SixelEncodeBusyError,
  SixelEncodeRejectedError,
  SixelEncoder,
} from '../../src/client/media/sixel/encode.ts'
import type { SixelRasterRequest } from '../../src/client/media/sixel/types.ts'

const CELL_WIDTH_PX = 10
const CELL_HEIGHT_PX = 20

/** Build a real PNG whose dominant color identifies the job. */
async function solidPng(red: number, green: number, blue: number, width = 40, height = 40): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp')
  const rgba = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = red
    rgba[index * 4 + 1] = green
    rgba[index * 4 + 2] = blue
    rgba[index * 4 + 3] = 255
  }
  return new Uint8Array(await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).png().toBuffer())
}

function request(png: Uint8Array, signal: AbortSignal, overrides: Partial<SixelRasterRequest> = {}): SixelRasterRequest {
  return {
    png,
    cellWidthPx: CELL_WIDTH_PX,
    cellHeightPx: CELL_HEIGHT_PX,
    maxColumns: 8,
    maxRows: 4,
    cropTopRows: 0,
    backgroundRgb: 0x282c34,
    signal,
    ...overrides,
  }
}

test('serializes concurrent jobs and keeps each result bound to its own input', async () => {
  const encoder = new SixelEncoder()
  try {
    const red = await solidPng(255, 0, 0)
    const green = await solidPng(0, 255, 0)
    const blue = await solidPng(0, 0, 255)
    const signals = [new AbortController(), new AbortController(), new AbortController()]

    const results = await Promise.all([
      encoder.encode(request(red, signals[0]!.signal)),
      encoder.encode(request(green, signals[1]!.signal)),
      encoder.encode(request(blue, signals[2]!.signal)),
    ])

    const palettes = results.map((raster) => (raster!.sequence.match(/#0;2;[0-9;]+/) ?? [''])[0])
    assert.match(palettes[0]!, /#0;2;100;0;0/, 'the first job must encode the red input')
    assert.match(palettes[1]!, /#0;2;0;100;0/, 'the second job must encode the green input')
    assert.match(palettes[2]!, /#0;2;0;0;100/, 'the third job must encode the blue input')
  } finally {
    await encoder.dispose()
  }
})

test('rejects a queued job on abort and still completes its neighbours', async () => {
  const encoder = new SixelEncoder()
  try {
    const red = await solidPng(255, 0, 0)
    const green = await solidPng(0, 255, 0)
    const blue = await solidPng(0, 0, 255)
    const abortedController = new AbortController()

    const first = encoder.encode(request(red, new AbortController().signal))
    const second = encoder.encode(request(green, abortedController.signal))
    const third = encoder.encode(request(blue, new AbortController().signal))

    abortedController.abort()

    await assert.rejects(() => second, SixelEncodeRejectedError)
    assert.notEqual(await first, null)
    assert.notEqual(await third, null)
  } finally {
    await encoder.dispose()
  }
})

test('aborting the active job releases the lane for the next job', async () => {
  const encoder = new SixelEncoder()
  try {
    // A larger raster keeps the first job in flight long enough to cancel it.
    const big = await solidPng(200, 30, 30, 700, 500)
    const small = await solidPng(0, 0, 255, 20, 20)
    const activeController = new AbortController()

    const active = encoder.encode(request(big, activeController.signal, { maxColumns: 80, maxRows: 30 }))
    const following = encoder.encode(request(small, new AbortController().signal))

    activeController.abort()

    await assert.rejects(() => active, SixelEncodeRejectedError)
    const raster = await following
    assert.notEqual(raster, null)
    assert.match(raster!.sequence, /#0;2;0;0;100/, 'the next job must encode its own blue input')
  } finally {
    await encoder.dispose()
  }
})

test('reports a real overload instead of dropping work', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await solidPng(120, 120, 120, 24, 24)
    const pending: Promise<unknown>[] = []
    // 1 active + 16 queued is the documented bound; the next request must fail.
    for (let index = 0; index < 17; index += 1) {
      pending.push(encoder.encode(request(png, new AbortController().signal)))
    }
    await assert.rejects(() => encoder.encode(request(png, new AbortController().signal)), SixelEncodeBusyError)
    await Promise.allSettled(pending)
  } finally {
    await encoder.dispose()
  }
})

test('abort before the worker starts never reaches a terminal', async () => {
  const encoder = new SixelEncoder()
  try {
    const png = await solidPng(255, 0, 0)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => encoder.encode(request(png, controller.signal)), SixelEncodeRejectedError)
  } finally {
    await encoder.dispose()
  }
})

test('dispose cancels queued work, is idempotent, and refuses later encodes', async () => {
  const encoder = new SixelEncoder()
  const png = await solidPng(255, 255, 255)
  const queued = encoder.encode(request(png, new AbortController().signal))
  const active = encoder.encode(request(png, new AbortController().signal))

  await encoder.dispose()
  await encoder.dispose()

  await assert.rejects(() => queued, SixelEncodeRejectedError)
  await assert.rejects(() => active, SixelEncodeRejectedError)
  await assert.rejects(() => encoder.encode(request(png, new AbortController().signal)), SixelEncodeRejectedError)
})

/**
 * Wait until the encoder has wired handlers onto a freshly constructed worker.
 * `#quantize` calls `worker.once(...)` immediately after `new Worker(...)`, so
 * this is a deterministic "a worker is alive right now" signal — unlike a sleep,
 * which loses the window under load.
 */
async function waitForWorker(workerThreads: typeof import('node:worker_threads'), created: unknown[]): Promise<void> {
  for (let attempt = 0; attempt < 20000 && created.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.ok(created.length > 0, 'the encoder never constructed a worker')
}

test('the lane waits for the REAL worker termination before starting the next job', async () => {
  const workerThreads = await import('node:worker_threads')
  type Once = typeof workerThreads.Worker.prototype.once
  type Terminate = typeof workerThreads.Worker.prototype.terminate
  const originalOnce: Once = workerThreads.Worker.prototype.once
  const originalTerminate: Terminate = workerThreads.Worker.prototype.terminate
  const created: unknown[] = []
  const terminations: { worker: unknown; resolved: boolean }[] = []
  const SLOW_TERMINATE_MS = 300

  workerThreads.Worker.prototype.once = function patchedOnce(
    this: InstanceType<typeof workerThreads.Worker>,
    event: string,
    listener: (...args: unknown[]) => void,
  ): InstanceType<typeof workerThreads.Worker> {
    if (!created.includes(this)) created.push(this)
    return originalOnce.call(this, event, listener)
  } as Once
  // Slow down ONLY the resolution of terminate(): the worker still terminates,
  // but "termination finished" becomes observable long after the call.
  workerThreads.Worker.prototype.terminate = function patchedTerminate(
    this: InstanceType<typeof workerThreads.Worker>,
  ): Promise<number> {
    const record = { worker: this as unknown, resolved: false }
    terminations.push(record)
    const actual = originalTerminate.call(this)
    return new Promise<number>((resolve) => {
      setTimeout(() => {
        void actual.then((code) => {
          record.resolved = true
          resolve(code)
        })
      }, SLOW_TERMINATE_MS)
    })
  } as Terminate

  const encoder = new SixelEncoder()
  const big = await solidPng(180, 30, 30, 800, 600)
  const small = await solidPng(0, 0, 255, 20, 20)
  try {
    const controller = new AbortController()
    const active = encoder.encode(request(big, controller.signal, { maxColumns: 80, maxRows: 30 }))
    await waitForWorker(workerThreads, created)
    const abortedWorker = created[0]

    const following = encoder.encode(request(small, new AbortController().signal))
    controller.abort()

    await assert.rejects(() => active, SixelEncodeRejectedError)
    const raster = await following
    assert.notEqual(raster, null, 'the following job must still produce a raster')

    const record = terminations.find((entry) => entry.worker === abortedWorker)
    assert.ok(record !== undefined, 'the aborted job must have terminated its own worker')
    assert.equal(
      record.resolved,
      true,
      'the next job may only start after the aborted worker really terminated',
    )
  } finally {
    workerThreads.Worker.prototype.once = originalOnce
    workerThreads.Worker.prototype.terminate = originalTerminate
    await encoder.dispose()
  }
})

test('dispose rejects with the disposal error even after the worker started', async () => {
  const workerThreads = await import('node:worker_threads')
  type Once = typeof workerThreads.Worker.prototype.once
  type Terminate = typeof workerThreads.Worker.prototype.terminate
  const originalOnce: Once = workerThreads.Worker.prototype.once
  const originalTerminate: Terminate = workerThreads.Worker.prototype.terminate
  const created: unknown[] = []
  const terminatedWorkers: unknown[] = []

  workerThreads.Worker.prototype.once = function patchedOnce(
    this: InstanceType<typeof workerThreads.Worker>,
    event: string,
    listener: (...args: unknown[]) => void,
  ): InstanceType<typeof workerThreads.Worker> {
    if (!created.includes(this)) created.push(this)
    return originalOnce.call(this, event, listener)
  } as Once
  workerThreads.Worker.prototype.terminate = function patchedTerminate(
    this: InstanceType<typeof workerThreads.Worker>,
  ): Promise<number> {
    terminatedWorkers.push(this as unknown)
    return originalTerminate.call(this)
  } as Terminate

  const encoder = new SixelEncoder()
  const big = await solidPng(200, 40, 40, 800, 600)
  try {
    const pending = encoder.encode(
      request(big, new AbortController().signal, { maxColumns: 80, maxRows: 30 }),
    )
    // Handler first: disposal settles the request synchronously.
    const outcome = pending.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    await waitForWorker(workerThreads, created)
    const liveWorker = created[0]

    await encoder.dispose()
    const result = await outcome
    assert.ok(
      result instanceof SixelEncodeRejectedError,
      `dispose must reject with the disposal error, got ${String(result)}`,
    )
    assert.ok(
      terminatedWorkers.includes(liveWorker),
      'dispose must have terminated the worker that was already running',
    )
  } finally {
    workerThreads.Worker.prototype.once = originalOnce
    workerThreads.Worker.prototype.terminate = originalTerminate
    await encoder.dispose()
  }
})

test('a concurrent second dispose waits for the same in-flight termination', async () => {
  const workerThreads = await import('node:worker_threads')
  type Once = typeof workerThreads.Worker.prototype.once
  type Terminate = typeof workerThreads.Worker.prototype.terminate
  const originalOnce: Once = workerThreads.Worker.prototype.once
  const originalTerminate: Terminate = workerThreads.Worker.prototype.terminate
  const created: unknown[] = []
  const records: { worker: unknown; resolved: boolean }[] = []
  const SLOW_TERMINATE_MS = 250

  workerThreads.Worker.prototype.once = function patchedOnce(
    this: InstanceType<typeof workerThreads.Worker>,
    event: string,
    listener: (...args: unknown[]) => void,
  ): InstanceType<typeof workerThreads.Worker> {
    if (!created.includes(this)) created.push(this)
    return originalOnce.call(this, event, listener)
  } as Once
  workerThreads.Worker.prototype.terminate = function patchedTerminate(
    this: InstanceType<typeof workerThreads.Worker>,
  ): Promise<number> {
    const record = { worker: this as unknown, resolved: false }
    records.push(record)
    const actual = originalTerminate.call(this)
    return new Promise<number>((resolve) => {
      setTimeout(() => {
        void actual.then((code) => {
          record.resolved = true
          resolve(code)
        })
      }, SLOW_TERMINATE_MS)
    })
  } as Terminate

  const encoder = new SixelEncoder()
  const big = await solidPng(200, 40, 40, 800, 600)
  try {
    const pending = encoder.encode(
      request(big, new AbortController().signal, { maxColumns: 80, maxRows: 30 }),
    )
    const outcome = pending.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    await waitForWorker(workerThreads, created)
    const liveWorker = created[0]

    const first = encoder.dispose()
    const second = encoder.dispose()
    // The SECOND await must already imply the real termination finished; a
    // dispose that returns early on re-entry would resolve long before.
    await second
    const record = records.find((entry) => entry.worker === liveWorker)
    assert.ok(record !== undefined, 'disposal must have terminated the live worker')
    assert.equal(
      record.resolved,
      true,
      'a concurrent dispose must not resolve before the termination finishes',
    )
    await first
    const result = await outcome
    assert.ok(result instanceof SixelEncodeRejectedError, 'disposal must reject the request')
  } finally {
    workerThreads.Worker.prototype.once = originalOnce
    workerThreads.Worker.prototype.terminate = originalTerminate
    await encoder.dispose()
  }
})
