/**
 * Headless tests for the diff engine: LCS alignment, context clustering,
 * fold capping, and the create/delete special cases.
 * @module @xmoon76/dsh-pi-tui/diff.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { computeDiffLines, renderDiffView, type AnchoredFileDiff } from '../src/diff.ts'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')

test('computeDiffLines aligns a replacement with context and line numbers', () => {
  const lines = computeDiffLines('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne')
  assert.deepEqual(lines.map(line => line.kind), ['context', 'delete', 'add', 'context', 'context', 'context'])
  const changed = lines.filter(line => line.kind !== 'context')
  assert.deepEqual(changed, [
    { kind: 'delete', lineNum: 2, code: 'b' },
    { kind: 'add', lineNum: 2, code: 'B' },
  ])
})

test('computeDiffLines handles insertions, deletions, and identical input', () => {
  // Insertion: one new line in the middle.
  const inserted = computeDiffLines('a\nc', 'a\nb\nc')
  assert.deepEqual(inserted.filter(line => line.kind !== 'context'), [{ kind: 'add', lineNum: 2, code: 'b' }])
  // Deletion: one removed line.
  const deleted = computeDiffLines('a\nb\nc', 'a\nc')
  assert.deepEqual(deleted.filter(line => line.kind !== 'context'), [{ kind: 'delete', lineNum: 2, code: 'b' }])
  // Identical: all context.
  const same = computeDiffLines('a\nb', 'a\nb')
  assert.ok(same.every(line => line.kind === 'context'))
  assert.equal(same.length, 2)
})

test('computeDiffLines degrades to a naive listing on very large input', () => {
  const oldText = Array.from({ length: 1200 }, (_, i) => `old ${i}`).join('\n')
  const newText = Array.from({ length: 1200 }, (_, i) => `new ${i}`).join('\n')
  const lines = computeDiffLines(oldText, newText)
  // 1200 + 1200 exceeds the LCS threshold: no context rows, all deletes then adds.
  assert.equal(lines.filter(line => line.kind === 'context').length, 0)
  assert.equal(lines.filter(line => line.kind === 'delete').length, 1200)
  assert.equal(lines.filter(line => line.kind === 'add').length, 1200)
})

test('renderDiffView emits the +N -M header with the relativized path', () => {
  const lines = renderDiffView(
    [{ path: '/ws/src/foo.ts', oldText: 'a\nb', newText: 'a\nB' }],
    '/ws',
  ).map(strip)
  assert.equal(lines[0], '+1 -1 src/foo.ts')
  assert.ok(lines.some(line => line.includes('- b')), `delete row missing:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.includes('+ B')), `add row missing:\n${lines.join('\n')}`)
})

test('renderDiffView clusters changes and elides unchanged middle runs', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const newText = Array.from({ length: 20 }, (_, i) => (i === 2 ? `line ${i} CHANGED` : i === 17 ? `line ${i} CHANGED` : `line ${i}`)).join('\n')
  const lines = renderDiffView([{ path: 'f.ts', oldText, newText }]).map(strip)
  assert.ok(lines.some(line => line.startsWith('… ') && line.includes('unchanged line')), `elision missing:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.includes('+ line 2 CHANGED')), `first change missing:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.includes('+ line 17 CHANGED')), `second change missing:\n${lines.join('\n')}`)
})

test('renderDiffView caps the body and appends a hidden-changes footer', () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `old ${i}`).join('\n')
  const newText = Array.from({ length: 40 }, (_, i) => `new ${i}`).join('\n')
  const lines = renderDiffView([{ path: 'f.ts', oldText, newText }], undefined, { maxLines: 10 }).map(strip)
  const body = lines.slice(1)
  assert.ok(body.length <= 10 + 1, `capped body too tall:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.includes('more changes hidden (click to expand)')), `footer missing:\n${lines.join('\n')}`)
})

test('renderDiffView shows only new lines for a create and only old lines for a deletion', () => {
  const created = renderDiffView([{ path: 'new.ts', oldText: null, newText: 'x\ny' }]).map(strip)
  assert.equal(created[0], '+2 new.ts')
  assert.ok(!created.some(line => line.startsWith('- ')), `create must not render deletions:\n${created.join('\n')}`)
  const deleted = renderDiffView([{ path: 'gone.ts', oldText: 'x\ny', newText: '' }]).map(strip)
  assert.equal(deleted[0], '-2 gone.ts')
  assert.ok(!deleted.some(line => line.startsWith('+ ')), `deletion must not render additions:\n${deleted.join('\n')}`)
})

// ── absolute line-number anchors (plan: hide the gutter, never guess) ───

/** Whether a rendered body row carries a gutter (a padded absolute line
 * number before the diff marker). */
function hasGutter(line: string): boolean {
  return /^\s*\d+\s/.test(line)
}

