/**
 * TSP canonical Full/Compact/Focus transcript qualification SUBJECT.
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
 * Focus visibility follows the official Focus projection; a qualification flow
 * expands its native Thought roots before reading a nested Workflow row.
 *
 * Usage: `TERN_PANE_TRANSCRIPT_MODE=full|compact` through
 * `scripts/tern-pane-drive.mjs scripts/tern-pane-transcript-modes.mjs`.
 * @module scripts/tern-pane-transcript-modes-subject
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
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
if (scenario !== 'modes' && scenario !== 'inner-disclosure' && scenario !== 'ptc-error-note' && scenario !== 'card-disclosure' && scenario !== 'workflow-disclosure') {
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

const ptcFailureSessionId = 'inner-ptc-note-session'
const ptcFailureOutput = `PTC_BUILD_OUTPUT_${'x'.repeat(260)}`
const ptcFailureCommand = 'false'
const ptcFailureProgram = `await tools.bash({command:'false',description:'run'});return 1`
const ptcFailureStep = {
  text: '',
  toolCall: {
    callId: 'call-inner-ptc-failure',
    name: 'run_code',
    arguments: JSON.stringify({ code: ptcFailureProgram, description: 'Qualify PTC note' }),
  },
}
const ptcFailureRuntime = {
  language: 'typescript',
  isolation: 'controlled-shell-binding',
  resolve: (request: Record<string, unknown>) => ({
    ...request, cwd: typeof request.cwd === 'string' ? request.cwd : process.cwd(),
    timeoutMs: typeof request.timeoutMs === 'number' ? request.timeoutMs : 10_000,
  }),
  run: async (spec: { readonly program: string; readonly bindings: readonly { global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }[] }) => {
    if (!spec.program.includes('tools.bash')) throw new Error('the scripted PTC program does not call the official bash binding')
    const tools = spec.bindings.find(binding => binding.global === 'tools')
    const callBash = tools?.functions['bash']
    if (callBash === undefined) throw new Error('the official PTC bindings omit tools.bash')
    if (!spec.program.includes('return 1')) {
      throw new Error('the scripted PTC program does not return a concise parent result')
    }
    await callBash({ command: ptcFailureCommand, description: 'run' })
    return { logs: [], value: 1 }
  },
}

const PROMPT = scenario === 'ptc-error-note'
  ? 'PTC-NOTE'
  : scenario === 'inner-disclosure'
    ? `INNER-${mode.toUpperCase()} Inspect the live reasoning, tool details and context disclosures.`
    : scenario === 'card-disclosure'
      ? `CARD-${mode.toUpperCase()} Inspect the native command, compaction, tool and context cards.`
      : scenario === 'workflow-disclosure'
        ? `WORKFLOW-${mode.toUpperCase()} Inspect the native Workflow run and phase disclosure.`
        : 'MODES-01 Please list the background jobs and then answer with one short plain note '
          + 'about the canonical transcript reading flow, mixing English with 中文混排 so the real client wraps it.'
writeFileSync(promptsPath, `${JSON.stringify({
  mode,
  scenario,
  assistantMarker: scenario === 'ptc-error-note' ? `PTC-NOTE-${mode.toUpperCase()}-ANSWER`
    : scenario === 'inner-disclosure' ? `INNER-${mode.toUpperCase()}-ANSWER`
      : scenario === 'card-disclosure' ? `CARD-${mode.toUpperCase()}-ANSWER`
        : scenario === 'workflow-disclosure' ? `WORKFLOW-${mode.toUpperCase()}-ANSWER` : 'MODES-DIRECT-ANSWER',
  toolName: scenario === 'ptc-error-note' ? 'run_code' : 'job_list',
  prompts: [{ ordinal: 1, marker: scenario === 'ptc-error-note' ? `PTC-NOTE-${mode.toUpperCase()}`
    : scenario === 'inner-disclosure' ? `INNER-${mode.toUpperCase()}`
      : scenario === 'card-disclosure' ? `CARD-${mode.toUpperCase()}`
        : scenario === 'workflow-disclosure' ? `WORKFLOW-${mode.toUpperCase()}` : 'MODES-01', text: PROMPT }],
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
          } else if (event.ev === 'action') {
            const fields = { kind: 'client.action', id: event.id, act: event.act }
            if (event.sf !== undefined) fields.sf = event.sf
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

/** The T3-0B card-disclosure scenario's Test-only SessionEvent composer.
 *  Every row is a REAL official SessionEvent appended through the live Direct
 *  Session writer and read back through the production TranscriptFolder; the
 *  composer never renders a node, fabricates a fold row or bypasses the
 *  renderer's input iterator. */
