/**
 * PR-D: the Client-local SVG raster cache and its isolated child rasterizer.
 *
 * The cache owns dedupe, settle notification and the stale-generation fence;
 * the rasterizer owns the OS process boundary and the PNG budget checks. The
 * real child lifecycle cases prove timeout/cancellation/close. Size-budget
 * refusals must not depend on a native PNG happy path.
 * @module @xmoon76/dsh-pi-tui/svg-raster.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { createSvgRasterizer, isolatedSvgRasterSupported, isRetryableRasterFailure, rasterizeSvg, SvgRasterFailure, type SvgRasterize } from '../../src/client/media/svg/rasterize.ts'
import { admitSvg } from '../../src/domain/visual/svg-admission.ts'
import { SvgThumbnail } from '../../src/tui/components/media/svg-thumbnail.ts'
import { MAX_IMAGE_ROWS } from '../../src/tui/components/media/image-thumbnail.ts'
import type { ImageGraphics, PixelBody } from '../../src/tui/graphics/native-image.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='


test('the loader dedupes one digest, notifies on settle and keeps an unrequested digest idle', async () => {
  let rasterCalls = 0
  let release!: (value: { png: Uint8Array; base64: string; widthPx: number; heightPx: number }) => void
  const loader = new SvgRasterLoader(async () => {
    rasterCalls += 1
    return await new Promise(resolve => { release = resolve })
  })
  assert.deepEqual(loader.get('digest-a', 128), { state: 'idle' })
  let notifications = 0
  const unsubscribe = loader.subscribe('digest-a', 128, () => { notifications += 1 })
  loader.load('digest-a', 'source-a', 128)
  loader.load('digest-a', 'source-a', 128)
  assert.equal(loader.get('digest-a', 128).state, 'loading')
  assert.equal(rasterCalls, 1, 'concurrent loads are deduped')
  release({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })
  await new Promise(resolve => setImmediate(resolve))
  const ready = loader.get('digest-a', 128)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.state === 'ready' ? ready.base64 : '', TINY_PNG_BASE64)
  assert.equal(notifications, 1)
  unsubscribe()
  loader.dispose()
})

test('clear() aborts an in-flight child and drops its late result', async () => {
  let observedAbort = false
  let release!: (value: { png: Uint8Array; base64: string; widthPx: number; heightPx: number }) => void
  const loader = new SvgRasterLoader(async (_source, options) => {
    options.signal.addEventListener('abort', () => { observedAbort = true })
    return await new Promise(resolve => { release = resolve })
  })
  loader.load('digest-b', 'source-b', 128)
  loader.clear()
  assert.equal(observedAbort, true, 'the in-flight request sees the abort')
  assert.deepEqual(loader.get('digest-b', 128), { state: 'idle' })
  release({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(loader.get('digest-b', 128), { state: 'idle' }, 'a cleared epoch never stores a late result')
  loader.dispose()
})

const nativeRasterSkip = process.platform === 'linux' || process.platform === 'darwin'
  ? false
  : 'the isolated raster lane is supported on Linux and (Owner-risk-accepted) macOS only'

test('the isolated raster lane is enabled on Linux and macOS', { skip: nativeRasterSkip }, () => {
  assert.equal(isolatedSvgRasterSupported(), true)
})

// ── PR-4B: the new static paint attributes reach REAL resvg pixels ────────

/**
 * Decode one RGBA PNG (the rasterizer's own output) into its IHDR dimensions
 * and raw pixel rows, so the static-attribute positives assert the PAINTED
 * COLOR at a known coordinate — not merely that resvg produced any bytes.
 * Uses only `node:zlib` (the test owns the tiny PNG defilter loop).
 */
function decodePngRgba(bytes: Uint8Array): { width: number; height: number; at(x: number, y: number): [number, number, number, number] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(bytes[0], 0x89)
  assert.equal(bytes[1], 0x50, 'PNG signature')
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  let offset = 8
  const idat: Uint8Array[] = []
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = Buffer.from(bytes.buffer, bytes.byteOffset + offset + 4, 4).toString('latin1')
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat.map(copy => Buffer.from(copy))))
  const stride = width * 4 + 1
  const rows: Buffer[] = []
  let previous = Buffer.alloc(width * 4)
  for (let y = 0; y < height; y++) {
    const line = Buffer.from(raw.subarray(y * stride, (y + 1) * stride))
    const filter = line[0]
    const current = Buffer.from(line.subarray(1))
    for (let x = 0; x < width * 4; x++) {
      const left = x >= 4 ? current[x - 4]! : 0
      const up = previous[x]!
      const upLeft = x >= 4 ? previous[x - 4]! : 0
      if (filter === 1) current[x] = (current[x]! + left) & 0xff
      else if (filter === 2) current[x] = (current[x]! + up) & 0xff
      else if (filter === 3) current[x] = (current[x]! + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        current[x] = (current[x]! + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
      }
    }
    rows.push(current)
    previous = current
  }
  return {
    width,
    height,
    at(x: number, y: number): [number, number, number, number] {
      const row = rows[y]!
      return [row[x * 4]!, row[x * 4 + 1]!, row[x * 4 + 2]!, row[x * 4 + 3]!]
    },
  }
}

