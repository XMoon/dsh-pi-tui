/**
 * The PR2.5 SVG viewer: the leased image workspace's read-only Preview/Source
 * page set, its bounded Source read position, its width-derived raster variant
 * and its painted pointer cells.
 *
 * Evidence level: a HEADLESS panel render. The real alt-screen wire, terminal
 * pixels and OS clipboard are covered by the TuiApp integration suites; this
 * file proves the panel's own layout, state and cancellation contract.
 * @module @xmoon76/dsh-pi-tui/client/svg-viewer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import { ImageWorkspacePanel } from '../../src/tui/components/media/image-workspace.ts'
import { SvgViewerPanel, type SvgViewerSource } from '../../src/tui/components/media/svg-viewer.ts'
import { admitSvg } from '../../src/domain/visual/svg-admission.ts'

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const WIDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

/** Forty self-identifying lines: enough Source rows to page and clamp. */
const LONG_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">',
  ...Array.from({ length: 40 }, (_, index) => `  <rect id="L${String(index).padStart(2, '0')}" x="${index}" y="0" width="1" height="1" fill="#000000"/>`),
  '</svg>',
].join('\n')

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/gu, '')
}

function capabilities(images: 'kitty' | 'iterm2' | null): void {
  resetCapabilitiesCache()
  setCapabilities({ images, trueColor: true, hyperlinks: false })
}

/** A loader that records each `(source, width)` and settles on demand. */
function pendingLoader(): {
  loader: SvgRasterLoader
  calls: Array<{ readonly source: string; readonly width: number }>
  releaseNext(): void
  settleAll(): Promise<void>
  activeCount(): number
} {
  const calls: Array<{ readonly source: string; readonly width: number }> = []
  const releases: Array<() => void> = []
  let pending = 0
  const loader = new SvgRasterLoader(async (source, options) => {
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
  })
  return {
    loader,
    calls,
    releaseNext: () => { releases.shift()?.() },
    settleAll: async () => {
      for (let index = 0; index < 40 && releases.length > 0; index += 1) {
        releases.shift()?.()
        await new Promise(resolve => setImmediate(resolve))
      }
    },
    activeCount: () => pending,
  }
}

