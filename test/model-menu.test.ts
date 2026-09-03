/**
 * Headless tests for the /model in-place submenu flow: loading → model
 * list → effort list, with immediate apply and Esc walking back one level,
 * plus async-cancellation races (a resolve/reject landing after Esc must
 * never apply a model or repaint a closed menu). No second overlay is
 * mounted at any point (the ghost-overlay trap the nested-openSettings
 * pattern fell into).
 * @module @xmoon76/dsh-pi-tui/model-menu.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { ModelSubmenu } from '../src/model-menu.ts'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
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
    try { app.dispose() } catch {}
  }
})


/** A promise the test resolves/rejects manually, to stage late completions. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FakeLlm {
  models: readonly { id: string }[]
  efforts: readonly { id: string; name: string }[] | undefined
}

function fakeLlm(shape: FakeLlm): {
  listModels: () => Promise<readonly { id: string }[]>
  resolveModelInfo: () => Promise<{ reasoning?: { efforts?: readonly { id: string; name: string }[] } }>
} {
  return {
    listModels: async () => shape.models,
    resolveModelInfo: async () => shape.efforts === undefined ? {} : { reasoning: { efforts: shape.efforts } },
  }
}

/** Drive the flow: open the settings list, Enter into the provider submenu. */
async function openModelFlow(
  llm: { listModels: (...args: never[]) => Promise<readonly { id: string }[]>; resolveModelInfo: (...args: never[]) => Promise<unknown> },
  applied: ModelSelection[],
): Promise<{ vt: VirtualTerminal; app: TuiApp; lines: string[] }> {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const current = { provider: 'p', model: 'm0' } as ModelSelection
  // The real owned-task entry, with a capture diag (the runner wires
  // runOwned with its own diag in production).
  const lines: string[] = []
  const diag = createDiag({
    filePath: undefined,
    stderrLevel: 'off',
    sinks: [{ write: (line: string) => { lines.push(line) } }],
  })
  const owned = <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void => {
    runOwned(label, task, { ...options, diag })
  }
  app.openSettings(
    [{
      id: 'p',
      label: 'provider',
      currentValue: current.model,
      submenu: (value, done) => new ModelSubmenu('p', current.model, undefined, {
        listModels: llm.listModels as never,
        resolveModelInfo: llm.resolveModelInfo as never,
        apply: (next) => applied.push(next),
        requestRender: () => app.requestRender(),
        done,
        runOwned: owned,
      }),
    }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  vt.sendInput('\r') // Enter: open the provider's model submenu
  return { vt, app, lines }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** Let queued promise continuations and paints settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

test('model submenu reflows to a short terminal without losing the selected model or hint', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({ models: Array.from({ length: 12 }, (_, index) => ({ id: `m${index}` })), efforts: undefined }),
    applied,
  )
  await settle()
  for (let index = 0; index < 6; index += 1) vt.sendInput('\x1b[B') // select m6
  await vt.waitForRender()
  vt.resize(80, 10) // shrink: the outer grant (maxRows = min(rows,28) − 2) must reach the inner model list
  await settle()
  const view = await viewport(vt)
  assert.ok(view.includes('m6'), `selected model must survive the shrink:\n${view}`)
  assert.ok(view.includes('Esc to cancel'), `submenu hint must survive the shrink:\n${view}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('model submenu applies the row budget to a list that lands after a resize', async () => {
  const applied: ModelSelection[] = []
  let resolveModels!: (rows: readonly { id: string }[]) => void
  const deferred = {
    listModels: () => new Promise<readonly { id: string }[]>((resolve) => { resolveModels = resolve }),
    resolveModelInfo: async (): Promise<unknown> => ({}),
  }
  const { vt } = await openModelFlow(deferred, applied)
  // Resize WHILE the model list is still loading: the grant lands on the
  // loading shell and must be re-applied when the async list swaps in —
  // without the rowGrant re-apply the inner list would keep maxVisible 6
  // and the 8-row frame would clip the hint.
  vt.resize(80, 10)
  await vt.waitForRender()
  resolveModels(Array.from({ length: 12 }, (_, index) => ({ id: `m${index}` })))
  await settle()
  const view = await viewport(vt)
  assert.ok(view.includes('m0'), `the swapped-in model list must render the selected row:\n${view}`)
  assert.ok(view.includes('Esc to cancel'), `the swapped-in list must honor the grant (hint needs re-apply):\n${view}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
})

test('model submenu loads the model list in place and applies on selection', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({ models: [{ id: 'm1' }, { id: 'm2' }], efforts: undefined }),
    applied,
  )
  await settle()
  let view = await viewport(vt)
  assert.ok(view.includes('m1') && view.includes('m2'), `model list missing:\n${view}`)
  vt.sendInput('\r') // select the first model (no effort route)
  await settle()
  await vt.waitForRender()
  assert.deepEqual(applied, [{ provider: 'p', model: 'm1' }], 'model selection must apply')
  view = await viewport(vt)
  assert.ok(view.includes('m1'), `back on the model list:\n${view}`)
})

