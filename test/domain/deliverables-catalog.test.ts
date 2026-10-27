/**
 * Delivered-files catalog unit tests (Delivered files PR1 / M1): the pure
 * projection from one full grouped transcript projection to the delivered
 * Turns, the display-label disambiguation, and the declared-set filter.
 *
 * The Fold's own attribution/de-duplication rules stay covered by
 * `test/tui/deliverables.test.ts`; this module must never reinterpret them.
 * @module @xmoon76/dsh-pi-tui/domain/deliverables-catalog.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PresentedFilePresentation, TranscriptMessage } from '../../src/transcript.ts'
import {
  deliveredDisplayPath,
  deliveredFileBasename,
  deliveredFileLabels,
  deliveredTurnsOf,
  filterDeliveredFiles,
} from '../../src/domain/deliverables/catalog.ts'

function file(path: string, description?: string): PresentedFilePresentation {
  return description === undefined ? { path } : { path, description }
}

function assistant(turn: number, text: string, deliverables?: readonly PresentedFilePresentation[]): TranscriptMessage {
  return deliverables === undefined
    ? { kind: 'assistant', turn, text }
    : { kind: 'assistant', turn, text, deliverables }
}

test('no delivered Assistant yields no Turns', () => {
  assert.deepEqual(deliveredTurnsOf([]), [])
  assert.deepEqual(deliveredTurnsOf([
    { kind: 'user', turn: 1, text: 'hello' },
    assistant(1, 'plain answer'),
    { kind: 'system', turn: 1, text: 'context' },
  ]), [])
})

test('an empty declaration array is not a delivery', () => {
  assert.deepEqual(deliveredTurnsOf([assistant(1, 'answer', [])]), [])
})

test('one Turn yields one entry in fold order', () => {
  const messages = [assistant(3, 'done', [file('/w/report.md', 'Final analysis'), file('/w/config.yaml')])]
  assert.deepEqual(deliveredTurnsOf(messages), [
    { turn: 3, files: [file('/w/report.md', 'Final analysis'), file('/w/config.yaml')] },
  ])
})

test('Turns are newest first by numeric turn, not by file count or position', () => {
  const messages = [
    assistant(2, 'two', [file('/w/two.md')]),
    assistant(10, 'ten', [file('/w/a.md'), file('/w/b.md'), file('/w/c.md')]),
    assistant(3, 'three', [file('/w/three.md'), file('/w/three2.md')]),
  ]
  assert.deepEqual(deliveredTurnsOf(messages).map(entry => entry.turn), [10, 3, 2])
  assert.deepEqual(deliveredTurnsOf(messages).map(entry => entry.files.length), [3, 2, 1])
})

test('only the structurally last delivered Assistant row of one Turn is adopted', () => {
  const first = assistant(4, 'first', [file('/w/old.md')])
  const closing = assistant(4, 'closing', [file('/w/final.md', 'Final')])
  assert.deepEqual(deliveredTurnsOf([first, closing]), [
    { turn: 4, files: [file('/w/final.md', 'Final')] },
  ])
  // A later NON-delivered Assistant row does not erase the delivery.
  assert.deepEqual(deliveredTurnsOf([first, closing, assistant(4, 'after')]), [
    { turn: 4, files: [file('/w/final.md', 'Final')] },
  ])
})

test('non-Assistant rows never contribute a delivery', () => {
  const messages: TranscriptMessage[] = [
    assistant(1, 'closing', [file('/w/a.md')]),
    // A tool card whose `present` output LOOKS like a file list must never
    // become a delivery: only the durable fold attaches deliverables.
    { kind: 'tool', turn: 2, name: 'present', args: '{}', result: 'Report at /w/b.md', status: 'ok' },
    { kind: 'user', turn: 2, text: 'here: /w/c.md' },
    { kind: 'summary', text: 'older turns collapsed' },
  ]
  assert.deepEqual(deliveredTurnsOf(messages).map(entry => entry.turn), [1])
})

test('the source projection is not mutated', () => {
  const messages = [assistant(2, 'two', [file('/w/b.md')]), assistant(1, 'one', [file('/w/a.md')])]
  const snapshot = JSON.stringify(messages)
  deliveredTurnsOf(messages)
  assert.equal(JSON.stringify(messages), snapshot)
})

test('labels use the basename unless the delivery repeats it', () => {
  const files = [
    file('/w/report.md'),
    file('/w/other.md'),
    file('/w/config.yaml'),
  ]
  assert.deepEqual(deliveredFileLabels(files), ['report.md', 'other.md', 'config.yaml'])
})

test('colliding basenames grow the shortest distinguishing directory suffix', () => {
  const files = [
    file('/w/docs/report.md'),
    file('/w/output/report.md'),
    file('/w/archive/report.md'),
    file('/w/unique.md'),
  ]
  assert.deepEqual(deliveredFileLabels(files), [
    'docs/report.md',
    'output/report.md',
    'archive/report.md',
    'unique.md',
  ])
})

test('deep collisions grow only as far as needed, and identical paths stay a basename', () => {
  const files = [
    file('/w/2026/q1/final/report.md'),
    file('/w/2026/q2/final/report.md'),
    file('/w/2026/q3/final/notes.md'),
    file('/w/2026/q3/final/notes.md'),
  ]
  assert.deepEqual(deliveredFileLabels(files), [
    'q1/final/report.md',
    'q2/final/report.md',
    'notes.md',
    // Two verbatim-identical declarations cannot be told apart by the path; the
    // ordinal pass is the ONE honest visible device (the Fold normally dedupes).
    'notes.md (2)',
  ])
})

test('basename resolves windows separators and trailing separators', () => {
  assert.equal(deliveredFileBasename('C:\\work\\report.md'), 'report.md')
  assert.equal(deliveredFileBasename('/work/report.md'), 'report.md')
  assert.equal(deliveredFileBasename('report.md'), 'report.md')
  assert.equal(deliveredFileBasename('/work/dir/'), 'dir')
})

test('an empty filter returns the input unchanged', () => {
  const files = [file('/w/a.md'), file('/w/b.md')]
  assert.equal(filterDeliveredFiles(files, ''), files)
  assert.equal(filterDeliveredFiles(files, '   '), files)
})

test('the filter matches basename, full path and description, case-insensitively', () => {
  const files = [
    file('/w/docs/Report-Final.md', 'Quarterly summary'),
    file('/w/output/data.csv', 'STATISTICS'),
    file('/w/notes.txt'),
  ]
  assert.deepEqual(filterDeliveredFiles(files, 'report'), [files[0]])
  assert.deepEqual(filterDeliveredFiles(files, 'OUTPUT/DATA'), [files[1]])
  assert.deepEqual(filterDeliveredFiles(files, 'quarterly'), [files[0]])
  assert.deepEqual(filterDeliveredFiles(files, 'statistics'), [files[1]])
  assert.deepEqual(filterDeliveredFiles(files, 'zzz'), [])
  assert.deepEqual(filterDeliveredFiles(files, '  '), files)
})

test('the filter preserves the declaration order and object identity', () => {
  const files = [file('/w/b-report.md'), file('/w/a-report.md'), file('/w/c.md')]
  const filtered = filterDeliveredFiles(files, 'report')
  assert.deepEqual(filtered.map(entry => entry.path), ['/w/b-report.md', '/w/a-report.md'])
  assert.equal(filtered[0], files[0])
  assert.equal(filtered[1], files[1])
})

test('the filter is locale-neutral and handles CJK, spaces and special characters', () => {
  const files = [
    file('/w/报告 最终.md', '季度总结'),
    file('/w/a(1).md', 'alpha [draft]'),
    file('/w/Plain.MD'),
  ]
  assert.deepEqual(filterDeliveredFiles(files, '报告'), [files[0]])
  assert.deepEqual(filterDeliveredFiles(files, '季度'), [files[0]])
  assert.deepEqual(filterDeliveredFiles(files, '(1)'), [files[1]])
  assert.deepEqual(filterDeliveredFiles(files, '[draft]'), [files[1]])
  assert.deepEqual(filterDeliveredFiles(files, 'plain.md'), [files[2]])
})

test('collision labels are derived from the PROJECTED text, not the raw bytes', async () => {
  const { sanitizeDisplaySegment } = await import('../../src/tui/presentation/terminal-text.ts')
  const hostile = 'report\u001b]52;c;YQ==\u0007.md'
  const files = [file(`/a/${hostile}`), file('/b/report.md')]
  // Raw comparison: the two basenames differ (the control bytes are part of the
  // raw string), so no directory suffix is added.
  assert.deepEqual(deliveredFileLabels(files), [hostile, 'report.md'])
  // Projected comparison: both PAINT as `report.md`, so the visible labels must
  // stay distinguishable. The raw paths remain the copy/search authority.
  const projected = deliveredFileLabels(files, { project: sanitizeDisplaySegment })
  assert.deepEqual(projected, ['a/report.md', 'b/report.md'])
  assert.notEqual(projected[0], projected[1])
  assert.equal(files[0]!.path, `/a/${hostile}`, 'the raw declaration is untouched')
})

test('projected-empty names never fall back to the raw path and stay distinguishable', async () => {
  const { sanitizeDisplaySegment } = await import('../../src/tui/presentation/terminal-text.ts')
  const red = '/a/report\u001b[31m'
  const green = '/a/report\u001b[32m'
  const files = [file(red), file(green), file('/a/report.md')]
  const labels = deliveredFileLabels(files, { project: sanitizeDisplaySegment })
  // The two control-only names project to the SAME visible path (`a/report`), so
  // the ordinal pass keeps them apart; the third file keeps its own basename.
  assert.deepEqual(labels, ['report', 'report (2)', 'report.md'])
  for (const label of labels) {
    assert.ok(!label.includes('\u001b'), `no control byte may survive in a label: ${JSON.stringify(label)}`)
    assert.ok(label !== '', 'no label may be empty')
  }
  // A path that projects to NOTHING is still a presentable row.
  assert.deepEqual(deliveredFileLabels([file('\u001b[31m')], { project: sanitizeDisplaySegment }), ['(unnamed)'])
  // Raw declarations are never rewritten.
  assert.equal(files[0]!.path, red)
  assert.equal(files[1]!.path, green)
})

test('a generated ordinal never steals a label another declaration naturally has', async () => {
  const { sanitizeDisplaySegment } = await import('../../src/tui/presentation/terminal-text.ts')
  // Two declarations collapse to `report` after projection, and a THIRD one
  // naturally carries `report (2)`.
  const files = [
    file('/a/report\u001b[31m'),
    file('/a/report\u001b[32m'),
    file('/b/report (2)'),
  ]
  const labels = deliveredFileLabels(files, { project: sanitizeDisplaySegment })
  assert.equal(new Set(labels).size, labels.length, `the final labels must be globally unique: ${JSON.stringify(labels)}`)
  assert.deepEqual(labels, ['report', 'report (3)', 'report (2)'])
  // The natural label is never rewritten; the duplicate takes the next free
  // ordinal instead.
  assert.equal(labels[2], 'report (2)')
  // RAW declarations remain the Copy/search authority.
  assert.deepEqual(files.map(entry => entry.path), ['/a/report\u001b[31m', '/a/report\u001b[32m', '/b/report (2)'])
})


test('deliveredDisplayPath keeps an absolute outside-root path verbatim, including ..', () => {
  assert.equal(deliveredDisplayPath('/ws/docs/report.md', '/ws'), 'docs/report.md')
  assert.equal(deliveredDisplayPath('/ws/docs/../report.md', '/ws'), 'report.md')
  assert.equal(deliveredDisplayPath('/ws/../ws/docs/report.md', '/ws'), 'docs/report.md')
  assert.equal(deliveredDisplayPath('/ws/../outside/report.md', '/ws'), '/ws/../outside/report.md')
  assert.equal(deliveredDisplayPath('/outside/report.md', '/ws'), '/outside/report.md')
  assert.equal(deliveredDisplayPath('/WS/report.md', '/ws'), '/WS/report.md')
  assert.equal(deliveredDisplayPath('/ws/..', '/ws'), '/ws/..')
  assert.equal(deliveredDisplayPath('/ws', '/ws'), '/ws')
  assert.equal(deliveredDisplayPath('/ws/report.md', '/ws/'), 'report.md')
  assert.equal(deliveredDisplayPath('/ws/report.md', undefined), '/ws/report.md')
  assert.equal(deliveredDisplayPath('/ws/report.md', ''), '/ws/report.md')
  assert.equal(deliveredDisplayPath('docs/report.md', '/ws'), 'docs/report.md')
  assert.equal(deliveredDisplayPath('../outside/report.md', '/ws'), '../outside/report.md')
})

test('deliveredDisplayPath applies the same lexical containment to Windows and mixed separators', () => {
  assert.equal(deliveredDisplayPath('C:\\ws\\docs\\report.md', 'C:\\ws'), 'docs/report.md')
  assert.equal(deliveredDisplayPath('C:\\ws\\..\\outside\\report.md', 'C:\\ws'), 'C:\\ws\\..\\outside\\report.md')
  assert.equal(deliveredDisplayPath('C:/ws/docs/report.md', 'C:\\ws'), 'docs/report.md')
  assert.equal(deliveredDisplayPath('C:\\ws\\docs/../report.md', 'C:\\ws'), 'report.md')
  assert.equal(deliveredDisplayPath('C:\\other\\report.md', 'C:\\ws'), 'C:\\other\\report.md')
  assert.equal(deliveredDisplayPath('/ws\\docs\\report.md', '/ws'), 'docs/report.md')
})
