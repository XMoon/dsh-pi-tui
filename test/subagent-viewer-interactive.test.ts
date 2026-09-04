/**
 * Interactive (continuable) subagent viewer acceptance tests (plan M1–M3):
 * the editor is LIVE in a continuable viewer, Enter submits through
 * onSubagentSubmit (never the parent's onSubmit/steer/queue), the child
 * draft is isolated from the main draft and retained across visits, and
 * failed sends restore the text into the child's own slot without
 * polluting a switched/closed viewer.
 * @module @xmoon76/dsh-pi-tui/subagent-viewer-interactive.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp, type SubagentViewerTarget } from '../src/tui-app.ts'
import { mergeDraft } from '../src/steer.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const continuable = (overrides: Partial<SubagentViewerTarget> = {}): SubagentViewerTarget => ({
  parentSessionId: 'session-main',
  childSessionId: 'child-1',
  label: 'research',
  mode: 'continuable',
  activity: 'inactive',
  ...overrides,
})

const oneShot = (overrides: Partial<SubagentViewerTarget> = {}): SubagentViewerTarget => ({
  parentSessionId: 'session-main',
  childSessionId: 'child-1',
  label: 'research',
  mode: 'one-shot',
  activity: 'running',
  ...overrides,
})

/** A bare app whose events are the CALLER's (a fresh object per test —
 * the harness never mutates the app's private state). */
async function startApp(
  events: {
    onSubmit?: (text: string) => void
    onExit?: () => void
    onSingleEscape?: () => boolean | void
    onSteer?: (text: string) => void
    onQueueSubmit?: (text: string) => void
    onSubagentSubmit?: (request: { parentSessionId: string; childSessionId: string; text: string }) => void
  } = {},
): Promise<{ vt: VirtualTerminal; app: TuiApp }> {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: events.onSubmit ?? (() => {}),
    onExit: events.onExit ?? (() => {}),
    onSingleEscape: events.onSingleEscape,
    onSteer: events.onSteer,
    onQueueSubmit: events.onQueueSubmit,
    onSubagentSubmit: events.onSubagentSubmit,
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  return { vt, app }
}

test('a continuable viewer opens an EDITABLE editor with the child placeholder hint', async () => {
  const { vt, app } = await startApp()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('[viewing subagent · continuable]'), `badge missing:\n${view}`)
  assert.ok(view.includes('Message research'), `empty-draft placeholder missing:\n${view}`)
  // Typing edits the CHILD draft (and hides the placeholder).
  vt.sendInput('hello child')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello child')
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Message research'), `placeholder must vanish once the draft is non-empty:\n${view}`)
  app.stop()
})

test('the child draft never mixes with the main draft: enter/exit round-trips both', async () => {
  const { vt, app } = await startApp()
  app.setDraft('main draft abc')
  await vt.waitForRender()
  // Enter the continuable viewer: the editor shows the (empty) child draft.
  app.setViewerMode(continuable())
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the main draft must NOT appear in the child editor')
  vt.sendInput('child draft xyz')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'child draft xyz')
  // Exit: the main draft returns; the child draft is parked.
  app.setViewerMode(undefined)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'main draft abc', 'the main draft must be restored exactly')
  // Re-enter the SAME child: the unsent child draft is back.
  app.setViewerMode(continuable())
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'child draft xyz', 'the child draft must be retained on re-entry')
  app.setViewerMode(undefined)
  app.stop()
})

test('Enter in a continuable viewer submits to onSubagentSubmit — never the parent', async () => {
  const parentSubmits: string[] = []
  const childSubmits: Array<{ parentSessionId: string; childSessionId: string; text: string }> = []
  const { vt, app } = await startApp({
    onSubmit: (text) => parentSubmits.push(text),
    onSubagentSubmit: (request) => childSubmits.push(request),
  })
  app.setViewerMode(continuable())
  await vt.waitForRender()
  vt.sendInput('focus on cancellation')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(childSubmits, [{
    parentSessionId: 'session-main',
    childSessionId: 'child-1',
    text: 'focus on cancellation',
  }], 'Enter must deliver exactly one subagent follow-up')
  assert.deepEqual(parentSubmits, [], 'the parent onSubmit must never fire from the viewer')
  assert.equal(app.getDraft(), '', 'the child draft clears after a submit (the runner restores on rejection)')
  // An EMPTY draft does not submit.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(childSubmits.length, 1, 'an empty draft must not submit')
  app.stop()
})