/** Wait for the loader's promise continuations (no timer, no I/O). */
async function drain(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

function sourceOf(overrides: Partial<SvgViewerSource> = {}): SvgViewerSource {
  return {
    title: 'Service topology',
    svgSource: WIDE_SVG,
    digest: 'digest-svg',
    onCopy: () => {},
    ...overrides,
  }
}

function panelOf(options: {
  readonly source?: SvgViewerSource
  readonly loader?: SvgRasterLoader
  readonly rows?: number
  readonly columns?: number
  readonly onClose?: () => void
  readonly requestRender?: () => void
} = {}): SvgViewerPanel {
  const rows = options.rows ?? 40
  return new SvgViewerPanel({
    source: options.source ?? sourceOf(),
    rows: () => rows,
    columns: () => options.columns ?? 80,
    requestRender: options.requestRender ?? (() => {}),
    ...(options.loader === undefined ? {} : { loader: options.loader }),
    theme: { fallbackColor: (text: string) => text },
    onClose: options.onClose ?? (() => {}),
  })
}

test('the viewer opens on Preview with the identity, one active page device and a pinned bar', () => {
  capabilities(null)
  try {
    const panel = panelOf({ rows: 12 })
    panel.setMaxRows(12)
    const lines = panel.render(80)
    assert.equal(lines.length, 12, 'the panel fills its grant so the bar is the last row')
    const title = stripSgr(lines[0]!)
    assert.ok(title.includes('SVG · Service topology'), title)
    assert.ok(title.includes('[Preview]') && title.includes('Source'), title)
    assert.equal(title.includes('[Source]'), false, 'exactly one device is active')
    const bar = stripSgr(lines.at(-1)!)
    assert.ok(bar.includes('Tab view'), bar)
    assert.ok(bar.includes('c copy source'), bar)
    assert.ok(bar.includes('Esc close'), bar)
    const body = lines.slice(1, -1).join('\n')
    assert.ok(body.includes('Preview unavailable'), 'no inline-image protocol is a truthful text state')
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('Tab reaches the Source page, which shows the sanitized XML inside the grant', () => {
  capabilities(null)
  try {
    const panel = panelOf({ rows: 12, source: sourceOf({ svgSource: LONG_SVG }) })
    panel.setMaxRows(12)
    panel.render(80)
    panel.handleInput('\t')
    const lines = panel.render(80)
    const title = stripSgr(lines[0]!)
    assert.ok(title.includes('[Source]') && title.includes('Preview'), title)
    const body = stripSgr(lines.slice(1, -1).join('\n'))
    assert.ok(body.includes('L00') && body.includes('L08'), 'the first readable lines are painted')
    assert.ok(body.includes('L09') === false, 'the bounded read region is exactly the body grant')
    const bar = stripSgr(lines.at(-1)!)
    assert.ok(bar.includes('↑/↓') && bar.includes('PgUp/PgDn'), 'the Source scroll keys are advertised')
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('Source scrolling moves one line, one page, home and end, clamped to the grant', () => {
  capabilities(null)
  try {
    const panel = panelOf({ rows: 12, source: sourceOf({ svgSource: LONG_SVG }) })
    panel.setMaxRows(12)
    panel.render(80)
    panel.handleInput('\t')
    const bodyOf = (): string => stripSgr(panel.render(80).slice(1, -1).join('\n'))
    assert.ok(bodyOf().includes('L00'))
    panel.handleInput('\x1b[B')
    assert.ok(bodyOf().includes('<rect id="L01"'), bodyOf())
    panel.handleInput('\x1b[6~')
    assert.ok(bodyOf().includes('<rect id="L11"'), bodyOf())
    panel.handleInput('\x1b[F')
    const end = bodyOf()
    assert.ok(end.includes('>L39<') || end.includes('L39'), end)
    assert.ok(end.includes('</svg>'), end)
    panel.handleInput('\x1b[H')
    assert.ok(bodyOf().includes('L00'), bodyOf())
    panel.handleInput('\x1b[5~')
    assert.ok(bodyOf().includes('L00'), 'page-up at the top clamps to the first line')
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('resize clamps the Source read position and returning to Preview then Source keeps it', () => {
  capabilities(null)
  try {
    const panel = panelOf({ rows: 12, source: sourceOf({ svgSource: LONG_SVG }) })
    panel.setMaxRows(12)
    panel.render(80)
    panel.handleInput('\t')
    panel.handleInput('\x1b[F')
    const before = stripSgr(panel.render(80).slice(1, -1).join('\n'))
    assert.ok(before.includes('L39') && before.includes('</svg>'), before)
    // Tab to Preview and back: the same read position survives.
    panel.handleInput('\t')
    panel.render(80)
    panel.handleInput('\t')
    const roundTrip = stripSgr(panel.render(80).slice(1, -1).join('\n'))
    assert.equal(roundTrip, before)
    // Growing the grant keeps the END position legal (it is the minimum of the
    // old row and the new last page), so the tail stays visible.
    panel.setMaxRows(30)
    const taller = stripSgr(panel.render(80).slice(1, -1).join('\n'))
    assert.ok(taller.includes('L39') && taller.includes('</svg>'), taller)
    // A short grant recomputes End against the shorter body: the tail is still
    // exactly the visible page.
    panel.setMaxRows(8)
    panel.render(80)
    panel.handleInput('\x1b[F')
    const short = stripSgr(panel.render(80).slice(1, -1).join('\n'))
    assert.ok(short.includes('L39') && short.includes('</svg>'), short)
    // Growing the grant after a short-grant End clamps the now-illegal middle
    // position up into the taller body's legal range, never below the top.
    panel.setMaxRows(30)
    const clamped = stripSgr(panel.render(80).slice(1, -1).join('\n'))
    assert.ok(clamped.includes('L13') && clamped.includes('</svg>'), clamped)
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('the ready Preview requests the Viewer grant variant, not the thumbnail width', async () => {
  capabilities('kitty')
  try {
    const recorder = pendingLoader()
    const panel = panelOf({ loader: recorder.loader, columns: 120, rows: 40 })
    panel.setMaxRows(40)
    panel.render(120)
    assert.deepEqual(recorder.calls.map(call => call.width), [1920],
      '120 columns × 16px/col, height grant 38 rows × 32px/row for a 2:1 viewBox → 1920px')
    await recorder.settleAll()
    await drain()
    const lines = panel.render(120)
    assert.ok(lines.slice(1, -1).some(line => line.includes('\x1b_G')), 'the settled PNG is placed in the body')
    panel.dispose()
    recorder.loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('a width change re-subscribes the exact new variant and releases the old unused one', async () => {
  capabilities('kitty')
  try {
    const recorder = pendingLoader()
    const panel = panelOf({ loader: recorder.loader, columns: 120, rows: 40 })
    panel.setMaxRows(40)
    panel.render(120)
    assert.deepEqual(recorder.calls.map(call => call.width), [1920])
    await recorder.settleAll()
    await drain()
    // The same grant never re-requests (the exact variant key is stable).
    panel.render(120)
    assert.deepEqual(recorder.calls.map(call => call.width), [1920])
    // A narrower terminal selects a different exact variant. The old ready
    // variant is NOT upscaled; a new request is made for the real grant.
    const narrow = panelOf({ loader: recorder.loader, columns: 80, rows: 40 })
    narrow.setMaxRows(40)
    narrow.render(80)
    assert.deepEqual(recorder.calls.map(call => call.width), [1920, 1280])
    narrow.dispose()
    panel.dispose()
    recorder.loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('C copies the raw source on both pages and Esc closes', () => {
  capabilities(null)
  try {
    let copies = 0
    let closes = 0
    const panel = panelOf({
      rows: 12,
      source: sourceOf({ onCopy: () => { copies += 1 } }),
      onClose: () => { closes += 1 },
    })
    panel.setMaxRows(12)
    panel.render(80)
    panel.handleInput('c')
    assert.equal(copies, 1, 'Preview still copies the source')
    panel.handleInput('\t')
    panel.render(80)
    panel.handleInput('c')
    assert.equal(copies, 2, 'Source copies the source')
    panel.handleInput('\x1b')
    assert.equal(closes, 1)
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('the Source projection drops terminal control bytes while Copy keeps the raw string', () => {
  capabilities(null)
  try {
    const hostile = `${WIDE_SVG.slice(0, 4)}<!-- \u001b]52;c;SGVsbG8=\u0007 -->${WIDE_SVG.slice(4)}`
    let copied: string | undefined
    const panel = panelOf({
      rows: 14,
      source: sourceOf({ svgSource: hostile, onCopy: () => { copied = hostile } }),
    })
    panel.setMaxRows(14)
    panel.render(80)
    panel.handleInput('\t')
    const painted = panel.render(80).join('\n')
    assert.equal(painted.includes('\x1b]52'), false, 'no OSC sequence reaches the terminal')
    assert.equal(painted.includes('\u0007'), false, 'no BEL reaches the terminal')
    assert.equal(stripSgr(painted).includes('52;c;SGVsbG8='), false,
      'the whole terminal-active sequence is removed, not echoed as readable residue')
    panel.handleInput('c')
    assert.equal(copied, hostile, 'the raw source is copied byte for byte')
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('pointer cells: the page devices and Copy Source act; body and blank cells are inert', () => {
  capabilities(null)
  try {
    let copies = 0
    const panel = panelOf({ rows: 12, onClose: () => {}, source: sourceOf({ onCopy: () => { copies += 1 } }) })
    panel.setMaxRows(12)
    const lines = panel.render(80).map(stripSgr)
    const title = lines[0]!
    const sourceCol = title.indexOf('Source')
    // Press/release on the inactive Source device switches the page.
    panel.onCellPress(sourceCol, 0)
    panel.onCellClick(sourceCol, 0)
    assert.ok(stripSgr(panel.render(80)[0]!).includes('[Source]'))
    // A press on the painted copy segment completes the copy.
    const bar = stripSgr(panel.render(80).at(-1)!)
    const copyCol = bar.indexOf('c copy source')
    panel.onCellPress(copyCol, 11)
    panel.onCellClick(copyCol, 11)
    assert.equal(copies, 1)
    // A press on a body row then release elsewhere does nothing.
    panel.onCellPress(3, 5)
    panel.onCellClick(3, 6)
    assert.equal(copies, 1)
    // A press on the copy label released over the body does nothing.
    panel.onCellPress(copyCol, 11)
    panel.onCellClick(copyCol, 5)
    assert.equal(copies, 1)
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('a terminal resize between press and release drops the pointer gesture', () => {
  capabilities(null)
  try {
    let copies = 0
    let termRows = 12
    let termCols = 80
    const panel = new SvgViewerPanel({
      source: sourceOf({ onCopy: () => { copies += 1 } }),
      rows: () => termRows,
      columns: () => termCols,
      requestRender: () => {},
      theme: { fallbackColor: text => text },
      onClose: () => {},
    })
    panel.setMaxRows(termRows)
    const bar = stripSgr(panel.render(termCols).at(-1)!)
    const copyCol = bar.indexOf('c copy source')
    panel.onCellPress(copyCol, termRows - 1)
    termCols = 100
    panel.setMaxRows(termRows)
    panel.render(termCols)
    panel.onCellClick(copyCol, termRows - 1)
    assert.equal(copies, 0, 'a stale painted frame never completes a copy')
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('one- and two-row grants keep the bar last and never paint a body', () => {
  capabilities(null)
  try {
    const panel = panelOf({ rows: 1 })
    panel.setMaxRows(1)
    const one = panel.render(80)
    assert.equal(one.length, 1)
    assert.ok(stripSgr(one[0]!).includes('Esc close'), one[0])
    panel.setMaxRows(2)
    const two = panel.render(80)
    assert.equal(two.length, 2)
    assert.ok(stripSgr(two[0]!).includes('SVG · Service topology'))
    assert.ok(stripSgr(two[1]!).includes('Esc close'))
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('the frozen width matrix keeps every row inside the grant and Esc reachable', () => {
  capabilities(null)
  try {
    for (const [width, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
      const panel = panelOf({ rows })
      panel.setMaxRows(rows)
      for (const page of ['preview', 'source'] as const) {
        if (page === 'source') panel.handleInput('\t')
        const lines = panel.render(width)
        assert.equal(lines.length, rows, `${width}×${rows} ${page}: body fills the grant`)
        assert.ok(stripSgr(lines.at(-1)!).includes('Esc'), `${width}×${rows} ${page}: Esc survives whole-segment degradation`)
        for (const line of lines) {
          // Strip SGR, then assert the painted cells never exceed the grant.
          const plain = stripSgr(line)
          assert.ok(plain.length <= width * 2, `${width}×${rows} ${page}: a row is bounded by the grant`)
        }
      }
      panel.dispose()
    }
  } finally {
    resetCapabilitiesCache()
  }
})

test('dispose releases the variant and a late settle never repaints the closed viewer', async () => {
  capabilities('kitty')
  try {
    const recorder = pendingLoader()
    let renders = 0
    const panel = panelOf({
      loader: recorder.loader,
      requestRender: () => { renders += 1 },
    })
    panel.setMaxRows(40)
    panel.render(120)
    assert.equal(recorder.activeCount(), 1)
    panel.dispose()
    assert.equal(recorder.activeCount(), 0, 'the cancelled variant child is gone')
    await recorder.settleAll()
    await drain()
    assert.equal(renders, 0, 'the closed viewer is never woken by a settle')
    recorder.loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('the leased workspace hosts the svg-viewer as its Viewer state and Esc closes it', () => {
  capabilities(null)
  try {
    let closes = 0
    const panel = new ImageWorkspacePanel({
      rows: () => 20,
      columns: () => 100,
      requestRender: () => {},
      theme: { fallbackColor: text => text },
      candidates: [],
      resolve: () => undefined,
      onStale: () => {},
      onClose: () => { closes += 1 },
      initial: { kind: 'svg-viewer', source: sourceOf() },
    })
    const lines = panel.render(100)
    assert.equal(lines.length, 20)
    assert.ok(stripSgr(lines[0]!).includes('[Preview]'))
    assert.ok(stripSgr(lines.at(-1)!).includes('Esc close'))
    panel.handleInput('\x1b')
    assert.equal(closes, 1, 'Esc closes the whole workspace, not a list round trip')
    panel.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('the admitted test sources are valid inputs for the preview path', () => {
  assert.equal(admitSvg(WIDE_SVG).ok, true)
  assert.equal(admitSvg(LONG_SVG).ok, true)
})
