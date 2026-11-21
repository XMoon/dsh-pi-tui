/**
 * Cross-adapter parity for the per-package extension-config port.
 *
 * Both adapters run the SAME semantic case list over structurally equivalent
 * official Settings descriptors. This is L4 semantic parity only: it never
 * substitutes for the real generated-Client/real Host chain in
 * `test/integration/extension-config-settings-pr2.test.ts`.
 */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { test } from 'node:test'
import {
  DirectExtensionConfigsConfig,
  type HostContextLike,
  type SettingsMutationOp,
  type SettingsServiceLike,
} from '../../../src/runtime/direct/config-direct.ts'
import {
  RemoteConfigPort,
  type RemoteConfigRuntimeSource,
  type RemoteSettingsPathOp,
} from '../../../src/runtime/remote/config-remote.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'
import { extensionConfigRowId } from '../../../src/domain/extension-config/row-id.ts'
import type { ExtensionConfigRead, ExtensionConfigsConfig } from '../../../src/runtime/config-port.ts'
import {
  commitPersistedSetting,
  readPersistedSetting,
  type PersistedSettingRecord,
} from '../../../src/app/client-extensions/persisted-setting.ts'

const A = '@r8-pr1-fixture/a'
const B = '@r8-pr1-fixture/b'
const C = '@r8-pr1-fixture/c'
const D = '@r8-pr1-fixture/d'
const E = '@r8-pr1-fixture/e'
const G = '@r8-pr1-fixture/g'

type Descriptor = { ns: string; value?: unknown; base?: unknown; user?: unknown; revision?: number }

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

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) node = plainRecord(node)?.[key]
  return node
}

function applyOps(descriptor: Descriptor, ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]): void {
  const user = clone(plainRecord(descriptor.user) ?? {}) as Record<string, unknown>
  const base = plainRecord(descriptor.base) ?? {}
  for (const op of ops) {
    if (op.op === 'set') {
      setPath(user, op.path, op.value)
    } else {
      // Official SettingsForms: an object-leaf unset whose inherited value
      // exists writes that inherited value; only an absent inherited leaf is
      // deleted. ConfigEditor then keeps the USER config while any sibling
      // override remains.
      const inherited = valueAt(base, op.path)
      if (inherited === undefined) deletePath(user, op.path)
      else setPath(user, op.path, inherited)
    }
  }
  descriptor.user = isDeepStrictEqual(user, base) ? {} : user
  descriptor.value = merge(base, descriptor.user)
  descriptor.revision = (descriptor.revision ?? 0) + 1
}

function initialDescriptors(): Descriptor[] {
  return [
    { ns: extensionConfigRowId(A), base: { data: { label: 'alpha', nested: { theme: 'light' }, limit: 3 } }, user: {}, value: { data: { label: 'alpha', nested: { theme: 'light' }, limit: 3 } }, revision: 4 },
    { ns: extensionConfigRowId(B), base: { data: { label: 'bravo', limit: 7 } }, user: {}, value: { data: { label: 'bravo', limit: 7 } }, revision: 9 },
    { ns: extensionConfigRowId(C), base: { data: { label: 'charlie' } }, user: { data: null }, value: { data: null }, revision: 1 },
    { ns: extensionConfigRowId(D), base: { data: { label: 'delta' } }, user: { data: false }, value: { data: false }, revision: 2 },
    { ns: extensionConfigRowId(E), base: { data: [1, 2] }, user: { data: 0 }, value: { data: 0 }, revision: 3 },
    { ns: extensionConfigRowId(G), base: { data: { label: 'golf' } }, user: { other: true }, value: { data: { label: 'golf' } }, revision: 6 },
  ]
}

function normalized(read: ExtensionConfigRead) {
  if (read.kind !== 'ready') return { kind: read.kind }
  return {
    kind: read.kind,
    packageName: read.packageName,
    revision: read.revision,
    effective: read.effective,
    inherited: read.inherited,
    user: read.user,
    userDataPresent: read.userDataPresent,
  }
}

interface AdapterUnderTest {
  prime(): Promise<void>
  read(packageName: string): ExtensionConfigRead
  mutate(packageName: string, ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[], revision: number, generation: object): Promise<string>
  advanceHostRevision(packageName: string): void
  readonly config: ExtensionConfigsConfig
}