test('model with reasoning efforts offers the effort list and applies effort', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({
      models: [{ id: 'm1' }, { id: 'm2' }],
      efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }],
    }),
    applied,
  )
  await settle()
  let view = await viewport(vt)
  assert.ok(view.includes('m1'), `model list missing:\n${view}`)
  vt.sendInput('\r') // m1 has efforts → effort list opens
  await settle()
  view = await viewport(vt)
  assert.ok(view.includes('High') && view.includes('Low'), `effort list missing:\n${view}`)
  vt.sendInput('\x1b[B') // down from 'Default' to 'High'
  vt.sendInput('\r') // select High
  await settle()
  await vt.waitForRender()
  assert.deepEqual(
    applied,
    [{ provider: 'p', model: 'm1', reasoningEffort: 'high' }],
    'effort selection must apply with the model',
  )
})

test('esc walks back one level from the effort list, never a ghost panel', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(
    fakeLlm({
      models: [{ id: 'm1' }],
      efforts: [{ id: 'high', name: 'High' }],
    }),
    applied,
  )
  await settle()
  vt.sendInput('\r') // m1 → effort list
  await settle()
  let view = await viewport(vt)
  assert.ok(view.includes('High'), `effort list missing:\n${view}`)
  vt.sendInput('\x1b') // esc: back to the model list
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('m1') && !view.includes('High'), `expected model list after esc:\n${view}`)
  vt.sendInput('\x1b') // esc: back to the provider list
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('provider'), `expected provider list after second esc:\n${view}`)
  vt.sendInput('\x1b') // esc: closes the settings overlay entirely
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(!view.includes('provider'), `overlay still mounted after third esc:\n${view}`)
  assert.deepEqual(applied, [], 'nothing applied while just navigating')
})

// --- async cancellation races: late completions after Esc must not act ---

