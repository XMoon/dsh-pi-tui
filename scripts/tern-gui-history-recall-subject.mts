/**
 * TSP I-B §7.5 real-Tern subject: the PRODUCTION Direct/TSP composition.
 *
 * `createDirectTspFixture({ externalTern: true, ... })` boots the official
 * Direct application composition over the real Tern-owned stdio. The production
 * `mountTspRenderer` therefore runs over the shipped SDK `connect()` inside a
 * REAL Tern GUI window pane on a real display; this is NOT a standalone `ui.editor()` demo,
 * a hand-rolled surface, or a second SDK mount.
 *
 * DECLARED STAND-INS / FIXTURE EVIDENCE (also written to `events.jsonl`):
 *  - the official Direct fixture's scripted LLM adapter, empty fileReferences
 *    and fixed default model are its own documented boundary stand-ins;
 *  - three newest-first history rows are seeded into the SAME production JSONL
 *    store (`historyFilePath` + v2 rows). The official Session A hydration
 *    `resetInputHistory` seam reads them through production code; they are
 *    fixture rows, not a user's persisted history;
 *  - the command-to-fixture channel is a narrow `case` file in TERN_PANE_DIR:
 *    `state`, `clear`, `seat-open`, `seat-close`, `switch`, `exit`. These are
 *    subject-local orchestration stand-ins ONLY. `clear`, `switch`, and the
 *    picker open/close use the PRODUCTION composer/display/presentation seams;
 *    no production input handler or editor reducer is bypassed. The flow also
 *    drives the real `/sessions` and `/exit` commands and the real trigger;
 *  - the Model/Effort picker's directory is a SCRIPTED stand-in, opened through
 *    the PRODUCTION `modelPresentation.openQuick` port. The registered `/model`
 *    command owner is qualified by the automated Direct suite;
 *  - the SDK's `TERN_TSP_RECORD` wire recorder is enabled so the flow can read
 *    the exact `ui.editor` `text`/`cursor` props from the SAME production wire,
 *    not from the client's visual hard-newline rendering;
 *  - the owner-approved `history.activateBootRecall()` amendment is present;
 *    the flow accepts either the sessionless boot seed or the Session A
 *    hydration reseed from the same pre-existing cwd JSONL rows, with no
 *    second history reader;
 *  - input is `GUI_CONTROL` (`tern ctl key|commit|click`); OS physical input,
 *    IME and the OS screen-reader bridge are NOT_VERIFIED.
 *
 * OBSERVATION HOOK: Node's `module.registerHooks` appends a ONE-TO-ONE wrapper
 * to the `src/tui/tsp/session.ts` module source. The wrapper calls the ORIGINAL
 * `mountTspRenderer` and returns the SAME object with read/write recorders
 * installed on its existing `display`, `composer`, `modelPresentation` and
 * `bindInput` members. Every recorder delegates to the original member. No
 * production file is edited, and no production state is duplicated.
 *
 * The subject's OWN record is `events.jsonl`: the shipped SDK capabilities,
 * the isolated history file, the fixture boot, every handled fixture command,
 * every formal display-seam owner call, every real input handler call, every
 * composed editor text, and every settled production Direct writer prompt.
 * The flow reads that record back as its positive control; a `ctl key` reply
 * alone never proves that a key arrived.
 *
 * Usage: node --import tsx/esm scripts/tern-gui-history-recall-subject.mts
 * @module scripts/tern-gui-history-recall-subject
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerHooks } from 'node:module'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern subject')
const workRoot = join(paneRoot, 'dsh-home')
const wireRecordPath = join(paneRoot, 'sdk-wire.jsonl')
mkdirSync(workRoot, { recursive: true })
// Set isolation BEFORE dynamically importing the DSH Host composition.
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wireRecordPath

const eventsPath = join(paneRoot, 'events.jsonl')
const note = (event: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}

/** The runtime-module observation hook. Production source stays untouched. */
const observedRendererUrl = new URL('../src/tui/tsp/session.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== observedRendererUrl) return result
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source ?? '')
    const hook = `

/* TSP I-B §7.5 ONE-TO-ONE subject recorder (appended, production source untouched). */
const __ternSubjectNote = (event) => globalThis.__ternPaneHistoryRecallNote?.(event)
const __ternSubjectOriginalMount = mountTspRenderer
mountTspRenderer = function (...args) {
  const renderer = __ternSubjectOriginalMount(...args)
  const display = renderer.display
  const originalReset = display.resetInputHistory
  const originalBegin = display.beginInputHistoryScope
  const originalSettle = display.settleScopeInput
  display.resetInputHistory = function (entries, owner) {
    __ternSubjectNote({ kind: 'seam.resetInputHistory', entries: [...entries], owner, newestFirst: true })
    return originalReset.call(display, entries, owner)
  }
  display.beginInputHistoryScope = function (owner) {
    __ternSubjectNote({ kind: 'seam.beginInputHistoryScope', owner })
    return originalBegin.call(display, owner)
  }
  display.settleScopeInput = function (settlement) {
    __ternSubjectNote({ kind: 'seam.settleScopeInput', settlement })
    return originalSettle.call(display, settlement)
  }
  const composer = renderer.composer
  const originalGetDraft = composer.getDraft
  const originalSetDraft = composer.setDraft
  composer.getDraft = function () { return originalGetDraft.call(composer) }
  composer.setDraft = function (text) {
    __ternSubjectNote({ kind: 'composer.setDraft', text, standIn: 'production port observed' })
    return originalSetDraft.call(composer, text)
  }
  const originalBindInput = renderer.bindInput
  renderer.bindInput = function (handlers) {
    const recording = {
      ...handlers,
      submit: (text, request, scopeToken) => {
        __ternSubjectNote({ kind: 'handler.submit', text, request: String(request), scopeToken })
        return handlers.submit(text, request, scopeToken)
      },
      steer: text => { __ternSubjectNote({ kind: 'handler.steer', text }); return handlers.steer(text) },
      cancel: () => { __ternSubjectNote({ kind: 'handler.cancel' }); return handlers.cancel() },
      pasteMedia: () => { __ternSubjectNote({ kind: 'handler.pasteMedia' }); return handlers.pasteMedia() },
      pastedPath: receipt => {
        __ternSubjectNote({ kind: 'handler.pastedPath', text: String(receipt.text ?? '') })
        return handlers.pastedPath(receipt)
      },
      admitPastedPathDelivery: text => {
        const admitted = handlers.admitPastedPathDelivery(text)
        __ternSubjectNote({ kind: 'handler.admitPastedPathDelivery', text, admitted })
        return admitted
      },
      shouldRememberInput: text => {
        const remembered = handlers.shouldRememberInput(text)
        __ternSubjectNote({ kind: 'handler.shouldRememberInput', text, remembered })
        return remembered
      },
      noteUserInput: () => {
        __ternSubjectNote({ kind: 'handler.noteUserInput', draft: renderer.composer.getDraft() })
        return handlers.noteUserInput()
      },
      openModelPicker: entry => { __ternSubjectNote({ kind: 'handler.openModelPicker', entry }); return handlers.openModelPicker(entry) },
      openModelQuick: () => { __ternSubjectNote({ kind: 'handler.openModelQuick' }); return handlers.openModelQuick() },
      selectPermission: id => { __ternSubjectNote({ kind: 'handler.selectPermission', id }); return handlers.selectPermission?.(id) },
      openSessionBrowser: () => { __ternSubjectNote({ kind: 'handler.openSessionBrowser' }); return handlers.openSessionBrowser() },
      exit: () => { __ternSubjectNote({ kind: 'handler.exit' }); return handlers.exit() },
    }
    __ternSubjectNote({ kind: 'renderer.bindInput', standIn: 'one-to-one recorder around production handlers' })
    return originalBindInput.call(renderer, recording)
  }
  globalThis.__ternPaneHistoryRecallRenderer = renderer
  __ternSubjectNote({ kind: 'renderer.observed', initialDraft: renderer.composer.getDraft() })
  return renderer
}
`
    return { ...result, source: source + hook }
  },
})
;(globalThis as unknown as { __ternPaneHistoryRecallNote: typeof note }).__ternPaneHistoryRecallNote = note

