/**
 * M1 viewer-subject tests (plan §13.6): the footer layout does NOT change
 * when the user enters the subagent viewer — the SAME preset composes,
 * the view-scope item leads, and the data-source items (cwd/turns-steps/
 * stats-line) follow the display subject's section values. The parent's
 * model/permission/plan/task/context/branch/extension parts never leak in.
 * @module @xmoon76/dsh-pi-tui/footer-view-subject.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { FooterComposer } from '../src/tui/footer/composer.ts'
import { createBuiltinFooterRegistry } from '../src/tui/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT, COMPACT_FOOTER_LAYOUT } from '../src/domain/footer/presets.ts'
import { StatusStore } from '../src/domain/status/store.ts'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { TuiApp } from '../src/tui-app.ts'
import { enterChildDisplaySubject, exitChildDisplaySubject } from './support/display-subject.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const composer = new FooterComposer(createBuiltinFooterRegistry())
const CONTEXT = { taskBrowserAvailable: true, extensionFooterText: '[EXT]' }

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

/** Switch the snapshot to the viewed child (the runner's ONE atomic
 *  display-subject commit: `view` + the child's OWN Session-owned sections). */
function enterViewer(snap: StatusSnapshot, mode: 'one-shot' | 'continuable', activity: 'running' | 'inactive'): void {
  const mutable = snap as DeepMutable<StatusSnapshot>
  mutable.view.subject = { kind: 'subagent', id: 'child-1', label: 'research', mode, activity }
  // The child's OWN Session-owned facts — never the parent's, which stay in
  // the sections the SAME atomic commit replaces.
  mutable.composition = {
    model: { provider: 'deepseek', id: 'child-model', displayName: 'child-model', reasoningEffort: 'high' },
    agentPreset: { id: 'child-preset', label: 'child-preset' },
  }
  mutable.access = { permissionPreset: { id: 'read-only', label: 'read-only', matched: true } }
  mutable.collaboration = { plan: { effective: false } }
  mutable.workspace = { cwd: '/child/ws', project: 'ws' }
  mutable.activity.todoCount = 2
  mutable.usage = {
    tokens: { input: 11, output: 5, cacheRead: 0, cacheWrite: 0 },
    performance: { llmMs: 12300, firstTokenMs: 12_300, tokensPerSec: 0 },
    turns: 3,
    steps: 5,
  }
  mutable.usage.context = { usedTokens: 100, windowTokens: 2000, percent: 5 }
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
  assert.ok(text.includes('TTFB 12.3s'), `child stats line missing:\n${text}`)
  // M3-5 PR1 §5: the child's OWN Session-owned facts render — model/provider,
  // configured preset, available permission, context pressure/window and the
  // cumulative token figures.
  assert.ok(text.includes('deepseek/child-model'), `the child model/provider must render:\n${text}`)
  assert.ok(text.includes('@high'), `the child reasoning effort must render:\n${text}`)
  assert.ok(text.includes('[read-only]'), `the child permission must render:\n${text}`)
  assert.ok(text.includes('↑11'), `the child cumulative input tokens must render:\n${text}`)
  assert.ok(text.includes('↓5'), `the child cumulative output tokens must render:\n${text}`)
  assert.ok(!text.includes('parent'), `the parent model must not leak:\n${text}`)
  assert.ok(!text.includes('[yolo]'), `the parent permission must not leak:\n${text}`)
  assert.ok(!text.includes('[plan]'), `the parent plan badge must not leak:\n${text}`)
  assert.ok(!text.includes('task'), `the parent task badge must not leak:\n${text}`)
  assert.ok(!text.includes('main'), `the parent branch must not leak:\n${text}`)
  assert.ok(!text.includes('[EXT]'), `extension segments must not render while viewing:\n${text}`)
  // The child context (numerator/window from its own projection) renders; the
  // parent's 1000/10000 window is nowhere.
  assert.ok(!text.includes('10.0k'), `the parent context window must not leak:\n${text}`)
})

