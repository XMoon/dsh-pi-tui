/**
 * Continuous transcript qualification subject for the production Direct/TSP path.
 * The official scripted model is the only stand-in; the Host, Agent, writer,
 * Folder, SurfaceRuntime, renderer and SDK remain the production composition.
 *
 * Two scenarios share this one subject, selected by
 * `TERN_CONTINUOUS_READING_STAGE4=1`:
 *
 * - DEFAULT (flag absent): the PR #652 25-prompt reveal flow, byte-for-byte the
 *   same prompts, the same writer count and `case.json:kind='reveal'`.
 * - STAGE4 (flag === '1'): 27 Session-A prompts (`PR1-TERN-01..25`, then
 *   `T2-READ-26`, `T2-READ-27`), an additional officially persisted blank
 *   Session B (`continuous-main-stage4-b`) for the headless source switch, and
 *   a `streamHold()` that holds the 26th REAL model request only. The held turn
 *   is released by `case.json:kind='release-held-26'`.
 *
 * The Stage4 scenario adds no production hook, no second Agent/Writer and no
 * new SDK monkey patch: it is the same fixture at a longer scenario with one
 * genuine held model call.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the continuous transcript subject')

/**
 * The opt-in Stage4 scenario.
 *
 * MEASURED on this build: a pane command started through `tern serve --control`
 * does NOT inherit the serve process's environment, so an env flag alone never
 * reaches the subject. The launched `launch.sh` CAN export it (the driver writes
 * that script), and the subject also honours a scenario file the flow writes into
 * the run directory BEFORE launching. Either signal opts in; with neither, the
 * PR1 flow is byte-for-byte the shipped one.
 */
const stage4MarkerPath = join(paneRoot, 'stage4.scenario')
const stage4 = process.env.TERN_CONTINUOUS_READING_STAGE4 === '1' || existsSync(stage4MarkerPath)
/**
 * The optional extra marker the flow names in its scenario file (the headless
 * source-switch prompt). It is only used to LABEL a settled write in the
 * subject's own ledger; it is never submitted by the subject.
 */
const scenarioBMarker = stage4 && existsSync(stage4MarkerPath)
  ? (JSON.parse(readFileSync(stage4MarkerPath, 'utf8')) as { readonly bMarker?: unknown }).bMarker
  : undefined
const sessionId = 'continuous-main-pr1'
/** The Stage4 source-switch target: an official persisted, released, blank Session. */
const secondSessionId = 'continuous-main-stage4-b'
const stage4PromptCount = 27
const heldOrdinal = 26
const workRoot = join(paneRoot, 'dsh-home')
const eventsPath = join(paneRoot, 'events.jsonl')
const wirePath = join(paneRoot, 'sdk-wire.jsonl')
const promptsPath = join(paneRoot, 'prompts.json')
const casePath = join(paneRoot, 'case.json')
const caseResultPath = join(paneRoot, 'case-result.json')
const stage4Markers = ['T2-READ-26', 'T2-READ-27'] as const
const prompts = Array.from({ length: stage4 ? stage4PromptCount : 25 }, (_unused, index) => {
  const marker = index < 25
    ? `PR1-TERN-${String(index + 1).padStart(2, '0')}`
    : stage4Markers[index - 25]!
  return { ordinal: index + 1, marker, text: `${marker} Keep this message in the continuously loaded transcript.` }
})

/**
 * The fixed Stage4 scripted reply: an actual long-CJK / Markdown / code-block
 * witness so the GUI matrix has real overflow content to read. TEST OUTPUT only;
 * the no-flag response is unchanged.
 */
const STAGE4_DELTAS = [
  'Continuous Main native reading. 原生历史阅读。\n\n',
  '## Rendering checkpoint\n\n',
  '```ts\nconst reading = { follow: true, history: "continuous" };\n```\n\n',
  '这是一条用于检测宽度与裁切的中英混排长文本：' + '中文CJK'.repeat(48) + '\n\n',
  'End of fixed Stage4 response.',
] as const

