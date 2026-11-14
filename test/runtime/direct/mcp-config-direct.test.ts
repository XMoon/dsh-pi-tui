/**
 * FR4 — the Direct MCP server configuration read/write over the official
 * `settings` forms service.
 *
 * Evidence level: adapter contract (L2). The settings double below implements
 * the INSTALLED 0.2.2-rc.3 `SettingsForms` contract that this adapter depends
 * on (one `describe()` carrying `value`/`base`/`user`/`revision`; path-op
 * `mutate` where an `unset` of a path the BASE holds restores the inherited
 * value, and an `unset` of a user-only path removes it). The real Host
 * composition (Loader/ConfigEditor/profile bytes/manager reconcile) is
 * qualified by `mcp-settings-mounted.test.ts` and the split-process smoke.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/direct/mcp-config-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectMcpServerConfigurationConfig,
  DirectMcpServerSourcesConfig,
  type HostContextLike,
  type SettingsServiceLike,
} from '../../../src/runtime/direct/config-direct.ts'

/** The generation identity both FR3 and FR4 reads are bound to. */
const GENERATION = Object.freeze({ id: 'host-a' })

/** A settings double with the INSTALLED official `mutate` semantics. */
class FakeSettingsForms implements SettingsServiceLike {
  base: Record<string, unknown>
  user: Record<string, unknown>
  revision = 1
  readonly mutations: Array<{ ns: string; ops: readonly unknown[]; revision: number | undefined }> = []
  failWith: Error | undefined

  constructor(base: Record<string, unknown> = { servers: {} }, user: Record<string, unknown> = { servers: {} }) {
    this.base = structuredClone(base)
    this.user = structuredClone(user)
  }

  describe(): readonly { ns: string; value: unknown; base?: unknown; user?: unknown; revision?: number }[] {
    return [{
      ns: 'mcp-manager',
      value: mergeLayers(this.base, this.user),
      base: structuredClone(this.base),
      user: structuredClone(this.user),
      revision: this.revision,
    }]
  }

  async mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[] | readonly ({ op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] })[], expectedRevision?: number): Promise<void> {
    this.mutations.push({ ns, ops: [...ops], revision: expectedRevision })
    if (this.failWith !== undefined) throw this.failWith
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      throw Object.assign(new Error(`settings namespace "mcp-manager" changed since it was read (expected revision ${String(expectedRevision)}, now ${String(this.revision)})`), {
        code: 'SETTINGS_CONFLICT',
        expected: expectedRevision,
        actual: this.revision,
      })
    }
    for (const op of ops) {
      if (op.op === 'set') {
        applySet(this.user, op.path, op.value)
        continue
      }
      // The official rule: a path the BASE holds is restored from base; a
      // user-only path is removed from the user layer.
      const inherited = readOwn(this.base, op.path)
      if (inherited === undefined) applyUnset(this.user, op.path)
      else applySet(this.user, op.path, inherited)
    }
    this.revision += 1
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isRecord(under) || !isRecord(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) merged[key] = mergeLayers(under[key], value)
  return merged
}

function applySet(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    Object.defineProperty(target, head, { value, enumerable: true, writable: true, configurable: true })
    return
  }
  const child = isRecord(target[head]) ? target[head] as Record<string, unknown> : {}
  Object.defineProperty(target, head, { value: child, enumerable: true, writable: true, configurable: true })
  applySet(child, rest, value)
}

function applyUnset(target: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path
  if (head === undefined) return
  if (rest.length === 0) {
    Reflect.deleteProperty(target, head)
    return
  }
  const child = target[head]
  if (isRecord(child)) applyUnset(child, rest)
}

function readOwn(source: unknown, path: readonly string[]): unknown {
  let node: unknown = source
  for (const key of path) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return node
}

function contextWith(settings: unknown): HostContextLike {
  return { get: name => (name === 'settings' ? settings : undefined) }
}

function makeConfig(settings: unknown, generation: () => object = () => GENERATION): DirectMcpServerConfigurationConfig {
  return new DirectMcpServerConfigurationConfig(contextWith(settings), generation)
}

/** One stdio entry value. */
function stdioEntry(command = '/bin/echo', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { transport: 'stdio', command, args: [], env: {}, cwd: '', enabled: true, ...extra }
}