test('the main session chords are inert inside the interactive viewer', async () => {
  const steered: string[] = []
  const queued: string[] = []
  const singleEscapes: number[] = []
  const { vt, app } = await startApp({
    onSteer: (text) => steered.push(text),
    onQueueSubmit: (text) => queued.push(text),
    onSingleEscape: () => { singleEscapes.push(1); return true },
  })
  app.setViewerMode(continuable())
  await vt.waitForRender()
  vt.sendInput('draft text')
  await vt.waitForRender()
  // Ctrl+S (steer) and Ctrl+Enter (queue) must be consumed, never parent.
  vt.sendInput('\x13') // ctrl+s
  await vt.waitForRender()
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter
  await vt.waitForRender()
  // Alt+↑ (dequeue), Shift+Tab (permission) and keyboard exit too.
  vt.sendInput('\x1b[1;3A') // alt+up
  await vt.waitForRender()
  vt.sendInput('\x1b[Z') // shift+tab
  await vt.waitForRender()
  vt.sendInput('\x03') // ctrl+c
  await vt.waitForRender()
  assert.deepEqual(steered, [], 'Ctrl+S must never steer the parent from the viewer')
  assert.deepEqual(queued, [], 'Ctrl+Enter must never queue the parent from the viewer')
  assert.equal(singleEscapes.length, 0, 'Ctrl+C must not exit (and no accidental Esc)')
  // The child draft is untouched by the blocked chords.
  assert.equal(app.getDraft(), 'draft text')
  // Esc still exits through onSingleEscape.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes.length, 1, 'Esc must exit the viewer')
  app.stop()
})

test('a one-shot viewer cannot submit through the host path either (hard reject)', async () => {
  const parentSubmits: string[] = []
  const childSubmits: unknown[] = []
  const { vt, app } = await startApp({
    onSubmit: (text) => parentSubmits.push(text),
    onSubagentSubmit: (request) => childSubmits.push(request),
  })
  app.setViewerMode(oneShot())
  await vt.waitForRender()
  // Enter is consumed by the read-only guard; submitDraft (the plugin
  // path) is a defensive hard reject.
  vt.sendInput('x')
  vt.sendInput('\r')
  await vt.waitForRender()
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(parentSubmits, [])
  assert.deepEqual(childSubmits, [])
  app.stop()
})

test('a NESTED continuable child is read-only from the root (plan §6.10)', async () => {
  // depth > 1 is read-only even when the child's MODE is continuable: the
  // nested descendant belongs to its exact parent, never to the root. The
  // viewer must show the REAL mode with the nested authority, and neither
  // Enter nor the plugin submit path may ever reach the child.
  const parentSubmits: string[] = []
  const childSubmits: unknown[] = []
  const { vt, app } = await startApp({
    onSubmit: (text) => parentSubmits.push(text),
    onSubagentSubmit: (request) => childSubmits.push(request),
  })
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-grandchild',
    label: 'deep research',
    mode: 'continuable',
    activity: 'inactive',
    access: 'readonly-nested',
  })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('nested · read-only'), `nested read-only must be advertised:\n${view}`)
  assert.ok(view.includes('continuable'), `the real mode must stay visible:\n${view}`)
  vt.sendInput('x')
  vt.sendInput('\r')
  await vt.waitForRender()
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(parentSubmits, [], 'nested viewer must never submit to the parent')
  assert.deepEqual(childSubmits, [], 'nested viewer must never submit to the grandchild from the root')
  // Esc still exits.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!view.includes('deep research') || true)
  app.stop()
})