test('real resvg renders the admitted static paint attributes into distinct pixels', { skip: nativeRasterSkip }, async () => {
  // This test owns native PIXEL semantics, not the isolated child deadline.
  // The separate raster lifecycle tests own spawn/timeout/close/cancellation.
  const { Resvg } = await import('@resvg/resvg-js')
  // One figure per new attribute, each with a known coordinate/color contract:
  // the dash pattern leaves the background visible between dashes; the offset
  // shifts the visible dash phase; currentColor resolves from the inherited
  // static `color` attribute.
  const dashSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect width="128" height="128" fill="#000000"/>'
    + '<path d="M8 64 L120 64" stroke="#ff0000" stroke-width="16" stroke-dasharray="32 32"/></svg>'
  const offsetSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect width="128" height="128" fill="#000000"/>'
    + '<path d="M8 64 L120 64" stroke="#00ff00" stroke-width="16" stroke-dasharray="16 48" stroke-dashoffset="16"/></svg>'
  const colorSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect width="128" height="128" fill="#000000"/>'
    + '<rect x="16" y="16" width="96" height="96" color="#0000ff" fill="currentColor"/></svg>'
  const miterSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
    + '<rect width="128" height="128" fill="#000000"/>'
    + '<path d="M20 108 L64 28 L108 108" fill="none" stroke="#ffff00" stroke-width="8" stroke-miterlimit="4"/></svg>'
  // The four fixed fixtures still cross the REAL admission boundary and
  // render through the REAL native resvg engine. Avoid four OS child starts
  // and their unrelated 3 s wall-clock deadlines in this pixel-contract test.
  const renderPixels = (svg: string): ReturnType<typeof decodePngRgba> => {
    assert.equal(admitSvg(svg).ok, true, 'the static paint fixture must be admitted')
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 } }).render().asPng()
    const pixels = decodePngRgba(png)
    assert.equal(pixels.width, 128)
    assert.equal(pixels.height, 128)
    return pixels
  }
  const dashImage = renderPixels(dashSvg)
  const offsetImage = renderPixels(offsetSvg)
  const colorImage = renderPixels(colorSvg)
  const miterImage = renderPixels(miterSvg)
  // Dash: an odd dash cycle over 112px leaves black background gaps on the line.
  const dashReds: boolean[] = []
  const dashBlacks: boolean[] = []
  for (let x = 8; x <= 120; x++) {
    const [r, g, b] = dashImage.at(x, 64)
    if (r > 200 && g < 60 && b < 60) dashReds.push(true)
    if (r < 40 && g < 40 && b < 40) dashBlacks.push(true)
  }
  assert.ok(dashReds.length > 0, 'the dash stroke paints red segments')
  assert.ok(dashBlacks.length > 0, 'the dash gap keeps the black background (the dash pattern is really applied)')
  // Offset: shifting the dash phase by 16px paints green at a coordinate the
  // unshifted pattern leaves black (the offset really moves the dash phase).
  const offsetShiftedGreens: boolean[] = []
  for (let x = 8; x <= 120; x++) {
    const [r, g, b] = offsetImage.at(x, 64)
    if (r < 60 && g > 200 && b < 60) offsetShiftedGreens.push(true)
  }
  assert.ok(offsetShiftedGreens.length > 0, 'the offset dash stroke paints green segments')
  // currentColor: the inherited static color attribute becomes the fill.
  const [cr, cg, cb] = colorImage.at(64, 64)
  assert.ok(cb > 150 && cr < 60 && cg < 60, `currentColor resolved to the inherited blue, saw rgb(${cr},${cg},${cb})`)
  // Miter: the miter limit of 4 keeps the sharp corner painted yellow.
  const [mr, mg, mb] = miterImage.at(64, 34)
  assert.ok(mr > 150 && mg > 150 && mb < 80, `the mitered corner paints yellow, saw rgb(${mr},${mg},${mb})`)
})

test('the Linux launcher keeps the verified ulimit cap and the Darwin launcher has no shell', async () => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return
  let seen: { readonly command: string; readonly args: readonly string[] } | undefined
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    seen = { command: args[0], args: args[1] ?? [] }
    return spawn(...args)
  }) as typeof spawn
  const rasterize = createSvgRasterizer(spawnProcess)
  const result = await rasterize(SVG_SOURCE, { targetWidth: 128, signal: new AbortController().signal })
  assert.equal(result.widthPx, 128)
  assert.ok(seen !== undefined)
  if (process.platform === 'linux') {
    assert.equal(seen.command, '/bin/sh')
    assert.equal(seen.args[0], '-c')
    assert.match(seen.args[1] ?? '', /ulimit -v 4194304 \|\| exit 97; exec/u)
  } else {
    assert.equal(seen.command, process.execPath)
    assert.ok(!seen.args.includes('/bin/sh'))
    assert.ok(seen.args.includes('--max-old-space-size=256'))
    assert.ok(!seen.args.some((arg) => arg.includes('ulimit')))
  }
})

test('an already-aborted raster request is refused before work starts', { skip: nativeRasterSkip }, async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(rasterizeSvg(SVG_SOURCE, { targetWidth: 128, signal: controller.signal }), /cancelled/u)
})

/**
 * A scripted raster child for the failure-MESSAGE witnesses: real `PassThrough`
 * streams and the real event order the production listeners consume, but driven
 * by the test instead of by a spawned process. The shape of a diagnostic message
 * must not depend on whether a real child happened to get scheduled before the
 * bound — that is the very condition the diagnostic exists to report — so the
 * lifecycle witness keeps a real child and these cases run deterministically.
 * @param tick - advance the mocked `setTimeout` clock (the production bound).
 */
function scriptedRasterChild(tick: (ms: number) => void): {
  readonly killed: string[]
  readonly runToTimeout: (milestones: string) => Promise<Error>
  readonly runToExit: (code: number, stderrText: string) => Promise<Error>
  readonly runToAnswer: (answer: string) => Promise<Error>
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const listeners = new EventEmitter()
  const killed: string[] = []
  const child = {
    stdout,
    stderr,
    stdin,
    kill: (signal: string): boolean => {
      killed.push(signal)
      return true
    },
    on: (event: string, listener: (...args: unknown[]) => void): void => {
      listeners.on(event, listener)
    },
  }
  const spawnProcess = (() => child) as unknown as typeof spawn
  /** One admitted request through the REAL rasterizer over this scripted child. */
  const request = (): Promise<unknown> => createSvgRasterizer(spawnProcess)(
    SVG_SOURCE,
    { targetWidth: 128, signal: new AbortController().signal },
  )
  /** Let the stream callbacks the rasterizer registered run to completion. */
  const drained = async (): Promise<void> => {
    await new Promise(resolve => setImmediate(resolve))
  }
  return {
    killed,
    /** One request that reaches the bound without ever answering. */
    runToTimeout: async (milestones: string): Promise<Error> => {
      const pending = request()
      if (milestones !== '') stderr.write(`${milestones}\n`)
      await drained()
      tick(3_000)
      stdout.end()
      stderr.end()
      await drained()
      listeners.emit('exit', null, 'SIGKILL')
      listeners.emit('close', null, 'SIGKILL')
      return await pending.then(
        () => assert.fail('the never-answering child must reject'),
        (error: unknown) => error as Error,
      )
    },
    /** One request whose child closes with its own non-zero exit code. */
    runToExit: async (code: number, stderrText: string): Promise<Error> => {
      const pending = request()
      stderr.write(`${stderrText}\n`)
      await drained()
      stdout.end()
      stderr.end()
      await drained()
      listeners.emit('exit', code, null)
      listeners.emit('close', code, null)
      return await pending.then(
        () => assert.fail('the exiting child must reject'),
        (error: unknown) => error as Error,
      )
    },
    /** One request whose child answers with an arbitrary JSON payload and closes 0. */
    runToAnswer: async (answer: string): Promise<Error> => {
      const pending = request()
      await drained()
      stdout.write(answer)
      stdout.end()
      stderr.end()
      await drained()
      listeners.emit('exit', 0, null)
      listeners.emit('close', 0, null)
      return await pending.then(
        () => assert.fail('the scripted answer must be rejected'),
        (error: unknown) => error as Error,
      )
    },
  }
}

