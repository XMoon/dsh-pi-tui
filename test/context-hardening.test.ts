/**
 * PR4/F4 hardening: malformed and legacy Context sources must degrade safely
 * through the REAL fold + presentation pipeline. Every unreadable shape stays
 * a standalone generic Context row — never ambient, never a fabricated
 * summary/sender/label — and a legacy session-reference keeps its recall role.
 * @module @xmoon76/dsh-pi-tui/context-hardening.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { contextPresentation, contextProvenance, contextSummary } from '../src/context.ts'
import {
  clusterAdjacentAmbientContext,
  contextFormOf,
  contextPresentationKind,
  isAmbientContext,
  isNoticeContext,
  isRecallContext,
  isRelayContext,
} from '../src/context-presentation.ts'
import { contextClusterSummaryParts } from '../src/context-cluster.ts'
import { NoticeContextRow, RecallContextRow, RelayContextRow } from '../src/context-row.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'

type SystemRow = Extract<TranscriptMessage, { kind: 'system' }>

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** Fold one injected-context source through the REAL user/message path. */
function foldSource(source: unknown, text = 'injected body'): TranscriptMessage | undefined {
  const folder = new TranscriptFolder()
  folder.apply([eventAt('turn/start', { turn: 0 }, 1000, 0)])
  folder.apply([eventAt('user/message', {
    id: MessageId('ctx'), role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, 1001, 1)])
  return folder.messages().find(message => message.kind === 'system' && message.context === true)
}

function systemRow(overrides: Partial<SystemRow> & { contextPresentation?: SystemRow['contextPresentation'] }): SystemRow {
  return { kind: 'system', turn: 0, text: 'body', context: true, ...overrides }
}

/** The visible text of one rendered row, with ANSI SGR sequences removed. */
function plain(row: string): string {
  return row.replace(/\x1B\[[0-9;]*m/g, '')
}

// --- 4.1 source matrix ----------------------------------------------------

const MALFORMED_SOURCES: ReadonlyArray<readonly [string, unknown]> = [
  ['source null', null],
  ['source undefined', undefined],
  ['source string', 'legacy'],
  ['source number', 7],
  ['source empty array', []],
  ['source empty object', {}],
  ['kind missing', { form: 'instructions' }],
  ['kind empty', { kind: '' }],
  ['kind number', { kind: 3 }],
  ['kind unknown', { kind: 'future-runtime-source' }],
  ['form empty', { kind: 'plugin', form: '' }],
  ['form number', { kind: 'plugin', form: 9 }],
  ['form future', { kind: 'plugin', form: 'future-form-v9' }],
  ['summary empty', { kind: 'subagent-settled', form: 'notice', summary: '' }],
  ['summary number', { kind: 'subagent-settled', form: 'notice', summary: 12 }],
  ['summary legacy long', { kind: 'subagent-settled', form: 'notice', summary: 'x'.repeat(400) }],
  ['sender empty', { kind: 'agent-message', form: 'relay', senderSessionId: '' }],
  ['sender number', { kind: 'agent-message', form: 'relay', senderSessionId: 5 }],
  ['plugin field missing', { kind: 'plugin', form: 'snapshot' }],
  ['skill name missing', { kind: 'skill-invocation', form: 'catalog' }],
  ['changes missing', { kind: 'agent-instructions', form: 'instructions' }],
  ['changes non-array', { kind: 'agent-instructions', form: 'instructions', changes: 'AGENTS.md' }],
  ['changes malformed entries', { kind: 'agent-instructions', form: 'instructions', changes: [null, 3, {}, { path: '' }, { path: 7 }] }],
  ['references missing', { kind: 'session-reference', form: 'recall' }],
  ['references non-array', { kind: 'session-reference', form: 'recall', references: {} }],
  ['references malformed entries', { kind: 'session-reference', form: 'recall', references: [null, 2, { label: '' }, { label: false }] }],
]

test('every malformed source degrades without throwing and never fabricates identity', () => {
  for (const [name, source] of MALFORMED_SOURCES) {
    assert.doesNotThrow(() => contextProvenance(source), `${name}: contextProvenance`)
    assert.doesNotThrow(() => contextPresentation(source), `${name}: contextPresentation`)
    assert.doesNotThrow(() => contextSummary(source), `${name}: contextSummary`)
    // The real fold must survive the same shape.
    assert.doesNotThrow(() => foldSource(source), `${name}: fold`)

    const presentation = contextPresentation(source)
    // An unknown/absent form is never recorded as a known ambient form.
    assert.ok(presentation.form === undefined || ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'].includes(presentation.form),
      `${name}: form must stay within the declared vocabulary`)
    if (presentation.form === undefined) {
      assert.equal(isAmbientContext(systemRow({ contextPresentation: presentation })), false, `${name}: no form is never ambient`)
    }
    // Empty/non-string summary and sender are never invented.
    const summary = contextSummary(source)
    assert.ok(summary === null || (typeof summary === 'string' && summary.length > 0), `${name}: summary is a non-empty string or absent`)
  }
})

test('the fold tolerates source null/undefined and keeps the row standalone generic', () => {
  for (const source of [null, undefined]) {
    const row = foldSource(source)
    assert.ok(row !== undefined, `source ${String(source)} must still fold an injected context row`)
    assert.equal(row.kind === 'system' ? row.context : undefined, true)
    assert.equal(contextFormOf(row), undefined, 'no form is recorded')
    assert.equal(contextPresentationKind(row), 'generic', 'unreadable source is standalone generic Context')
    assert.equal(isAmbientContext(row), false)
    assert.equal(row.kind === 'system' ? row.label : 'x', undefined, 'no producer label is invented')
    assert.equal(row.kind === 'system' ? row.summary : 'x', undefined, 'no summary is invented')
  }
})

test('unknown, empty and future forms fail open to generic standalone Context', () => {
  for (const [name, source] of MALFORMED_SOURCES) {
    const presentation = contextPresentation(source)
    if (presentation.form !== undefined) continue
    const row = foldSource(source)
    assert.ok(row !== undefined, `${name}: folds a context row`)
    assert.equal(row.kind === 'system' ? row.context : undefined, true, `${name}: stays surfaced Context`)
    assert.equal(contextFormOf(row), undefined, `${name}: no declared form`)
    assert.equal(contextPresentationKind(row), 'generic', `${name}: presents generic`)
  }
  // A future form on a producer that also carries an ambient-looking kind must
  // still never cluster: form is authority, not kind (R6).
  const a = foldSource({ kind: 'agent-instructions', form: 'future-form-v9', changes: [{ path: 'AGENTS.md' }] })
  const b = foldSource({ kind: 'agent-instructions', form: 'future-form-v9', changes: [{ path: 'AGENTS.md' }] })
  assert.ok(a !== undefined && b !== undefined)
  assert.equal(clusterAdjacentAmbientContext([a, b]).clusters.length, 0, 'future forms never cluster')
})

// --- 4.2 legacy recall fallback -------------------------------------------

test('a legacy session-reference stays recall with a missing, matching or unknown form', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['no form', { kind: 'session-reference', references: [{ label: 'prior work' }] }],
    ['form recall', { kind: 'session-reference', form: 'recall', references: [{ label: 'prior work' }] }],
    ['unknown form', { kind: 'session-reference', form: 'future-form-v9', references: [{ label: 'prior work' }] }],
  ]
  for (const [name, source] of cases) {
    const row = foldSource(source)
    assert.ok(row !== undefined, `${name}: folds`)
    assert.equal(isRecallContext(row), true, `${name}: recall role survives`)
    assert.equal(contextPresentationKind(row), 'recall', `${name}: presents as recall`)
    assert.equal(isAmbientContext(row), false, `${name}: never ambient`)
  }
})

