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
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { FileHistorySearchSource } from '../../src/client/history/search.ts'
import type { SaveLocationDeps, SaveLocationResult } from '../../src/tui/interaction/save-location.ts'
import { historyFilePath } from '../../src/client/history/store.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<DisposableApp>()
afterEach(() => {
  disposeStartedApps()
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
  sourceImpl?: import('../../src/client/history/search.ts').HistorySearchSource,
) {
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
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
    // No Session bound in this harness: the captured scope is sessionless and
    // stays current (a controllable pair; the currentness tests below inject
    // their own).
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
    copySelection,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  return { vt, app, submitted, copied }
}

/** Whether the History seat frame is currently painted. The header is the
 * seat's stable identity (`Input History`). */
function panelVisible(viewport: string[]): boolean {
  return viewport.some(line => line.includes('Input History'))
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
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
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

test('Ctrl+R resolves the Current Directory at OPEN time (a session switch moves the scope)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
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
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
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
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
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
    captureHistoryScope: () => {
      const capturedId = liveSessionId
      return { sessionId: capturedId, isCurrent: () => liveSessionId === capturedId }
    },
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
  // This case needs an UNMATCHING row, because "the `nginx` query committed"
  // is otherwise unobservable: BOTH shared-fixture rows match `nginx`, so the
  // old predicate (`fix nginx reload` painted) was already true on the
  // pre-query page and raced the panel's debounced search.
  seedHistory(home, '/work/a', [
    { content: 'fix nginx reload', ts: 3 },
    { content: 'old nginx prompt from yesterday', ts: 1 },
    { content: 'unrelated history', ts: 0 },
  ])
  vt.sendInput('\x12')
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor-panel', 'the History tenant owns the derived keyboard seat')
  // The unfiltered page first: 3 matches, including the non-matching row.
  await waitFor(() => strip(vt.getViewport()).includes('Results · 3 matches'))
  vt.sendInput('nginx')
  // Acceptance is the FILTERED page (2 matches, `unrelated history` gone) —
  // never "a read settled" or the initial 3-match page still painted.
  await waitFor(() => {
    const frame = strip(vt.getViewport())
    return frame.includes('Search: > nginx')
      && frame.includes('Results · 2 matches')
      && !frame.includes('unrelated history')
  })
  const selectedOlderNginxRow = (): boolean =>
    strip(vt.getViewport()).split('\n').some(line =>
      line.startsWith('> ') && line.includes('old nginx prompt from yesterday'))
  vt.sendInput('\x1b[B') // select the second (older) row
  await vt.waitForRender()
  assert.ok(selectedOlderNginxRow(), 'the second matching row is selected before the park')

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
  await waitFor(selectedOlderNginxRow)
  assert.ok(selectedOlderNginxRow(), 'the SAME selected row survives the park/restore round trip')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(app.focusSeatForTest(), 'editor', 'closing the seat derives the ordinary editor seat again')
})

test('a session switch WHILE History is open retires the seat (no prior-session surface survives)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  seedHistory(home, '/work/a', [{ content: 'prompt from A', ts: 1, sessionId: 'ses_a' }])
  const vt = new VirtualTerminal(80, 24)
  let liveSessionId: string | undefined = 'ses_a'
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => {
      const capturedId = liveSessionId
      return { sessionId: capturedId, isCurrent: () => liveSessionId === capturedId }
    },
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
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  seedHistory(home, '/work/a', [{ content: 'fix nginx reload', ts: 3 }])
  const vt = new VirtualTerminal(80, 8)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  const viewport = vt.getViewport()
  assert.ok(viewport.some(line => line.includes('Input History')), 'the seat header must open')
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
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  const { KeybindingRegistry } = await import('../../src/extension/internal/keybinding-registry.ts')
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
  assert.equal(viewport.filter(line => line.includes('Input History')).length, 1,
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

test('H3A-10: a REAL large-paste registry entry survives a History round trip (expanded payload identity)', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app, submitted } = await makeApp(life, home)
  // A REAL large paste through the fork editor's bracketed-paste path: >10 lines
  // makes the editor store the payload in its paste REGISTRY and insert a marker
  // token (never an inline body).
  const body = Array.from({ length: 40 }, (_, index) => `pasted line ${index}`).join('\n')
  vt.sendInput(`before \x1b[200~${body}\x1b[201~ after`)
  await vt.waitForRender()
  // The RAW document carries the registry marker; the production WIRE form
  // (`getDraft`, the submit/steer source) carries the expanded payload.
  const document = app.seatTextForTest()
  const expanded = app.getDraft()
  assert.match(document, /\[paste #1 \+40 lines\]/, `the editor must create a REAL marker token:\n${document}`)
  assert.ok(expanded.includes('pasted line 39'),
    'the marker really expands through the production submit/steer wire form')
  assert.ok(!expanded.includes('[paste #'), 'the wire form never carries registry-bound marker text')
  const cursorBefore = (app as unknown as { editor: { getCursor(): unknown } }).editor.getCursor()

  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()), 'the History seat opens over the pasted draft')
  vt.sendInput('\x1b') // Esc
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), document,
    'the marker document survives a History round trip byte for byte')
  assert.equal(app.getDraft(), expanded,
    'the paste REGISTRY entry still resolves to the same full payload (the editor was never rebuilt)')
  assert.deepEqual((app as unknown as { editor: { getCursor(): unknown } }).editor.getCursor(), cursorBefore,
    'the cursor is untouched')
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
  let resolveSearch: ((page: import('../../src/client/history/search.ts').HistorySearchPage) => void) | undefined
  const pending = new Promise<import('../../src/client/history/search.ts').HistorySearchPage>((resolve) => {
    resolveSearch = resolve
  })
  const source: import('../../src/client/history/search.ts').HistorySearchSource = { search: () => pending }
  let liveSessionId: string | undefined = 'ses_a'
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    historySearchSource: source,
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => {
      const capturedId = liveSessionId
      return { sessionId: capturedId, isCurrent: () => liveSessionId === capturedId }
    },
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
  assert.ok(!strip(vt.getViewport()).includes('Loading history'),
    'dropping the stale page also repaints the loading state away')
  // The stale seat is INERT (no acceptance, no copy, no pointer action)…
  assert.equal(app.getDraft(), '', 'the stale seat accepts nothing')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'Enter on a stale seat is inert')
  // …and the host's next revalidation entry retires it: the keystroke that
  // reaches the seat retires it and lands in the NEW session's editor.
  vt.sendInput('a')
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()), 'the next input retires the stale seat')
  assert.equal(app.getDraft(), 'a', 'the retired seat lets the key reach the new session editor')
  // The lease was really released: a fresh Ctrl+R captures the NEW session.
  vt.sendInput('\x12')
  await vt.waitForRender()
  assert.ok(panelVisible(vt.getViewport()), 'a fresh seat opens for the new session')
})

