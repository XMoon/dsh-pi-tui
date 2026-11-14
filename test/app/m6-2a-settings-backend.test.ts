/**
 * The startup-backend ConfigPort contract (`tui-startup.backend`): the profile
 * preference that selects which backend a NEW cold launch runs.
 *
 * Evidence level: L3/L5 adapter-contract tests over the REAL Direct and Remote
 * adapters with structural fakes. The Direct adapter reads the official
 * SettingsForms descriptor projection and writes a revision-checked PATH
 * mutation of `backend`; the Remote adapter reads the mirrored namespace and
 * writes through the revision-checked mirror with a post-settlement refresh as
 * the only new authority.
 *
 * The contract pinned here:
 *  - a valid `direct`/`daemon` value is read with its USER-layer provenance;
 *  - an out-of-vocabulary value is UNREADABLE (`undefined`), never silently
 *    mapped to `direct` (fail-closed);
 *  - the write is exactly one path-level `set` of `backend` at the decision's
 *    revision, so an external edit is a conflict, not a silent overwrite;
 *  - a stale Remote mirror keeps its last-known value readable but refuses the
 *    write without dispatching it.
 *
 * The UI-level A5 slice (the `Backend` row's summary/`(default)` rule, the
 * read-only environment-override line and the General-category reachability)
 * is proven end-to-end through the REAL `/settings` composition in
 * `test/app/settings-workspace-visual.test.ts`, where the workspace harness
 * lives; this file owns the adapter contract below it.
 *
 * @module @xmoon76/dsh-pi-tui/test/app/m6-2a-settings-backend
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectConfigPort, type HostContextLike } from '../../src/runtime/direct/config-direct.ts'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import { createObservableGenerationHarness } from '../support/remote-generation.ts'

/* ------------------------------------------------------------------------- *
 * Direct adapter.
 * ------------------------------------------------------------------------- */

function host(services: Record<string, unknown>): HostContextLike {
  return { get: name => services[name], on: (() => false) as unknown as HostContextLike['on'] }
}

function directPort(services: Record<string, unknown>): DirectConfigPort {
  return new DirectConfigPort(host(services), undefined, () => undefined)
}

/** The 0.1.7 SettingsForms surface over one in-memory form document. */
function settingsDoc(
  ns: string,
  value: Record<string, unknown>,
  options: { readonly user?: Record<string, unknown>; readonly revision?: number; readonly mutate?: (ns: string, ops: unknown, revision?: number) => Promise<unknown> } = {},
) {
  return {
    describe: () => [{ ns, value, user: options.user, revision: options.revision ?? 5 }],
    mutate: options.mutate ?? (async () => {}),
  }
}

test('the Direct startup-backend read returns the effective value and its USER provenance', () => {
  const unset = directPort({ settings: settingsDoc('tui-startup', { backend: 'daemon' }, { user: {} }) }).backendStartupPreference
  assert.deepEqual(unset.read(), { backend: 'daemon', revision: 5, userOverridden: false })

  const declared = directPort({
    settings: settingsDoc('tui-startup', { backend: 'direct' }, { user: { backend: 'direct' }, revision: 9 }),
  }).backendStartupPreference
  assert.deepEqual(declared.read(), { backend: 'direct', revision: 9, userOverridden: true })
})

test('an out-of-vocabulary Profile backend is unreadable, never silently mapped to direct', () => {
  assert.equal(directPort({
    settings: settingsDoc('tui-startup', { backend: 'garbage' }),
  }).backendStartupPreference.read(), undefined, 'a non-public value is not a read')
  assert.equal(directPort({
    settings: settingsDoc('tui-startup', { backend: '' }),
  }).backendStartupPreference.read(), undefined, 'an empty value is not a read')
  assert.equal(directPort({
    settings: settingsDoc('tui-startup', {}),
  }).backendStartupPreference.read(), undefined, 'an absent backend field is unreadable, not the default')
  assert.equal(directPort({
    settings: settingsDoc('tui-startup', { backend: 7 }),
  }).backendStartupPreference.read(), undefined, 'a non-string value is unreadable')
  assert.equal(directPort({
    settings: { describe: () => [{ ns: 'other', value: { backend: 'direct' }, revision: 1 }], mutate: async () => {} },
  }).backendStartupPreference.read(), undefined, 'a missing namespace is unavailable')
  assert.equal(directPort({}).backendStartupPreference.read(), undefined, 'no settings service at all is unreadable')
})

