/**
 * Pure tests for the form-aware standalone Context rows (notice / relay /
 * recall): brightness, natural wrapping, producer-authored summaries, the
 * reused long-message disclosure geometry, and the card-internal header→body
 * indent (header at the transcript left edge, body indented 2 cells).
 * @module @xmoon76/dsh-pi-tui/context-row.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { NoticeContextRow, RecallContextRow, RelayContextRow } from '../src/context-row.ts'
import { color } from '../src/theme.ts'
import type { TranscriptMessage } from '../src/transcript.ts'

/** The card-internal body indent every standalone Context body row carries
 * (context-card body-indent supplement). */
const BODY = '  '

/** The visible text of one painted row (the indent lives before/inside the
 * paint, so column assertions read the stripped form). */
function visible(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, '')
}

type SystemRow = Extract<TranscriptMessage, { kind: 'system' }>

function noticeRow(summary: string | undefined, text = 'full payload body'): SystemRow {
  return {
    kind: 'system', turn: 0, text, label: 'Background job', icon: 'context-notice', context: true,
    ...summary === undefined ? {} : { summary },
    contextPresentation: { form: 'notice', sourceKind: 'subagent-settled', role: 'inject' },
  }
}

function relayRow(text: string): SystemRow {
  return {
    kind: 'system', turn: 0, text, label: 'agent-message', icon: 'context-generic', context: true,
    contextPresentation: { form: 'relay', sourceKind: 'agent-message', senderSessionId: 'child-2', role: 'inject' },
  }
}

function recallRow(text: string): SystemRow {
  return {
    kind: 'system', turn: 0, text, label: 'prior work', icon: 'context-recall', context: true,
    contextPresentation: { form: 'recall', sourceKind: 'session-reference', role: 'recall' },
  }
}