test('no anchor: the body renders WITHOUT a fake absolute gutter (Case A)', () => {
  const lines = renderDiffView([{ path: 'foo.ts', oldText: 'a\nold\nc', newText: 'a\nnew\nc' }]).map(strip)
  assert.equal(lines[0], '+1 -1 foo.ts', 'the +N -M header stays')
  assert.ok(lines.some(line => line.includes('- old')), `delete row missing:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.includes('+ new')), `add row missing:\n${lines.join('\n')}`)
  const body = lines.slice(1)
  assert.ok(!body.some(hasGutter),
    `a hunk without anchors must never render a fake absolute gutter:\n${lines.join('\n')}`)
})

test('with anchors: the real absolute line numbers render (Case B)', () => {
  const lines = renderDiffView([{
    path: 'foo.ts',
    oldText: 'a\nold\nc',
    newText: 'a\nnew\nc',
    oldStart: 830,
    newStart: 830,
  } as AnchoredFileDiff]).map(strip)
  assert.equal(lines[0], '+1 -1 foo.ts')
  const deleteRow = lines.find(line => line.includes('- old'))
  const addRow = lines.find(line => line.includes('+ new'))
  assert.ok(deleteRow !== undefined && hasGutter(deleteRow), `anchored delete must carry a gutter:\n${lines.join('\n')}`)
  assert.ok(addRow !== undefined && hasGutter(addRow), `anchored add must carry a gutter:\n${lines.join('\n')}`)
  // LCS alignment: context 'a' = 830, the delete is the OLD side line 831,
  // the add the NEW side line 831, the trailing context 'c' advances to 832.
  assert.match(deleteRow, /^\s*831\s+- old/, `old-side anchor wrong: ${deleteRow}`)
  assert.match(addRow, /^\s*831\s+\+ new/, `new-side anchor wrong: ${addRow}`)
  const contextRow = lines.find(line => line.includes('  c'))
  assert.ok(contextRow !== undefined && /^\s*832\s+/.test(contextRow), `context must advance past the anchor: ${contextRow}`)
})

test('anchors are validated: a missing or malformed anchor falls back to no gutter', () => {
  const base = { path: 'foo.ts', oldText: 'a\nold\nc', newText: 'a\nnew\nc' }
  for (const hunk of [
    { ...base, oldStart: 0, newStart: 0 },
    { ...base, oldStart: 1.5, newStart: 1 },
    { ...base, oldStart: 1 },
    { ...base, oldStart: 1, newStart: undefined },
  ]) {
    const lines = renderDiffView([hunk]).map(strip)
    assert.ok(!lines.slice(1).some(hasGutter),
      `malformed anchors must not render a gutter: ${JSON.stringify(hunk)}\n${lines.join('\n')}`)
  }
})

test('create/delete with anchors: only the present side gets real numbers (Cases C/D)', () => {
  const created = renderDiffView([{ path: 'new.ts', oldText: null, newText: 'x\ny', oldStart: 1, newStart: 40 } as AnchoredFileDiff]).map(strip)
  assert.equal(created[0], '+2 new.ts')
  assert.ok(created.some(line => /^\s*40\s+\+ x/.test(line)), `create new-side anchor missing:\n${created.join('\n')}`)
  assert.ok(created.some(line => /^\s*41\s+\+ y/.test(line)), `create new-side advance missing:\n${created.join('\n')}`)
  const deleted = renderDiffView([{ path: 'gone.ts', oldText: 'x\ny', newText: '', oldStart: 77, newStart: 1 } as AnchoredFileDiff]).map(strip)
  assert.equal(deleted[0], '-2 gone.ts')
  assert.ok(deleted.some(line => /^\s*77\s+- x/.test(line)), `delete old-side anchor missing:\n${deleted.join('\n')}`)
  assert.ok(deleted.some(line => /^\s*78\s+- y/.test(line)), `delete old-side advance missing:\n${deleted.join('\n')}`)
})

test('no anchor: create/delete render no gutter at all (Cases C/D)', () => {
  const created = renderDiffView([{ path: 'new.ts', oldText: null, newText: 'x\ny' }]).map(strip)
  assert.ok(!created.slice(1).some(hasGutter), `create without anchors must not render a gutter:\n${created.join('\n')}`)
  const deleted = renderDiffView([{ path: 'gone.ts', oldText: 'x\ny', newText: '' }]).map(strip)
  assert.ok(!deleted.slice(1).some(hasGutter), `delete without anchors must not render a gutter:\n${deleted.join('\n')}`)
})

test('anchored elision and truncation footers align with the gutter column', () => {
  const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const newText = Array.from({ length: 20 }, (_, i) => (i === 2 ? `line ${i} CHANGED` : i === 17 ? `line ${i} CHANGED` : `line ${i}`)).join('\n')
  const anchored = renderDiffView([{ path: 'f.ts', oldText, newText, oldStart: 100, newStart: 100 } as AnchoredFileDiff]).map(strip)
  assert.ok(anchored.some(line => line.startsWith('     … ') && line.includes('unchanged line')),
    `anchored elision must keep the gutter-column indent:\n${anchored.join('\n')}`)
  const plain = renderDiffView([{ path: 'f.ts', oldText, newText }]).map(strip)
  assert.ok(plain.some(line => line.startsWith('… ') && line.includes('unchanged line')),
    `unanchored elision must start at column 0:\n${plain.join('\n')}`)
})