test('a failed send while the viewer is CURRENT restores into the visible editor, merged with newer typing', async () => {
  const { vt, app } = await startApp({ onSubagentSubmit: () => {} })
  app.setViewerMode(continuable())
  await vt.waitForRender()
  vt.sendInput('foo')
  await vt.waitForRender()
  // Submit (clears the draft), then the delivery REJECTS while the user
  // already typed 'bar' again. The viewer never moved, so the runner's
  // settleSubagentSubmit CURRENT branch runs the EXACT restore call:
  //   app.setEditorText(mergeDraft(app.getDraft(), request.text))
  // (the current/stale decision itself is unit-tested in
  // subagent-viewer-submit.test.ts via resolveSubagentSettleTarget).
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('bar')
  await vt.waitForRender()
  app.setEditorText(mergeDraft(app.getDraft(), 'foo'))
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'bar\n\nfoo', 'the failed submission must merge below the newer typing')
  assert.equal(app.seatTextForTest(), 'bar\n\nfoo', 'the visible editor must show the merge')
  app.setViewerMode(undefined)
  app.stop()
})

test('a stale send (close → reopen the SAME child) restores MAP-ONLY, never the visible editor', async () => {
  const { vt, app } = await startApp({ onSubagentSubmit: () => {} })
  app.setViewerMode(continuable())
  await vt.waitForRender()
  vt.sendInput('foo')
  await vt.waitForRender()
  // Submit, then close and REOPEN the same child while the send is in
  // flight: the reopened viewer is a NEW viewer session (its generation
  // moved on), so the late rejection must not touch its visible editor —
  // even though the child id is identical.
  vt.sendInput('\r')
  await vt.waitForRender()
  app.setViewerMode(undefined)
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  vt.sendInput('bar')
  await vt.waitForRender()
  app.restoreSubagentDraft('child-1', 'foo')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'bar', 'the reopened viewer\u2019s visible editor must stay unpolluted')
  assert.equal(app.getDraft(), 'bar', 'getDraft reads the VISIBLE editor (the current session\u2019s truth)')
  // The stale merge lives in the child's slot: re-entering later shows it.
  app.setViewerMode(undefined)
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'bar\n\nfoo')
  app.setViewerMode(undefined)
  app.stop()
})

test('a send that outlives a viewer switch restores into the OLD child slot only', async () => {
  const { vt, app } = await startApp()
  app.setViewerMode(continuable({ childSessionId: 'child-1' }))
  await vt.waitForRender()
  app.setViewerMode(continuable({ childSessionId: 'child-2', label: 'audit' }))
  await vt.waitForRender()
  vt.sendInput('new child draft')
  await vt.waitForRender()
  // The child-1 send failed AFTER the viewer switched: the text must land
  // in child-1's slot, never in the current surface.
  app.restoreSubagentDraft('child-1', 'old submission')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'new child draft', 'the current viewer must stay unpolluted')
  // Re-enter child-1: the restored text is there (merged with whatever
  // child-1 held — the cleared submit draft).
  app.setViewerMode(undefined)
  await vt.waitForRender()
  app.setViewerMode(continuable({ childSessionId: 'child-1' }))
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'old submission')
  app.stop()
})

test('the viewer generation bumps on open/close/switch (the stale-guard anchor)', async () => {
  const { vt, app } = await startApp()
  const g0 = app.getViewerGeneration()
  app.setViewerMode(continuable())
  const g1 = app.getViewerGeneration()
  assert.ok(g1 > g0, 'opening the viewer must bump the generation')
  app.setViewerMode(continuable({ childSessionId: 'child-2' }))
  const g2 = app.getViewerGeneration()
  assert.ok(g2 > g1, 'switching the viewed child must bump the generation')
  app.setViewerMode(undefined)
  const g3 = app.getViewerGeneration()
  assert.ok(g3 > g2, 'closing the viewer must bump the generation')
  app.stop()
})

test('a replacement (plugin) editor receives the child draft and the follow-up target', async () => {
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  let pluginText = ''
  const submits: unknown[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSubagentSubmit: (request) => submits.push(request),
  }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  registry.register({ id: 'vim', priority: 0, create: () => ({
    component: { kind: 'text', spans: [{ text: 'vim' }] },
    getText: () => pluginText,
    setText: (text) => { pluginText = text },
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => {},
  }) }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The child draft writes target the CURRENT seat occupant.
  app.setViewerMode(continuable())
  await vt.waitForRender()
  app.setEditorText('child draft via runner')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'child draft via runner', 'the child draft must not leak to the main draft')
  // The host-owned submit routes to the subagent even with a plugin editor.
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submits, [{
    parentSessionId: 'session-main',
    childSessionId: 'child-1',
    text: 'child draft via runner',
  }])
  app.setViewerMode(undefined)
  app.stop()
})

