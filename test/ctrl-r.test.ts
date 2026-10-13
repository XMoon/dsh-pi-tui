/**
 * End-to-end Ctrl+R integration tests (Phase 3B / B3-A): the host mounts the
 * History panel as the OPTIONAL editor-seat tenant, the Transcript stays visible
 * above it, Enter fills the CURRENT editor WITHOUT submitting, Esc leaves the
 * draft/cursor/mode untouched, a live blocking owner REFUSES the request and a
 * capturing overlay keeps its own keys. A real `FileHistorySearchSource` over a
 * temp dsh home drives the search.
 * @module @xmoon76/dsh-pi-tui/ctrl-r.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { FileHistorySearchSource } from '../src/client/history/search.ts'
import { historyFilePath } from '../src/client/history/store.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const startedApps = new Set<DisposableApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function tempHome(life: TestLifecycle): string {
  return life.tempDir('pi-tui-ctrl-r-')
}

function seedHistory(home: string, cwd: string, rows: Array<{ content: string; ts: number; sessionId?: string }>): void {
  const file = historyFilePath(home, cwd)
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  writeFileSync(file, rows.map(row => JSON.stringify({
    v: 2, content: row.content, cwd, ts: row.ts,
    ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
  })).join('\n') + '\n', { mode: 0o600 })
}

async function makeApp(
  life: TestLifecycle,
  home: string,
  cwd = '/work/a',
  copyImpl?: (text: string) => Promise<boolean>,
  sourceImpl?: import('../src/client/history/search.ts').HistorySearchSource,
) {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  seedHistory(home, cwd, [
    { content: 'fix nginx reload', ts: 3 },
    { content: 'old prompt from yesterday', ts: 1 },
  ])
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const copied: string[] = []
  const copySelection = copyImpl ?? (async (text: string) => {
    copied.push(text)
    return true
  })
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    runOwned: (_label, task, options) => {
      void Promise.resolve()
        .then(() => task())
        .then(result => options.onResult?.(result), error => options.onError?.(error))
    },
  }, {
    historySearchSource: sourceImpl ?? new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => cwd,
    copySelection,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  return { vt, app, submitted, copied }
}

/** Whether the History seat frame is currently painted. The header is the
 * seat's stable identity (`Input history`). */
function panelVisible(viewport: string[]): boolean {
  return viewport.some(line => line.includes('Input history'))
}

const strip = (lines: string[]): string => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')

/** Poll until a predicate holds (bounded): deterministic settling for
 * async panel searches — no fixed wall-clock sleeps. */
async function waitFor(
  probe: () => boolean,
  maxMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (!probe()) {
    if (Date.now() - start > maxMs) {
      throw new Error('waitFor: predicate never became true')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('Ctrl+R mounts the History seat; Enter fills the CURRENT editor and does NOT submit', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app, submitted } = await makeApp(life, home)
  app.setDraft('existing draft')
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'transcript stays visible above the seat' }])
  await vt.waitForRender()
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  const opened = strip(vt.getViewport())
  assert.ok(panelVisible(vt.getViewport()), `the History seat must be visible:\n${opened}`)
  assert.ok(opened.includes('transcript stays visible above the seat'),
    'the Transcript must stay visible above the seat (no overlay blackout)')
  assert.ok(opened.includes('Enter use'), 'the seat action bar is painted')
  vt.sendInput('nginx')
  // Settle on the FILTERED result state — both the match painted AND the
  // non-matching row gone — never on a fixed delay: acceptance stays frozen
  // until the debounced search really commits.
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload'))
    && !vt.getViewport().some(line => line.includes('old prompt from yesterday')))
  vt.sendInput('\r') // Enter = accept
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'fix nginx reload', 'the selected history text replaces the draft')
  assert.deepEqual(submitted, [], 'accept must NEVER submit')
  assert.ok(!panelVisible(vt.getViewport()), 'accepting restores the ordinary editor seat')
  assert.ok(strip(vt.getViewport()).includes('fix nginx reload'), 'the restored editor paints the accepted draft')
})