test('one descriptor classifies user-added, inherited and overridden entries', () => {
  const settings = new FakeSettingsForms(
    { servers: { inherited: stdioEntry('/base'), both: stdioEntry('/base') } },
    { servers: { both: { enabled: false }, mine: stdioEntry('/mine') } },
  )
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.generation, GENERATION)
  assert.equal(read.revision, 1)
  assert.deepEqual(read.entries.map(entry => [entry.name, entry.provenance]), [
    ['inherited', 'inherited'],
    ['both', 'overridden'],
    ['mine', 'user-added'],
  ])
  // The effective facts come from the SAME descriptor (base merged with user).
  const both = read.entries.find(entry => entry.name === 'both')
  assert.equal(both?.effective.enabled, false)
  const inherited = read.entries.find(entry => entry.name === 'inherited')
  assert.equal(inherited?.effective.command, '/base')
})

test('a name in neither layer is not config-owned and is absent from the entries', () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  // A plugin-registered server never appears in the settings descriptor at all.
  const read = makeConfig(settings).read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.deepEqual(read.entries.map(entry => entry.name), ['mine'])
})

test('an absent service, namespace, servers map or revision is unavailable', () => {
  assert.equal(makeConfig(undefined).read().kind, 'unavailable')
  assert.equal(makeConfig({ describe: () => [] }).read().kind, 'unavailable')
  assert.equal(makeConfig({ describe: () => [{ ns: 'mcp-manager', value: { servers: 'x' }, revision: 1 }] }).read().kind, 'unavailable')
  assert.equal(makeConfig({ describe: () => [{ ns: 'mcp-manager', value: { servers: {} } }] }).read().kind, 'unavailable')
  assert.equal(makeConfig({ describe: () => { throw new Error('projection failed') } }).read().kind, 'unavailable')
})

test('a user-only Delete removes the entry; an inherited Reset restores the base value', async () => {
  const settings = new FakeSettingsForms(
    { servers: { inherited: stdioEntry('/base') } },
    { servers: { inherited: { enabled: false }, mine: stdioEntry('/mine') } },
  )
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return

  const deleted = await config.mutate([{ op: 'unset', path: ['servers', 'mine'] }], read.revision, GENERATION)
  assert.equal(deleted.kind, 'saved')
  assert.deepEqual(Object.keys(settings.user.servers as Record<string, unknown>), ['inherited'])
  assert.equal(settings.mutations.length, 1, 'ONE official mutate per decision')
  assert.equal(settings.mutations[0]?.ns, 'mcp-manager')
  assert.equal(settings.mutations[0]?.revision, read.revision)

  const afterDelete = config.read()
  assert.equal(afterDelete.kind, 'ready')
  if (afterDelete.kind !== 'ready') return
  const reset = await config.mutate([{ op: 'unset', path: ['servers', 'inherited'] }], afterDelete.revision, GENERATION)
  assert.equal(reset.kind, 'saved')
  // Reset restores the INHERITED value; the server keeps existing.
  const effective = (mergeLayers(settings.base, settings.user) as { servers: Record<string, Record<string, unknown>> }).servers
  assert.deepEqual(effective.inherited, stdioEntry('/base'))
  assert.deepEqual((settings.user.servers as Record<string, unknown>).inherited, stdioEntry('/base'))
})

test('a stale expectedRevision is the official CONFLICT, never a silent overwrite', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  const config = makeConfig(settings)
  const first = config.read()
  assert.equal(first.kind, 'ready')
  if (first.kind !== 'ready') return
  // Another editor moves the namespace first.
  await settings.mutate('mcp-manager', [{ op: 'set', path: ['servers', 'other'], value: stdioEntry() }], first.revision)
  const outcome = await config.mutate([{ op: 'set', path: ['servers', 'mine', 'enabled'], value: false }], first.revision, GENERATION)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'conflict')
  // The user layer still holds the un-overwritten value.
  assert.equal((settings.user.servers as Record<string, Record<string, unknown>>).mine?.enabled, true)
})

test('a replaced Host generation is refused BEFORE dispatch', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  let generation: object = GENERATION
  const config = makeConfig(settings, () => generation)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  generation = Object.freeze({ id: 'host-b' })
  const outcome = await config.mutate([{ op: 'unset', path: ['servers', 'mine'] }], read.revision, GENERATION)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
  assert.equal(settings.mutations.length, 0, 'a stale generation never dispatches a write')
})

test('an Add is ONE whole-entry set and the FR3 source key set agrees afterwards', async () => {
  const settings = new FakeSettingsForms()
  const config = makeConfig(settings)
  const sources = new DirectMcpServerSourcesConfig(contextWith(settings), () => GENERATION)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.deepEqual(sources.read().kind, 'ready')
  const before = sources.read()
  assert.deepEqual(before.kind === 'ready' ? before.configuredNames : [], [])

  const outcome = await config.mutate(
    [{ op: 'set', path: ['servers', 'added'], value: stdioEntry('/bin/true', { args: ['a b'] }) }],
    read.revision,
    GENERATION,
  )
  assert.equal(outcome.kind, 'saved')
  const after = sources.read()
  assert.equal(after.kind, 'ready')
  if (after.kind !== 'ready') return
  assert.deepEqual(after.configuredNames, ['added'])
  // The saved revision is the READ-BACK one, not the pre-write one.
  if (outcome.kind !== 'saved') return
  assert.equal(outcome.revision, read.revision + 1)
})

