/**
 * FR4 — the Remote MCP server configuration read/write over the ONE settings
 * mirror.
 *
 * Evidence level: adapter contract (L2) over the committed mirror + the
 * official generated `settings` wire faces. It pins: a `ready` read requires a
 * CURRENT committed snapshot; a Host generation change refuses a write BEFORE
 * dispatch; a stale revision is the official conflict; a lost post-write
 * refresh is `outcome-unconfirmed` (never a fake refusal and never a replay);
 * and a write is dispatched EXACTLY ONCE. The authenticated Split Host/Client
 * journey (two Clients, real profile bytes) is the split-process smoke.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/mcp-config-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteConfigPort, type RemoteConfigRuntimeSource } from '../../../src/runtime/remote/config-remote.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'

interface NamespaceView {
  ns: string
  value?: unknown
  base?: unknown
  user?: unknown
  revision?: number
}

interface FixtureOptions {
  readonly namespaces?: readonly NamespaceView[]
  /** Make the NEXT `describe()` fail (a lost post-write read). */
  readonly describeFailureAfterWrite?: boolean
  /** Make `mutate` fail with this wire error. */
  readonly mutateError?: { code: string; message: string }
}

function stdioEntry(command = '/bin/echo', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { transport: 'stdio', command, args: [], env: {}, cwd: '', enabled: true, ...extra }
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

function makePort(options: FixtureOptions = {}) {
  let snapshot: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  const generation = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  let namespaces: NamespaceView[] = [...(options.namespaces ?? [])]
  const mutateCalls: Array<{ ns: string; ops: readonly unknown[]; revision: number | undefined }> = []
  let failNextDescribe = false
  const remote = {
    settings: {
      describe: async () => {
        if (failNextDescribe) {
          failNextDescribe = false
          return { ok: false as const, error: { code: 'transport/lost', message: 'read lost' } }
        }
        return { ok: true as const, value: { writable: true, hasDocument: true, namespaces } }
      },
      update: async () => ({ ok: true as const, value: {} }),
      replace: async () => ({ ok: true as const, value: {} }),
      mutate: async (ns: string, ops: readonly ({ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] })[], revision: number | undefined) => {
        mutateCalls.push({ ns, ops: [...ops], revision })
        if (options.mutateError !== undefined) {
          return { ok: false as const, error: options.mutateError }
        }
        const target = namespaces.find(view => view.ns === ns)
        if (target === undefined) return { ok: false as const, error: { code: 'settings/absent', message: 'no namespace' } }
        if (revision !== undefined && revision !== target.revision) {
          return { ok: false as const, error: { code: 'settings/conflict', message: `expected ${String(revision)}, now ${String(target.revision)}` } }
        }
        const user = structuredClone(target.user ?? {}) as Record<string, unknown>
        for (const op of ops) {
          if (op.op === 'set') {
            applySet(user, op.path, op.value)
            continue
          }
          const inherited = readOwn(target.base, op.path)
          if (inherited === undefined) applyUnset(user, op.path)
          else applySet(user, op.path, inherited)
        }
        target.user = user
        target.value = mergeLayers(target.base, user)
        target.revision = (target.revision ?? 0) + 1
        if (options.describeFailureAfterWrite === true) failNextDescribe = true
        return { ok: true as const, value: {} }
      },
    },
    credentials: {
      describe: async () => ({ ok: true as const, value: {} }),
      set: async () => ({ ok: true as const, value: undefined }),
      unset: async () => ({ ok: true as const, value: undefined }),
    },
    commands: { execute: async () => ({ ok: false as const, error: { code: 'unused', message: 'unused' } }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    $on: (_event: string, _listener: (...args: unknown[]) => void) => () => {},
  }
  const port = new RemoteConfigPort({
    remote,
    connection: { generation },
  } as unknown as RemoteConfigRuntimeSource)
  return {
    port,
    mutateCalls,
    get generationIdentity() { return snapshot },
    advanceGeneration() {
      snapshot = { id: (snapshot?.id as number ?? 0) + 1 }
      for (const listener of [...listeners]) listener()
    },
  }
}

test('the configuration read is unavailable before any authoritative settings read', () => {
  const fixture = makePort()
  assert.equal(fixture.port.mcpServerConfiguration.read().kind, 'unavailable')
})

test('one current descriptor classifies the three provenances and carries the revision', async () => {
  const fixture = makePort({
    namespaces: [{
      ns: 'mcp-manager',
      base: { servers: { inherited: stdioEntry('/base'), both: stdioEntry('/base') } },
      user: { servers: { both: { enabled: false }, mine: stdioEntry('/mine') } },
      value: { servers: { inherited: stdioEntry('/base'), both: stdioEntry('/base', { enabled: false }), mine: stdioEntry('/mine') } },
      revision: 9,
    }],
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.revision, 9)
  assert.equal(read.generation, fixture.generationIdentity)
  assert.deepEqual(read.entries.map(entry => [entry.name, entry.provenance]), [
    ['inherited', 'inherited'],
    ['both', 'overridden'],
    ['mine', 'user-added'],
  ])
})

test('a stale mirror (a Host generation change) is stale, never a key set', async () => {
  const fixture = makePort({
    namespaces: [{ ns: 'mcp-manager', value: { servers: {} }, revision: 2 }],
  })
  await fixture.port.describe()
  assert.equal(fixture.port.mcpServerConfiguration.read().kind, 'ready')
  fixture.advanceGeneration()
  assert.equal(fixture.port.mcpServerConfiguration.read().kind, 'stale')
})

test('an absent namespace is unavailable', async () => {
  const fixture = makePort({ namespaces: [{ ns: 'other', value: {}, revision: 1 }] })
  await fixture.port.describe()
  assert.equal(fixture.port.mcpServerConfiguration.read().kind, 'unavailable')
})

test('one Add is ONE wire mutation at the pinned revision, and the read-back confirms it', async () => {
  const fixture = makePort({
    namespaces: [{ ns: 'mcp-manager', base: { servers: {} }, user: { servers: {} }, value: { servers: {} }, revision: 4 }],
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const outcome = await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'set', path: ['servers', 'added'], value: stdioEntry('/bin/true') }],
    read.revision,
    read.generation,
  )
  assert.equal(outcome.kind, 'saved')
  if (outcome.kind !== 'saved') return
  assert.equal(outcome.revision, 5)
  assert.equal(fixture.mutateCalls.length, 1, 'exactly ONE dispatch')
  assert.equal(fixture.mutateCalls[0]?.ns, 'mcp-manager')
  assert.equal(fixture.mutateCalls[0]?.revision, 4)
  const after = fixture.port.mcpServerConfiguration.read()
  assert.equal(after.kind, 'ready')
  if (after.kind !== 'ready') return
  assert.deepEqual(after.entries.map(entry => entry.name), ['added'])
})

test('a stale revision is the official conflict and the stored value is not overwritten', async () => {
  const fixture = makePort({
    namespaces: [{ ns: 'mcp-manager', base: { servers: {} }, user: { servers: { mine: stdioEntry() } }, value: { servers: { mine: stdioEntry() } }, revision: 3 }],
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  // Another Client moves the namespace first (the wire bumps the revision).
  await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'set', path: ['servers', 'other'], value: stdioEntry() }],
    read.revision,
    read.generation,
  )
  const outcome = await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'set', path: ['servers', 'mine', 'enabled'], value: false }],
    read.revision,
    read.generation,
  )
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'conflict')
  const after = fixture.port.mcpServerConfiguration.read()
  assert.equal(after.kind, 'ready')
  if (after.kind !== 'ready') return
  assert.equal(after.entries.find(entry => entry.name === 'mine')?.effective.enabled, true)
})