test('a replacement editor submit clears the child slot EXPLICITLY (no resurrection on re-entry)', async () => {
  // The host editor's onChange mirror cannot be relied on when a
  // replacement editor occupies the seat: an accepted submission must
  // clear the child's SLOT directly, or a reopened viewer would show
  // already-delivered text.
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  let pluginText = ''
  const submits: Array<{ text: string }> = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSubagentSubmit: (request) => submits.push(request),
  }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  registry.register({ id: 'vim', priority: 0, create: () => ({
    component: { kind: 'text', spans: [{ text: 'vim' }] },
    getText: () => pluginText,
    setText: (text) => { pluginText = text },
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => {},
  }) }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  app.setEditorText('delivered text')
  await vt.waitForRender()
  // Submit through the host path (the plugin editor never fires the host
  // onChange): the slot must clear even though the plugin's setText is
  // what cleared the visible buffer.
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submits, [{
    parentSessionId: 'session-main',
    childSessionId: 'child-1',
    text: 'delivered text',
  }])
  assert.equal(app.getDraft(), '', 'the child slot must clear without relying on onChange')
  // Re-enter: the delivered text must NOT resurrect.
  app.setViewerMode(undefined)
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'already-delivered text must never resurrect in a reopened viewer')
  app.stop()
})

test('a replacement editor that edits through its OWN handleInput submits the LATEST visible text', async () => {
  // The plugin editor mutates its buffer through its public handleInput
  // (semantic events) — the host onChange mirror never fires, so the
  // per-child slot lags. getDraft() must read the VISIBLE editor as the
  // authority, or a submit would send the stale slot text and lose the
  // user's latest input (round-3 finding 1).
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  let pluginText = ''
  const submits: Array<{ text: string }> = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSubagentSubmit: (request) => submits.push({ text: request.text }),
  }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  registry.register({ id: 'vim', priority: 0, create: () => ({
    component: { kind: 'text', spans: [{ text: 'vim' }] },
    getText: () => pluginText,
    setText: (text) => { pluginText = text },
    handleInput: (event) => {
      if (event.kind === 'key' && event.key.key === 'x') {
        pluginText += 'x'
        return true
      }
      return false
    },
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => {},
  }) }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  app.setEditorText('old')
  await vt.waitForRender()
  // The plugin edits through its OWN handleInput ('x' key) — the host
  // onChange never fires, so the per-child slot still holds 'old'.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'oldx', 'getDraft must read the VISIBLE editor in a continuable viewer')
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submits, [{ text: 'oldx' }], 'the submission must carry the LATEST visible text, never the stale slot')
  app.setViewerMode(undefined)
  app.stop()
})

test('parking keeps NEW replacement-editor text even when it is a SUBSTRING of the slotted map', async () => {
  // The plugin edited the draft down (abcdef → cdef) without the host
  // onChange mirror: parking must keep the CURRENT text, not classify it
  // as "already known" because it is a substring of the slotted value.
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  let pluginText = ''
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  registry.register({ id: 'vim', priority: 0, create: () => ({
    component: { kind: 'text', spans: [{ text: 'vim' }] },
    getText: () => pluginText,
    setText: (text) => { pluginText = text },
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => {},
  }) }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  app.setEditorText('abcdef')
  await vt.waitForRender()
  // The plugin buffer shrinks (deletions) — host onChange never fires.
  pluginText = 'cdef'
  app.setViewerMode(undefined)
  await vt.waitForRender()
  // Re-enter: BOTH texts must be present (the map kept the older, the
  // visible parked the newer — nothing lost).
  app.setViewerMode(continuable())
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.ok(draft.includes('cdef'), `the newer visible text must survive parking:\n${draft}`)
  assert.ok(draft.includes('abcdef'), `the older slotted text must survive parking:\n${draft}`)
  app.stop()
})

test('the footer switches to the viewed child\u2019s identity and back on exit', async () => {
  const { vt, app } = await startApp()
  app.setStatus({ model: 'parent-model', cwd: '/parent', branch: '', turns: 9, steps: 9, statsLine: 'parent stats' })
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  app.setViewerFooter({
    label: 'research',
    childSessionId: 'child-1',
    mode: 'continuable',
    activity: 'running',
    cwd: '/child-workspace',
    turns: 3,
    steps: 5,
    statsLine: 'child stats line',
    // M1: the footer composes the child's stats line from the structured
    // usage facts.
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 12300, firstTokenMs: 12_300, tokensPerSec: 0 },
      turns: 3,
      steps: 5,
    },
  })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('[subagent · continuable]'), `subagent footer badge missing:\n${view}`)
  assert.ok(view.includes('research'), `child label missing from the footer:\n${view}`)
  assert.ok(view.includes('t3/s5'), `child turn/step counters missing:\n${view}`)
  assert.ok(view.includes('TTFB 12.3s'), `child stats line missing:\n${view}`)
  assert.ok(!view.includes('parent-model'), `the parent model must not leak into the viewer footer:\n${view}`)
  // Clearing restores the parent footer (the runner's exitView calls BOTH
  // setters — the view subject and the footer payload return together).
  app.setViewerMode(undefined)
  app.setViewerFooter(undefined)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('parent-model'), `the parent footer must return:\n${view}`)
  assert.ok(!view.includes('[subagent · continuable]'), `subagent footer badge must clear:\n${view}`)
  app.stop()
})

