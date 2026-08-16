/**
 * Headless unit tests for the catalog probe lifecycle: create →
 * whenIdle → read → zero-event gate → await dispose, on every path
 * (success, create failure, hung whenIdle + abort, read failure, event
 * violation, dispose failure, pre-aborted signal). The agents service,
 * the agent and the collector are fakes; the real-composition integration
 * test (`catalog-probe-integration.test.ts`) drives the same function
 * against the real agent loop.
 * @module @xmoon76/dsh-pi-tui/catalog-probe.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { probeSurfaceCatalog, type ProbeAgentsService, type ProbeComposition } from '../src/catalog-probe.ts'
import { createDiag } from '../src/diag.ts'
import { isCancellation } from '../src/detached.ts'
import type { SurfaceCatalogSnapshot } from '../src/surface-catalog.ts'

/** A promise the test resolves manually, to stage late completions. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A fake agent with scripted whenIdle and events. */
function fakeAgent(events: unknown[] = []): Agent {
  return {
    session: { id: 'session-probe-x', header: { cwd: '/ws' }, events: events as never },
    whenIdle: async () => {},
    options: { provider: 'p', model: 'm' },
  } as unknown as Agent
}

/** A scripted handle recording dispose order and optionally failing it. */
function fakeHandle(agent: Agent, log: string[], failDispose = false): AgentHandle {
  return {
    agent,
    dispose: async (): Promise<void> => {
      log.push('dispose')
      if (failDispose) throw new Error('dispose exploded')
    },
  }
}

/** A scripted agents service recording create options. */
function fakeAgents(script: {
  create?: (options: Parameters<ProbeAgentsService['create']>[0]) => Promise<AgentHandle> | never
  log?: string[]
} = {}): ProbeAgentsService & { createCalls: Array<Parameters<ProbeAgentsService['create']>[0]> } {
  const createCalls: Array<Parameters<ProbeAgentsService['create']>[0]> = []
  return {
    createCalls,
    create: (options) => {
      createCalls.push(options)
      if (script.create !== undefined) return script.create(options)
      throw new Error('unexpected create')
    },
  }
}

/** A diag sink capturing formatted lines. */
function capturingDiag(): { diag: ReturnType<typeof createDiag>; lines: string[] } {
  const lines: string[] = []
  return {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off', sinks: [{ write: (line: string) => { lines.push(line) } }] }),
    lines,
  }
}

const composition: ProbeComposition = { agentPreset: 'standard', setup: () => {} }

const snapshot: SurfaceCatalogSnapshot = Object.freeze({
  commands: Object.freeze([Object.freeze({ name: 'plan', description: 'Enter plan mode' })]),
  scopedCommands: Object.freeze([]),
  skills: Object.freeze([]),
  issues: Object.freeze([]),
})

test('a normal probe runs create → whenIdle → read → zero-event gate → await dispose and returns the detached snapshot', async () => {
  const log: string[] = []
  const agent = fakeAgent()
  const agents = fakeAgents({
    log,
    create: async () => {
      log.push('create')
      return fakeHandle(agent, log)
    },
  })
  const { diag, lines } = capturingDiag()
  const readOrder: string[] = []
  const result = await probeSurfaceCatalog({
    agents,
    composition,
    agentOptions: { provider: 'p', model: 'm' },
    cwd: '/ws',
    signal: new AbortController().signal,
    readCatalog: async (probeAgent, signal) => {
      readOrder.push('read')
      assert.equal(probeAgent, agent, 'the collector must receive the created probe agent')
      assert.equal(signal.aborted, false)
      return snapshot
    },
    diag,
  })
  assert.deepEqual(log, ['create', 'dispose'], 'dispose must run AFTER the read, awaited in the same owner')
  assert.deepEqual(readOrder, ['read'], 'the catalog must be read exactly once')
  assert.equal(result, snapshot, 'the detached snapshot must be returned as-is')
  const createCall = agents.createCalls[0]
  assert.ok(createCall !== undefined)
  assert.equal(String(createCall.sessionId).startsWith('session-'), true, 'a SessionId-branded id is passed')
  assert.deepEqual(createCall.meta, { cwd: '/ws', agentPreset: 'standard' }, 'meta carries cwd + resolved preset')
  assert.ok(createCall.signal !== undefined, 'the creation signal must ride along to agents.create')
  assert.ok(lines.some(line => /catalog probe start/.test(line) && /standard/.test(line)))
  assert.ok(lines.some(line => /catalog probe ready/.test(line) && /commands=1/.test(line)))
  assert.ok(lines.some(line => /catalog probe disposed/.test(line)))
})

test('a create failure leaves no handle: dispose is NOT called and the error propagates', async () => {
  const log: string[] = []
  const agents = fakeAgents({
    log,
    create: async () => { throw new Error('factory down') },
  })
  const { diag } = capturingDiag()
  await assert.rejects(
    probeSurfaceCatalog({
      agents,
      composition,
      agentOptions: {},
      cwd: '/ws',
      signal: new AbortController().signal,
      readCatalog: async () => snapshot,
      diag,
    }),
    /factory down/,
  )
  assert.deepEqual(log, [], 'no handle existed; dispose must never run')
})

