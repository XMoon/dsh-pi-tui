/**
 * PR-D: the canonical chart/SVG facts, their strict parsers, the render-time
 * SVG authorization and the bounded admission gate.
 *
 * These are the UI-neutral contracts every renderer shares: the FINAL durable
 * content is the only drawing admission source, and the machine line is
 * versioned and strictly parsed.
 * @module @xmoon76/dsh-pi-tui/visual-facts.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chartArgsProblem,
  chartContentBlocks,
  chartFactFromArgs,
  chartHumanText,
  chartProjection,
  chartTextRows,
  chartValueRows,
  parseChartFact,
} from '../../src/domain/visual/chart.ts'
import {
  authorizeSvg,
  parseSvgArgs,
  svgDetailRows,
  parseSvgFact,
  svgContentBlocks,
  svgDigest,
  svgFactFromArgs,
} from '../../src/domain/visual/svg.ts'
import { admitSvg } from '../../src/domain/visual/svg-admission.ts'
import { parseVisualFactLine, visualParts, visualPartsFromText } from '../../src/domain/visual/visual-facts.ts'
import { SVG_MAX_SOURCE_BYTES } from '../../src/domain/visual/constants.ts'

const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/><text x="4" y="20" font-size="12">Gateway</text></svg>'

function chartArgs() {
  return { kind: 'bars' as const, title: 'Request latency', unit: 'ms', series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }] }
}

// ── chart ──────────────────────────────────────────────────────────────────

test('chart: a valid fact round-trips through the machine line', () => {
  const fact = chartFactFromArgs(chartArgs())
  assert.equal(chartArgsProblem(chartArgs()), undefined)
  assert.deepEqual(parseChartFact(JSON.parse(JSON.stringify(fact))), fact)
  const line = (chartContentBlocks(fact).find(block => block.type === 'text' && block.text.startsWith('visual-v1:')) as { text: string }).text
  assert.deepEqual(parseVisualFactLine(line), fact)
})

test('chart: the readable projection keeps every exact value, unit and order', () => {
  const fact = chartFactFromArgs({
    kind: 'spark',
    title: 'Delta',
    unit: 'ms',
    series: [{ label: 'a', value: -12.5 }, { label: 'b', value: 0 }, { label: 'c', value: 0 }],
  })
  const text = chartHumanText(fact)
  assert.match(text, /Delta \(ms\)/u)
  assert.match(text, /a {2}-12\.5 ms/u)
  assert.match(text, /b {2}0 ms/u)
  assert.match(text, /3 supplied values/u)
  // The graphical card body repeats the values without the title.
  assert.deepEqual(chartValueRows(fact), ['a  -12.5 ms', 'b  0 ms', 'c  0 ms', '3 supplied values'])
})

test('chart: the TSP projection carries the same ordered series and one summary', () => {
  const projection = chartProjection(chartFactFromArgs(chartArgs()))
  assert.equal(projection.kind, 'bars')
  assert.equal(projection.summary, 'Request latency (ms)')
  assert.deepEqual(projection.series, [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }])
})

test('chart: every exact value survives narrow rows; bars are the only thing dropped', () => {
  const fact = chartFactFromArgs({
    kind: 'bars',
    title: 'Long labels',
    series: [
      { label: 'a rather long label that will not fit', value: 123456789 },
      { label: 'short', value: -7 },
    ],
  })
  for (const width of [42, 30, 20]) {
    const rows = chartTextRows(fact, width)
    const text = rows.join('\n')
    assert.match(text, /123456789/u, `value survives at ${width}: ${text}`)
    assert.match(text, /-7/u, `negative value survives at ${width}: ${text}`)
    assert.match(text, /2 supplied values/u)
  }
})

test('chart: argument validation rejects the named product limits', () => {
  assert.match(chartArgsProblem({ kind: 'heatmap', title: 'x', series: [] }) ?? '', /kind/u)
  assert.match(chartArgsProblem({ ...chartArgs(), series: [{ label: 'only', value: 1 }] }) ?? '', /between 2 and 12/u)
  assert.match(chartArgsProblem({ ...chartArgs(), series: [{ label: 'a', value: Number.NaN }, { label: 'b', value: 1 }] }) ?? '', /finite/u)
  assert.match(chartArgsProblem({ ...chartArgs(), series: [{ label: 'a', value: 1 }, { label: '', value: 2 }] }) ?? '', /non-empty label/u)
  assert.match(chartArgsProblem({ ...chartArgs(), extra: true }) ?? '', /only kind/u)
  assert.equal(chartArgsProblem({ ...chartArgs(), series: Array.from({ length: 13 }, (_, index) => ({ label: String(index), value: index })) })?.includes('between 2 and 12'), true)
})

test('chart: a malformed machine line is not a fact and does not leak into the human text', () => {
  const parts = visualParts([
    { type: 'text', text: 'readable' },
    { type: 'text', text: 'visual-v1:{"type":"chart","version":2}' },
  ])
  assert.equal(parts.fact, undefined)
  assert.equal(parts.humanText, 'readable')
  const flat = visualPartsFromText('readable\nvisual-v1:{"type":"chart","version":2}')
  assert.equal(flat.fact, undefined)
  assert.equal(flat.humanText, 'readable')
})

// ── SVG admission ──────────────────────────────────────────────────────────

test('svg admission: the safe static subset is admitted verbatim', () => {
  for (const source of [
    SAFE_SVG,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><rect id="r" width="8" height="8"/></defs><use href="#r"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#22c55e"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="8" y="32" font-size="12">节点</text></svg>',
  ]) {
    const verdict = admitSvg(source)
    assert.equal(verdict.ok, true, `expected admission: ${JSON.stringify(verdict)}`)
  }
})

test('svg admission: every measured hostile shape is refused', () => {
  const cases: Record<string, string> = {
    script: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(1)</script></svg>',
    onload: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect onload="x" width="8" height="8"/></svg>',
    foreignObject: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><foreignObject><body/></foreignObject></svg>',
    externalHref: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><image xlink:href="http://127.0.0.1/x"/></svg>',
    externalPaint: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="url(http://127.0.0.1/x)"/></svg>',
    styleElement: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.c{fill:red}</style><rect class="c" width="8" height="8"/></svg>',
    animate: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="8" height="8"><animate attributeName="x" to="20"/></rect></svg>',
    doctype: '<?xml version="1.0"?><!DOCTYPE svg SYSTEM "http://127.0.0.1/x"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
    hugeViewBox: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000000 100000000"><rect width="100" height="100"/></svg>',
    pxBomb: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="9999999999px" height="9999999999px"/>',
    noNamespace: '<svg viewBox="0 0 32 32"><rect width="32" height="32"/></svg>',
    currentColor: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="currentColor"/></svg>',
  }
  for (const [name, source] of Object.entries(cases)) {
    const verdict = admitSvg(source)
    assert.equal(verdict.ok, false, `${name} must be refused: ${JSON.stringify(verdict)}`)
  }
})

test('svg admission: the 128 KiB product budget is below the client SVG gate', () => {
  const padding = 'x'.repeat(SVG_MAX_SOURCE_BYTES)
  const over = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><desc>${padding}</desc></svg>`
  const verdict = admitSvg(over)
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.reason : '', /bytes/u)
})

// ── SVG authorization ──────────────────────────────────────────────────────

test('svg: the credential digest matches the durable call source', () => {
  const args = { title: 'Topology', description: 'Gateway -> App -> Database', svg: SAFE_SVG }
  const fact = svgFactFromArgs(args)
  assert.equal(fact.digest, svgDigest(SAFE_SVG))
  assert.equal(parseSvgFact(JSON.parse(JSON.stringify(fact)))?.digest, fact.digest)
  assert.deepEqual(parseSvgArgs(JSON.stringify(args)), args)
  const auth = authorizeSvg(JSON.stringify(args), svgContentBlocks(fact), 'ok')
  assert.equal(auth.state, 'ready', JSON.stringify(auth))
})

test('svg: a replaced content / mismatching value / unsafe source degrades to text', () => {
  const args = { title: 'Topology', description: 'Gateway -> App -> Database', svg: SAFE_SVG }
  const fact = svgFactFromArgs(args)
  const replaced = authorizeSvg(JSON.stringify(args), [{ type: 'text', text: 'REPLACED by policy' }], 'ok')
  assert.equal(replaced.state, 'text')
  assert.match(replaced.state === 'text' ? replaced.reason : '', /credential is missing/u)
  const other = svgFactFromArgs({ title: 'Other', description: 'other', svg: `${SAFE_SVG}<!-- other -->` })
  const mismatch = authorizeSvg(JSON.stringify(args), svgContentBlocks(other), 'ok')
  assert.equal(mismatch.state, 'text')
  assert.match(mismatch.state === 'text' ? mismatch.reason : '', /does not match/u)
  const unsafe = { title: 'Bad', description: 'bad', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>x</script></svg>' }
  const unsafeFact = { version: 1 as const, type: 'svg' as const, title: 'Bad', description: 'bad', digest: svgDigest(unsafe.svg), bytes: Buffer.byteLength(unsafe.svg) }
  const refused = authorizeSvg(JSON.stringify(unsafe), svgContentBlocks(unsafeFact), 'ok')
  assert.equal(refused.state, 'text')
  assert.match(refused.state === 'text' ? refused.reason : '', /not admissible/u)
})


test('svg admission: percentages and theme-paint keywords are value-bounded', () => {
  const base = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">${body}</svg>`
  for (const body of [
    '<circle r="1e300%" cx="10" cy="10"/>',
    '<rect width="1e300%" height="1e300%"/>',
    '<rect x="1e300%" width="8" height="8"/>',
    '<rect width="2048%" height="2048%"/>',
    '<circle r="2048%" cx="10" cy="10"/>',
    '<rect width="100em" height="8"/>',
    '<rect width="100ex" height="8"/>',
    '<rect width="100ch" height="8"/>',
    '<rect width="100rem" height="8"/>',
    '<rect width="100vw" height="8"/>',
    '<rect width="100vh" height="8"/>',
    '<rect fill="currentcolor" width="8" height="8"/>',
    '<rect fill="CurrentColor" width="8" height="8"/>',
    '<rect fill="VAR(--fg)" width="8" height="8"/>',
  ]) {
    const verdict = admitSvg(base(body))
    assert.equal(verdict.ok, false, `${body} must be refused: ${JSON.stringify(verdict)}`)
  }
  const inheritedFont = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 64" font-size="1000"><rect width="100em" height="64"/></svg>'
  assert.equal(admitSvg(inheritedFont).ok, false, 'relative font units must not bypass the pixel budget')
  // The exact absolute equivalent (100em at font-size 1000 = 100000) is
  // already rejected; the relative spelling must be too.
  assert.equal(admitSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 64"><rect width="100000" height="8"/></svg>').ok, false)
  const bigViewport = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 1024"><rect width="2048%" height="2048%"/></svg>'
  assert.equal(admitSvg(bigViewport).ok, false)
  const bigRadius = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 1024"><circle r="2048%" cx="10" cy="10"/></svg>'
  assert.equal(admitSvg(bigRadius).ok, false)
  // Length percentages are outside the bounded subset at every magnitude;
  // only a gradient stop offset may be a bounded 0–100% fraction.
  assert.equal(admitSvg(base('<circle r="50%" cx="10" cy="10"/>')).ok, false)
  assert.equal(admitSvg(base('<rect width="100%" height="100%"/>')).ok, false)
  const gradient = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><defs>'
    + '<linearGradient id="g"><stop offset="0%" stop-color="#000"/><stop offset="100%" stop-color="#fff"/></linearGradient>'
    + '</defs><rect width="64" height="32" fill="url(#g)"/></svg>'
  assert.equal(admitSvg(gradient).ok, true)
  assert.equal(admitSvg(base('<rect width="8" height="8" fill="#3b82f6"/>')).ok, true)
  // The exact fractional CSS viewport is preserved for the raster budget; the
  // display target stays the user-coordinate (viewBox) size.
  const fractionalViewport = '<svg xmlns="http://www.w3.org/2000/svg" width="0.5" height="1" viewBox="0 0 2000 1"><rect width="20" height="1" fill="#ff0000"/></svg>'
  const fractional = admitSvg(fractionalViewport)
  assert.equal(fractional.ok, true)
  if (fractional.ok) {
    assert.equal(fractional.width, 2000)
    assert.equal(fractional.height, 1)
    assert.equal(fractional.viewportWidth, 0.5)
    assert.equal(fractional.viewportHeight, 1)
  }
  // Absolute units stay in the subset (and are converted to their px bound).
  assert.equal(admitSvg(base('<rect width="100px" height="8"/>')).ok, true)
  assert.equal(admitSvg(base('<rect width="10mm" height="8"/>')).ok, true)
  assert.equal(admitSvg(base('<rect width="1in" height="8"/>')).ok, true)
})

test('the final fact title is carried by the display projections, not just the call args', () => {
  const chart = chartFactFromArgs({
    kind: 'bars',
    title: 'FINAL_APPROVED_TITLE',
    unit: 'ms',
    series: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }],
  })
  assert.match(chartHumanText(chart), /FINAL_APPROVED_TITLE \(ms\)/u)
  assert.equal(chartProjection(chart).summary, 'FINAL_APPROVED_TITLE (ms)')
  const svg = svgFactFromArgs({ title: 'FINAL_SVG_TITLE', description: 'desc', svg: SAFE_SVG })
  assert.equal(svgDetailRows(svg)[0], 'FINAL_SVG_TITLE')
})

test('a non-successful result never authorizes an SVG drawing', () => {
  const args = { title: 'Topology', description: 'desc', svg: SAFE_SVG }
  const fact = svgFactFromArgs(args)
  for (const status of ['error', 'running'] as const) {
    const verdict = authorizeSvg(JSON.stringify(args), svgContentBlocks(fact), status)
    assert.equal(verdict.state, 'text')
    assert.match(verdict.state === 'text' ? verdict.reason : '', /not successful/u)
  }
})