test('a failed read-back after a committed write is outcome-unconfirmed, never saved or refused', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  // The pre-write read already happened; every LATER describe (the read-back)
  // fails.
  settings.describe = (): ReturnType<FakeSettingsForms['describe']> => {
    throw new Error('read-back failed')
  }
  const outcome = await config.mutate([{ op: 'set', path: ['servers', 'mine', 'enabled'], value: false }], read.revision, GENERATION)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'outcome-unconfirmed')
})

test('a Host refusal is reported with its real reason', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  settings.failWith = new Error('servers.mine: a stdio server requires "command"')
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const outcome = await config.mutate([{ op: 'set', path: ['servers', 'mine', 'command'], value: '' }], read.revision, GENERATION)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
  assert.match(outcome.failure.reason, /requires "command"/u)
})

test('a Host replacement during the write is outcome-unconfirmed, never saved', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  let generation: object = GENERATION
  const config = makeConfig(settings, () => generation)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  // The Host is replaced WHILE the mutation settles: the read-back belongs to
  // another authority, so the write's outcome is unobservable here.
  const originalMutate = settings.mutate.bind(settings)
  settings.mutate = async (ns, ops, revision) => {
    await originalMutate(ns, ops, revision)
    generation = Object.freeze({ id: 'host-b' })
  }
  const outcome = await config.mutate(
    [{ op: 'set', path: ['servers', 'mine', 'enabled'], value: false }],
    read.revision,
    GENERATION,
  )
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'outcome-unconfirmed')
})

test('a mutate that throws AFTER persisting is saved when the read-back proves the op is in force', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  // The official ConfigEditor persists the patch and THEN reconciles; a throw
  // from the Loader must not be reported as "the configuration did not change".
  const originalMutate = settings.mutate.bind(settings)
  settings.mutate = async (ns, ops, revision) => {
    await originalMutate(ns, ops, revision)
    throw new Error('loader reconcile failed after the patch was written')
  }
  const outcome = await config.mutate(
    [{ op: 'set', path: ['servers', 'mine', 'enabled'], value: false }],
    read.revision,
    GENERATION,
  )
  assert.equal(outcome.kind, 'saved', 'the read-back proves the write committed')
})

test('a mutate that throws without persisting is a rejection when the revision did not move', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  settings.mutate = async () => { throw new Error('servers.mine: a stdio server requires "command"') }
  const outcome = await config.mutate(
    [{ op: 'set', path: ['servers', 'mine', 'command'], value: '' }],
    read.revision,
    GENERATION,
  )
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
  assert.match(outcome.failure.reason, /requires "command"/u)
})

test('a commit-then-throw Delete is only saved when the entry is really gone', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const originalMutate = settings.mutate.bind(settings)
  settings.mutate = async (ns, ops, revision) => {
    await originalMutate(ns, ops, revision)
    throw new Error('loader reconcile failed after the patch was written')
  }
  const outcome = await config.mutate([{ op: 'unset', path: ['servers', 'mine'] }], read.revision, GENERATION)
  assert.equal(outcome.kind, 'saved', 'the entry is gone, so the unset committed')
})

test('a commit-then-throw Reset is NOT claimed saved when the inherited entry survives', async () => {
  // A Reset keeps the server (the base provides it), so the unset cannot be
  // proven by the entry's absence: the truthful settlement is unconfirmed.
  const settings = new FakeSettingsForms(
    { servers: { inherited: stdioEntry('/base') } },
    { servers: { inherited: { enabled: false } } },
  )
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const originalMutate = settings.mutate.bind(settings)
  settings.mutate = async (ns, ops, revision) => {
    await originalMutate(ns, ops, revision)
    throw new Error('loader reconcile failed after the patch was written')
  }
  const outcome = await config.mutate([{ op: 'unset', path: ['servers', 'inherited'] }], read.revision, GENERATION)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'outcome-unconfirmed')
})

test('an unset that provably did not take effect stays a rejection', async () => {
  const settings = new FakeSettingsForms({ servers: {} }, { servers: { mine: stdioEntry() } })
  const config = makeConfig(settings)
  const read = config.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  settings.mutate = async () => { throw new Error('the Host refused the write') }
  const outcome = await config.mutate([{ op: 'unset', path: ['servers', 'mine'] }], read.revision, GENERATION)
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
})
