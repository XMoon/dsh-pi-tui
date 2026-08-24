/**
 * End-to-end Ctrl+R integration tests: the host opens the history panel,
 * the overlay owns its keys, Enter fills the editor WITHOUT submitting,
 * Esc leaves the draft untouched, and overlay/question precedence is
 * preserved (plan §28/§30/§33/§34/§47). A real FileHistorySearchSource
 * over a temp dsh home drives the search.
 * @module @xmoon76/dsh-pi-tui/ctrl-r.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHistorySearchSource } from '../src/history-search.ts'
import { historyFilePath } from '../src/history.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pi-tui-ctrl-r-'))
}

function seedHistory(home: string, cwd: string, rows: Array<{ content: string; ts: number; sessionId?: string }>): void {
  const file = historyFilePath(home, cwd)
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  writeFileSync(file, rows.map(row => JSON.stringify({
    v: 2, content: row.content, cwd, ts: row.ts,
    ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
  })).join('\n') + '\n', { mode: 0o600 })
}

async function makeApp(home: string, cwd = '/work/a') {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  seedHistory(home, cwd, [
    { content: 'fix nginx reload', ts: 3 },
    { content: 'old prompt from yesterday', ts: 1 },
  ])
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  }, {
    historySearchSource: new FileHistorySearchSource({ dshHome: home }),
    historySearchCwd: () => cwd,
  })
  app.start()
  await vt.waitForRender()
  return { vt, app, submitted }
}

/** Whether the panel frame is currently painted (the "History" header).
 * The scope tabs are responsive (short labels on narrow terminals), so the
 * probe matches the title line by its stable parts only. */
function panelVisible(viewport: string[]): boolean {
  return viewport.some(line => line.includes('History') && (line.includes('Directory') || line.includes('Session')))
}

/** Poll until a predicate holds (bounded): deterministic settling for
 * async panel searches — no fixed wall-clock sleeps (AGENTS.md timing
 * rule: assert on the STATE, not on a delay). */
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

test('Ctrl+R opens the history panel; Enter fills the editor and does NOT submit', async () => {
  const home = tempHome()
  try {
    const { vt, app, submitted } = await makeApp(home)
    app.setDraft('existing draft')
    await vt.waitForRender()
    vt.sendInput('\x12') // Ctrl+R
    await vt.waitForRender()
    assert.ok(panelVisible(vt.getViewport()), 'the history panel must be visible')
    vt.sendInput('nginx')
    // Settle on the RESULT state (the filtered row painted), never on a
    // fixed delay: the debounce + file read must complete before Enter.
    await waitFor(() => vt.getViewport().some(line => line.includes('fix nginx reload')))
    vt.sendInput('\r') // Enter = accept
    await vt.waitForRender()
    assert.equal(app.getDraft(), 'fix nginx reload', 'the selected history text replaces the draft')
    assert.deepEqual(submitted, [], 'accept must NEVER submit')
    app.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Esc closes the panel and leaves the original draft untouched', async () => {
  const home = tempHome()
  try {
    const { vt, app, submitted } = await makeApp(home)
    app.setDraft('my draft in progress')
    await vt.waitForRender()
    vt.sendInput('\x12') // Ctrl+R
    await vt.waitForRender()
    assert.ok(panelVisible(vt.getViewport()))
    vt.sendInput('\x1b') // Esc
    await vt.waitForRender()
    assert.ok(!panelVisible(vt.getViewport()), 'Esc must close the panel')
    assert.equal(app.getDraft(), 'my draft in progress', 'Esc must never modify the draft')
    assert.deepEqual(submitted, [], 'Esc must never submit')
    app.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an active transcript-search overlay keeps its keys (Ctrl+R never opens a second panel)', async () => {
  const home = tempHome()
  try {
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
    await vt.waitForRender()
    app.startTranscriptSearch()
    await vt.waitForRender()
    assert.ok(app.isSearching())
    vt.sendInput('\x12') // Ctrl+R
    await vt.waitForRender()
    assert.ok(app.isSearching(), 'the search overlay stays up')
    assert.ok(!panelVisible(vt.getViewport()), 'the history panel must NOT open over the search overlay')
    app.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Ctrl+R resolves the Current directory at OPEN time (a session switch moves the scope)', async () => {
  // Review repro: the app is constructed while the cwd is /work/a; a
  // session switch moves the live cwd to /work/b; Ctrl+R must search
  // /work/b, never the construction-time snapshot.
  const home = tempHome()
  try {
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
    app.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('UI4: Ctrl+R captures the session identity at OPEN time (a session switch moves the scope)', async () => {
  // The session scope's identity getter must be read at open time, never
  // captured at construction: a switch between opens makes the next
  // Ctrl+R search the NEW session.
  const home = tempHome()
  try {
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
    await vt.waitForRender()
    vt.sendInput('\x12') // Ctrl+R
    await vt.waitForRender()
    await waitFor(() => vt.getViewport().some(line => line.includes('prompt from A')))
    assert.ok(!vt.getViewport().some(line => line.includes('prompt from B')),
      'the session scope must filter by the LIVE session identity')
    vt.sendInput('\x1b') // Esc closes the panel
    await vt.waitForRender()
    // "Session switch": the live identity moves before the next Ctrl+R.
    liveSessionId = 'ses_b'
    vt.sendInput('\x12')
    await vt.waitForRender()
    await waitFor(() => vt.getViewport().some(line => line.includes('prompt from B')))
    assert.ok(!vt.getViewport().some(line => line.includes('prompt from A')),
      'the reopened panel must search the NEW session, not the construction snapshot')
    app.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Ctrl+R on a TINY terminal (8 rows) never clips the panel footer', async () => {
  // Round-5 repro: maxHeight 6 on an 8-row terminal; the panel's old
  // unconditional maxRows floor pushed the framed output past the overlay
  // and clipped the footer. The panel must fit the available height.
  const home = tempHome()
  try {
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
    await vt.waitForRender()
    vt.sendInput('\x12') // Ctrl+R
    await vt.waitForRender()
    const viewport = vt.getViewport()
    assert.ok(viewport.some(line => line.includes('History')), 'the panel must open')
    assert.ok(viewport.some(line => line.includes('Esc cancel')), 'the footer hint must stay visible')
    app.stop()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('plugin keybindings can never claim Ctrl+R (host-reserved)', async () => {
  const home = tempHome()
  try {
    const { VirtualTerminal } = await import('./virtual-terminal.ts')
    const { TuiApp } = await import('../src/tui-app.ts')
    const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
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
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})