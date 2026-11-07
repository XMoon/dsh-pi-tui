/**
 * TSP production Transcript Presenter Qualification SUBJECT.
 *
 * Boots the PRODUCTION Direct application (`createDirectTspFixture({ externalTern:
 * true })`) inside a real `tern serve --control` pane, so the ONE real
 * `SurfaceRuntime.repaintTarget() -> display.setTranscript -> mountTspRenderer ->
 * SDK Surface.render(main)` chain is the only transcript chain in the run. NO
 * standalone raw-wire demo, NO second SDK Surface, NO second Folder or
 * WindowController and NO hand-rolled Presenter is created here.
 *
 * This file owns exactly three things:
 *  1. a READ-ONE-TO-ONE observation of the production commit
 *     (`renderer.display.setTranscript`) and of the real SDK `error` event,
 *     installed by `module.registerHooks` the same way
 *     `tern-pane-history-search-ux-subject.mts` does it: the original function
 *     is called once with the original arguments in the original order, its
 *     result is returned unchanged and its errors are never caught;
 *  2. the isolated deterministic test INPUT (`PROMPTS`, written once to
 *     `prompts.json`, which the flow reads as its only prompt source);
 *  3. a TEST-ONLY command channel (`case.json` / `case-result.json`) whose five
 *     commands only arm/release the fixture's existing `streamHold`, re-project
 *     the ALREADY COMMITTED real message objects through the SAME mounted
 *     Presenter, and call `reveal` on the ALREADY OPENED production Surface.
 *
 * EVIDENCE LEVELS THIS SUBJECT CANNOT PROVE (declared, never claimed):
 *  - input is CONTROL_INJECTED (`tern ctl type|key`): no physical keyboard,
 *    IME, wheel or OS clipboard is observed here (GUI / G8: NOT_VERIFIED);
 *  - the `project-*` commands are a test harness input, NOT the application's
 *    user "Older/Newer/Latest" entry, which does not exist on TSP yet
 *    (`PRODUCT_USER_PAGING = NOT_IMPLEMENTED`);
 *  - whether a frame was really painted is decided by the SDK wire and the
 *    client tree in the FLOW, never by the `setTranscript` record itself.
 *
 * Usage: started by `scripts/tern-pane-drive.mjs` through the generated
 * `launch.sh` (`node --import tsx/esm <this file>` with `TERN_PANE_DIR` set).
 * @module scripts/tern-pane-transcript-production-qualification-subject
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern production Transcript subject')
const workRoot = join(paneRoot, 'dsh-home')
const wireRecordPath = join(paneRoot, 'sdk-wire.jsonl')
const eventsPath = join(paneRoot, 'events.jsonl')
const promptsPath = join(paneRoot, 'prompts.json')
const casePath = join(paneRoot, 'case.json')
const caseResultPath = join(paneRoot, 'case-result.json')

// The DSH home and the SDK wire recorder are process-level facts that must exist
// BEFORE the Host composition is imported (both are read at connect time).
mkdirSync(workRoot, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wireRecordPath

const note = (event: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}

// ── Fixed, isolated, deterministic test input (the ONLY prompt definition) ──
const SESSION_A = 'transcript-source-A'
const SESSION_B = 'transcript-source-B'
const A_MARKER_COUNT = 9
const A_PROMPTS: readonly string[] = Array.from({ length: A_MARKER_COUNT }, (_unused, index) => {
  const marker = `TRANSCRIPT-A-${String(index + 1).padStart(2, '0')}`
  // Plain ASCII prose of a stable length so one prompt wraps onto several rows
  // in the real client; no control characters and no shell command.
  const body = 'Please answer with a short plain note about how the reading position must stay '
    + `stable while another reply streams into this same transcript region, marker ${marker}.`
  return `${marker} ${body}`
})
const B_PROMPTS: readonly string[] = [
  'TRANSCRIPT-B-01 Now this second Session is the current one; answer with a short plain note '
    + 'that belongs to the incoming Session only and keeps the same reading vocabulary.',
]

writeFileSync(promptsPath, `${JSON.stringify({
  sessions: { a: SESSION_A, b: SESSION_B },
  assistantMarker: 'TRANSCRIPT-DIRECT-ANSWER-SETTLED',
  prompts: [
    ...A_PROMPTS.map((text, index) => ({ session: SESSION_A, ordinal: index + 1, marker: text.split(' ')[0], text })),
    ...B_PROMPTS.map((text, index) => ({ session: SESSION_B, ordinal: index + 1, marker: text.split(' ')[0], text })),
  ],
}, null, 1)}\n`)

// ── ONE-TO-ONE recorder around the production mount (append-only, no rewrite) ──
const observedRendererUrl = new URL('../src/tui/tsp/session.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== observedRendererUrl) return result
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source ?? '')
    const hook = `

/* Production Transcript qualification ONE-TO-ONE subject recorder (appended;
   the production source above is byte-for-byte unchanged). */
