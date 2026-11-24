/**
 * A REAL live removal of one Agent (the registry's OWNED handle) must revoke
 * the Client list and the incremental Activity observation's Running fact
 * truthfully. The owned handle is the supported removal capability; the model
 * route is `agentOptions` (never a bare `model` field).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRemoteApplicationHostFixture, testLifecycle } from '../support/remote-application-fixture.ts'
import { createExperimentalRemoteRuntime } from '../support/m3-inprocess/runtime.ts'
import { RemoteSessionReader } from '../../src/runtime/remote/session-reader-remote.ts'
import { RemoteSessionWorkspaceFacts } from '../../src/runtime/remote/session-workspace-facts-remote.ts'

const SESSION = 'gate-a-live-removal'
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}

/** A real turn that STAYS running until the Agent aborts it. */
class GatedAdapter extends LlmAdapter {
  release!: () => void
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve })
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    await Promise.race([
      this.gate,
      new Promise<void>((_resolve, reject) => {
        const signal = options.signal
        if (signal === undefined) return
        const abort = (): void => { reject(signal.reason ?? new Error('the Agent was disposed')) }
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }),
    ])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'released' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'released' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('a live owned-Agent removal revokes the Client and observation Running truthfully', async (t) => {
  const life = testLifecycle(t)
  const adapter = new GatedAdapter()
  const host = await createRemoteApplicationHostFixture(life, 'gate-a-probe', { llmAdapter: adapter })
  // The registry's OWNED handle is the supported live-removal capability; the
  // model route is `agentOptions` (never a bare `model` field).
  const handle = await (host.ctx as any).agents.create({
    sessionId: SessionId(SESSION),
    agentOptions: { provider: 'smoke', model: 'smoke' },
    meta: { cwd: host.anchorDir },
  })
  const agent = handle.agent
  const runtime = await createExperimentalRemoteRuntime({ hostContext: host.ctx, waitForHostPrerequisites: async () => {} })
  t.after(async () => { await runtime.dispose().catch(() => {}) })
  const client = runtime.client as any
  const generation = client.connection.generation
  const forwarded = client.remote.$on.bind(client.remote)
  const statusEvents: Array<{ at: number; sessionId: string; running: boolean }> = []
  forwarded('api-session/status', ((sessionId: unknown, running: unknown) => {
    statusEvents.push({ at: Date.now(), sessionId: String(sessionId), running: running === true })
  }) as never)
  const removed: string[] = []
  forwarded('api-session/removed', ((sessionId: unknown) => { removed.push(String(sessionId)) }) as never)

  await waitFor('the Client list is ready', () => client.sessions.list.getSnapshot().phase === 'ready', 30_000)
  const reader = new RemoteSessionReader(client.sessions, generation)
  const facts = new RemoteSessionWorkspaceFacts({
    sessions: client.sessions,
    remote: { session: client.remote.session, workspace: client.remote.workspace },
    connection: { generation },
    events: { onSessionStatus: (listener: (sessionId: string, running: boolean) => void) => forwarded('api-session/status', listener as never) },
    workspaceStream: client.workspaceStream,
    initialGeneration: client.initialGeneration,
  })
  t.after(() => { facts.dispose() })
  const observation = facts.observeActivity(new AbortController().signal)
  t.after(() => { observation.dispose() })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold the turn' }], source: { kind: 'user' } }))
  await waitFor('the official list proves Running', () => client.sessions.list.getSnapshot().byId[SESSION]?.running === true, 30_000)
  observation.setRoster(await reader.list(undefined) ?? [], 1, undefined)
  await waitFor('the observation publishes Running', () =>
    observation.getSnapshot().facts.some(fact => fact.sessionId === SESSION && fact.running === true), 20_000)
  const statusBeforeDispose = statusEvents.length
  const removedBeforeDispose = removed.length
  await handle.dispose()
  await waitFor('the removal reaches the official forwarded channel', () =>
    statusEvents.slice(statusBeforeDispose).some(entry => entry.sessionId === SESSION && entry.running === false)
    || removed.slice(removedBeforeDispose).includes(SESSION), 20_000)
  // The actual post-dispose official source event: the list's target Running
  // stops being true before the roster/observation are read.
  await waitFor('the official list no longer proves Running', () =>
    client.sessions.list.getSnapshot().byId[SESSION]?.running !== true, 20_000)
  const rosterAfter = await reader.list(undefined) ?? []
  observation.setRoster(rosterAfter, 2, undefined)
  await waitFor('the observation has processed the removal', () => {
    const fact = observation.getSnapshot().facts.find(entry => entry.sessionId === SESSION)
    return fact === undefined || fact.running !== true
  }, 20_000)
  const listAfter = client.sessions.list.getSnapshot()
  const factAfter = observation.getSnapshot().facts.find(entry => entry.sessionId === SESSION)
  assert.notEqual(listAfter.byId[SESSION]?.running, true, 'the Client list no longer paints the removed Agent as Running')
  assert.notEqual(factAfter?.running, true, 'the observation revokes the removed Agent Running fact')
})
