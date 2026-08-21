/**
 * Headless unit tests for the skill catalog refresh coordinator (M3): epoch
 * supersession, target-change transitions, latest-only commits, same-target
 * partial-field retention, read-failure and cancellation semantics, the
 * STANDING preset path (skills-only installs, degradation notices, last-good
 * on a failed same-target reload), and the CoalescingRefreshGate.
 * @module @xmoon76/dsh-pi-tui/skill-catalog-refresh.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CatalogRefreshCoordinator, CoalescingRefreshGate, type CatalogRefreshHooks } from '../src/skill-catalog-refresh.ts'
import { createDiag } from '../src/diag.ts'
import type { HumanSkillCatalog } from '../src/skill-catalog.ts'
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

function catalogOf(skills: string[], complete = true): HumanSkillCatalog {
  return Object.freeze({
    skills: Object.freeze(skills.map(name => Object.freeze({ name, description: name }))),
    complete,
  })
}

/** Scripted hooks recording every call. */
function scriptedHooks(script: {
  read?: (agent: Agent, signal: AbortSignal) => Promise<SurfaceCatalogSnapshot> | never
  standing?: (presetId: string | undefined, signal: AbortSignal) => Promise<{ catalog: HumanSkillCatalog; notice?: string }> | never
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
    readStanding: async (presetId, signal) => {
      if (script.standing !== undefined) {
        const result = script.standing(presetId, signal)
        return result instanceof Promise ? abortAware(result, signal) : result
      }
      throw new Error('unexpected standing read')
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

test('a preset target reads the STANDING catalog and installs it as a skills-only snapshot', async () => {
  const readPresets: (string | undefined)[] = []
  const { hooks, calls, installed } = scriptedHooks({
    standing: async (presetId) => {
      readPresets.push(presetId)
      return { catalog: catalogOf(['glab', 'find-skills']) }
    },
  })
  const { diag, lines } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') {
    assert.deepEqual(outcome.snapshot.commands, [], 'the standing view installs no commands')
    assert.deepEqual(outcome.snapshot.scopedCommands, [], 'the standing view installs no scoped commands')
    assert.deepEqual(outcome.snapshot.skills.map(skill => skill.name), ['glab', 'find-skills'],
      'the coordinator installs the catalog verbatim; the collector owns the sort')
    assert.equal(outcome.notice, undefined)
  }
  assert.deepEqual(readPresets, ['code'], 'the standing read receives the preset id')
  assert.deepEqual(calls, [{ kind: 'transition' }, { kind: 'install' }])
  assert.equal(installed.length, 1)
  assert.ok(lines.some(line => /INFO catalog applied/.test(line) && /source=preset/.test(line)))
})

test('a standing degradation notice rides the applied outcome', async () => {
  const { hooks, installed } = scriptedHooks({
    standing: async () => ({
      catalog: catalogOf(['global-skill']),
      notice: 'skill catalog unavailable for preset "code": preset exploded',
    }),
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'reload',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') {
    assert.match(outcome.notice ?? '', /preset exploded/)
    assert.deepEqual(outcome.snapshot.skills.map(skill => skill.name), ['global-skill'])
  }
  assert.equal(installed.length, 1, 'a degraded read still installs the global layer')
})

test('a standing read failure keeps the last-good catalog on a same-target reload', async () => {
  let calls = 0
  const { hooks, installed } = scriptedHooks({
    standing: async () => {
      calls += 1
      if (calls === 1) return { catalog: catalogOf(['glab']) }
      throw new Error('registry down')
    },
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const first = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(first.kind, 'applied')
  const outcome = await coordinator.refresh({
    source: 'reload',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(outcome.kind, 'failed')
  assert.deepEqual(installed, [catalogSnapshotOf(['glab'])],
    'a failed same-target reload installs nothing: the last-good catalog stays')
})

/** The skills-only snapshot the coordinator wraps a standing catalog into. */
function catalogSnapshotOf(names: string[]): SurfaceCatalogSnapshot {
  return Object.freeze({
    commands: Object.freeze([]),
    scopedCommands: Object.freeze([]),
    skills: Object.freeze(names.map(name => Object.freeze({ name, description: name }))),
    issues: Object.freeze([]),
  })
}

test('quick preset switches install only the last preset (A→B race)', async () => {
  const gateA = deferred<{ catalog: HumanSkillCatalog; notice?: string }>()
  const { hooks, installed } = scriptedHooks({
    standing: (presetId, signal) => {
      if (presetId === 'code') return gateA.promise
      return Promise.resolve({ catalog: catalogOf(['beta']) })
    },
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const refreshA = coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  const refreshB = coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'standard' },
  })
  const outcomeB = await refreshB
  assert.equal(outcomeB.kind, 'applied')
  // A's standing read lands late: only B may install.
  gateA.resolve({ catalog: catalogOf(['alpha']) })
  const outcomeA = await refreshA
  assert.equal(outcomeA.kind, 'superseded')
  assert.deepEqual(installed, [catalogSnapshotOf(['beta'])], 'only the latest preset installs')
})

test('a late standing result never replaces a live-agent result', async () => {
  const standingGate = deferred<{ catalog: HumanSkillCatalog; notice?: string }>()
  const { hooks, installed } = scriptedHooks({
    standing: async () => standingGate.promise,
    read: async () => snapshotOf({
      commands: Object.freeze([Object.freeze({ name: 'live-cmd', description: 'l' })]),
      skills: Object.freeze([Object.freeze({ name: 'live-skill', description: 'l' })]),
    }),
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  // A sessionless standing refresh starts (e.g. /preset), then the first
  // real Agent is created and refreshes the LIVE surface.
  const standing = coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  const live = await coordinator.refresh({
    source: 'live-session',
    target: { kind: 'agent', key: 1 },
    agent: fakeAgent(),
  })
  assert.equal(live.kind, 'applied')
  // The standing result lands AFTER the live agent became the owner: dropped.
  standingGate.resolve({ catalog: catalogOf(['standing-skill']) })
  const standingOutcome = await standing
  assert.equal(standingOutcome.kind, 'superseded')
  assert.deepEqual(installed, [snapshotOf({
    commands: Object.freeze([Object.freeze({ name: 'live-cmd', description: 'l' })]),
    skills: Object.freeze([Object.freeze({ name: 'live-skill', description: 'l' })]),
  })], 'only the live-agent snapshot installs')
  assert.ok(!installed.some(snapshot => snapshot.skills.some(skill => skill.name === 'standing-skill')))
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

test('the coalescing gate runs one refresh per burst and one follow-up on settle', async () => {
  const starts: number[] = []
  const gate = new CoalescingRefreshGate(() => { starts.push(starts.length + 1) })
  // A burst while idle starts ONE refresh.
  gate.notify()
  gate.notify()
  gate.notify()
  assert.deepEqual(starts, [1], 'notifications during flight only mark dirty')
  gate.settled()
  assert.deepEqual(starts, [1, 2], 'the dirty gate starts exactly one follow-up')
  gate.settled()
  assert.deepEqual(starts, [1, 2], 'a clean settle starts nothing')
})

test('the coalescing gate drops a burst that settles clean before the next notify', async () => {
  const starts: number[] = []
  const gate = new CoalescingRefreshGate(() => { starts.push(starts.length + 1) })
  gate.notify()
  gate.settled()
  gate.notify()
  gate.settled()
  assert.deepEqual(starts, [1, 2], 'clean settle then a new notification starts a fresh refresh')
})

test('an incomplete standing observation keeps the last-good catalog on a same-target reload', async () => {
  let calls = 0
  const { hooks, installed } = scriptedHooks({
    standing: async () => {
      calls += 1
      return calls === 1
        ? { catalog: catalogOf(['glab']) }
        : { catalog: catalogOf([], false) }
    },
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const first = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(first.kind, 'applied')
  const outcome = await coordinator.refresh({
    source: 'reload',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') {
    assert.equal(outcome.snapshot.issues[0]?.provider, 'skills',
      'the incomplete observation must carry a detached skills issue')
    assert.deepEqual(outcome.snapshot.skills.map(skill => skill.name), ['glab'],
      'the last-good skills survive an incomplete observation (never a blank catalog)')
  }
  assert.equal(installed.length, 2)
  assert.deepEqual(installed[1]?.skills, installed[0]?.skills, 'the merged install keeps the old skills')
})

test('an incomplete standing observation on a TARGET CHANGE keeps the transition wrappers', async () => {
  const { hooks, installed } = scriptedHooks({
    standing: async () => ({ catalog: catalogOf([], false) }),
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(outcome.kind, 'applied')
  if (outcome.kind === 'applied') {
    assert.equal(outcome.snapshot.issues[0]?.provider, 'skills')
    // installSurfaceSnapshot's skillsFailed guard keeps the revalidating
    // transition wrappers; the coordinator's job is to surface the issue.
    assert.deepEqual(outcome.snapshot.skills, [])
  }
})

test('a user preset literally named "default" transitions away from the deployment default', async () => {
  const { hooks, calls, installed } = scriptedHooks({
    standing: async (presetId) => ({ catalog: catalogOf([presetId ?? 'deployment-default']) }),
  })
  const { diag } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(hooks, new AbortController().signal, diag)
  const first = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: undefined },
  })
  assert.equal(first.kind, 'applied')
  const transitionsBefore = calls.filter(call => call.kind === 'transition').length
  const second = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'default' },
  })
  assert.equal(second.kind, 'applied')
  const transitionsAfter = calls.filter(call => call.kind === 'transition').length
  assert.equal(transitionsAfter, transitionsBefore + 1,
    'the deployment default and a preset named "default" are DIFFERENT owners: a transition must fire')
  assert.equal(installed.length, 2)
})

test('a throwing transition hook settles as failed — refresh never rejects', async () => {
  const { hooks, installed } = scriptedHooks({
    standing: async () => ({ catalog: catalogOf(['glab']) }),
  })
  // Make the transition hook throw for THIS coordinator.
  const throwing = { ...hooks, enterCatalogTransition: (): never => { throw new Error('transition exploded') } }
  const { diag, lines } = capturingDiag()
  const coordinator = new CatalogRefreshCoordinator(throwing, new AbortController().signal, diag)
  const outcome = await coordinator.refresh({
    source: 'preset',
    target: { kind: 'preset', presetId: 'code' },
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind === 'failed') assert.equal(outcome.error, 'transition exploded')
  assert.deepEqual(installed, [])
  assert.ok(lines.some(line => /WARN catalog unavailable/.test(line) && /transition exploded/.test(line)))
})

test('a double settled() is idempotent and cannot clear a follow-up refresh', async () => {
  const starts: number[] = []
  const gate = new CoalescingRefreshGate(() => { starts.push(starts.length + 1) })
  gate.notify()
  // The runOwned double-settle path: onResult settles, throws, and runOwned
  // routes to onError which settles AGAIN before the follow-up starts.
  gate.settled()
  gate.settled()
  assert.deepEqual(starts, [1], 'the second settle is a no-op (no dirty notification)')
  gate.notify()
  gate.settled()
  assert.deepEqual(starts, [1, 2], 'a fresh notification still starts a refresh')
  gate.settled()
  assert.deepEqual(starts, [1, 2], 'the follow-up was not cleared by the stale settle')
})
