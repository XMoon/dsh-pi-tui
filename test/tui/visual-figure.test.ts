/**
 * The inline published-visual figure: its action row, its selected device, its
 * painted cell geometry and its SVG thumbnail pixel-body eligibility.
 *
 * Evidence level: a component render. The press/release owner, the leased
 * viewer and the clipboard sink are proven by the TuiApp integration suites.
 * @module @xmoon76/dsh-pi-tui/tui/visual-figure.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { SvgRasterLoader } from '../../src/client/media/svg/raster-loader.ts'
import type { ChartFact } from '../../src/domain/visual/chart.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'
import { VisualFigureComponent } from '../../src/tui/components/transcript/visual-figure.ts'
import { color } from '../../src/tui/theme/runtime.ts'
import type { ImageGraphics, PixelBody } from '../../src/tui/graphics/native-image.ts'

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

const REF = `sv1_${'a'.repeat(20)}`

const CHART: ChartFact = {
  version: 1,
  type: 'chart',
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}

function chartPublication(): PublishedVisual {
  return {
    ref: REF,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: 'present-chart',
    source: {
      ref: REF,
      type: 'chart',
      title: CHART.title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: 'chart-source',
      chart: CHART,
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

function svgPublication(): PublishedVisual {
  return {
    ref: REF,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: 'present-svg',
    source: {
      ref: REF,
      type: 'svg',
      title: 'Service topology',
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: 'svg-source',
      chart: undefined,
      svg: {
        version: 1,
        type: 'svg',
        title: 'Service topology',
        description: 'Gateway -> App -> Database',
        digest: 'digest-svg',
        bytes: SVG_SOURCE.length,
      },
      svgSource: SVG_SOURCE,
      svgAdmissionWidth: 64,
    },
  }
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/gu, '')
}

function figureOf(
  publication: PublishedVisual,
  overrides: Partial<ConstructorParameters<typeof VisualFigureComponent>[0]> = {},
): VisualFigureComponent {
  return new VisualFigureComponent({
    publication,
    selected: () => false,
    paint: text => color.textDim(text),
    requestRender: () => {},
    onCopy: () => {},
    ...overrides,
  })
}

test('the chart figure keeps the exact values and appends one full Copy Data action row', () => {
  const figure = figureOf(chartPublication())
  const lines = figure.render(80)
  const painted = stripSgr(lines.join('\n'))
  assert.ok(painted.includes('Request latency') && painted.includes('42 ms') && painted.includes('70 ms'), painted)
  const actionRow = lines.findIndex(line => stripSgr(line).includes('Copy Data'))
  assert.ok(actionRow > lines.findIndex(line => stripSgr(line).includes('Request latency')),
    'the action row follows the existing chart body')
  const hits = figure.paintedHitMap(80)
  assert.ok(hits !== undefined)
  assert.equal(hits.height, lines.length)
  assert.deepEqual(hits.actions, [{ action: 'copy', row: actionRow, startCol: 0, endCol: 9 }])
  assert.equal(stripSgr(lines[actionRow]!).slice(0, 9), 'Copy Data')
  figure.dispose()
})

test('the SVG figure keeps description + actions, and only an ACTUAL pixel body becomes a View cell', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  try {
    const loader = new SvgRasterLoader(async () => ({
      png: new Uint8Array(),
      base64: TINY_PNG_BASE64,
      widthPx: 640,
      heightPx: 320,
    }))
    let views = 0
    const figure = figureOf(svgPublication(), {
      onView: () => { views += 1 },
      svgLoader: loader,
      svgTheme: { fallbackColor: text => text },
      svgAdmissionWidth: 640,
    })
    const loading = figure.render(100)
    const loadingPainted = stripSgr(loading.join('\n'))
    assert.ok(loadingPainted.includes('Service topology') && loadingPainted.includes('Gateway -> App -> Database'))
    assert.ok(loadingPainted.includes('View') && loadingPainted.includes('Copy SVG'))
    const loadingHits = figure.paintedHitMap(100)
    assert.ok(loadingHits !== undefined)
    assert.equal(loadingHits.thumbnailBody, undefined, 'a loading placeholder is not a pixel body')
    assert.equal(loadingHits.actions.length, 2)
    const loadingActions = loadingHits.actions.map(hit => stripSgr(loading[hit.row]!).slice(hit.startCol, hit.endCol))
    assert.deepEqual(loadingActions, ['View', 'Copy SVG'])

    for (let index = 0; index < 40; index += 1) await Promise.resolve()
    const ready = figure.render(100)
    const readyHits = figure.paintedHitMap(100)
    assert.ok(readyHits !== undefined && readyHits.thumbnailBody !== undefined,
      'the ready Kitty render registers its real pixel body')
    const body = readyHits.thumbnailBody!
    assert.ok(body.startRow < body.endRow)
    assert.ok(body.endCol > 0)
    assert.ok(ready[body.startRow]!.startsWith('\x1b_G'), 'the body starts at the anchored Kitty sequence')
    assert.equal(views, 0, 'a render alone never opens the viewer')
    figure.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('without a Kitty surface the SVG figure keeps description and actions but registers no pixel body', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  try {
    const loader = new SvgRasterLoader(async () => {
      throw new Error('the fallback path must not raster')
    })
    const figure = figureOf(svgPublication(), {
      onView: () => {},
      svgLoader: loader,
      svgTheme: { fallbackColor: text => text },
      svgAdmissionWidth: 640,
    })
    const lines = figure.render(44)
    const painted = stripSgr(lines.join('\n'))
    assert.ok(painted.includes('Service topology') && painted.includes('View') && painted.includes('Copy SVG'))
    const hits = figure.paintedHitMap(44)
    assert.ok(hits !== undefined)
    assert.equal(hits.thumbnailBody, undefined)
    // Both actions still have a complete, distinct hit cell at the 44-column
    // floor (the frozen matrix requires each to remain clickable).
    const spans = hits.actions.map(hit => ({
      label: stripSgr(lines[hit.row]!).slice(hit.startCol, hit.endCol),
      start: hit.startCol,
      end: hit.endCol,
    }))
    assert.deepEqual(spans.map(span => span.label), ['View', 'Copy SVG'])
    assert.ok(spans.every(span => span.end > span.start))
    figure.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})

test('the selected device is a painted word and shifts the action cells by its visible width', () => {
  const normal = figureOf(chartPublication())
  normal.render(80)
  const normalHits = normal.paintedHitMap(80)
  assert.ok(normalHits !== undefined)
  assert.equal(stripSgr(normal.render(80).join('\n')).includes('[Selected]'), false)

  const selected = figureOf(chartPublication(), { selected: () => true })
  const lines = selected.render(80)
  const painted = stripSgr(lines.join('\n'))
  assert.ok(painted.includes('[Selected]'), painted)
  assert.ok(painted.includes('Copy Data'))
  const hits = selected.paintedHitMap(80)
  assert.ok(hits !== undefined)
  assert.deepEqual(hits.actions, [{ action: 'copy', row: hits.actions[0]!.row, startCol: 11, endCol: 20 }])
  const row = stripSgr(lines[hits.actions[0]!.row]!)
  assert.equal(row.slice(0, 10), '[Selected]')
  assert.equal(row.slice(11, 20), 'Copy Data')
  normal.dispose()
  selected.dispose()
})

test('a narrow action row drops whole labels instead of painting half a button', () => {
  // `Copy SVG` is dropped before `View`; both survive at the 44-column floor.
  const wide = figureOf(svgPublication(), { onView: () => {} })
  assert.equal(wide.paintedHitMap(44), undefined, 'no hit geometry before the first paint')
  wide.render(44)
  const floor = wide.paintedHitMap(44)
  assert.ok(floor !== undefined)
  assert.deepEqual(floor.actions.map(hit => hit.action), ['view', 'copy'])
  wide.dispose()

  const narrow = figureOf(svgPublication(), { onView: () => {} })
  const lines = narrow.render(12)
  const painted = stripSgr(lines.join('\n')).split('\n')
  const actionRow = painted.find(line => line.includes('View'))
  assert.ok(actionRow !== undefined, 'View remains reachable at an extreme width')
  assert.equal(painted.some(line => line.includes('Copy SVG')), false,
    'the lower-priority label is dropped whole, never truncated into a partial hit')
  const hits = narrow.paintedHitMap(12)
  assert.ok(hits !== undefined)
  assert.deepEqual(hits.actions.map(hit => hit.action), ['view'])
  narrow.dispose()
})

// ── Image-8 / I8-2B: SIXEL post-commit pixel hit ──────────────────────────

const SIXEL_PLACEMENT = '\x1bP0;1;q"1;1;320;160#0;2;100;0;0~\x1b\\'

/** A Direct SIXEL owner face whose committed footprint is controlled by the
 *  test: the component renders before the Screen materializes the raster. */
