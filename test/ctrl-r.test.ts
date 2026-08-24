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

function seedHistory(home: string, cwd: string, rows: Array<{ content: string; ts: number }>): void {
  const file = historyFilePath(home, cwd)
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  writeFileSync(file, rows.map(row => JSON.stringify({ v: 2, content: row.content, cwd, ts: row.ts })).join('\n') + '\n', { mode: 0o600 })
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

/** Whether the panel frame is currently painted (the "History" header). */
function panelVisible(viewport: string[]): boolean {
  return viewport.some(line => line.includes('History') && line.includes('Current directory'))
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