test('a custom layout renders the child’s own preset/branch/context where configured (M3-5 PR1 §5)', () => {
  const snap = parentSnapshot()
  enterViewer(snap, 'continuable', 'running')
  ;(snap as DeepMutable<StatusSnapshot>).workspace.branch = 'child-branch'
  const custom = composer.render({
    snapshot: snap,
    layout: {
      schemaVersion: 1,
      rows: [{
        left: [{ id: 'agent-preset' }, { id: 'model' }, { id: 'git-branch' }, { id: 'context', format: 'percent' }, { id: 'todo' }],
        right: [],
      }],
    },
    width: 140,
    context: CONTEXT,
  })
  assert.ok(custom.includes('[child-preset]'), `the configured child preset must render:\n${custom}`)
  assert.ok(custom.includes('[deepseek/child-model @high]'), `the child model must render:\n${custom}`)
  assert.ok(custom.includes('child-branch'), `the child branch must render:\n${custom}`)
  assert.ok(custom.includes('5%'), `the child context percent must render:\n${custom}`)
  assert.ok(custom.includes('2 todo'), `the child todo count must render:\n${custom}`)
  assert.ok(!custom.includes('parent'), `the parent model must not leak:\n${custom}`)
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
  assert.ok(!text.includes('TTFB 12.3s'), `compact must drop the stats line:\n${text}`)
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
  // The runner mounts the viewer by publishing the viewer identity and then
  // committing the display subject (view + the child's Session-owned sections)
  // in ONE atomic update. The paint must never precede the subject switch, so
  // even a bare display-subject commit (no runner ordering to rely on) shows
  // the child on the very first frame.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3 })
  await vt.waitForRender()
  const before = vt.getViewport().join('\n')
  assert.ok(before.includes('p/m'), `the parent footer must be painted first:\n${before}`)
  enterChildDisplaySubject(app, {
    id: 'child-1', label: 'research', mode: 'one-shot', activity: 'running',
    cwd: '/child-ws', turns: 5, steps: 9,
  })
  // NO extra refresh: this is the first frame after the viewer opens.
  await vt.waitForRender()
  const first = vt.getViewport().join('\n')
  assert.ok(first.includes('[subagent · one-shot]'), `the first frame must show the child identity:\n${first}`)
  assert.ok(first.includes('child-ws'), `the first frame must show the child workspace:\n${first}`)
  assert.ok(!first.includes('p/m'), `the parent model must not leak into the first frame:\n${first}`)
  assert.ok(!first.includes('parent-ws'), `the parent cwd must not leak into the first frame:\n${first}`)
  exitChildDisplaySubject(app, { model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3 })
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.ok(after.includes('p/m'), `leaving the viewer must restore the parent footer immediately:\n${after}`)
  app.stop()
})

test('the viewer transition is ATOMIC in the StatusStore: no observer ever reads a mixed snapshot (review P2)', () => {
  // The store notifies its subscribers SYNCHRONOUSLY inside update(), so the
  // footer command runner's refresh reads EVERY published snapshot. The old
  // choreography published the view section alone (enter: `subagent` + the
  // parent's facts; exit: `main` + the child's facts) — a mixed snapshot an
  // observer can genuinely read and act on. The display-subject commit now
  // carries view + composition + access + workspace + usage in ONE update.
  // The test records EVERY post-update snapshot through the production-shaped
  // commit pair and asserts none of them is mixed.
  const snapshots: StatusSnapshot[] = []
  const store = new StatusStore(emptyStatusSnapshot())
  store.subscribe(() => { snapshots.push(store.snapshot()) })
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store })
  app.start()
  startedApps.add(app)
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3 })
  const parentCwd = '/parent-ws'
  const childCwd = '/child-ws'
  const childModel = { provider: 'deepseek', model: 'child' }
  const childPermission = 'read-only'
  // ENTER: the viewer identity then the display-subject commit carrying the
  // child's OWN Session-owned facts.
  enterChildDisplaySubject(app, {
    id: 'c1', label: 'research', mode: 'one-shot', activity: 'running',
    cwd: childCwd, turns: 5, steps: 9, model: childModel, permission: childPermission,
    todos: [{ content: 'child todo', status: 'in_progress' }],
    title: 'child session',
  })
  // EXIT.
  exitChildDisplaySubject(app, { model: 'p/m', cwd: parentCwd, turns: 2, steps: 3 })
  // Every observed snapshot is self-consistent: the subject kind matches the
  // workspace AND the Session-owned sections the SAME snapshot carries.
  for (const snap of snapshots) {
    if (snap.view.subject.kind === 'subagent') {
      assert.equal(snap.workspace.cwd, childCwd,
        `a subagent snapshot must carry the CHILD workspace, got ${snap.workspace.cwd}`)
      assert.equal(snap.composition.model?.id, childModel.model,
        `a subagent snapshot must carry the CHILD model: ${JSON.stringify(snap.composition)}`)
      assert.equal(snap.access.permissionPreset?.id, childPermission,
        `a subagent snapshot must carry the CHILD permission: ${JSON.stringify(snap.access)}`)
      assert.equal(snap.usage.turns, 5, 'the child turn count follows the child subject')
    } else {
      assert.notEqual(snap.workspace.cwd, childCwd,
        `a main snapshot must never carry the child workspace: ${JSON.stringify(snap.workspace)}`)
      assert.notEqual(snap.composition.model?.id, childModel.model,
        `a main snapshot must never carry the child model: ${JSON.stringify(snap.composition)}`)
    }
  }
  // The transition actually happened (the test is not vacuous).
  assert.ok(snapshots.some(snap => snap.view.subject.kind === 'subagent'), 'the enter was observed')
  assert.ok(snapshots.some(snap => snap.view.subject.kind === 'main' && snap.workspace.cwd === parentCwd),
    'the exit restores main + the parent workspace in one snapshot')
  app.stop()
})

