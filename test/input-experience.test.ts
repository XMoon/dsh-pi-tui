/**
 * Headless tests for the P5b input experience: fork editor keybindings
 * (undo / kill-ring), input-history seeding and recall, Ctrl+S steering,
 * the external-editor hook, and local `!` shell cards.
 * @module @xmoon76/dsh-pi-tui/input-experience.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp, type TuiAppEvents, type TuiAppEventsBase } from '../src/tui-app.ts'
import { runOwned, type OwnedTaskOptions } from '../src/detached.ts'
import { createDiag } from '../src/diag.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces,
 * so a test that starts an app must not leak the slot into the next test
 * (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.stop() } catch {}
  }
})


/** The owned-task entry the runner wires in production; tests use the real
 * runOwned with a silent capture diag. */
const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
const owned = <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void => {
  runOwned(label, task, { ...options, diag })
}

function startApp(overrides: Partial<TuiAppEventsBase> = {}): { vt: VirtualTerminal; app: TuiApp; submitted: string[] } {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    ...overrides,
  })
  app.start()
  startedApps.add(app)
  return { vt, app, submitted }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('editor undo (ctrl+-) restores text after a word deletion', async () => {
  const { vt, app, submitted } = startApp()
  vt.sendInput('abc')
  vt.sendInput('\x17') // ctrl+w: delete word backward
  vt.sendInput('\x1f') // ctrl+-: undo
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['abc'], 'undo must restore the deleted word')
  void app
})

test('kill ring yanks back killed text (ctrl+k, ctrl+y)', async () => {
  const { vt, app, submitted } = startApp()
  vt.sendInput('one two')
  vt.sendInput('\x0b') // ctrl+k: kill to line end
  vt.sendInput('\x19') // ctrl+y: yank
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['one two'], 'yank must restore the killed text')
  void app
})

test('seeded input history recalls entries with the up arrow', async () => {
  const { vt, app, submitted } = startApp()
  app.seedInputHistory(['second', 'first']) // newest first, as persisted
  vt.sendInput('\x1b[A') // up
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['second'], 'up arrow must recall the newest entry')
})

test('submitted lines land in the persisted history mirror', async () => {
  const { vt, app } = startApp()
  vt.sendInput('hello')
  vt.sendInput('\r')
  await viewport(vt)
  vt.sendInput('world')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual([...app.getInputHistory()], ['world', 'hello'])
})

test('ctrl+s steers the draft and clears the editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const steered: string[] = []
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    onSteer: (text) => steered.push(text),
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('do better')
  vt.sendInput('\x13') // ctrl+s
  await viewport(vt)
  assert.deepEqual(steered, ['do better'], 'steer must receive the draft')
  // The editor was cleared: a follow-up submit carries only the new text.
  vt.sendInput('x')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['x'], 'steer must clear the editor')
})

test('ctrl+s with an empty draft still fires onSteer (the runner decides)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const steered: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSteer: (text) => steered.push(text),
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('\x13') // ctrl+s with an empty editor
  await viewport(vt)
  // The queue pane is the primary steer surface: with queued messages and an
  // empty draft, the runner steers the whole queue, so the event must fire.
  assert.deepEqual(steered, [''], 'empty-draft ctrl+s must still fire onSteer')
  assert.equal(app.getDraft(), '', 'editor must stay empty after ctrl+s')
})

test('ctrl+enter fires the queue-submit chord and clears the editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const queued: string[] = []
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    onQueueSubmit: (text) => queued.push(text),
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('queue me')
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter
  await viewport(vt)
  assert.deepEqual(queued, ['queue me'], 'the chord must submit the draft in queue mode')
  assert.deepEqual(submitted, [], 'the chord must not fire the plain submit')
  // The editor was cleared: a follow-up Enter carries only the new text.
  vt.sendInput('x')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['x'], 'the chord must clear the editor')
})

test('ctrl+enter without a wired chord falls through (no draft loss)', async () => {
  const { vt, app } = startApp()
  vt.sendInput('keep me')
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter with no onQueueSubmit wired
  const view = await viewport(vt)
  assert.ok(view.includes('keep me'), `draft must survive without a wired chord:\n${view}`)
  void app
})