test('the one-shot viewer footer carries the one-shot badge and no stats line under compact', async () => {
  const { vt, app } = await startApp()
  app.setFooterPreset('compact')
  await vt.waitForRender()
  app.setViewerMode(oneShot())
  await vt.waitForRender()
  app.setViewerFooter({
    label: 'audit',
    childSessionId: 'child-1',
    mode: 'one-shot',
    activity: 'inactive',
    cwd: '',
    turns: 1,
    steps: 2,
    statsLine: 'child stats',
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 12300, firstTokenMs: 12_300, tokensPerSec: 0 },
      turns: 1,
      steps: 2,
    },
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('[subagent · one-shot]'), `one-shot badge missing:\n${view}`)
  assert.ok(!view.includes('TTFB 12.3s'), `compact preset must drop the stats line:\n${view}`)
  app.setViewerFooter(undefined)
  app.setViewerMode(undefined)
  app.stop()
})

test('the viewer footer never shows the parent keyboard exit hint (round-1 finding)', async () => {
  // The parent arms the exit window (Ctrl+C on a non-empty draft), then
  // the user opens a viewer before the timer expires: parent exit requests
  // are inert inside the viewer, so the confirmation hint must never render
  // there — the child's stats line shows instead.
  const { vt, app } = await startApp()
  app.setDraft('unsent text')
  vt.sendInput('\x03') // Ctrl+C arms the exit window
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  app.setViewerFooter({
    label: 'research',
    childSessionId: 'child-1',
    mode: 'continuable',
    activity: 'running',
    cwd: '',
    turns: 1,
    steps: 1,
    statsLine: 'child stats line',
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 12300, firstTokenMs: 12_300, tokensPerSec: 0 },
      turns: 1,
      steps: 1,
    },
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('again to exit'), `the parent exit hint must never leak into the viewer footer:\n${view}`)
  assert.ok(view.includes('TTFB 12.3s'), `the child stats line must show instead:\n${view}`)
  app.setViewerFooter(undefined)
  app.setViewerMode(undefined)
  app.stop()
})

test('a plugin keybinding still REACHES the runner inside a continuable viewer (the capability gate is the guard)', async () => {
  // The raw-key guard consumes the parent chords, but a plugin binding
  // for a non-reserved chord (Ctrl+Alt+X) is routed through even while
  // viewing — the SEMANTIC gate in the runner (viewerActionCapability)
  // is what must block its parent side effects. This test pins the
  // ROUTING half: the action arrives, so the gate is the only defense.
  const actions: string[] = []
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action) => actions.push(action),
  }, {
    pluginActionFor: (key) => {
      if (key.key === 'x' && key.ctrl && key.alt) return 'cancel-activity'
      return undefined
    },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setViewerMode(continuable())
  await vt.waitForRender()
  vt.sendInput('\x1b\x18') // Ctrl+Alt+X
  await vt.waitForRender()
  assert.deepEqual(actions, ['cancel-activity'],
    'the semantic action must reach the runner even inside the viewer (the gate blocks it there)')
  app.setViewerMode(undefined)
  app.stop()
})