test('a legacy parent setStatus while viewing never clobbers the child subject', async () => {
  // The runner's display-subject commit projects the DISPLAY SUBJECT (the
  // viewed child) into the store BEFORE the legacy setStatus call repaints the
  // footer. A setStatus carrying the parent's cwd/model must not overwrite the
  // child's committed sections — the legacy writer is gated on the store's own
  // `view` subject.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  enterChildDisplaySubject(app, {
    id: 'child-1', label: 'child', mode: 'one-shot', activity: 'inactive',
    cwd: '/child-ws', turns: 5, steps: 9,
  })
  // Then the legacy parent-status update (the runner's setStatus): the
  // parent's cwd/model must NOT clobber the child's subject.
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', branch: 'main', turns: 2, steps: 3 })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('child-ws'), `the child workspace must stay:\n${view}`)
  assert.ok(!view.includes('parent-ws'), `the parent cwd must not leak in:\n${view}`)
  // Leaving the viewer restores the parent facts.
  exitChildDisplaySubject(app, { model: 'p/m', cwd: '/parent-ws', branch: 'main', turns: 2, steps: 3 })
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('parent-ws'), `the parent workspace must return:\n${restored}`)
  app.stop()
})

test('absent child usage never leaks the PARENT token figures into the child stats line', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  // Paint the parent's STRUCTURED usage facts first (real token figures) —
  // these are what the stats-line item composes from.
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3, usage: {
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
  // Enter the viewer WITHOUT structured usage: the child's stats line must not
  // show the parent's token figures (the child's own zeroed fold instead).
  enterChildDisplaySubject(app, {
    id: 'child-1', label: 'child', mode: 'one-shot', activity: 'inactive',
    cwd: '/child-ws', turns: 5, steps: 9,
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('10.0k'), `the parent input-token figure must not leak:\n${view}`)
  assert.ok(!view.includes('8.9k'), `the parent output-token figure must not leak:\n${view}`)
  // The child's official cumulative usage is UNAVAILABLE (mirroring the
  // production projection-absent disposition): the section OMITS the token
  // figures entirely — neither a zeroed stand-in nor the parent's numbers.
  assert.ok(!view.includes('↑'), `no input-token figure may render when the official child usage is unavailable:\n${view}`)
  assert.ok(!view.includes('↓'), `no output-token figure may render when the official child usage is unavailable:\n${view}`)
  // The child's own turns/steps still show via the viewer identity.
  assert.ok(view.includes('child-ws'), `the child workspace must show:\n${view}`)
  assert.ok(view.includes('t5/s9'), `the child counters must show:\n${view}`)
  // Leaving the viewer restores the parent surface.
  exitChildDisplaySubject(app, { model: 'p/m', cwd: '/parent-ws', branch: 'main', turns: 2, steps: 3 })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('parent-ws'), `the parent workspace must return:\n${view}`)
  assert.ok(!view.includes('child-ws'), `the child workspace must clear:\n${view}`)
  app.stop()
})