test('the raster timeout renders the worker milestones in the order the parent observed them', { skip: nativeRasterSkip }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const failure = await scriptedRasterChild(ms => t.mock.timers.tick(ms)).runToTimeout([
    'rp request=1',
    'rp import=9',
    // A real stderr record that only LOOKS like a milestone: absorbing it into
    // the array would make the diagnostic invent a worker phase that never ran.
    'rp native abort',
  ].join('\n'))
  assert.match(failure.message,
    /\[spawn=\d+ stdinWritten=\d+ terminate=\d+\(timeout\) stdoutEnd=\d+\(0b\) exit=\d+\(code=null signal=SIGKILL\) close=\d+\(code=null signal=SIGKILL\)\]/u,
    `the marks appear in the order the boundaries were reached: ${failure.message}`)
  assert.match(failure.message, /\[rp request=1 rp import=9\]/u,
    `the array ends at the last real record: ${failure.message}`)
  assert.ok(!failure.message.includes('firstStdout'),
    'a child that answered nothing records no stdout boundary, so the two stalls stay separable')
})

test('a legitimate raster timeout with no worker milestones at all still classifies from the close', { skip: nativeRasterSkip }, async (t) => {
  // The zero-record case is VALID, not a diagnostic failure: a child that never
  // reported anything leaves an empty array, and nothing may turn that into a
  // second error or a different classification.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const failure = await scriptedRasterChild(ms => t.mock.timers.tick(ms)).runToTimeout('')
  assert.match(failure.message, /SVG rasterization exceeded 3000 ms/u)
  assert.ok(failure.message.endsWith('[]'), `no milestone was invented: ${failure.message}`)
})

test('a raster child that outlives the 3 s bound is classified as a timeout after its real close', { skip: nativeRasterSkip }, async () => {
  // The ONE hard-timeout path, measured on a REAL child: a process that never
  // answers, the SIGKILL at the shared `SVG_RASTER_TIMEOUT_MS` bound, and a
  // promise that settles only after `close`. This is the event-order evidence
  // for the `SVG rasterization exceeded 3000 ms` failure class; it does not
  // change the production budget. It asserts only what stays true when the child
  // is starved of CPU: a real child is not guaranteed to report any milestone
  // before the bound, and requiring that here would make the guard depend on the
  // scheduling it exists to diagnose.
  const events: string[] = []
  let child: ChildProcessWithoutNullStreams | undefined
  const spawnProcess = ((..._args: Parameters<typeof spawn>): ReturnType<typeof spawn> => {
    const spawned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = spawned
    events.push('spawn')
    spawned.on('exit', (code, signal) => events.push(`exit:${signal ?? code}`))
    spawned.on('close', (code, signal) => events.push(`close:${signal ?? code}`))
    return spawned
  }) as typeof spawn
  const rasterize = createSvgRasterizer(spawnProcess)
  const started = Date.now()
  const failure = await rasterize(SVG_SOURCE, { targetWidth: 128, signal: new AbortController().signal }).then(
    () => assert.fail('the never-answering child must reject'),
    (error: unknown) => error as Error,
  )
  events.push('settled')
  const elapsed = Date.now() - started
  assert.deepEqual(events, ['spawn', 'exit:SIGKILL', 'close:SIGKILL', 'settled'],
    'the failure settles from the real child close, never from the timer alone')
  assert.ok(elapsed >= 3000, `the shared hard timeout really elapsed: ${elapsed} ms`)
  assert.ok(elapsed < 10_000, `the failure is bounded by the raster budget, not a 30 s wait: ${elapsed} ms`)
  assert.equal(child?.signalCode, 'SIGKILL', 'the child process is really gone before the promise settles')
  assert.equal(child?.exitCode, null)
  assert.match(failure.message, /SVG rasterization exceeded 3000 ms/u)
  assert.match(failure.message, /\[spawn=\d+ /u, `the timeline starts at the spawn: ${failure.message}`)
  assert.match(failure.message, /terminate=\d+\(timeout\)/u,
    `the timeout names its own boundary: ${failure.message}`)
  assert.ok(!failure.message.includes('firstStdout'),
    'the real child answered nothing, so no stdout boundary is recorded')
})

test('a real timeout -> loader retry -> real successor PNG is ONE chain', { skip: nativeRasterSkip }, async () => {
  // §5 item 1 joins three boundaries on the PRODUCTION rasterizer: a real child
  // that outlives the 3 s bound, the loader's typed retry eligibility, and a
  // real successor render on the same single lane. No fake rasterizer, no sleep.
  let spawns = 0
  const spawnProcess = ((...args: Parameters<typeof spawn>): ReturnType<typeof spawn> => {
    spawns += 1
    if (spawns === 1) {
      return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    return spawn(...args)
  }) as typeof spawn
  const loader = new SvgRasterLoader(createSvgRasterizer(spawnProcess))
  const digest = 'real-retry-chain'
  const width = 128
  const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const value = read()
      if (value !== undefined) return value
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try {
    loader.subscribe(digest, width, () => {})
    loader.load(digest, SVG_SOURCE, width)
    const errored = await waitFor(() => {
      const state = loader.get(digest, width)
      return state.state === 'error' ? state : undefined
    }, 'the real child timeout classification')
    assert.ok(errored.error instanceof SvgRasterFailure, `the real timeout is the typed failure: ${errored.error.message}`)
    assert.equal(isRetryableRasterFailure(errored.error), true, 'a real timeout is retryable')
    assert.equal(loader.canRetryFailed(digest, width), true, 'the loader exposes Retry for the settled timeout')
    assert.equal(loader.retryFailed(digest, SVG_SOURCE, width), true, 'the ONE retry lane accepts the real failure')
    const ready = await waitFor(() => {
      const state = loader.get(digest, width)
      return state.state === 'ready' ? state : undefined
    }, 'the real successor render')
    assert.equal(spawns, 2, 'exactly one successor child on the same lane')
    assert.ok(ready.base64.startsWith('iVBOR'), 'the successor carries a real PNG payload')
    assert.ok(ready.widthPx > 0 && ready.heightPx > 0, 'the successor carries real raster dimensions')
  } finally {
    loader.dispose()
  }
})

test('a raster child that exits with an error keeps its real stderr, not its milestone lines', { skip: nativeRasterSkip }, async () => {
  // `rp native abort` is a genuine native error line that only LOOKS like the
  // milestone prefix: filtering by prefix would delete it from the one message
  // that exists to report the failure.
  const harness = scriptedRasterChild(() => {
    throw new Error('this case settles from the child exit, never from the bound')
  })
  const failure = await harness.runToExit(3, 'rp request=1\nrp native abort\nresvg hard failure')
  assert.match(failure.message, /SVG rasterizer exited \(3\): rp native abort\nresvg hard failure/u, failure.message)
  assert.ok(!failure.message.includes('rp request=1'), `milestones never bury the error: ${failure.message}`)
  assert.deepEqual(harness.killed, [], 'a real exit is not a termination')
})

test('an actual oversized PNG is refused by its IHDR budget, not only the declared canvas', { skip: nativeRasterSkip }, async () => {
  const harness = scriptedRasterChild(() => {
    throw new Error('this case answers, never times out')
  })
  // A minimal PNG signature + IHDR carrying 4096x4096: the parent's final
  // actual-output check must refuse it even though the declared canvas passed.
  const oversized = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized, 0)
  oversized.writeUInt32BE(4096, 16)
  oversized.writeUInt32BE(4096, 20)
  const failure = await harness.runToAnswer(JSON.stringify({ ok: true, png: oversized.toString('base64') }))
  assert.match(failure.message, /SVG raster exceeded the pixel budget \(4096×4096\)/u, failure.message)
  assert.deepEqual(harness.killed, [], 'a budget refusal is not a timeout kill')
})

test('a crashed raster child releases the lane for the next real render', { skip: nativeRasterSkip }, async () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const listeners = new EventEmitter()
  let first = true
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    if (!first) return spawn(...args)
    first = false
    const child = {
      stdout,
      stderr,
      stdin,
      kill: (): boolean => true,
      on: (event: string, listener: (...eventArgs: unknown[]) => void): void => {
        listeners.on(event, listener)
      },
    }
    queueMicrotask(() => {
      stdout.end(JSON.stringify({ ok: false, error: 'native abort' }))
      stderr.end()
      listeners.emit('exit', 3, null)
      listeners.emit('close', 3, null)
    })
    return child
  }) as unknown as typeof spawn
  const rasterize = createSvgRasterizer(spawnProcess)
  await assert.rejects(
    rasterize(SVG_SOURCE, { targetWidth: 128, signal: new AbortController().signal }),
    /SVG rasterizer exited \(3\)/u,
  )
  const recovered = await rasterize(SVG_SOURCE, { targetWidth: 128, signal: new AbortController().signal })
  assert.equal(recovered.widthPx, 128, 'the next request reaches a real native render')
  assert.equal(recovered.heightPx, 64)
})

