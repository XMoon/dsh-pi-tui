/**
 * TSP canonical Full/Compact transcript mode qualification SUBJECT.
 *
 * Boots the PRODUCTION Direct application (`createDirectTspFixture({
 * externalTern: true, tuiConfig: { displayPreset: <mode> } })`) inside ONE real
 * `tern serve --control` pane. The mode comes from the SAME volatile Runner
 * config the product reads, so `resolveDisplayPreset` → the ONE `DisplayState`
 * → `productionTspConnector` → the mounted renderer is the only mode path.
 * This file never sets a renderer-local preset and never renders a node.
 *
 * It owns exactly three things:
 *  1. a READ-ONE-TO-ONE observation of the production `display.setTranscript`
 *     commit and of the client's own `toggle`/`error` events, installed by
 *     `module.registerHooks` (unbound original, original receiver, original
 *     arguments/order, result returned unchanged, errors never caught);
 *  2. the isolated deterministic test INPUT (`prompts.json`, the only prompt
 *     definition the flow reads);
 *  3. a TEST-ONLY `case.json` command channel that re-projects the ALREADY
 *     COMMITTED real message objects through the SAME mounted Presenter, so a
 *     second formal commit can prove the mode reads the live authority.
 *
 * EVIDENCE THIS SUBJECT CANNOT PROVE (declared, never claimed): input is
 * CONTROL_INJECTED (`tern ctl type|key|click`) — no physical keyboard, IME,
 * wheel or OS clipboard; the real GUI/OS appearance and G8 are NOT_VERIFIED.
 * Focus TSP is NOT_IMPLEMENTED in this PR and is not exercised here.
 *
 * Usage: `TERN_PANE_TRANSCRIPT_MODE=full|compact` through
 * `scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-modes.mjs`.
 * @module scripts/tern-pane-transcript-modes-subject
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern transcript-modes subject')
// The launcher script forwards only TERN_PANE_DIR (the harness owns it), so the
// mode travels through the run directory the FLOW wrote: ONE mode per run, no
// second source.
const modePath = join(paneRoot, 'mode.json')
if (!existsSync(modePath)) throw new Error(`the flow must write ${modePath} before launching this subject`)
const modeConfig = JSON.parse(readFileSync(modePath, 'utf8')) as { readonly mode?: string; readonly scenario?: string }
const mode = modeConfig.mode
const scenario = modeConfig.scenario ?? 'modes'
if (mode !== 'full' && mode !== 'compact' && mode !== 'focus') {
  throw new Error('the flow must select exactly full, compact or focus')
}
if (scenario !== 'modes' && scenario !== 'inner-disclosure') {
  throw new Error(`unknown transcript Tern scenario ${scenario}`)
}
const workRoot = join(paneRoot, 'dsh-home')
const wireRecordPath = join(paneRoot, 'sdk-wire.jsonl')
const eventsPath = join(paneRoot, 'events.jsonl')
const promptsPath = join(paneRoot, 'prompts.json')
const casePath = join(paneRoot, 'case.json')
const caseResultPath = join(paneRoot, 'case-result.json')
let releaseReasoning!: () => void
const heldReasoning = new Promise<void>(resolve => { releaseReasoning = resolve })
let reasoningReleased = false
let reasoningDeltaHeld = false

const releaseToolArgumentsPath = join(paneRoot, 'release-tool-arguments.json')
let releaseToolArguments!: () => void
const heldToolArguments = new Promise<void>(resolve => { releaseToolArguments = resolve })
let toolArgumentsReleased = false
const onReleaseReasoning = (): void => {
  if (reasoningReleased) return
  reasoningReleased = true
  releaseReasoning()
  note({ kind: 'subject.reasoning.second-released' })
}
writeFileSync(releaseToolArgumentsPath, `${JSON.stringify({ release: false })}\n`)
const onReleaseToolArguments = (): void => {
  if (!existsSync(releaseToolArgumentsPath)) return
  const state = JSON.parse(readFileSync(releaseToolArgumentsPath, 'utf8')) as { release?: boolean }
  if (state.release !== true || toolArgumentsReleased) return
  toolArgumentsReleased = true
  releaseToolArguments()
  note({ kind: 'subject.tool-arguments.released' })
}

// The DSH home and the SDK wire recorder are process-level facts that must
// exist BEFORE the Host composition is imported (both are read at connect).
mkdirSync(workRoot, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wireRecordPath

const note = (event: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}

// ── Fixed, isolated, deterministic test input (the ONLY prompt definition) ──
const PROMPT = scenario === 'inner-disclosure'
  ? `INNER-${mode.toUpperCase()} Inspect the live reasoning, tool details and context disclosures.`
  : 'MODES-01 Please list the background jobs and then answer with one short plain note '
    + 'about the canonical transcript reading flow, mixing English with 中文混排 so the real client wraps it.'
writeFileSync(promptsPath, `${JSON.stringify({
  mode,
  scenario,
  assistantMarker: scenario === 'inner-disclosure' ? `INNER-${mode.toUpperCase()}-ANSWER` : 'MODES-DIRECT-ANSWER',
  toolName: 'job_list',
  prompts: [{ ordinal: 1, marker: scenario === 'inner-disclosure' ? `INNER-${mode.toUpperCase()}` : 'MODES-01', text: PROMPT }],
}, null, 1)}\n`)

// ── ONE-TO-ONE recorder around the production mount (append-only) ──
const observedRendererUrl = new URL('../src/tui/tsp/session.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== observedRendererUrl) return result
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source ?? '')
    const hook = `

/* Transcript-modes qualification ONE-TO-ONE subject recorder (appended; the
   production source above is byte-for-byte unchanged). */
