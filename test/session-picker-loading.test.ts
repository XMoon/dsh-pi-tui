/**
 * Input-first lifecycle regression for the /sessions picker (the official
 * /resume fix, mirrored): the overlay opens and owns the input BEFORE any
 * Host read settles — Esc works while `list()` pends forever, arrows /
 * search / category cycling work while a projection batch pends, closing
 * the picker aborts the scan, a late settlement never refreshes a closed
 * or superseded picker, and a progressive title refresh neither clears the
 * live search query nor re-triggers a resume.
 * @module @xmoon76/dsh-pi-tui/session-picker-loading.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** Poll `predicate` until true or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

type ProjectionMap = Map<string, { title?: string; preset?: string }>

interface Harness {
  vt: VirtualTerminal
  app: TuiApp
  runSessions: () => Promise<unknown>
  view: () => string
  switched: string[]
}

/** Mount the command surface with an injectable sessionReader. */
function harness(sessionReader: unknown): Harness {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  ctx.provide('commands', commands as never)
  const state: { agent: Agent | undefined } = { agent: undefined }
  const switched: string[] = []
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return state.agent },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    agents: {} as never,
    sessionReader: sessionReader as never,
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as never,
    hostFile: new DirectHostFilePort(() => undefined),
    requestExit: () => {},
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 1 },
    switchSession: async (id: string): Promise<string | undefined> => {
      switched.push(id)
      return undefined
    },
    transitionTo: async <T>(steps: { create: () => Promise<T> }) => ({ ok: true, next: await steps.create() }),
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    applyFooterSettings: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommands(runner)
  const def = defs.find(entry => entry.name === 'sessions')
  assert.ok(def?.handler !== undefined, 'sessions handler missing')
  const runSessions = () =>
    (def!.handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => Promise<unknown>)({
      commandId: CommandId('cmd-test-1'),
      agent: undefined as never,
      rawInput: '',
      signal: new AbortController().signal,
    })
  return {
    vt,
    app,
    runSessions,
    view: () => vt.getViewport().join('\n'),
    switched,
  }
}

const pendingList = (): Promise<never> => new Promise(() => {})

test('the picker opens and Esc cancels while list() pends forever', async (t) => {
  const h = harness({
    list: pendingList,
    search: async () => [],
    projectionBatch: async () => new Map(),
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  const result = await h.runSessions()
  assert.deepEqual(result, { kind: 'success' }, 'the handler must NOT wait for the listing')
  await h.vt.waitForRender()
  const view = h.view()
  assert.ok(view.includes('Loading sessions…'), `the loading frame must be visible without list() settling:\n${view}`)

  // Esc closes the overlay immediately — no listing settlement involved.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Loading sessions…'), 'Esc must close the pending picker immediately')
})

test('Enter on the loading placeholder never triggers a resume', async (t) => {
  const h = harness({
    list: pendingList,
    search: async () => [],
    projectionBatch: async () => new Map(),
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  await h.runSessions()
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.deepEqual(h.switched, [], 'Enter while loading must never resume a session')
})

test('arrows, search, and Esc stay responsive while a projection batch pends', async (t) => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `session-row${i}`,
    createdAt: 1_000_000 - i,
    cwd: '/ws',
    live: false,
  }))
  const h = harness({
    list: async () => rows,
    search: async () => [],
    projectionBatch: () => new Promise<ProjectionMap>(() => {}),
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  await h.runSessions()
  await waitUntil(() => h.view().includes('row0'))

  // Arrow keys move the selection while the first batch is pending.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  let view = h.view()
  assert.ok(view.includes('row3'), 'the rows stay rendered while enrichment pends')

  // Typing narrows the corpus (search works mid-enrichment).
  h.vt.sendInput('row3')
  await h.vt.waitForRender()
  view = h.view()
  assert.ok(view.includes('row3'), `the search filter must apply while enrichment pends:\n${view}`)
  assert.ok(!view.includes('row0'), 'non-matching rows must be filtered mid-enrichment')

  // Esc aborts the pending batch and closes the picker.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('row3'), 'Esc must close the picker during pending enrichment')
})

test('closing the picker aborts the pending projection batch', async (t) => {
  let observedSignal: AbortSignal | undefined
  let settleBatch!: () => void
  const rows = [{ id: 'session-a', createdAt: 10, cwd: '/ws', live: false }]
  const h = harness({
    list: async () => rows,
    search: async () => [],
    projectionBatch: (_batch: unknown, signal?: AbortSignal) => {
      observedSignal = signal
      return new Promise<ProjectionMap>(resolve => { settleBatch = () => resolve(new Map()) })
    },
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  await h.runSessions()
  await waitUntil(() => observedSignal !== undefined)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(observedSignal?.aborted, true, 'Esc must abort the pending scan')

  // A late settlement must not resurrect the closed picker.
  settleBatch()
  await new Promise<void>(resolve => setImmediate(resolve))
  const view = h.view()
  assert.ok(!view.includes('session-a'), 'a late batch result must not refresh the closed picker')
})

test('a superseding open fences the previous load out of the UI', async (t) => {
  let firstListed = 0
  let secondListed = 0
  let firstSignal: AbortSignal | undefined
  const rows = [{ id: 'session-old', createdAt: 10, cwd: '/ws', live: false }]
  const h = harness({
    list: async (_id: string | undefined, signal?: AbortSignal) => {
      if (firstListed === 0) {
        firstListed += 1
        firstSignal = signal
        return new Promise<never>(() => {}) // the superseded load never settles
      }
      secondListed += 1
      return rows
    },
    search: async () => [],
    projectionBatch: async () => new Map(),
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  await h.runSessions()
  await h.vt.waitForRender()
  // Re-open immediately: the second open supersedes and cancels the first.
  await h.runSessions()
  await waitUntil(() => secondListed === 1)
  await waitUntil(() => h.view().includes('old'))
  assert.equal(firstSignal?.aborted, true, 'the superseded load must be aborted')
})

test('a listing failure swaps the loading row for the refusal row', async (t) => {
  const h = harness({
    list: async () => undefined,
    search: async () => [],
    projectionBatch: async () => new Map(),
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  await h.runSessions()
  await waitUntil(() => h.view().includes('session persistence unavailable'))
  const view = h.view()
  assert.ok(!view.includes('Loading sessions…'), 'the refusal replaces the loading row')
})

test('progressive title enrichment preserves the live search query', async (t) => {
  const rows = [
    { id: 'session-needle', createdAt: 20, cwd: '/ws', live: false },
    { id: 'session-other', createdAt: 10, cwd: '/ws', live: false },
  ]
  let calls = 0
  let resolveBatch!: (value: ProjectionMap) => void
  const h = harness({
    list: async () => rows,
    search: async () => [],
    projectionBatch: async () => {
      calls += 1
      if (calls === 1) {
        return new Promise<ProjectionMap>(resolve => { resolveBatch = resolve })
      }
      return new Map()
    },
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' }),
  })
  t.after(() => h.app.stop())

  await h.runSessions()
  await waitUntil(() => h.view().includes('needle'))
  // Filter down to one row, then let the late title land: the query must
  // survive the refresh and the enriched title must enter the corpus.
  h.vt.sendInput('needle')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('other'), 'the filter applies before enrichment')

  resolveBatch(new Map([['session-needle', { title: 'the fixed title' }]]))
  await waitUntil(() => h.view().includes('the fixed title'))
  const view = h.view()
  assert.ok(!view.includes('other'), 'the search query must survive the progressive refresh')
})
