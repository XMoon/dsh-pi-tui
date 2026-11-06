/**
 * TSP I-E real-Tern SUBJECT: the PRODUCTION Direct/TSP composition.
 *
 * `createDirectTspFixture({ externalTern: true, ... })` boots the official
 * Direct application over the real Tern-owned stdio, so the real one-time
 * `mount(image, status, historySearch)` bridge, the real
 * `FileHistorySearchSource` and the real `mountTspRenderer` History seat all
 * run inside a real `tern serve --control` pane. NO standalone raw-wire demo,
 * second SDK mount, second history source or hand-rolled production Presenter
 * is used: the production node tree is the only tree in the run.
 *
 * DECLARED STAND-INS (also written to `events.jsonl`):
 *  - the official Direct fixture's scripted LLM adapter, empty fileReferences
 *    and fixed default model;
 *  - history rows seeded into the SAME production JSONL store under an
 *    isolated `TERN_PANE_DIR/dsh-home` (`historyFilePath`, v2 rows);
 *  - a narrow `case` command channel for `state` / `exit` only. Neither the
 *    production input handlers, the editor reducer nor the seat are bypassed;
 *  - the SDK's `TERN_TSP_RECORD` wire recorder gives the flow the exact
 *    `ui.input` query props and the ONE composer's `text`/`cursor` props;
 *  - GUI / PHYSICAL_OS / IME / OS-clipboard-write / wheel-trackpad delivery is
 *    NOT_VERIFIED: `tern ctl key|type|click` is control-injected input.
 *
 * OBSERVATION HOOK: `module.registerHooks` appends a ONE-TO-ONE wrapper to the
 * `src/tui/tsp/session.ts` module source. It calls the ORIGINAL
 * `mountTspRenderer`, then records the renderer's own `bindHistorySearch`
 * install, the real Client-local copy payload and every real Submit/Cancel at
 * the bound handler boundary. It delegates every member back to the ORIGINAL
 * receiver; no production source file is modified and no production state is
 * duplicated.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-history-search-ux-subject.mts
 * @module scripts/tern-pane-history-search-ux-subject
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerHooks } from 'node:module'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern subject')
const workRoot = join(paneRoot, 'dsh-home')
const wireRecordPath = join(paneRoot, 'sdk-wire.jsonl')
mkdirSync(workRoot, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wireRecordPath

const eventsPath = join(paneRoot, 'events.jsonl')
const note = (event: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}

const observedRendererUrl = new URL('../src/tui/tsp/session.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== observedRendererUrl) return result
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source ?? '')
    const hook = `

/* TSP I-E ONE-TO-ONE subject recorder (appended, production source untouched). */
const __ieNote = (event) => globalThis.__ternPaneHistorySearchNote?.(event)
const __ieOriginalMount = mountTspRenderer
mountTspRenderer = function (...args) {
  // The decoded-key positive control wraps the SESSION ITERATOR BEFORE the
  // mount installs its own loop (the mount starts iterating synchronously), and
  // delegates one-to-one: no second reader, no private decoder, no changed
  // value. The flow reads the exact SDK Key each injected chord became.
  const sdkSession = args[0]
  const originalIterator = sdkSession[Symbol.asyncIterator]
  sdkSession[Symbol.asyncIterator] = function () {
    const inner = originalIterator.call(sdkSession)
    return {
      async next() {
        const step = await inner.next()
        if (!step.done && step.value && step.value.type === 'key') {
          const key = step.value.key
          __ieNote({ kind: 'sdk.key', name: key.name, ctrl: key.ctrl, alt: key.alt, shift: key.shift, meta: key.meta })
        }
        return step
      },
      return(value) { return inner.return ? inner.return(value) : { done: true, value } },
      throw(error) { return inner.throw ? inner.throw(error) : Promise.reject(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }
  const renderer = __ieOriginalMount(...args)
  const originalBindHistory = renderer.bindHistorySearch
  renderer.bindHistorySearch = function (binding) {
    __ieNote({ kind: 'history.bind', hasSource: typeof binding.source?.search === 'function',
      hasCwd: typeof binding.cwd === 'function', hasCapture: typeof binding.captureScope === 'function' })
    return originalBindHistory.call(renderer, binding)
  }
  const originalBindInput = renderer.bindInput
  renderer.bindInput = function (handlers) {
    const recording = {
      ...handlers,
      submit: (text, request, scopeToken) => {
        __ieNote({ kind: 'handler.submit', text, request: String(request), scopeToken })
        return handlers.submit(text, request, scopeToken)
      },
      cancel: () => { __ieNote({ kind: 'handler.cancel' }); return handlers.cancel() },
      pasteMedia: () => { __ieNote({ kind: 'handler.pasteMedia' }); return handlers.pasteMedia() },
      steer: text => { __ieNote({ kind: 'handler.steer', text }); return handlers.steer(text) },
    }
    __ieNote({ kind: 'renderer.bindInput', standIn: 'one-to-one recorder around production handlers' })
    return originalBindInput.call(renderer, recording)
  }
  globalThis.__ternPaneHistorySearchRenderer = renderer
  __ieNote({ kind: 'renderer.observed', initialDraft: renderer.composer.getDraft() })
  return renderer
}
`
    return { ...result, source: source + hook }
  },
})
;(globalThis as unknown as { __ternPaneHistorySearchNote: typeof note }).__ternPaneHistorySearchNote = note

const commandPath = join(paneRoot, 'case')
const commandResultPath = join(paneRoot, 'case-result')
const SESSION_A = 'session-history-search-a'
const HISTORY_ROWS = [
  { content: 'oldest stored prompt' },
  { content: 'middle stored prompt about tern' },
  { content: 'newest stored prompt\nwith a long second line' },
]

process.once('exit', code => note({ kind: 'process.exit', code }))
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => { resolveExit = resolve })
process.once('SIGTERM', () => setImmediate(resolveExit))
process.once('SIGINT', () => setImmediate(resolveExit))
let setupCleanup: (() => unknown) | undefined
const life: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir: prefix => { throw new Error(`external Tern fixture requires explicit workRoot, got ${prefix}`) },
  defer: cleanup => { setupCleanup = cleanup },
}

const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')
const { historyFilePath } = await import('../src/client/history/store.ts')
const { connect } = await import('@stencil-hq/tern')
const { DirectSessionWriter } = await import('../src/runtime/direct/session-writer-direct.ts')

/** Seed BOTH cwd identities the official composition reads, through the
 *  production store's OWN path: the launch cwd and the Session header cwd. */
const historyFiles = [process.cwd(), workRoot].map(cwd => {
  const file = historyFilePath(workRoot, cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, HISTORY_ROWS.map((row, index) => JSON.stringify({
    v: 2, content: row.content, cwd, ts: 1_700_000_000_000 + index, sessionId: SESSION_A,
  })).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  return { cwd, file }
})

const capabilitySession = await connect({ app: 'tern-pane-history-search-ux', timeout: 2000 })
if (capabilitySession === null) throw new Error('this subject must run inside a real Tern pane')
const caps = capabilitySession.caps
await capabilitySession.close()
note({
  kind: 'subject.ready',
  standIns: [
    'official Direct fixture: scripted LLM, empty fileReferences, fixed default model',
    'three fixture history rows in the production JSONL store under an isolated DSH_HOME',
    'case-file orchestration for state/exit only',
    'GUI/PHYSICAL_OS/IME/OS-clipboard-write/wheel: NOT_VERIFIED',
  ],
  caps,
  workRoot,
  clientCwd: process.cwd(),
  historyFiles,
  wireRecordPath,
  seededRows: HISTORY_ROWS,
  sessionA: SESSION_A,
  productionComposition: 'createDirectTspFixture(externalTern=true) -> production SurfaceRuntime.mount(3 args) -> production History seat',
})

/** ONE-TO-ONE recorder of the PRODUCTION Direct writer: unbound original,
 *  original receiver, record ONLY after the write settled, return unchanged. */
const promptPrototype = DirectSessionWriter.prototype as unknown as {
  prompt(this: typeof DirectSessionWriter.prototype, sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<unknown>
}
const originalPrompt = promptPrototype.prompt
promptPrototype.prompt = async function (this: typeof DirectSessionWriter.prototype, sessionId, message, mode) {
  const outcome = await originalPrompt.call(this, sessionId, message, mode)
  note({ kind: 'writer.prompt', sessionId, mode, message, outcome })
  return outcome
}

type ObservedRenderer = { readonly composer: { getDraft(): string } }
const observedRenderer = (): ObservedRenderer | undefined =>
  (globalThis as unknown as { __ternPaneHistorySearchRenderer?: ObservedRenderer }).__ternPaneHistorySearchRenderer

let fixture: import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture | undefined
let handled = -1
const handledCommands: string[] = []
let disposed = false

async function runCase(command: string): Promise<Record<string, unknown>> {
  const [name] = command.split(/\s+/u)
  if (fixture === undefined) throw new Error('the Direct fixture is not ready')
  if (name === 'state') {
    return {
      handledCommands,
      draft: observedRenderer()?.composer.getDraft(),
      rendererObserved: observedRenderer() !== undefined,
      wireRecordPath,
      historyFiles,
    }
  }
  if (name === 'exit') {
    setImmediate(resolveExit)
    return { exitRequested: true }
  }
  return { error: `unknown fixture command ${name}` }
}

const periodic = async (): Promise<void> => {
  while (!disposed) {
    await new Promise(resolve => setTimeout(resolve, 40))
    const command = existsSync(commandPath) ? readFileSync(commandPath, 'utf8').trim() : ''
    if (command === '' || (handled >= 0 && command === handledCommands[handled])) continue
    const ordinal = handledCommands.length
    handledCommands.push(command)
    handled = ordinal
    note({ kind: 'case.received', ordinal, command })
    try {
      const result = await runCase(command)
      writeFileSync(commandResultPath, `${JSON.stringify({ ordinal, command, ...result })}\n`)
      note({ kind: 'case.done', ordinal, command, ...result })
    } catch (error) {
      writeFileSync(commandResultPath, `${JSON.stringify({ ordinal, command, error: String(error) })}\n`)
      note({ kind: 'case.failed', ordinal, command, error: String(error) })
    }
  }
}

try {
  fixture = await createDirectTspFixture(life, {
    externalTern: true,
    workRoot,
    composerActions: true,
    historySearch: true,
    startup: { sessionId: SESSION_A },
    persistedBlankSessions: [{ id: SESSION_A }],
    deltas: ['I-E', '-REAL', '-OK'],
    appExit: () => {
      note({ kind: 'app.exit' })
      setImmediate(resolveExit)
    },
  }) as import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture
  let renderer = observedRenderer()
  for (let waited = 0; renderer === undefined && waited < 20_000; waited += 50) {
    await new Promise(resolve => setTimeout(resolve, 50))
    renderer = observedRenderer()
  }
  note({
    kind: 'fixture.ready',
    workRoot,
    historyFiles,
    wireRecordPath,
    seededRows: HISTORY_ROWS,
    sessionA: SESSION_A,
    productionComposition: 'createDirectTspFixture(externalTern=true) -> production mountTspRenderer over shipped SDK connect()',
    inputLoop: 'renderer-owned',
    rendererObserved: renderer !== undefined,
    initialDraft: renderer?.composer.getDraft(),
  })
  console.log('history search pane ready')
  const polling = periodic()
  await exitRequested
  disposed = true
  await polling
  await setupCleanup!()
  note({ kind: 'fixture.settled' })
} finally {
  disposed = true
  await setupCleanup?.()
  promptPrototype.prompt = originalPrompt
}
