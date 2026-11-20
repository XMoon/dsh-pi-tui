/** Remote per-package extension-config adapter contract evidence over the production mirror. */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { test } from 'node:test'
import {
  RemoteConfigPort,
  type RemoteConfigRuntimeSource,
  type RemoteSettingsPathOp,
} from '../../../src/runtime/remote/config-remote.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'
import { extensionConfigRowId } from '../../../src/domain/extension-config/row-id.ts'

const PACKAGE_A = '@r8-pr1-fixture/a'
const PACKAGE_B = '@r8-pr1-fixture/b'
const NS_A = extensionConfigRowId(PACKAGE_A)
const NS_B = extensionConfigRowId(PACKAGE_B)

type Namespace = { ns: string; value?: unknown; base?: unknown; user?: unknown; revision?: number }

interface FixtureOptions {
  readonly namespaces?: readonly Namespace[]
  readonly failDescribeAfterWrite?: boolean
  readonly initialDescribeFailure?: boolean
  readonly mutateFailure?: { readonly code: string; readonly message: string }
  readonly applyBeforeFailure?: boolean
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = root
  for (const key of path.slice(0, -1)) {
    const child = plainRecord(node[key])
    if (child === undefined) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path[path.length - 1]!] = clone(value)
}

function deletePath(root: Record<string, unknown>, path: readonly string[]): void {
  let node = root
  for (const key of path.slice(0, -1)) {
    const child = plainRecord(node[key])
    if (child === undefined) return
    node = child
  }
  Reflect.deleteProperty(node, path[path.length - 1]!)
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) node = plainRecord(node)?.[key]
  return node
}

function merge(base: unknown, user: unknown): unknown {
  const baseRecord = plainRecord(base)
  const userRecord = plainRecord(user)
  if (baseRecord === undefined || userRecord === undefined) return user
  const merged: Record<string, unknown> = { ...baseRecord }
  for (const [key, value] of Object.entries(userRecord)) {
    merged[key] = plainRecord(merged[key]) !== undefined && plainRecord(value) !== undefined
      ? merge(merged[key], value)
      : value
  }
  return merged
}

function applyMutation(target: Namespace, ops: readonly RemoteSettingsPathOp[]): void {
  const user = clone(plainRecord(target.user) ?? {}) as Record<string, unknown>
  const base = plainRecord(target.base) ?? {}
  for (const op of ops) {
    if (op.op === 'set') {
      setPath(user, op.path, op.value)
    } else {
      const inherited = valueAt(base, op.path)
      if (inherited === undefined) deletePath(user, op.path)
      else setPath(user, op.path, inherited)
    }
  }
  target.user = isDeepStrictEqual(user, base) ? {} : user
  target.value = merge(base, target.user)
  target.revision = (target.revision ?? 0) + 1
}

function defaultNamespaces(): Namespace[] {
  return [
    { ns: NS_A, base: { data: { label: 'alpha', limit: 3 } }, user: {}, value: { data: { label: 'alpha', limit: 3 } }, revision: 4 },
    { ns: NS_B, base: { data: { label: 'bravo', limit: 7 } }, user: {}, value: { data: { label: 'bravo', limit: 7 } }, revision: 9 },
  ]
}

