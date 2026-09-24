/**
 * PR4/F4 hardening: width, grapheme and ANSI robustness of the F4 Compact
 * components. Every returned rendered row must obey the framebuffer width
 * contract at the current width; wide glyphs, combining marks, ZWJ emoji and
 * ANSI-colored text must never add a physical row or break the escape state.
 * @module @xmoon76/dsh-pi-tui/compact-width-grapheme.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Text, visibleWidth } from '@xmoon76/pi-tui'
import { CompactPendingWorkComponent, CompactWorkComponent, type CompactWorkSummary } from '../src/compact-work.ts'
import { projectCompact, type CompactWorkSpan } from '../src/compact-projection.ts'
import { ContextClusterComponent, contextClusterSummaryParts } from '../src/context-cluster.ts'
import { clusterAdjacentAmbientContext } from '../src/context-presentation.ts'
import { NoticeContextRow, RecallContextRow, RelayContextRow } from '../src/context-row.ts'
import { UserBubbleComponent } from '../src/tui-app.ts'
import { color } from '../src/theme.ts'
import type { TranscriptMessage } from '../src/transcript.ts'

type SystemRow = Extract<TranscriptMessage, { kind: 'system' }>

const WIDTHS = [1, 2, 3, 4, 5, 8, 10, 20, 40, 80, 120] as const

/** The grapheme/ANSI sample set the plan's matrix requires. */
const SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['ascii', 'plain ascii text with spaces'],
  ['cjk', '中文内容与更多文字混排测试'],
  ['emoji', 'emoji 🙂🚀✨ here'],
  ['emoji-vs', 'text ❤️ variation selector'],
  ['combining', 'combining e\u0301 a\u0300 o\u0308 marks'],
  ['zwj', 'family 👨‍👩‍👧‍👦 and flag 🇨🇳'],
  ['ansi', `${color.text('colored')} ${color.textDim('dimmed')} tail`],
  ['ansi-cjk-mixed', `${color.text('中文')} 🐋 ${color.textDim('尾部')} ascii`],
]

function systemRow(overrides: Partial<SystemRow>): SystemRow {
  return { kind: 'system', turn: 0, text: 'body', context: true, ...overrides }
}

const notice = (summary: string): SystemRow =>
  systemRow({ text: summary, summary, label: 'Background job', icon: 'context-notice', contextPresentation: { form: 'notice', sourceKind: 'subagent-settled', role: 'inject' } })

const relay = (body: string): SystemRow =>
  systemRow({ text: body, label: 'agent-message', icon: 'context-generic', contextPresentation: { form: 'relay', sourceKind: 'agent-message', senderSessionId: 'child-2', role: 'inject' } })

const recall = (body: string, label: string): SystemRow =>
  systemRow({ text: body, label, icon: 'context-recall', contextPresentation: { form: 'recall', sourceKind: 'session-reference', role: 'recall' } })

function ambient(label: string, form: 'instructions' | 'catalog' | 'snapshot', text: string): SystemRow {
  return systemRow({ turn: 0, text, label, contextPresentation: { form, sourceKind: 'plugin', role: 'inject' } })
}

/** A real Work span derived from the projection, so the component sees genuine
 * thinking + tool members. */
function compactSpan(): CompactWorkSpan {
  const messages: TranscriptMessage[] = [
    { kind: 'thinking', turn: 0, text: 'reasoning', running: false },
    { kind: 'tool', turn: 0, name: 'read', args: '{}', result: 'ok', status: 'ok' },
  ]
  const blocks = projectCompact(messages, { expandedWorkOwners: new Set(), expandedClusters: new Set(), forcedExpanded: new Set() })
  const block = blocks[0]
  assert.ok(block !== undefined && block.kind === 'work', 'fixture: one Work span')
  return block.span
}

function assertRowsWithin(rows: readonly string[], width: number, where: string): void {
  assert.ok(rows.length > 0, `${where} width ${width}: must render at least one row`)
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= width, `${where} width ${width} overflowed: ${JSON.stringify(row)}`)
  }
}