test('the Direct startup-backend write is ONE path-level set at the decision revision', async () => {
  const calls: Array<{ ns: string; ops: unknown; revision?: number }> = []
  const config = directPort({
    settings: settingsDoc('tui-startup', { backend: 'direct' }, {
      revision: 12,
      mutate: async (ns, ops, revision) => { calls.push({ ns, ops, revision }) },
    }),
  }).backendStartupPreference
  await config.setBackend('daemon', 12)
  assert.deepEqual(calls, [{
    ns: 'tui-startup',
    ops: [{ op: 'set', path: ['backend'], value: 'daemon' }],
    revision: 12,
  }], 'the write is the exact backend path at the caller revision, never a whole-section replace')

  const absent = directPort({ settings: { describe: () => [], mutate: async () => {} } }).backendStartupPreference
  await assert.rejects(absent.setBackend('daemon', 1), /not mounted/u, 'an absent section is an explicit refusal')
  const noSettings = directPort({}).backendStartupPreference
  await assert.rejects(noSettings.setBackend('daemon', 1), /settings service is unavailable/u)
})

test('a stale Direct decision is refused and the ORIGINAL read revision is the fence', async () => {
  let revision = 21
  const calls: Array<{ revision?: number }> = []
  const config = directPort({
    settings: {
      describe: () => [{ ns: 'tui-startup', value: { backend: 'direct' }, revision }],
      mutate: async (_ns: string, _ops: unknown, expectedRevision?: number) => {
        calls.push({ revision: expectedRevision })
        if (expectedRevision !== revision) {
          throw Object.assign(new Error(`expected revision ${String(expectedRevision)}, actual ${revision}`), { code: 'SETTINGS_CONFLICT' })
        }
        revision += 1
      },
    },
  }).backendStartupPreference
  const decision = config.read()
  assert.equal(decision?.revision, 21)
  revision = 22
  await assert.rejects(config.setBackend('daemon', decision.revision), /expected revision 21, actual 22/u,
    'the stale decision is refused instead of overwriting the external edit')
  assert.deepEqual(calls, [{ revision: 21 }], 'the ORIGINAL read revision is the fence')
  assert.equal(config.read()?.revision, 22, 'the authoritative read re-establishes the newer revision')
})

/* ------------------------------------------------------------------------- *
 * Remote adapter (structural wire fake).
 * ------------------------------------------------------------------------- */

interface FakeNamespace {
  ns: string
  value: Record<string, unknown>
  user?: Record<string, unknown>
  revision: number
}

