/**
 * PR-D: the Client-local SVG raster cache and its isolated child rasterizer.
 *
 * The cache owns dedupe, settle notification and the stale-generation fence;
 * the rasterizer owns the OS process boundary and the PNG budget checks. The
 * real raster test uses the pinned `@resvg/resvg-js` platform binary and the
 * same safe source the chart/SVG cards use.
 * @module @xmoon76/dsh-pi-tui/svg-raster.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { createSvgRasterizer, rasterizeSvg, type SvgRasterize } from '../../src/client/media/svg/rasterize.ts'
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

const nativeRasterSkip = process.platform === 'linux'
  ? false
  : 'the native memory cap is verified on Linux only; other platforms use the text/source fallback'

test('the real isolated rasterizer produces a bounded PNG for an admitted source', { skip: nativeRasterSkip }, async () => {
  const result = await rasterizeSvg(SVG_SOURCE, { targetWidth: 128, signal: new AbortController().signal })
  assert.equal(result.widthPx, 128)
  assert.equal(result.heightPx, 64)
  assert.deepEqual([...result.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(result.png.length > 0)
  assert.equal(Buffer.from(result.base64, 'base64').length, result.png.length)
})

test('an already-aborted raster request is refused before work starts', { skip: nativeRasterSkip }, async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(rasterizeSvg(SVG_SOURCE, { targetWidth: 128, signal: controller.signal }), /cancelled/u)
})

test('a raster child that outlives the 3 s bound is classified as a timeout after its real close', { skip: nativeRasterSkip }, async () => {
  // The ONE hard-timeout path, measured on a REAL child: a process that never
  // answers, the SIGKILL at the shared `SVG_RASTER_TIMEOUT_MS` bound, and a
  // promise that settles only after `close`. This is the event-order evidence
  // for the `SVG rasterization exceeded 3000 ms` failure class; it does not
  // change the production budget.
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
  await assert.rejects(
    rasterize(SVG_SOURCE, { targetWidth: 128, signal: new AbortController().signal }),
    /SVG rasterization exceeded 3000 ms/u,
  )
  events.push('settled')
  const elapsed = Date.now() - started
  assert.deepEqual(events, ['spawn', 'exit:SIGKILL', 'close:SIGKILL', 'settled'],
    'the failure settles from the real child close, never from the timer alone')
  assert.ok(elapsed >= 3000, `the shared hard timeout really elapsed: ${elapsed} ms`)
  assert.ok(elapsed < 10_000, `the failure is bounded by the raster budget, not a 30 s wait: ${elapsed} ms`)
  assert.equal(child?.signalCode, 'SIGKILL', 'the child process is really gone before the promise settles')
  assert.equal(child?.exitCode, null)
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

test('the native canvas budget is checked before render() allocates', { skip: nativeRasterSkip }, async () => {
  const admission = admitSvg(ASPECT_MISMATCH_SVG)
  assert.equal(admission.ok, true, 'the source itself is admitted')
  if (admission.ok) {
    assert.equal(admission.width, 2048)
    assert.equal(admission.height, 64)
  }
  // The rendered viewport is 1:4, so targetWidth 2048 becomes 2048x8192: the
  // worker must refuse the real canvas before render()/asPng allocation.
  await assert.rejects(
    rasterizeSvg(ASPECT_MISMATCH_SVG, { targetWidth: 2048, signal: new AbortController().signal }),
    /raster canvas 2048x8192/u,
  )
  // A target that fits the same aspect still renders normally.
  const small = await rasterizeSvg(ASPECT_MISMATCH_SVG, { targetWidth: 128, signal: new AbortController().signal })
  assert.equal(small.widthPx, 128)
  assert.equal(small.heightPx, 512)
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
  const small = await rasterize(FRACTIONAL_SVG, { targetWidth: 128, signal: new AbortController().signal })
  assert.equal(small.widthPx, 128)
  assert.equal(small.heightPx, 256)
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
  const small = await rasterize(WIDTH_ONLY_VIEWBOX_SVG, { targetWidth: 128, signal: new AbortController().signal })
  assert.equal(small.widthPx, 128)
  assert.ok(small.heightPx === 262 || small.heightPx === 263, `safe target height ${small.heightPx}`)
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

test('an iTerm2 or image-less surface paints no SVG pixel body and never starts a raster', () => {
  for (const images of ['iterm2', null] as const) {
    setCapabilities({ images, trueColor: true, hyperlinks: false })
    const recorder = widthRecordingRasterizer()
    const loader = new SvgRasterLoader(recorder.rasterize)
    const thumbnail = new SvgThumbnail('caps-digest', SVG_SOURCE, 320, loader, { fallbackColor: text => text }, () => {})
    assert.deepEqual(thumbnail.render(100), [], `${String(images)}: no fake rows`)
    assert.equal(thumbnail.paintedImageBody(100), undefined)
    assert.equal(recorder.calls.length, 0, `${String(images)}: no native child`)
    thumbnail.dispose()
    loader.dispose()
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
