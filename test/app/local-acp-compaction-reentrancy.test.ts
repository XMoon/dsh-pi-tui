/**
 * CMP-04 production observer reentrancy (L5): the real in-process Host
 * composition, the production `AcpSessionViewRegistry` and its production
 * Host-fact observer. A test-only `session/event` observer calls the real
 * `registry.cancelSession()` synchronously at the committed summary (and at
 * the precommit start in the negative leg); the observer is registered both
 * BEFORE and AFTER the production observer to prove order does not rewrite a
 * committed compaction. The raw engine, flush and official `sessionQuery` read
 * are real; only the scripted model endpoint is synthetic.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-compaction-reentrancy.test
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import {
  AcpSessionViewRegistry,
  type AcpPromptSessionParams,
  type HostAcpSessionAccess,
} from '../../src/app/remote-process/local-acp-session-view.ts'
import { createHostAcpSessionAccess } from '../../src/app/remote-process/local-host-entry.ts'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const QUIET_DIAG: Diag = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  dispose: () => {},
}

const LONG_ANSWER = `cmp04 answer ${'context '.repeat(900)}`

/** Scripted endpoint: a real DSH adapter over a synthetic model response. */
class CompactionAdapter extends LlmAdapter {
  override resolveModel(_provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({
      provider: 'smoke',
      id: model,
      name: model,
      context: { contextWindow: 8_000 },
    } as never)
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'smoke' }])
  }

  override async *stream(options: { readonly purpose?: string }): AsyncGenerator<StreamChunk> {
    const text = options.purpose === 'compaction' ? 'cmp04 compaction summary' : LONG_ANSWER
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The official compaction modules the audited preset inspection expects. */
const COMPACTION_PRESET_PLUGINS = [
  {
    id: 'compaction-basic',
    name: '@deepseek-ai/dsh-compaction-basic',
    config: {
      auto: false,
      thresholdRatio: 0.5,
      retainRatio: 0.1,
      summarizationProvider: 'smoke',
      summarizationModel: 'smoke',
    },
  },
  { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
] as const

interface SessionEventFact {
  readonly type: string
  readonly data?: unknown
}

interface C4Harness {
  readonly ctx: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>['ctx']
  readonly access: HostAcpSessionAccess
  readonly registry: AcpSessionViewRegistry
  readonly conn: ReturnType<AcpSessionViewRegistry['createConnection']>
  readonly sessionId: string
  readonly dispose: () => Promise<void>
  readonly events: SessionEventFact[]
  readonly updates: Array<{ readonly sessionUpdate?: string; readonly [key: string]: unknown }>
}

/** Read the own-compaction facts from one test-captured event. */
function compactionFact(event: SessionEventFact): { id?: string; error?: string } {
  const data = event.data as { readonly compactionId?: unknown; readonly error?: unknown } | undefined
  return {
    ...typeof data?.compactionId === 'string' ? { id: data.compactionId } : {},
    ...typeof data?.error === 'string' ? { error: data.error } : {},
  }
}

/**
 * Boot one real Host, one real session through the ACP view's `newSession`,
 * and one real long turn. The test observer is installed on the exact side of
 * the production observer requested by `order`.
 */
async function startC4(
  life: TestLifecycle,
  order: 'before' | 'after',
  cancelAt: 'compaction/start' | 'compaction/summary',
): Promise<C4Harness> {
  const host = await createRemoteApplicationHostFixture(life, 'standard', {
    llmAdapter: new CompactionAdapter(),
    presetPlugins: [...COMPACTION_PRESET_PLUGINS],
  })
  await host.ctx.plugin(TokenMeter)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const access = createHostAcpSessionAccess(host.ctx, parseCommand, BasicCompactionEngine)
  const registry = new AcpSessionViewRegistry(QUIET_DIAG)
  registry.bindAccess(access)
  const conn = registry.createConnection()
  const events: SessionEventFact[] = []
  const updates: Array<{ readonly sessionUpdate?: string; readonly [key: string]: unknown }> = []
  let targetSessionId: string | undefined
  let armed = true
  const cancelObserver = (session: { readonly id: string }, event: SessionEventFact) => {
    if (targetSessionId === undefined || String(session.id) !== targetSessionId) return
    events.push({ type: event.type, data: event.data })
    if (armed && event.type === cancelAt) {
      armed = false
      registry.cancelSession(conn, access, targetSessionId)
    }
  }
  const disposers: Array<() => void> = []
  if (order === 'before') disposers.push(host.ctx.on('session/event', cancelObserver))
  disposers.push(access.observePromptFacts(registry))
  if (order === 'after') disposers.push(host.ctx.on('session/event', cancelObserver))
  const dispose = async () => {
    for (const disposeObserver of disposers.reverse()) disposeObserver()
    await hostRuntime.dispose()
    await host.dispose()
  }
  try {
    const channels = {
      notifyProjection: async (_sessionId: string, update: { readonly sessionUpdate?: string; readonly [key: string]: unknown }) => {
        updates.push(update)
      },
      capabilities: { plan: false, compaction: true, subagents: false, notices: false },
    }
    const created = await registry.newSession(conn, access, { cwd: host.anchorDir, mcpServers: [] }, channels)
    targetSessionId = created.sessionId
    const sendUpdate = async (update: { readonly sessionUpdate?: string; readonly [key: string]: unknown }) => { updates.push(update) }
    const requestPermission = async () => { throw new Error('CMP-04: no permission request expected') }
    const historyRequest: AcpPromptSessionParams = {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: `CMP04 history ${'long context '.repeat(1_200)}` }],
    }
    const first = await registry.promptSession(
      conn, access,
      historyRequest,
      new AbortController().signal,
      false,
      sendUpdate,
      requestPermission,
    )
    assert.equal(first.stopReason, 'end_turn', 'CMP-04: the history turn must end_turn')
    return { ctx: host.ctx, access, registry, conn, sessionId: created.sessionId, dispose, events, updates }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function compactThroughView(c4: C4Harness): Promise<{ stopReason: string }> {
  const sendUpdate = async (update: { readonly sessionUpdate?: string; readonly [key: string]: unknown }) => { c4.updates.push(update) }
  const requestPermission = async () => { throw new Error('CMP-04: no permission request expected') }
  return await c4.registry.promptSession(
    c4.conn, c4.access,
    { sessionId: c4.sessionId, prompt: [{ type: 'text', text: '/compact' }] },
    new AbortController().signal,
    false,
    sendUpdate,
    requestPermission,
  )
}

test('CMP-04: a synchronous ACP cancel inside the production observer never aborts a committed compaction (ordered)', async (t: TestContext) => {
  const life = testLifecycle(t)
  const c4 = await startC4(life, 'before', 'compaction/summary')
  try {
    const reply = await compactThroughView(c4)
    assert.equal(reply.stopReason, 'end_turn', 'CMP-04: commit wins and the reply is end_turn')
    const summaries = c4.events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1, 'CMP-04: one committed summary')
    const id = compactionFact(summaries[0]!).id ?? ''
    assert.notEqual(id, '', 'CMP-04: the summary carries the own compaction id')
    assert(c4.events.some(event => event.type === 'compaction/end'
      && compactionFact(event).id === id && compactionFact(event).error === undefined),
    'CMP-04: the own clean end follows the summary')
    assert(c4.updates.some(update => update.sessionUpdate === 'compaction_update'
      && update.compactionId === id && update.status === 'completed'),
    'CMP-04: the live view still delivers the completed frame')
    const snapshot = await c4.ctx.sessionQuery.readSession(c4.sessionId as never)
    const durable = snapshot.events.filter(event => (event.data as { readonly compactionId?: string } | undefined)?.compactionId === id)
    assert(durable.some(event => event.type === 'compaction/start')
      && durable.some(event => event.type === 'compaction/summary')
      && durable.some(event => event.type === 'compaction/end'
        && (event.data as { readonly error?: string }).error === undefined),
    'CMP-04: the official cold read matches the same id and clean bracket')
  } finally {
    await c4.dispose()
  }
})

test('CMP-04: the same synchronous cancel after the production observer is still commit-wins (reverse)', async (t: TestContext) => {
  const life = testLifecycle(t)
  const c4 = await startC4(life, 'after', 'compaction/summary')
  try {
    const reply = await compactThroughView(c4)
    assert.equal(reply.stopReason, 'end_turn', 'CMP-04: reverse order still returns end_turn')
    const summaries = c4.events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1, 'CMP-04: reverse order has one committed summary')
    const id = compactionFact(summaries[0]!).id ?? ''
    assert(c4.events.some(event => event.type === 'compaction/end'
      && compactionFact(event).id === id && compactionFact(event).error === undefined),
    'CMP-04: reverse order keeps the own clean end')
  } finally {
    await c4.dispose()
  }
})