function remotePort(seed?: (state: {
  namespaces: Map<string, FakeNamespace>
  describeFailure: { code: string; message: string } | undefined
  mutateCalls: Array<{ ns: string; ops: unknown; revision: number | undefined }>
}) => void) {
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const state = {
    namespaces: new Map<string, FakeNamespace>(),
    describeFailure: undefined as { code: string; message: string } | undefined,
    mutateCalls: [] as Array<{ ns: string; ops: unknown; revision: number | undefined }>,
  }
  seed?.(state)
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const wire: Record<string, unknown> = {}
  const remote = {
    settings: {
      describe: async () => {
        if (state.describeFailure !== undefined) return { ok: false as const, error: state.describeFailure }
        return {
          ok: true as const,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [...state.namespaces.values()].map(entry => ({
              ns: entry.ns,
              value: structuredClone(entry.value),
              ...entry.user === undefined ? {} : { user: structuredClone(entry.user) },
              revision: entry.revision,
            })),
          },
        }
      },
      mutate: async (ns: string, ops: ReadonlyArray<{ op: string; path: readonly string[]; value?: unknown }>, revision: number | undefined) => {
        state.mutateCalls.push({ ns, ops, revision })
        const entry = state.namespaces.get(ns)
        if (entry !== undefined) {
          if (revision !== undefined && revision !== entry.revision) {
            return { ok: false as const, error: { code: 'settings/conflict', message: `revision ${revision} != ${entry.revision}` } }
          }
          for (const op of ops) {
            if (op.op === 'set') (entry.value as Record<string, unknown>)[op.path[op.path.length - 1]!] = op.value
          }
          entry.revision += 1
        }
        return { ok: true as const, value: { ns } }
      },
    },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    $on(this: unknown, event: string, listener: (...args: unknown[]) => void) {
      if (this !== wire) throw new TypeError('unbound event seat')
      let set = listeners.get(event)
      if (set === undefined) { set = new Set(); listeners.set(event, set) }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }
  for (const [key, value] of Object.entries(remote)) {
    Object.defineProperty(wire, key, { get: () => value, enumerable: false, configurable: false })
  }
  const port = new RemoteConfigPort({
    remote: wire as never,
    connection: { generation: generation.source },
  })
  return { port, state }
}

test('the Remote startup-backend read mirrors the Host namespace and its USER provenance', async () => {
  const { port } = remotePort(current => {
    current.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'daemon' }, revision: 7 })
  })
  assert.equal(port.backendStartupPreference.read(), undefined, 'a never-described mirror has no authority to report')
  await port.describe()
  assert.deepEqual(port.backendStartupPreference.read(), { backend: 'daemon', revision: 7, userOverridden: false })

  const overridden = remotePort(current => {
    current.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, user: { backend: 'direct' }, revision: 3 })
  })
  await overridden.port.describe()
  assert.deepEqual(overridden.port.backendStartupPreference.read(), { backend: 'direct', revision: 3, userOverridden: true })
})

test('an out-of-vocabulary mirrored backend is unreadable, never the default', async () => {
  const { port } = remotePort(current => {
    current.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'garbage' }, revision: 2 })
  })
  await port.describe()
  assert.equal(port.backendStartupPreference.read(), undefined)

  const absent = remotePort()
  await absent.port.describe()
  assert.equal(absent.port.backendStartupPreference.read(), undefined, 'an absent namespace is unavailable')
  await assert.rejects(absent.port.backendStartupPreference.setBackend('direct', 1), /not available in this deployment/u)
})

test('the Remote startup-backend write is revision-checked and refreshes from authority', async () => {
  const { port, state } = remotePort(current => {
    current.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, revision: 7 })
  })
  await port.describe()
  await port.backendStartupPreference.setBackend('daemon', 7)
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0]!.ns, 'tui-startup')
  assert.deepEqual(state.mutateCalls[0]!.ops, [{ op: 'set', path: ['backend'], value: 'daemon' }])
  assert.equal(state.mutateCalls[0]!.revision, 7, 'the write carries the revision the decision was read at')
  assert.equal(port.backendStartupPreference.read()?.backend, 'daemon',
    'the post-settlement mirror refresh is the new authority')
})

test('a stale Remote mirror keeps the read last-known and refuses the write without dispatching', async () => {
  const { port, state } = remotePort(current => {
    current.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, revision: 2 })
  })
  await port.describe()
  state.describeFailure = { code: 'gateway/disconnected', message: 'connection lost' }
  await assert.rejects(port.describe())
  assert.deepEqual(port.backendStartupPreference.read(), { backend: 'direct', revision: 2, userOverridden: false },
    'the last-known value stays readable but non-current')
  assert.equal(port.configReadiness(), 'stale')
  const before = state.mutateCalls.length
  await assert.rejects(port.backendStartupPreference.setBackend('daemon', 2), /settings\.describe failed: connection lost/u)
  assert.equal(state.mutateCalls.length, before, 'a stale mirror never dispatches the startup backend')
})