function makePort(options: FixtureOptions = {}) {
  let snapshot: RemoteConnectionGeneration | undefined = { id: 1 } as RemoteConnectionGeneration
  const generationListeners = new Set<() => void>()
  const namespaces: Namespace[] = clone([...(options.namespaces ?? defaultNamespaces())])
  const calls: Array<{ ns: string; ops: readonly RemoteSettingsPathOp[]; revision: number | undefined }> = []
  let describeCalls = 0
  let failNextDescribe = options.initialDescribeFailure === true
  let holdNextMutation: { entered: () => void; released: Promise<void> } | undefined
  let holdNextDescribe: { entered: () => void; released: Promise<void> } | undefined

  const settings = {
    describe: async () => {
      describeCalls += 1
      if (holdNextDescribe !== undefined) {
        const held = holdNextDescribe
        holdNextDescribe = undefined
        held.entered()
        await held.released
      }
      if (failNextDescribe) {
        failNextDescribe = false
        return { ok: false as const, error: { code: 'gateway/internal', message: 'settings read lost' } }
      }
      return { ok: true as const, value: { writable: true, hasDocument: true, namespaces: clone(namespaces) } }
    },
    update: async () => ({ ok: true as const, value: {} }),
    replace: async () => ({ ok: true as const, value: {} }),
    mutate: async (ns: string, ops: readonly RemoteSettingsPathOp[], revision: number | undefined) => {
      calls.push({ ns, ops: clone(ops), revision })
      if (holdNextMutation !== undefined) {
        const held = holdNextMutation
        holdNextMutation = undefined
        held.entered()
        await held.released
      }
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
    advanceGeneration() {
      snapshot = { id: 2 } as RemoteConnectionGeneration
      for (const listener of [...generationListeners]) listener()
    },
    disconnect() {
      snapshot = undefined
      for (const listener of [...generationListeners]) listener()
    },
    holdNextDescribe() {
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      holdNextDescribe = { entered: enter, released }
      return { entered, release }
    },
    holdNextMutation() {
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      holdNextMutation = { entered: enter, released }
      return { entered, release }
    },
  }
}

test('the ONE mirror projects A and B independently with detached data projections', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  assert.equal(fixture.describeCalls, 1)
  const a = fixture.port.extensionConfigs.read(PACKAGE_A)
  const b = fixture.port.extensionConfigs.read(PACKAGE_B)
  assert.equal(a.kind, 'ready')
  assert.equal(b.kind, 'ready')
  if (a.kind !== 'ready' || b.kind !== 'ready') return
  assert.equal(a.generation, fixture.generationIdentity)
  assert.equal(a.revision, 4)
  assert.deepEqual(a.effective, { label: 'alpha', limit: 3 })
  assert.deepEqual(a.inherited, { label: 'alpha', limit: 3 })
  assert.equal(a.user, undefined)
  assert.equal(a.userDataPresent, false)
  assert.equal(b.revision, 9)
  assert.deepEqual(b.effective, { label: 'bravo', limit: 7 })
})

test('a nested set dispatches one exact data-relative batch and leaves B untouched', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const opened = fixture.port.extensionConfigs.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.deepEqual(await fixture.port.extensionConfigs.mutate(PACKAGE_A, [
    { op: 'set', path: ['label'], value: 'alpha-2' },
    { op: 'unset', path: ['limit'] },
  ], opened.revision, opened.generation), { kind: 'accepted' })
  assert.deepEqual(fixture.calls, [{
    ns: NS_A,
    ops: [
      { op: 'set', path: ['data', 'label'], value: 'alpha-2' },
      { op: 'unset', path: ['data', 'limit'] },
    ],
    revision: 4,
  }])
  const after = fixture.port.extensionConfigs.read(PACKAGE_A)
  const b = fixture.port.extensionConfigs.read(PACKAGE_B)
  assert.equal(after.kind, 'ready')
  assert.equal(b.kind, 'ready')
  if (after.kind !== 'ready' || b.kind !== 'ready') return
  assert.deepEqual(after.effective, { label: 'alpha-2', limit: 3 })
  assert.deepEqual(b.effective, { label: 'bravo', limit: 7 })
})

test('an old generation write queued behind another write is rejected before dispatch', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const a = fixture.port.extensionConfigs.read(PACKAGE_A)
  const b = fixture.port.extensionConfigs.read(PACKAGE_B)
  assert.equal(a.kind, 'ready')
  assert.equal(b.kind, 'ready')
  if (a.kind !== 'ready' || b.kind !== 'ready') return

  const held = fixture.holdNextMutation()
  const first = fixture.port.extensionConfigs.mutate(PACKAGE_A, [{ op: 'set', path: ['label'], value: 'first' }], a.revision, a.generation)
  assert.equal(fixture.port.hasUnsettledWrites(), true)
  await held.entered
  const queued = fixture.port.extensionConfigs.mutate(PACKAGE_B, [{ op: 'set', path: ['limit'], value: 8 }], b.revision, b.generation)
  assert.equal(fixture.port.hasUnsettledWrites(), true)
  fixture.advanceGeneration()
  held.release()
  // The first write was already dispatched; its settlement belongs to the old
  // generation, so its read-back cannot prove acceptance on the new one.
  assert.deepEqual(await first, { kind: 'outcome-unconfirmed', reason: 'the Host authority changed while the write settled' })
  assert.equal((await queued).kind, 'rejected')
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0]?.ns, NS_A)
  assert.equal(fixture.port.hasUnsettledWrites(), false)
})

