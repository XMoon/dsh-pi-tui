/**
 * Headless unit tests for the catalog refresh coordinator (M3): epoch
 * supersession, target-change transitions, latest-only commits, same-target
 * partial-field retention, read-failure and cancellation semantics, and the
 * composition probe path.
 * @module @xmoon76/dsh-pi-tui/catalog-refresh.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CatalogRefreshCoordinator, type CatalogRefreshHooks } from '../src/catalog-refresh.ts'
import { createDiag } from '../src/diag.ts'
import type { SurfaceCatalogSnapshot } from '../src/surface-catalog.ts'

/** A promise the test resolves manually, to stage late completions. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A cancellation-shaped rejection the fake reads use on abort. */
function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
}

/** Race one staged gate against the caller signal, like the REAL collector
 * does: the coordinator can only settle once its hooks honor the signal. */
function abortAware<T>(gate: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    gate.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function fakeAgent(id = 'session-a'): Agent {
  return { id, session: { id, header: { cwd: '/ws' }, events: [] } } as unknown as Agent
}

function snapshotOf(overrides: Partial<SurfaceCatalogSnapshot> = {}): SurfaceCatalogSnapshot {
  return Object.freeze({
    commands: Object.freeze([]),
    scopedCommands: Object.freeze([]),
    skills: Object.freeze([]),
    issues: Object.freeze([]),
    ...overrides,
  })
}

/** Scripted hooks recording every call. */
function scriptedHooks(script: {
  read?: (agent: Agent, signal: AbortSignal) => Promise<SurfaceCatalogSnapshot> | never
  probe?: (composition: unknown, signal: AbortSignal) => Promise<SurfaceCatalogSnapshot> | never
} = {}) {
  const calls: { kind: 'transition' | 'install' }[] = []
  const installed: SurfaceCatalogSnapshot[] = []
  const hooks: CatalogRefreshHooks = {
    readAgent: async (agent, signal) => {
      if (script.read !== undefined) {
        const result = script.read(agent, signal)
        return result instanceof Promise ? abortAware(result, signal) : result
      }
      throw new Error('unexpected read')
    },
    probeComposition: async (composition, signal) => {
      if (script.probe !== undefined) {
        const result = script.probe(composition, signal)
        return result instanceof Promise ? abortAware(result, signal) : result
      }
      throw new Error('unexpected probe')
    },
    installSnapshot: (snapshot) => {
      calls.push({ kind: 'install' })
      installed.push(snapshot)
    },
    enterCatalogTransition: () => {
      calls.push({ kind: 'transition' })
    },
  }
  return { hooks, calls, installed }
}

function capturingDiag(): { diag: ReturnType<typeof createDiag>; lines: string[] } {
  const lines: string[] = []
  return {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off', sinks: [{ write: (line: string) => { lines.push(line) } }] }),
    lines,
  }
}

const snapshotA = snapshotOf({ commands: Object.freeze([Object.freeze({ name: 'alpha', description: 'a' })]) })
const snapshotB = snapshotOf({ commands: Object.freeze([Object.freeze({ name: 'beta', description: 'b' })]) })

test('a live-agent refresh reads, installs once and reports applied', async () => {
  const { hooks, calls, installed } = scriptedHooks({ read: async () => snapshotA })
  const { diag, lines } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') assert.equal(outcome.snapshot, snapshotA)
  assert.deepEqual(calls, [{ kind: 'transition' }, { kind: 'install' }],
    'the first refresh enters the transition (nothing applied before) then installs')
  assert.equal(installed.length, 1)
  assert.ok(lines.some(line => /INFO catalog applied/.test(line) && /source=live-session/.test(line)))
})

test('a newer refresh supersedes an in-flight one: the late result never installs', async () => {
  const gateA = deferred<SurfaceCatalogSnapshot>()
  const reads: string[] = []
  const { hooks, calls, installed } = scriptedHooks({
    read: (agent) => {
      reads.push(String(agent.id))
      return agent.id === 'session-a' ? gateA.promise : Promise.resolve(snapshotB)
    },
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const refreshA = coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent('session-a'),
  })
  const refreshB = coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 2 },
    agent: fakeAgent('session-b'),
  })
  const outcomeB = await refreshB
  assert.equal(outcomeB.kind, 'applied')
  // A's catalog lands LATE: the epoch guard must drop it.
  gateA.resolve(snapshotA)
  const outcomeA = await refreshA
  assert.equal(outcomeA.kind, 'superseded')
  assert.deepEqual(installed, [snapshotB], 'only the latest refresh may install')
  assert.deepEqual(reads, ['session-a', 'session-b'], 'both reads started (B aborts A)')
  assert.ok(calls.some(call => call.kind === 'transition'), 'the target change entered a transition')
})

