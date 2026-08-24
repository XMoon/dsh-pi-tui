/**
 * Responsive footer tests (plan §14.7): the composer must never overflow
 * the terminal, never break ANSI, never leave a dangling separator, never
 * let the right zone be covered by the left, drop items by importance, and
 * never crash at extreme narrow widths.
 * @module @xmoon76/dsh-pi-tui/footer-responsive.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { FooterComposer } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

const composer = new FooterComposer(createBuiltinFooterRegistry())
const CONTEXT = { editorEmpty: true, extensionFooterText: '[EXT-SEG]' }

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

/** A busy snapshot: every default item renders. */
function busySnapshot(): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.model = { provider: 'deepseek', id: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' }
  snap.access.permissionPreset = { id: 'danger-full-access', label: 'danger-full-access', matched: true }
  snap.collaboration.plan.effective = true
  snap.activity.taskCount = 2
  snap.activity.childAgentCount = 1
  snap.workspace = { cwd: '/home/xmoon/project/dsh-pi-tui', branch: 'feat/footer-customization' }
  snap.usage = {
    tokens: { input: 999_900_000, output: 999_900_000, cacheRead: 999_900_000, cacheWrite: 999_900_000 },
    cacheHitPct: 99.9,
    performance: { llmMs: 999_900, firstTokenMs: 999_900, tokensPerSec: 999 },
    turns: 12,
    steps: 38,
  }
  snap.usage.context = { usedTokens: 160000, windowTokens: 1_000_000, percent: 16 }
  return snap as StatusSnapshot
}

/** A custom layout with a right zone (the focus-mode pin). */
const RIGHT_ZONE_LAYOUT = {
  schemaVersion: 1 as const,
  rows: [{
    left: [
      { id: 'permission-preset' },
      { id: 'plan-state' },
      { id: 'model' },
      { id: 'tasks' },
      { id: 'cwd' },
      { id: 'git-branch' },
      { id: 'context', format: 'full' },
      { id: 'cache-hit' },
      { id: 'token-usage', format: 'io' },
      { id: 'performance', format: 'full' },
      { id: 'version', format: 'tui' },
    ],
    right: [{ id: 'focus-mode' }],
    separator: { text: ' │ ' },
  }],
}

const WIDTHS = [200, 160, 120, 100, 80, 60, 40, 20]

test('the default layout never overflows or breaks ANSI at any width', () => {
  const snap = busySnapshot()
  for (const width of WIDTHS) {
    const text = composer.render({ snapshot: snap, layout: { schemaVersion: 1, rows: [{ left: [
      { id: 'permission-preset' }, { id: 'plan-state' }, { id: 'model' }, { id: 'tasks' },
      { id: 'cwd' }, { id: 'git-branch' }, { id: 'context' }, { id: 'turns-steps' }, { id: 'ext:*' },
    ], right: [] }] }, width, context: CONTEXT })
    for (const row of text.split('\n')) {
      assert.ok(visibleWidth(row) <= width, `row overflows at ${width}: ${JSON.stringify(row)}`)
      // No truncated ANSI: every escape is a COMPLETE SGR sequence (the
      // composer only uses the fork's ANSI-safe helpers; chalk re-applies
      // the outer dim after inner resets — the legacy structure).
      const truncated = row.match(/\x1b\[(?:[0-9;]*[^0-9;m]|[0-9;]*$)/)
      assert.equal(truncated, null, `truncated ANSI at ${width}: ${JSON.stringify(row)}`)
    }
  }
})

test('a right zone is never covered by the left zone at any width', () => {
  const snap = busySnapshot() as DeepMutable<StatusSnapshot>
  snap.interaction.focusMode = true
  for (const width of WIDTHS) {
    const text = composer.render({ snapshot: snap, layout: RIGHT_ZONE_LAYOUT, width, context: CONTEXT })
    const rows = text.split('\n')
    assert.ok(rows.length >= 1, `no rows at ${width}`)
    // The right zone ('focus') must appear on the FIRST row and never be
    // truncated away (importance 120 — the highest).
    const first = rows[0]!
    assert.ok(first.includes('focus'), `right zone lost at ${width}: ${JSON.stringify(first)}`)
    assert.ok(visibleWidth(first) <= width, `row overflows at ${width}`)
  }
})

test('items drop by importance under pressure (the tail goes first)', () => {
  const snap = busySnapshot() as DeepMutable<StatusSnapshot>
  snap.interaction.focusMode = true
  // A narrow width with a right zone: the left zone must compact/drop the
  // LOWEST-importance items (version 10, performance 40, token-usage 50,
  // cache-hit 55...) while keeping the highest (permission 110, plan 115).
  const text = composer.render({ snapshot: snap, layout: RIGHT_ZONE_LAYOUT, width: 40, context: CONTEXT })
  assert.ok(text.includes('[yolo]'), `the highest-importance item must survive:\n${text}`)
  assert.ok(text.includes('[plan]'), `the plan badge must survive:\n${text}`)
  assert.ok(text.includes('focus'), `the right zone must survive:\n${text}`)
  // The lowest-importance items drop first.
  assert.ok(!text.includes('v0.0.0'), `the version item (importance 10) must drop first:\n${text}`)
})

test('no dangling separator: separators only join surviving items', () => {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  // Only the model renders (everything else absent) — the row must be
  // exactly the model badge, never ` │ [model]` or `[model] │ `.
  snap.composition.model = { provider: 'deepseek', id: 'flash', displayName: 'flash' }
  const text = composer.render({
    snapshot: snap,
    layout: { schemaVersion: 1, rows: [{ left: [
      { id: 'permission-preset' }, { id: 'model' }, { id: 'git-branch' },
    ], right: [], separator: { text: ' │ ' } }] },
    width: 100,
    context: CONTEXT,
  })
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  assert.equal(plain.trim(), '[deepseek/flash]', `dangling separator: ${JSON.stringify(plain)}`)
})

test('extreme narrow widths never crash and never produce negative padding', () => {
  const snap = busySnapshot()
  for (const width of [20, 10, 5, 1]) {
    const text = composer.render({ snapshot: snap, layout: RIGHT_ZONE_LAYOUT, width, context: CONTEXT })
    assert.equal(typeof text, 'string')
    for (const row of text.split('\n')) {
      assert.ok(visibleWidth(row) <= Math.max(1, width), `row overflows at ${width}`)
    }
  }
})