test('Esc closes the seat and leaves the original draft, cursor and input mode untouched', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app, submitted } = await makeApp(life, home)
  // A shell-mode draft with a cursor: the cancellation must restore ALL of it.
  app.setDraft('!ls -la')
  await vt.waitForRender()
  const hostEditor = (app as unknown as { editor: { getCursor(): unknown } }).editor
  const cursorBefore = hostEditor.getCursor()
  const modeBefore = app.inputModeForTest()
  assert.notEqual(modeBefore, 'prompt', 'the `!` draft opened in a shell input mode')
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()))
  vt.sendInput('\x1b') // Esc
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'Esc must close the seat')
  assert.equal(app.getDraft(), '!ls -la', 'Esc must never modify the draft')
  // The visible seat document is the DECODED body; `getDraft` is the
  // serialized wire form (mode prefix + body).
  assert.equal(app.seatTextForTest(), 'ls -la', 'the visible seat document is the original draft body')
  assert.equal(app.inputModeForTest(), modeBefore, 'Esc must preserve the input mode')
  assert.deepEqual(hostEditor.getCursor(), cursorBefore, 'Esc must preserve the cursor position')
  assert.deepEqual(submitted, [], 'Esc must never submit')
})

test('an active transcript-search overlay keeps its keys (Ctrl+R never opens a second surface)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.startTranscriptSearch()
  await vt.waitForRender()
  assert.ok(app.isSearching())
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  assert.ok(app.isSearching(), 'the search overlay stays up')
  assert.ok(!panelVisible(vt.getViewport()), 'the History seat must NOT open over the search overlay')
})

test('a live blocking Question REFUSES Ctrl+R (silent no-op, question untouched)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  const question = app.askQuestions([{ id: 'q1', question: 'block the history?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('block the history?'), 'the question owns the seat')
  vt.sendInput('\x12') // Ctrl+R while the blocking owner is live
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'a refused request must not paint History')
  assert.ok(strip(vt.getViewport()).includes('block the history?'), 'the blocking owner is untouched')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }], 'the question still answers normally')
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'the refused History never appears after the settle')
})

test('Ctrl+R resolves the Current directory at OPEN time (a session switch moves the scope)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  seedHistory(home, '/work/a', [{ content: 'prompt from a', ts: 1 }])
  seedHistory(home, '/work/b', [{ content: 'prompt from b', ts: 2 }])
  const vt = new VirtualTerminal(80, 24)
  let liveCwd = '/work/a'
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    // The runner wires the LIVE session cwd getter — it must be read at
    // open time, not captured at construction.
    historySearchCwd: () => liveCwd,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  // "Session switch": the live cwd moves before Ctrl+R is pressed.
  liveCwd = '/work/b'
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  // Empty-query browse shows the /work/b history (newest first) — the
  // /work/a row must be absent from the current scope.
  await waitFor(() => vt.getViewport().some(line => line.includes('prompt from b')))
  assert.ok(!vt.getViewport().some(line => line.includes('prompt from a')),
    'the current-directory scope must follow the LIVE cwd, not the construction snapshot')
})

test('UI4: Ctrl+R captures the session identity at OPEN time (a session switch moves the scope)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  seedHistory(home, '/work/a', [
    { content: 'prompt from A', ts: 1, sessionId: 'ses_a' },
    { content: 'prompt from B', ts: 2, sessionId: 'ses_b' },
  ])
  const vt = new VirtualTerminal(80, 24)
  let liveSessionId: string | undefined = 'ses_a'
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
    // The runner wires the LIVE session identity getter.
    historySearchSessionId: () => liveSessionId,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('prompt from A')))
  assert.ok(!vt.getViewport().some(line => line.includes('prompt from B')),
    'the session scope must filter by the LIVE session identity')
  vt.sendInput('\x1b') // Esc closes the seat
  await vt.waitForRender()
  // "Session switch": the live identity moves before the next Ctrl+R.
  liveSessionId = 'ses_b'
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('prompt from B')))
  assert.ok(!vt.getViewport().some(line => line.includes('prompt from A')),
    'the reopened seat must search the NEW session, not the construction snapshot')
})

