/**
 * Request time zone: the continuable CHILD follow-up over the REAL Direct Host
 * (plan §6 "Direct child viewer follow-up" row and §8 A3).
 *
 * The chain under test is the production one below the viewer surface:
 *
 * ```text
 * caller (the viewer's submit seam)
 *   -> SubagentPort            (DirectSubagentPort — the frozen semantic boundary)
 *   -> ctx.subagents.prompt    (REAL @deepseek-ai/dsh-subagent runtime + the
 *                               official in-process `spawn` provider)
 *   -> the cold-resumed child Session's durable `user/message`
 * ```
 *
 * The child is a REAL delegated continuable child: it is created through the
 * official `startActivation` entry, its initial turn runs to completion, its
 * activation detaches, and the follow-up then cold-resumes it exactly as a
 * production viewer follow-up does. The follow-up source and the untouched
 * parent log are read back from the Host's own Session logs.
 *
 * ## L5 fixture manifest
 *
 * - PRODUCTION PREREQUISITES REPRODUCED: the real `@deepseek-ai/dsh-subagent`
 *   runtime and the official `@deepseek-ai/dsh-subagent-spawn-in-process`
 *   `spawn` provider; the real rc.2 Agent/Session registry and AgentLoop
 *   (`mountAgentLoopTestDependencies`); the real JSONL Session persistence; the
 *   official SQLite `sessionQuery` engine (the runtime's cold-child read); the
 *   official `workingDirectory` owner; and the REAL `DirectSubagentPort`.
 * - TEST STAND-INS: the model endpoint (`FinishAdapter`, a scripted text-only
 *   stream) and the caller-owned `SubagentPromptContext` (`makeSignal` plus the
 *   composition-supplied `clientTimeZone`).
 * - DELIBERATELY ABSENT: the TUI viewer surface (its submit → port wiring is
 *   proven by `test/runner-viewer-task-integration.test.ts` F4-R1), a live
 *   network transport, and the official `time-context` row (its reading of this
 *   source is proven by `test/request-time-zone.test.ts`).
 *
 * @module @xmoon76/dsh-pi-tui/request-time-zone-child.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { DirectSubagentPort } from '../src/runtime/direct/subagent-direct.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const PARENT = 'request-zone-child-parent'
const CHILD = 'request-zone-child'

/** The scripted model endpoint (text only; the zone metadata is the subject). */
class FinishAdapter extends LlmAdapter {
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'child reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'child reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface DurableEvent {
  readonly type: string
  readonly data: unknown
}

/** One durable `user/message` payload as this test reads it. */
interface DurableUserMessage {
  readonly content: readonly { readonly text?: string }[]
  readonly source?: { readonly kind?: string; readonly rpcId?: unknown; readonly clientTimeZone?: unknown }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Bounded wait for one durable child-log predicate. */
async function waitForDurable(
  read: () => Promise<readonly DurableEvent[]>,
  label: string,
  predicate: (events: readonly DurableEvent[]) => boolean,
  timeoutMs = 30_000,
): Promise<readonly DurableEvent[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const events = await read()
    if (predicate(events)) return events
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(25)
  }
}

/** Every user message text of one child log. */
function userMessages(events: readonly DurableEvent[]): DurableUserMessage[] {
  return events.filter(event => event.type === 'user/message').map(event => event.data as DurableUserMessage)
}

function textOf(message: DurableUserMessage): string {
  return message.content.map(part => part.text ?? '').join('')
}

test('the REAL Direct child follow-up persists the Client-sampled zone on the child source and keeps parent/child authority', async (t) => {
  const life: TestLifecycle = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const JsonlSessionPersistence = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence as never, {
    root: life.tempDir('request-zone-child-persistence-'),
  } as never)
  life.defer(() => persistenceFiber.dispose())
  await ctx.plugin(AgentLoop, { agents: [] })
  // The runtime's cold-child read (the continuation path) requires the official
  // Session query engine, exactly as the shipped Host composition mounts it.
  const { SqliteSessionQueryEngine } = await import('@deepseek-ai/dsh-session-query-sqlite')
  await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' } as never)
  })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['zone'], new FinishAdapter())

  const parentHandle = await ctx.agents.create({
    sessionId: SessionId(PARENT),
    agentOptions: { provider: 'zone', model: 'm' } as never,
  })
  // One REAL delegated continuable child, created through the official entry.
  const subagents = ctx.get('subagents') as unknown as {
    startActivation(spec: unknown): Promise<{ readonly childId: string; readonly messageId: string }>
  }
  const started = await subagents.startActivation({
    provider: 'spawn',
    label: 'request-zone child',
    childId: SessionId(CHILD),
    request: {
      prompt: [{ type: 'text', text: 'child initial prompt' }],
      parent: parentHandle.agent,
    },
    signal: new AbortController().signal,
    delivery: 'parent',
  })
  assert.equal(started.childId, CHILD, 'the official spawn must establish the reserved child identity')

  const persistence = ctx.get('sessionPersistence') as unknown as {
    open(id: unknown, mode: 'read'): Promise<{
      read(): Promise<{ events: readonly DurableEvent[] }>
      close(): Promise<void>
    }>
  }
  const readChild = async (): Promise<readonly DurableEvent[]> => {
    const handle = await persistence.open(SessionId(CHILD), 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  }
  // The child's own initial turn completes, then its activation detaches: the
  // follow-up below therefore cold-resumes a REAL detached continuable child.
  await waitForDurable(readChild, 'the child initial turn', events =>
    events.some(event => event.type === 'assistant/message'))
  const sessions = ctx.sessions as unknown as {
    get(id: unknown): { snapshotEvents(): readonly DurableEvent[] } | undefined
  }
  await waitForDurable(async () => sessions.get(SessionId(CHILD)) === undefined ? [] : [{} as DurableEvent],
    'the child activation to detach', events => events.length === 0)

  assert.ok(sessions.get(SessionId(PARENT)) !== undefined, 'the live parent Session must exist')

  const port = new DirectSubagentPort({ get: (name: string) => ctx.get(name) })
  const outcome = await port.prompt(
    {
      parentSessionId: PARENT,
      childSessionId: CHILD,
      delivery: 'queue',
      content: [{ type: 'text', text: 'child follow up' }],
    },
    { makeSignal: () => new AbortController().signal, clientTimeZone: () => 'Asia/Shanghai' },
  )
  assert.equal(outcome.kind, 'ok', 'the follow-up must be admitted by the official child inbox')

  const events = await waitForDurable(readChild, 'the child follow-up to be durable', current =>
    userMessages(current).some(message => textOf(message) === 'child follow up'))
  const followUp = userMessages(events).find(message => textOf(message) === 'child follow up')
  assert.ok(followUp !== undefined, 'the child log must carry the follow-up')
  assert.deepEqual({
    kind: followUp.source?.kind,
    rpcId: typeof followUp.source?.rpcId,
    clientTimeZone: followUp.source?.clientTimeZone,
  }, {
    kind: 'user',
    rpcId: 'string',
    clientTimeZone: 'Asia/Shanghai',
  }, 'the child source must carry the official human provenance plus the Client-sampled request zone')
  assert.equal(textOf(userMessages(events).find(message => textOf(message) === 'child initial prompt')!),
    'child initial prompt', 'the initial delegated prompt stays untouched')
  assert.equal(userMessages(events).filter(message => textOf(message) === 'child follow up').length, 1,
    'the follow-up lands on the child exactly once (no double delivery)')

  // Parent/child authority is unchanged: a follow-up addressed from a different
  // parent is refused by the official runtime and never reaches the child.
  const wrongParent = await port.prompt(
    {
      parentSessionId: 'request-zone-child-other-parent',
      childSessionId: CHILD,
      delivery: 'queue',
      content: [{ type: 'text', text: 'unauthorized follow up' }],
    },
    { makeSignal: () => new AbortController().signal, clientTimeZone: () => 'Asia/Shanghai' },
  )
  assert.equal(wrongParent.kind, 'rejected', 'a foreign parent must be refused')
  const afterWrongParent = await readChild()
  assert.equal(userMessages(afterWrongParent).some(message => textOf(message) === 'unauthorized follow up'), false,
    'a refused follow-up never reaches the child log')

  // The identity is per submit: a second follow-up carries its own requestId.
  const second = await port.prompt(
    {
      parentSessionId: PARENT,
      childSessionId: CHILD,
      delivery: 'queue',
      content: [{ type: 'text', text: 'child follow up two' }],
    },
    { makeSignal: () => new AbortController().signal, clientTimeZone: () => 'Europe/Paris' },
  )
  assert.equal(second.kind, 'ok')
  const afterSecond = await waitForDurable(readChild, 'the second follow-up to be durable', current =>
    userMessages(current).some(message => textOf(message) === 'child follow up two'))
  const messages = userMessages(afterSecond)
  const first = messages.find(message => textOf(message) === 'child follow up')!
  const next = messages.find(message => textOf(message) === 'child follow up two')!
  assert.notEqual(next.source?.rpcId, first.source?.rpcId, 'each human follow-up mints its own request identity')
  assert.equal(next.source?.clientTimeZone, 'Europe/Paris',
    'each follow-up carries the zone sampled for THAT submit')
})