test('the display-subject commit re-projects the activity todo count and an ALREADY-OPEN todo panel (M3-5 PR1 review R1)', async () => {
  // The production-reachable leak: the todo panel is opened on the MAIN
  // subject, then the user enters the child viewer. The display-subject commit
  // must publish the child's todo count in the SAME store update AND refresh
  // the already-rendered panel — not wait for an unrelated setTodoSummary /
  // resize / toggle. The same must hold for child A → child B, a child todo
  // change while open, and the exit back to main.
  const snapshots: StatusSnapshot[] = []
  const store = new StatusStore(emptyStatusSnapshot())
  store.subscribe(() => { snapshots.push(store.snapshot()) })
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store })
  app.start()
  startedApps.add(app)
  app.setStatus({ model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3 })
  app.setTodoSummary([
    { content: 'PARENT-TODO-1', status: 'in_progress' },
    { content: 'PARENT-TODO-2', status: 'pending' },
  ])
  // The panel is OPENED on the main subject, BEFORE the viewer transition.
  app.toggleTodoPanel()
  await vt.waitForRender()
  assert.equal(store.snapshot().activity.todoCount, 2, 'the main todo count is committed first')
  assert.ok(vt.getViewport().join('\n').includes('PARENT-TODO-1'), 'the open panel shows the main list')

  // ENTER: the child's own single todo replaces the subject everywhere.
  enterChildDisplaySubject(app, {
    id: 'child-1', label: 'child', mode: 'one-shot', activity: 'running',
    cwd: '/child-ws', turns: 5, steps: 9,
    todos: [
      { content: 'CHILD-A-TODO-1', status: 'in_progress' },
      { content: 'CHILD-A-TODO-2', status: 'pending' },
      { content: 'CHILD-A-TODO-3', status: 'pending' },
    ],
  })
  await vt.waitForRender()
  assert.equal(store.snapshot().activity.todoCount, 3,
    'the child todo count must be committed with the subject (not left at the parent’s)')
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('CHILD-A-TODO-1'), `the already-open panel must re-render the child list:\n${view}`)
  assert.ok(!view.includes('PARENT-TODO'), `the parent list must not survive in the open panel:\n${view}`)

  // The SAME child's todo list changes while the panel is open: the re-commit
  // (StatusRuntime re-reads SessionStatus(child) on the next child refresh)
  // follows it, and the panel re-renders.
  enterChildDisplaySubject(app, {
    id: 'child-1', label: 'child', mode: 'one-shot', activity: 'running',
    cwd: '/child-ws', turns: 5, steps: 9,
    todos: [{ content: 'CHILD-A-TODO-NEW', status: 'in_progress' }],
  })
  await vt.waitForRender()
  assert.equal(store.snapshot().activity.todoCount, 1, 'the same child’s new count must be committed')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('CHILD-A-TODO-NEW'), `the open panel must follow the same child’s new list:\n${view}`)
  assert.ok(!view.includes('CHILD-A-TODO-1'), `the same child’s stale list must be replaced:\n${view}`)

  // A main todo write while the child is displayed must not replace the child
  // projection (neither the count nor the panel).
  app.setTodoSummary([{ content: 'PARENT-TODO-V2', status: 'pending' }])
  await vt.waitForRender()
  assert.equal(store.snapshot().activity.todoCount, 1, 'the hidden main write must not become the visible count')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('CHILD-A-TODO-NEW'), `the open panel must keep the child list:\n${view}`)
  assert.ok(!view.includes('PARENT-TODO-V2'), `the hidden main write must not reach the child panel:\n${view}`)

  // A child A → B switch while the panel stays open.
  enterChildDisplaySubject(app, {
    id: 'child-2', label: 'child two', mode: 'continuable', activity: 'running',
    cwd: '/child-2-ws', turns: 1, steps: 1,
    todos: [{ content: 'CHILD-B-TODO-1', status: 'pending' }],
  })
  await vt.waitForRender()
  assert.equal(store.snapshot().activity.todoCount, 1, 'the B todo count must replace A’s')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('CHILD-B-TODO-1'), `the open panel must show B’s list:\n${view}`)
  assert.ok(!view.includes('CHILD-A-TODO'), `A’s list must not survive into B:\n${view}`)

  // EXIT while the panel stays open: the LATEST main list returns.
  app.setTodoSummary([
    { content: 'PARENT-TODO-V3', status: 'in_progress' },
    { content: 'PARENT-TODO-V4', status: 'pending' },
    { content: 'PARENT-TODO-V5', status: 'pending' },
    { content: 'PARENT-TODO-V6', status: 'pending' },
  ])
  exitChildDisplaySubject(app, { model: 'p/m', cwd: '/parent-ws', turns: 2, steps: 3 })
  await vt.waitForRender()
  assert.equal(store.snapshot().activity.todoCount, 4, 'the latest main count must return')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('PARENT-TODO-V3'), `the latest main list must return in the open panel:\n${view}`)
  assert.ok(!view.includes('CHILD-B-TODO'), `the child list must clear:\n${view}`)

  // Every published snapshot stays subject-consistent: the view subject and
  // the activity todo count travel together. The parent list lengths are 2 and
  // 4 while every child list length is 3 or 1, so a mixed snapshot is
  // unambiguous; the id membership check pins the subject to the child ids.
  for (const snap of snapshots) {
    if (snap.view.subject.kind === 'subagent') {
      assert.ok(snap.view.subject.id === 'child-1' || snap.view.subject.id === 'child-2',
        `a subagent snapshot must name a child session: ${JSON.stringify(snap.view.subject)}`)
      assert.ok(snap.activity.todoCount === 3 || snap.activity.todoCount === 1,
        `a child snapshot must carry a CHILD todo count: ${JSON.stringify(snap.activity)}`)
    } else {
      assert.ok(snap.activity.todoCount === 0 || snap.activity.todoCount === 2 || snap.activity.todoCount === 4,
        `a main snapshot must carry a MAIN todo count: ${JSON.stringify(snap.activity)}`)
    }
  }
  app.stop()
})