test('H3A-14: a Question PARKS the History seat and the SAME tenant (query + selection) is restored', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  vt.sendInput('\x12')
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the History tenant owns the derived keyboard seat')
  vt.sendInput('nginx')
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x1b[B') // select the second (older) row
  await vt.waitForRender()
  const before = strip(vt.getViewport())
  assert.ok(before.includes('›'), 'a row is selected before the park')

  const question = app.askQuestions([{ id: 'q1', question: 'park history?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('park history?'), 'the blocking owner takes the seat')
  assert.ok(!panelVisible(vt.getViewport()), 'the PARKED History tenant is not painted')
  assert.notEqual(app.focusSeatForTest(), 'editor-panel', 'a parked tenant is not the keyboard owner')
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()), 'the SAME History tenant comes back after the last blocker settles')
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the restored tenant owns the derived keyboard seat again')
  assert.ok(strip(vt.getViewport()).includes('Search: > nginx'), 'the query survives the park/restore round trip')
  assert.ok(strip(vt.getViewport()).includes('old prompt from yesterday'), 'the selected row survives too')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor', 'closing the seat derives the ordinary editor seat again')
})

test('a session switch WHILE History is open retires the seat (no prior-session surface survives)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  seedHistory(home, '/work/a', [{ content: 'prompt from A', ts: 1, sessionId: 'ses_a' }])
  const vt = new VirtualTerminal(80, 24)
  let liveSessionId: string | undefined = 'ses_a'
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
    historySearchSessionId: () => liveSessionId,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('prompt from A')))
  // The session is replaced while the seat is up: the next input re-validates
  // the subject and the tenant is retired instead of surviving stale.
  liveSessionId = 'ses_b'
  vt.sendInput('x')
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'a stale History tenant must be retired, not kept painted')
})

test('Ctrl+R on a TINY terminal (8 rows) keeps the header and the Esc hint, never overflowing', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  seedHistory(home, '/work/a', [{ content: 'fix nginx reload', ts: 3 }])
  const vt = new VirtualTerminal(80, 8)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  const viewport = vt.getViewport()
  assert.ok(viewport.some(line => line.includes('Input history')), 'the seat header must open')
  assert.ok(viewport.some(line => line.includes('Esc cancel')), 'the Esc hint must stay visible')
  // The seat must not paint past the terminal: the last painted row is the
  // footer/hint region and the physical frame never exceeds the rows.
  assert.ok(viewport.length <= 8, 'the viewport can never exceed the terminal height')
})

test('Alt+C copies the selected entry through the app clipboard owner', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app, copied } = await makeApp(life, home)
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x1bc') // Alt+C
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(copied, ['fix nginx reload'], 'Alt+C copies the exact stored prompt')
  assert.equal(app.getDraft(), '', 'copying must never accept into the editor')
})

test('plugin keybindings can never claim Ctrl+R (host-reserved)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { KeybindingRegistry } = await import('../src/extension/internal/keybinding-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action) => actions.push(action),
  }, {
    // A resolver claiming EVERY key: the reserved gate must still win.
    pluginActionFor: () => 'open-search' as const,
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Ctrl+R must never fire a plugin action')
  app.stop()

  // The registry itself rejects the registration loudly.
  const registry = new KeybindingRegistry()
  assert.throws(() => registry.register({
    id: 'k-ctrl-r',
    key: { key: 'r', ctrl: true, alt: false, shift: false, super: false },
    action: 'open-search',
  }, 'plugin'), /reserved/, 'a plugin cannot bind Ctrl+R')
})

test('H3A-01: a second Ctrl+R while the seat is open is a no-op (ONE History instance)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  vt.sendInput('\x12')
  await vt.waitForRender()
  vt.sendInput('nginx')
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x12') // a second Ctrl+R
  await vt.waitForRender()
  const viewport = strip(vt.getViewport()).split('\n')
  assert.equal(viewport.filter(line => line.includes('Input history')).length, 1,
    'a second Ctrl+R must never open a second History surface')
  assert.ok(strip(vt.getViewport()).includes('Search: > nginx'), 'the SAME seat keeps its query')
})

