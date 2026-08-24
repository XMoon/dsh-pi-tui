/**
 * M1 viewer-subject tests (plan §13.6): the footer layout does NOT change
 * when the user enters the subagent viewer — the SAME preset composes,
 * the view-scope item leads, and the data-source items (cwd/turns-steps/
 * stats-line) follow the display subject's section values. The parent's
 * model/permission/plan/task/context/branch/extension parts never leak in.
 * @module @xmoon76/dsh-pi-tui/footer-view-subject.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { FooterComposer } from '../src/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT, COMPACT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/status/types.ts'

const composer = new FooterComposer(createBuiltinFooterRegistry())
const CONTEXT = { editorEmpty: true, extensionFooterText: '[EXT]' }

/** Deep-mutable build shape (the snapshot is deeply readonly). */
type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> }

/** A parent snapshot with every main-only fact set. */
function parentSnapshot(): StatusSnapshot {
  const snap = emptyStatusSnapshot() as DeepMutable<StatusSnapshot>
  snap.composition.model = { provider: 'deepseek', id: 'parent', displayName: 'parent' }
  snap.access.permissionPreset = { id: 'danger-full-access', label: 'danger-full-access', matched: true }
  snap.collaboration.plan.effective = true
  snap.activity.taskCount = 2
  snap.workspace = { cwd: '/parent/ws', branch: 'main' }
  snap.usage = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 },
    turns: 9,
    steps: 9,
  }
  snap.usage.context = { usedTokens: 1000, windowTokens: 10000, percent: 10 }
  return snap
}

/** Switch the snapshot to the viewed child (the runner's projection). */
function enterViewer(snap: StatusSnapshot, mode: 'one-shot' | 'continuable', activity: 'running' | 'inactive'): void {
  const mutable = snap as DeepMutable<StatusSnapshot>
  mutable.view.subject = { kind: 'subagent', id: 'child-1', label: 'research', mode, activity }
  mutable.workspace = { cwd: '/child/ws', project: 'ws' }
  mutable.usage = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 12300, firstTokenMs: 0, tokensPerSec: 0 },
    turns: 3,
    steps: 5,
  }
}

test('the viewer footer composes the SAME preset with the child data (one-shot)', () => {
  const snap = parentSnapshot()
  enterViewer(snap, 'one-shot', 'inactive')
  const text = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.ok(text.includes('[subagent · one-shot]'), `viewer badge missing:\n${text}`)
  assert.ok(text.includes('research'), `child label missing:\n${text}`)
  assert.ok(text.includes('inactive'), `activity missing:\n${text}`)
  assert.ok(text.includes('ws'), `child cwd missing:\n${text}`)
  assert.ok(text.includes('t3/s5'), `child counters missing:\n${text}`)
  assert.ok(text.includes('LLM 12.3s'), `child stats line missing:\n${text}`)
  // The parent's main-only facts never leak in.
  assert.ok(!text.includes('parent'), `the parent model must not leak:\n${text}`)
  assert.ok(!text.includes('[yolo]'), `the parent permission must not leak:\n${text}`)
  assert.ok(!text.includes('[plan]'), `the parent plan badge must not leak:\n${text}`)
  assert.ok(!text.includes('task'), `the parent task badge must not leak:\n${text}`)
  assert.ok(!text.includes('main'), `the parent branch must not leak:\n${text}`)
  assert.ok(!text.includes('[EXT]'), `extension segments must not render while viewing:\n${text}`)
})

test('the viewer footer shows the running activity for a continuable child', () => {
  const snap = parentSnapshot()
  enterViewer(snap, 'continuable', 'running')
  const text = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.ok(text.includes('[subagent · continuable]'), `viewer badge missing:\n${text}`)
  assert.ok(text.includes('● running'), `running activity missing:\n${text}`)
})

test('the compact preset drops the child stats row while viewing', () => {
  const snap = parentSnapshot()
  enterViewer(snap, 'one-shot', 'inactive')
  const text = composer.render({ snapshot: snap, layout: COMPACT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.ok(text.includes('[subagent · one-shot]'), `viewer badge missing:\n${text}`)
  assert.ok(!text.includes('LLM 12.3s'), `compact must drop the stats line:\n${text}`)
})

test('returning to the main subject restores the parent footer', () => {
  const snap = parentSnapshot()
  const text = composer.render({ snapshot: snap, layout: DEFAULT_FOOTER_LAYOUT, width: 100, context: CONTEXT })
  assert.ok(text.includes('[deepseek/parent]'), `parent model missing:\n${text}`)
  assert.ok(text.includes('[yolo]'), `parent permission missing:\n${text}`)
  assert.ok(text.includes('[plan]'), `parent plan badge missing:\n${text}`)
  assert.ok(text.includes('2 tasks running'), `parent task badge missing:\n${text}`)
  assert.ok(text.includes('parent/ws'), `parent cwd missing:\n${text}`)
  assert.ok(text.includes('main'), `parent branch missing:\n${text}`)
  assert.ok(text.includes('t9/s9'), `parent counters missing:\n${text}`)
  assert.ok(text.includes('[EXT]'), `extension segments must return:\n${text}`)
})