test('a Host A -> B generation change refuses the write BEFORE dispatch', async () => {
  const fixture = makePort({
    namespaces: [{ ns: 'mcp-manager', base: { servers: {} }, user: { servers: { mine: stdioEntry() } }, value: { servers: { mine: stdioEntry() } }, revision: 1 }],
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const pinned = read.generation
  fixture.advanceGeneration()
  await fixture.port.describe()
  const outcome = await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'unset', path: ['servers', 'mine'] }],
    read.revision,
    pinned,
  )
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
  assert.equal(fixture.mutateCalls.length, 0, 'a replaced Host never receives the write')
})

test('a lost post-write read is outcome-unconfirmed and the write is never replayed', async () => {
  const fixture = makePort({
    namespaces: [{ ns: 'mcp-manager', base: { servers: {} }, user: { servers: { mine: stdioEntry() } }, value: { servers: { mine: stdioEntry() } }, revision: 1 }],
    describeFailureAfterWrite: true,
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const outcome = await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'set', path: ['servers', 'mine', 'enabled'], value: false }],
    read.revision,
    read.generation,
  )
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'outcome-unconfirmed')
  assert.equal(fixture.mutateCalls.length, 1, 'exactly one dispatch, no replay')
  // The committed write is visible once the authority can be read again.
  await fixture.port.describe()
  const after = fixture.port.mcpServerConfiguration.read()
  assert.equal(after.kind, 'ready')
  if (after.kind !== 'ready') return
  assert.equal(after.entries.find(entry => entry.name === 'mine')?.effective.enabled, false)
})

test('a wire refusal is reported as a rejection with its real reason', async () => {
  const fixture = makePort({
    namespaces: [{ ns: 'mcp-manager', base: { servers: {} }, user: { servers: { mine: stdioEntry() } }, value: { servers: { mine: stdioEntry() } }, revision: 1 }],
    mutateError: { code: 'settings/rejected', message: 'servers.mine: a stdio server requires "command"' },
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  const outcome = await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'set', path: ['servers', 'mine', 'command'], value: '' }],
    read.revision,
    read.generation,
  )
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.failure.kind, 'rejected')
  assert.match(outcome.failure.reason, /requires "command"/u)
})

test('an inherited Reset through the wire restores the base value (never a deletion)', async () => {
  const fixture = makePort({
    namespaces: [{
      ns: 'mcp-manager',
      base: { servers: { inherited: stdioEntry('/base') } },
      user: { servers: { inherited: { enabled: false } } },
      value: { servers: { inherited: stdioEntry('/base', { enabled: false }) } },
      revision: 2,
    }],
  })
  await fixture.port.describe()
  const read = fixture.port.mcpServerConfiguration.read()
  assert.equal(read.kind, 'ready')
  if (read.kind !== 'ready') return
  assert.equal(read.entries.find(entry => entry.name === 'inherited')?.provenance, 'overridden')
  const outcome = await fixture.port.mcpServerConfiguration.mutate(
    [{ op: 'unset', path: ['servers', 'inherited'] }],
    read.revision,
    read.generation,
  )
  assert.equal(outcome.kind, 'saved')
  const after = fixture.port.mcpServerConfiguration.read()
  assert.equal(after.kind, 'ready')
  if (after.kind !== 'ready') return
  const entry = after.entries.find(candidate => candidate.name === 'inherited')
  // The official `unset` restores the inherited VALUE into the user layer (it
  // does not delete the user entry), so the effective configuration is the
  // base one again while the descriptor truthfully still reports a user copy.
  assert.equal(entry?.effective.enabled, true)
  assert.equal(entry?.effective.command, '/base')
})