test('a collapsed notice shows the producer summary at normal brightness, never a payload preview', () => {
  const summary = 'the background test suite finished with 3 failures'
  const rows = new NoticeContextRow({ message: noticeRow(summary), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.equal(rows.length, 2, 'header + summary only')
  assert.match(rows[0]!, /Background job/)
  assert.match(rows[0]!, /ctrl\+o to expand/)
  assert.equal(rows[1], color.text(`${BODY}${summary}`), 'the summary is normal brightness, never dim, and indented under its header')
  assert.ok(!visible(rows[0]!).startsWith(' '), 'the header stays at the transcript left edge')
  assert.ok(!rows.some(row => row.includes('full payload body')), 'the payload stays hidden')
  assert.ok(!rows.some(row => row.includes('Context injection')), 'a notice is never a generic Context injection')
})

test('a notice summary wraps naturally at narrow widths instead of being truncated to one row', () => {
  const summary = 'the background job completed with a long account that cannot fit on a single physical terminal row'
  const rows = new NoticeContextRow({ message: noticeRow(summary), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(24)
  for (const row of rows) assert.ok(visibleWidth(row) <= 24, `row exceeds the width: ${JSON.stringify(row)}`)
  const summaryRows = rows.slice(1)
  assert.ok(summaryRows.length > 1, `the summary must wrap, got ${summaryRows.length} row(s)`)
  assert.ok(!summaryRows.some(row => row.includes('…')), 'the summary is never ellipsized to a single line')
  assert.ok(summaryRows.join(' ').includes('background'), 'the summary text is present')
})

test('an expanded notice adds the complete payload and keeps the summary', () => {
  const summary = 'job finished'
  const rows = new NoticeContextRow({ message: noticeRow(summary, 'line one\nline two'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.ok(rows.includes(color.text(`${BODY}${summary}`)))
  assert.ok(rows.includes(color.textDim(`${BODY}line one`)), 'the payload renders through the existing Context body rules, indented on the SAME body edge as the summary')
  assert.ok(rows.includes(color.textDim(`${BODY}line two`)))
  assert.ok(!rows.some(row => row.includes('to expand')), 'an open row carries no expand affordance')
})

test('a legacy notice without a summary fabricates no body preview', () => {
  const rows = new NoticeContextRow({ message: noticeRow(undefined, 'the only payload'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.equal(rows.length, 1, 'header only — no invented summary, no head preview')
  assert.ok(!rows[0]!.includes('the only payload'))
})

test('a relay names its sender, shows the body at normal brightness, and is not a generic Context injection', () => {
  const body = 'There are two need-fix issues in the search restoration path.'
  const rows = new RelayContextRow({
    message: relayRow(body), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji',
    geometry: { thresholdRows: 10, headRows: 4, tailRows: 3 },
  }).render(100)
  assert.equal(rows.length, 2)
  assert.match(rows[0]!, /Agent message · child-2/)
  assert.equal(rows[1], color.text(`${BODY}${body}`), 'the relay body is indented under its header')
  assert.ok(!visible(rows[0]!).startsWith(' '), 'the relay header stays at the transcript left edge')
  assert.ok(!rows.some(row => row.includes('Context injection')))
})

test('a long relay reuses the FULL long-message disclosure geometry: head, marker and tail', () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index}`).join(' ')
  const geometry = { thresholdRows: 3, headRows: 2, tailRows: 2 }
  const rows = new RelayContextRow({
    message: relayRow(body), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry,
  }).render(60)
  assert.match(rows[0]!, /to expand/)
  assert.equal(rows.length, 6, 'header + 2 head rows + the overflow marker + 2 tail rows')
  assert.ok(rows[3]!.includes('…'), 'the marker sits between the head and the tail')
  assert.ok(rows[1]!.includes('line 0'), 'the head is kept')
  assert.ok(rows[5]!.includes('line 39'), 'the TAIL is kept, exactly like the long-user geometry')
  assert.ok(!rows.some(row => row.includes('line 20')), 'the middle is what the affordance reveals')

  const expanded = new RelayContextRow({
    message: relayRow(body), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry,
  }).render(60)
  assert.ok(expanded.length > 5, 'an expanded relay renders the whole body')
  assert.ok(expanded.join(' ').includes('line 20'))
  assert.ok(expanded.join(' ').includes('line 39'))
})

test('a relay short enough to keep head AND tail shows no marker and hides nothing', () => {
  const body = Array.from({ length: 4 }, (_, index) => `line ${index}`).join(' ')
  const geometry = { thresholdRows: 3, headRows: 4, tailRows: 3 }
  const rows = new RelayContextRow({
    message: relayRow(body), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry,
  }).render(60)
  assert.ok(!rows.join('\n').includes('…'), 'no marker when nothing is hidden')
  assert.ok(rows.join(' ').includes('line 3'), 'the full body is shown')
})

test('a long relay never exceeds a narrow width (header, head rows and overflow marker)', () => {
  const body = Array.from({ length: 30 }, (_, index) => `line ${index}`).join(' ')
  const geometry = { thresholdRows: 3, headRows: 2, tailRows: 2 }
  const message = relayRow(body)
  for (const width of [1, 2, 3]) {
    const rows = new RelayContextRow({ message, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry }).render(width)
    assert.ok(rows.length > 0, `width ${width} must still render rows`)
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `width ${width} overflowed: ${JSON.stringify(row)}`)
    }
  }
})

test('wide glyphs (CJK / emoji) never break the narrow-width row contract', () => {
  const cjkSummary = '后台任务已完成并发现三个问题'
  const cjkBody = '另一个 agent 发来的消息内容包含中文与表情 🐋🐳 以及更多文字'
  for (const width of [1, 2, 3]) {
    const noticeRows = new NoticeContextRow({ message: noticeRow(cjkSummary), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)
    for (const row of noticeRows) {
      assert.ok(visibleWidth(row) <= width, `notice width ${width} overflowed: ${JSON.stringify(row)}`)
    }
    const noticeExpanded = new NoticeContextRow({ message: noticeRow(cjkSummary, '展开后的中文载荷内容'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)
    for (const row of noticeExpanded) {
      assert.ok(visibleWidth(row) <= width, `expanded notice width ${width} overflowed: ${JSON.stringify(row)}`)
    }
    const relayRows = new RelayContextRow({
      message: relayRow(cjkBody), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji',
      geometry: { thresholdRows: 1, headRows: 1, tailRows: 1 },
    }).render(width)
    for (const row of relayRows) {
      assert.ok(visibleWidth(row) <= width, `relay width ${width} overflowed: ${JSON.stringify(row)}`)
    }
    const recallRows = new RecallContextRow({ message: recallRow('回忆载荷 🐋 中文'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)
    for (const row of recallRows) {
      assert.ok(visibleWidth(row) <= width, `recall width ${width} overflowed: ${JSON.stringify(row)}`)
    }
  }
})

test('a recall names its labels and keeps the payload behind the ordinary disclosure', () => {
  const collapsed = new RecallContextRow({ message: recallRow('recalled body'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.equal(collapsed.length, 1)
  assert.match(collapsed[0]!, /Session recall · prior work/)
  assert.ok(!collapsed[0]!.includes('recalled body'))
  const expanded = new RecallContextRow({ message: recallRow('recalled body'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.ok(expanded.includes(color.textDim(`${BODY}recalled body`)), 'the recall payload is indented under its header')
  assert.ok(!visible(expanded[0]!).startsWith(' '), 'the recall header stays at the transcript left edge')
  // No metadata -> no invented summary.
  const bare = new RecallContextRow({
    message: { kind: 'system', turn: 0, text: 'x', context: true, contextPresentation: { form: 'recall', role: 'recall' } },
    expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji',
  }).render(80)
  assert.equal(bare[0]!.includes('Session recall'), true)
})

// ── Card-internal header→body indent (body-indent supplement §11/§12) ─────

test('the long-relay marker shares the body left edge with the head/tail rows', () => {
  const body = Array.from({ length: 40 }, (_, index) => `line ${index}`).join(' ')
  const geometry = { thresholdRows: 3, headRows: 2, tailRows: 2 }
  const rows = new RelayContextRow({
    message: relayRow(body), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry,
  }).render(60)
  assert.ok(!visible(rows[0]!).startsWith(' '), 'the header is not indented')
  for (const row of rows.slice(1)) {
    assert.ok(visible(row).startsWith(BODY), `every relay body row shares the 2-cell body edge:\n${JSON.stringify(row)}`)
  }
  // The marker is the overflow row between the head and the tail.
  assert.ok(visible(rows[3]!).startsWith(`${BODY}…`), `the marker follows the same body indent:\n${JSON.stringify(rows[3])}`)
})

test('a notice body row and its payload keep one body edge (no mixed left boundary)', () => {
  const rows = new NoticeContextRow({
    message: noticeRow('short summary', 'payload line'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji',
  }).render(80)
  const bodyRows = rows.slice(1)
  assert.equal(bodyRows.length, 2, 'summary + payload')
  for (const row of bodyRows) assert.ok(visible(row).startsWith(BODY), `body edge:\n${JSON.stringify(row)}`)
})

test('the standalone Context body indent never overflows at 1-3 columns', () => {
  const cases: ReadonlyArray<readonly [string, (width: number) => string[]]> = [
    ['notice summary', width => new NoticeContextRow({ message: noticeRow('后台任务完成 🐋'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
    ['notice payload', width => new NoticeContextRow({ message: noticeRow('s', '展开载荷 🐳'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
    ['relay body', width => new RelayContextRow({ message: relayRow('relay 🐋 body'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry: { thresholdRows: 1, headRows: 1, tailRows: 1 } }).render(width)],
    ['recall payload', width => new RecallContextRow({ message: recallRow('回忆 🐳'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
  ]
  for (const [where, render] of cases) {
    for (const width of [1, 2, 3, 10]) {
      for (const row of render(width)) {
        assert.ok(visibleWidth(row) <= width, `${where} width ${width} overflowed: ${JSON.stringify(row)}`)
      }
      // Below the 3-column floor the defensive drop keeps the header edge
      // too: the card never manufactures a wider-than-terminal lead.
      if (width <= 2) {
        for (const row of render(width)) {
          assert.ok(!visible(row).startsWith(' '), `${where} width ${width} must drop the indent rather than overflow: ${JSON.stringify(row)}`)
        }
      }
    }
  }
})

// ── Wide-grapheme artifact suppression (body-indent supplement §9) ────────

test('a content-bearing wide glyph never leaves a pure-indent ghost body row', () => {
  // width 3 → indent 2 + content 1: the fork cannot place a wide grapheme in
  // one cell, so it would otherwise emit `['', glyph]` → a ghost `'  '` row.
  const one = new NoticeContextRow({ message: noticeRow('中'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(3)
  assert.equal(one.length, 2, `header + exactly ONE body row:\n${one.map(visible).join('|')}`)
  assert.equal(visible(one[1]!), `${BODY}…`, 'the body row is the truncated glyph under the indent')
  const two = new NoticeContextRow({ message: noticeRow('中中'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(3)
  assert.equal(two.length, 3, `two glyphs -> two body rows, no ghosts:\n${two.map(visible).join('|')}`)
  for (const row of one.slice(1).concat(two.slice(1))) {
    assert.notEqual(visible(row).trim(), '', `no pure-indent ghost row:\n${JSON.stringify(visible(row))}`)
  }
})

test('a genuine blank logical line keeps its body row (artifact cleanup is per logical line)', () => {
  const rows = new NoticeContextRow({
    message: noticeRow('first\n\nsecond'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji',
  }).render(40)
  const body = rows.slice(1).map(visible)
  assert.equal(body.length, 3, `three body rows (content / blank / content):\n${body.join('|')}`)
  assert.ok(body[0]!.includes('first'))
  assert.equal(body[1]!.trim(), '', 'the source-authored blank line is NOT deleted')
  assert.ok(body[2]!.includes('second'))
})

test('wide-glyph artifacts never push the relay long-message window into collapse', () => {
  // Three CJK glyphs at content width 1 wrap to exactly THREE true physical
  // rows. A ghost row per glyph would report six and cross a threshold of 3,
  // wrongly collapsing the body and inflating hidden rows.
  const rows = new RelayContextRow({
    message: relayRow('中中中'), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji',
    geometry: { thresholdRows: 3, headRows: 2, tailRows: 2 },
  }).render(3)
  assert.equal(rows.length, 4, `header + exactly 3 body rows, no overflow marker:\n${rows.map(visible).join('|')}`)
  assert.ok(!rows.some(row => visible(row).includes('to expand')), 'no collapse affordance at the threshold')
  for (const row of rows) assert.ok(visibleWidth(row) <= 3, `width contract:\n${JSON.stringify(visible(row))}`)
})

test('a genuine blank relay body line survives the artifact cleanup', () => {
  const rows = new RelayContextRow({
    message: relayRow('alpha\n\nbeta'), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji',
    geometry: { thresholdRows: 10, headRows: 4, tailRows: 3 },
  }).render(20)
  const body = rows.slice(1).map(visible)
  assert.equal(body.length, 3, `content / blank / content:\n${body.join('|')}`)
  assert.equal(body[1]!.trim(), '', 'the blank line is preserved')
})