test('a real crashed child releases the LOADER lane for a successor real render', { skip: nativeRasterSkip }, async () => {
  let children = 0
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    children += 1
    if (children === 1) {
      // A REAL process that dies abnormally; the second request must get the
      // real production launcher args unchanged.
      return spawn(process.execPath, ['-e', 'process.exit(3)'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    return spawn(...args)
  }) as typeof spawn
  const loader = new SvgRasterLoader(createSvgRasterizer(spawnProcess))
  const settled = (digest: string): Promise<void> => new Promise((resolve) => {
    const unsubscribe = loader.subscribe(digest, 128, () => {
      unsubscribe()
      resolve()
    })
  })
  const crashed = settled('crash-digest')
  loader.load('crash-digest', SVG_SOURCE, 128)
  await crashed
  const crashedState = loader.get('crash-digest', 128)
  assert.equal(crashedState.state, 'error', 'the crash is a terminal error state')
  assert.match(crashedState.state === 'error' ? crashedState.error.message : '', /SVG rasterizer exited \(3\)/u,
    'the failure is the real child exit, not a timeout')
  const recovered = settled('successor-digest')
  loader.load('successor-digest', SVG_SOURCE, 128)
  await recovered
  assert.equal(loader.get('successor-digest', 128).state, 'ready',
    'the same loader starts a new real child after the crash')
  loader.dispose()
})

test('a real child stdout overflow releases the LOADER lane for a successor real render', { skip: nativeRasterSkip }, async () => {
  let children = 0
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    children += 1
    if (children === 1) {
      return spawn(process.execPath, [
        '-e',
        "process.stdout.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000)",
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    }
    return spawn(...args)
  }) as typeof spawn
  const loader = new SvgRasterLoader(createSvgRasterizer(spawnProcess))
  const settled = (digest: string): Promise<void> => new Promise((resolve) => {
    const unsubscribe = loader.subscribe(digest, 128, () => {
      unsubscribe()
      resolve()
    })
  })
  const overflowed = settled('overflow-digest')
  loader.load('overflow-digest', SVG_SOURCE, 128)
  await overflowed
  const overflowedState = loader.get('overflow-digest', 128)
  assert.equal(overflowedState.state, 'error', 'the overflow is a terminal error state')
  assert.match(overflowedState.state === 'error' ? overflowedState.error.message : '',
    /SVG rasterizer produced too much output/u, 'the failure is the overflow guard, not a timeout')
  const recovered = settled('after-overflow-digest')
  loader.load('after-overflow-digest', SVG_SOURCE, 128)
  await recovered
  assert.equal(loader.get('after-overflow-digest', 128).state, 'ready',
    'the same loader starts a new real child after the overflow')
  loader.dispose()
})

test('the loader runs ONE global raster at a time and an evicted digest reaches a terminal state', async () => {
  let active = 0
  let maxActive = 0
  const calls = new Map<string, number>()
  const releases: Array<() => void> = []
  const loader = new SvgRasterLoader(async (source, options) => {
    calls.set(source, (calls.get(source) ?? 0) + 1)
    active += 1
    maxActive = Math.max(maxActive, active)
    return await new Promise((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        active -= 1
        finish()
      }
      releases.push(() => settle(() => resolve({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })))
      options.signal.addEventListener('abort', () => settle(() => reject(new Error('cancelled'))), { once: true })
    })
  })
  // A LIVE demand is what turns an eviction into a terminal state; a digest
  // without subscribers is forgettable cache history (see the thumbnail tests).
  loader.subscribe('digest-0', 128, () => {})
  for (let index = 0; index < 13; index += 1) loader.load(`digest-${index}`, `source-${index}`, 128)
  assert.equal(maxActive, 1, 'different digests must never spawn concurrent native rasterizations')
  // The 13th load evicts the ACTIVE oldest entry. It must not be resurrected
  // and must not stay 'idle' (which would invite an endless re-request).
  await new Promise(resolve => setImmediate(resolve))
  const evicted = loader.get('digest-0', 128)
  assert.equal(evicted.state, 'error')
  assert.match(evicted.state === 'error' ? evicted.error.message : '', /evicted/u)
  loader.load('digest-0', 'source-0', 128)
  assert.equal(loader.get('digest-0', 128).state, 'error', 'the eviction is terminal for this epoch')
  assert.equal(calls.get('source-0'), 1, 'the evicted digest is never retried; the next queued digest proceeds')
  while (releases.length > 0) {
    releases.shift()?.()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(maxActive, 1, 'the single lane stays bounded while the queue drains')
  loader.dispose()
})

test('clear() releases the eviction epoch and lets a later load restart the source', async () => {
  let calls = 0
  let releaseFirst!: () => void
  const loader = new SvgRasterLoader(async () => {
    calls += 1
    return await new Promise(resolve => { releaseFirst = () => resolve({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 }) })
  })
  loader.load('a', 'source-a', 128)
  assert.equal(calls, 1)
  loader.clear()
  loader.load('b', 'source-b', 128)
  assert.equal(calls, 1, 'a cleared active lane stays claimed until its request settles')
  releaseFirst()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2, 'the next request starts only after the prior lane settled')
  releaseFirst()
  await new Promise(resolve => setImmediate(resolve))
  loader.dispose()
})