const __tmNote = (event) => globalThis.__transcriptModesNote?.(event)
const __tmOriginalMount = mountTspRenderer
mountTspRenderer = function (...args) {
  const sdkSession = args[0]
  // Record the client's OWN toggle/error events one-to-one. The iterator is
  // wrapped BEFORE the mount starts its own loop: one reader, delegated, no
  // second consumer and no changed value.
  const originalIterator = sdkSession[Symbol.asyncIterator]
  sdkSession[Symbol.asyncIterator] = function () {
    const inner = originalIterator.call(sdkSession)
    return {
      async next() {
        const step = await inner.next()
        if (!step.done && step.value && step.value.type === 'event' && step.value.event) {
          const event = step.value.event
          if (event.ev === 'toggle') {
            const fields = { kind: 'client.toggle', id: event.id }
            if (event.sf !== undefined) fields.sf = event.sf
            if (event.collapsed !== undefined) fields.collapsed = event.collapsed
            if (event.key !== undefined) fields.key = event.key
            __tmNote(fields)
          } else if (event.ev === 'error') {
            const fields = { kind: 'sdk.error', msg: event.msg }
            if (event.sf !== undefined) fields.sf = event.sf
            if (event.id !== undefined) fields.id = event.id
            __tmNote(fields)
          }
        }
        return step
      },
      return(value) { return inner.return ? inner.return(value) : { done: true, value } },
      throw(error) { return inner.throw ? inner.throw(error) : Promise.reject(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }
  const originalOpen = sdkSession.open
  sdkSession.open = function (...openArgs) {
    const opened = originalOpen.apply(this, openArgs)
    if (openArgs[0] && openArgs[0].mode === 'inline') {
      globalThis.__transcriptModesSurface = opened
      __tmNote({ kind: 'surface.inline.opened', id: opened.id })
    }
    return opened
  }
  __tmNote({ kind: 'sdk.caps', caps: sdkSession.caps })
  const renderer = __tmOriginalMount.apply(this, args)
  const originalCommit = renderer.display.setTranscript
  renderer.display.setTranscript = function (...commitArgs) {
    const result = originalCommit.apply(this, commitArgs)
    globalThis.__transcriptModesObserveCommit?.(commitArgs)
    return result
  }
  globalThis.__transcriptModesRenderer = renderer
  __tmNote({ kind: 'renderer.observed' })
  return renderer
}
`
    return { ...result, source: source + hook }
  },
})

type GlobalProbe = {
  __transcriptModesNote?: (event: Record<string, unknown>) => void
  __transcriptModesObserveCommit?: (args: readonly unknown[]) => void
  __transcriptModesRenderer?: { display: { setTranscript: (...args: unknown[]) => void }; composer: { getDraft(): string } }
  __transcriptModesSurface?: { id: string }
}
;(globalThis as unknown as GlobalProbe).__transcriptModesNote = note

// ── The read-only commit record ──
const sourceSeqByToken = new WeakMap<object, number>()
let nextSourceSeq = 0
let probing = false
let lastProductionCommit: { messages: readonly unknown[]; rest: unknown[] } | undefined

const observeCommit = (args: readonly unknown[]): void => {
  const messages = (Array.isArray(args[0]) ? args[0] : []) as readonly { kind?: string; turn?: number; text?: string }[]
  const rest = args.slice(1)
  const window = rest[1] as { mode?: string; hasNewer?: boolean; lastTurn?: number } | undefined
  const source = rest[4] as object | undefined
  let sourceSeq: number | undefined
  if (source !== undefined) {
    const known = sourceSeqByToken.get(source)
    if (known === undefined) {
      nextSourceSeq += 1
      sourceSeqByToken.set(source, nextSourceSeq)
      sourceSeq = nextSourceSeq
      note({ kind: 'scope.changed', sourceSeq, origin: probing ? 'subject-probe' : 'production' })
    } else sourceSeq = known
  }
  note({
    kind: 'display.setTranscript',
    origin: probing ? 'subject-probe' : 'production',
    sourceSeq,
    messageCount: messages.length,
    kinds: messages.map(message => message.kind),
    hasNewer: window?.hasNewer,
    windowMode: window?.mode,
    lastTurn: window?.lastTurn,
  })
  if (!probing) lastProductionCommit = { messages, rest }
}
;(globalThis as unknown as GlobalProbe).__transcriptModesObserveCommit = observeCommit

// ── Lifecycle ──
process.once('exit', code => note({ kind: 'process.exit', code }))
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => { resolveExit = resolve })
process.once('SIGTERM', () => { onReleaseReasoning(); setImmediate(resolveExit) })
process.once('SIGINT', () => { onReleaseReasoning(); setImmediate(resolveExit) })
let setupCleanup: (() => unknown) | undefined
const life: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir: prefix => { throw new Error(`the external Tern subject requires an explicit workRoot, got ${prefix}`) },
  defer: cleanup => {
    setupCleanup = () => {
      onReleaseReasoning()
      return cleanup()
    }
  },
}

const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')
type Fixture = import('../test/support/direct-tsp-fixture.ts').DirectTspExternalFixture
let fixture: Fixture | undefined
let mainSessionId: string | undefined
let promptsSeen = 0

/** Re-project the SAME already-committed message objects: a second FORMAL
 *  commit through the same Presenter, never a new fold or a new source. */
const reproject = (): Record<string, unknown> => {
  const renderer = (globalThis as unknown as GlobalProbe).__transcriptModesRenderer
  const committed = lastProductionCommit
  if (renderer === undefined || committed === undefined) throw new Error('no formal production commit has been observed yet')
  probing = true
  try {
    renderer.display.setTranscript(committed.messages, ...committed.rest)
  } finally {
    probing = false
  }
  return { messageCount: committed.messages.length, sourceSeq: sourceSeqByToken.get(committed.rest[4] as object) ?? null }
}

let lastHandledSeq = 0
let handling: Promise<void> | undefined
let polling = false
const handleOneBatch = async (): Promise<void> => {
  if (!existsSync(casePath)) return
  let command: { seq?: number; kind?: string }
  try {
    command = JSON.parse(readFileSync(casePath, 'utf8'))
  } catch {
    return
  }
  const seq = command.seq
  if (typeof seq !== 'number' || seq <= lastHandledSeq) return
  lastHandledSeq = seq
  const kind = String(command.kind)
  note({ kind: 'case.received', seq, command: kind })
  try {
    if (fixture === undefined) throw new Error('the Direct fixture is not ready')
    if (kind === 'release-reasoning') {
      if (scenario !== 'inner-disclosure' || !reasoningDeltaHeld) {
        throw new Error('the real Direct Agent has not reached its second-reasoning gate')
      }
      onReleaseReasoning()
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'reproject') {
      const payload = { seq, command: kind, status: 'ok', ...reproject() }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'append-context') {
      if (mainSessionId === undefined) throw new Error('no production Direct writer has selected the main Session')
      const agent = fixture.ctx.agents.get(mainSessionId as never)
      if (agent === undefined) throw new Error('the Direct Session agent is not available')
      for (const [index, text] of ['first native context detail', 'second native context detail'].entries()) {
        agent.session.append('user/message', {
          id: MessageId(`inner-context-${mode}-${index}`),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', form: 'snapshot', plugin: `inner-context-${index}` },
        }, { surfaceOp: 'append' })
      }
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'release-tool-arguments') {
      writeFileSync(releaseToolArgumentsPath, `${JSON.stringify({ release: true })}\n`)
      onReleaseToolArguments()
      if (!toolArgumentsReleased) throw new Error('the real model step is not holding Tool arguments')
      await heldToolArguments
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    throw new Error(`unknown subject command kind ${kind}`)
  } catch (error) {
    const payload = { seq, command: kind, status: 'error', error: String(error) }
    writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
    renameSync(`${caseResultPath}.tmp`, caseResultPath)
    note({ kind: 'case.finished', ...payload })
  }
}
watchFile(releaseToolArgumentsPath, { interval: 50 }, onReleaseToolArguments)
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

const awaitRenderer = async (): Promise<boolean> => {
  const deadline = Date.now() + 20_000
  for (;;) {
    if ((globalThis as unknown as GlobalProbe).__transcriptModesRenderer !== undefined) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

try {
  note({
    kind: 'subject.ready',
    mode,
    scenario,
    workRoot,
    wireRecordPath,
    eventsPath,
    promptsPath,
    casePath,
    clientRequirement: 'the subject must run inside a real Tern pane (TERN_PANE_DIR + the SDK handshake)',
  })
  fixture = await createDirectTspFixture(life, {
    externalTern: true,
    workRoot,
    // The ONE production mode authority: the real Runner volatile config that
    // `resolveDisplayPreset` reads. No renderer-local preset is set anywhere.
    tuiConfig: { displayPreset: mode },
    deltas: scenario === 'inner-disclosure' ? [`INNER-${mode.toUpperCase()}-`, 'ANSWER'] : ['MODES-', 'DIRECT-', 'ANSWER'],
    ...(scenario === 'inner-disclosure' ? {
      scriptedToolCalls: [{ text: 'the production Agent is checking the jobs', toolCall: { callId: 'call-inner-jobs', name: 'job_list', arguments: '{}' } }],
      scriptedReasoningDeltas: ['checking the first row\n', 'latest reasoning line'],
      holdScriptedReasoningDelta: async (step: number, deltaIndex: number) => {
        if (scenario === 'inner-disclosure' && step === 0 && deltaIndex === 1) {
          reasoningDeltaHeld = true
          note({ kind: 'subject.reasoning.second-held', step, deltaIndex })
          await heldReasoning
        }
      },
      holdScriptedToolCallArguments: async (step: number) => { if (step === 0) await heldToolArguments },
    } : {
      // ONE real registered Host tool, executed by the production Agent loop.
      scriptedToolCall: { callId: 'call-modes-jobs', name: 'job_list', arguments: '{}' },
    }),
    appExit: () => {
      onReleaseReasoning()
      note({ kind: 'app.exit' })
      setImmediate(resolveExit)
    },
  }) as Fixture
  fixture.recordPrompts(call => {
    promptsSeen += 1
    mainSessionId = call.sessionId
    note({ kind: 'producer.writer.settled', settledCount: promptsSeen, sessionId: call.sessionId, mode: call.mode, outcomeKind: call.outcome.kind })
  })
  const rendererObserved = await awaitRenderer()
  note({
    kind: 'fixture.ready',
    mode,
    scenario,
    session: mainSessionId ?? null,
    workRoot,
    wireRecordPath,
    rendererObserved,
    productionComposition: 'createDirectTspFixture(externalTern=true, tuiConfig.displayPreset) -> resolveDisplayPreset -> productionTspConnector -> mountTspRenderer over the shipped SDK connect()',
    standIns: [
      'the official Direct fixture scripted streaming LLM adapter (the model endpoint only)',
      'the fixed prompt written to prompts.json (isolated deterministic test input)',
      'case.json reproject: TEST-ONLY re-commit of the SAME already-committed message objects',
      'GUI / PHYSICAL_OS / IME / wheel / OS clipboard: NOT_VERIFIED (tern ctl injects control input)',
      'FOCUS_TSP_NOT_YET_IMPLEMENTED: this PR does not project Focus on TSP',
    ],
  })
  console.log(`transcript modes pane ready (${mode})`)
  await exitRequested
  clearInterval(caseTimer)
  unwatchFile(releaseToolArgumentsPath, onReleaseToolArguments)
  await handling
  await setupCleanup!()
  note({ kind: 'fixture.settled', promptsSeen })
} finally {
  clearInterval(caseTimer)
  unwatchFile(releaseToolArgumentsPath, onReleaseToolArguments)
  await handling
  await setupCleanup?.()
  note({ kind: 'subject.final', promptsSeen })
}
