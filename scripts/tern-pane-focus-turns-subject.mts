import { appendFileSync, existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { registerHooks } from 'node:module'
import { defineTool } from '@deepseek-ai/dsh-tools'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the Focus-turn subject')
const workRoot = join(paneRoot, 'dsh-home')
const wireRecordPath = join(paneRoot, 'sdk-wire.jsonl')
const eventsPath = join(paneRoot, 'events.jsonl')
const promptsPath = join(paneRoot, 'prompts.json')
const releasePath = join(paneRoot, 'release-stream.json')
const releaseToolAPath = join(paneRoot, 'release-tool-a.json')
const releaseToolStepPath = join(paneRoot, 'release-tool-step.json')
const releaseToolArgumentsPath = join(paneRoot, 'release-tool-arguments.json')
const turnEndReleasePath = join(paneRoot, 'release-turn-end.json')
const scenarioPath = join(paneRoot, 'focus-scenario.json')
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as { readonly name: 'svg' | 'image' | 'question' }
const scenarioName = scenario.name
if (scenarioName !== 'svg' && scenarioName !== 'image' && scenarioName !== 'question') {
  throw new Error(`unknown Focus Tern case ${scenarioName}`)
}
const prompt = scenarioName === 'svg'
  ? 'FOCUS-TURNS-01 Start the first operation, then inspect the standalone SVG result.'
  : scenarioName === 'image'
    ? 'FOCUS-RASTER-01 Render and inspect the registered durable image result.'
    : 'FOCUS-WAIT-01 Ask for a decision, then report one concise result.'
const finalMarker = `${scenarioName.toUpperCase()}-DIRECT-FINAL`
mkdirSync(workRoot, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = wireRecordPath
const note = (value: Record<string, unknown>): void => appendFileSync(eventsPath, `${JSON.stringify({ scenario: scenarioName, ...value })}\n`)
process.once('beforeExit', () => note({ kind: 'subject.beforeExit' }))
const SESSION_ID = `focus-turn-transcript-${scenarioName}`
writeFileSync(promptsPath, `${JSON.stringify({
  scenario: scenarioName,
  session: SESSION_ID,
  prompt,
  steer: scenarioName === 'svg' ? 'Inspect the SVG result after the first operation.' : undefined,
  assistantMarker: finalMarker,
}, null, 1)}\n`)

writeFileSync(releasePath, `${JSON.stringify({ release: false })}\n`)
writeFileSync(releaseToolAPath, `${JSON.stringify({ release: false })}\n`)
writeFileSync(releaseToolStepPath, `${JSON.stringify({ release: false })}\n`)
writeFileSync(releaseToolArgumentsPath, `${JSON.stringify({ release: false })}\n`)
writeFileSync(turnEndReleasePath, `${JSON.stringify({ release: false })}\n`)

let releaseHeldToolA!: () => void
const heldToolA = new Promise<void>(resolve => { releaseHeldToolA = resolve })
let heldToolAReleased = false
const onReleaseToolAFileChange = (): void => {
  if (!existsSync(releaseToolAPath)) return
  const request = JSON.parse(readFileSync(releaseToolAPath, 'utf8')) as { release?: boolean }
  if (request.release !== true || heldToolAReleased) return
  heldToolAReleased = true
  releaseHeldToolA()
  note({ kind: 'subject.tool-a.released' })
}
let releaseHeldToolStep!: () => void
const heldToolStep = new Promise<void>(resolve => { releaseHeldToolStep = resolve })
let heldToolStepReleased = false
let releaseHeldToolArguments!: () => void
const heldToolArguments = new Promise<void>(resolve => { releaseHeldToolArguments = resolve })
let heldToolArgumentsReleased = false
const onReleaseToolStepFileChange = (): void => {
  if (!existsSync(releaseToolStepPath)) return
  const request = JSON.parse(readFileSync(releaseToolStepPath, 'utf8')) as { release?: boolean; releaseArguments?: boolean }
  if (request.release === true && !heldToolStepReleased) {
    heldToolStepReleased = true
    releaseHeldToolStep()
    note({ kind: 'subject.model-step.released', stepIndex: 1 })
  }
  if (request.releaseArguments === true && !heldToolArgumentsReleased) {
    heldToolArgumentsReleased = true
    releaseHeldToolArguments()
    note({ kind: 'subject.tool-arguments.released' })
  }
}

const onReleaseToolArgumentsFileChange = (): void => {
  if (!existsSync(releaseToolArgumentsPath)) return
  const request = JSON.parse(readFileSync(releaseToolArgumentsPath, 'utf8')) as { release?: boolean }
  if (request.release !== true || heldToolArgumentsReleased) return
  heldToolArgumentsReleased = true
  releaseHeldToolArguments()
  note({ kind: 'subject.tool-arguments.released', callId: 'focus-real-svg-b' })
}

let deferredTurnEnd: { readonly type: string; readonly data: unknown; readonly options: readonly unknown[] } | undefined
let releaseHeldTurnEnd: (() => unknown) | undefined
let turnEndSession: { append(type: string, data: unknown, ...options: unknown[]): unknown } | undefined
let restoreSessionAppend: () => void = () => {}
let releaseModelStream!: () => void
const modelStreamGate = new Promise<void>(resolve => { releaseModelStream = resolve })
let released = false
const release = (): void => {
  if (released) return
  released = true
  releaseModelStream()
  note({ kind: 'subject.stream.released' })
}
const onReleaseFileChange = (): void => {
  if (!existsSync(releasePath)) return
  const request = JSON.parse(readFileSync(releasePath, 'utf8')) as { release?: boolean }
  if (request.release === true) release()
}
const onTurnEndReleaseFileChange = (): void => {
  if (!existsSync(turnEndReleasePath)) return
  const request = JSON.parse(readFileSync(turnEndReleasePath, 'utf8')) as { release?: boolean }
  if (request.release !== true) return
  if (releaseHeldTurnEnd === undefined || deferredTurnEnd === undefined || turnEndSession === undefined) {
    throw new Error('the Focus qualification cannot release an absent official turn/end event')
  }
  const release = releaseHeldTurnEnd
  deferredTurnEnd = undefined
  releaseHeldTurnEnd = undefined
  release()
  note({ kind: 'turn.end.released' })
}
watchFile(releasePath, { interval: 50 }, onReleaseFileChange)
watchFile(releaseToolAPath, { interval: 50 }, onReleaseToolAFileChange)
watchFile(releaseToolStepPath, { interval: 50 }, onReleaseToolStepFileChange)
watchFile(releaseToolArgumentsPath, { interval: 50 }, onReleaseToolArgumentsFileChange)
watchFile(turnEndReleasePath, { interval: 50 }, onTurnEndReleaseFileChange)

const observedRendererUrl = new URL('../src/tui/tsp/session.ts', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== observedRendererUrl) return result
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source ?? '')
    const hook = `

/* Focus-turn qualification one-to-one observation seam. */
const __focusNote = event => globalThis.__focusTurnNote?.(event)
const __focusMountOriginal = mountTspRenderer
mountTspRenderer = function (...args) {
  const sdkSession = args[0]
  const iteratorOriginal = sdkSession[Symbol.asyncIterator]
  sdkSession[Symbol.asyncIterator] = function () {
    const inner = iteratorOriginal.call(sdkSession)
    return {
      async next() {
        const step = await inner.next()
        if (!step.done && step.value?.type === 'event' && step.value.event?.ev === 'toggle') {
          const event = step.value.event
          __focusNote({ kind: 'client.toggle', sf: event.sf, id: event.id, collapsed: event.collapsed })
        }
        return step
      },
      return(value) { return inner.return ? inner.return(value) : { done: true, value } },
      throw(error) { return inner.throw ? inner.throw(error) : Promise.reject(error) },
      [Symbol.asyncIterator]() { return this },
    }
  }
  const renderer = __focusMountOriginal.apply(this, args)
  const bindStatusReaderOriginal = renderer.bindStatusReader
  let statusReader
  renderer.bindStatusReader = function (reader) {
    const result = bindStatusReaderOriginal.call(this, reader)
    statusReader = reader
    return result
  }
  const displayCommitOriginal = renderer.display.commitDisplaySubject
  renderer.display.commitDisplaySubject = function (...commitArgs) {
    const result = displayCommitOriginal.apply(this, commitArgs)
    const status = statusReader?.snapshot()
    if (status !== undefined) {
      __focusNote({
        kind: 'status.commit',
        phase: status.activity.phase,
        busy: status.activity.busy,
      })
    }
    return result
  }
  const commitOriginal = renderer.display.setTranscript
  renderer.display.setTranscript = function (...commitArgs) {
    const result = commitOriginal.apply(this, commitArgs)
    const messages = Array.isArray(commitArgs[0]) ? commitArgs[0] : []
    const activities = commitArgs[1]
    const final = messages.find(message => message?.kind === 'assistant'
      && String(message.text ?? '').includes(globalThis.__focusTurnFinalMarker))
    __focusNote({
      kind: 'display.commit',
      messageKinds: messages.map(message => message?.kind),
      userTexts: messages.filter(message => message?.kind === 'user').map(message => String(message.text ?? '')),
      completedTurns: activities instanceof Map
        ? [...activities.values()].filter(activity => activity.completed).map(activity => activity.turn)
        : [],
      finalPresent: final !== undefined,
    })
    return result
  }
  globalThis.__focusTurnRenderer = renderer
  __focusNote({ kind: 'renderer.mounted' })
  return renderer
}
`
    return { ...result, source: source + hook }
  },
})

