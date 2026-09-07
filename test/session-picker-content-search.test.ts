/**
 * Session Browser content-search integration (plan §8/§9/§10/§11): /sessions,
 * /resume and /search share ONE `openSessionPicker` lifecycle; Host content
 * search is a 250ms-debounced async augmentation of the local metadata
 * filter — hits merge onto already-listed rows, capability-unavailable and
 * provider failures degrade non-fatally, and close/supersede aborts the
 * pending or in-flight search.
 * @module @xmoon76/dsh-pi-tui/session-picker-content-search.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
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
import type { SessionContentSearchPage } from '../src/runtime/session-reader-port.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** Poll `predicate` until true or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
}

interface SearchCall {
  query: string
  signal?: AbortSignal
}

interface Harness {
  vt: VirtualTerminal
  app: TuiApp
  runSearch: (rawInput: string) => Promise<unknown>
  runSessions: (rawInput: string) => Promise<unknown>
  runResume: (rawInput: string) => Promise<unknown>
  view: () => string
  switched: string[]
  notices: Array<{ text: string; kind: string }>
  searchCalls: SearchCall[]
  rawWrites: string[]
}

interface Row {
  id: string
  createdAt: number
  cwd?: string
  origin?: 'subagent'
  live?: boolean
}

/** Mount the command surface with an injectable sessionReader. */
function harness(options: {
  rows?: Row[]
  search?: (query: string, signal?: AbortSignal) => Promise<SessionContentSearchPage | undefined>
  list?: (id: string | undefined, signal?: AbortSignal) => Promise<Row[] | undefined>
  projectionBatch?: () => Promise<Map<string, { title?: string; preset?: string }>>
}): Harness {
  const ctx = new Context()
  const vt = new VirtualTerminal(80, 24)
  // Record every raw terminal write: terminal-injection assertions must
  // check the write stream, not the viewport (an OSC/CSI payload is
  // consumed by the emulator and may never appear in the view).
  const rawWrites: string[] = []
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    rawWrites.push(data)
    originalWrite(data)
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { notifyDurationMs: 60_000 })
  app.start()
  startedApps.add(app)
  const notices: Array<{ text: string; kind: string }> = []
  const originalNotify = app.notify.bind(app)
  app.notify = (text, kind = 'info') => {
    notices.push({ text, kind })
    originalNotify(text, kind)
  }
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
  const searchCalls: SearchCall[] = []
  const rows = options.rows ?? []
  const search = options.search ?? (async () => ({ items: [], hasMore: false }))
  const list = options.list ?? (async () => rows)
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
    sessionReader: {
      list,
      search: async (query: string, signal?: AbortSignal) => {
        searchCalls.push({ query, signal })
        return search(query, signal)
      },
      projectionBatch: options.projectionBatch ?? (async () => new Map()),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    } as never,
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
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
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
  const resumeDef = defs.find(entry => entry.name === 'resume')
  assert.ok(resumeDef?.handler !== undefined, 'resume alias handler missing')
  const searchDef = defs.find(entry => entry.name === 'search')
  assert.ok(searchDef?.handler !== undefined, 'search handler missing')
  const invoke = (handler: unknown, rawInput: string) =>
    (handler as (inv: { commandId: string; agent: never; rawInput: string; signal: AbortSignal }) => Promise<unknown>)({
      commandId: CommandId('cmd-test-1'),
      agent: undefined as never,
      rawInput,
      signal: new AbortController().signal,
    })
  return {
    vt,
    app,
    runSearch: (rawInput: string) => invoke(searchDef!.handler, rawInput),
    runSessions: (rawInput: string) => invoke(def!.handler, rawInput),
    runResume: (rawInput: string) => invoke(resumeDef!.handler, rawInput),
    view: () => vt.getViewport().join('\n'),
    switched,
    notices,
    searchCalls,
    rawWrites,
  }
}

const rows = (): Row[] => [
  { id: 'session-alpha', createdAt: 300, cwd: '/ws' },
  { id: 'session-beta', createdAt: 200, cwd: '/ws' },
]

test('/search with an empty argument is rejected before any overlay opens', async (t) => {
  const h = harness({ rows: rows() })
  t.after(() => h.app.stop())
  const result = await h.runSearch('   ')
  assert.deepEqual(result, { kind: 'error', text: 'search needs a query' })
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Current directory'), 'no picker may open for an empty /search')
  assert.equal(h.searchCalls.length, 0)
})