test('a same-target reload keeps the old field for a failed provider (partial failure)', async () => {
  const { hooks, installed } = scriptedHooks({
    read: async () => snapshotOf({
      commands: Object.freeze([Object.freeze({ name: 'fresh', description: 'f' })]),
      skills: Object.freeze([]),
      issues: Object.freeze([Object.freeze({ provider: 'skills', message: 'skills down' })]),
    }),
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  // First refresh: full snapshot with skills.
  await coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  const outcome = await coordinator.refresh({
    source: 'reload',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') {
    assert.equal(outcome.snapshot.issues[0]?.provider, 'skills')
    assert.deepEqual(outcome.snapshot.commands.map(command => command.name), ['fresh'],
      'the successful provider updates')
    // The failed skills field keeps the OLD snapshot's skills: the merged
    // snapshot equals the first install's skills.
    assert.deepEqual(outcome.snapshot.skills, installed[0]?.skills, 'the failed field keeps the old value')
  }
})

test('a same-target refresh with no issues installs the fresh snapshot wholesale', async () => {
  const { hooks, installed } = scriptedHooks({ read: async () => snapshotB })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  await coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  const outcome = await coordinator.refresh({
    source: 'reload',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') assert.equal(outcome.snapshot, snapshotB)
  assert.equal(installed.length, 2)
  assert.equal(installed[1], snapshotB, 'a clean same-target refresh replaces the snapshot')
})

test('a read failure reports failed, installs nothing and keeps the transition state', async () => {
  const { hooks, calls, installed } = scriptedHooks({
    read: async () => { throw new Error('registry exploded') },
  })
  const { diag, lines } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.error, 'registry exploded')
  assert.deepEqual(installed, [], 'a failed read never installs (the transition commands stay)')
  assert.ok(calls.some(call => call.kind === 'transition'), 'the transition was still entered')
  assert.ok(lines.some(line => /WARN catalog unavailable/.test(line) && /registry exploded/.test(line)))
})

test('a lifecycle abort supersedes the refresh: no install, no failure report', async () => {
  const gate = deferred<SurfaceCatalogSnapshot>()
  const { hooks, installed } = scriptedHooks({ read: async () => gate.promise })
  const lifecycle = new AbortController()
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, lifecycle.signal, diag)
  const refresh = coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  lifecycle.abort()
  const outcome = await refresh
  assert.equal(outcome.kind, 'superseded')
  assert.deepEqual(installed, [])
  // The late result stays dropped even after the gate resolves.
  gate.resolve(snapshotA)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(installed, [])
})

test('dispose aborts the active refresh so no late install can land', async () => {
  const gate = deferred<SurfaceCatalogSnapshot>()
  const { hooks, installed } = scriptedHooks({ read: async () => gate.promise })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const refresh = coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  coordinator.dispose()
  const outcome = await refresh
  assert.equal(outcome.kind, 'superseded')
  gate.resolve(snapshotA)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(installed, [])
})

test('a composition target probes the composition and installs its snapshot', async () => {
  const probed: unknown[] = []
  const { hooks, calls, installed } = scriptedHooks({
    probe: async (composition) => {
      probed.push(composition)
      return snapshotA
    },
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const composition = { agentPreset: 'code', setup: () => {} }
  const outcome = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'composition', key: 'code' },
    composition,
  })
  assert.equal(outcome.kind, 'applied')
  assert.equal(probed.length, 1)
  assert.equal(probed[0], composition)
  assert.equal(installed.length, 1)
  assert.ok(calls.some(call => call.kind === 'transition'))
})

test('quick preset switches install only the last composition (A→B race)', async () => {
  const gateA = deferred<SurfaceCatalogSnapshot>()
  const { hooks, installed } = scriptedHooks({
    probe: (composition, signal) => {
      const key = (composition as { agentPreset?: string }).agentPreset
      return key === 'code' ? gateA.promise : Promise.resolve(snapshotB)
    },
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const refreshA = coordinator.refresh({
    source: 'preset',
    target: { kind: 'composition', key: 'code' },
    composition: { agentPreset: 'code', setup: () => {} },
  })
  const refreshB = coordinator.refresh({
    source: 'preset',
    target: { kind: 'composition', key: 'standard' },
    composition: { agentPreset: 'standard', setup: () => {} },
  })
  const outcomeB = await refreshB
  assert.equal(outcomeB.kind, 'applied')
  // A's probe lands late: only B may install.
  gateA.resolve(snapshotA)
  const outcomeA = await refreshA
  assert.equal(outcomeA.kind, 'superseded')
  assert.deepEqual(installed, [snapshotB], 'only the latest composition installs')
})

test('a refresh from an incomplete request fails soft without installing', async () => {
  const { hooks, installed } = scriptedHooks()
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    // no agent: the request is incomplete
  })
  assert.equal(outcome.kind, 'failed')
  assert.deepEqual(installed, [])
})
