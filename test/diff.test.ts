/**
 * Headless tests for the diff engine: the DSH 0.1.6 bounded contextual patch
 * derivation (`structuredPatch`, `context: 3`, `maxEditLength: 256`), the
 * coarse whole-fragment fallback past the bound, context/gap rendering, fold
 * capping, the create/delete cases, and the absolute-anchor gutter rule.
 * @module @xmoon76/dsh-pi-tui/diff.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DIFF_CONTEXT_LINES, MAX_DIFF_EDIT_LENGTH, renderDiffView, summarizeDiffs, type AnchoredFileDiff } from '../src/diff.ts'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')

/** Lines `prefix 0 .. prefix n-1`. */
const lines = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix} ${i}`)

/** A one-to-one replacement fixture with a leading shared context line. */
function replacementFragment(count: number): { path: string; oldText: string; newText: string } {
  return {
    path: 'f.ts',
    oldText: ['shared', ...lines('old', count)].join('\n'),
    newText: ['shared', ...lines('new', count)].join('\n'),
  }
}

test('the bounded edit search is the official 0.1.6 contract', () => {
  assert.equal(MAX_DIFF_EDIT_LENGTH, 256)
  assert.equal(DIFF_CONTEXT_LINES, 3)
})

// ── exact contextual patches ───────────────────────────────────────────────

test('a single-line replacement is +1/-1 and never counts shared context', () => {
  const diffs = [{ path: 'f.ts', oldText: 'a\nb\nc\nd\ne', newText: 'a\nB\nc\nd\ne' }]
  assert.deepEqual(summarizeDiffs(diffs), { added: 1, removed: 1 })
  const body = renderDiffView(diffs, undefined, { headerMode: 'none' }).map(strip)
  assert.equal(body.filter(line => line.startsWith('- ')).length, 1)
  assert.equal(body.filter(line => line.startsWith('+ ')).length, 1)
  assert.equal(body.filter(line => line.startsWith('  ')).length, 4, 'shared context renders once and is not counted')
})

test('an exact change keeps exactly three context lines per side', () => {
  const oldText = lines('line', 20).join('\n')
  const newText = lines('line', 20).map((line, i) => (i === 10 ? `${line} CHANGED` : line)).join('\n')
  const body = renderDiffView([{ path: 'f.ts', oldText, newText }], undefined, { headerMode: 'none' }).map(strip)
  const context = body.filter(line => line.startsWith('  ')).map(line => line.slice(2))
  assert.deepEqual(context, ['line 7', 'line 8', 'line 9', 'line 11', 'line 12', 'line 13'])
  assert.deepEqual(body.filter(line => line.startsWith('- ')), ['- line 10'])
  assert.deepEqual(body.filter(line => line.startsWith('+ ')), ['+ line 10 CHANGED'])
})

test('insertion-only and deletion-only fragments keep exact counts', () => {
  assert.deepEqual(summarizeDiffs([{ path: 'f.ts', oldText: 'a\nc', newText: 'a\nb\nc' }]), { added: 1, removed: 0 })
  assert.deepEqual(summarizeDiffs([{ path: 'f.ts', oldText: 'a\nb\nc', newText: 'a\nc' }]), { added: 0, removed: 1 })
  assert.deepEqual(summarizeDiffs([{ path: 'f.ts', oldText: 'a\nb', newText: 'a\nb' }]), { added: 0, removed: 0 })
})

test('two distant changes are separate hunks with a 3-context gap between', () => {
  // Changes away from the file edges so both sides get their full 3 context rows.
  const oldText = lines('line', 40).join('\n')
  const newText = lines('line', 40).map((line, i) => (i === 10 || i === 30 ? `${line} CHANGED` : line)).join('\n')
  const body = renderDiffView([{ path: 'f.ts', oldText, newText }], undefined, { headerMode: 'none' }).map(strip)
  assert.ok(body.some(line => line.startsWith('… ') && line.includes('unchanged line')),
    `a gap between distant hunks is required:\n${body.join('\n')}`)
  assert.ok(body.includes('- line 10'))
  assert.ok(body.includes('+ line 10 CHANGED'))
  assert.ok(body.includes('- line 30'))
  assert.ok(body.includes('+ line 30 CHANGED'))
  assert.equal(body.filter(line => line.startsWith('  ')).length, 12, 'three context rows on each side of each change')
})

// ── content-line terminator rule ───────────────────────────────────────────

test('a trailing newline is a terminator, never a phantom blank line', () => {
  assert.deepEqual(summarizeDiffs([{ path: 'f.ts', oldText: 'a\nb\n', newText: 'a\nB\n' }]), { added: 1, removed: 1 })
  const body = renderDiffView([{ path: 'f.ts', oldText: 'a\nb\n', newText: 'a\nB\n' }], undefined, { headerMode: 'none' }).map(strip)
  assert.ok(!body.some(line => line === '  '), `no phantom blank context row:\n${JSON.stringify(body)}`)
})

test('an interior blank line survives', () => {
  const body = renderDiffView([{ path: 'f.ts', oldText: 'a\n\nb', newText: 'a\n\nB' }], undefined, { headerMode: 'none' }).map(strip)
  assert.ok(body.includes('  '), `the interior blank line must render as context:\n${JSON.stringify(body)}`)
  assert.deepEqual(summarizeDiffs([{ path: 'f.ts', oldText: 'a\n\nb', newText: 'a\n\nB' }]), { added: 1, removed: 1 })
})

test('empty text is zero lines (create and full deletion)', () => {
  assert.deepEqual(summarizeDiffs([{ path: 'new.ts', oldText: null, newText: 'x\ny' }]), { added: 2, removed: 0 })
  assert.deepEqual(summarizeDiffs([{ path: 'gone.ts', oldText: 'x\ny', newText: '' }]), { added: 0, removed: 2 })
  const created = renderDiffView([{ path: 'new.ts', oldText: null, newText: 'x\ny' }]).map(strip)
  assert.equal(created[0], '+2 new.ts')
  assert.ok(!created.some(line => line.startsWith('- ')), `create must not render deletions:\n${created.join('\n')}`)
  const deleted = renderDiffView([{ path: 'gone.ts', oldText: 'x\ny', newText: '' }]).map(strip)
  assert.equal(deleted[0], '-2 gone.ts')
  assert.ok(!deleted.some(line => line.startsWith('+ ')), `deletion must not render additions:\n${deleted.join('\n')}`)
})

// ── sparse edits stay exact regardless of total file size ──────────────────

test('one sparse replacement in 10,000 lines stays exact (no whole-file fallback)', () => {
  const oldLines = lines('line', 10_000)
  const newLines = oldLines.map((line, i) => (i === 5_000 ? `${line} CHANGED` : line))
  const diffs = [{ path: 'big.ts', oldText: oldLines.join('\n'), newText: newLines.join('\n') }]
  assert.deepEqual(summarizeDiffs(diffs), { added: 1, removed: 1 })
  const body = renderDiffView(diffs, undefined, { headerMode: 'none' }).map(strip)
  assert.ok(body.includes('- line 5000'))
  assert.ok(body.includes('+ line 5000 CHANGED'))
  assert.ok(!body.some(line => line.includes('- line 4999')), `a neighbouring line must stay context:\n${body.slice(0, 8).join('\n')}`)
})

test('100 sparse replacements in 10,000 lines stay exact', () => {
  const oldLines = lines('line', 10_000)
  const newLines = oldLines.map((line, i) => (i % 100 === 0 ? `${line} CHANGED` : line))
  const diffs = [{ path: 'big.ts', oldText: oldLines.join('\n'), newText: newLines.join('\n') }]
  assert.deepEqual(summarizeDiffs(diffs), { added: 100, removed: 100 })
})

// ── the 128/129 bounded edit-search boundary ───────────────────────────────

test('a 256-edit comparison stays exact; one edit past it is a coarse replacement', () => {
  // One replacement consumes two edits: 128 replacements with a shared context
  // line is exactly 256 edits (exact); 129 is 258 (past the bound).
  assert.deepEqual(summarizeDiffs([replacementFragment(128)]), { added: 128, removed: 128 },
    '128 one-to-one replacements stay exact')
  assert.deepEqual(summarizeDiffs([replacementFragment(129)]), { added: 130, removed: 130 },
    'past the bound the COMPLETE fragment is replaced, shared context included')
  const coarse = renderDiffView([replacementFragment(129)], undefined, { headerMode: 'none' }).map(strip)
  assert.ok(coarse.includes('- shared'), 'the coarse fallback counts the shared line as removed')
  assert.ok(coarse.includes('+ shared'), 'the coarse fallback counts the shared line as added')
})

// ── repeated lines, multi-file, multi-hunk ─────────────────────────────────

test('repeated-line inputs produce a bounded deterministic result', () => {
  const oldText = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'old' : 'shared')).join('\n')
  const newText = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'new' : 'shared')).join('\n')
  const stats = summarizeDiffs([{ path: 'f.ts', oldText, newText }])
  assert.deepEqual(stats, { added: 20, removed: 20 })
  // Deterministic: the same input derives the same totals.
  assert.deepEqual(summarizeDiffs([{ path: 'f.ts', oldText, newText }]), stats)
})

test('multi-file and same-file multi-hunk summaries match the rendered body', () => {
  const diffs = [
    { path: 'src/foo.ts', oldText: 'same\nold', newText: 'same\nnew\nadded' },
    { path: 'src/foo.ts', oldText: 'before', newText: 'after' },
    { path: 'src/bar.ts', oldText: null, newText: 'fresh' },
  ]
  const stats = summarizeDiffs(diffs)
  assert.deepEqual(stats, { added: 4, removed: 2 })
  const rendered = renderDiffView(diffs, undefined, { headerMode: 'none' }).map(strip)
  assert.deepEqual({
    added: rendered.filter(line => line.startsWith('+ ')).length,
    removed: rendered.filter(line => line.startsWith('- ')).length,
  }, stats, 'the body and the summary must come from the same derivation')
})

test('header modes and stats-only share the rendered diff counts', () => {
  const diffs = [{ path: 'src/foo.ts', oldText: 'same\nold', newText: 'same\nnew\nadded' }]
  assert.equal(renderDiffView(diffs, undefined, { headerMode: 'stats-only' }).map(strip)[0], '+2 -1')
  assert.ok(!renderDiffView(diffs, undefined, { headerMode: 'stats-only' }).map(strip)[0]!.includes('src/foo.ts'))
  const noHeader = renderDiffView(diffs, undefined, { headerMode: 'none' }).map(strip)
  assert.ok(!noHeader.some(line => line.includes('src/foo.ts')), `body must not repeat the path:\n${noHeader.join('\n')}`)
})

// ── fold capping ───────────────────────────────────────────────────────────

test('renderDiffView caps the body and appends a hidden-changes footer', () => {
  const oldText = lines('old', 40).join('\n')
  const newText = lines('new', 40).join('\n')
  const rendered = renderDiffView([{ path: 'f.ts', oldText, newText }], undefined, { maxLines: 10 }).map(strip)
  assert.ok(rendered.slice(1).length <= 11, `capped body too tall:\n${rendered.join('\n')}`)
  assert.ok(rendered.some(line => line.includes('more changes hidden (click to expand)')), `footer missing:\n${rendered.join('\n')}`)
})

test('renderDiffView marks a cap that hides context after all changes', () => {
  const oldText = ['old', 'context 1', 'context 2', 'context 3', 'context 4', 'context 5'].join('\n')
  const newText = ['new', 'context 1', 'context 2', 'context 3', 'context 4', 'context 5'].join('\n')
  const rendered = renderDiffView([{ path: 'f.ts', oldText, newText }], undefined, { maxLines: 2 }).map(strip)
  assert.ok(rendered.some(line => line.includes('more diff lines hidden (click to expand)')), `context marker missing:\n${rendered.join('\n')}`)
  assert.ok(!rendered.some(line => line.includes('0 more changes hidden')), `must not report zero hidden changes:\n${rendered.join('\n')}`)
})

test('renderDiffView does not add a marker when the body fits its cap', () => {
  const rendered = renderDiffView([{ path: 'f.ts', oldText: 'old', newText: 'new' }], undefined, { maxLines: 3 }).map(strip)
  assert.ok(!rendered.some(line => line.includes('hidden')), `unexpected truncation marker:\n${rendered.join('\n')}`)
})

test('renderDiffView ignores a trailing no-op hunk when the body cap is full', () => {
  const rendered = renderDiffView([
    { path: 'changed.ts', oldText: 'old', newText: 'new' },
    { path: 'same.ts', oldText: 'same', newText: 'same' },
  ], undefined, { maxLines: 2 }).map(strip)
  assert.ok(!rendered.some(line => line.includes('hidden')), `a no-op hunk must not trigger truncation:\n${rendered.join('\n')}`)
})

// ── absolute line-number anchors (plan: hide the gutter, never guess) ──────

/** Whether a rendered body row carries a gutter (a padded absolute line
 * number before the diff marker). */
function hasGutter(line: string): boolean {
  return /^\s*\d+\s/.test(line)
}

test('no anchor: the body renders WITHOUT a fake absolute gutter (Case A)', () => {
  const rendered = renderDiffView([{ path: 'foo.ts', oldText: 'a\nold\nc', newText: 'a\nnew\nc' }]).map(strip)
  assert.equal(rendered[0], '+1 -1 foo.ts', 'the +N -M header stays')
  assert.ok(rendered.some(line => line.includes('- old')), `delete row missing:\n${rendered.join('\n')}`)
  assert.ok(rendered.some(line => line.includes('+ new')), `add row missing:\n${rendered.join('\n')}`)
  assert.ok(!rendered.slice(1).some(hasGutter),
    `a hunk without anchors must never render a fake absolute gutter:\n${rendered.join('\n')}`)
})

test('with anchors: the real absolute line numbers render (Case B)', () => {
  const rendered = renderDiffView([{
    path: 'foo.ts',
    oldText: 'a\nold\nc',
    newText: 'a\nnew\nc',
    oldStart: 830,
    newStart: 830,
  } as AnchoredFileDiff]).map(strip)
  assert.equal(rendered[0], '+1 -1 foo.ts')
  const deleteRow = rendered.find(line => line.includes('- old'))
  const addRow = rendered.find(line => line.includes('+ new'))
  assert.ok(deleteRow !== undefined && hasGutter(deleteRow), `anchored delete must carry a gutter:\n${rendered.join('\n')}`)
  assert.ok(addRow !== undefined && hasGutter(addRow), `anchored add must carry a gutter:\n${rendered.join('\n')}`)
  // The context 'a' is old/new line 830; the delete is the OLD-side line 831,
  // the add the NEW-side line 831, the trailing context 'c' advances to 832.
  assert.match(deleteRow, /^\s*831\s+- old/, `old-side anchor wrong: ${deleteRow}`)
  assert.match(addRow, /^\s*831\s+\+ new/, `new-side anchor wrong: ${addRow}`)
  const contextRow = rendered.find(line => line.includes('  c'))
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
    const rendered = renderDiffView([hunk]).map(strip)
    assert.ok(!rendered.slice(1).some(hasGutter),
      `malformed anchors must not render a gutter: ${JSON.stringify(hunk)}\n${rendered.join('\n')}`)
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

test('anchored elision footers align with the gutter column', () => {
  const oldText = lines('line', 20).join('\n')
  const newText = lines('line', 20).map((line, i) => (i === 2 || i === 17 ? `${line} CHANGED` : line)).join('\n')
  const anchored = renderDiffView([{ path: 'f.ts', oldText, newText, oldStart: 100, newStart: 100 } as AnchoredFileDiff]).map(strip)
  assert.ok(anchored.some(line => line.startsWith('     … ') && line.includes('unchanged line')),
    `anchored elision must keep the gutter-column indent:\n${anchored.join('\n')}`)
  const plain = renderDiffView([{ path: 'f.ts', oldText, newText }]).map(strip)
  assert.ok(plain.some(line => line.startsWith('… ') && line.includes('unchanged line')),
    `unanchored elision must start at column 0:\n${plain.join('\n')}`)
})