test('currentness: a copy settling after a SESSION SWITCH notifies nothing', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  seedHistory(home, '/work/a', [{ content: 'fix nginx reload', ts: 3, sessionId: 'ses_a' }])
  const notices: string[] = []
  let release: ((ok: boolean) => void) | undefined
  const deferred = new Promise<boolean>((resolve) => { release = resolve })
  let liveSessionId: string | undefined = 'ses_a'
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { TuiApp } = await import('../../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (_label, task, options) => {
      void Promise.resolve()
        .then(() => task())
        .then(result => options.onResult?.(result), error => options.onError?.(error))
    },
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => {
      const capturedId = liveSessionId
      return { sessionId: capturedId, isCurrent: () => liveSessionId === capturedId }
    },
    copySelection: () => deferred,
  })
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  await vt.waitForRender()
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  vt.sendInput('\x1bc') // Alt+C: the payload is captured for ses_a, the clipboard write is pending
  await vt.waitForRender()
  // The session is replaced while the copy is in flight, with NO further input
  // (so the tenant has not been retired by a revalidation entry yet).
  liveSessionId = 'ses_b'
  release?.(true)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(notices, [],
    'a copy started for the previous session must not report its outcome over the new session')
})

// ---------------------------------------------------------------------------
// Phase 3B / B3-B: the REAL History tenant under the blocking owners. These
// reuse the file-backed harness above (the real `HistoryPanel` seat tenant and
// the real Question / Approval / Save Location owners); there is no shadow
// simulator.
// ---------------------------------------------------------------------------

/** A Client-local save-location deps set with no real filesystem. */
function b3bSaveDeps(): SaveLocationDeps {
  return {
    resolveDirectory: (input) => input === './' ? '/tmp/dsh-ctrl-r-out' : input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async () => null,
  }
}

function b3bAskSave(app: import('../../src/tui-app.ts').TuiApp): Promise<SaveLocationResult> {
  return app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    b3bSaveDeps(),
  )
}

