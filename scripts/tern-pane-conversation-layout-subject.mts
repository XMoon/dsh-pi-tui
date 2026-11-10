/**
 * Native conversation qualification subject. Only this subject imports the
 * production Direct fixture; every display row is an official Session event.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const root = process.env.TERN_PANE_DIR
if (root === undefined) throw new Error('TERN_PANE_DIR is required')
const config = JSON.parse(readFileSync(join(root, 'subject-config.json'), 'utf8')) as {
  readonly sourceRoot: string
  readonly preset: string
}
const repo = config.sourceRoot
const preset = config.preset
if (!['full', 'compact', 'focus'].includes(preset)) throw new Error(`unsupported DisplayPreset: ${preset}`)
const sourceModule = (relative: string): string => pathToFileURL(join(repo, relative)).href
const sessionId = 'native-conversation-fixture'
const eventsPath = join(root, 'subject-events.jsonl')
const sdkWirePath = join(root, 'sdk-wire.jsonl')
const payloadPath = join(root, 'copy-payloads.jsonl')
const commandPath = join(root, 'case.json')
const resultPath = join(root, 'case-result.json')
const workRoot = join(root, 'dsh-home')
const helperDir = join(root, 'bin')
mkdirSync(workRoot, { recursive: true })
mkdirSync(helperDir, { recursive: true })
process.env.DSH_HOME = workRoot
process.env.TERN_TSP_RECORD = sdkWirePath
process.env.TSP_COPY_CAPTURE = payloadPath
process.env.DISPLAY ??= ':0'
process.env.PATH = `${helperDir}:${process.env.PATH ?? ''}`
writeFileSync(join(helperDir, 'xclip'), [
  '#!/usr/bin/env node',
  'const { appendFileSync } = require("node:fs")',
  'const chunks = []',
  "process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))",
  "process.stdin.on('end', () => appendFileSync(process.env.TSP_COPY_CAPTURE, JSON.stringify({ payload: Buffer.concat(chunks).toString('utf8') }) + '\\n'))",
  '',
].join('\n'), { mode: 0o755 })

const note = value => appendFileSync(eventsPath, `${JSON.stringify(value)}\n`)
globalThis.__nativeConversationNote = note
const clientActionsUrl = sourceModule('src/app/surface/client-actions.ts')
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== clientActionsUrl) return result
    const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source ?? '')
    const recorder = `
const __nativeOriginalCreateClientActions = createClientActions
createClientActions = function (...args) {
  const actions = __nativeOriginalCreateClientActions.apply(this, args)
  const copySelection = actions.copySelection
  actions.copySelection = async function (text) {
    const copied = await copySelection.call(this, text)
    globalThis.__nativeConversationNote({ kind: 'client.copy.result', payload: text, copied })
    return copied
  }
  return actions
}
`
    return { ...result, source: source + recorder }
  },
})

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><rect width="64" height="32" fill="#3b82f6"/></svg>'
let fixture
let closed = false
let commandRunning = false
let handledCommandId
let resolveExit
const exitRequested = new Promise(resolve => { resolveExit = resolve })
const commandWatcher = watch(root, (_event, filename) => {
  if (filename === 'case.json' && existsSync(commandPath)) void runCommand()
})

const atomicJson = (path, value) => {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

async function sessionForFixture() {
  const { waitFor } = await import(sourceModule('test/support/direct-tsp-fixture.ts'))
  let session
  await waitFor('the production Direct Session', () => {
    session = fixture.ctx.sessions.get(SessionId(sessionId))
    return session !== undefined
  }, 30_000)
  return session
}

async function seed(session) {
  const { chartContentBlocks, chartFactFromArgs } = await import(sourceModule('src/domain/visual/chart.ts'))
  const { svgContentBlocks, svgFactFromArgs } = await import(sourceModule('src/domain/visual/svg.ts'))
  const { visualReference, visualReferenceLine } = await import(sourceModule('src/domain/visual/reference.ts'))
  const { MessageId, ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const sharpModule = await import('sharp')
  const imageBytes = new Uint8Array(await sharpModule.default({
    create: { width: 18, height: 12, channels: 3, background: '#ef4444' },
  }).png().toBuffer())
  const image = (await fixture.ctx.get('attachments').saveImages([{
    data: imageBytes, mediaType: 'image/png', name: 'synthetic.png',
  }]))[0]

  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    id: MessageId('conversation-user-no-usage'), role: 'user',
    content: [{ type: 'image', attachment: image }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 0 })
  session.append('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: MessageId('conversation-assistant-no-usage'), role: 'assistant',
      content: [{ type: 'text', text: 'TSP-NO-USAGE-FINAL This synthetic reply deliberately has no usage fact.' }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted-model' }, stream: [],
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 0 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  session.append('turn/start', { turn: 2 })
  session.append('user/message', {
    id: MessageId('conversation-user-error'), role: 'user',
    content: [{ type: 'text', text: 'TSP-ERROR-CASE Show the synthetic tool error.' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('step/start', { turn: 2, step: 0 })
  session.append('tool/call', { turn: 2, step: 0, callId: ToolCallId('native-conversation-error'), name: 'job_list', arguments: '{}' })
  session.append('tool/result', {
    turn: 2, step: 0,
    message: {
      id: MessageId('native-conversation-error-result'), role: 'tool', toolCallId: ToolCallId('native-conversation-error'),
      content: [{ type: 'text', text: 'Synthetic tool failure.' }], isError: true,
      source: { kind: 'tool', callId: 'native-conversation-error' },
    },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'fixture_error', message: 'Synthetic tool failure.' } } })

  const turn = 3
  const appendVisualSource = async (step, name, callId, args, blocks) => {
    session.append('step/start', { turn, step })
    const stepStart = session.snapshotEvents().findLast(entry =>
      entry.type === 'step/start' && entry.data.turn === turn && entry.data.step === step)
    if (stepStart === undefined) throw new Error(`step/start ${step} was not persisted`)
    const ref = visualReference({ turn, stepStartSeq: stepStart.seq, callId })
    session.append('tool/call', { turn, step, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) })
    session.append('tool/result', {
      turn, step,
      message: {
        id: MessageId(`result-${callId}`), role: 'tool', toolCallId: ToolCallId(callId),
        content: [blocks[0], { type: 'text', text: visualReferenceLine(ref) }, ...blocks.slice(1)],
        source: { kind: 'tool', callId: ToolCallId(callId) },
      },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })
    return ref
  }

  session.append('turn/start', { turn })
  session.append('user/message', {
    id: MessageId('conversation-user-mixed'), role: 'user',
    content: [
      { type: 'text', text: 'TSP-QUESTION-MIXED 检查这一段日志，保留 CJK 与代码：\n```ts\nconst ready = true\n```\n窄屏文本：这是一个用于验证原生消息气泡边界与换行的长中文句子。\nlongword_without_break_that_must_wrap_in_a_narrow_native_message_bubble\n' },
      { type: 'image', attachment: image },
      { type: 'text', text: '\n图像保持在原始 block 位置。' },
    ],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })

  const chartArgs = {
    kind: 'bars', title: 'Synthetic latency', unit: 'ms',
    series: [{ label: 'p50', value: 31 }, { label: 'p99', value: 86 }],
  }
  const chartRef = await appendVisualSource(
    0, 'dsh_pi_tui_chart', 'native-conversation-chart', chartArgs,
    chartContentBlocks(chartFactFromArgs(chartArgs)),
  )
  const svgArgs = { title: 'Synthetic topology', description: 'Gateway to database', svg: SVG_SOURCE }
  const svgRef = await appendVisualSource(
    1, 'dsh_pi_tui_svg', 'native-conversation-svg', svgArgs,
    svgContentBlocks(svgFactFromArgs(svgArgs)),
  )

  session.append('step/start', { turn, step: 2 })
  session.append('assistant/message', {
    turn, step: 2,
    message: {
      id: MessageId('conversation-assistant-visuals'), role: 'assistant',
      content: [{ type: 'text', text: `Intro paragraph.\n\n[dsh-visual-${chartRef}]: <#>\n\nTopology paragraph.\n\n[dsh-visual-${svgRef}]: <#>\n\nThe figures remain in source order.` }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted-model' }, stream: [],
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 2 })

  session.append('step/start', { turn, step: 3 })
  session.append('tool/call', {
    turn, step: 3, callId: ToolCallId('native-conversation-publish'), name: 'present_visual',
    arguments: JSON.stringify({ visuals: [{ ref: chartRef }, { ref: svgRef }] }),
  })
  session.append('tool/result', {
    turn, step: 3,
    message: {
      id: MessageId('native-conversation-publish-result'), role: 'tool',
      toolCallId: ToolCallId('native-conversation-publish'),
      content: [
        { type: 'text', text: 'Selected 2 visuals for presentation.' },
        { type: 'text', text: `visual-published-v1:${JSON.stringify({ version: 1, published: [{ ref: chartRef }, { ref: svgRef }] })}` },
      ],
      source: { kind: 'tool', callId: 'native-conversation-publish' },
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 3 })

  session.append('step/start', { turn, step: 4 })
  session.append('assistant/message', {
    turn, step: 4,
    usage: { inputTokens: 124, outputTokens: 86 },
    message: {
      id: MessageId('conversation-assistant-final'), role: 'assistant',
      content: [{ type: 'text', text: 'TSP-ANSWER-FINAL 最终建议：先处理 p99 上游延迟，再复核数据库连接。' }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted-model' }, stream: [],
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 4 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { chartRef, svgRef, pngBytes: imageBytes.byteLength }
}

async function runCommand() {
  if (commandRunning || !existsSync(commandPath)) return
  commandRunning = true
  try {
    const command = JSON.parse(readFileSync(commandPath, 'utf8'))
    if (command.id === handledCommandId) return
    handledCommandId = command.id
    if (command.kind !== 'seed') throw new Error(`unknown fixture command: ${String(command.kind)}`)
    const result = await seed(await sessionForFixture())
    note({ kind: 'fixture.seeded', preset, ...result })
    atomicJson(resultPath, { id: command.id, ok: true, ...result })
  } catch (error) {
    note({ kind: 'fixture.command.error', message: String(error), stack: error instanceof Error ? error.stack : undefined })
    atomicJson(resultPath, { id: JSON.parse(readFileSync(commandPath, 'utf8')).id, ok: false, message: String(error) })
  } finally {
    commandRunning = false
  }
}

try {
  fixture = await (await import(sourceModule('test/support/direct-tsp-fixture.ts'))).createDirectTspFixture({
    tempDir() { throw new Error('external Tern fixture must use TERN_PANE_DIR') },
    defer() {},
  }, {
    externalTern: true,
    startup: { sessionId },
    persistedBlankSessions: [{ id: sessionId }],
    nativeImages: true,
    nativeChart: true,
    tuiConfig: { displayPreset: preset },
    workRoot,
  })
  note({ kind: 'subject.ready', preset, version: process.versions.node })
  await exitRequested
} finally {
  if (!closed) {
    closed = true
    commandWatcher.close()
    await fixture?.settle()
  }
  note({ kind: 'subject.closed' })
}
