/**
 * TSP I-C §7.6 real-Tern GUI-window subject: the PRODUCTION Direct/TSP
 * composition with the first-line slash-completion seat.
 *
 * `createDirectTspFixture({ externalTern: true, ... })` boots the official
 * Direct application composition over the real Tern-owned stdio. The production
 * `mountTspRenderer` therefore runs over the shipped SDK `connect()` inside a
 * pane of a REAL Tern GUI window on a real display; this is NOT a standalone
 * `ui.editor()` demo, a hand-rolled surface, or a second SDK mount. The composer
 * path under test is the same production Direct-shape Quiet Composer the I-B
 * recall subject drives: the same stylesheet install, the same mount order, the
 * same display seam, and history seeded through the same production JSONL store
 * + `resetInputHistory`.
 *
 * DECLARED STAND-INS / FIXTURE EVIDENCE (also written to `events.jsonl`):
 *  - the official Direct fixture's scripted LLM adapter, empty fileReferences
 *    and fixed default model are its own documented boundary stand-ins;
 *  - three newest-first history rows are seeded into the SAME production JSONL
 *    store (`historyFilePath` + v2 rows) and read back through the official
 *    hydration `resetInputHistory` seam, exactly as the I-B subject does. One
 *    extra FORMAL reseed (`case recall-seed`) re-issues the SAME three rows
 *    through the SAME production display seam so the post-submit recall case
 *    starts from a known kernel state; no second history reader is created;
 *  - the catalog the popup offers arrives through the REAL command layer's ONE
 *    commit point (`src/commands.ts` → `installTspCommandCompletions` → the
 *    mount's own `installCommandCompletions`). The subject records that call and
 *    its call sites, so the flow can prove the provenance instead of assuming
 *    it. The `catalog-*` cases re-commit through that SAME mount port with a
 *    copy of the production installation whose `commands` list is reduced or
 *    scripted; the command layer's own provenance filter is NOT re-run (that
 *    half is `test/app/tern-tsp-slash-completion-composition.test.ts`);
 *  - the command-to-fixture channel is a narrow `case` file in `TERN_PANE_DIR`:
 *    `state`, `clear`, `seat-open`, `seat-close`, `recall-seed`, `catalog-reduce`,
 *    `catalog-single`, `catalog-long`, `catalog-restore`, `exit`. These are
 *    subject-local orchestration stand-ins ONLY. Every one of them uses the
 *    PRODUCTION composer/display/presentation/install seams; no production input
 *    handler, editor reducer or completion seat is bypassed or re-implemented;
 *  - the Model/Effort quick menu (the higher composer control in the seat-
 *    priority case) is a SCRIPTED roster opened through the PRODUCTION
 *    `modelPresentation.openQuick` port, the same stand-in the I-B subject
 *    declared. The Permission trigger is clicked for real by the flow and its
 *    interactivity is REPORTED, not assumed;
 *  - the SDK's `TERN_TSP_RECORD` wire recorder is enabled so the flow can read
 *    the exact `ui.editor` `text`/`cursor` props and the exact candidate-row
 *    props (including `data-highlight`) from the SAME production wire, not from
 *    the client's visual rendering;
 *  - input is `CONTROL_INJECTED_INPUT` (`tern ctl key|commit|click`) delivered
 *    to the real GUI window through its control endpoint. The tier is
 *    `REAL_TERN_GUI` + `CONTROL_INJECTED_INPUT`, never `OS_INPUT_VERIFIED`: no
 *    OS physical keyboard, no OS IME and no OS screen-reader bridge is
 *    exercised by this lane.
 *
 * OBSERVATION HOOK: Node's `module.registerHooks` appends a ONE-TO-ONE wrapper
 * to the `src/tui/tsp/session.ts` module source. The wrapper calls the ORIGINAL
 * `mountTspRenderer` and returns the SAME object with read/write recorders
 * installed on its existing `display`, `composer`, `modelPresentation`,
 * `installCommandCompletions` and `bindInput` members, plus one recorder on the
 * production-created SDK `Session.next` that the mount's OWN input loop calls.
 * Every recorder delegates to the original member and returns its outcome
 * unchanged. No production file is edited and no production state is duplicated.
 *
 * The subject's OWN record is `events.jsonl`: the shipped SDK capabilities, the
 * isolated history file, the fixture boot, every key the mount's input loop
 * actually pulled, every handled fixture command, every catalog commit, every
 * composer reducer call, every conditional completion write, every formal
 * display-seam owner call, every real input handler call, and every settled
 * production Direct writer prompt. The flow reads that record back as its
 * positive control; a `ctl key` reply alone never proves that a key arrived.
 *
 * Usage: node --import tsx/esm scripts/tern-gui-slash-completion-subject.mts
 * @module scripts/tern-gui-slash-completion-subject
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

/* TSP I-C §7.6 ONE-TO-ONE subject recorder (appended, production source untouched). */
const __ternSubjectNote = (event) => globalThis.__ternPaneSlashNote?.(event)
const __ternSubjectOriginalMount = mountTspRenderer
mountTspRenderer = function (...args) {
  const renderer = __ternSubjectOriginalMount(...args)
  // Every input the MOUNT's own input loop pulls, recorded as it arrives. The
  // loop is "for await (const input of session)", whose generator calls
  // "this.next()" on every step, so patching the production-created Session's
  // OWN method sees a key BEFORE any seat decides it — including a key the
  // slash seat consumes and never forwards. The UNBOUND original is saved and
  // called with the ORIGINAL receiver (never .bind); the recorder returns the
  // same value. The recorder is installed after the mount returns, so an input
  // already in flight at that instant is not recorded; measured: no flow input
  // is delivered before the mount exists.
  const session = args[0]
  if (session !== undefined && session !== null && typeof session.next === 'function') {
    const originalNext = session.next
    session.next = function (...nextArgs) {
      const settled = originalNext.apply(this, nextArgs)
      return Promise.resolve(settled).then((input) => {
        if (input !== null && input !== undefined) {
          if (input.type === 'key') {
            const key = input.key
            __ternSubjectNote({
              kind: 'key.arrived', name: key.name, text: key.text ?? null,
              ctrl: key.ctrl === true, alt: key.alt === true, shift: key.shift === true, meta: key.meta === true,
            })
            // The subject contract: F10 shuts the subject down.
            if (key.name === 'f10') globalThis.__ternPaneSlashF10?.()
          } else if (input.event !== undefined && input.event.ev !== 'resize') {
            // Every other client event, named as the client sent it (a pointer
            // click on a candidate row is one of these; the lane records which
            // ev the real client actually uses instead of guessing).
            __ternSubjectNote({ kind: 'client.event', ev: input.event.ev, sf: input.event.sf, id: input.event.id, act: input.event.act })
          }
        }
        return input
      })
    }
    globalThis.__ternPaneSlashRestoreSessionNext = () => { session.next = originalNext }
  }
  // TSP I-C: the ONE catalog commit point. This is the mount's own production
  // installer; the command layer calls it and the flow re-commits through it.
  // The call sites are recorded so the PROVENANCE (real command layer vs. this
  // subject's case channel) is a fact in the run, not an assumption.
  const originalInstall = renderer.installCommandCompletions
  renderer.installCommandCompletions = function (installation) {
    const stack = String(new Error().stack ?? '')
    const callSites = stack.split('\\n').slice(1, 8).map(line => line.trim().slice(0, 200))
    const names = (installation.commands ?? []).map(command => command.name)
    // The command layer commits TWICE at boot: an empty catalog first, then the
    // real one. The re-install cases must copy the EFFECTIVE production
    // catalog, so only a commit that did NOT come from this subject's own case
    // channel, and that is non-empty, is kept as the production installation.
    const fromSubjectCase = globalThis.__ternPaneSlashSubjectCommit === true
    if (!fromSubjectCase && names.length > 0) {
      globalThis.__ternPaneSlashProductionInstallation = installation
    }
    globalThis.__ternPaneSlashLastInstallation = installation
    __ternSubjectNote({
      kind: 'catalog.install',
      origin: fromSubjectCase ? 'subject-case' : 'production-commit-point',
      count: names.length,
      names,
      cwd: installation.cwd,
      hostShellCompletion: installation.hostShellCompletion === true,
      skillReferences: (installation.skillReferences ?? []).length,
      hasFileReferences: installation.fileReferences !== undefined && installation.fileReferences !== null,
      hasExtensionSuggest: typeof installation.extensionSuggest === 'function',
      callSites,
    })
    return originalInstall.call(renderer, installation)
  }
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
  const originalApplyKey = composer.applyKey
  const originalApplyCompletionEdit = composer.applyCompletionEdit
  composer.getDraft = function () { return originalGetDraft.call(composer) }
  composer.setDraft = function (text) {
    __ternSubjectNote({ kind: 'composer.setDraft', text, standIn: 'production port observed' })
    return originalSetDraft.call(composer, text)
  }
  // A key the slash seat CONSUMES never reaches this reducer, so the count of
  // reducer calls is the witness that an arrow walked the list instead of
  // editing the draft or entering the I-B browse.
  composer.applyKey = function (key) {
    const edit = originalApplyKey.call(composer, key)
    const state = composer.state()
    __ternSubjectNote({
      kind: 'composer.applyKey', name: key.name, ctrl: key.ctrl === true, alt: key.alt === true,
      shift: key.shift === true, meta: key.meta === true, edit: edit?.kind ?? null,
      text: state.text, cursor: state.cursor,
    })
    return edit
  }
  // TSP I-C: the ONE conditional write a completion is allowed to make.
  composer.applyCompletionEdit = function (expected, next) {
    const accepted = originalApplyCompletionEdit.call(composer, expected, next)
    __ternSubjectNote({ kind: 'composer.applyCompletionEdit', expected, next, accepted })
    return accepted
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
      openSessionBrowser: () => { __ternSubjectNote({ kind: 'handler.openSessionBrowser' }); return handlers.openSessionBrowser() },
      exit: () => { __ternSubjectNote({ kind: 'handler.exit' }); return handlers.exit() },
    }
    // The OPTIONAL seams are wrapped only when the production composition
    // actually supplied them: adding a member the mount did not have would
    // change what production does (an absent "permissionOptions" is itself a
    // fact the Quiet Composer reads).
    if (typeof handlers.permissionOptions === 'function') {
      recording.permissionOptions = () => {
        const roster = handlers.permissionOptions()
        __ternSubjectNote({ kind: 'handler.permissionOptions', roster: [...roster] })
        return roster
      }
    }
    if (typeof handlers.selectPermission === 'function') {
      recording.selectPermission = id => {
        __ternSubjectNote({ kind: 'handler.selectPermission', id })
        return handlers.selectPermission(id)
      }
    }
    __ternSubjectNote({ kind: 'renderer.bindInput', standIn: 'one-to-one recorder around production handlers' })
    return originalBindInput.call(renderer, recording)
  }
  globalThis.__ternPaneSlashRenderer = renderer
  __ternSubjectNote({ kind: 'renderer.observed', initialDraft: renderer.composer.getDraft() })
  return renderer
}
`
    return { ...result, source: source + hook }
  },
})
;(globalThis as unknown as { __ternPaneSlashNote: typeof note }).__ternPaneSlashNote = note

const commandPath = join(paneRoot, 'case')
const commandResultPath = join(paneRoot, 'case-result')
const SESSION_A = 'session-slash-a'
const SESSION_B = 'session-slash-b'
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
// The subject contract: F10 (seen by the mount's own input loop recorder)
// shuts the subject down.
;(globalThis as unknown as { __ternPaneSlashF10?: () => void }).__ternPaneSlashF10 = () => setImmediate(resolveExit)
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

const capabilitySession = await connect({ app: 'tern-gui-slash-completion', timeout: 2000 })
if (capabilitySession === null) throw new Error('this subject must run inside a real Tern GUI window pane')
const caps = capabilitySession.caps
await capabilitySession.close()
note({
  kind: 'subject.ready',
  standIns: [
    'official Direct fixture: scripted LLM, empty fileReferences, fixed default model',
    'three fixture history rows in the production JSONL store under an isolated DSH_HOME',
    'case-file orchestration for state/clear/seat/recall-seed/catalog/exit',
    'catalog re-commits go through the mount port with a copy of the PRODUCTION installation (commands only replaced)',
    'scripted model roster through the production modelPresentation.openQuick port',
    'OS physical input / OS screen reader: NOT_VERIFIED; control-injected REAL GUI window input is exercised (REAL_TERN_GUI + CONTROL_INJECTED_INPUT)',
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
type CatalogCommand = { readonly name: string; readonly description?: string }
type CatalogInstallation = {
  readonly commands: readonly CatalogCommand[]
  readonly cwd: string
  readonly [key: string]: unknown
}
type ObservedRenderer = {
  readonly display: {
    resetInputHistory(entries: readonly string[], owner?: string): void
    beginInputHistoryScope(owner: string): void
  }
  readonly composer: {
    getDraft(): string
    setDraft(text: string): void
    state(): { text: string; cursor: number; focused: boolean }
  }
  readonly modelPresentation?: {
    openQuick?: (request: unknown) => {
      setLoading(): void
      setDirectory(value: unknown): void
      close(): void
    }
  }
  installCommandCompletions?(installation: CatalogInstallation): void
  scopeFactCountForTest?(): number
  reconcileStepsForTest?(): number
}
const globals = globalThis as unknown as {
  __ternPaneSlashRenderer?: ObservedRenderer
  __ternPaneSlashProductionInstallation?: CatalogInstallation
  __ternPaneSlashLastInstallation?: CatalogInstallation
  __ternPaneSlashSubjectCommit?: boolean
  __ternPaneSlashRestoreSessionNext?: () => void
}
const observedRenderer = (): ObservedRenderer | undefined => globals.__ternPaneSlashRenderer
let quickHandle: ReturnType<NonNullable<NonNullable<ObservedRenderer['modelPresentation']>['openQuick']>> | undefined

let fixture: import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture | undefined
let handled = -1
const handledCommands: string[] = []
let disposed = false
/** Every catalog this subject committed itself (never the production install). */
const subjectCatalogCommits: string[] = []

function reInstall(kind: string, commands: readonly CatalogCommand[]): Record<string, unknown> {
  const renderer = observedRenderer()
  const production = globals.__ternPaneSlashProductionInstallation
  if (renderer?.installCommandCompletions === undefined || production === undefined) {
    return { available: false, reason: 'the production catalog install was never observed' }
  }
  // The SAME installation object the command layer committed, with ONLY the
  // `commands` list replaced: every other input (cwd, scope, localCwd,
  // skillReferences, fileReferences, extensionSuggest, hostShellCompletion)
  // keeps the production composition.
  // The commit is marked so the recorder never mistakes it for the production
  // command-layer commit (which is the catalog the re-install cases copy from).
  globals.__ternPaneSlashSubjectCommit = true
  try {
    renderer.installCommandCompletions({ ...production, commands })
  } finally {
    globals.__ternPaneSlashSubjectCommit = false
  }
  subjectCatalogCommits.push(kind)
  return {
    committed: true,
    commit: kind,
    names: commands.map(command => command.name),
    standIn: 'mount installCommandCompletions port; the command-layer provenance filter was not re-run',
  }
}

async function runCase(command: string, ordinal: number): Promise<Record<string, unknown>> {
  const [name, ...args] = command.split(/\s+/u)
  if (fixture === undefined) throw new Error('the Direct fixture is not ready')
  const renderer = observedRenderer()
  const records = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const countOf = (kind: string) => records.filter(entry => entry.kind === kind).length
  const draft = renderer?.composer.getDraft()
  const composerState = renderer?.composer.state()
  if (name === 'state') {
    return {
      rows: historyFiles.flatMap(entry => loadHistoryRecords(entry.file).map(row => ({
        file: entry.file,
        content: row.content,
        sessionId: row.sessionId,
        version: row.version,
      }))),
      handledCommands,
      subjectCatalogCommits,
      sessionA: SESSION_A,
      sessionB: SESSION_B,
      expectedRecall: EXPECTED_RECALL,
      draft,
      composer: composerState,
      seatState: {
        keyArrived: countOf('key.arrived'),
        applyKey: countOf('composer.applyKey'),
        applyCompletionEdit: countOf('composer.applyCompletionEdit'),
        catalogInstall: countOf('catalog.install'),
        handlerSubmit: countOf('handler.submit'),
        handlerCancel: countOf('handler.cancel'),
        writerPrompt: countOf('writer.prompt'),
      },
      lastInstallationNames: globals.__ternPaneSlashLastInstallation?.commands?.map(entry => entry.name) ?? null,
      productionInstallationNames: globals.__ternPaneSlashProductionInstallation?.commands?.map(entry => entry.name) ?? null,
      scopeFacts: renderer?.scopeFactCountForTest?.(),
      reconcileSteps: renderer?.reconcileStepsForTest?.(),
      rendererObserved: renderer !== undefined,
      wireRecordPath,
    }
  }
  if (name === 'clear') {
    if (renderer === undefined) return { available: false, reason: 'production renderer not observed' }
    renderer.composer.setDraft('')
    return { cleared: true, draft: renderer.composer.getDraft(), standIn: 'production composer.setDraft port' }
  }
  if (name === 'recall-seed') {
    if (renderer === undefined) return { available: false, reason: 'production renderer not observed' }
    // The SAME production display seam the Session A hydration uses, re-issued
    // with the SAME three seeded rows, so a later ↑ browse is deterministic.
    renderer.display.resetInputHistory(EXPECTED_RECALL, SESSION_A)
    return { seeded: true, entries: EXPECTED_RECALL, owner: SESSION_A, formalOwner: 'resetInputHistory' }
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
  if (name === 'catalog-reduce') {
    const production = globals.__ternPaneSlashProductionInstallation
    if (production === undefined) return { available: false, reason: 'the production catalog install was never observed' }
    const withdrawn = production.commands[0]?.name
    const kept = production.commands.slice(1)
    const result = reInstall('catalog-reduce', kept)
    return { ...result, withdrawn, kept: kept.length }
  }
  if (name === 'catalog-single') {
    const scripted: readonly CatalogCommand[] = [{ name: 'evidence-probe', description: 'Scripted I-C evidence row' }]
    return reInstall('catalog-single', scripted)
  }
  if (name === 'catalog-long') {
    const longName = 'evidence-very-long-command-name-for-wrap-probe'
    const scripted: readonly CatalogCommand[] = [{
      name: longName,
      description: `Scripted long description ${'alpha '.repeat(40)}`,
    }]
    const result = reInstall('catalog-long', scripted)
    return { ...result, longName }
  }
  if (name === 'catalog-restore') {
    const production = globals.__ternPaneSlashProductionInstallation
    if (production === undefined) return { available: false, reason: 'the production catalog install was never observed' }
    return reInstall('catalog-restore', production.commands)
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
    deltas: ['I-C', '-DIRECT', '-OK'],
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
    completionCatalog: 'the real command layer installs through the mount installCommandCompletions port',
    inputLoop: 'renderer-owned',
    rendererObserved: renderer !== undefined,
    initialDraft: renderer?.composer.getDraft(),
  })
  note({
    kind: 'renderer.ready',
    rendererObserved: renderer !== undefined,
    initialDraft: renderer?.composer.getDraft(),
    recallSeedPolicy: 'the flow accepts either the sessionless activateBootRecall seed or the Session A hydration reseed; both use the same pre-existing cwd JSONL rows',
    seat: 'the slash-completion seat is mount-local and is driven only by real keys and the production catalog install',
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
  globals.__ternPaneSlashRestoreSessionNext?.()
}