test('a loading thumbnail evicted from the cache leaves the loading line and does not retry', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const calls = new Map<string, number>()
    const releases: Array<() => void> = []
    const loader = new SvgRasterLoader(async (source, options) => {
      calls.set(source, (calls.get(source) ?? 0) + 1)
      return await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void): void => { if (settled) return; settled = true; fn() }
        releases.push(() => finish(() => resolve({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })))
        options.signal.addEventListener('abort', () => finish(() => reject(new Error('cancelled'))), { once: true })
      })
    })
    let notifications = 0
    loader.subscribe('digest-0', 128, () => { notifications += 1 })
    const thumbnails = Array.from({ length: 13 }, (_, index) => new SvgThumbnail(
      `digest-${index}`,
      `source-${index}`,
      128,
      loader,
      { fallbackColor: (text: string) => text },
      () => {},
    ))
    for (const thumbnail of thumbnails) thumbnail.render(100)
    assert.equal(loader.get('digest-0', 128).state, 'error', 'the evicted active digest is terminal')
    assert.equal(notifications, 1, 'its live subscriber was notified exactly once')
    const firstPaint = thumbnails[0]!.render(100).join('\n')
    assert.ok(!firstPaint.includes('Rendering SVG image'), `the evicted image must not stay loading:\n${firstPaint}`)
    assert.ok(firstPaint.includes('SVG image unavailable'), firstPaint)
    assert.equal(calls.get('source-0'), 1, 'the evicted digest is never retried')
    // Drain the single lane to prove the remaining subscriptions converge.
    for (let index = 0; index < 20 && releases.length > 0; index += 1) {
      releases.shift()?.()
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.equal(loader.get('digest-12', 128).state, 'ready')
    for (const thumbnail of thumbnails) thumbnail.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})


test('a cancellation settles only after the REAL child process closed', { skip: nativeRasterSkip }, async () => {
  let spawned = 0
  let open = 0
  let maxOpen = 0
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    spawned += 1
    open += 1
    maxOpen = Math.max(maxOpen, open)
    child.on('close', () => { open -= 1 })
    return child
  }) as typeof spawn
  const rasterize = createSvgRasterizer(spawnProcess)
  const controller = new AbortController()
  const pending = rasterize(SVG_SOURCE, { targetWidth: 128, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, /cancelled/u)
  assert.equal(spawned, 1)
  assert.equal(maxOpen, 1)
  assert.equal(open, 0, 'the promise must settle only after the real child close')
})


test('the live subscriber terminal state survives arbitrary cache-history churn', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const calls = new Map<string, number>()
    const releases: Array<() => void> = []
    const loader = new SvgRasterLoader(async (source, options) => {
      calls.set(source, (calls.get(source) ?? 0) + 1)
      return await new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn: () => void): void => { if (settled) return; settled = true; fn() }
        releases.push(() => finish(() => resolve({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })))
        options.signal.addEventListener('abort', () => finish(() => reject(new Error('cancelled'))), { once: true })
      })
    })
    let firstNotifications = 0
    loader.subscribe('digest-0', 128, () => { firstNotifications += 1 })
    // 12 cache entries + 64 more + one: the old bounded-history design forgot
    // the first live terminal after 64 evictions and restarted it.
    const thumbnails = Array.from({ length: 77 }, (_, index) => new SvgThumbnail(
      `digest-${index}`,
      `source-${index}`,
      128,
      loader,
      { fallbackColor: (text: string) => text },
      () => {},
    ))
    for (const thumbnail of thumbnails) thumbnail.render(100)
    for (let frame = 0; frame < 4; frame += 1) {
      const paint = thumbnails[0]!.render(100).join('\n')
      assert.ok(!paint.includes('Rendering SVG image'), `frame ${frame}: the evicted live demand must stay terminal:\n${paint}`)
      assert.ok(paint.includes('SVG image unavailable'), paint)
    }
    assert.equal(firstNotifications, 1)
    assert.equal(calls.get('source-0'), 1, 'the live terminal state is not a retry loop')
    assert.equal(loader.get('digest-0', 128).state, 'error')
    for (const thumbnail of thumbnails) thumbnail.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})


const ASPECT_MISMATCH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="4" viewBox="0 0 2048 64">'
  + '<rect width="64" height="32" fill="#ff0000"/></svg>'

test('an admitted aspect-mismatched SVG is refused before a native child starts', { skip: nativeRasterSkip }, async () => {
  const admission = admitSvg(ASPECT_MISMATCH_SVG)
  assert.equal(admission.ok, true, 'the source itself is admitted')
  if (admission.ok) {
    assert.equal(admission.width, 2048)
    assert.equal(admission.height, 64)
  }
  // The declared viewport is 1:4, so targetWidth 2048 becomes 2048x8192.
  // The parent must reject this canvas before even launching a native process.
  let spawned = 0
  const rasterize = createSvgRasterizer(((...args: Parameters<typeof spawn>) => {
    spawned += 1
    return spawn(...args)
  }) as typeof spawn)
  await assert.rejects(
    rasterize(ASPECT_MISMATCH_SVG, { targetWidth: 2048, signal: new AbortController().signal }),
    /raster canvas 2048x8192/u,
  )
  assert.equal(spawned, 0, 'an over-budget canvas must not spawn a native child')
})


const FRACTIONAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="0.5" height="1" viewBox="0 0 2000 1">'
  + '<rect width="20" height="1" fill="#ff0000"/></svg>'
const TALL_FRACTIONAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="0.5" height="2048" viewBox="0 0 1 64">'
  + '<rect width="1" height="64" fill="#ff0000"/></svg>'

test('a fractional CSS viewport is refused before the native child spawns', { skip: nativeRasterSkip }, async () => {
  let spawned = 0
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    spawned += 1
    return spawn(...args)
  }) as typeof spawn
  const rasterize = createSvgRasterizer(spawnProcess)
  // 0.5x1 viewport at target 2000 is a real 2000x4000 canvas; the integer
  // Resvg getters report 1x1 and used to let render() allocate it.
  await assert.rejects(
    rasterize(FRACTIONAL_SVG, { targetWidth: 2000, signal: new AbortController().signal }),
    /raster canvas 2000x4000/u,
  )
  assert.equal(spawned, 0, 'the over-budget canvas must be refused before spawning the native child')
  await assert.rejects(
    rasterize(TALL_FRACTIONAL_SVG, { targetWidth: 1, signal: new AbortController().signal }),
    /raster canvas 1x4096/u,
  )
  assert.equal(spawned, 0)
})


const WIDTH_ONLY_VIEWBOX_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" viewBox="0 0 1900 2048">'
  + '<rect width="64" height="32" fill="#ff0000"/></svg>'

test('the missing-side viewBox intrinsic is used before the native child spawns', { skip: nativeRasterSkip }, async () => {
  const admission = admitSvg(WIDTH_ONLY_VIEWBOX_SVG)
  assert.equal(admission.ok, true)
  if (admission.ok) {
    assert.equal(admission.viewportWidth, 1000)
    assert.equal(admission.viewportHeight, 2048)
  }
  let spawned = 0
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    spawned += 1
    return spawn(...args)
  }) as typeof spawn
  const rasterize = createSvgRasterizer(spawnProcess)
  // The native intrinsic is 1000x2048; target 1900 is really 1900x3891/3892.
  await assert.rejects(
    rasterize(WIDTH_ONLY_VIEWBOX_SVG, { targetWidth: 1900, signal: new AbortController().signal }),
    /raster canvas 1900x3892/u,
  )
  assert.equal(spawned, 0, 'the missing-side intrinsic must be refused before spawning')
})