// Every grapheme/ANSI sample must satisfy the width contract on every F4 row
// family, expanded and collapsed.
test('the grapheme/ANSI matrix never overflows any F4 row family', () => {
  for (const [name, sample] of SAMPLES) {
    const workSummary: CompactWorkSummary = { actionStats: { total: 5, types: new Map([['read', 4], ['subagent', 1]]) }, think: { text: sample, running: true }, action: undefined }
    const clusterRows = [ambient(sample, 'instructions', 'a'), ambient(sample, 'catalog', 'b')]
    const { clusters } = clusterAdjacentAmbientContext(clusterRows)
    assert.equal(clusters.length, 1, `${name}: fixture clusters`)
    for (const width of WIDTHS) {
      const batches: ReadonlyArray<readonly [string, string[]]> = [
        ['work collapsed', new CompactWorkComponent({ span: compactSpan(), expanded: false, summary: workSummary, action: { kind: 'tool', display: sample, rootName: 'read' }, iconStyle: 'emoji' }).render(width)],
        ['work expanded', new CompactWorkComponent({ span: compactSpan(), expanded: true, summary: workSummary, iconStyle: 'emoji' }).render(width)],
        ['pending work', new CompactPendingWorkComponent({ preparingSummary: sample, iconStyle: 'emoji' }).render(width)],
        ['cluster collapsed', new ContextClusterComponent({ cluster: clusters[0]!, expanded: false, iconStyle: 'emoji' }).render(width)],
        ['cluster expanded', new ContextClusterComponent({ cluster: clusters[0]!, expanded: true, iconStyle: 'emoji' }).render(width)],
        ['notice collapsed', new NoticeContextRow({ message: notice(sample), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
        ['notice expanded', new NoticeContextRow({ message: notice(sample), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
        ['relay collapsed', new RelayContextRow({ message: relay(sample), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry: { thresholdRows: 2, headRows: 1, tailRows: 1 } }).render(width)],
        ['relay expanded', new RelayContextRow({ message: relay(sample), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry: { thresholdRows: 2, headRows: 1, tailRows: 1 } }).render(width)],
        ['recall collapsed', new RecallContextRow({ message: recall(sample, sample), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
        ['recall expanded', new RecallContextRow({ message: recall(sample, sample), expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)],
      ]
      for (const [where, rows] of batches) assertRowsWithin(rows, width, `${name} ${where}`)
    }
  }
})

// The notice summary keeps NORMAL brightness and a NATURAL wrap: it is never
// reduced to one truncated physical row (R12).
test('a notice summary wraps naturally and is never one-line truncated', () => {
  for (const [name, sample] of SAMPLES) {
    const summary = `${sample} — an account long enough to require more than one physical terminal row at a narrow width`
    for (const width of [10, 20, 40]) {
      const rows = new NoticeContextRow({ message: notice(summary), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width)
      assertRowsWithin(rows, width, `notice summary ${name}`)
      const bodyRows = rows.slice(1)
      assert.ok(bodyRows.length >= 1, `${name} width ${width}: the summary must render`)
      assert.ok(!bodyRows.some(row => row.includes('…')), `${name} width ${width}: the summary is never ellipsized to one line`)
    }
  }
})

// The shared long-message geometry decides IDENTICALLY for a User bubble and a
// Relay row with the same body and width (R: fix the shared helper, not Relay).
test('the user bubble and the relay row make compatible long-message decisions', () => {
  const geometry = { thresholdRows: 10, headRows: 4, tailRows: 3 }
  for (const [name, body] of SAMPLES) {
    for (const width of [40, 80]) {
      const lineCount = 12
      const text = Array.from({ length: lineCount }, (_, index) => `${name} line ${index} ${body}`).join('\n')
      const bubble = new UserBubbleComponent(new Text(text, 0, 0), '❯ ', (value) => value, {
        ...geometry, expanded: false,
        compactMarker: (hidden) => `MARK ${hidden}`,
      })
      const bubbleRows = bubble.render(width)
      const userMarked = bubble.compactMarkerRow() !== undefined

      const relayRows = new RelayContextRow({
        message: relay(text), expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry,
      }).render(width)
      const relayMarked = relayRows.slice(1).some(row => row.includes('…'))

      assert.equal(relayMarked, userMarked,
        `${name} width ${width}: the relay fold decision must match the user bubble`)
      if (userMarked) {
        // Both keep ONE marker row and the same number of head/tail rows.
        const userMarkerCount = bubbleRows.filter(row => row.includes('MARK')).length
        const relayMarkerCount = relayRows.slice(1).filter(row => row.includes('…')).length
        assert.equal(userMarkerCount, 1)
        assert.equal(relayMarkerCount, 1)
      }
    }
  }
})

test('the cluster summary composes deterministically from wide/duplicate labels', () => {
  const rows = [ambient('中文标签', 'instructions', 'a'), ambient('中文标签', 'catalog', 'b'), ambient('🏷️', 'snapshot', 'c')]
  const { clusters } = clusterAdjacentAmbientContext(rows)
  assert.deepEqual(contextClusterSummaryParts(clusters[0]!), ['中文标签 ×2', '🏷️'])
  for (const width of WIDTHS) {
    assertRowsWithin(new ContextClusterComponent({ cluster: clusters[0]!, expanded: false, iconStyle: 'emoji' }).render(width), width, 'cluster summary')
  }
})

test('an oversized Work header degrades without wrapping to extra rows', () => {
  const summary: CompactWorkSummary = { actionStats: { total: 1234567890, types: new Map([['read', 123456789], ['bash', 1234567890 - 123456789]]) }, think: { text: 'x', running: true } }
  for (const width of WIDTHS) {
    const rows = new CompactWorkComponent({ span: compactSpan(), expanded: false, summary, action: { kind: 'tool', display: 'very long tool display '.repeat(10), rootName: 'read' }, iconStyle: 'symbols' }).render(width)
    assert.equal(rows.length <= 3, true, `width ${width}: header + at most two slot rows`)
    assertRowsWithin(rows, width, 'oversized work header')
  }
})
