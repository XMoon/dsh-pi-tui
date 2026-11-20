/** Direct per-package extension-config adapter contract evidence. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import {
  DirectConfigPort,
  DirectExtensionConfigsConfig,
  type HostContextLike,
  type SettingsMutationOp,
  type SettingsServiceLike,
} from '../../../src/runtime/direct/config-direct.ts'
import { extensionConfigRowId } from '../../../src/domain/extension-config/row-id.ts'

const PACKAGE_A = '@r8-pr1-fixture/a'
const PACKAGE_B = '@r8-pr1-fixture/b'
const NS_A = extensionConfigRowId(PACKAGE_A)
const NS_B = extensionConfigRowId(PACKAGE_B)

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

class SettingsFixture implements SettingsServiceLike {
  descriptors: Descriptor[]
  describeCalls = 0
  readonly mutations: Array<{ ns: string; ops: readonly SettingsMutationOp[]; revision: number | undefined }> = []
  describeFailure: Error | undefined
  mutateFailureAfterApply: Error | undefined
  mutateFailureBeforeApply: Error | undefined

  constructor(descriptors: Descriptor[]) {
    this.descriptors = clone(descriptors)
  }

  describe(): readonly Descriptor[] {
    this.describeCalls += 1
    if (this.describeFailure !== undefined) throw this.describeFailure
    return clone(this.descriptors)
  }

  async mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
    this.mutations.push({ ns, ops: clone(ops), revision })
    if (this.mutateFailureBeforeApply !== undefined) throw this.mutateFailureBeforeApply
    const descriptor = this.descriptors.find(item => item.ns === ns)
    if (descriptor === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    if (revision !== descriptor.revision) {
      throw Object.assign(new Error('settings namespace changed since it was read'), { code: 'SETTINGS_CONFLICT' })
    }
    const user = clone(plainRecord(descriptor.user) ?? {}) as Record<string, unknown>
    const base = plainRecord(descriptor.base) ?? {}
    for (const op of ops) {
      if (op.op === 'set') {
        setPath(user, op.path, op.value)
      } else {
        const inherited = valueAt(base, op.path)
        if (inherited === undefined) deletePath(user, op.path)
        else setPath(user, op.path, inherited)
      }
    }
    descriptor.user = user
    descriptor.value = merge(base, user)
    descriptor.revision = (descriptor.revision ?? 0) + 1
    if (this.mutateFailureAfterApply !== undefined) throw this.mutateFailureAfterApply
  }
}

class CordisSettingsFixture extends Service {
  private readonly backing: SettingsFixture

  constructor(ctx: Context, backing: SettingsFixture) {
    super(ctx, 'settings')
    this.backing = backing
  }

  describe(): readonly Descriptor[] {
    return this.backing.describe()
  }

  mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
    return this.backing.mutate(ns, ops, revision)
  }
}

function contextWith(settings: unknown): HostContextLike {
  return { get: name => name === 'settings' ? settings : undefined }
}

function defaultDescriptors(): Descriptor[] {
  return [
    { ns: NS_A, base: { data: { label: 'alpha', limit: 3 } }, user: {}, value: { data: { label: 'alpha', limit: 3 } }, revision: 4 },
    { ns: NS_B, base: { data: { label: 'bravo', limit: 7 } }, user: {}, value: { data: { label: 'bravo', limit: 7 } }, revision: 9 },
  ]
}

test('one authoritative describe projects A and B independently with detached data', () => {
  const settings = new SettingsFixture(defaultDescriptors())
  const config = new DirectExtensionConfigsConfig(contextWith(settings))
  const a = config.read(PACKAGE_A)
  assert.equal(settings.describeCalls, 1)
  assert.equal(a.kind, 'ready')
  if (a.kind !== 'ready') return
  assert.equal(a.packageName, PACKAGE_A)
  assert.equal(a.revision, 4)
  assert.deepEqual(a.effective, { label: 'alpha', limit: 3 })
  assert.deepEqual(a.inherited, { label: 'alpha', limit: 3 })
  assert.equal(a.user, undefined)
  assert.equal(a.userDataPresent, false)

  const b = config.read(PACKAGE_B)
  assert.equal(settings.describeCalls, 2)
  assert.equal(b.kind, 'ready')
  if (b.kind !== 'ready') return
  assert.equal(b.revision, 9)
  assert.deepEqual(b.effective, { label: 'bravo', limit: 7 })

  // The projection is an owned tree: mutating it cannot touch the descriptor.
  ;(a.effective as { label: string }).label = 'mutated'
  assert.deepEqual(settings.descriptors[0]?.value, { data: { label: 'alpha', limit: 3 } })
})

test('data null, false, 0, arrays and absent USER data keep their exact identity', () => {
  const descriptors: Descriptor[] = [
    { ns: NS_A, base: { data: { nested: { limit: 1 } } }, user: { data: null }, value: { data: null }, revision: 1 },
    { ns: NS_B, base: { data: { nested: { limit: 1 } } }, user: { data: false }, value: { data: false }, revision: 2 },
    { ns: extensionConfigRowId('@r8-pr1-fixture/c'), base: { data: [1, 2] }, user: { data: 0 }, value: { data: 0 }, revision: 3 },
    { ns: extensionConfigRowId('@r8-pr1-fixture/d'), base: { data: { nested: { limit: 1 } } }, user: {}, value: { data: { nested: { limit: 1 } } }, revision: 5 },
  ]
  const config = new DirectExtensionConfigsConfig(contextWith(new SettingsFixture(descriptors)))
  const nullRead = config.read(PACKAGE_A)
  const falseRead = config.read(PACKAGE_B)
  const arrayRead = config.read('@r8-pr1-fixture/c')
  const absentRead = config.read('@r8-pr1-fixture/d')
  assert.equal(nullRead.kind === 'ready' ? nullRead.effective : 'unexpected', null)
  assert.equal(falseRead.kind === 'ready' ? falseRead.effective : 'unexpected', false)
  assert.equal(arrayRead.kind === 'ready' ? arrayRead.effective : 'unexpected', 0)
  assert.deepEqual(arrayRead.kind === 'ready' ? arrayRead.inherited : undefined, [1, 2])
  assert.equal(absentRead.kind === 'ready' ? absentRead.userDataPresent : 'unexpected', false)
})

test('nested set and whole-data unset map to exact relative paths and one CAS batch', async () => {
  const settings = new SettingsFixture(defaultDescriptors())
  const config = new DirectExtensionConfigsConfig(contextWith(settings))
  const opened = config.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return

  assert.deepEqual(await config.mutate(PACKAGE_A, [
    { op: 'set', path: ['label'], value: 'alpha-2' },
    { op: 'set', path: ['nested', 'flag'], value: false },
  ], opened.revision, opened.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations[0], {
    ns: NS_A,
    ops: [
      { op: 'set', path: ['data', 'label'], value: 'alpha-2' },
      { op: 'set', path: ['data', 'nested', 'flag'], value: false },
    ],
    revision: 4,
  })
  const afterSet = config.read(PACKAGE_A)
  assert.equal(afterSet.kind, 'ready')
  if (afterSet.kind !== 'ready') return
  assert.deepEqual(afterSet.effective, { label: 'alpha-2', limit: 3, nested: { flag: false } })
  assert.equal(afterSet.userDataPresent, true)
  const b = config.read(PACKAGE_B)
  assert.equal(b.kind, 'ready')
  if (b.kind !== 'ready') return
  assert.deepEqual(b.effective, { label: 'bravo', limit: 7 })
  assert.deepEqual(b.user, undefined)

  assert.deepEqual(await config.mutate(PACKAGE_A, [
    { op: 'unset', path: [] },
  ], afterSet.revision, afterSet.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations[1], {
    ns: NS_A,
    ops: [{ op: 'unset', path: ['data'] }],
    revision: 5,
  })
  const reset = config.read(PACKAGE_A)
  assert.equal(reset.kind, 'ready')
  if (reset.kind !== 'ready') return
  assert.deepEqual(reset.effective, { label: 'alpha', limit: 3 })
  // The official `SettingsForms.mutate` materializes an inherited value into
  // the USER patch when the base layer owns the field; the effective value is
  // the contract, own-field presence is reported truthfully.
  assert.equal(reset.userDataPresent, true)

  const afterUnsetField = config.read(PACKAGE_A)
  assert.equal(afterUnsetField.kind, 'ready')
  if (afterUnsetField.kind !== 'ready') return
  assert.deepEqual(await config.mutate(PACKAGE_A, [
    { op: 'unset', path: ['nested', 'flag'] },
  ], afterUnsetField.revision, afterUnsetField.generation), { kind: 'accepted' })
  const removed = config.read(PACKAGE_A)
  assert.equal(removed.kind, 'ready')
  if (removed.kind !== 'ready') return
  assert.deepEqual(removed.user, { label: 'alpha', limit: 3 })
})

test('a stale revision is a conflict before dispatch and changes no row', async () => {
  const settings = new SettingsFixture(defaultDescriptors())
  const config = new DirectExtensionConfigsConfig(contextWith(settings))
  const opened = config.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const outcome = await config.mutate(PACKAGE_A, [{ op: 'set', path: ['limit'], value: 99 }], opened.revision + 1, opened.generation)
  assert.equal(outcome.kind, 'conflict')
  assert.equal(settings.mutations.length, 0)
  assert.deepEqual(settings.descriptors[0]?.value, { data: { label: 'alpha', limit: 3 } })
})

test('a post-persist failure is outcome-unconfirmed, the value is readable and is never replayed', async () => {
  const settings = new SettingsFixture(defaultDescriptors())
  settings.mutateFailureAfterApply = new Error('Loader reconciliation failed after persistence')
  const config = new DirectExtensionConfigsConfig(contextWith(settings))
  const opened = config.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const outcome = await config.mutate(PACKAGE_A, [{ op: 'set', path: ['label'], value: 'persisted' }], opened.revision, opened.generation)
  assert.equal(outcome.kind, 'outcome-unconfirmed')
  assert.equal(settings.mutations.length, 1)
  const readBack = config.read(PACKAGE_A)
  assert.equal(readBack.kind, 'ready')
  if (readBack.kind !== 'ready') return
  assert.deepEqual(readBack.effective, { label: 'persisted', limit: 3 })
})

test('a HOME/CLI overlay refusal cannot be claimed as a clean rejection while B stays writable', async () => {
  const settings = new SettingsFixture(defaultDescriptors())
  settings.mutateFailureBeforeApply = new Error('Configuration for "pi-tui-extcfg-x" is overridden by a home patch or command-line overlay')
  const config = new DirectExtensionConfigsConfig(contextWith(settings))
  const opened = config.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.equal((await config.mutate(PACKAGE_A, [{ op: 'set', path: ['label'], value: 'blocked' }], opened.revision, opened.generation)).kind, 'outcome-unconfirmed')
  settings.mutateFailureBeforeApply = undefined
  const b = config.read(PACKAGE_B)
  assert.equal(b.kind, 'ready')
  if (b.kind !== 'ready') return
  assert.deepEqual(await config.mutate(PACKAGE_B, [{ op: 'set', path: ['limit'], value: 8 }], b.revision, b.generation), { kind: 'accepted' })
})

test('real Cordis proxies keep the raw settings authority as the generation fence', async () => {
  const ctx = new Context()
  const backing = new SettingsFixture(defaultDescriptors())
  const raw = new CordisSettingsFixture(ctx, backing)
  const firstProxy = ctx.get('settings') as unknown as { readonly [symbols.original]?: object }
  const nextProxy = ctx.get('settings') as unknown as { readonly [symbols.original]?: object }
  assert.notEqual(firstProxy, nextProxy)
  assert.equal(firstProxy[symbols.original], raw)

  const config = new DirectExtensionConfigsConfig(ctx)
  const opened = config.read(PACKAGE_A)
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.equal(opened.generation, raw)

  const replacement = new SettingsFixture(defaultDescriptors())
  ctx.set('settings', replacement)
  assert.equal((await config.mutate(PACKAGE_A, [{ op: 'set', path: ['limit'], value: 2 }], opened.revision, opened.generation)).kind, 'rejected')
  assert.equal(backing.mutations.length, 0)
  assert.equal(replacement.mutations.length, 0)
})

test('missing service, missing row and malformed projections are honest non-ready reads', async () => {
  const noService = new DirectExtensionConfigsConfig(contextWith(undefined))
  assert.equal(noService.read(PACKAGE_A).kind, 'unavailable')

  const noRow = new DirectExtensionConfigsConfig(contextWith(new SettingsFixture([])))
  assert.equal(noRow.read(PACKAGE_A).kind, 'unavailable')
  assert.equal((await noRow.mutate(PACKAGE_A, [{ op: 'set', path: ['label'], value: 1 }], 0, {})).kind, 'rejected')

  const badRevision = new SettingsFixture([{ ns: NS_A, value: { data: 1 }, base: {}, user: {}, revision: -1 }])
  assert.equal(new DirectExtensionConfigsConfig(contextWith(badRevision)).read(PACKAGE_A).kind, 'unreadable')

  const badData = new SettingsFixture([{ ns: NS_A, value: { data: new Date() }, base: {}, user: {}, revision: 1 }])
  assert.equal(new DirectExtensionConfigsConfig(contextWith(badData)).read(PACKAGE_A).kind, 'unreadable')

  const throwing = new SettingsFixture(defaultDescriptors())
  throwing.describeFailure = new Error('descriptor read lost')
  assert.equal(new DirectExtensionConfigsConfig(contextWith(throwing)).read(PACKAGE_A).kind, 'unreadable')

  const emptyOps = new SettingsFixture(defaultDescriptors())
  const config = new DirectExtensionConfigsConfig(contextWith(emptyOps))
  const read = config.read(PACKAGE_A)
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal((await config.mutate(PACKAGE_A, [], read.revision, read.generation)).kind, 'rejected')
})

test('DirectConfigPort wires the same extension sub-domain', () => {
  const settings = new SettingsFixture(defaultDescriptors())
  const port = new DirectConfigPort(contextWith(settings), undefined, () => undefined)
  const read = port.extensionConfigs.read(PACKAGE_B)
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.revision, 9)
})