test('ctrl+enter on an empty draft does not fire the chord (no session-creating submit)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const queued: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onQueueSubmit: (text) => queued.push(text),
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter with an empty editor
  await viewport(vt)
  assert.deepEqual(queued, [], 'an empty chord must not submit an empty followup')
})

// ── P0: empty-submission semantics (plan §4.1 / §6.2) ────────────────────────────────────

test('Enter on a truly empty editor is a silent NO-OP — no submit event at all', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  })
  app.start()

  startedApps.add(app)
  await vt.waitForRender()
  vt.sendInput('\r') // Enter on the empty editor
  await vt.waitForRender()
  assert.deepEqual(submitted, [], 'an empty Enter must never fire onSubmit')
  // Whitespace-only is also empty (the wire form trims to nothing).
  vt.sendInput('   ')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, [], 'a whitespace-only Enter must never fire onSubmit')
  // The editor itself was cleared by the fork BEFORE onSubmit, so a no-op
  // leaves the surface fresh for the next real input.
  assert.equal(app.getDraft(), '', 'the draft stays empty after the no-op Enter')
  app.stop()
})

test('Enter after a REAL prompt still submits (the empty gate never eats a non-empty wire form)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  })
  app.start()

  startedApps.add(app)
  await vt.waitForRender()
  vt.sendInput('hello')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello'], 'a non-empty Enter must submit exactly as before')
  app.stop()
})

test('ctrl+g opens the external editor and restores its content', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    openExternalEditor: async (draft) => `edited: ${draft}`,
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('draft')
  vt.sendInput('\x07') // ctrl+g
  // The TUI stops and restarts around the external editor round-trip.
  await new Promise(resolve => setTimeout(resolve, 30))
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['edited: draft'], 'external editor content must replace the draft')
})

test('an external editor saving the draft unchanged does not touch the editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    openExternalEditor: async (draft) => draft, // the editor "saved" without changes
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('draft text')
  await viewport(vt)
  vt.sendInput('\x07') // ctrl+g → editor round-trip returns the identical draft
  await new Promise(resolve => setTimeout(resolve, 30))
  // The draft is untouched and no update/repaint churn was triggered.
  assert.equal(app.getDraft(), 'draft text', 'an unchanged save must not rewrite the draft')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['draft text'], 'the untouched draft still submits normally')
  app.stop()
})

test('an external editor launch failure is caught: no unhandled rejection, app restarts', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => {
      throw new Error('editor not found')
    },
    runOwned: owned,
  })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    app.start()

    startedApps.add(app)
    vt.sendInput('draft')
    vt.sendInput('\x07') // ctrl+g → the editor promise rejects
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [], 'a failed external editor must not leak an unhandled rejection')
    // The TUI restarted (finally) and the failure is visible as a notice.
    const view = await viewport(vt)
    assert.ok(view.includes('external editor failed: editor not found'), `notice missing:\n${view}`)
    // The app still accepts input after the failure.
    vt.sendInput('more')
    await viewport(vt)
    assert.ok(app.getDraft().includes('more'), `editor must stay live after a failed launch:\n${app.getDraft()}`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    app.stop()
  }
})

test('openExternalEditor without runOwned is rejected at construction (bound contract)', () => {
  const vt = new VirtualTerminal(80, 24)
  // The type union already forbids this at compile time; the cast proves
  // the RUNTIME check catches a violation (plain JS hosts, casts).
  assert.throws(() => new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async (draft: string) => draft,
  } as unknown as TuiAppEvents), /openExternalEditor requires runOwned/)
})

test('ctrl+g without an editor hook is a documented no-op, never a crash', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()

  startedApps.add(app)
  vt.sendInput('draft text')
  await viewport(vt)
  vt.sendInput('\x07') // ctrl+g: no editor configured
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(app.getDraft(), 'draft text', 'the draft must be untouched')
  // The key was consumed but nothing launched; the app stays live.
  vt.sendInput(' more')
  await viewport(vt)
  assert.ok(app.getDraft().includes('more'), 'input must keep flowing after the no-op')
  app.stop()
})