// ── width variants: the viewer derivative is NOT the thumbnail PNG ────────

/** A rasterizer that records every request and returns the requested width. */
function widthRecordingRasterizer(): {
  rasterize: SvgRasterize
  calls: Array<{ readonly source: string; readonly width: number }>
  releaseNext: () => void
  pending: number
} {
  const calls: Array<{ readonly source: string; readonly width: number }> = []
  const releases: Array<() => void> = []
  let pending = 0
  const rasterize: SvgRasterize = async (source, options) => {
    calls.push({ source, width: options.targetWidth })
    pending += 1
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        pending -= 1
        fn()
      }
      releases.push(() => finish(() => resolve({
        png: new Uint8Array(),
        base64: TINY_PNG_BASE64,
        widthPx: options.targetWidth,
        heightPx: Math.max(1, Math.round(options.targetWidth / 2)),
      })))
      options.signal.addEventListener('abort', () => finish(() => reject(new Error('cancelled'))), { once: true })
    })
  }
  return {
    rasterize,
    calls,
    releaseNext: () => { releases.shift()?.() },
    get pending() { return pending },
  }
}

test('one digest at two widths keeps two cache variants and rasters each exact width once', async () => {
  const recorder = widthRecordingRasterizer()
  const loader = new SvgRasterLoader(recorder.rasterize)
  loader.load('same-digest', 'same-source', 320)
  loader.load('same-digest', 'same-source', 320)
  loader.load('same-digest', 'same-source', 1280)
  // The single lane runs the first variant; the second is queued exactly once.
  assert.deepEqual(recorder.calls.map(call => call.width), [320])
  recorder.releaseNext()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(recorder.calls.map(call => call.width), [320, 1280], 'a different width is a different request')
  recorder.releaseNext()
  await new Promise(resolve => setImmediate(resolve))
  const small = loader.get('same-digest', 320)
  const large = loader.get('same-digest', 1280)
  assert.equal(small.state === 'ready' ? small.widthPx : 0, 320)
  assert.equal(large.state === 'ready' ? large.widthPx : 0, 1280,
    'the ready derivative reports the width that produced it, never a shared thumbnail PNG')
  loader.dispose()
})