test('effort info resolving after Esc never applies the model', async () => {
  const applied: ModelSelection[] = []
  const info = deferred<{ reasoning?: { efforts?: readonly { id: string; name: string }[] } }>()
  const { vt } = await openModelFlow({
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => info.promise,
  }, applied)
  await settle()
  vt.sendInput('\r') // m1 → effort menu (still loading)
  await settle()
  vt.sendInput('\x1b') // esc: cancel the effort selection
  await vt.waitForRender()
  info.resolve({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
  await settle()
  assert.deepEqual(applied, [], 'a late resolve after Esc must not apply the model')
  const view = await viewport(vt)
  assert.ok(view.includes('m1'), `back on the model list:\n${view}`)
  assert.ok(!view.includes('High'), `effort list must not appear after cancel:\n${view}`)
})

test('effort info rejecting after Esc never applies and never shows a stale error', async () => {
  const applied: ModelSelection[] = []
  const info = deferred<never>()
  const { vt, lines } = await openModelFlow({
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => info.promise,
  }, applied)
  await settle()
  vt.sendInput('\r') // m1 → effort menu (still loading)
  await settle()
  vt.sendInput('\x1b') // esc: cancel
  await vt.waitForRender()
  info.reject(new Error('provider exploded'))
  await settle()
  assert.deepEqual(applied, [], 'a late reject after Esc must not apply the model')
  const view = await viewport(vt)
  assert.ok(!view.includes('unavailable'), `no stale error after cancel:\n${view}`)
  assert.ok(view.includes('m1'), `back on the model list:\n${view}`)
  // The disposed classifier routes the late rejection to a CANCELLATION:
  // debug diagnostics only — a normal Esc must never be an ERROR line.
  assert.ok(lines.some(line => /DEBUG model info/.test(line) && line.includes('cancelled=true')), lines.join(' | '))
  assert.ok(!lines.some(line => line.includes('ERROR')), `no error diagnostics for a user cancel:\n${lines.join('\n')}`)
})

test('a late effort info from an earlier selection cannot override a later one', async () => {
  const applied: ModelSelection[] = []
  const infoA = deferred<{ reasoning?: { efforts?: readonly { id: string; name: string }[] } }>()
  const infoB = deferred<{ reasoning?: { efforts?: readonly { id: string; name: string }[] } }>()
  const { vt } = await openModelFlow({
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async (_provider: string, modelId: string) => modelId === 'm1' ? infoA.promise : infoB.promise,
  }, applied)
  await settle()
  vt.sendInput('\r') // m1 → effort loading
  await settle()
  vt.sendInput('\x1b') // esc: abandon m1
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // down to m2
  vt.sendInput('\r') // m2 → effort loading
  await settle()
  // m2 settles first: no efforts → apply m2 immediately.
  infoB.resolve({})
  await settle()
  assert.deepEqual(applied, [{ provider: 'p', model: 'm2' }], 'the current selection applies')
  // m1's info lands late: it must NOT override m2.
  infoA.resolve({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
  await settle()
  assert.deepEqual(applied, [{ provider: 'p', model: 'm2' }], 'a late A must not override B')
})

test('a model list resolving after the menu closed triggers no repaint or apply', async () => {
  const applied: ModelSelection[] = []
  const list = deferred<readonly { id: string }[]>()
  const { vt } = await openModelFlow({
    listModels: async () => list.promise,
    resolveModelInfo: async () => ({}),
  }, applied)
  await settle()
  // Esc from the loading model submenu → provider list; Esc again → overlay closed.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  list.resolve([{ id: 'm1' }, { id: 'm2' }])
  await settle()
  assert.deepEqual(applied, [], 'a late list must not apply anything')
  const view = await viewport(vt)
  assert.ok(!view.includes('m1') && !view.includes('m2'), `stale model list painted after close:\n${view}`)
  assert.ok(!view.includes('Loading models'), `stale loading text painted after close:\n${view}`)
})

test('effort info reject while the menu is current shows the error in place, applies nothing', async () => {
  const applied: ModelSelection[] = []
  const info = deferred<never>()
  const { vt, lines } = await openModelFlow({
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => info.promise,
  }, applied)
  await settle()
  vt.sendInput('\r') // m1 → effort menu (still loading)
  await settle()
  info.reject(new Error('provider exploded'))
  await settle()
  assert.deepEqual(applied, [], 'an info error is not a model selection')
  const view = await viewport(vt)
  assert.ok(view.includes('model info unavailable'), `error must render in the current menu:\n${view}`)
  // A CURRENT menu's provider failure is a real failure: ERROR diagnostics.
  assert.ok(lines.some(line => /ERROR model info/.test(line) && line.includes('error=provider exploded')), lines.join(' | '))
  // Esc from the error still walks back cleanly.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const after = await viewport(vt)
  assert.ok(after.includes('m1') && !after.includes('unavailable'), `esc from the error back to the list:\n${after}`)
})

// ── requirement 6: applying an effort closes the WHOLE overlay ───────────

test('applying an effort closes the whole overlay (web settleSelection parity)', async () => {
  const applied: ModelSelection[] = []
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()

  startedApps.add(app)
  const current = { provider: 'p', model: 'm0' } as ModelSelection
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  const owned = <T>(label: string, task: () => T | Promise<T>, options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>): void => {
    runOwned(label, task, { ...options, diag })
  }
  // The SAME closer wrapper the /model command wires (commands.ts): an
  // applied selection closes the whole overlay, Esc keeps the walk-back.
  let closer: () => void = () => {}
  closer = app.openSettings(
    [{
      id: 'p',
      label: 'provider',
      currentValue: current.model,
      submenu: (value, done) => new ModelSubmenu('p', current.model, undefined, {
        listModels: async () => [{ id: 'm1' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
        apply: (next) => applied.push(next),
        requestRender: () => app.requestRender(),
        done: (picked) => {
          if (picked !== undefined) closer()
          done(picked)
        },
        runOwned: owned,
      }),
    }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  vt.sendInput('\r') // provider → model list
  await settle()
  vt.sendInput('\r') // m1 → effort list
  await settle()
  let view = await viewport(vt)
  assert.ok(view.includes('High'), `effort list missing:\n${view}`)
  vt.sendInput('\r') // select the FIRST effort row (Default)
  await settle()
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(!view.includes('provider'), `overlay must close after applying an effort:\n${view}`)
  assert.ok(!view.includes('High'), `the effort list must be gone with the overlay:\n${view}`)
  assert.deepEqual(applied, [{ provider: 'p', model: 'm1' }], 'the default effort applies the model')
  app.stop()
})

test('a model WITHOUT effort options keeps the overlay open (Esc still walks back)', async () => {
  const applied: ModelSelection[] = []
  const { vt } = await openModelFlow(fakeLlm({ models: [{ id: 'm1' }], efforts: undefined }), applied)
  await settle()
  let view = await viewport(vt)
  assert.ok(view.includes('m1'), `model list missing:\n${view}`)
  vt.sendInput('\r') // select m1 (no effort route: applies and returns to the list)
  await settle()
  await vt.waitForRender()
  view = await viewport(vt)
  assert.ok(view.includes('m1'), `the model list (overlay) must stay open without effort options:\n${view}`)
  assert.deepEqual(applied, [{ provider: 'p', model: 'm1' }], 'the model still applies')
})