// --- 4.4 malformed Notice --------------------------------------------------

function noticeFrom(source: unknown): SystemRow {
  const row = foldSource(source)
  assert.ok(row !== undefined && row.kind === 'system', 'fixture: notice folds')
  return row
}

test('a valid producer notice summary survives; missing/empty/non-string never fabricates one', () => {
  const valid = noticeFrom({ kind: 'subagent-settled', form: 'notice', summary: 'child completed', senderSessionId: 'child-9' })
  assert.equal(valid.summary, 'child completed')
  assert.equal(valid.contextPresentation?.form, 'notice')
  assert.equal(valid.contextPresentation?.senderSessionId, 'child-9')

  for (const source of [
    { kind: 'subagent-settled', form: 'notice' },
    { kind: 'subagent-settled', form: 'notice', summary: '' },
    { kind: 'subagent-settled', form: 'notice', summary: 42 },
  ]) {
    const row = noticeFrom(source)
    assert.equal(row.summary, undefined, 'an invalid summary is never invented')
    assert.equal(isNoticeContext(row), true, 'the row is still a standalone notice')
  }
})

test('a legacy >120-char notice summary is tolerated, not rejected', () => {
  const long = `background job finished: ${'detail '.repeat(30)}`
  assert.ok(long.length > 120)
  const row = noticeFrom({ kind: 'subagent-settled', form: 'notice', summary: long })
  assert.equal(row.summary, long)
  const rows = new NoticeContextRow({ message: row, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.equal(rows.length > 1, true, 'the long summary wraps rather than being dropped')
})

test('a no-summary / malformed-payload notice renders its standalone header and never crashes', () => {
  // No producer label and no summary: the header degrades to the generic
  // "Notice" title with no fabricated preview.
  const bare = systemRow({ text: 'the only payload', contextPresentation: { form: 'notice', sourceKind: 'subagent-settled', role: 'inject' } })
  const collapsed = new NoticeContextRow({ message: bare, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(80)
  assert.equal(collapsed.length, 1, 'header only, no fabricated preview')
  assert.match(plain(collapsed[0]!), /Notice/)
  assert.ok(!plain(collapsed[0]!).includes('the only payload'), 'the payload is never used as the preview')

  for (const payload of ['<skill><broken>', '<?xml version="1.0"?><unclosed>', '\u0000\u0001 control bytes']) {
    const row: SystemRow = { ...bare, text: payload }
    assert.doesNotThrow(() =>
      new NoticeContextRow({ message: row, expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(40))
  }
})

// --- 4.5 malformed Relay ---------------------------------------------------

test('a relay without a sender is readable and never invents an identity', () => {
  for (const source of [
    { kind: 'agent-message', form: 'relay' },
    { kind: 'agent-message', form: 'relay', senderSessionId: '' },
    { kind: 'agent-message', form: 'relay', senderSessionId: 9 },
  ]) {
    const row = foldSource(source)
    assert.ok(row !== undefined && row.kind === 'system', 'relay folds')
    assert.equal(row.contextPresentation?.senderSessionId, undefined, 'no sender is invented')
    assert.equal(isRelayContext(row), true)
    const rows = new RelayContextRow({
      message: row, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji',
      geometry: { thresholdRows: 10, headRows: 4, tailRows: 3 },
    }).render(80)
    assert.match(plain(rows[0]!), /Agent message$/, 'the header degrades to a bare Agent message with no sender')
    assert.ok(rows.length >= 1)
  }
})

test('a long CJK/emoji relay body keeps the shared geometry and never exceeds the width', () => {
  const body = Array.from({ length: 30 }, (_, index) => `第${index}行中文内容与表情 🐋🐳 混排`).join(' ')
  const row = systemRow({
    text: body, label: 'agent-message', icon: 'context-generic',
    contextPresentation: { form: 'relay', sourceKind: 'agent-message', senderSessionId: 'child-2', role: 'inject' },
  })
  const geometry = { thresholdRows: 4, headRows: 3, tailRows: 4 }
  for (const width of [1, 2, 3, 8, 20, 40, 80]) {
    const rows = new RelayContextRow({ message: row, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry }).render(width)
    for (const rendered of rows) {
      assert.ok(visibleWidth(rendered) <= width, `width ${width} overflowed: ${JSON.stringify(rendered)}`)
    }
  }
  const wide = new RelayContextRow({ message: row, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry }).render(60)
  assert.ok(plain(wide[0]!).includes('to expand'), 'the long body is compacted behind the shared affordance')
  assert.ok(plain(wide.join(' ')).includes('第29行'), 'the shared geometry keeps the tail')
})

// --- 4.6 ambient labels ----------------------------------------------------

function ambientRow(turn: number, label: string | undefined, form: 'instructions' | 'catalog' | 'snapshot' = 'instructions'): SystemRow {
  return systemRow({
    turn,
    text: 'ambient body',
    ...label === undefined ? {} : { label },
    contextPresentation: { form, sourceKind: 'agent-instructions', role: 'inject' },
  })
}

test('the cluster summary uses structured provenance only, in deterministic first-seen order', () => {
  const rows = [
    ambientRow(0, 'AGENTS.md'),
    ambientRow(0, 'AGENTS.md'),
    ambientRow(0, undefined),
    ambientRow(0, 'skill catalog', 'catalog'),
    ambientRow(0, '中文标签'),
    ambientRow(0, '🏷️ 标签'),
  ]
  const { clusters } = clusterAdjacentAmbientContext(rows)
  assert.equal(clusters.length, 1)
  const parts = contextClusterSummaryParts(clusters[0]!)
  assert.deepEqual(parts, ['AGENTS.md ×2', 'instructions', 'skill catalog', '中文标签', '🏷️ 标签'])
  // Deterministic: the same input yields the same output.
  assert.deepEqual(contextClusterSummaryParts(clusters[0]!), parts)
  // Presentation-only compression never drops a member.
  assert.equal(clusters[0]!.members.length, 6)
  assert.equal(new Set(clusters[0]!.members).size, 6, 'every member stays a distinct TranscriptMessage')
})

test('the same label across different ambient forms compresses for display but keeps exact members', () => {
  const a = ambientRow(0, 'shared', 'instructions')
  const b = ambientRow(0, 'shared', 'catalog')
  const c = ambientRow(0, 'shared', 'snapshot')
  const { clusters } = clusterAdjacentAmbientContext([a, b, c])
  assert.deepEqual(contextClusterSummaryParts(clusters[0]!), ['shared ×3'])
  assert.deepEqual(clusters[0]!.members, [a, b, c], 'expanded members remain exact and separate')
})

test('a very long / empty ambient label degrades without breaking the collapsed row', () => {
  const long = 'x'.repeat(500)
  const rows = [ambientRow(0, long), ambientRow(0, '')]
  const { clusters } = clusterAdjacentAmbientContext(rows)
  assert.equal(clusters.length, 1)
  // An empty label falls back to the declared form; the long label is kept
  // exact in the model (only the rendered row is clipped).
  assert.deepEqual(contextClusterSummaryParts(clusters[0]!), [long, 'instructions'])
})

// --- width / grapheme sweep for the standalone rows (Track E overlap) -------

test('standalone Context rows obey the width contract across the full sweep', () => {
  const notice = noticeFrom({ kind: 'subagent-settled', form: 'notice', summary: '完成 ✅ with a mixing of widths 🐋 and ASCII' })
  const relay = systemRow({
    text: 'relay body 中文 🐋 mixed with ascii and a combining accent e\u0301',
    contextPresentation: { form: 'relay', sourceKind: 'agent-message', senderSessionId: '会话-1', role: 'inject' },
  })
  const recall = systemRow({
    text: 'recall payload 中文 🐋', label: '标签 🏷️',
    contextPresentation: { form: 'recall', sourceKind: 'session-reference', role: 'recall' },
  })
  const geometry = { thresholdRows: 2, headRows: 1, tailRows: 1 }
  for (const width of [1, 2, 3, 4, 5, 8, 10, 20, 40, 80, 120]) {
    const batches: readonly string[][] = [
      new NoticeContextRow({ message: notice, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width),
      new NoticeContextRow({ message: notice, expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width),
      new RelayContextRow({ message: relay, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry }).render(width),
      new RelayContextRow({ message: relay, expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji', geometry }).render(width),
      new RecallContextRow({ message: recall, expanded: false, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width),
      new RecallContextRow({ message: recall, expanded: true, expandHint: 'ctrl+o', iconStyle: 'emoji' }).render(width),
    ]
    for (const rows of batches) {
      for (const rendered of rows) {
        assert.ok(visibleWidth(rendered) <= width, `width ${width} overflowed: ${JSON.stringify(rendered)}`)
      }
    }
  }
})