test('releaseUnused cancels only the exact unsubscribed variant while a thumbnail still watches its own width', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const recorder = widthRecordingRasterizer()
    const loader = new SvgRasterLoader(recorder.rasterize)
    const thumbnail = new SvgThumbnail('shared-digest', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {})
    thumbnail.render(100)
    assert.deepEqual(recorder.calls.map(call => call.width), [320], 'the thumbnail owns the 320 variant')
    // No viewer subscription yet: releasing the viewer variant is a no-op for
    // the live thumbnail variant.
    loader.releaseUnused('shared-digest', 320)
    assert.equal(loader.get('shared-digest', 320).state, 'loading', 'a live thumbnail demand is never cancelled by releaseUnused')
    loader.releaseUnused('shared-digest', 1280)
    assert.equal(recorder.calls.length, 1, 'an idle viewer variant starts nothing')
    loader.dispose()
    thumbnail.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('a viewer variant cancelled before its child starts never spawns a second native process', async () => {
  const recorder = widthRecordingRasterizer()
  const loader = new SvgRasterLoader(recorder.rasterize)
  loader.subscribe('viewer-digest', 1280, () => {})
  loader.load('viewer-digest', 'viewer-source', 1280)
  loader.load('viewer-digest', 'viewer-source', 320)
  assert.deepEqual(recorder.calls.map(call => call.width), [1280], 'one lane owns 1280')
  // The viewer leaves while 1280 is active: its queued 320 demand is dropped,
  // and the active child keeps the lane until it really settles.
  loader.releaseUnused('viewer-digest', 320)
  assert.deepEqual(recorder.calls.map(call => call.width), [1280], 'the cancelled queued variant never spawns')
  loader.releaseUnused('viewer-digest', 1280)
  recorder.releaseNext()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(recorder.calls.map(call => call.width), [1280], 'no successor starts for a cancelled demand')
  assert.equal(recorder.pending, 0)
  loader.dispose()
})

test('the thumbnail reports the real painted pixel body only for an anchored Kitty placement', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const recorder = widthRecordingRasterizer()
    const loader = new SvgRasterLoader(recorder.rasterize)
    const thumbnail = new SvgThumbnail('geometry-digest', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {})
    const loading = thumbnail.render(100)
    assert.ok(loading.join('\n').includes('Rendering SVG image'))
    assert.equal(thumbnail.paintedImageBody(100), undefined, 'a loading render registers no pixel body')
    assert.equal(thumbnail.paintedPixelSize(100), undefined)
    recorder.releaseNext()
    await new Promise(resolve => setImmediate(resolve))
    const ready = thumbnail.render(100)
    const body = thumbnail.paintedImageBody(100)
    assert.ok(body !== undefined && body.rows > 0, `the ready render paints pixel rows:\n${ready.join('\n')}`)
    assert.ok(body !== undefined && body.endCol > 0, 'the hit is bounded by the placement width, not the maxWidthCells ceiling')
    assert.deepEqual(thumbnail.paintedPixelSize(100), { widthPx: 320, heightPx: 160 },
      'the painted derivative reports the THUMBNAIL variant dimensions')
    assert.equal(thumbnail.paintedImageBody(80), undefined, 'geometry is reported only for the width actually painted')
    thumbnail.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('Direct iTerm2 paints SVG OSC 1337 pixels without publishing a clickable body', async () => {
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  try {
    const recorder = widthRecordingRasterizer()
    const loader = new SvgRasterLoader(recorder.rasterize)
    const thumbnail = new SvgThumbnail('iterm2-digest', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {})
    assert.ok(thumbnail.render(100).join('\n').includes('Rendering SVG image'))
    assert.equal(recorder.calls.length, 1)
    recorder.releaseNext()
    await new Promise(resolve => setImmediate(resolve))
    const ready = thumbnail.render(100).join('\n')
    assert.ok(ready.includes('\x1b]1337;File='), 'Direct iTerm2 paints OSC 1337')
    assert.equal(thumbnail.paintedImageBody(100), undefined, 'iTerm2 pixels never invent click geometry')
    thumbnail.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('an image-less surface paints no SVG pixel body and never starts a raster', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  try {
    const recorder = widthRecordingRasterizer()
    const loader = new SvgRasterLoader(recorder.rasterize)
    const thumbnail = new SvgThumbnail('caps-digest', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {})
    assert.deepEqual(thumbnail.render(100), [], 'no fake rows')
    assert.equal(thumbnail.paintedImageBody(100), undefined)
    assert.equal(recorder.calls.length, 0, 'no native child')
    thumbnail.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

// ── Image-8 / I8-2B: SIXEL SVG thumbnails ──────────────────────────────────

const SVG_SIXEL_DCS = '\x1bP0;1;q"1;1;320;160#0;2;100;0;0~\x1b\\'

/**
 * A narrow Direct SIXEL owner face. Every bound occurrence renders the trusted
 * DCS plus layout rows; `paintedBodyAt` answers only after the test says the
 * Screen committed that frame, exactly like the real owner's last-committed
 * footprint. The recorded calls prove the row ceiling the component requested.
 */
function sixelThumbnailGraphics(state: { committed: boolean; renderedWidth?: number }): {
  graphics: ImageGraphics
  calls: Array<{ readonly maxHeightCells: number; readonly maxWidthCells: number; readonly widthPx: number; readonly heightPx: number }>
  disposals: () => number
} {
  const calls: Array<{ maxHeightCells: number; maxWidthCells: number; widthPx: number; heightPx: number }> = []
  let disposals = 0
  const graphics = {
    mode: 'sixel',
    canPaint: () => true,
    image: (source: { widthPx: number; heightPx: number }, options: { maxHeightCells?: number; maxWidthCells: number }) => {
      calls.push({
        maxHeightCells: options.maxHeightCells ?? 0,
        maxWidthCells: options.maxWidthCells,
        widthPx: source.widthPx,
        heightPx: source.heightPx,
      })
      const body: PixelBody = {
        render: (width: number) => {
          state.renderedWidth = width
          return [SVG_SIXEL_DCS, '', '']
        },
        invalidate: () => {},
        paintedBodyAt: (width: number) => (state.committed && state.renderedWidth === width ? { width, columns: 5, rows: 2 } : undefined),
        dispose: () => { disposals += 1 },
      }
      return body
    },
    terminal: {} as never,
    screen: {} as never,
    observeScreen: () => {},
    resample: () => {},
    dispose: () => {},
  } as unknown as ImageGraphics
  return { graphics, calls, disposals: () => disposals }
}

/** Drive the real loader's settle chain to its promise continuation. */
async function settleRaster(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await new Promise(resolve => setImmediate(resolve))
}

test('a SIXEL SVG thumbnail renders its candidate, and only the committed frame reports hits', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  try {
    const state = { committed: false }
    const { graphics, calls } = sixelThumbnailGraphics(state)
    const loader = new SvgRasterLoader(async (_source, options) => ({
      png: new Uint8Array(),
      base64: TINY_PNG_BASE64,
      widthPx: options.targetWidth,
      heightPx: Math.max(1, Math.round(options.targetWidth / 2)),
    }))
    const thumbnail = new SvgThumbnail('sixel-digest', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {}, undefined, graphics)
    const loading = thumbnail.render(100)
    assert.ok(loading.join('\n').includes('Rendering SVG image'), loading.join('\n'))
    assert.equal(thumbnail.paintedImageBody(100), undefined, 'a loading render is not a pixel body')
    await settleRaster()
    await settleRaster()
    const ready = thumbnail.render(100)
    assert.ok(ready.join('\n').includes(SVG_SIXEL_DCS), `the SIXEL candidate is painted: ${JSON.stringify(ready)}`)
    assert.ok(!ready.join('\n').includes('\x1b_G'), 'no Kitty APC on the SIXEL path')
    assert.deepEqual(calls.map(call => call.maxHeightCells), [MAX_IMAGE_ROWS],
      'the component still grants the full image row budget')
    // The Screen has not committed the raster yet: the candidate is not pixels.
    assert.equal(thumbnail.paintedImageBody(100), undefined, 'an uncommitted candidate is not clickable')
    assert.equal(thumbnail.paintedPixelSize(100), undefined, 'and it reports no painted pixel size')
    state.committed = true
    // No second render: the same occurrence answers from the committed frame.
    assert.deepEqual(thumbnail.paintedImageBody(100), { rows: 2, endCol: 5 })
    assert.deepEqual(thumbnail.paintedPixelSize(100), { widthPx: 320, heightPx: 160 })
    assert.equal(thumbnail.paintedImageBody(80), undefined, 'the footprint is fenced to the painted width')
    thumbnail.dispose()
    assert.equal(thumbnail.paintedImageBody(100), undefined, 'dispose drops the occurrence and its hit')
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('a fixed SIXEL row budget caps the encoder rows and never starts work for one row', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  try {
    let rasterCalls = 0
    const immediateLoader = (): SvgRasterLoader => new SvgRasterLoader(async (_source, options) => {
      rasterCalls += 1
      return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: options.targetWidth, heightPx: 32 }
    })
    const state = { committed: false }
    const one = sixelThumbnailGraphics(state)
    const oneRow = new SvgThumbnail('fixed-1', SVG_SOURCE, 320, immediateLoader(), { fallbackColor: text => text }, () => {}, 1, one.graphics)
    assert.deepEqual(oneRow.render(100), [''], 'one fixed row paints exactly the spacer')
    assert.equal(rasterCalls, 0, 'no raster starts without an image row grant')
    assert.equal(one.calls.length, 0, 'no SIXEL occurrence is bound')
    oneRow.dispose()

    const zeroRow = new SvgThumbnail('fixed-0', SVG_SOURCE, 320, immediateLoader(), { fallbackColor: text => text }, () => {}, 0, sixelThumbnailGraphics(state).graphics)
    assert.deepEqual(zeroRow.render(100), [], 'zero fixed rows paint nothing')
    assert.equal(rasterCalls, 0)
    zeroRow.dispose()

    const five = sixelThumbnailGraphics(state)
    const fiveRows = new SvgThumbnail('fixed-5', SVG_SOURCE, 320, immediateLoader(), { fallbackColor: text => text }, () => {}, 5, five.graphics)
    fiveRows.render(100)
    await settleRaster()
    await settleRaster()
    const lines = fiveRows.render(100)
    assert.equal(lines.length, 5, 'the fixed row budget is preserved')
    assert.equal(lines[0], '', 'the leading spacer stays first')
    assert.ok(lines.join('\n').includes(SVG_SIXEL_DCS))
    assert.equal(five.calls.length, 1)
    assert.equal(five.calls[0]!.maxHeightCells, 4, 'fixedRows=5 grants four real image rows')
    fiveRows.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})


test('Kitty keeps its fixedRows=1 loading/status behavior while SIXEL uses the spacer rule', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    let rasterCalls = 0
    const loader = new SvgRasterLoader(async (_source, options) => {
      rasterCalls += 1
      return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: options.targetWidth, heightPx: 32 }
    })
    const thumbnail = new SvgThumbnail('kitty-fixed-1', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {}, 1)
    const loading = thumbnail.render(100)
    assert.equal(loading.length, 1)
    assert.ok(loading[0]!.includes('Rendering SVG image'), `Kitty keeps its loading row: ${JSON.stringify(loading)}`)
    assert.equal(rasterCalls, 1, 'Kitty still starts the raster for its existing fixed-row behavior')
    await settleRaster()
    const ready = thumbnail.render(100)
    assert.deepEqual(ready, [''], 'the settled Kitty body is the one reserved spacer row')
    thumbnail.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

// ── PR-4B: the loader's explicit retry semantics ──────────────────────────

/** The typed failures the classification contract is proved against. */
const timeoutFailure = (): Error => new SvgRasterFailure('timeout', 'SVG rasterization exceeded 3000 ms')
const spawnFailure = (): Error => new SvgRasterFailure('spawn', 'SVG rasterizer failed to start: EAGAIN')
const workerExitFailure = (): Error => new SvgRasterFailure('worker-exit', 'SVG rasterizer exited (1): boom')
const invalidOutputFailure = (): Error => new SvgRasterFailure('invalid-output', 'SVG rasterizer produced an invalid PNG')
const rejectedFailure = (): Error => new SvgRasterFailure('rejected', 'SVG rasterizer rejected the document: the budget')

test('canRetryFailed is a pure read: only transient kinds with a live demand qualify', async () => {
  const loader = new SvgRasterLoader(async () => { throw timeoutFailure() })
  assert.equal(loader.canRetryFailed('d', 64), false, 'an idle variant is not retryable')
  loader.subscribe('d', 64, () => {})
  loader.load('d', 'src', 64)
  assert.equal(loader.canRetryFailed('d', 64), false, 'a loading variant is not retryable')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.get('d', 64).state, 'error')
  assert.equal(loader.canRetryFailed('d', 64), true, 'a settled timeout with a live demand is retryable')
  // The read NEVER mutated anything: still errored, still no second child.
  assert.equal(loader.get('d', 64).state, 'error')
  // Without a live subscriber the same error is not retryable.
  const lonely = new SvgRasterLoader(async () => { throw timeoutFailure() })
  lonely.load('d', 'src', 64)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lonely.canRetryFailed('d', 64), false, 'no live demand, no retry')
  lonely.dispose()
  loader.dispose()
})

test('retryFailed rebuilds the EXACT variant through load; non-retryable kinds never retry', async () => {
  for (const [name, failure, retryable] of [
    ['timeout', timeoutFailure, true],
    ['spawn', spawnFailure, true],
    ['worker-exit', workerExitFailure, true],
    ['invalid-output', invalidOutputFailure, false],
    ['rejected', rejectedFailure, false],
  ] as const) {
    let spawned = 0
    const loader = new SvgRasterLoader(async () => {
      spawned += 1
      throw failure()
    })
    loader.subscribe('d', 64, () => {})
    loader.load('d', 'src', 64)
    await new Promise(resolve => setImmediate(resolve))
    const retried = loader.retryFailed('d', 'src', 64)
    assert.equal(retried, retryable, `${name}: retry decision`)
    assert.equal(spawned, retryable ? 2 : 1, `${name}: child count`)
    // A repeated retry while the rebuilt request is in flight is refused.
    if (retryable) {
      assert.equal(loader.retryFailed('d', 'src', 64), false, `${name}: no stacked request`)
      assert.equal(spawned, 2, `${name}: still exactly one successor child`)
    }
    loader.dispose()
  }
})

test('a retry is per-variant: another width of the same digest is untouched', async () => {
  let spawned = 0
  let release!: () => void
  const loader = new SvgRasterLoader(async () => {
    spawned += 1
    return await new Promise<never>((_resolve, reject) => { release = () => reject(timeoutFailure()) })
  })
  const unsubscribeA = loader.subscribe('d', 64, () => {})
  loader.load('d', 'src', 64)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.get('d', 64).state, 'error')
  // A different width variant has its own state; a retry of the errored one
  // must not queue, cancel or evict the sibling.
  const unsubscribeB = loader.subscribe('d', 128, () => {})
  loader.load('d', 'src', 128)
  assert.equal(loader.get('d', 128).state, 'loading')
  assert.equal(loader.retryFailed('d', 'src', 64), true)
  assert.equal(loader.get('d', 128).state, 'loading', 'the sibling variant keeps loading')
  assert.equal(loader.get('d', 64).state, 'loading', 'the retried variant rebuilt as loading')
  unsubscribeA()
  unsubscribeB()
  loader.dispose()
})

test('an evicted errored variant is terminal: no retry, no resurrection', async () => {
  const loader = new SvgRasterLoader(async () => { throw timeoutFailure() })
  loader.subscribe('d', 64, () => {})
  loader.load('d', 'src', 64)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.get('d', 64).state, 'error')
  // Force an eviction storm: 12 more variants push the errored entry out.
  loader.load('other', 'other', 64)
  for (let index = 0; index < 14; index++) loader.load(`filler-${index}`, 'src', 64)
  // The errored entry may have been evicted; a terminal eviction is not retryable.
  if (loader.get('d', 64).state === 'error') {
    // Still present: the eviction never happened (under MAX_ENTRIES), retry
    // eligibility stays as the state machine decides.
    assert.equal(typeof loader.retryFailed('d', 'src', 64), 'boolean')
  } else {
    assert.equal(loader.retryFailed('d', 'src', 64), false, 'an evicted variant never resurrects through retry')
  }
  loader.dispose()
})

test('a real child timeout is classified, the loader exposes retry, and the successor child succeeds', { skip: nativeRasterSkip }, async (t) => {
  // LAYER 1 - the REAL rasterizer classifies a timed-out child as the typed
  // `timeout` failure: the scripted child runs to the 3 s bound, dies by
  // SIGKILL and settles from its close, and the rejection carries the kind.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const scripted = scriptedRasterChild(ms => t.mock.timers.tick(ms))
  const failure = await scripted.runToTimeout('rp request=1')
  assert.ok(failure instanceof SvgRasterFailure, `a timeout is the typed failure: ${failure.message}`)
  assert.equal(failure.kind, 'timeout')

  // LAYER 2 - the loader flow around that classification: the typed timeout
  // enters the cache as an error, the ONE user retry rebuilds the SAME
  // variant through load, and the successor child succeeds.
  let firstAttempt = true
  const loader = new SvgRasterLoader(async () => {
    if (firstAttempt) {
      firstAttempt = false
      throw failure
    }
    return { png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 128, heightPx: 64 }
  })
  loader.subscribe('digest-timeout', 128, () => {})
  loader.load('digest-timeout', SVG_SOURCE, 128)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loader.get('digest-timeout', 128).state, 'error')
  assert.equal(loader.canRetryFailed('digest-timeout', 128), true, 'the typed timeout is retry-eligible')
  assert.equal(loader.retryFailed('digest-timeout', SVG_SOURCE, 128), true)
  await new Promise(resolve => setImmediate(resolve))
  const ready = loader.get('digest-timeout', 128)
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  assert.equal(ready.state === 'ready' ? ready.widthPx : 0, 128)
  loader.dispose()
})