type FocusGlobals = {
  __focusTurnNote?: (value: Record<string, unknown>) => void
  __focusTurnFinalMarker: string
  __focusTurnRenderer?: { display: { setTranscript(...args: unknown[]): void } }
}
const focusGlobals = globalThis as unknown as FocusGlobals
focusGlobals.__focusTurnNote = note
focusGlobals.__focusTurnFinalMarker = finalMarker

const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')
let setupCleanup: (() => unknown) | undefined
const lifecycle: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir: prefix => { throw new Error(`the Focus Tern subject requires explicit workRoot, got ${prefix}`) },
  defer: cleanup => { setupCleanup = cleanup },
}
let fixture: Awaited<ReturnType<typeof createDirectTspFixture>> | undefined
let detachRecorder: () => void = () => {}
let restoreImageReader: () => void = () => {}
let disposeImageTool: (() => void) | undefined
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => { resolveExit = resolve })
let promptsSeen = 0

process.once('SIGTERM', () => setImmediate(resolveExit))
process.once('SIGINT', () => setImmediate(resolveExit))

const awaitRenderer = async (): Promise<boolean> => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((globalThis as unknown as FocusGlobals).__focusTurnRenderer !== undefined) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

try {
  note({
    kind: 'subject.ready',
    readyMarker: 'event ledger entry; the Direct transcript itself is not decorated with test text',
    session: SESSION_ID,
    workRoot,
    promptsPath,
    releasePath,
    productionPath: 'createDirectTspFixture(externalTern) -> configured Runner -> Direct Agent/SessionWriter -> SurfaceRuntime -> TSP SDK',
  })
  const scriptedToolCall = scenarioName === 'image'
    ? { callId: 'focus-real-image-call', name: 'focus_read_image', arguments: '{}' }
    : scenarioName === 'question'
      ? {
          callId: 'focus-real-question-call',
          name: 'ask_user_question',
          arguments: JSON.stringify({ questions: [{
            id: 'focus-question',
            header: 'Confirm',
            question: 'Continue after the Focus turn?',
            options: [{ label: 'Continue' }, { label: 'Stop' }],
            multi_select: false,
          }] }),
        }
      : undefined
  fixture = await createDirectTspFixture(lifecycle, {
    externalTern: true,
    workRoot,
    startup: { sessionId: SESSION_ID },
    tuiConfig: { displayPreset: 'focus', ...(scenarioName === 'svg' ? { busyEnter: 'steer' } : {}) },
    deltas: scenarioName === 'svg'
      ? [
          'The official Tool-A-to-SVG sequence completed. ',
          ...Array.from({ length: 14 }, (_, index) =>
            `Detail ${index + 1}: the final response follows the accepted steer and the SVG inspection.\n\n`),
          finalMarker,
        ]
      : [`${scenarioName.toUpperCase()}-`, 'DIRECT-', 'FINAL'],
    ...(scenarioName === 'svg' ? {
      scriptedToolCalls: [
        {
          text: 'Running the first operation before the SVG check.',
          toolCall: {
            callId: 'focus-real-work-a',
            name: 'focus_qualification_a',
            arguments: '{}',
          },
        },
        {
          text: 'The first result is ready; checking the second figure.',
          toolCall: {
            callId: 'focus-real-svg-b',
            name: 'dsh_pi_tui_svg',
            arguments: JSON.stringify({
              title: 'Focus Evidence B',
              description: 'The second canonical Work SVG',
              svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#20a070"/></svg>',
            }),
          },
        },
      ],
    } : {}),
    ...(scenarioName === 'svg' ? {
      holdScriptedToolCallArguments: async (stepIndex, signal) => {
        if (stepIndex !== 1) return
        note({ kind: 'subject.tool-arguments.held', callId: 'focus-real-svg-b' })
        signal?.throwIfAborted()
        if (signal === undefined) {
          await heldToolArguments
          return
        }
        let onAbort!: () => void
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('the scripted Tool arguments were aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        try {
          await Promise.race([heldToolArguments, aborted])
          signal.throwIfAborted()
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
      holdScriptedToolStep: async (stepIndex, signal) => {
        if (stepIndex !== 1) return
        note({ kind: 'subject.model-step.held', stepIndex })
        signal?.throwIfAborted()
        if (signal === undefined) {
          await heldToolStep
          return
        }
        let onAbort!: () => void
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('the scripted model step was aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        try {
          await Promise.race([heldToolStep, aborted])
          signal.throwIfAborted()
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
    } : {}),
    streamHold: async () => {
      note({ kind: 'model.stream.held' })
      await modelStreamGate
    },
    scriptedToolCall,
    ...(scenarioName === 'question' ? { officialServices: { askUserTool: true } } : {}),
    appExit: () => {
      note({ kind: 'app.exit' })
      resolveExit()
    },
  })
  if (scenarioName === 'svg') {
    fixture.ctx.tools.register(defineTool({
      name: 'focus_qualification_a',
      description: 'Hold a registered fixture operation before the next Agent request.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'First qualification operation completed.' }],
      },
      async execute(_args, exec) {
        note({ kind: 'subject.tool-a.started' })
        exec.signal.throwIfAborted()
        let onAbort!: () => void
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(exec.signal.reason ?? new Error('the qualification Tool A was aborted'))
          exec.signal.addEventListener('abort', onAbort, { once: true })
          if (exec.signal.aborted) onAbort()
        })
        try {
          await Promise.race([heldToolA, aborted])
          exec.signal.throwIfAborted()
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
          if (!heldToolAReleased) {
            heldToolAReleased = true
            releaseHeldToolA()
          }
        }
        note({ kind: 'subject.tool-a.completed' })
        return { ok: true }
      },
    }))
    note({ kind: 'fixture.tool-a-registered', tool: 'focus_qualification_a', authority: 'official Tools registry and real Agent execution' })
  }
  if (scenarioName === 'question') {
    const sessionPrototype = Session.prototype as unknown as {
      append(this: { readonly id: unknown }, type: string, data: unknown, ...options: unknown[]): unknown
    }
    const originalAppend = sessionPrototype.append
    sessionPrototype.append = function patched(this: { readonly id: unknown }, type, data, ...options) {
      if (type !== 'turn/end') return originalAppend.call(this, type, data, ...options)
      if (deferredTurnEnd !== undefined) throw new Error('the Focus qualification already holds an official turn/end event')
      turnEndSession = this
      deferredTurnEnd = { type, data, options }
      releaseHeldTurnEnd = () => originalAppend.call(this, type, data, ...options)
      note({ kind: 'turn.end.deferred', session: String(this.id), data })
      return undefined
    }
    restoreSessionAppend = () => { sessionPrototype.append = originalAppend }
  }
  if (scenarioName === 'svg') {
    const { apply: applyVisualTools } = await import('../src/app/host/visual-tools.ts')
    applyVisualTools(fixture.ctx, { enabled: { get: () => true } } as never)
    note({ kind: 'fixture.visual-tool-registered', tool: 'dsh_pi_tui_svg', calls: ['focus-real-svg-b'], authority: 'official Host visual-tools implementation' })
  }
  if (scenarioName === 'image') {
    const attachments = fixture.ctx.get('attachments') as unknown as {
      saveImage(input: { readonly data: Uint8Array; readonly mediaType: 'image/png'; readonly name: string }): Promise<{
        readonly attachmentId: string
        readonly mediaType: 'image/png'
        readonly bytes: number
        readonly width: number
        readonly height: number
        readonly name?: string
      }>
      readImage(ref: { readonly attachmentId: string }, signal?: AbortSignal): Promise<unknown>
    }
    const originalReadImage = attachments.readImage
    attachments.readImage = function patched(this: unknown, ref: { readonly attachmentId: string }, signal?: AbortSignal) {
      note({ kind: 'attachment.read', attachmentId: ref.attachmentId })
      return originalReadImage.call(this, ref, signal)
    }
    restoreImageReader = () => { attachments.readImage = originalReadImage }
    const imageBytes = new Uint8Array(readFileSync(new URL('../test/fixtures/images/transcript-sample.png', import.meta.url)))
    disposeImageTool = fixture.ctx.tools.register(defineTool({
      name: 'focus_read_image',
      description: 'Return the qualification PNG as a durable image result.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachment: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', enum: ['image/png'], required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
        },
        render: (_args, value) => {
          const attachment = (value as unknown as { readonly attachment: Record<string, unknown> }).attachment
          return [
            { type: 'text', text: 'Raster image ready.' },
            { type: 'image', attachment },
          ] as never
        },
      },
      async execute() {
        const attachment = await attachments.saveImage({ data: imageBytes, mediaType: 'image/png', name: 'focus-evidence.png' })
        note({ kind: 'attachment.saved', attachmentId: attachment.attachmentId, bytes: attachment.bytes })
        return { attachment }
      },
    }))
    note({ kind: 'fixture.image-tool-registered', tool: 'focus_read_image', authority: 'real Host AttachmentStore and registered Tool' })
  }
  const recorder = fixture.recordPrompts(call => {
    promptsSeen += 1
    note({ kind: 'writer.settled', count: promptsSeen, outcome: call.outcome.kind, mode: call.mode })
  })
  detachRecorder = recorder.detach
  const rendererObserved = await awaitRenderer()
  note({
    kind: 'fixture.ready',
    rendererObserved,
    modeAuthority: 'tuiConfig.displayPreset=focus -> real Runner DisplayState -> production TSP mount',
    input: 'CONTROL_INJECTED_INPUT through the pinned Tern client; no OS input claim',
  })
  console.log('focus-turn subject ready')
  await exitRequested
} finally {
  unwatchFile(releasePath, onReleaseFileChange)
  unwatchFile(releaseToolAPath, onReleaseToolAFileChange)
  unwatchFile(releaseToolStepPath, onReleaseToolStepFileChange)
  unwatchFile(releaseToolArgumentsPath, onReleaseToolArgumentsFileChange)
  unwatchFile(turnEndReleasePath, onTurnEndReleaseFileChange)
  if (!heldToolArgumentsReleased) {
    heldToolArgumentsReleased = true
    releaseHeldToolArguments()
  }
  if (!heldToolStepReleased) {
    heldToolStepReleased = true
    releaseHeldToolStep()
  }
  release()
  detachRecorder()
  restoreSessionAppend()
  restoreImageReader()
  disposeImageTool?.()
  await setupCleanup?.()
  if (fixture !== undefined) note({ kind: 'fixture.settled', promptsSeen })
  note({ kind: 'subject.final', promptsSeen })
}
