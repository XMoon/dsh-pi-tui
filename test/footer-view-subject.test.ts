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
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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

test('the FIRST frame after entering the viewer already shows the child subject', async () => {
  // The runner mounts the viewer by calling setViewerMode (view section)
  // and setViewerFooter (usage/workspace + paint). The paint must never
  // precede the subject switch: the app projects the view section BEFORE
  // its own renderFooter, so even a bare setViewerFooter (no runner
  // ordering to rely on) shows the child on the very first frame.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3 })
  await vt.waitForRender()
  const before = vt.getViewport().join('\n')
  assert.ok(before.includes('p/m'), `the parent footer must be painted first:\n${before}`)
  app.setViewerFooter({
    label: 'research',
    childSessionId: 'child-1',
    mode: 'one-shot',
    activity: 'running',
    cwd: '/child-ws',
    turns: 5,
    steps: 9,
    usage: undefined,
    statsLine: '',
  })
  // NO extra refresh: this is the first frame after the viewer opens.
  await vt.waitForRender()
  const first = vt.getViewport().join('\n')
  assert.ok(first.includes('[subagent · one-shot]'), `the first frame must show the child identity:\n${first}`)
  assert.ok(first.includes('child-ws'), `the first frame must show the child workspace:\n${first}`)
  assert.ok(!first.includes('p/m'), `the parent model must not leak into the first frame:\n${first}`)
  assert.ok(!first.includes('parent-ws'), `the parent cwd must not leak into the first frame:\n${first}`)
  app.setViewerFooter(undefined)
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('p/m'), `leaving the viewer must restore the parent footer immediately:\n${after}`)
  app.stop()
})

test('a legacy parent setStatus while viewing never clobbers the child workspace', async () => {
  // The runner's refreshStatus projects the DISPLAY SUBJECT (the viewed
  // child) into the store BEFORE the legacy setStatus call repaints the
  // footer. A setStatus carrying the parent's cwd must not overwrite the
  // child's workspace — the cwd item follows the display subject.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  // The runner's store update first: the child's workspace lands in the
  // store (the app's statusStore is internal, so setViewerFooter plays
  // the same role — it projects the child facts).
  app.setViewerFooter({
    mode: 'one-shot',
    label: 'child',
    childSessionId: 'child-1',
    activity: 'inactive',
    cwd: '/child-ws',
    turns: 5,
    steps: 9,
    usage: undefined,
    statsLine: '',
  })
  // Then the legacy parent-status update (the runner's setStatus): the
  // parent's cwd must NOT clobber the child's workspace.
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', branch: 'main', turns: 2, steps: 3, statsLine: 'x' })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('child-ws'), `the child workspace must stay:\n${view}`)
  assert.ok(!view.includes('parent-ws'), `the parent cwd must not leak in:\n${view}`)
  // Leaving the viewer restores the parent facts (the next refresh's
  // setStatus owns the workspace again).
  app.setViewerFooter(undefined)
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', branch: 'main', turns: 2, steps: 3, statsLine: 'x' })
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('parent-ws'), `the parent workspace must return:\n${restored}`)
  app.stop()
})

test('absent child usage never leaks the PARENT token figures into the child stats line', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  // Paint the parent's STRUCTURED usage facts first (real token figures) —
  // these are what the stats-line item composes from.
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3, statsLine: 'x', usage: {
    tokens: { input: 9999, output: 8888, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 120000, firstTokenMs: 2000, tokensPerSec: 40 },
    turns: 2,
    steps: 3,
  } })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  // 9999 formats as 10.0k, 8888 as 8.9k (pi's formatTokens) — the parent
  // figures must be painted first (precondition).
  assert.ok(view.includes('↑10.0k'), `the parent token figures must be painted first (precondition):\n${view}`)
  assert.ok(view.includes('↓8.9k'), `the parent output figures must be painted first (precondition):\n${view}`)
  // Enter the viewer WITHOUT structured usage: the child's stats line must
  // not show the parent's token figures (a fresh/empty surface instead).
  app.setViewerFooter({
    label: 'child',
    childSessionId: 'child-1',
    mode: 'one-shot',
    activity: 'inactive',
    cwd: '/child-ws',
    turns: 5,
    steps: 9,
    usage: undefined,
    statsLine: 'child line',
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('10.0k'), `the parent input-token figure must not leak:\n${view}`)
  assert.ok(!view.includes('8.9k'), `the parent output-token figure must not leak:\n${view}`)
  assert.ok(view.includes('↑0 ↓0'), `the child stats line shows its OWN zeroed facts (never the parent's):\n${view}`)
  // The child's own turns/steps still show via the viewer identity.
  assert.ok(view.includes('child-ws'), `the child workspace must show:\n${view}`)
  assert.ok(view.includes('t5/s9'), `the child counters must show:\n${view}`)
  // Leaving the viewer restores the parent surface; the app-level
  // restore + the runner's refreshStatus (a setStatus here plays it)
  // bring the parent workspace back.
  app.setViewerFooter(undefined)
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', branch: 'main', turns: 2, steps: 3, statsLine: 'x' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('parent-ws'), `the parent workspace must return:\n${view}`)
  assert.ok(!view.includes('child-ws'), `the child workspace must clear:\n${view}`)
  app.stop()
})
