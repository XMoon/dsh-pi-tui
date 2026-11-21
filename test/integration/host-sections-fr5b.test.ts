/** FR5-B over the REAL official configuration plane: the `agent-loop`,
 * `bash-sandbox` and `session-log-deepseek` rows through
 * ConfigEditor/SettingsForms, their live plugins, and their real sinks.
 *
 * EVIDENCE
 * - Agent loop: the saved official section really feeds the live
 *   `ctx.agentLoop.config.maxParallelToolCalls` the next Agent step reads; two
 *   gated concurrency-safe tools prove 1 -> 2 parallel starts.
 * - Shell: the saved two-field mutation reaches the ACTIVE `bash-sandbox`
 *   executor's live refs, then a real command observes the timeout kill and the
 *   stdout cap.
 * - Session log: the saved official switch changes the real plugin's
 *   `dsh_session_log` contribution for the next prepared DeepSeek request.
 *
 * FIXTURE: a disposable real profile/bundle with exactly these rows; the model
 * endpoint is a recording stand-in, the session-log "transport" is the official
 * extension registry's prepare step (no network, no real account).
 * @module @xmoon76/dsh-pi-tui/test/integration/host-sections-fr5b
 */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensions from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { DeepSeekSessionLogExtension } from '@deepseek-ai/dsh-session-log-deepseek'
import {
  LlmAdapter,
  createUserMessage,
  ToolCallId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { mountHostSectionsPlane } from '../support/host-sections-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** One scripted model response sequence: a tool-call batch, then a text stop. */
class ScriptedAdapter extends LlmAdapter {
  private readonly queue: StreamChunk[][]

  constructor(queue: readonly (readonly StreamChunk[])[]) {
    super()
    this.queue = queue.map(chunks => [...chunks])
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'mock', name: 'Mock' }])
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    yield* (this.queue.shift() ?? [{ type: 'finish' as const, reason: { kind: 'stop' as const } }])
  }
}

