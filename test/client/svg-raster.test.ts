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
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { rasterizeSvg } from '../../src/client/media/svg/rasterize.ts'

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
  assert.deepEqual(loader.get('digest-a'), { state: 'idle' })
  let notifications = 0
  const unsubscribe = loader.subscribe('digest-a', () => { notifications += 1 })
  loader.load('digest-a', 'source-a', 128)
  loader.load('digest-a', 'source-a', 128)
  assert.equal(loader.get('digest-a').state, 'loading')
  assert.equal(rasterCalls, 1, 'concurrent loads are deduped')
  release({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })
  await new Promise(resolve => setImmediate(resolve))
  const ready = loader.get('digest-a')
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
  assert.deepEqual(loader.get('digest-b'), { state: 'idle' })
  release({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(loader.get('digest-b'), { state: 'idle' }, 'a cleared epoch never stores a late result')
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


test('the loader runs ONE global raster at a time across different digests', async () => {
  let active = 0
  let maxActive = 0
  const releases: Array<() => void> = []
  const loader = new SvgRasterLoader(async (_source, options) => {
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
  for (let index = 0; index < 13; index += 1) loader.load(`digest-${index}`, `source-${index}`, 128)
  assert.equal(maxActive, 1, 'different digests must never spawn concurrent native rasterizations')
  // The 13th load evicts the ACTIVE oldest entry; its aborted rejection must
  // not resurrect the evicted digest as an error entry.
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(loader.get('digest-0'), { state: 'idle' }, 'an evicted settlement must not commit')
  while (releases.length > 0) {
    releases.shift()?.()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(maxActive, 1, 'the single lane stays bounded while the queue drains')
  loader.dispose()
})

test('an evicted digest can be reloaded and its old settlement cannot overwrite the new one', async () => {
  const releases: Array<() => void> = []
  const loader = new SvgRasterLoader(async (_source, options) => {
    return await new Promise((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        finish()
      }
      releases.push(() => settle(() => resolve({ png: new Uint8Array(), base64: TINY_PNG_BASE64, widthPx: 1, heightPx: 1 })))
      options.signal.addEventListener('abort', () => settle(() => reject(new Error('cancelled'))), { once: true })
    })
  })
  for (let index = 0; index < 13; index += 1) loader.load(`digest-${index}`, `source-${index}`, 128)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(loader.get('digest-0'), { state: 'idle' })
  // Reload the evicted digest while the old (aborted) request is still in
  // flight; the old rejection must not overwrite the new loading/ready entry.
  loader.load('digest-0', 'source-0', 128)
  assert.equal(loader.get('digest-0').state, 'loading')
  while (releases.length > 0) {
    releases.shift()?.()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.notEqual(loader.get('digest-0').state, 'error', 'the old settlement must never win over the reload')
  loader.dispose()
})