test('two ctrl+g in one input batch start the external editor only once (single-flight)', async () => {
  const vt = new VirtualTerminal(80, 24)
  let calls = 0
  let release!: (text: string) => void
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => {
      calls += 1
      await new Promise<string>(resolve => { release = resolve })
      return 'edited'
    },
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('draft')
  await viewport(vt)
  // Both keys land while the first launch is still pending: the second must
  // be consumed without starting another editor (one terminal ownership).
  vt.sendInput('\x07')
  vt.sendInput('\x07')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 1, 'a pending launch must be single-flight')
  assert.equal(release !== undefined, true, 'the first launch must be in flight')
  // The latch releases when the launch settles: a later Ctrl+G launches again.
  release('edited')
  await new Promise(resolve => setTimeout(resolve, 30))
  vt.sendInput('\x07')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 2, 'the latch must release after a successful launch')
  app.stop()
})

test('the external editor round-trip EXPANDS paste markers (P1 large-paste loss)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const seenDrafts: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async (draft) => {
      seenDrafts.push(draft)
      return draft
    },
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  // A large multi-line paste lands as a `[paste #N +12 lines]` marker in
  // the editor text; the registry holds the real content.
  const pasted = Array.from({ length: 12 }, (_, i) => `real line ${i + 1}`).join('\n')
  vt.sendInput(`\x1b[200~${pasted}\x1b[201~`)
  await vt.waitForRender()
  await app.launchExternalEditor()
  assert.equal(seenDrafts.length, 1)
  assert.ok(seenDrafts[0]!.includes('real line 12'), `$EDITOR must see the REAL paste content, got: ${seenDrafts[0]}`)
  assert.ok(!seenDrafts[0]!.includes('[paste #'), 'the marker text must never reach $EDITOR')
  app.stop()
})

test('the external editor round-trip preserves fullscreen and the surface generation (P2)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async (draft) => draft,
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true, 'fullscreen is up before the round-trip')
  const generationBefore = app.getSurfaceGeneration()
  await app.launchExternalEditor()
  await vt.waitForRender()
  assert.equal(app.isFullscreen(), true, 'returning from $EDITOR must re-enter the SAME fullscreen surface')
  assert.equal(app.getSurfaceGeneration(), generationBefore, 'the round-trip stays inside one surface generation')
  app.setFullscreen(false)
  await vt.waitForRender()
  app.stop()
})

test('the editor single-flight latch releases after a failed launch', async () => {
  const vt = new VirtualTerminal(80, 24)
  let calls = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => {
      calls += 1
      throw new Error('editor vanished')
    },
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  vt.sendInput('\x07')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 1)
  // Failure is a terminal outcome: the latch must be free again.
  vt.sendInput('\x07')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 2, 'the latch must release after a failed launch')
  app.stop()
})

test('the editor latch releases even when the TUI restart (start) throws', async () => {
  const vt = new VirtualTerminal(80, 24)
  let calls = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => {
      calls += 1
      return 'edited'
    },
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  const screen = (app as unknown as { tui: { start: () => void; stop: () => void } }).tui
  const originalStart = screen.start.bind(screen)
  // The first launch's resume (screen restart) throws: the failure lands
  // in diagnostics (the runOwned error path in production), but the latch
  // MUST still clear — otherwise the editor capability dies silently for
  // the rest of the session. The resume seam stops/starts the ACTIVE
  // screen directly (suspendForExternalEditor /
  // resumeFromExternalEditor), not TuiApp.start.
  screen.start = () => { throw new Error('restart failed') }
  await app.launchExternalEditor().catch(() => {})
  assert.equal(calls, 1, 'the editor round-trip ran')
  screen.start = originalStart
  await app.launchExternalEditor()
  assert.equal(calls, 2, 'the latch must release even when restart threw')
  app.stop()
})

test('the editor latch releases even when the TUI stop throws', async () => {
  const vt = new VirtualTerminal(80, 24)
  let calls = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => {
      calls += 1
      return 'edited'
    },
    runOwned: owned,
  })
  app.start()

  startedApps.add(app)
  const screen = (app as unknown as { tui: { start: () => void; stop: () => void } }).tui
  const originalStop = screen.stop.bind(screen)
  // The suspend seam stops the ACTIVE screen (suspendForExternalEditor),
  // not TuiApp.stop — patch the screen's stop.
  screen.stop = () => { throw new Error('stop failed') }
  await app.launchExternalEditor().catch(() => {})
  assert.equal(calls, 0, 'the editor never opened (stop threw first)')
  screen.stop = originalStop
  await app.launchExternalEditor()
  assert.equal(calls, 1, 'the latch must release even when stop threw')
  app.stop()
})

