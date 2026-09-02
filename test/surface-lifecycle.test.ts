/**
 * M0 contract gate: the final surface lifetime boundary. A surface
 * GENERATION is created once and outlives every transient screen mode —
 * `start()`, `stop()`, fullscreen toggles and the external-editor
 * stop/start round-trip MUST NOT create a new generation; only a final
 * `dispose()` bumps it. After disposal, old-generation callbacks are
 * benign no-ops, never crashes.
 * @module @xmoon76/dsh-pi-tui/surface-lifecycle.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
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

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

/** A deferred that resolves after the current microtask queue drains. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('the surface generation is stable across start/stop and fullscreen toggles', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const initial = app.getSurfaceGeneration()
  app.stop()
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  assert.equal(app.getSurfaceGeneration(), initial, 'stop/start must not bump the generation')
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.getSurfaceGeneration(), initial, 'fullscreen entry must not bump the generation')
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(app.getSurfaceGeneration(), initial, 'fullscreen exit must not bump the generation')
  app.stop()
})

test('the external-editor round-trip does not bump the surface generation', async () => {
  const vt = new VirtualTerminal(80, 24)
  let calls = 0
  const app: TuiApp = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async (draft: string): Promise<string> => {
      calls += 1
      // The TUI is stopped while the editor is open (raw mode released).
      assert.equal(app.isDisposed(), false)
      return `${draft} edited`
    },
    runOwned: () => {},
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const initial = app.getSurfaceGeneration()
  app.setDraft('hello')
  await app.launchExternalEditor()
  await vt.waitForRender()
  assert.equal(calls, 1, 'the editor round-trip ran')
  assert.equal(app.getSurfaceGeneration(), initial, 'the external-editor stop/start round-trip must not bump the generation')
  assert.equal(app.getDraft(), 'hello edited')
  app.stop()
})

test('dispose is idempotent and bumps the generation exactly once', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const before = app.getSurfaceGeneration()
  app.dispose()
  assert.equal(app.isDisposed(), true)
  assert.ok(app.getSurfaceGeneration() > before, 'dispose must bump the generation')
  const after = app.getSurfaceGeneration()
  app.dispose()
  app.dispose()
  assert.equal(app.getSurfaceGeneration(), after, 'dispose must be idempotent (one bump)')
  assert.equal(app.isDisposed(), true)
})

test('stale surface calls are benign no-ops after disposal', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.dispose()
  // None of these may throw or reach a dead terminal.
  app.requestRender()
  app.requestRender(true)
  app.notify('after death')
  app.setStatus({ model: 'x', cwd: '/w', branch: '', turns: 1, steps: 1, statsLine: '' })
  app.setTasks([{ id: 't', label: 'l', status: 'running', kind: 'bash' }])
  app.setQueueItems([{ id: 'q', text: 't', mode: 'followup' }])
  app.setTodoSummary([{ content: 'todo', status: 'in_progress' }])
  app.setPlanMode(true)
  app.setSessionTitle('title')
  app.setTranscript([])
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls', result: '', status: 'running',
  })
  app.setDraft('late draft')
  // A stale draft write lands in the (still-alive) editor object but never
  // reaches a dead terminal; the requestRender inside is a benign no-op.
  await settle()
})

test('a pending external-editor round-trip finishing after dispose restarts nothing', async () => {
  const vt = new VirtualTerminal(80, 24)
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  })
  app.start()
  startedApps.add(app)
  const pending = app.launchExternalEditor()
  app.dispose()
  release('late edit')
  await pending
  assert.equal(app.isDisposed(), true)
  // The restart must have been skipped: the surface is gone.
  await settle()
  assert.equal(app.isDisposed(), true)
})

test('an in-flight theme autodetect settling after dispose applies nothing', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const pending = app.autoDetectTheme()
  app.dispose()
  await pending
  assert.equal(app.isDisposed(), true)
  await settle()
})

test('an open approval prompt and question flow settle on dispose (no dangling promises)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const approval = app.showApprovalPrompt({ toolName: 'read', reason: 'read a file' })
  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?' }])
  app.dispose()
  const outcomes = await Promise.allSettled([approval, questions])
  assert.equal(outcomes[0]?.status, 'fulfilled', 'the approval prompt must settle on dispose')
  assert.equal(outcomes[1]?.status, 'rejected', 'the question flow must settle rejected on dispose')
})

test('approval and question requests arriving AFTER dispose settle immediately (no hang)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.dispose()
  // The runner's approval/questions handlers can fire during exit teardown;
  // neither may leave the caller's promise pending forever.
  const approval = app.showApprovalPrompt({ toolName: 'read', reason: 'late ask' })
  const questions = app.askQuestions([{ id: 'q1', question: 'late ask?' }])
  const outcomes = await Promise.allSettled([approval, questions])
  assert.equal(outcomes[0]?.status, 'fulfilled', 'a late approval prompt must settle cancelled')
  assert.equal(outcomes[0]?.status === 'fulfilled' ? outcomes[0].value : '', 'cancelled')
  assert.equal(outcomes[1]?.status, 'rejected', 'a late question flow must settle rejected')
})

test('dispose clears the transcript-search state (no stale handles)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  assert.equal(app.isSearching(), true, 'search must be open before dispose')
  app.dispose()
  assert.equal(app.isSearching(), false, 'search state must be cleared by dispose')
  // A stale search write after dispose must be a benign no-op.
  app.setSearchResult(1, 2)
  await settle()
})

test('dispose settles EVERY queued approval exactly once (no skipped promises)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // 1 active + 4 queued: the drain loop must settle every promise — the
  // round-2 regression (settleApproval splices while iterating the live
  // queue, skipping every other queued prompt).
  const prompts = Array.from({ length: 5 }, (_, index) =>
    app.showApprovalPrompt({ toolName: 'read', reason: `ask ${index}` }))
  const settled: string[] = []
  const outcomes = prompts.map(prompt =>
    prompt.then(outcome => { settled.push(outcome) }))
  app.dispose()
  const results = await Promise.allSettled(outcomes)
  for (const result of results) {
    assert.equal(result.status, 'fulfilled', 'every queued approval must settle')
  }
  assert.equal(settled.length, 5, 'exactly five approvals must resolve')
  assert.ok(settled.every(outcome => outcome === 'cancelled'), 'every approval settles cancelled')
})

test('fullscreen toggles and transcript search are benign no-ops after dispose', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  app.dispose()
  // None of these may re-enter raw mode, re-create an alt screen, or mount
  // an overlay on a dead terminal (round-2 finding 2).
  app.toggleFullscreen()
  app.setFullscreen(true)
  app.setFullscreen(false)
  app.startTranscriptSearch()
  assert.equal(app.isFullscreen(), false, 'fullscreen must stay off after dispose')
  assert.equal(app.isSearching(), false, 'search must stay closed after dispose')
  await settle()
})
