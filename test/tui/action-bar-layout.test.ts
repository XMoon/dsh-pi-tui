import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  ACTION_BAR_SEPARATOR,
  layoutActionBarRow,
  renderActionBarRow,
  type ActionBarSegment,
} from '../../src/tui/presentation/action-bar.ts'

const matrixWidths = [44, 72, 80, 100, 120]

test('action-bar rendering keeps its established compact and drop result', () => {
  const segments: ActionBarSegment[] = [
    { text: 'Enter open', priority: 90 },
    { text: 'Stop [S]', short: 'Stop', priority: 95 },
    { text: 'Esc close', priority: 1000 },
  ]

  assert.equal(renderActionBarRow(segments, 25), 'Stop · Esc close         ')
})

test('action-bar spans retain input identity and use visible cell widths', () => {
  const segments: ActionBarSegment[] = [
    { text: 'Open', priority: 100 },
    { text: 'Stop [S]', short: 'Stop', priority: 95 },
    { text: 'Drop', priority: 1 },
    { text: 'Open', priority: 90 },
    { text: '操作', priority: 80 },
  ]
  const original = segments.map(segment => ({ ...segment }))
  const layout = layoutActionBarRow(segments, 30)

  assert.equal(layout.truncated, false)
  assert.deepEqual(layout.spans.map(span => span.inputIndex), [0, 1, 3, 4])
  assert.deepEqual(layout.spans.map(span => span.text), ['Open', 'Stop', 'Open', '操作'])
  assert.equal(layout.text, 'Open · Stop · Open · 操作     ')
  for (const span of layout.spans) {
    assert.equal(span.endCol - span.startCol, visibleWidth(span.text))
  }
  assert.equal(layout.spans[1]!.startCol - layout.spans[0]!.endCol, visibleWidth(ACTION_BAR_SEPARATOR))
  assert.equal(layout.spans[2]!.startCol - layout.spans[1]!.endCol, visibleWidth(ACTION_BAR_SEPARATOR))
  assert.equal(layout.spans[3]!.startCol - layout.spans[2]!.endCol, visibleWidth(ACTION_BAR_SEPARATOR))
  assert.deepEqual(segments, original, 'compacting and dropping never mutate caller segments')
})

test('action-bar layout matches the existing text renderer at supported widths', () => {
  const segments: ActionBarSegment[] = [
    { text: 'Enter open', priority: 90 },
    { text: 'Continue [Right]', short: 'Continue', priority: 95 },
    { text: '操作', short: '操作', priority: 60 },
    { text: 'Cancel [Esc]', short: 'Cancel', priority: 1000 },
    { text: 'Open', priority: 50 },
    { text: 'Open', priority: 40 },
  ]

  for (const width of matrixWidths) {
    const layout = layoutActionBarRow(segments, width)
    assert.equal(layout.text, renderActionBarRow(segments, width), `width ${width}`)
    assert.equal(layout.truncated, false, `the surviving action fits at width ${width}`)
    for (const span of layout.spans) {
      assert.equal(span.endCol - span.startCol, visibleWidth(span.text), `width ${width}: ${span.text}`)
    }
  }
})

test('action-bar clipping leaves no clickable span and empty layouts stay empty', () => {
  const single = layoutActionBarRow([{ text: 'Confirm stop', priority: 90 }], 5)
  assert.equal(single.truncated, true)
  assert.deepEqual(single.spans, [])

  const empty = layoutActionBarRow([], 80)
  assert.deepEqual(empty, { text: '', spans: [], truncated: false })
  for (const width of [0, 1, 44, 80, 120]) {
    assert.equal(renderActionBarRow([], width), ' '.repeat(width), `legacy empty-row padding at width ${width}`)
  }
})