test('app.stop is idempotent: repeated calls neither throw nor double-teardown', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()

  startedApps.add(app)
  vt.sendInput('hello')
  await viewport(vt)
  app.stop()
  app.stop() // the runner cleanup path may run twice (exit + effect dispose)
  app.stop()
  // After stop, rendering has halted: the viewport no longer advances.
  const frozen = await viewport(vt)
  vt.sendInput('world')
  await new Promise(resolve => setTimeout(resolve, 20))
  const still = await viewport(vt)
  assert.deepEqual(still, frozen, 'no rendering after stop')
})

test('local shell cards render, settle in place, and clear', async () => {
  const { vt, app } = startApp()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: '', status: 'running',
  })
  let view = await viewport(vt)
  assert.ok(view.includes('Shell ls -la [running]'), `running card missing:\n${view}`)
  assert.ok(view.includes('ls -la'), `args missing:\n${view}`)
  app.updateLastLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: 'total 8\n[exit 0]', status: 'ok',
  })
  view = await viewport(vt)
  assert.ok(view.includes('exit 0'), `result missing:\n${view}`)
  app.clearLocalMessages()
  view = await viewport(vt)
  assert.ok(!view.includes('Shell'), `card not cleared:\n${view}`)
})

test('a settled card updates by identity, never the newest card', async () => {
  const { vt, app } = startApp()
  // `!cmd1` running; its settle callback holds this reference.
  const first = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'cmd1', result: '', status: 'running',
  })
  // `!cmd2` starts before cmd1 settles (cmd1 was aborted/killed).
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'cmd2', result: '', status: 'running',
  })
  // cmd1's close event arrives late: it must touch only ITS card.
  app.updateLocalMessage(first, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'cmd1', result: 'aborted', status: 'error',
  })
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('aborted'), `cmd1 settlement missing:\n${view}`)
  assert.ok(!view.includes('abortedcmd2') && view.includes('cmd2'), `cmd2 card corrupted:\n${view}`)
  assert.ok(
    !view.includes('cmd1') || view.includes('aborted'),
    `cmd1 card must show its own settlement:\n${view}`,
  )
})

test('clearSettledLocalMessages drops settled cards and keeps running ones', async () => {
  const { vt, app } = startApp()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'done1', result: '[exit 0]', status: 'ok',
  })
  const running = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'live2', result: '', status: 'running',
  })
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'failed3', result: 'failed: boom', status: 'error',
  })
  app.clearSettledLocalMessages()
  let view = await viewport(vt)
  assert.ok(!view.includes('done1'), `settled ok card must clear:\n${view}`)
  assert.ok(!view.includes('failed3'), `settled error card must clear:\n${view}`)
  assert.ok(view.includes('live2'), `running card must survive:\n${view}`)
  // The running card later settles; the next dismissal takes it too.
  app.updateLocalMessage(running, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'live2', result: '[exit 0]', status: 'ok',
  })
  app.clearSettledLocalMessages()
  view = await viewport(vt)
  assert.ok(!view.includes('live2'), `newly settled card must clear on the next dismissal:\n${view}`)
})

test('slash-command autocomplete paints the fresh list on the keystroke frame', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()

  startedApps.add(app)
  // Fullscreen: the alt screen renders while the main screen (which the
  // editor's own render requests target) is stopped — the exact condition
  // under which the fresh list used to never paint.
  app.setFullscreen(true)
  app.setCommandCompletions([
    { name: 'reload', description: 'Reload' },
    { name: 'resume', description: 'Resume a session' },
    { name: 'reset', description: 'Reset' },
  ], '/ws')
  await vt.waitForRender()
  const type = async (char: string): Promise<string> => {
    vt.sendInput(char)
    // Inside the render throttle window (16ms): the keystroke's own frame
    // must already show the CURRENT query's list. A stale /re list would
    // keep /reload first after typing 's' until the throttled follow-up
    // frame — the "one keystroke behind" lag fast typing exposed.
    await new Promise(resolve => setTimeout(resolve, 8))
    await vt.flush()
    return vt.getViewport().join('\n')
  }
  await type('/')
  await type('r')
  const view = await type('s')
  assert.ok(view.includes('resume'), `fresh /res list missing:\n${view}`)
  assert.ok(!view.includes('reload'), `stale list still painted after /res:\n${view}`)
  app.stop()
})