mkdirSync(workRoot, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wirePath
writeFileSync(promptsPath, `${JSON.stringify({
  sessionId,
  prompts,
  ...(stage4 ? { sessions: { a: sessionId, b: secondSessionId }, stage4: true, heldOrdinal } : {}),
}, null, 1)}\n`)

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

/* One-to-one qualification observation of the production inline Surface. */
const __continuousOriginalMount = mountTspRenderer
mountTspRenderer = function (...args) {
  const sdkSession = args[0]
  const originalOpen = sdkSession.open
  sdkSession.open = function (...openArgs) {
    const opened = originalOpen.apply(this, openArgs)
    if (openArgs[0] && openArgs[0].mode === 'inline') {
      globalThis.__continuousMainSurface = opened
      globalThis.__continuousMainNote?.({ kind: 'surface.inline.opened', id: opened.id })
    }
    return opened
  }
  return __continuousOriginalMount.apply(this, args)
}
`
    return { ...result, source: source + hook }
  },
})
;(globalThis as unknown as { __continuousMainNote?: (event: Record<string, unknown>) => void }).__continuousMainNote = note

type ContinuousSurface = { readonly id: string; reveal(id: string, at?: string): void }
type ContinuousGlobal = { __continuousMainSurface?: ContinuousSurface }
let lastCommandSeq = 0

/**
 * The held 26th model request. ARMING IS NOT HOLDING: the Direct writer settles
 * as soon as the Agent accepts the message, and only the live model request
 * afterwards enters this gate. `model.hold.26.started` therefore records the
 * request that is REALLY parked, and a release proves it resolved THAT wait.
 */
let heldOrdinalArmed = stage4
let heldResolve: (() => void) | undefined
let heldPromise: Promise<void> | undefined
let heldRequestOrdinal: number | undefined
let releasedRequests = 0
let modelRequests = 0
/** The prompt ordinal of the most recently settled Direct write. */
let lastSettledOrdinal: number | null = null

const streamHold = (): Promise<void> => {
  modelRequests += 1
  if (!heldOrdinalArmed || modelRequests !== heldOrdinal) return Promise.resolve()
  if (heldPromise === undefined) {
    heldRequestOrdinal = modelRequests
    heldPromise = new Promise<void>(resolve => { heldResolve = resolve })
    note({ kind: 'model.hold.26.started', ordinal: lastSettledOrdinal, modelCalls: fixture?.modelCalls() ?? 0 })
  }
  return heldPromise
}

/**
 * Release the parked request EXACTLY once. A repeated or premature release is
 * refused and noted; it never releases another turn.
 */
const releaseHeldStream = (
  seq: number,
): { seq: number; status: string; released: boolean; ordinal: number | null } => {
  const resolve = heldResolve
  const ordinal = heldRequestOrdinal ?? null
  if (!heldOrdinalArmed || resolve === undefined) {
    note({ kind: 'model.hold.26.refused', seq, reason: 'no held request is parked', ordinal })
    return { seq, status: 'refused', released: false, ordinal }
  }
  if (releasedRequests > 0) {
    note({ kind: 'model.hold.26.refused', seq, reason: 'the held request was already released', ordinal })
    return { seq, status: 'refused', released: false, ordinal }
  }
  heldOrdinalArmed = false
  heldResolve = undefined
  heldPromise = undefined
  releasedRequests += 1
  resolve()
  note({ kind: 'model.hold.26.released', seq, ordinal })
  return { seq, status: 'ok', released: true, ordinal }
}

/**
 * The one command channel. DEFAULT accepts only `reveal`; Stage4 accepts
 * `reveal` and `release-held-26`. Exactly one result file answers one seq, and a
 * command whose seq does not advance is ignored (never re-executed).
 */
const applyCommand = (): void => {
  if (!existsSync(casePath)) return
  const command = JSON.parse(readFileSync(casePath, 'utf8')) as {
    readonly seq?: number
    readonly kind?: string
    readonly nodeId?: string
  }
  if (typeof command.seq !== 'number' || command.seq <= lastCommandSeq) return
  lastCommandSeq = command.seq
  if (command.kind === 'release-held-26') {
    if (!stage4) throw new Error('release-held-26 requires TERN_CONTINUOUS_READING_STAGE4=1')
    const result = releaseHeldStream(command.seq)
    atomicResult(result)
    return
  }
  if (command.kind !== 'reveal' || typeof command.nodeId !== 'string' || command.nodeId === '') {
    throw new Error(`the continuous Main subject accepts only a reveal command with a real node id${stage4 ? ' or release-held-26' : ''}`)
  }
  const surface = (globalThis as unknown as ContinuousGlobal).__continuousMainSurface
  if (surface === undefined) throw new Error('the production inline Surface is not open')
  surface.reveal(command.nodeId, 'nearest')
  const result = { seq: command.seq, status: 'ok', nodeId: command.nodeId, surfaceId: surface.id, action: 'surface.reveal' }
  atomicResult(result)
  note({ kind: 'client.reveal.requested', ...result })
}

function atomicResult(result: Record<string, unknown>): void {
  writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(result)}\n`)
  renameSync(`${caseResultPath}.tmp`, caseResultPath)
}

let fixture: import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture | undefined
let releaseFixture: (() => void | Promise<void>) | undefined
let recorder: { detach(): void } | undefined
let observationTimer: ReturnType<typeof setInterval> | undefined
let restoreAgentsResume: (() => void) | undefined
let sampleFacts: (() => void) | undefined
let settledWrites = 0
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => {
  resolveExit = resolve
  process.once('SIGTERM', () => setImmediate(resolve))
  process.once('SIGINT', () => setImmediate(resolve))
})

const life: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir(prefix) { throw new Error(`the external Tern subject requires an explicit workRoot, got ${prefix}`) },
  defer(cleanup) { releaseFixture = cleanup },
}