test('/search foo opens the SAME Session Browser and runs a debounced content search', async (t) => {
  const h = harness({
    rows: rows(),
    search: async (query) => ({ items: [{ sessionId: 'session-alpha', snippet: `needle in ${query}` }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.view().includes('alpha'))
  const view = h.view()
  assert.ok(view.includes('search · Search results'), `a query must enter the global search projection:\n${view}`)
  assert.ok(!view.includes('beta'), 'the argument must act as the live filter')
  // The content search runs after the 250ms debounce, only after the list
  // baseline landed.
  await waitUntil(() => h.searchCalls.length === 1)
  assert.equal(h.searchCalls[0]!.query, 'needle')
  await waitUntil(() => h.view().includes('needle in needle'))
  assert.ok(h.view().includes('…needle in needle…'), 'the hit snippet must enrich the row description')
})

test('content search unavailable keeps the picker open with local filtering and notices once', async (t) => {
  const h = harness({ rows: rows(), search: async () => undefined })
  t.after(() => h.app.stop())
  await h.runSearch('alpha')
  await waitUntil(() => h.view().includes('alpha'))
  await waitUntil(() => h.notices.some(notice => notice.text === 'content search unavailable'))
  assert.equal(h.notices.filter(notice => notice.text === 'content search unavailable').length, 1)
  // The picker stays open and the local metadata filter still works.
  const view = h.view()
  assert.ok(view.includes('search · Search results'), 'the picker must stay open when content search is unavailable')
  assert.ok(!view.includes('beta'), 'local metadata filtering must keep working')
  // A second query does not re-notice (once per picker lifecycle).
  h.vt.sendInput('beta')
  await h.vt.waitForRender()
  await waitUntil(() => h.view().includes('beta'))
  assert.equal(h.notices.filter(notice => notice.text === 'content search unavailable').length, 1)
})

test('a content-only hit becomes visible through its snippet under the local filter', async (t) => {
  const h = harness({
    rows: rows(),
    search: async () => ({ items: [{ sessionId: 'session-beta', snippet: 'needle found in beta' }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  // Neither row matches 'needle' by metadata — the picker shows no rows.
  await waitUntil(() => h.searchCalls.length === 1)
  await waitUntil(() => h.view().includes('needle found in beta'))
  const view = h.view()
  assert.ok(view.includes('beta'), 'the content-only hit must surface through its snippet')
  assert.ok(view.includes('…needle found in beta…'), 'the snippet must be part of the row description')
})

test('unknown hit ids are ignored and subagent hits never enter the browser', async (t) => {
  const h = harness({
    rows: [...rows(), { id: 'session-child', createdAt: 100, cwd: '/ws', origin: 'subagent' }],
    search: async () => ({
      items: [
        { sessionId: 'session-ghost', snippet: 'needle ghost' },
        { sessionId: 'session-child', snippet: 'needle child' },
        { sessionId: 'session-alpha', snippet: 'needle alpha' },
      ],
      hasMore: false,
    }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  await waitUntil(() => h.view().includes('needle alpha'))
  const view = h.view()
  assert.ok(!view.includes('ghost'), 'an unknown hit id must not create a row')
  assert.ok(!view.includes('child'), 'a subagent hit must not enter the human Session Browser')
  assert.ok(view.includes('alpha'), 'the known main-row hit must merge')
})

test('search results are global: the browse scope never hides Host hits (review P1)', async (t) => {
  // The Host returns a bounded GLOBAL top-20. If the top 20 all belong to
  // /other and the real current-workspace match ranks 21st, the old
  // Current-directory post-filter would hide it. The search projection
  // must show Host hits from ANY workspace.
  const h = harness({
    rows: [
      { id: 'session-here', createdAt: 300, cwd: '/ws' },
      { id: 'session-there', createdAt: 200, cwd: '/other' },
    ],
    search: async () => ({
      items: [
        { sessionId: 'session-here', snippet: 'needle here' },
        { sessionId: 'session-there', snippet: 'needle there' },
      ],
      hasMore: false,
    }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  await waitUntil(() => h.view().includes('needle here'))
  const view = h.view()
  assert.ok(view.includes('Search results'), 'a query must enter the global search projection')
  assert.ok(view.includes('there'), 'a Host hit from another workspace must be visible in the search view')
  assert.ok(view.includes('here'), 'a Host hit from the current workspace must be visible too')
})

test('rapid query changes abort the superseded search and only the latest result refreshes', async (t) => {
  let resolveFoo!: (page: SessionContentSearchPage) => void
  const fooSignal: AbortSignal[] = []
  const h = harness({
    rows: rows(),
    search: async (query, signal) => {
      if (query === 'foo') {
        fooSignal.push(signal!)
        return new Promise<SessionContentSearchPage>(resolve => { resolveFoo = resolve })
      }
      return { items: [{ sessionId: 'session-beta', snippet: 'bar result' }], hasMore: false }
    },
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  // Type 'foo' (search pends), then replace the query with 'bar' before it
  // settles (backspace clears the search box, then the new text types in).
  h.vt.sendInput('foo')
  await waitUntil(() => fooSignal.length === 1)
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('bar')
  await waitUntil(() => h.searchCalls.length === 2)
  assert.equal(fooSignal[0]!.aborted, true, 'the superseded query must abort its in-flight search')
  // The late foo result must not refresh the UI.
  resolveFoo({ items: [{ sessionId: 'session-alpha', snippet: 'stale foo result' }], hasMore: false })
  await new Promise<void>(resolve => setImmediate(resolve))
  await waitUntil(() => h.view().includes('bar result'))
  const view = h.view()
  assert.ok(!view.includes('stale foo result'), 'a late superseded result must never refresh the picker')
})

test('closing the picker aborts the in-flight content search', async (t) => {
  let resolveSearch!: (page: SessionContentSearchPage) => void
  const observed: AbortSignal[] = []
  const h = harness({
    rows: rows(),
    search: async (_query, signal) => {
      observed.push(signal!)
      return new Promise<SessionContentSearchPage>(resolve => { resolveSearch = resolve })
    },
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => observed.length === 1)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(observed[0]!.aborted, true, 'Esc must abort the pending content search')
  resolveSearch({ items: [{ sessionId: 'session-alpha', snippet: 'late' }], hasMore: false })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(!h.view().includes('late'), 'a late result must not refresh the closed picker')
})

test('a provider failure keeps the local rows and the picker open', async (t) => {
  const h = harness({
    rows: rows(),
    search: async () => { throw new Error('fts backend exploded') },
  })
  t.after(() => h.app.stop())
  await h.runSearch('alpha')
  await waitUntil(() => h.view().includes('alpha'))
  await waitUntil(() => h.notices.some(notice => notice.text === 'session content search failed: fts backend exploded'))
  const view = h.view()
  assert.ok(view.includes('search · Search results'), 'the picker must stay open after a provider failure')
  assert.ok(view.includes('alpha'), 'local rows must survive a provider failure')
})

test('hasMore shows the refine hint', async (t) => {
  const h = harness({
    rows: rows(),
    search: async () => ({ items: [{ sessionId: 'session-alpha', snippet: 'needle alpha' }], hasMore: true }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  await waitUntil(() => h.notices.some(notice => notice.text === 'More content matches exist — refine the search.'))
})

test('/resume with a unique match switches without starting a content search', async (t) => {
  const h = harness({ rows: rows() })
  t.after(() => h.app.stop())
  await h.runResume('alpha')
  await waitUntil(() => h.switched.length === 1)
  assert.deepEqual(h.switched, ['session-alpha'])
  await new Promise<void>(resolve => setTimeout(resolve, 400))
  assert.equal(h.searchCalls.length, 0, 'the direct fast path must not start a content search')
})

test('/resume with no match keeps the picker and starts a content search', async (t) => {
  const h = harness({
    rows: rows(),
    search: async (query) => ({ items: [{ sessionId: 'session-alpha', snippet: `needle in ${query}` }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runResume('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  assert.equal(h.searchCalls[0]!.query, 'needle')
  await waitUntil(() => h.view().includes('needle in needle'))
  assert.ok(h.view().includes('resume · Search results'), 'the unmatched /resume stays in the SAME picker, in the search projection')
})

test('/sessions foo applies the filter after the list lands and starts a content search', async (t) => {
  const h = harness({
    rows: rows(),
    search: async (query) => ({ items: [{ sessionId: 'session-alpha', snippet: `needle in ${query}` }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('needle')
  await waitUntil(() => h.view().includes('alpha'))
  await waitUntil(() => h.searchCalls.length === 1)
  assert.equal(h.searchCalls[0]!.query, 'needle')
  const view = h.view()
  assert.ok(view.includes('sessions · Search results'), 'a /sessions argument must enter the search projection')
  assert.ok(!view.includes('beta'), 'the argument must act as the live filter')
})

test('a query change drops the previous query enrichment immediately', async (t) => {
  let resolveFirst!: (page: SessionContentSearchPage) => void
  const h = harness({
    rows: [
      { id: 'session-one', createdAt: 300, cwd: '/ws' },
      { id: 'session-two', createdAt: 200, cwd: '/ws' },
    ],
    search: async (query) => {
      if (query === 'needle') {
        return new Promise<SessionContentSearchPage>(resolve => { resolveFirst = resolve })
      }
      return { items: [], hasMore: false }
    },
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  resolveFirst({ items: [{ sessionId: 'session-one', snippet: 'needle alpha' }], hasMore: false })
  await waitUntil(() => h.view().includes('needle alpha'))
  // Replace the query with 'alpha': the OLD snippet contains 'alpha', so
  // without the clear-on-change fix the stale hit would keep the row
  // visible under the new filter until the new search lands.
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('alpha')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('needle alpha'), 'the previous query hits must not linger under the new filter')
})

test('a malicious snippet with terminal control sequences renders inert', async (t) => {
  const h = harness({
    rows: rows(),
    search: async () => ({ items: [{ sessionId: 'session-alpha', snippet: '\x1b]0;PWNED\x07\u009b2Jneedle' }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  // The complete OSC sequence is removed by the sanitizer, so the row
  // still surfaces through the surviving 'needle' text — with no control
  // bytes and no injected payload.
  await waitUntil(() => h.view().includes('alpha'))
  const view = h.view()
  assert.ok(!view.includes('\x1b'), 'the raw ESC must never reach the terminal')
  assert.ok(!view.includes('\x07'), 'the raw BEL must never reach the terminal')
  assert.ok(!view.includes('\u009b'), 'the raw C1 CSI must never reach the terminal')
  assert.ok(!view.includes('PWNED'), 'the OSC payload must not survive as text')
})

test('a whitespace-only filter never triggers a content search', async (t) => {
  const h = harness({ rows: rows() })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  h.vt.sendInput(' ')
  await h.vt.waitForRender()
  await new Promise<void>(resolve => setTimeout(resolve, 400))
  assert.equal(h.searchCalls.length, 0, 'a whitespace-only filter must not call the Host search')
  assert.equal(
    h.notices.filter(notice => notice.text.startsWith('session content search failed')).length,
    0,
    'a whitespace-only filter must not surface as a search failure',
  )
})

test('a whitespace-padded filter sends the canonical query and still shows the hit (review P1)', async (t) => {
  const h = harness({
    rows: rows(),
    search: async (query) => ({ items: [{ sessionId: 'session-alpha', snippet: `needle in ${query}` }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  // Type a leading space, then the query: the Host search must receive
  // the canonical (trimmed) query — never the raw padded text — and the
  // hit must still display (the search projection does not re-filter by
  // the raw input text).
  h.vt.sendInput(' ')
  h.vt.sendInput('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  assert.equal(h.searchCalls[0]!.query, 'needle', 'the Host search must receive the canonical query')
  await waitUntil(() => h.view().includes('needle in needle'))
  assert.ok(h.view().includes('alpha'), 'the Host hit must be visible under the whitespace-padded input')
})

test('an over-long filter still surfaces the Host hit for the searched prefix (review P1)', async (t) => {
  const long = 'x'.repeat(600)
  const h = harness({
    rows: rows(),
    search: async (query) => ({ items: [{ sessionId: 'session-alpha', snippet: `hit ${query.slice(0, 20)}` }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  h.vt.sendInput(long)
  await waitUntil(() => h.searchCalls.length === 1)
  assert.equal(h.searchCalls[0]!.query.length, 500, 'the Host search must receive the bounded canonical query')
  // The canonical 500-char query was searched; the hit is in the union and
  // the SelectList renders without a substring re-filter — the row shows.
  await waitUntil(() => h.view().includes('hit x'))
  assert.ok(h.view().includes('alpha'), 'the Host hit for the searched prefix must be visible')
})

test('a malicious provider error message never reaches the terminal raw', async (t) => {
  const h = harness({
    rows: rows(),
    search: async () => { throw new Error('\x1b]0;PWNED\x07boom') },
  })
  t.after(() => h.app.stop())
  await h.runSearch('alpha')
  await waitUntil(() => h.notices.some(notice => notice.text.startsWith('session content search failed')))
  // The notify text itself is sanitized (the notice is captured before
  // rendering), and the RAW write stream must never carry the payload.
  const notice = h.notices.find(entry => entry.text.startsWith('session content search failed'))!
  assert.ok(!notice.text.includes('\x1b'), 'the notice text must be sanitized')
  assert.ok(!notice.text.includes('PWNED'), 'the OSC payload must not survive in the notice')
  const raw = h.rawWrites.join('')
  assert.ok(!raw.includes('\x1b]0;PWNED'), 'the raw terminal stream must never carry the injected sequence')
})

test('a pre-list whitespace-padded filter is canonicalized before the client cap', async (t) => {
  let resolveList!: (rows: Row[]) => void
  const h = harness({
    list: () => new Promise<Row[]>(resolve => { resolveList = resolve }),
    search: async () => ({ items: [], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await h.vt.waitForRender()
  // Type a leading space + exactly 500 chars while the list pends: the
  // recorded query must be canonicalized (trimmed) BEFORE the 500-unit
  // client cap, so the Host receives the full 500-char query — never a
  // 499-char query with a stray leading space.
  h.vt.sendInput(' ')
  h.vt.sendInput('x'.repeat(500))
  resolveList(rows())
  await waitUntil(() => h.searchCalls.length === 1)
  assert.equal(h.searchCalls[0]!.query.length, 500, 'the Host must receive the full trimmed 500-char query')
  assert.ok(!h.searchCalls[0]!.query.startsWith(' '), 'the Host query must be canonical (no leading space)')
})

test('typing a query enters the search projection; clearing restores the browse state', async (t) => {
  const h = harness({ rows: rows() })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  assert.ok(h.view().includes('Current directory'), 'the picker opens in browse state')
  h.vt.sendInput('alpha')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Search results'), 'a query must enter the search projection')
  // Clear the query: back to the browse state.
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Current directory'), 'clearing the query must restore the browse state')
})

test('clearing a query restores the previous browse category', async (t) => {
  const h = harness({ rows: rows() })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  // Switch to All directories, then type a query.
  h.vt.sendInput('\t')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('All directories'))
  h.vt.sendInput('alpha')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Search results'))
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('All directories'), 'clearing must restore the previous browse category')
})

test('a Host hit displays even when its snippet lacks the query literal (review P1)', async (t) => {
  // DSH only guarantees the snippet is a plain-text excerpt around the
  // match — never that it contains the caller's raw query string. The
  // search projection's membership is the explicit union; the SelectList
  // renders without a substring re-filter, so a Host-authoritative hit is
  // never dropped.
  const h = harness({
    rows: rows(),
    search: async () => ({ items: [{ sessionId: 'session-alpha', snippet: 'found it' }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  await waitUntil(() => h.view().includes('found it'))
  const view = h.view()
  assert.ok(view.includes('alpha'), 'the Host hit must be visible in the search projection')
  assert.ok(!view.includes('· needle'), 'the query must never be appended to the description')
})

test('Tab never leaves the search projection while a query is active', async (t) => {
  const h = harness({ rows: rows() })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  h.vt.sendInput('alpha')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Search results'))
  h.vt.sendInput('\t')
  await h.vt.waitForRender()
  const view = h.view()
  assert.ok(view.includes('Search results'), 'Tab must not leave the search projection while a query is active')
  assert.ok(!view.includes('Current directory'), 'the browse tabs must not wrap global search results')
  assert.ok(!view.includes('All directories'), 'the browse tabs must not wrap global search results')
})

test('enriched title and preset feed the local metadata search', async (t) => {
  const h = harness({
    rows: rows(),
    projectionBatch: async () => new Map([['session-alpha', { title: 'the fixed title', preset: 'minimal' }]]),
    search: async () => ({ items: [], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('the fixed title'))
  // The raw list rows carry no title/preset — the search projection must
  // match through the enriched metadata (review round 4).
  h.vt.sendInput('fixed')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('alpha'), 'a title match must enter the search projection')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('\x7f')
  h.vt.sendInput('minimal')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('alpha'), 'a preset match must enter the search projection')
})

test('a cwd query finds rows through the searchable description', async (t) => {
  const h = harness({
    rows: [
      { id: 'session-aaa', createdAt: 300, cwd: '/ws' },
      { id: 'session-bbb', createdAt: 200, cwd: '/other' },
    ],
    search: async () => ({ items: [], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('aaa'))
  // The cwd lives in the group header in the browse view; the search
  // projection must carry it in the searchable description (the SelectList
  // never searches the group — review round 4).
  h.vt.sendInput('/other')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('bbb'), 'a cwd match must be visible in the search projection')
  assert.ok(!h.view().includes('aaa'), 'non-matching rows must stay hidden')
})

test('a malicious cwd never reaches the terminal through the search description', async (t) => {
  const h = harness({
    rows: [{ id: 'session-evil', createdAt: 300, cwd: '/ws\x1b]0;PWNED\x07' }],
    search: async () => ({ items: [], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await h.vt.waitForRender()
  // The sanitized cwd ('/ws') is searchable, so the row DISPLAYS in the
  // search projection — its group header AND description must carry the
  // sanitized cwd only (the injected OSC must never reach the terminal).
  h.vt.sendInput('/ws')
  await h.vt.waitForRender()
  await waitUntil(() => h.view().includes('evil'))
  const raw = h.rawWrites.join('')
  assert.ok(!raw.includes('\x1b]0;PWNED'), 'the raw terminal stream must never carry the injected cwd sequence')
  const view = h.view()
  assert.ok(!view.includes('\x1b'), 'the raw ESC must never reach the terminal')
})

test('content-only matches keep the Host page order (review P2)', async (t) => {
  // session-a is NEWER (list order a, b), but the Host page returns
  // [b, a] — the content-only rows must follow the Host page order, never
  // the newest-first list order.
  const h = harness({
    rows: [
      { id: 'session-a', createdAt: 300, cwd: '/ws' },
      { id: 'session-b', createdAt: 200, cwd: '/ws' },
    ],
    search: async () => ({
      items: [
        { sessionId: 'session-b', snippet: 'needle b' },
        { sessionId: 'session-a', snippet: 'needle a' },
      ],
      hasMore: false,
    }),
  })
  t.after(() => h.app.stop())
  await h.runSearch('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  await waitUntil(() => h.view().includes('needle b'))
  const lines = h.view().split('\n')
  const bIndex = lines.findIndex(line => line.includes('needle b'))
  const aIndex = lines.findIndex(line => line.includes('needle a'))
  assert.ok(bIndex >= 0 && aIndex >= 0, 'both content-only hits must display')
  assert.ok(bIndex < aIndex, 'the Host page order must be preserved (b before a)')
})

test('the search projection overlay keeps the full row budget (no bottom truncation)', async (t) => {
  // The external search Input renders ABOVE the SelectList, outside its
  // maxRows budget — the frame must reserve those rows or the compositor
  // truncates the bottom (hint/border). Many distinct groups force the
  // item window to fill the budget, which is what triggers the overflow
  // (review round 6).
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `session-${i}`, createdAt: 1_000_000_000_000 + i, cwd: `/ws-${i}` }))
  const h = harness({ rows: many, search: async () => ({ items: [], hasMore: false }) })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('Current directory'))
  h.vt.sendInput('session')
  await h.vt.waitForRender()
  await waitUntil(() => h.view().includes('Search results'))
  const lines = h.view().split('\n')
  const boxTop = lines.findIndex(line => line.includes('╭'))
  const boxBottom = lines.findIndex(line => line.includes('╰'))
  assert.ok(boxTop >= 0 && boxBottom > boxTop, 'the overlay frame must render')
  assert.ok(lines.join('\n').includes('↑↓ navigate'), 'the hint must stay visible')
  assert.ok(boxBottom < lines.length - 1, 'the bottom border must not be truncated')
})

test('a raw edit that does not change the canonical query does not restart the search', async (t) => {
  const h = harness({
    rows: rows(),
    search: async () => ({ items: [{ sessionId: 'session-alpha', snippet: 'needle found' }], hasMore: false }),
  })
  t.after(() => h.app.stop())
  await h.runSessions('')
  await waitUntil(() => h.view().includes('alpha'))
  h.vt.sendInput('needle')
  await waitUntil(() => h.searchCalls.length === 1)
  // Padding whitespace around the same term: the canonical is unchanged,
  // so the identical Host search must NOT be aborted/restarted.
  h.vt.sendInput(' ')
  await h.vt.waitForRender()
  await new Promise<void>(resolve => setTimeout(resolve, 400))
  assert.equal(h.searchCalls.length, 1, 'an unchanged canonical query must not restart the Host search')
})
