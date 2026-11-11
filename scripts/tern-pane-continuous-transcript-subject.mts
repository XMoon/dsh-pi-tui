/**
 * Continuous transcript qualification subject for the production Direct/TSP path.
 * The official scripted model is the only stand-in; the Host, Agent, writer,
 * Folder, SurfaceRuntime, renderer and SDK remain the production composition.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the continuous transcript subject')

const sessionId = 'continuous-main-pr1'
const workRoot = join(paneRoot, 'dsh-home')
const eventsPath = join(paneRoot, 'events.jsonl')
const wirePath = join(paneRoot, 'sdk-wire.jsonl')
const promptsPath = join(paneRoot, 'prompts.json')
const casePath = join(paneRoot, 'case.json')
const caseResultPath = join(paneRoot, 'case-result.json')
const prompts = Array.from({ length: 25 }, (_unused, index) => {
  const marker = `PR1-TERN-${String(index + 1).padStart(2, '0')}`
  return { ordinal: index + 1, marker, text: `${marker} Keep this message in the continuously loaded transcript.` }
})

mkdirSync(workRoot, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wirePath
writeFileSync(promptsPath, `${JSON.stringify({ sessionId, prompts }, null, 1)}\n`)

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
let lastRevealSeq = 0
const applyReveal = (): void => {
  if (!existsSync(casePath)) return
  const command = JSON.parse(readFileSync(casePath, 'utf8')) as { readonly seq?: number; readonly kind?: string; readonly nodeId?: string }
  if (typeof command.seq !== 'number' || command.seq <= lastRevealSeq) return
  lastRevealSeq = command.seq
  if (command.kind !== 'reveal' || typeof command.nodeId !== 'string' || command.nodeId === '') {
    throw new Error('the continuous Main subject accepts only a reveal command with a real node id')
  }
  const surface = (globalThis as unknown as ContinuousGlobal).__continuousMainSurface
  if (surface === undefined) throw new Error('the production inline Surface is not open')
  surface.reveal(command.nodeId, 'nearest')
  const result = { seq: command.seq, status: 'ok', nodeId: command.nodeId, surfaceId: surface.id, action: 'surface.reveal' }
  writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(result)}\n`)
  renameSync(`${caseResultPath}.tmp`, caseResultPath)
  note({ kind: 'client.reveal.requested', ...result })
}

let fixture: import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture | undefined
let releaseFixture: (() => void | Promise<void>) | undefined
let recorder: { detach(): void } | undefined
let observationTimer: ReturnType<typeof setInterval> | undefined
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
    persistedBlankSessions: [{ id: sessionId }],
    tuiConfig: { displayPreset: 'full' },
    deltas: ['continuous Main scripted reply'],
    appExit: () => { setImmediate(resolveExit) },
  })

  const eventReaders = new Map<string, () => readonly { readonly seq?: number; readonly type: string; readonly data?: unknown }[]>()
  const eventCursors = new Map<string, number>()
  let lastModelCalls = 0
  recorder = fixture.recordPrompts(call => {
    settledWrites += 1
    eventReaders.set(call.sessionId, call.sessionEvents)
    const marker = prompts.find(prompt => JSON.stringify(call.message).includes(prompt.marker))?.marker
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
    applyReveal()
  }, 25)

  note({
    kind: 'subject.ready',
    sessionId,
    workRoot,
    promptsPath,
    wirePath,
    productionComposition: 'createDirectTspFixture(externalTern=true) -> real Direct Agent/writer -> one Folder -> SurfaceRuntime -> production TSP renderer -> shipped SDK',
    standIns: ['the fixture scripted streaming LLM adapter (model endpoint only)', 'CONTROL_INJECTED_INPUT from the real Tern pane'],
  })
  console.log('continuous transcript subject ready')
  await exitRequested
} finally {
  if (observationTimer !== undefined) clearInterval(observationTimer)
  sampleFacts?.()
  recorder?.detach()
  if (fixture !== undefined) {
    note({ kind: 'subject.stopping', sessionId, modelCalls: fixture.modelCalls(), settledWrites })
    await fixture.settle()
  }
  await releaseFixture?.()
  note({ kind: 'subject.final', sessionId, modelCalls: fixture?.modelCalls() ?? 0, settledWrites })
}
