/** FR5-B Remote adapter contract over the production shared mirror: the Host's
 * served Settings namespaces decide the ACTIVE shell row; the Client OS is
 * never consulted. This fixture is not authenticated wire evidence. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RemoteConfigPort,
  type RemoteConfigRuntimeSource,
  type RemoteSettingsPathOp,
} from '../../../src/runtime/remote/config-remote.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'

type Namespace = { ns: string; value?: unknown; base?: unknown; user?: unknown; revision?: number }

interface FixtureOptions {
  readonly namespaces?: readonly Namespace[]
  readonly mutateFailure?: { readonly code: string; readonly message: string }
  readonly applyBeforeFailure?: boolean
  readonly failDescribeAfterWrite?: boolean
}

function defaultNamespaces(): Namespace[] {
  return [
    {
      ns: 'agent-loop',
      base: { maxParallelToolCalls: 10 },
      user: { maxParallelToolCalls: 2 },
      value: { maxParallelToolCalls: 2 },
      revision: 8,
    },
    {
      ns: 'bash-sandbox',
      base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 90_000 },
      value: { timeoutMs: 90_000, maxOutputBytes: 64_000 },
      revision: 11,
    },
    {
      ns: 'session-log-deepseek',
      base: { enabled: true },
      user: { enabled: false },
      value: { enabled: false },
      revision: 6,
    },
  ]
}

function applyMutation(target: Namespace, ops: readonly RemoteSettingsPathOp[]): void {
  const user = { ...(target.user as Record<string, unknown> | undefined) }
  const base = target.base as Record<string, unknown>
  for (const op of ops) {
    assert.equal(op.path.length, 1, 'the typed adapter only writes whole fields')
    const field = op.path[0]!
    if (op.op === 'set') user[field] = structuredClone(op.value)
    else if (Object.hasOwn(base, field)) user[field] = structuredClone(base[field])
    else Reflect.deleteProperty(user, field)
  }
  target.user = user
  target.value = { ...base, ...user }
  target.revision = (target.revision ?? 0) + 1
}

function makePort(options: FixtureOptions = {}) {
  let snapshot: RemoteConnectionGeneration | undefined = { id: 1 } as RemoteConnectionGeneration
  const generationListeners = new Set<() => void>()
  const namespaces: Namespace[] = [...structuredClone(options.namespaces ?? defaultNamespaces())]
  const calls: Array<{ ns: string; ops: readonly RemoteSettingsPathOp[]; revision: number | undefined }> = []
  let describeCalls = 0
  let failNextDescribe = false

  const settings = {
    describe: async () => {
      describeCalls += 1
      if (failNextDescribe) {
        failNextDescribe = false
        return { ok: false as const, error: { code: 'gateway/internal', message: 'settings read lost' } }
      }
      return { ok: true as const, value: { writable: true, hasDocument: true, namespaces: structuredClone(namespaces) } }
    },
    update: async () => ({ ok: true as const, value: {} }),
    replace: async () => ({ ok: true as const, value: {} }),
    mutate: async (ns: string, ops: readonly RemoteSettingsPathOp[], revision: number | undefined) => {
      calls.push({ ns, ops: structuredClone(ops), revision })
      const target = namespaces.find(item => item.ns === ns)
      if (target === undefined) return { ok: false as const, error: { code: 'settings/absent', message: 'no section' } }
      if (revision !== target.revision) {
        return { ok: false as const, error: { code: 'settings/conflict', message: 'revision changed since it was read' } }
      }
      if (options.mutateFailure !== undefined) {
        if (options.applyBeforeFailure === true) applyMutation(target, ops)
        return { ok: false as const, error: options.mutateFailure }
      }
      applyMutation(target, ops)
      if (options.failDescribeAfterWrite === true) failNextDescribe = true
      return { ok: true as const, value: {} }
    },
  }
  const remote = {
    settings,
    credentials: {
      describe: async () => ({ ok: true as const, value: {} }),
      set: async () => ({ ok: true as const, value: undefined }),
      unset: async () => ({ ok: true as const, value: undefined }),
    },
    commands: { execute: async () => ({ ok: true as const, value: undefined }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    $on: (_event: string, _listener: (...args: unknown[]) => void) => () => {},
  }
  const generation = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  const port = new RemoteConfigPort({ remote, connection: { generation } } as unknown as RemoteConfigRuntimeSource)
  return {
    port,
    calls,
    get describeCalls() { return describeCalls },
    get generationIdentity() { return snapshot },
    get namespaces() { return namespaces },
    disconnect() {
      snapshot = undefined
      for (const listener of [...generationListeners]) listener()
    },
  }
}

test('one mirror snapshot projects the Agent loop, active shell row and session log', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  assert.equal(fixture.describeCalls, 1)

  const loop = fixture.port.agentLoopSettings.read()
  assert.equal(loop.kind, 'ready')
  if (loop.kind !== 'ready') return
  assert.equal(loop.generation, fixture.generationIdentity)
  assert.equal(loop.revision, 8)
  assert.deepEqual(loop.effective, { maxParallelToolCalls: 2 })
  assert.deepEqual(loop.inherited, { maxParallelToolCalls: 10 })
  assert.deepEqual(loop.overridden, { maxParallelToolCalls: true })

  const shell = fixture.port.shellExecutionSettings.read()
  assert.equal(shell.kind, 'ready')
  if (shell.kind !== 'ready') return
  assert.deepEqual(shell.effective, { executor: 'bash', timeoutMs: 90_000, maxOutputBytes: 64_000 })
  assert.deepEqual(shell.inherited, { executor: 'bash', timeoutMs: 60_000, maxOutputBytes: 64_000 })

  const sessionLog = fixture.port.sessionLogUpload.read()
  assert.equal(sessionLog.kind, 'ready')
  if (sessionLog.kind !== 'ready') return
  assert.deepEqual(sessionLog.effective, { enabled: false })
  assert.deepEqual(sessionLog.inherited, { enabled: true })
})

test('a Windows Host mirror selects pwsh while the Client OS is never consulted; ambiguity fails closed', async () => {
  const windows = makePort({
    namespaces: [
      { ns: 'agent-loop', base: { maxParallelToolCalls: 10 }, value: { maxParallelToolCalls: 10 }, revision: 1 },
      { ns: 'pwsh-sandbox', base: { timeoutMs: 120_000, maxOutputBytes: 64_000 }, value: { timeoutMs: 120_000, maxOutputBytes: 64_000 }, revision: 2 },
    ],
  })
  await windows.port.describe()
  const pwsh = windows.port.shellExecutionSettings.read()
  assert.equal(pwsh.kind, 'ready')
  if (pwsh.kind === 'ready') assert.equal(pwsh.effective.executor, 'pwsh')

  const both = makePort({
    namespaces: [
      { ns: 'bash-sandbox', base: { timeoutMs: 60_000, maxOutputBytes: 64_000 }, value: { timeoutMs: 60_000, maxOutputBytes: 64_000 }, revision: 1 },
      { ns: 'pwsh-sandbox', base: { timeoutMs: 120_000, maxOutputBytes: 64_000 }, value: { timeoutMs: 120_000, maxOutputBytes: 64_000 }, revision: 2 },
    ],
  })
  await both.port.describe()
  const ambiguous = both.port.shellExecutionSettings.read()
  assert.equal(ambiguous.kind, 'unreadable')
  if (ambiguous.kind === 'unreadable') assert.match(ambiguous.reason, /ambiguous/u)

  const none = makePort({ namespaces: [] })
  await none.port.describe()
  assert.equal(none.port.shellExecutionSettings.read().kind, 'unavailable')
  assert.equal(none.port.agentLoopSettings.read().kind, 'unavailable')
})

test('the two shell caps dispatch as ONE exact-revision mutation and Reset preserves the sibling cap', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const opened = fixture.port.shellExecutionSettings.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const result = await fixture.port.shellExecutionSettings.mutate({
    timeoutMs: { kind: 'set', value: 30_000 },
    maxOutputBytes: { kind: 'reset' },
  }, opened.revision, opened.generation, opened.effective.executor)
  assert.deepEqual(result, { kind: 'accepted' })
  assert.ok(fixture.calls.length === 1)
  assert.deepEqual(fixture.calls[0], {
    ns: 'bash-sandbox',
    ops: [
      { op: 'set', path: ['timeoutMs'], value: 30_000 },
      { op: 'unset', path: ['maxOutputBytes'] },
    ],
    revision: 11,
  })
  const readback = fixture.port.shellExecutionSettings.read()
  assert.equal(readback.kind, 'ready')
  if (readback.kind !== 'ready') return
  assert.deepEqual(readback.effective, { executor: 'bash', timeoutMs: 30_000, maxOutputBytes: 64_000 })
  // A stale page cannot write the other executor's row or its own old revision.
  const switched = makePort({ namespaces: [
    { ns: 'pwsh-sandbox', base: { timeoutMs: 120_000, maxOutputBytes: 64_000 }, value: { timeoutMs: 120_000, maxOutputBytes: 64_000 }, revision: 11 },
  ] })
  await switched.port.describe()
  const switchedRead = switched.port.shellExecutionSettings.read()
  assert.equal(switchedRead.kind, 'ready')
  if (switchedRead.kind !== 'ready') return
  assert.equal((await switched.port.shellExecutionSettings.mutate({ timeoutMs: { kind: 'set', value: 1 } }, opened.revision, opened.generation, 'bash')).kind, 'rejected')
  assert.equal(switched.calls.length, 0)
})

test('session log false is a real value; Reset sends the official unset and may read back On', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const opened = fixture.port.sessionLogUpload.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.deepEqual(await fixture.port.sessionLogUpload.mutate({ enabled: { kind: 'set', value: true } }, opened.revision, opened.generation), { kind: 'accepted' })
  assert.deepEqual(fixture.calls[0]?.ops, [{ op: 'set', path: ['enabled'], value: true }])

  const afterOn = fixture.port.sessionLogUpload.read()
  assert.equal(afterOn.kind, 'ready')
  if (afterOn.kind !== 'ready') return
  assert.deepEqual(await fixture.port.sessionLogUpload.mutate({ enabled: { kind: 'reset' } }, afterOn.revision, afterOn.generation), { kind: 'accepted' })
  assert.deepEqual(fixture.calls[1]?.ops, [{ op: 'unset', path: ['enabled'] }])
  const readback = fixture.port.sessionLogUpload.read()
  assert.equal(readback.kind, 'ready')
  if (readback.kind !== 'ready') return
  assert.equal(readback.effective.enabled, true, 'the official readback may return On after Reset')
})

test('stale generations, conflicts and disconnected Hosts never produce a fake save', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const opened = fixture.port.agentLoopSettings.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const conflict = await fixture.port.agentLoopSettings.mutate(
    { maxParallelToolCalls: { kind: 'set', value: 3 } },
    opened.revision + 1,
    opened.generation,
  )
  assert.equal(conflict.kind, 'conflict')
  assert.equal(fixture.calls.length, 0)

  fixture.disconnect()
  assert.equal(fixture.port.agentLoopSettings.read().kind, 'unavailable')
  const disconnected = await fixture.port.agentLoopSettings.mutate(
    { maxParallelToolCalls: { kind: 'set', value: 3 } },
    opened.revision,
    opened.generation,
  )
  assert.equal(disconnected.kind, 'rejected')
  assert.equal(fixture.calls.length, 0)
})

test('a dispatched write whose official settle is unobservable stays outcome-unconfirmed', async () => {
  const fixture = makePort({
    mutateFailure: { code: 'settings/rejected', message: 'Loader failed after persistence' },
    applyBeforeFailure: true,
  })
  await fixture.port.describe()
  const opened = fixture.port.agentLoopSettings.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const outcome = await fixture.port.agentLoopSettings.mutate(
    { maxParallelToolCalls: { kind: 'set', value: 4 } }, opened.revision, opened.generation,
  )
  assert.equal(outcome.kind, 'outcome-unconfirmed')
  assert.equal(fixture.calls.length, 1)
  const readback = fixture.port.agentLoopSettings.read()
  assert.equal(readback.kind, 'ready')
  if (readback.kind === 'ready') assert.equal(readback.effective.maxParallelToolCalls, 4)
})