function parallelBatch(ids: readonly string[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  ids.forEach((id, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name: 'gate', arguments: JSON.stringify({ id }) } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function textStop(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A concurrency-safe tool whose calls block until the test releases them. */
function gatedTool() {
  const gates = new Map<string, () => void>()
  const started: string[] = []
  const tool = defineContentToolFixture({
    name: 'gate',
    description: 'gated concurrency-safe tool',
    parameters: { id: { type: 'string', required: true } },
    isConcurrencySafe: () => true,
    async execute(args) {
      started.push(args.id)
      await new Promise<void>(resolve => { gates.set(args.id, resolve) })
      return [{ type: 'text', text: `done-${args.id}` }]
    },
  })
  return {
    tool,
    started,
    release(id: string) { gates.get(id)?.(); gates.delete(id) },
    pending() { return [...gates.keys()] },
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let step = 0; step < 2000 && !predicate(); step += 1) await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(predicate(), label)
}

function idle(ctx: Context, agent: unknown): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function boot(ctx: Context, workRoot: string, initial: Parameters<typeof mountHostSectionsPlane>[2] = {}) {
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(SandboxLocal)
  await ctx.plugin(SandboxPolicy)
  await ctx.plugin(DeepSeekLlmApiExtensions)
  await ctx.plugin(Loader)
  return mountHostSectionsPlane(ctx, workRoot, initial)
}

test('the saved Agent-loop section feeds the real next-step scheduler budget', async (t: TestContext) => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const plane = await boot(ctx, life.tempDir('host-sections-agent-loop-'), {
    agentLoop: { maxParallelToolCalls: 1 },
  })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const opened = port.agentLoopSettings.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.equal(opened.effective.maxParallelToolCalls, 1, 'the bundle config is the real base')

  const gated = gatedTool()
  ctx.tools.register(gated.tool)
  const adapter = new ScriptedAdapter([
    parallelBatch(['c1', 'c2']),
    textStop('first'),
    parallelBatch(['c3', 'c4']),
    textStop('second'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)

  const agent = await ctx.agentLoop.create(SessionId('fr5b-agent-loop') as never, { provider: 'mock', model: 'mock' })
  const firstIdle = idle(ctx, agent)
  ;(agent as unknown as { followup(message: unknown): void }).followup(
    createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
  )
  await until(() => gated.started.length === 1, 'the cap-1 step must start exactly one call')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(gated.started.length, 1, 'the second parallel-safe call must not start under cap 1')
  gated.release('c1')
  await until(() => gated.started.length === 2, 'the second call starts only after the first completes')
  gated.release('c2')
  await firstIdle

  // The REAL official Settings mutation: exact revision, then an authoritative
  // readback and the live volatile config.
  assert.deepEqual(await port.agentLoopSettings.mutate(
    { maxParallelToolCalls: { kind: 'set', value: 2 } }, opened.revision, opened.generation,
  ), { kind: 'accepted' })
  const saved = port.agentLoopSettings.read()
  assert.equal(saved.kind, 'ready')
  if (saved.kind !== 'ready') return
  assert.equal(saved.effective.maxParallelToolCalls, 2)
  assert.equal((plane.userConfig('agent-loop') as { maxParallelToolCalls?: number } | undefined)?.maxParallelToolCalls, 2,
    'the actual USER profile patch carries the new budget')
  assert.equal(ctx.agentLoop.config.maxParallelToolCalls.get(), 2, 'the live config the next step reads is updated')

  const secondIdle = idle(ctx, agent)
  ;(agent as unknown as { followup(message: unknown): void }).followup(
    createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }),
  )
  await until(() => gated.started.length === 4, 'the cap-2 step must start both parallel-safe calls')
  assert.deepEqual(gated.started.slice(2), ['c3', 'c4'], 'both calls really started before either completed')
  gated.release('c3')
  gated.release('c4')
  await secondIdle

  // Reset is the official field unset; the Host readback decides the value.
  const beforeReset = port.agentLoopSettings.read()
  assert.equal(beforeReset.kind, 'ready')
  if (beforeReset.kind !== 'ready') return
  assert.deepEqual(await port.agentLoopSettings.mutate(
    { maxParallelToolCalls: { kind: 'reset' } }, beforeReset.revision, beforeReset.generation,
  ), { kind: 'accepted' })
  const reset = port.agentLoopSettings.read()
  assert.equal(reset.kind, 'ready')
  if (reset.kind !== 'ready') return
  assert.equal(reset.effective.maxParallelToolCalls, 1, 'the readback is the official inherited bundle value')
  assert.equal(ctx.agentLoop.config.maxParallelToolCalls.get(), 1)
})

test('the saved Shell-execution caps reach the active executor and its next real command', async (t: TestContext) => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const plane = await boot(ctx, life.tempDir('host-sections-shell-'), {
    bashSandbox: { timeoutMs: 60_000 },
    user: { 'bash-sandbox': { timeoutMs: 70_000 } },
  })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const opened = port.shellExecutionSettings.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.deepEqual(opened.effective, { executor: 'bash', timeoutMs: 70_000, maxOutputBytes: 64_000 })
  const liveShell = (): { config: { timeoutMs: { get(): number }; maxOutputBytes: { get(): number } } } =>
    ctx.shell as unknown as { config: { timeoutMs: { get(): number }; maxOutputBytes: { get(): number } } }
  assert.equal(liveShell().config.timeoutMs.get(), 70_000, 'the real executor reads the USER override')

  // Timeout + output cap in ONE official mutation; the second field is a reset
  // candidate but here we SET both so the next command observes both.
  assert.deepEqual(await port.shellExecutionSettings.mutate({
    timeoutMs: { kind: 'set', value: 120 },
    maxOutputBytes: { kind: 'set', value: 64 },
  }, opened.revision, opened.generation, opened.effective.executor), { kind: 'accepted' })
  const saved = port.shellExecutionSettings.read()
  assert.equal(saved.kind, 'ready')
  if (saved.kind !== 'ready') return
  assert.deepEqual(saved.effective, { executor: 'bash', timeoutMs: 120, maxOutputBytes: 64 })
  assert.deepEqual(plane.userConfig('bash-sandbox'), { timeoutMs: 120, maxOutputBytes: 64 })
  assert.equal(liveShell().config.timeoutMs.get(), 120)
  assert.equal(liveShell().config.maxOutputBytes.get(), 64)

  const workdir = life.tempDir('host-sections-shell-run-')
  const timed = await ctx.shell.execute(ctx.shell.resolve({
    // reason: the command must outlive the 120ms configured timeout window.
    command: 'node -e "setTimeout(() => {}, 400)"',
    workdir,
  }))
  const timedResult = await timed.result()
  assert.equal(timedResult.timedOut, true, 'the next real command is killed by the configured timeout')
  assert.equal(timedResult.timeoutMs, 120)

  // Give the output-cap observation a normal startup budget; the timeout test
  // above already proved the configured 120ms deadline classification.
  const beforeCapRun = port.shellExecutionSettings.read()
  assert.equal(beforeCapRun.kind, 'ready')
  if (beforeCapRun.kind !== 'ready') return
  assert.deepEqual(await port.shellExecutionSettings.mutate(
    { timeoutMs: { kind: 'set', value: 5_000 } }, beforeCapRun.revision, beforeCapRun.generation, beforeCapRun.effective.executor,
  ), { kind: 'accepted' })
  const spilled = await ctx.shell.execute(ctx.shell.resolve({
    command: 'node -e "process.stdout.write(\'x\'.repeat(4096))"',
    workdir,
  }))
  const spillResult = await spilled.result()
  assert.equal(spillResult.timedOut, false)
  assert.equal(spillResult.stdout.truncated, true, 'the next real command is capped at 64 stdout bytes')
  assert.ok(spillResult.stdout.text.length <= 64)

  // Reset ONE cap; the sibling USER override stays effective and in the patch.
  const beforeReset = port.shellExecutionSettings.read()
  assert.equal(beforeReset.kind, 'ready')
  if (beforeReset.kind !== 'ready') return
  assert.deepEqual(await port.shellExecutionSettings.mutate({
    maxOutputBytes: { kind: 'reset' },
  }, beforeReset.revision, beforeReset.generation, beforeReset.effective.executor), { kind: 'accepted' })
  const reset = port.shellExecutionSettings.read()
  assert.equal(reset.kind, 'ready')
  if (reset.kind !== 'ready') return
  assert.equal(reset.effective.timeoutMs, 5_000, 'the sibling timeout override is preserved')
  assert.equal(reset.effective.maxOutputBytes, 64_000, 'the reset cap reads the inherited bundle value')
  // The official unset may materialize OR remove the USER key; the CURRENT
  // effective value is the authority. Only the sibling override must survive.
  assert.deepEqual(plane.userConfig('bash-sandbox'), { timeoutMs: 5_000 },
    'the reset cap leaves no stale USER override while the sibling timeout stays')
  assert.equal(liveShell().config.maxOutputBytes.get(), 64_000)
})

test('the saved Session-log switch changes the real plugin contribution for the next request', async (t: TestContext) => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const plane = await boot(ctx, life.tempDir('host-sections-session-log-'), { sessionLog: { enabled: true } })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const opened = port.sessionLogUpload.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.equal(opened.effective.enabled, true)

  const session = ctx.sessions.create(SessionId('fr5b-session-log') as never)
  session.append('user/message',
    createUserMessage({ content: [{ type: 'text', text: 'hello session log' }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
  const prepare = async () => ctx.deepseekLlmApiExtensions.prepare({
    body: { messages: [] }, signal: new AbortController().signal, sessionId: String(session.id),
  })
  const logField = (fields: Readonly<Partial<Record<string, unknown>>>): DeepSeekSessionLogExtension | undefined =>
    fields.dsh_session_log as DeepSeekSessionLogExtension | undefined
  const enabledRequest = await prepare()
  assert.ok(logField(enabledRequest.fields) !== undefined, 'the enabled plugin contributes the session log field')
  assert.ok((logField(enabledRequest.fields)?.events.length ?? 0) > 0)

  assert.deepEqual(await port.sessionLogUpload.mutate(
    { enabled: { kind: 'set', value: false } }, opened.revision, opened.generation,
  ), { kind: 'accepted' })
  const disabled = port.sessionLogUpload.read()
  assert.equal(disabled.kind, 'ready')
  if (disabled.kind !== 'ready') return
  assert.equal(disabled.effective.enabled, false, 'false is a real saved Host value')
  assert.equal((plane.userConfig('session-log-deepseek') as { enabled?: boolean } | undefined)?.enabled, false)
  const disabledRequest = await prepare()
  assert.equal(logField(disabledRequest.fields), undefined, 'the disabled plugin contributes nothing')

  // Reset is the official unset; the readback may be On again, and that IS the
  // current authority the next request follows.
  assert.deepEqual(await port.sessionLogUpload.mutate(
    { enabled: { kind: 'reset' } }, disabled.revision, disabled.generation,
  ), { kind: 'accepted' })
  const reset = port.sessionLogUpload.read()
  assert.equal(reset.kind, 'ready')
  if (reset.kind !== 'ready') return
  assert.equal(reset.effective.enabled, true, 'the official reset reads back the inherited default On')
  const resetRequest = await prepare()
  assert.ok(logField(resetRequest.fields) !== undefined, 'the readback value really drives the next request')
})
