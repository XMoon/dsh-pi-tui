/**
 * FR3 — the Remote MCP configuration-source read over the ONE settings mirror.
 *
 * Evidence level: unit/contract (L2) over the committed mirror semantics. It
 * pins that a source verdict is `ready` ONLY for a CURRENT, readable
 * `mcp-manager.servers` snapshot; a stale mirror or an absent namespace is
 * never presented as a key set (the caller must show Source Unknown).
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/mcp-server-sources-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteConfigPort, type RemoteConfigRuntimeSource } from '../../../src/runtime/remote/config-remote.ts'
import type { RemoteConnectionGeneration } from '../../../src/runtime/remote/session-reader-remote.ts'

interface FixtureOptions {
  readonly namespaces?: readonly { ns: string; value?: unknown; revision?: number }[]
  readonly settingsFailure?: unknown
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
  let describeCalls = 0
  let namespaces = options.namespaces ?? []
  const remote = {
    settings: {
      describe: async () => {
        describeCalls += 1
        if (options.settingsFailure !== undefined) return { ok: false as const, error: options.settingsFailure }
        return { ok: true as const, value: { writable: true, hasDocument: true, namespaces } }
      },
      update: async () => ({ ok: true as const, value: {} }),
      replace: async () => ({ ok: true as const, value: {} }),
      mutate: async () => ({ ok: true as const, value: {} }),
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
    get describeCalls() { return describeCalls },
    get generationIdentity() { return snapshot },
    setNamespaces(next: readonly { ns: string; value?: unknown; revision?: number }[]) { namespaces = next },
    advanceGeneration() {
      snapshot = { id: (snapshot?.id as number ?? 0) + 1 }
      for (const listener of [...listeners]) listener()
    },
  }
}

test('the source read is unavailable before any authoritative settings read', () => {
  const fixture = makePort()
  assert.deepEqual(fixture.port.mcpServerSources.read(), {
    kind: 'unavailable',
    reason: 'no current Host settings snapshot is available',
  })
})

test('a current mcp-manager namespace yields its effective configured keys and revision', async () => {
  const fixture = makePort({
    namespaces: [{
      ns: 'mcp-manager',
      value: { servers: { alpha: { transport: 'stdio' }, beta: { transport: 'streamable-http' } } },
      revision: 7,
    }],
  })
  await fixture.port.describe()
  assert.deepEqual(fixture.port.mcpServerSources.read(), {
    kind: 'ready',
    configuredNames: ['alpha', 'beta'],
    generation: fixture.generationIdentity,
    revision: 7,
  })
})

test('an empty configured server map is a real ready empty list, not unavailable', async () => {
  const fixture = makePort({ namespaces: [{ ns: 'mcp-manager', value: { servers: {} }, revision: 1 }] })
  await fixture.port.describe()
  assert.deepEqual(fixture.port.mcpServerSources.read(), {
    kind: 'ready', configuredNames: [], generation: fixture.generationIdentity, revision: 1,
  })
})

test('a missing namespace or an unreadable servers field is unavailable, never plugin-owned', async () => {
  const missing = makePort({ namespaces: [{ ns: 'llm-pi-ai', value: {} }] })
  await missing.port.describe()
  assert.equal(missing.port.mcpServerSources.read().kind, 'unavailable')

  const unreadable = makePort({ namespaces: [{ ns: 'mcp-manager', value: { servers: 'not-a-map' } }] })
  await unreadable.port.describe()
  assert.equal(unreadable.port.mcpServerSources.read().kind, 'unavailable')

  const noServers = makePort({ namespaces: [{ ns: 'mcp-manager', value: {} }] })
  await noServers.port.describe()
  assert.equal(noServers.port.mcpServerSources.read().kind, 'unavailable')
})

test('a generation change makes the last-known key set stale, never ready', async () => {
  const fixture = makePort({ namespaces: [{ ns: 'mcp-manager', value: { servers: { alpha: {} } }, revision: 2 }] })
  await fixture.port.describe()
  assert.equal(fixture.port.mcpServerSources.read().kind, 'ready')
  fixture.advanceGeneration()
  const verdict = fixture.port.mcpServerSources.read()
  assert.equal(verdict.kind, 'stale')
})

test('refresh drives the same describe() so a just-opened page becomes current', async () => {
  const fixture = makePort({ namespaces: [{ ns: 'mcp-manager', value: { servers: { alpha: {} } }, revision: 3 }] })
  const before = fixture.describeCalls
  await fixture.port.mcpServerSources.refresh()
  assert.equal(fixture.describeCalls, before + 1, 'refresh uses the existing settings describe, not a second mirror')
  assert.equal(fixture.port.mcpServerSources.read().kind, 'ready')
})

test('a failed settings read leaves the source stale, never a fabricated ready', async () => {
  const fixture = makePort({ settingsFailure: { code: 'gateway/internal', message: 'describe failed' } })
  await assert.rejects(fixture.port.describe())
  assert.notEqual(fixture.port.mcpServerSources.read().kind, 'ready')
})