const __tqNote = (event) => globalThis.__transcriptQualificationNote?.(event)
const __tqOriginalMount = mountTspRenderer
mountTspRenderer = function (...args) {
  const sdkSession = args[0]
  // The SDK event stream is wrapped BEFORE the mount starts its own async
  // iteration loop: one reader, delegated one-to-one, no second consumer and no
  // changed value. Only the client's own fields are recorded.
  const originalIterator = sdkSession[Symbol.asyncIterator]
  sdkSession[Symbol.asyncIterator] = function () {
    const inner = originalIterator.call(sdkSession)
    return {
      async next() {
        const step = await inner.next()
        if (!step.done && step.value && step.value.type === 'event' && step.value.event && step.value.event.ev === 'error') {
          const event = step.value.event
          const fields = { kind: 'sdk.error', msg: event.msg }
          if (event.sf !== undefined) fields.sf = event.sf
          if (event.s !== undefined) fields.s = event.s
          if (event.op !== undefined) fields.op = event.op
          if (event.id !== undefined) fields.id = event.id
          __tqNote(fields)
        }
        return step
      },
      return(value) { return inner.return ? inner.return(value) : { done: true, value } },
      throw(error) { return inner.throw ? inner.throw(error) : Promise.reject(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }
  // The production mount opens the ONE inline Surface; the probe only captures
  // that already-opened object, it never opens another one.
  const originalOpen = sdkSession.open
  sdkSession.open = function (...openArgs) {
    const opened = originalOpen.apply(this, openArgs)
    if (openArgs[0] && openArgs[0].mode === 'inline') {
      globalThis.__transcriptQualificationSurface = opened
      __tqNote({ kind: 'surface.inline.opened', id: opened.id })
    }
    return opened
  }
  __tqNote({ kind: 'sdk.caps', caps: sdkSession.caps })
  const renderer = __tqOriginalMount.apply(this, args)
  const display = renderer.display
  const originalCommit = display.setTranscript
  display.setTranscript = function (...commitArgs) {
    const result = originalCommit.apply(this, commitArgs)
    globalThis.__transcriptQualificationObserveCommit?.(commitArgs)
    return result
  }
  globalThis.__transcriptQualificationRenderer = renderer
  __tqNote({ kind: 'renderer.observed' })
  return renderer
}
`
    return { ...result, source: source + hook }
  },
})

type GlobalProbe = {
  __transcriptQualificationNote?: (event: Record<string, unknown>) => void
  __transcriptQualificationObserveCommit?: (args: readonly unknown[]) => void
  __transcriptQualificationRenderer?: TspRendererProbe
  __transcriptQualificationSurface?: SurfaceProbe
}
type TspRendererProbe = {
  display: { setTranscript: (...args: unknown[]) => void }
  composer: { getDraft(): string }
}
type SurfaceProbe = { id: string; reveal(id: string, at?: string): void }
;(globalThis as unknown as GlobalProbe).__transcriptQualificationNote = note

// ── The read-only commit record ──
interface CommitShape {
  readonly messages: readonly { kind: string; turn?: number; text?: string }[]
  readonly rest: readonly unknown[]
}
const sourceSeqByToken = new WeakMap<object, number>()
let nextSourceSeq = 0
let probing = false
let lastProductionCommit: { messages: readonly unknown[]; rest: unknown[] } | undefined

const firstToken = (text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined
  const token = text.split(' ')[0]
  return typeof token === 'string' && token.startsWith('TRANSCRIPT-') ? token : undefined
}

/** The deterministic marker of one prepared Host message, WITHOUT its body. */
const messageMarker = (message: unknown): string | undefined => {
  const content = (message as { readonly content?: unknown }).content
  const blocks = Array.isArray(content) ? content : [content]
  for (const block of blocks) {
    const marker = firstToken((block as { readonly text?: unknown } | undefined)?.text)
    if (marker !== undefined) return marker
  }
  return undefined
}

const shape = (args: readonly unknown[]): CommitShape => ({
  messages: (Array.isArray(args[0]) ? args[0] : []) as CommitShape['messages'],
  rest: args.slice(1),
})

const observeCommit = (args: readonly unknown[]): void => {
  const { messages, rest } = shape(args)
  const window = rest[1] as { mode?: string; firstTurn?: number; lastTurn?: number; hasNewer?: boolean } | undefined
  const source = rest[4] as object | undefined
  let sourceSeq: number | undefined
  if (source !== undefined) {
    const known = sourceSeqByToken.get(source)
    if (known === undefined) {
      nextSourceSeq += 1
      sourceSeqByToken.set(source, nextSourceSeq)
      sourceSeq = nextSourceSeq
      note({ kind: 'scope.changed', sourceSeq, origin: probing ? 'subject-probe' : 'production' })
    } else {
      sourceSeq = known
    }
  }
  const head = messages[0]
  const tail = messages[messages.length - 1]
  const markers = messages.map(message => firstToken(message.text)).filter((marker): marker is string => marker !== undefined)
  note({
    kind: 'display.setTranscript',
    origin: probing ? 'subject-probe' : 'production',
    sourceSeq,
    messageCount: messages.length,
    lastTurn: window?.lastTurn,
    firstTurn: window?.firstTurn,
    hasNewer: window?.hasNewer,
    mode: window?.mode,
    headKind: head?.kind,
    headTurn: head?.turn,
    tailKind: tail?.kind,
    tailTurn: tail?.turn,
    markers,
  })
  if (!probing) lastProductionCommit = { messages: messages as readonly unknown[], rest: rest as unknown[] }
}
;(globalThis as unknown as GlobalProbe).__transcriptQualificationObserveCommit = observeCommit

// ── The scripted model hold: the fixture's OWN `streamHold` parameter ──
let holdingArmed = false
let heldResolve: (() => void) | undefined
let heldPromise: Promise<void> | undefined
const streamHold = (): Promise<void> => {
  if (!holdingArmed) return Promise.resolve()
  heldPromise ??= new Promise<void>(resolve => { heldResolve = resolve })
  return heldPromise
}
const releaseHeldStream = (): void => {
  const resolve = heldResolve
  heldResolve = undefined
  heldPromise = undefined
  holdingArmed = false
  resolve?.()
}

// ── Lifecycle ──
process.once('exit', code => note({ kind: 'process.exit', code }))
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => { resolveExit = resolve })
process.once('SIGTERM', () => setImmediate(resolveExit))
process.once('SIGINT', () => setImmediate(resolveExit))
let setupCleanup: (() => unknown) | undefined
let restoreAgentsResume: (() => void) | undefined
const life: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir: prefix => { throw new Error(`the external Tern subject requires an explicit workRoot, got ${prefix}`) },
  defer: cleanup => { setupCleanup = cleanup },
}

const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')
type Fixture = import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture
let fixture: Fixture | undefined
let promptsSeen = 0

/** Re-project the SAME already-committed message objects over a turn suffix. */
const projectWindow = (keepTurns: 'tail' | 'full'): Record<string, unknown> => {
  const renderer = (globalThis as unknown as GlobalProbe).__transcriptQualificationRenderer
  const committed = lastProductionCommit
  if (renderer === undefined || committed === undefined) throw new Error('no formal production commit has been observed yet')
  const turns = committed.messages
    .map(message => (message as { turn?: number }).turn)
    .filter((turn): turn is number => typeof turn === 'number')
  if (turns.length === 0) throw new Error('the last formal commit carries no turn-bearing message')
  const lastTurn = Math.max(...turns)
  let messages: readonly unknown[] = committed.messages
  let firstKeptTurn: number | undefined
  if (keepTurns === 'tail') {
    firstKeptTurn = lastTurn - 3
    const index = committed.messages.findIndex(message => {
      const turn = (message as { turn?: number }).turn
      return typeof turn === 'number' && turn >= firstKeptTurn
    })
    if (index < 0) throw new Error(`no message reaches the tail turn ${firstKeptTurn}`)
    // A CONTIGUOUS suffix only: nothing is reordered and nothing is invented.
    messages = committed.messages.slice(index)
  }
  const args = [messages, ...committed.rest]
  probing = true
  try {
    renderer.display.setTranscript(...args)
  } finally {
    probing = false
  }
  const kept = messages as readonly { kind: string; text?: string }[]
  const overlapMarkers = kept.map(message => firstToken(message.text)).filter((m): m is string => m !== undefined)
  return {
    projection: keepTurns,
    sourceSeq: sourceSeqByToken.get(committed.rest[4] as object) ?? null,
    messageCount: kept.length,
    firstKeptTurn: firstKeptTurn ?? null,
    lastTurn,
    displayedMarkers: overlapMarkers,
    displayedUserRows: kept.filter(message => message.kind === 'user').length,
  }
}

async function runCase (command: { kind: string; nodeId?: string }): Promise<Record<string, unknown>> {
  if (command.kind === 'hold-next-model') {
    holdingArmed = true
    return { armed: true, note: 'the fixture ScriptedStreamingAdapter only: no renderer or currentness effect' }
  }
  if (command.kind === 'release-model') {
    const wasArmed = holdingArmed
    releaseHeldStream()
    return { released: wasArmed, armed: holdingArmed }
  }
  if (command.kind === 'project-tail-window' || command.kind === 'project-full-window') {
    return projectWindow(command.kind === 'project-tail-window' ? 'tail' : 'full')
  }
  if (command.kind === 'reveal-node') {
    const surface = (globalThis as unknown as GlobalProbe).__transcriptQualificationSurface
    if (surface === undefined) throw new Error('the production inline Surface has not been opened yet')
    if (typeof command.nodeId !== 'string' || command.nodeId === '') throw new Error('reveal-node requires a nodeId')
    surface.reveal(command.nodeId, 'nearest')
    return { revealed: command.nodeId, align: 'nearest', surfaceId: surface.id }
  }
  throw new Error(`unknown subject command kind ${command.kind}`)
}

let lastHandledSeq = 0
let handling: Promise<void> | undefined
let polling = false
let lastModelCalls = -1

/**
 * The scripted Agent's own request counter, sampled by this subject's existing
 * 50 ms poll. The writer settles BEFORE the live Agent issues its model call,
 * so a settle-time sample is always one behind: the flow waits on this
 * monotone witness instead.
 */
const sampleModelCalls = (): void => {
  if (fixture === undefined) return
  const calls = fixture.modelCalls()
  if (calls === lastModelCalls) return
  lastModelCalls = calls
  note({ kind: 'producer.model.calls', calls, settledCount: promptsSeen })
}

const handleOneBatch = async (): Promise<void> => {
  sampleModelCalls()
  if (!existsSync(casePath)) return
  let command: { seq?: number; kind?: string; nodeId?: string }
  try {
    command = JSON.parse(readFileSync(casePath, 'utf8'))
  } catch {
    return
  }
  const seq = command.seq
  if (typeof seq !== 'number' || seq <= lastHandledSeq) return
  lastHandledSeq = seq
  const kind = String(command.kind)
  note({ kind: 'case.received', seq, command: kind, nodeId: command.nodeId })
  try {
    if (fixture === undefined) throw new Error('the Direct fixture is not ready')
    const result = await runCase({ kind, nodeId: command.nodeId })
    const payload = { seq, command: kind, status: 'ok', ...result }
    writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
    renameSync(`${caseResultPath}.tmp`, caseResultPath)
    note({ kind: 'case.finished', ...payload })
  } catch (error) {
    const payload = { seq, command: kind, status: 'error', error: String(error) }
    writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
    renameSync(`${caseResultPath}.tmp`, caseResultPath)
    note({ kind: 'case.finished', ...payload })
  }
}

const caseTimer = setInterval(() => {
  if (polling) return
  polling = true
  handling = (async () => {
    try {
      await handleOneBatch()
    } finally {
      polling = false
    }
  })()
}, 50)

const awaitRenderer = async (): Promise<TspRendererProbe | undefined> => {
  const deadline = Date.now() + 20_000
  for (;;) {
    const renderer = (globalThis as unknown as GlobalProbe).__transcriptQualificationRenderer
    if (renderer !== undefined) return renderer
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

try {
  note({
    kind: 'subject.ready',
    workRoot,
    wireRecordPath,
    eventsPath,
    promptsPath,
    casePath,
    sessionA: SESSION_A,
    sessionB: SESSION_B,
    promptCount: { a: A_PROMPTS.length, b: B_PROMPTS.length },
    clientRequirement: 'the subject must run inside a real Tern pane (TERN_PANE_DIR + the SDK handshake)',
  })
  fixture = await createDirectTspFixture(life, {
    externalTern: true,
    workRoot,
    startup: { sessionId: SESSION_A },
    persistedBlankSessions: [{ id: SESSION_A }, { id: SESSION_B }],
    deltas: ['TRANSCRIPT-', 'DIRECT-', 'ANSWER-SETTLED'],
    streamHold,
    appExit: () => {
      note({ kind: 'app.exit' })
      setImmediate(resolveExit)
    },
  }) as Fixture
  // The official Session transition, recorded AS-IS through the Host's own
  // `agents` service (one-to-one: unbound original, original receiver, the
  // result returned unchanged). The flow needs the real settle identity of the
  // Resume the USER clicked in the native Browser — never a scripted claim.
  const agents = fixture.ctx.get('agents') as unknown as {
    resume(options: unknown): Promise<unknown>
  }
  const originalResume = agents.resume
  agents.resume = async function (this: typeof agents, options: unknown): Promise<unknown> {
    const sessionId = String((options as { readonly resumeSessionId: unknown }).resumeSessionId)
    note({ kind: 'agents.resume.start', sessionId })
    try {
      const result = await originalResume.call(this, options)
      note({ kind: 'agents.resume.settled', sessionId })
      return result
    } catch (error) {
      note({ kind: 'agents.resume.rejected', sessionId, error: String(error) })
      throw error
    }
  }
  restoreAgentsResume = () => { agents.resume = originalResume }
  fixture.recordPrompts(call => {
    promptsSeen += 1
    note({
      kind: 'producer.writer.settled',
      settledCount: promptsSeen,
      sessionId: call.sessionId,
      mode: call.mode,
      agentStatus: call.agentStatus,
      outcomeKind: call.outcome.kind,
      marker: messageMarker(call.message),
    })
  })
  const renderer = await awaitRenderer()
  note({
    kind: 'fixture.ready',
    workRoot,
    wireRecordPath,
    sessionA: SESSION_A,
    sessionB: SESSION_B,
    rendererObserved: renderer !== undefined,
    initialDraft: renderer?.composer.getDraft() ?? null,
    productionComposition: 'createDirectTspFixture(externalTern=true) -> production SurfaceRuntime -> production mountTspRenderer over the shipped SDK connect()',
    standIns: [
      'the official Direct fixture scripted streaming LLM adapter (the model endpoint only)',
      'the fixed ASCII prompts written to prompts.json (isolated deterministic test input)',
      'case.json commands: hold/release of the fixture streamHold, TEST-ONLY turn-suffix re-projection, reveal on the production Surface',
      'GUI / PHYSICAL_OS / IME / wheel / OS clipboard: NOT_VERIFIED (tern ctl injects control input)',
    ],
  })
  console.log('transcript production qualification pane ready')
  await exitRequested
  clearInterval(caseTimer)
  await handling
  await setupCleanup!()
  note({ kind: 'fixture.settled', promptsSeen })
} finally {
  clearInterval(caseTimer)
  await handling
  releaseHeldStream()
  restoreAgentsResume?.()
  await setupCleanup?.()
  note({ kind: 'subject.final', promptsSeen })
}