test('H3B-01 (ctrl-r harness): a Question FIFO Q1→Q2 keeps the file-backed History seat parked and restores its query', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  vt.sendInput('\x12') // Ctrl+R
  await vt.waitForRender()
  vt.sendInput('nginx')
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload'))
    && !vt.getViewport().some(line => line.includes('old prompt from yesterday')))
  const panel = app.focusedComponentForTest()
  assert.ok(panel !== null, 'the History tenant owns the seat')

  const first = app.askQuestions([{ id: 'q1', question: 'first park?', options: [{ label: 'Yes' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'second park?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('first park?'), 'Q1 owns the seat')
  assert.ok(!panelVisible(vt.getViewport()), 'the parked History is not painted')
  assert.notEqual(app.focusSeatForTest(), 'editor-panel')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await first, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('second park?'), 'Q2 takes the seat directly')
  assert.ok(!panelVisible(vt.getViewport()), 'no History projection between the two flows')
  assert.notEqual(app.focusSeatForTest(), 'editor-panel')

  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await second, [{ id: 'q2', selected: ['Yes'] }])
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), panel, 'the LAST settle restores the SAME tenant')
  assert.ok(strip(vt.getViewport()).includes('Search: > nginx'), 'the query survives the FIFO round trip')
  assert.equal(app.focusSeatForTest(), 'editor-panel')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!panelVisible(vt.getViewport()))
})

test('H3B-02 (ctrl-r harness): an Approval A→B FIFO keeps the file-backed History seat parked through the handover', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  const panel = app.focusedComponentForTest()
  assert.ok(panel !== null)

  // The `hasPending()` handover gap: `ApprovalRuntime.settle(A)` clears the
  // ACTIVE slot and only then presents B. `projectActivity()` runs inside that
  // window — the parked History must not be restored there.
  const proto = Object.getPrototypeOf(app) as { projectActivity(): void }
  const originalProject = proto.projectActivity
  const gaps: Array<{ seat: string; panelFocused: boolean }> = []
  let armed = false
  proto.projectActivity = function patchedProjectActivity(this: typeof app): void {
    originalProject.call(this)
    if (armed) gaps.push({ seat: this.focusSeatForTest(), panelFocused: this.focusedComponentForTest() === panel })
  }
  life.defer(() => { proto.projectActivity = originalProject })

  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'park first' })
  const second = app.showApprovalPrompt({ toolName: 'fs', reason: 'park second' })
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('bash'), 'A owns the seat')
  assert.ok(!panelVisible(vt.getViewport()))

  armed = true
  vt.sendInput('y')
  assert.equal(await first, 'allowed-once')
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('fs'), 'B took the seat after A settled')
  assert.ok(!panelVisible(vt.getViewport()), 'no History projection between the two approvals')
  assert.notEqual(app.focusSeatForTest(), 'editor-panel')
  assert.ok(gaps.length >= 1, 'the settle tail ran inside the active→next handover window')
  assert.ok(gaps.every(gap => gap.seat !== 'editor-panel' && !gap.panelFocused),
    `the parked History must never regain the seat in the handover gap: ${JSON.stringify(gaps)}`)

  vt.sendInput('n')
  assert.equal(await second, 'rejected')
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), panel, 'the drained queue releases the SAME tenant')
  assert.equal(app.focusSeatForTest(), 'editor-panel')
})

test('H3B-03 (ctrl-r harness): Save Location cancel and confirm each restore the SAME file-backed History seat', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const { vt, app } = await makeApp(life, home)
  app.setDraft('untouched draft')
  await vt.waitForRender()
  vt.sendInput('\x12')
  await vt.waitForRender()
  await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
  const panel = app.focusedComponentForTest()
  assert.ok(panel !== null)

  const cancelled = b3bAskSave(app)
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('Save session archive'), 'the Save prompt owns the seat')
  assert.ok(!panelVisible(vt.getViewport()))
  vt.sendInput('\x1b')
  assert.deepEqual(await cancelled, { kind: 'cancelled' })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), panel, 'cancel restores the SAME History tenant')
  assert.equal(app.getDraft(), 'untouched draft', 'cancel leaves the draft untouched')

  const confirmed = b3bAskSave(app)
  await vt.waitForRender()
  assert.ok(strip(vt.getViewport()).includes('Save session archive'))
  vt.sendInput('\r')
  assert.deepEqual(await confirmed, { kind: 'selected', directory: '/tmp/dsh-ctrl-r-out', overwrite: false })
  await vt.waitForRender()
  assert.equal(app.focusedComponentForTest(), panel, 'confirm restores the SAME History tenant')
  assert.equal(app.getDraft(), 'untouched draft', 'confirm leaves the draft untouched')
  assert.ok(strip(vt.getViewport()).includes('Search: > '), 'the query row is back')
})