test('a stale revision conflicts before dispatch', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const opened = fixture.port.extensionConfigs.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.equal((await fixture.port.extensionConfigs.mutate(
    PACKAGE_A,
    [{ op: 'set', path: ['limit'], value: 99 }],
    opened.revision + 1,
    opened.generation,
  )).kind, 'conflict')
  assert.equal(fixture.calls.length, 0)
})

test('a committed write whose post-write describe fails is outcome-unconfirmed and stale', async () => {
  const fixture = makePort({ failDescribeAfterWrite: true })
  await fixture.port.describe()
  const opened = fixture.port.extensionConfigs.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const outcome = await fixture.port.extensionConfigs.mutate(PACKAGE_A, [{ op: 'set', path: ['label'], value: 'persisted' }], opened.revision, opened.generation)
  assert.equal(outcome.kind, 'outcome-unconfirmed')
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.port.extensionConfigs.read(PACKAGE_A).kind, 'stale')
})

test('an applied-then-failed official write stays outcome-unconfirmed and is never replayed', async () => {
  const fixture = makePort({
    mutateFailure: { code: 'settings/rejected', message: 'Loader reconcile failed after persistence' },
    applyBeforeFailure: true,
  })
  await fixture.port.describe()
  const opened = fixture.port.extensionConfigs.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.equal((await fixture.port.extensionConfigs.mutate(PACKAGE_A, [
    { op: 'set', path: ['label'], value: 'persisted-before-error' },
  ], opened.revision, opened.generation)).kind, 'outcome-unconfirmed')
  assert.equal(fixture.calls.length, 1)
  const readBack = fixture.port.extensionConfigs.read(PACKAGE_A)
  assert.equal(readBack.kind, 'ready')
  if (readBack.kind !== 'ready') return
  assert.deepEqual(readBack.effective, { label: 'persisted-before-error', limit: 3 })
})

test('a current mirror becomes stale while a refresh is in flight, then recovers', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const held = fixture.holdNextDescribe()
  fixture.advanceGeneration()
  assert.equal(fixture.port.extensionConfigs.read(PACKAGE_A).kind, 'stale')
  held.release()
  await new Promise(resolve => setTimeout(resolve, 0))
  const recovered = fixture.port.extensionConfigs.read(PACKAGE_A)
  assert.equal(recovered.kind, 'ready')
  if (recovered.kind !== 'ready') return
  assert.equal(recovered.generation, fixture.generationIdentity)
})

test('disconnect is unavailable; a failed initial read is unreadable; missing rows are unavailable', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  fixture.disconnect()
  assert.equal(fixture.port.extensionConfigs.read(PACKAGE_A).kind, 'unavailable')
  assert.equal((await fixture.port.extensionConfigs.mutate(PACKAGE_A, [{ op: 'set', path: ['label'], value: 1 }], 4, {})).kind, 'rejected')

  const failed = makePort({ initialDescribeFailure: true })
  await assert.rejects(failed.port.describe())
  assert.equal(failed.port.extensionConfigs.read(PACKAGE_A).kind, 'unreadable')

  const missing = makePort({ namespaces: [] })
  await missing.port.describe()
  assert.equal(missing.port.extensionConfigs.read(PACKAGE_A).kind, 'unavailable')
})

test('refresh drives the SAME shared describe rather than a second mirror', async () => {
  const fixture = makePort()
  await fixture.port.describe()
  const before = fixture.describeCalls
  await fixture.port.extensionConfigs.refresh()
  assert.equal(fixture.describeCalls, before + 1)
})