interface CardEventSession {
  append(type: string, data: Record<string, unknown>, intent?: Record<string, unknown>): unknown
}

const CARD_LATE_COMMAND = 'cmd-card-late'

const cardTool = (
  session: CardEventSession,
  callId: string,
  name: string,
  args: string,
  text: string,
  isError = false,
): void => {
  session.append('tool/call', { turn: 2, step: 0, callId: ToolCallId(callId), name, arguments: args })
  session.append('tool/result', {
    turn: 2,
    step: 0,
    message: {
      id: MessageId(`card-result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: text === '' ? [] : [{ type: 'text', text }],
      ...(isError ? { isError: true, error: { name: 'ToolError', code: 'E_CARD' } } : {}),
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, { surfaceOp: 'append' })
}

const cardContext = (
  session: CardEventSession,
  id: string,
  text: string,
  source: Record<string, unknown>,
): void => {
  session.append('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, { surfaceOp: 'append' })
}

const appendCardDisclosure = (): void => {
  if (fixture === undefined || mainSessionId === undefined) {
    throw new Error('the production Direct writer has not selected the main Session')
  }
  const agent = fixture.ctx.agents.get(mainSessionId as never) as { session: unknown } | undefined
  if (agent === undefined) throw new Error('the Direct Session agent is not available')
  const session = agent.session as CardEventSession
  // Command lifecycle: one settled success, one running row that a later case
  // settles as an error, and one done-only fragment.
  session.append('command/run', {
    commandId: CommandId('cmd-card-ok'), name: 'status', args: ' --short', source: { kind: 'user' },
  })
  session.append('command/done', {
    commandId: CommandId('cmd-card-ok'), kind: 'success',
    text: 'session healthy: one live Direct session\nsecond result line\n中文输出仍然可读',
  })
  session.append('command/run', {
    commandId: CommandId(CARD_LATE_COMMAND), name: 'deploy', args: ' production', source: { kind: 'user' },
  })
  session.append('command/done', {
    commandId: CommandId('cmd-card-fragment'), kind: 'success', text: 'fragment-only result',
  })
  // Compaction lifecycle: success with counts, a plain failure and the ONE
  // fused manual-compaction owner (failure with an empty command text).
  session.append('compaction/start', { compactionId: 'cpt-card-ok', turn: null })
  session.append('compaction/summary', {
    compactionId: 'cpt-card-ok',
    summary: [{ type: 'text', text: 'Compaction summary body\nsecond summary line' }],
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 42,
  })
  session.append('compaction/end', { compactionId: 'cpt-card-ok' })
  session.append('compaction/start', { compactionId: 'cpt-card-error', turn: null })
  session.append('compaction/end', {
    compactionId: 'cpt-card-error', error: 'summarizer failed: upstream timeout after 120s',
  })
  session.append('command/run', {
    commandId: CommandId('cmd-card-manual'), name: 'compact', source: { kind: 'user' },
  })
  session.append('compaction/start', {
    compactionId: 'cpt-card-manual', sourceCommandId: CommandId('cmd-card-manual'), turn: null,
  })
  session.append('compaction/summary', {
    compactionId: 'cpt-card-manual',
    sourceCommandId: CommandId('cmd-card-manual'),
    summary: [{ type: 'text', text: 'manual compaction summary body' }],
    shadowedSeqs: [4],
    shadowedTokenCount: 9,
  })
  session.append('compaction/end', { compactionId: 'cpt-card-manual' })
  session.append('command/done', {
    commandId: CommandId('cmd-card-manual'), kind: 'error', text: '',
  })
  // One synthetic but official tool/context turn: the Fold sees real
  // tool/call + tool/result pairs and real injected user/message sources.
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 0 })
  cardTool(session, 'card-read', 'read', '{"file_path":"src/example.ts"}',
    '<path>src/example.ts</path>\n<type>file</type>\n<content>\n1: first line\n2: second line\n(End of file - total 2 lines)\n</content>')
  cardTool(session, 'card-write', 'write', '{"file_path":"src/example.ts"}',
    '<path>src/example.ts</path> <type>file</type> <content>Updated file</content>')
  cardTool(session, 'card-skill', 'skill', '{"name":"alpha"}',
    '<skill_content name="alpha"><skill_resources></skill_resources><skill_instructions>\nfirst instruction\nsecond instruction\n</skill_instructions></skill_content>')
  cardTool(session, 'card-image', 'read_image', '{"path":"shot.png"}',
    '<path>shot.png</path> <type>image</type> <content>\nPNG image, 800x600 px, 1234 bytes\n</content>')
  cardTool(session, 'card-goal', 'update_goal', '{"status":"active"}',
    '{"goal":{"phase":"active","revision":3,"roundsStarted":2,"maxGoalRounds":6}}')
  cardTool(session, 'card-ask', 'ask_user_question', '{"questions":[]}',
    '{"answers":[{"id":"q1","selected":["yes"]},{"id":"q2"}]}')
  cardTool(session, 'card-schedule', 'schedule_list', '{}',
    '{"items":[],"shown":0,"total":0,"limit":10,"offset":0}')
  cardTool(session, 'card-visual', 'present_visual', '{"files":[]}',
    `Published 1 visual.\nvisual-published-v1:{"version":1,"published":[{"ref":"sv2_${'a'.repeat(20)}"}]}`)
  cardTool(session, 'card-bash', 'bash', '{"command":"qualify terminal output"}',
    '\u001b[31mline one\u001b[0m\rprogress 10%\rprogress 100%\nsecond output line')
  cardTool(session, 'card-json', 'mystery_tool', '{}', '{"machine":"receipt"}')
  cardTool(session, 'card-text', 'mystery_tool', '{}', 'human summary line\nmore detail')
  cardTool(session, 'card-error', 'read', '{"file_path":"missing.ts"}',
    'ENOENT: no such file or directory', true)
  session.append('step/end', { turn: 2, step: 0 })
  cardContext(session, 'card-notice', 'notice full payload detail', {
    kind: 'subagent-settled', form: 'notice',
    summary: `Agent completed\n第二行摘要 ${'很长'.repeat(20)}`,
  })
  cardContext(session, 'card-recall', 'recalled transcript details', {
    kind: 'session-reference', form: 'recall', references: [{ label: 'prior session' }],
  })
  cardContext(session, 'card-relay-short', 'relayed short body', {
    kind: 'agent-message', form: 'relay', senderSessionId: 'agent-short',
  })
  cardContext(session, 'card-relay-long',
    Array.from({ length: 12 }, (_, index) => `relay line ${index + 1}`).join('\n'), {
      kind: 'agent-message', form: 'relay', senderSessionId: 'agent-long',
    })
  cardContext(session, 'card-unknown', 'unknown context stays readable', {
    kind: 'future-producer', form: 'future-context',
  })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

const appendWorkflowDisclosure = (): void => {
  if (fixture === undefined || mainSessionId === undefined) {
    throw new Error('the production Direct writer has not selected the main Session')
  }
  const agent = fixture.ctx.agents.get(mainSessionId as never) as { session: CardEventSession } | undefined
  if (agent === undefined) throw new Error('the Direct Session agent is not available')
  const session = agent.session as CardEventSession
  const workflowAgent = (
    runId: string,
    seq: number,
    label: string,
    phase?: string | null,
    outcome?: 'completed' | 'failed' | 'cancelled',
  ): void => {
    session.append('tool-workflow/agent-start', {
      runId,
      seq,
      label,
      ...(phase === undefined ? {} : { phase }),
      childId: `wf-child-${runId}-${seq}`,
    })
    if (outcome !== undefined) session.append('tool-workflow/agent-end', { runId, seq, outcome })
  }
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 0 })
  // Run A: four phase identities, 10 initial members. Prepare starts at the
  // inline floor (5) and is grown to 6 by the late `workflow-grow` case, so the
  // real client observes the 5→6 inline→summary switch. One failed member keeps
  // the run abnormal while it is still running; null/empty/named phases coexist.
  session.append('tool-workflow/run-start', { runId: 'wf-run-a', name: 'deploy-backend' })
  workflowAgent('wf-run-a', 1, 'build-1', 'Prepare', 'completed')
  workflowAgent('wf-run-a', 2, 'build-2', 'Prepare', 'failed')
  workflowAgent('wf-run-a', 3, 'verify-1', 'Prepare')
  workflowAgent('wf-run-a', 4, 'build-3', 'Prepare', 'completed')
  workflowAgent('wf-run-a', 5, 'build-4', 'Prepare', 'completed')
  workflowAgent('wf-run-a', 6, 'node-east', 'Rollout', 'cancelled')
  workflowAgent('wf-run-a', 7, 'node-west', 'Rollout')
  workflowAgent('wf-run-a', 8, 'node-south', 'Rollout')
  workflowAgent('wf-run-a', 9, 'unassigned-1')
  workflowAgent('wf-run-a', 10, 'empty-1', '')
  // Run B: a cold-replayed settled clean run (default closed, no fake edge).
  session.append('tool-workflow/run-start', { runId: 'wf-run-b', name: 'audit-done' })
  workflowAgent('wf-run-b', 1, 'checker-1', 'Review', 'completed')
  session.append('tool-workflow/run-end', { runId: 'wf-run-b', stopReason: 'completed' })
  // Run C: 100 members in ONE phase — the real client must stay bounded to
  // counts + the first three abnormal rows + the hidden count + one button.
  session.append('tool-workflow/run-start', { runId: 'wf-run-c', name: 'bulk-100' })
  for (let seq = 1; seq <= 90; seq += 1) workflowAgent('wf-run-c', seq, `bulk-done-${seq}`, 'Migration', 'completed')
  for (let seq = 91; seq <= 95; seq += 1) workflowAgent('wf-run-c', seq, `bulk-run-${seq}`, 'Migration')
  for (let seq = 96; seq <= 99; seq += 1) workflowAgent('wf-run-c', seq, `bulk-fail-${seq}`, 'Migration', 'failed')
  workflowAgent('wf-run-c', 100, 'bulk-cancel-100', 'Migration', 'cancelled')
  session.append('step/end', { turn: 2, step: 0 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

/** Same-source late official update: grow Prepare from 5 to 6 members so the
 *  real client must switch that Phase to summary mode. */
const growWorkflowPhase = (): void => {
  if (fixture === undefined || mainSessionId === undefined) {
    throw new Error('the production Direct writer has not selected the main Session')
  }
  const agent = fixture.ctx.agents.get(mainSessionId as never) as { session: CardEventSession } | undefined
  if (agent === undefined) throw new Error('the Direct Session agent is not available')
  agent.session.append('tool-workflow/agent-start', {
    runId: 'wf-run-a', seq: 11, label: 'build-5', phase: 'Prepare', childId: 'wf-child-wf-run-a-11',
  })
}

/** Settle every remaining Run A member and close the run (still abnormal, so
 *  the completed run stays open with its real status word). */
const settleWorkflowRun = (): void => {
  if (fixture === undefined || mainSessionId === undefined) {
    throw new Error('the production Direct writer has not selected the main Session')
  }
  const agent = fixture.ctx.agents.get(mainSessionId as never) as { session: CardEventSession } | undefined
  if (agent === undefined) throw new Error('the Direct Session agent is not available')
  const session = agent.session as CardEventSession
  for (const seq of [3, 7, 8, 9, 10, 11]) {
    session.append('tool-workflow/agent-end', { runId: 'wf-run-a', seq, outcome: 'completed' })
  }
  session.append('tool-workflow/run-end', { runId: 'wf-run-a', stopReason: 'completed' })
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
        // The FIRST payload is deliberately long: the member body must wrap and
        // stay reachable through the client's own scroll without moving the Dock.
        const body = index === 0
          ? `${text}\n${'continuous context detail '.repeat(24).trim()}`
          : text
        agent.session.append('user/message', {
          id: MessageId(`inner-context-${mode}-${index}`),
          role: 'user',
          content: [{ type: 'text', text: body }],
          source: { kind: 'plugin', form: 'snapshot', plugin: `inner-context-${index}` },
        }, { surfaceOp: 'append' })
      }
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'observe-ptc-failure') {
      if (mainSessionId === undefined) throw new Error('no production Direct writer has selected the main Session')
      const agent = fixture.ctx.agents.get(mainSessionId as never)
      if (agent === undefined) throw new Error('the Direct Session agent is not available')
      const sessionEvents = agent.session.snapshotEvents() as Array<{ type: string; data?: Record<string, unknown> }>
      const rootCall = sessionEvents.find(event => event.type === 'tool/call' && event.data?.name === 'run_code')
      const rootCallId = rootCall?.data?.callId
      const childStart = sessionEvents.find(event => event.type === 'tool/ptc-dispatch-start'
        && String(event.data?.rootCallId) === String(rootCallId) && event.data?.name === 'bash')
      const childId = childStart?.data?.subCallId
      const childSettle = sessionEvents.find(event => event.type === 'tool/ptc-dispatch'
        && String(event.data?.subCallId) === String(childId))
      const result = childSettle?.data?.content
      const output = Array.isArray(result)
        ? result.filter((block): block is { type: string; text: string } => typeof block === 'object'
          && block !== null && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string')
          .map(block => block.text).join('')
        : ''
      const parentResult = sessionEvents.find(event => event.type === 'tool/result'
        && String((event.data?.message as { toolCallId?: unknown } | undefined)?.toolCallId) === String(rootCallId))
      const parentContent = (parentResult?.data?.message as { content?: unknown } | undefined)?.content
      const parentOutput = Array.isArray(parentContent)
        ? parentContent.filter((block): block is { type: string; text: string } => typeof block === 'object'
          && block !== null && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string')
          .map(block => block.text).join('')
        : ''
      const status = rootCall !== undefined && childStart !== undefined && childSettle !== undefined
        && childSettle.data?.isError === false && output.endsWith('\n[exit code: 2]')
        && parentResult !== undefined && !parentOutput.includes('PTC_BUILD_OUTPUT_') && parentOutput.length < 256
        ? 'ok' : 'error'
      const facts = { rootCall: rootCall?.data ?? null, childStart: childStart?.data ?? null,
        childSettle: childSettle?.data ?? null, output, parentOutput, parentResult: parentResult?.data ?? null }
      const payload = { seq, command: kind, status, facts }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'card-disclosure') {
      appendCardDisclosure()
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'workflow-disclosure') {
      appendWorkflowDisclosure()
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'workflow-grow') {
      growWorkflowPhase()
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'workflow-late-settle') {
      if (fixture === undefined || mainSessionId === undefined) {
        throw new Error('the production Direct writer has not selected the main Session')
      }
      settleWorkflowRun()
      const payload = { seq, command: kind, status: 'ok' }
      writeFileSync(`${caseResultPath}.tmp`, `${JSON.stringify(payload)}\n`)
      renameSync(`${caseResultPath}.tmp`, caseResultPath)
      note({ kind: 'case.finished', ...payload })
      return
    }
    if (kind === 'late-command-error') {
      if (fixture === undefined || mainSessionId === undefined) {
        throw new Error('the production Direct writer has not selected the main Session')
      }
      const agent = fixture.ctx.agents.get(mainSessionId as never) as { session: CardEventSession } | undefined
      if (agent === undefined) throw new Error('the Direct Session agent is not available')
      agent.session.append('command/done', {
        commandId: CommandId(CARD_LATE_COMMAND), kind: 'error',
        text: 'deployment failed: permission denied',
      })
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
    // The workflow scenario needs the real subagent task-read half, or the
    // scoped browse button must not paint at all.
    ...(scenario === 'workflow-disclosure'
      ? { workingDirectory: true, officialServices: { subagentRuntime: true } }
      : {}),
    ...(scenario === 'ptc-error-note' ? {
      ptcMode: { runtime: ptcFailureRuntime },
      startup: { sessionId: ptcFailureSessionId },
      persistedBlankSession: { id: ptcFailureSessionId },
    } : {}),
    // The ONE production mode authority: the real Runner volatile config that
    // `resolveDisplayPreset` reads. No renderer-local preset is set anywhere.
    tuiConfig: { displayPreset: mode },
    deltas: scenario === 'ptc-error-note' ? []
      : scenario === 'inner-disclosure' ? [`INNER-${mode.toUpperCase()}-`, 'ANSWER']
        : scenario === 'card-disclosure' ? [`CARD-${mode.toUpperCase()}-`, 'ANSWER']
          : scenario === 'workflow-disclosure' ? [`WORKFLOW-${mode.toUpperCase()}-`, 'ANSWER']
            : ['MODES-', 'DIRECT-', 'ANSWER'],
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
    } : scenario === 'ptc-error-note' ? {
      scriptedToolCalls: [ptcFailureStep],
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
  if (scenario === 'ptc-error-note') {
    fixture.ctx.provide('shell', {
      sandboxMode: undefined,
      resolve: (request: Record<string, unknown>) => ({
        ...request,
        workdir: request.workdir ?? workRoot,
        timeoutMs: request.timeoutMs ?? 10_000,
      }),
      execute: async (spec: { readonly timeoutMs: number }) => ({
        result: async () => ({
          exitCode: 2, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: ptcFailureOutput, truncated: false },
          stderr: { text: '', truncated: false },
        }),
      }),
    } as never)
    const shellEnv = await import('@deepseek-ai/dsh-shell-env')
    await fixture.ctx.plugin(shellEnv as never, { dshHome: workRoot } as never)
    const bash = await import('@deepseek-ai/dsh-tool-bash')
    await fixture.ctx.plugin(bash as never, { enableRunInBackground: false } as never)
    note({ kind: 'ptc-fixture.ready', sessionId: ptcFailureSessionId, runtime: 'controlled-shell-binding', shellExitCode: 2,
      stdoutLength: ptcFailureOutput.length })
  }
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
      ...(scenario === 'ptc-error-note' ? [
        'the test-owned PTC runtime invokes the official tools.bash binding; the shell provider returns deterministic stdout and exit code 2 (no real process is spawned)',
      ] : []),
      'the fixed prompt written to prompts.json (isolated deterministic test input)',
      'case.json reproject: TEST-ONLY re-commit of the SAME already-committed message objects',
      'GUI / PHYSICAL_OS / IME / wheel / OS clipboard: NOT_VERIFIED (tern ctl injects control input)',
      'Focus roots are expanded through their native heads before a nested Workflow row is read (official Focus visibility)',
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