test('CMP-04: a precommit cancel aborts without a summary and the next compact commits a new id', async (t: TestContext) => {
  const life = testLifecycle(t)
  const c4 = await startC4(life, 'before', 'compaction/start')
  try {
    const reply = await compactThroughView(c4)
    assert.equal(reply.stopReason, 'cancelled', 'CMP-04: precommit cancel must settle cancelled')
    const starts = c4.events.filter(event => event.type === 'compaction/start')
    const id = compactionFact(starts[0]!).id ?? ''
    assert.notEqual(id, '', 'CMP-04: the precommit cancel has its own start id')
    assert(!c4.events.some(event => event.type === 'compaction/summary' && compactionFact(event).id === id),
      'CMP-04: the cancelled attempt never commits a summary')
    assert(c4.events.some(event => event.type === 'compaction/end'
      && compactionFact(event).id === id && compactionFact(event).error !== undefined),
    'CMP-04: the cancelled attempt has its matching failed end')
    const second = await compactThroughView(c4)
    assert.equal(second.stopReason, 'end_turn', 'CMP-04: the next compact after a cancel commits')
    const secondSummaries = c4.events.filter(event => event.type === 'compaction/summary')
    const secondId = compactionFact(secondSummaries.at(-1)!).id ?? ''
    assert.notEqual(secondId, '', 'CMP-04: the second compact has a summary id')
    assert.notEqual(secondId, id, 'CMP-04: the second compact never reuses the cancelled id')
  } finally {
    await c4.dispose()
  }
})