function directAdapter(): AdapterUnderTest {
  const descriptors = initialDescriptors()
  const settings: SettingsServiceLike = {
    describe: () => clone(descriptors),
    async mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
      const descriptor = descriptors.find(item => item.ns === ns)
      if (descriptor === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
      if (revision !== descriptor.revision) {
        throw Object.assign(new Error('settings namespace changed since it was read'), { code: 'SETTINGS_CONFLICT' })
      }
      applyOps(descriptor, ops)
    },
  }
  const ctx: HostContextLike = { get: name => name === 'settings' ? settings : undefined }
  const config = new DirectExtensionConfigsConfig(ctx)
  return {
    async prime() {},
    read: packageName => config.read(packageName),
    async mutate(packageName, ops, revision, generation) {
      return (await config.mutate(packageName, ops as never, revision, generation)).kind
    },
    advanceHostRevision(packageName) {
      const descriptor = descriptors.find(item => item.ns === extensionConfigRowId(packageName))!
      descriptor.revision = (descriptor.revision ?? 0) + 1
    },
    config,
  }
}

function remoteAdapter(): AdapterUnderTest {
  const namespaces: Descriptor[] = initialDescriptors()
  let snapshot: RemoteConnectionGeneration | undefined = { id: 1 } as RemoteConnectionGeneration
  const generationListeners = new Set<() => void>()
  const remote = {
    settings: {
      describe: async () => ({ ok: true as const, value: { writable: true, hasDocument: true, namespaces: clone(namespaces) } }),
      update: async () => ({ ok: true as const, value: {} }),
      replace: async () => ({ ok: true as const, value: {} }),
      mutate: async (ns: string, ops: readonly RemoteSettingsPathOp[], revision: number | undefined) => {
        const descriptor = namespaces.find(item => item.ns === ns)
        if (descriptor === undefined) return { ok: false as const, error: { code: 'settings/absent', message: 'no section' } }
        if (revision !== descriptor.revision) {
          return { ok: false as const, error: { code: 'settings/conflict', message: 'revision changed since it was read' } }
        }
        applyOps(descriptor, ops)
        return { ok: true as const, value: {} }
      },
    },
    credentials: {
      describe: async () => ({ ok: true as const, value: {} }),
      set: async () => ({ ok: true as const, value: undefined }),
      unset: async () => ({ ok: true as const, value: undefined }),
    },
    commands: { execute: async () => ({ ok: true as const, value: undefined }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    $on: () => () => {},
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
    async prime() { await port.describe() },
    read: packageName => port.extensionConfigs.read(packageName),
    async mutate(packageName, ops, revision, generationToken) {
      return (await port.extensionConfigs.mutate(packageName, ops as never, revision, generationToken)).kind
    },
    advanceHostRevision(packageName) {
      const descriptor = namespaces.find(item => item.ns === extensionConfigRowId(packageName))!
      descriptor.revision = (descriptor.revision ?? 0) + 1
    },
    config: port.extensionConfigs,
  }
}

async function runSemanticCases(adapter: AdapterUnderTest) {
  // The Remote mirror needs its ONE initial authoritative read; Direct is
  // synchronous. This primer is outside the compared semantic case list.
  await adapter.prime()
  const log: unknown[] = []
  log.push(normalized(adapter.read(A)))
  log.push(normalized(adapter.read(B)))
  log.push(normalized(adapter.read(C)))
  log.push(normalized(adapter.read(D)))
  log.push(normalized(adapter.read(E)))
  log.push(normalized(adapter.read(G)))
  log.push(normalized(adapter.read('@r8-pr1-fixture/missing')))

  const openedA = adapter.read(A)
  assert.equal(openedA.kind, 'ready')
  if (openedA.kind !== 'ready') return log
  log.push(await adapter.mutate(A, [
    { op: 'set', path: ['nested', 'theme'], value: 'dark' },
    { op: 'set', path: ['enabled'], value: false },
  ], openedA.revision, openedA.generation))
  log.push(normalized(adapter.read(A)))
  log.push(normalized(adapter.read(B)))

  const openedB = adapter.read(B)
  assert.equal(openedB.kind, 'ready')
  if (openedB.kind !== 'ready') return log
  log.push(await adapter.mutate(B, [{ op: 'set', path: ['limit'], value: 9 }], openedB.revision, openedB.generation))
  log.push(normalized(adapter.read(A)))
  log.push(normalized(adapter.read(B)))

  const afterA = adapter.read(A)
  assert.equal(afterA.kind, 'ready')
  if (afterA.kind !== 'ready') return log
  log.push(await adapter.mutate(A, [{ op: 'unset', path: ['nested', 'theme'] }], afterA.revision, afterA.generation))
  log.push(normalized(adapter.read(A)))

  // A stale captured revision is a conflict and changes nothing.
  log.push(await adapter.mutate(A, [{ op: 'set', path: ['limit'], value: 100 }], openedA.revision, afterA.generation))
  log.push(normalized(adapter.read(A)))

  // An external Host revision change after the read is also a conflict.
  const raced = adapter.read(B)
  assert.equal(raced.kind, 'ready')
  if (raced.kind !== 'ready') return log
  adapter.advanceHostRevision(B)
  log.push(await adapter.mutate(B, [{ op: 'set', path: ['label'], value: 'raced' }], raced.revision, raced.generation))
  log.push(normalized(adapter.read(B)))
  return log
}

test('Direct and Remote produce the same semantic read/write/conflict results', async () => {
  const directLog = await runSemanticCases(directAdapter())
  const remoteLog = await runSemanticCases(remoteAdapter())
  assert.deepEqual(remoteLog, directLog)
})

test('persisted-setting adapter writes and resets ONE package USER field through the real Direct ConfigPort', async () => {
  const host = directAdapter()
  await host.prime()
  const recordA: PersistedSettingRecord = {
    id: 'r8-a-label',
    owner: '10:fixture-a',
    registrationToken: 1,
    mode: 'persisted',
    currentValue: 'alpha',
    persisted: {
      path: ['label'],
      choices: [
        { id: 'alpha', op: 'set', value: 'alpha' },
        { id: 'omega', op: 'set', value: 'omega' },
        { id: 'inherit', op: 'unset' },
      ],
    },
  }
  const recordB: PersistedSettingRecord = {
    id: 'r8-b-limit',
    owner: '11:fixture-b',
    registrationToken: 2,
    mode: 'persisted',
    currentValue: '7',
    persisted: {
      path: ['limit'],
      choices: [
        { id: 'seven', op: 'set', value: 7 },
        { id: 'eleven', op: 'set', value: 11 },
        { id: 'inherit', op: 'unset' },
      ],
    },
  }
  const ownerA = { packageName: A, entryId: 'entry-a', registrationToken: 1 }
  const ownerB = { packageName: B, entryId: 'entry-b', registrationToken: 2 }
  const openedA = readPersistedSetting(recordA, A, host.config)
  assert.equal(openedA.mode, 'ready')
  if (openedA.mode !== 'ready') return
  assert.equal(openedA.effective, 'alpha')
  assert.equal(openedA.userFieldPresent, false)
  const saved = await commitPersistedSetting(recordA, ownerA, 'omega', host.config, openedA.revision, openedA.generation)
  assert.deepEqual(saved, { outcome: 'verified' })
  const afterA = readPersistedSetting(recordA, A, host.config)
  assert.equal(afterA.mode, 'ready')
  if (afterA.mode !== 'ready') return
  assert.equal(afterA.effective, 'omega')
  assert.equal(afterA.userFieldPresent, true)
  // Writing A never changes B's own USER field or effective value.
  const afterB = readPersistedSetting(recordB, B, host.config)
  assert.equal(afterB.mode, 'ready')
  if (afterB.mode !== 'ready') return
  assert.equal(afterB.effective, 7)
  assert.equal(afterB.userFieldPresent, false)
  // Reset restores the inherited EFFECTIVE value. The official SettingsForms /
  // ConfigEditor path may keep A's USER leaf (label:'alpha') because the USER
  // config still differs from base in another field; the reset is verified by
  // effective == inherited, not by USER absence.
  const reset = await commitPersistedSetting(recordA, ownerA, 'inherit', host.config, afterA.revision, afterA.generation)
  assert.deepEqual(reset, { outcome: 'verified' })
  const afterReset = readPersistedSetting(recordA, A, host.config)
  assert.equal(afterReset.mode, 'ready')
  if (afterReset.mode !== 'ready') return
  assert.equal(afterReset.userFieldPresent, true)
  assert.equal(afterReset.user, 'alpha')
  assert.equal(afterReset.effective, 'alpha')
  assert.equal(afterReset.inherited, 'alpha')
  assert.equal(afterReset.overriddenDisplay, 'No')
  assert.equal(afterReset.candidateId, 'inherit')
  // The stale pre-save revision is a definite conflict, never an overwrite.
  const stale = await commitPersistedSetting(recordA, ownerA, 'omega', host.config, openedA.revision, openedA.generation)
  assert.equal(stale.outcome, 'not-saved')
  assert.match(stale.reason ?? '', /Host Config changed/u)
  // B can still be written independently.
  const openedB = readPersistedSetting(recordB, B, host.config)
  assert.equal(openedB.mode, 'ready')
  if (openedB.mode !== 'ready') return
  assert.deepEqual(
    await commitPersistedSetting(recordB, ownerB, 'eleven', host.config, openedB.revision, openedB.generation),
    { outcome: 'verified' },
  )
})