try {
  const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')
  fixture = await createDirectTspFixture(life, {
    externalTern: true,
    workRoot,
    startup: { sessionId },
    persistedBlankSessions: stage4
      ? [{ id: sessionId }, { id: secondSessionId }]
      : [{ id: sessionId }],
    tuiConfig: { displayPreset: 'full' },
    deltas: stage4 ? STAGE4_DELTAS : ['continuous Main scripted reply'],
    ...(stage4 ? { streamHold } : {}),
    appExit: () => { setImmediate(resolveExit) },
  })

  // The official source-switch evidence the headless lane needs: the REAL
  // `agents.resume` call the Session Browser makes when the user clicks Resume.
  // One-to-one observation of the production service (unbound original saved,
  // restored by identity), never a second resume path.
  if (stage4) {
    const agents = (fixture as unknown as {
      ctx: { get(name: string): { resume: (options: unknown) => Promise<unknown> } }
    }).ctx.get('agents')
    const originalResume = agents.resume
    agents.resume = async function (this: typeof agents, options: unknown): Promise<unknown> {
      const resumedSessionId = String((options as { readonly resumeSessionId: unknown }).resumeSessionId)
      note({ kind: 'agents.resume.start', sessionId: resumedSessionId })
      try {
        const result = await originalResume.call(this, options)
        note({ kind: 'agents.resume.settled', sessionId: resumedSessionId })
        return result
      } catch (error) {
        note({ kind: 'agents.resume.rejected', sessionId: resumedSessionId, error: String(error) })
        throw error
      }
    }
    restoreAgentsResume = () => { agents.resume = originalResume }
  }

  const eventReaders = new Map<string, () => readonly { readonly seq?: number; readonly type: string; readonly data?: unknown }[]>()
  const eventCursors = new Map<string, number>()
  let lastModelCalls = 0
  recorder = fixture.recordPrompts(call => {
    settledWrites += 1
    eventReaders.set(call.sessionId, call.sessionEvents)
    const known = prompts.find(prompt => JSON.stringify(call.message).includes(prompt.marker))?.marker
    const marker = known
      ?? (typeof scenarioBMarker === 'string' && JSON.stringify(call.message).includes(scenarioBMarker) ? scenarioBMarker : undefined)
    lastSettledOrdinal = prompts.find(prompt => prompt.marker === marker)?.ordinal ?? null
    note({
      kind: 'writer.settled',
      ordinal: settledWrites,
      marker: marker ?? null,
      sessionId: call.sessionId,
      mode: call.mode,
      outcomeKind: call.outcome.kind,
    })
  })

  sampleFacts = () => {
    const calls = fixture!.modelCalls()
    if (calls !== lastModelCalls) {
      lastModelCalls = calls
      note({ kind: 'model.calls', calls })
    }
    for (const [sourceSessionId, readEvents] of eventReaders) {
      const entries = readEvents()
      let cursor = eventCursors.get(sourceSessionId) ?? 0
      while (cursor < entries.length) {
        const event = entries[cursor++]!
        const data = event.data as { readonly turn?: unknown } | undefined
        note({
          kind: 'session.event',
          sessionId: sourceSessionId,
          index: cursor - 1,
          seq: event.seq ?? null,
          eventType: event.type,
          turn: typeof data?.turn === 'number' ? data.turn : null,
        })
      }
      eventCursors.set(sourceSessionId, cursor)
    }
  }
  observationTimer = setInterval(() => {
    sampleFacts?.()
    applyCommand()
  }, 25)

  note({
    kind: 'subject.ready',
    sessionId,
    workRoot,
    promptsPath,
    wirePath,
    ...(stage4 ? { stage4: true, sessions: { a: sessionId, b: secondSessionId }, heldOrdinal, promptCount: prompts.length } : {}),
    productionComposition: 'createDirectTspFixture(externalTern=true) -> real Direct Agent/writer -> one Folder -> SurfaceRuntime -> production TSP renderer -> shipped SDK',
    standIns: ['the fixture scripted streaming LLM adapter (model endpoint only)', 'CONTROL_INJECTED_INPUT from the real Tern pane'],
  })
  console.log(stage4 ? 'continuous reading stage4 subject ready' : 'continuous transcript subject ready')
  await exitRequested
} finally {
  if (observationTimer !== undefined) clearInterval(observationTimer)
  sampleFacts?.()
  recorder?.detach()
  restoreAgentsResume?.()
  if (fixture !== undefined) {
    note({ kind: 'subject.stopping', sessionId, modelCalls: fixture.modelCalls(), settledWrites })
    await fixture.settle()
  }
  await releaseFixture?.()
  note({
    kind: 'subject.final',
    sessionId,
    modelCalls: fixture?.modelCalls() ?? 0,
    settledWrites,
    ...(stage4 ? { stage4: true, releasedRequests } : {}),
  })
}