test('a hung whenIdle aborts through the caller signal and still disposes', async () => {
  const log: string[] = []
  const gate = deferred<void>()
  const agent = fakeAgent()
  agent.whenIdle = () => gate.promise
  const agents = fakeAgents({
    log,
    create: async () => {
      log.push('create')
      return fakeHandle(agent, log)
    },
  })
  const controller = new AbortController()
  const { diag } = capturingDiag()
  const run = probeSurfaceCatalog({
    agents,
    composition,
    agentOptions: {},
    cwd: '/ws',
    signal: controller.signal,
    readCatalog: async () => snapshot,
    diag,
  })
  controller.abort()
  await assert.rejects(run, (error: unknown) => {
    assert.ok(isCancellation(error), 'an abort during whenIdle must reject with a cancellation-shaped error')
    return true
  })
  assert.deepEqual(log, ['create', 'dispose'], 'the published handle must be disposed on the abort path')
})

test('a collector failure still disposes and propagates the error', async () => {
  const log: string[] = []
  const agent = fakeAgent()
  const agents = fakeAgents({
    log,
    create: async () => {
      log.push('create')
      return fakeHandle(agent, log)
    },
  })
  const { diag } = capturingDiag()
  await assert.rejects(
    probeSurfaceCatalog({
      agents,
      composition,
      agentOptions: {},
      cwd: '/ws',
      signal: new AbortController().signal,
      readCatalog: async () => { throw new Error('collector down') },
      diag,
    }),
    /collector down/,
  )
  assert.deepEqual(log, ['create', 'dispose'], 'dispose must still run after a read failure')
})

test('a non-zero event probe fails the release gate with count/types and still disposes', async () => {
  const log: string[] = []
  const agent = fakeAgent([
    { type: 'turn/start', seq: 0, data: {} },
    { type: 'agent/inbox/spliced', seq: 1, data: {} },
    { type: 'turn/start', seq: 2, data: {} },
  ])
  const agents = fakeAgents({
    log,
    create: async () => {
      log.push('create')
      return fakeHandle(agent, log)
    },
  })
  const { diag, lines } = capturingDiag()
  await assert.rejects(
    probeSurfaceCatalog({
      agents,
      composition,
      agentOptions: {},
      cwd: '/ws',
      signal: new AbortController().signal,
      readCatalog: async () => snapshot,
      diag,
    }),
    /catalog probe emitted 3 session event\(s\) \(turn\/start, agent\/inbox\/spliced\)/,
  )
  assert.deepEqual(log, ['create', 'dispose'], 'dispose must still run after the gate violation')
  assert.ok(lines.some(line => /catalog probe emitted events/.test(line) && /count=3/.test(line) && /turn\/start/.test(line)),
    `the gate violation must land in diagnostics:\n${lines.join('\n')}`)
})

test('a dispose failure surfaces as a primary failure: no success catalog is returned', async () => {
  const agent = fakeAgent()
  const agents = fakeAgents({
    create: async () => fakeHandle(agent, [], true),
  })
  const { diag, lines } = capturingDiag()
  await assert.rejects(
    probeSurfaceCatalog({
      agents,
      composition,
      agentOptions: {},
      cwd: '/ws',
      signal: new AbortController().signal,
      readCatalog: async () => snapshot,
      diag,
    }),
    /catalog probe dispose failed: dispose exploded/,
  )
  assert.ok(lines.some(line => /catalog probe dispose failed/.test(line) && /dispose exploded/.test(line)),
    `the dispose failure must land in diagnostics:\n${lines.join('\n')}`)
})

test('a dispose failure on an already-failing path combines both failures', async () => {
  const agent = fakeAgent()
  const agents = fakeAgents({
    create: async () => fakeHandle(agent, [], true),
  })
  const { diag } = capturingDiag()
  await assert.rejects(
    probeSurfaceCatalog({
      agents,
      composition,
      agentOptions: {},
      cwd: '/ws',
      signal: new AbortController().signal,
      readCatalog: async () => { throw new Error('collector down') },
      diag,
    }),
    /catalog probe dispose failed: dispose exploded \(while handling: collector down\)/,
  )
})

test('an already-aborted signal never creates a probe', async () => {
  const log: string[] = []
  const agents = fakeAgents({ log })
  const controller = new AbortController()
  controller.abort()
  const { diag } = capturingDiag()
  await assert.rejects(
    probeSurfaceCatalog({
      agents,
      composition,
      agentOptions: {},
      cwd: '/ws',
      signal: controller.signal,
      readCatalog: async () => snapshot,
      diag,
    }),
    (error: unknown) => {
      assert.ok(isCancellation(error))
      return true
    },
  )
  assert.deepEqual(agents.createCalls, [], 'no create may start on an already-aborted signal')
  assert.deepEqual(log, [])
})