test('H3A-13: a pending Approval REFUSES Ctrl+R (silent no-op, approval untouched)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  const approval = app.showApprovalPrompt({ toolName: 'bash', reason: 'block the history?' })
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('block the history?'), 'the approval owns the seat')
  vt.sendInput('\x12') // Ctrl+R while the approval is pending
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'a refused request must not paint History')
  assert.ok(strip(vt.getViewport()).includes('block the history?'), 'the approval is untouched')
  vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'the refused History never appears after the approval settles')
})

test('H3A-15: a clipboard failure reports Copy failed, and a settle after the seat closed stays silent', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const notices: string[] = []
  let mode: 'fail' | 'deferred' = 'fail'
  let release: ((ok: boolean) => void) | undefined
  const deferred = new Promise<boolean>((resolve) => { release = resolve })
  const { vt, app } = await makeApp(life, home, '/work/a',
    () => (mode === 'fail' ? Promise.resolve(false) : deferred))
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x1bc') // Alt+C — the clipboard capability answers `false`
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(notices.includes('Copy failed'), 'a rejected clipboard write is reported through the owned diagnostic')

  // A copy whose settlement lands AFTER the seat closed must not notify.
  mode = 'deferred'
  vt.sendInput('\x1b') // Esc closes the seat (the copy above already settled)
  await vt.waitForRender()
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x1bc') // Alt+C — the payload is captured now, the write is pending
  await vt.waitForRender()
  vt.sendInput('\x1b') // Esc closes the seat before the clipboard settles
  await vt.waitForRender()
  const settledBefore = notices.length
  release?.(true)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(notices.length, settledBefore,
    'a stale copy settle must not notify over a closed/replacement surface')
})

test('H3A-10: Esc preserves a pending paste marker in the draft byte for byte', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app, submitted } = await makeApp(life, home)
  const draft = 'before [paste #1 +12 lines] after'
  app.setDraft(draft)
  await vt.waitForRender()
  vt.sendInput('\x12')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.getDraft(), draft, 'the paste marker survives a History round trip')
  assert.deepEqual(submitted, [], 'cancelling never submits the expanded paste')
})

test('currentness: a copy settling while the seat is PARKED notifies nothing', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const notices: string[] = []
  let release: ((ok: boolean) => void) | undefined
  const deferred = new Promise<boolean>((resolve) => { release = resolve })
  const { vt, app } = await makeApp(life, home, '/work/a', () => deferred)
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x1bc') // Alt+C: the payload is captured, the clipboard write is pending
  await vt.waitForRender()
  const question = app.askQuestions([{ id: 'q1', question: 'park during the copy?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'the Question parks (and hides) the History seat')
  release?.(true)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(notices, [], 'a copy that settles while the seat is PARKED is not visible feedback')
  vt.sendInput('\r')
  vt.sendInput('\r')
  await question
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()), 'the parked seat is restored for the SAME tenant')
})

test('currentness: a session switch while a search is in flight never publishes the old session page', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  let resolveSearch: ((page: import('../src/client/history/search.ts').HistorySearchPage) => void) | undefined
  const pending = new Promise<import('../src/client/history/search.ts').HistorySearchPage>((resolve) => {
    resolveSearch = resolve
  })
  const source: import('../src/client/history/search.ts').HistorySearchSource = { search: () => pending }
  let liveSessionId: string | undefined = 'ses_a'
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    historySearchSource: source,
    historySearchCwd: () => '/work/a',
    historySearchSessionId: () => liveSessionId,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('\x12') // Ctrl+R: the captured subject is ses_a
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()), 'the seat is open while its search is in flight')
  // The session is replaced BEFORE the search settles.
  liveSessionId = 'ses_b'
  resolveSearch?.({ results: [{ id: 'old', content: 'previous session row', cwd: '/work/a', ts: 1, sourceFile: '/h.jsonl', sourceByteOffset: 1 }], exhausted: true })
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 10))
  await vt.waitForRender()
  assert.ok(!strip(vt.getViewport()).includes('previous session row'),
    'a page resolved for the previous session is never published')
  assert.ok(!panelVisible(vt.getViewport()),
    'the stale seat retires through the host close path instead of staying visibly stale')
  // The lease was really released: a fresh Ctrl+R captures the NEW session.
  vt.sendInput('\x12')
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()), 'a fresh seat opens for the new session')
})