const commandPath = join(paneRoot, 'case')
const commandResultPath = join(paneRoot, 'case-result')
const SESSION_A = 'session-recall-a'
const SESSION_B = 'session-recall-b'
const HISTORY_ROWS = [
  { content: 'oldest recall row', sessionId: SESSION_A },
  { content: 'middle recall row', sessionId: SESSION_A },
  { content: 'newest recall row', sessionId: SESSION_A },
]
/** Newest-first: exactly the production hydration projection of the JSONL. */
const EXPECTED_RECALL = [...HISTORY_ROWS].reverse().map(row => row.content)

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
const { historyFilePath, loadHistoryRecords } = await import('../src/client/history/store.ts')
const { connect } = await import('@stencil-hq/tern')
const { DirectSessionWriter } = await import('../src/runtime/direct/session-writer-direct.ts')

/**
 * Seed BOTH cwd identities the official composition may read: the Client launch
 * cwd (`process.cwd()`) and the Session header cwd (`workRoot`). Both files are
 * the PRODUCTION store's own `historyFilePath`.
 */
const historyFiles = [process.cwd(), workRoot].map(cwd => {
  const file = historyFilePath(workRoot, cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, HISTORY_ROWS.map((row, index) => JSON.stringify({
    v: 2,
    content: row.content,
    cwd,
    ts: 1_700_000_000_000 + index,
    sessionId: row.sessionId,
  })).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  return { cwd, file, rows: loadHistoryRecords(file).map(row => row.content) }
})

const capabilitySession = await connect({ app: 'tern-pane-history-recall-ux', timeout: 2000 })
if (capabilitySession === null) throw new Error('this subject must run inside a real Tern pane')
const caps = capabilitySession.caps
await capabilitySession.close()
note({
  kind: 'subject.ready',
  standIns: [
    'official Direct fixture: scripted LLM, empty fileReferences, fixed default model',
    'three fixture history rows in the production JSONL store under an isolated DSH_HOME',
    'case-file orchestration for state/clear/seat/switch/exit',
    'scripted model roster through the production modelPresentation.openQuick port',
    'OS physical input / OS screen reader: NOT_VERIFIED; control-injected GUI window input is exercised',
  ],
  caps,
  workRoot,
  clientCwd: process.cwd(),
  historyFiles,
  wireRecordPath,
  seededRows: HISTORY_ROWS,
  expectedRecall: EXPECTED_RECALL,
  sessionA: SESSION_A,
  sessionB: SESSION_B,
})

/**
 * ONE-TO-ONE recorder of the PRODUCTION Direct writer: save the UNBOUND
 * prototype original, call it with the ORIGINAL receiver, record only AFTER it
 * settles, and return the original outcome unchanged.
 */
const promptPrototype = DirectSessionWriter.prototype as unknown as {
  prompt(this: typeof DirectSessionWriter.prototype, sessionId: string, message: unknown, mode: 'queue' | 'steer'): Promise<unknown>
}
const originalPrompt = promptPrototype.prompt
promptPrototype.prompt = async function (this: typeof DirectSessionWriter.prototype, sessionId, message, mode) {
  const outcome = await originalPrompt.call(this, sessionId, message, mode)
  note({ kind: 'writer.prompt', sessionId, mode, message, outcome })
  return outcome
}

/** The PRODUCTION renderer object observed by the module hook. */
type ObservedRenderer = {
  readonly display: {
    resetInputHistory(entries: readonly string[], owner?: string): void
    beginInputHistoryScope(owner: string): void
  }
  readonly composer: { getDraft(): string; setDraft(text: string): void }
  readonly modelPresentation?: {
    openQuick?: (request: unknown) => {
      setLoading(): void
      setDirectory(value: unknown): void
      close(): void
    }
  }
  scopeFactCountForTest?(): number
  reconcileStepsForTest?(): number
}
const observedRenderer = (): ObservedRenderer | undefined =>
  (globalThis as unknown as { __ternPaneHistoryRecallRenderer?: ObservedRenderer }).__ternPaneHistoryRecallRenderer
let quickHandle: ReturnType<NonNullable<NonNullable<ObservedRenderer['modelPresentation']>['openQuick']>> | undefined

let fixture: import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture | undefined
let handled = -1
const handledCommands: string[] = []
let disposed = false

async function runCase(command: string, ordinal: number): Promise<Record<string, unknown>> {
  const [name, ...args] = command.split(/\s+/u)
  if (fixture === undefined) throw new Error('the Direct fixture is not ready')
  const renderer = observedRenderer()
  if (name === 'state') {
    return {
      rows: historyFiles.flatMap(entry => loadHistoryRecords(entry.file).map(row => ({
        file: entry.file,
        content: row.content,
        sessionId: row.sessionId,
        version: row.version,
      }))),
      handledCommands,
      sessionA: SESSION_A,
      sessionB: SESSION_B,
      expectedRecall: EXPECTED_RECALL,
      draft: renderer?.composer.getDraft(),
      scopeFacts: renderer?.scopeFactCountForTest?.(),
      reconcileSteps: renderer?.reconcileStepsForTest?.(),
      rendererObserved: renderer !== undefined,
      wireRecordPath,
    }
  }
  if (name === 'clear') {
    if (renderer === undefined) return { available: false, reason: 'production renderer not observed' }
    renderer.composer.setDraft('')
    return { cleared: true, standIn: 'production composer.setDraft port' }
  }
  if (name === 'seat-open') {
    if (renderer?.modelPresentation?.openQuick === undefined) return { available: false, reason: 'production openQuick port absent' }
    const request = {
      subject: { sessionless: false },
      entry: 'models',
      isCurrent: () => true,
      retry: () => { note({ kind: 'quick.retry', ordinal }) },
      apply: (selection: unknown) => {
        note({ kind: 'quick.apply', ordinal, selection, standIn: 'scripted /model write result' })
        return Promise.resolve('rejected' as never)
      },
      runOwned: (label: string, task: () => unknown, options: { onResult?: (value: unknown) => void; onError?: (error: unknown) => void }) => {
        note({ kind: 'quick.runOwned', ordinal, label, standIn: 'scripted quick directory read' })
        void Promise.resolve().then(task).then(options.onResult, options.onError)
      },
    }
    quickHandle = renderer.modelPresentation.openQuick(request)
    quickHandle.setLoading()
    await new Promise(resolve => setTimeout(resolve, 120))
    quickHandle.setDirectory({
      directory: {
        default: { provider: 'scripted', model: 'scripted-model' },
        routableProviders: ['scripted'],
        groups: [{ id: 'scripted', name: 'Scripted provider', models: [{ id: 'scripted-model', name: 'Scripted Model' }] }],
        failures: [],
      },
      current: { provider: 'scripted', model: 'scripted-model' },
    })
    return { available: true, opened: true, standIn: 'scripted quick directory through production openQuick port' }
  }
  if (name === 'seat-close') {
    quickHandle?.close()
    quickHandle = undefined
    return { closed: true }
  }
  if (name === 'switch') {
    if (renderer === undefined) return { available: false, reason: 'production renderer not observed' }
    renderer.display.beginInputHistoryScope(SESSION_B)
    renderer.display.resetInputHistory([], SESSION_B)
    return { fenced: true, to: SESSION_B, formalOwners: ['beginInputHistoryScope', 'resetInputHistory'] }
  }
  if (name === 'exit') {
    setImmediate(resolveExit)
    return { exitRequested: true }
  }
  return { error: `unknown fixture command ${name}`, args }
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
      const result = await runCase(command, ordinal)
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
    startup: { sessionId: SESSION_A },
    persistedBlankSessions: [{ id: SESSION_A }, { id: SESSION_B }],
    sessionBrowser: true,
    modelPicker: true,
    modelQuick: true,
    deltas: ['I-B', '-DIRECT', '-OK'],
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
    expectedRecall: EXPECTED_RECALL,
    sessionA: SESSION_A,
    sessionB: SESSION_B,
    productionComposition: 'createDirectTspFixture(externalTern=true) -> production mountTspRenderer over shipped SDK connect()',
    inputLoop: 'renderer-owned',
    rendererObserved: renderer !== undefined,
    initialDraft: renderer?.composer.getDraft(),
  })
  note({
    kind: 'renderer.ready',
    rendererObserved: renderer !== undefined,
    initialDraft: renderer?.composer.getDraft(),
    bootSeedPolicy: 'the flow accepts either the new sessionless activateBootRecall seed or the Session A hydration reseed; both use the same pre-existing cwd JSONL rows',
    sourceDeltaStatus: 'pending rerun after source freeze',
  })
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