function sixelFigureGraphics(state: { committed: boolean; rows: number; columns: number }): ImageGraphics {
  return {
    mode: 'sixel',
    canPaint: () => true,
    image: () => {
      const body: PixelBody = {
        render: () => [SIXEL_PLACEMENT, '', ''],
        invalidate: () => {},
        paintedBodyAt: (width: number) => (state.committed ? { width, columns: state.columns, rows: state.rows } : undefined),
        dispose: () => {},
      }
      return body
    },
    terminal: {} as never,
    screen: {} as never,
    observeScreen: () => {},
    resample: () => {},
    dispose: () => {},
  } as unknown as ImageGraphics
}

async function drainRaster(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await new Promise(resolve => setImmediate(resolve))
}

test('a SIXEL figure reports its pixel hit only after the Screen commits, without another render', async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  try {
    const state = { committed: false, rows: 3, columns: 8 }
    const loader = new SvgRasterLoader(async (_source, options) => ({
      png: new Uint8Array(),
      base64: TINY_PNG_BASE64,
      widthPx: options.targetWidth,
      heightPx: Math.max(1, Math.round(options.targetWidth / 2)),
    }))
    const figure = figureOf(svgPublication(), {
      svgLoader: loader,
      svgTheme: { fallbackColor: text => text },
      svgAdmissionWidth: 640,
      graphics: sixelFigureGraphics(state),
    })
    figure.render(100)
    await drainRaster()
    await drainRaster()
    const lines = figure.render(100)
    const before = figure.paintedHitMap(100)
    assert.ok(before !== undefined, 'the figure painted its action layout')
    assert.equal(before.thumbnailBody, undefined, 'an uncommitted candidate registers no pixel body')
    const stable = { height: before.height, actions: before.actions }

    state.committed = true
    // The SAME query, no render: the committed footprint is now the hit.
    const after = figure.paintedHitMap(100)
    assert.ok(after !== undefined)
    assert.ok(after.thumbnailBody !== undefined, 'the committed frame reports a pixel body')
    const body = after.thumbnailBody!
    assert.ok(body.startRow > 0 && body.endRow > body.startRow)
    assert.equal(body.endRow - body.startRow, 3, 'the footprint rows come from the owner')
    assert.equal(body.endCol, 8)
    assert.equal(after.height, stable.height, 'the asynchronous raster never changes the figure height')
    assert.deepEqual(after.actions, stable.actions, 'action rows stay the render-time snapshot')
    // The first painted row is the DCS candidate at the figure-relative index.
    assert.ok(lines[body.startRow]!.includes(SIXEL_PLACEMENT), 'the hit starts at the real DCS row')

    state.rows = 99
    assert.equal(figure.paintedHitMap(100)?.thumbnailBody, undefined, 'an over-budget footprint is never a hit')
    state.rows = 3
    state.columns = 101
    assert.equal(figure.paintedHitMap(100)?.thumbnailBody, undefined, 'a footprint wider than the grant is never a hit')
    figure.dispose()
    loader.dispose()
  } finally {
    resetCapabilitiesCache()
  }
})
