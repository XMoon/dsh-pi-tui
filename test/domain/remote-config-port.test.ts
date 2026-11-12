/**
 * L3 adapter contract tests for the Remote config port
 * (`runtime/remote/config-remote.ts`, M3-3B): the adapter maps the published
 * rc.2 wire onto the SAME semantic contract the Direct adapter serves. The
 * fake structural sources below stand in for the generated namespaces — no
 * Host package is imported.
 *
 * Covered: the serialized generation-aware mirror (listener-before-first-
 * describe, invalidation-raced describe re-read, write serialization,
 * write→authoritative-refresh-before-UI-commit, disconnect/reconnect),
 * credential reference/event semantics, the explicit unsupported classes
 * (credential records, provider authorization, session approval override), and
 * the official generated Account adapter (covered by its owner-layer suite), permission
 * catalog/apply, preset default, subagent model selection, footer USER-layer
 * trust parity, and raw settings field round-trips.
 * @module @xmoon76/dsh-pi-tui/remote-config-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import { DirectWebProviderConfig, type HostContextLike } from '../../src/runtime/direct/config-direct.ts'
import type { ProviderCatalogEntry } from '../../src/domain/catalog/provider.ts'
import { serializeTuiSettingsMutation, type ProviderProfileConfig, type TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import { createObservableGenerationHarness } from '../support/remote-generation.ts'
import { CredentialWorkflow, resolveLoginDestination, resolveLogoutDestination } from '../../src/app/command/credential-workflow.ts'

/* ------------------------------------------------------------------------- *
 * Fake structural wire backend.
 * ------------------------------------------------------------------------- */

interface FakeNamespace {
  ns: string
  value: Record<string, unknown>
  user?: Record<string, unknown>
  revision: number
}

interface FakeMutateCall {
  ns: string
  ops: readonly { op: string; path: readonly string[]; value?: unknown }[]
  revision: number | undefined
}

interface FakeState {
  readonly namespaces: Map<string, FakeNamespace>
  providers: ProviderCatalogEntry[] | undefined
  readonly permissionOptions: { value: string; name: string }[]
  permissionDefaultPreset: string | undefined
  readonly presetRoster: { id: string; isDefault?: boolean }[]
  describeCalls: number
  describeGate: (() => void | Promise<void>) | undefined
  describeFailure: { code: string; message: string } | undefined
  readonly mutateCalls: FakeMutateCall[]
  mutateGate: (() => Promise<void>) | undefined
  mutateFailure: unknown
  mutateApplies: boolean
  readonly credentialStore: Map<string, { configured: boolean; source?: string }>
  /** Runs INSIDE a credential RPC so a test can replace the generation mid-call. */
  credentialGate: (() => void | Promise<void>) | undefined
  /** Makes the next credential RPC fail (a real failure result). */
  credentialFailure: { code: string; message: string } | undefined
  /** The stored RECORD metadata the private namespace reports. */
  records: { key: string; kind: 'api-key' | 'grant' }[]
  /** Holds the next record RPC open so a test can replace the generation mid-call. */
  recordsGate: (() => void | Promise<void>) | undefined
  recordsListFailure: { code: string; message: string } | undefined
  recordsDeleteFailure: { code: string; message: string } | undefined
  readonly recordsDeleteCalls: string[]
  readonly executeCalls: { sessionId: string; line: string; attachments: readonly unknown[]; signal: AbortSignal }[]
  executeResult: { ok: true; value: unknown } | { ok: false; error: unknown }
  readonly order: string[]
  /** The private authorization roster the Host would report. */
  authorizationRoster: readonly {
    kind: 'authorization'
    route?: string
    key: string
    label: string
    methods: readonly { id: string; label: string }[]
    inFlight: boolean
  }[]
  /** The roster read's next result (a definite unavailable, or a failure). */
  authorizationListOutcome: { kind: 'unavailable'; reason: string } | { kind: 'throw'; error: { code: string; message: string } } | undefined
}

type EventListener = (...args: unknown[]) => void

const TUI_NS = 'tui-app'
const SUBAGENT_NS = 'subagent-model-selection-settings'
const WEB_NS = 'web'
const WEB_API_NS = 'web-deepseek-api'
const WEB_DEFAULTS = {
  searchProvider: 'deepseek-official',
  fetchProvider: 'http',
}
/** The pure rc.2 default section (the schema-resolved shipped values). */
const WEB_API_DEFAULTS = {
  searchBilling: 'auto',
  fetchBilling: 'auto',
  count: 10,
  sendOriginalQuestion: true,
}

/** The valid v1 custom layout both the Direct and Remote trust paths accept. */
const VALID_LAYOUT = {
  schemaVersion: 1,
  rows: [{ left: [{ id: 'user:clock' }], right: [] }],
}

/** The resolved `tui-app` projection defaults: the real
 *  `SettingsNamespaceView.value` is the schema-defaults-resolved section, so
 *  a field the user never set still reads as its default. */
const TUI_DEFAULTS = {
  theme: 'auto',
  iconStyle: 'emoji',
  footer: 'full',
  footerFallbackMode: 'default',
  fullscreen: 'on',
  busyEnter: 'queue',
  localShellSandbox: 'bypass',
  homeEndKeys: 'input',
  displayPreset: 'full',
  progressUpdates: 'milestones',
  // The real Host descriptor always carries the schema default, so the remote
  // fixture must too (an absent field would look like a change to pin).
  gitAttribution: 'off',
  responseStyle: 'default',
  notificationMode: 'unfocused',
  notificationMethod: 'auto',
  terminalProgress: '9;4+7501',
  wheelScrollLines: '1',
}

function applyPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!
    const next = current[key]
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>
    } else {
      const created: Record<string, unknown> = {}
      current[key] = created
      current = created
    }
  }
  current[path[path.length - 1]!] = value
}

function unsetPath(target: Record<string, unknown>, path: readonly string[]): void {
  let current: Record<string, unknown> | undefined = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const next: unknown = current?.[path[index]!]
    current = typeof next === 'object' && next !== null && !Array.isArray(next)
      ? next as Record<string, unknown>
      : undefined
  }
  if (current !== undefined) delete current[path[path.length - 1]!]
}

function tick(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

function createBackend(seed?: (state: FakeState) => void, options: { readonly authorization?: boolean; readonly records?: boolean } = {}) {
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const state: FakeState = {
    namespaces: new Map(),
    providers: [],
    permissionOptions: [],
    permissionDefaultPreset: undefined,
    presetRoster: [],
    describeCalls: 0,
    describeGate: undefined,
    describeFailure: undefined,
    mutateCalls: [],
    mutateGate: undefined,
    mutateFailure: undefined,
    mutateApplies: true,
    credentialStore: new Map(),
    credentialGate: undefined,
    credentialFailure: undefined,
    records: [],
    recordsGate: undefined,
    recordsListFailure: undefined,
    recordsDeleteFailure: undefined,
    recordsDeleteCalls: [],
    executeCalls: [],
    executeResult: { ok: true, value: { commandId: 'c' } },
    order: [],
    authorizationRoster: [],
    authorizationListOutcome: undefined,
  }
  seed?.(state)

  const listeners = new Map<string, Set<EventListener>>()
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const viewOf = (ns: FakeNamespace) => ({
    ns: ns.ns,
    value: structuredClone(ns.value),
    ...ns.user === undefined ? {} : { user: structuredClone(ns.user) },
    revision: ns.revision,
    applies: 'live',
    secrets: [],
    autoGenerate: false,
    schema: {},
  })

  // Assigned below; the `$on` seat guard compares against the object the port
  // actually holds, which is the accessor-backed wire.
  let wire: Record<string, unknown>
  const remote = {
    settings: {
      describe: async () => {
        state.describeCalls += 1
        state.order.push('describe')
        if (state.describeFailure !== undefined) return { ok: false as const, error: state.describeFailure }
        // Snapshot the authority BEFORE the gate so a raced invalidation can
        // leave the first read with genuinely stale data.
        const value = {
          writable: true,
          hasDocument: true,
          namespaces: [...state.namespaces.values()].map(viewOf),
        }
        await state.describeGate?.()
        return { ok: true as const, value }
      },
      update: async () => { throw new Error('settings.update is unused by the adapter') },
      replace: async () => { throw new Error('settings.replace is unused by the adapter') },
      mutate: async (ns: string, ops: FakeMutateCall['ops'], revision: number | undefined) => {
        state.order.push('mutate')
        state.mutateCalls.push({ ns, ops, revision })
        if (state.mutateGate !== undefined) {
          const gate = state.mutateGate
          state.mutateGate = undefined
          await gate()
        }
        if (state.mutateFailure !== undefined) return { ok: false as const, error: state.mutateFailure }
        if (state.mutateApplies) {
          const entry = state.namespaces.get(ns)
          if (entry !== undefined) {
            // The official `settings.mutate` checks the caller's revision
            // ATOMICALLY: a base revision that no longer matches the live
            // document is refused with a conflict instead of being applied to
            // the newer state.
            if (revision !== undefined && revision !== entry.revision) {
              return {
                ok: false as const,
                error: { code: 'settings/conflict', message: `revision ${revision} != ${entry.revision}` },
              }
            }
            for (const op of ops) {
              if (op.op === 'set') applyPath(entry.value, op.path, op.value)
              else unsetPath(entry.value, op.path)
            }
            entry.revision += 1
          }
        }
        return { ok: true as const, value: { ns } }
      },
    },
    credentials: {
      describe: async (refs: string[]) => {
        await state.credentialGate?.()
        if (state.credentialFailure !== undefined) return { ok: false as const, error: state.credentialFailure }
        const value: Record<string, { configured: boolean; source?: string; writable: boolean }> = {}
        for (const ref of refs) {
          const info = state.credentialStore.get(ref)
          value[ref] = {
            configured: info?.configured ?? false,
            ...info?.source === undefined ? {} : { source: info.source },
            writable: true,
          }
        }
        return { ok: true as const, value }
      },
      set: async (ref: string, _value: string) => {
        await state.credentialGate?.()
        if (state.credentialFailure !== undefined) return { ok: false as const, error: state.credentialFailure }
        state.credentialStore.set(ref, { configured: true, source: 'provider' })
        return { ok: true as const, value: undefined }
      },
      unset: async (ref: string) => {
        await state.credentialGate?.()
        if (state.credentialFailure !== undefined) return { ok: false as const, error: state.credentialFailure }
        state.credentialStore.delete(ref)
        return { ok: true as const, value: undefined }
      },
    },
    ...options.records === false ? {} : {
      // The SAME mounted private namespace the package contribution publishes
      // (M6-1 F7B): metadata-only rows, exact-key delete, official store state.
      piTuiCredentialRecords: {
        list: async () => {
          state.order.push('records:list')
          await state.recordsGate?.()
          if (state.recordsListFailure !== undefined) return { ok: false as const, error: state.recordsListFailure }
          return { ok: true as const, value: state.records.map(record => ({ ...record })) }
        },
        delete: async (key: string) => {
          state.order.push(`records:delete:${key}`)
          state.recordsDeleteCalls.push(key)
          await state.recordsGate?.()
          if (state.recordsDeleteFailure !== undefined) return { ok: false as const, error: state.recordsDeleteFailure }
          state.records = state.records.filter(record => record.key !== key)
          return { ok: true as const, value: undefined }
        },
      },
    },
    commands: {
      execute: async (sessionId: string, line: string, attachments: readonly unknown[], signal: AbortSignal) => {
        state.executeCalls.push({ sessionId, line, attachments, signal })
        return state.executeResult
      },
    },
    permissionPresets: {
      catalog: async () => ({
        ok: true as const,
        value: {
          options: state.permissionOptions.map(option => ({ ...option })),
          ...state.permissionDefaultPreset === undefined ? {} : { defaultPreset: state.permissionDefaultPreset },
        },
      }),
    },
    agentPresets: {
      list: async () => ({ ok: true as const, value: { presets: state.presetRoster.map(row => ({ ...row })) } }),
      select: async () => ({ ok: true as const, value: 'x' }),
    },
    llm: {
      listConfigurableProviders: async () => state.providers === undefined
        ? { ok: false as const, error: { code: 'gateway/service-unavailable', message: 'no directory' } }
        : { ok: true as const, value: state.providers.map(entry => ({ ...entry, settingsPath: [...entry.settingsPath] })) },
      discoverModels: async () => ({ ok: true as const, value: [] }),
    },
    ...options.authorization === false ? {} : {
      piTuiAuthorization: {
        list: async () => {
          state.order.push('authorization:list')
          if (state.authorizationListOutcome?.kind === 'throw') {
            throw new Error(state.authorizationListOutcome.error.message)
          }
          if (state.authorizationListOutcome?.kind === 'unavailable') {
            return { ok: true as const, value: { kind: 'unavailable' as const, reason: state.authorizationListOutcome.reason } }
          }
          return {
            ok: true as const,
            value: {
              kind: 'ready' as const,
              targets: state.authorizationRoster.map(target => ({
                ...target,
                ...(target.route === undefined ? {} : { route: target.route }),
                methods: target.methods.map(method => ({ ...method })),
              })),
            },
          }
        },
        run: () => { throw new Error('authorization.run is unused by the ConfigPort') },
        respond: async () => ({ ok: true as const, value: undefined }),
        cancel: async () => ({ ok: true as const, value: undefined }),
      },
    },
    // A METHOD with a real `this`, like the generated Client `$on`: it reads
    // its own service state, so a detached reference must throw. This is the
    // regression lock for the P11-class bug (an unbound event seat).
    $on(this: unknown, event: string, listener: EventListener) {
      if (this !== wire) {
        throw new TypeError("Cannot read properties of undefined (reading 'subscribe')")
      }
      state.order.push(`$on:${event}`)
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        state.order.push(`off:${event}`)
      }
    },
  }

  // The generated Client exposes each namespace through a prototype ACCESSOR.
  // The fixture mirrors that shape — non-enumerable accessors over the members
  // above — so an own-property copy (`{ ...remote }`) inside the adapter loses
  // every namespace instead of silently keeping them (the namespace-loss P1).
  wire = {}
  for (const [key, value] of Object.entries(remote)) {
    Object.defineProperty(wire, key, { get: () => value, enumerable: false, configurable: false })
  }
  const port = new RemoteConfigPort({
    remote: wire as never,
    connection: { generation: generation.source },
  })
  return { port, state, generation, emit, listeners, wire }
}

/** The create decision over the REAL Remote provider adapter: the other
 *  workflow seams are inert, because these tests exercise the mirrored
 *  catalog classification and the wire mutation sink only. */
function workflowOver(providers: ProviderProfileConfig): CredentialWorkflow {
  return new CredentialWorkflow({
    providers,
    credentials: {
      available: () => true,
      setReference: async () => {},
      unsetReference: async () => {},
      recordsSupported: () => false,
      deleteRecord: async () => {},
      describeReference: async () => ({ configured: false }),
      listRecords: async () => [],
      onChanged: () => () => {},
    },
    authorization: { available: () => false, listTargets: () => [], refreshTargets: async () => {}, targetsState: () => 'unavailable' as const, begin: async () => ({ kind: 'unavailable' as const }), onEvent: () => () => {}, respond: async () => {}, cancel: async () => {} },
    account: {
      available: () => false,
      isObservationCurrent: () => false,
      getState: async () => { throw new Error('unused') },
      getProfile: async () => null,
      getBalance: async () => null,
      watch: async function* () {},
      getCallbackOrigin: () => undefined,
      startSignIn: async () => { throw new Error('unused') },
      cancelSignIn: async () => { throw new Error('unused') },
      signOut: async () => { throw new Error('unused') },
      hasRunningAccountTasks: async () => false,
    },
    catalog: { models: { available: () => false, discoverModels: async () => [] } },
    signal: new AbortController().signal,
    diag: { error: () => {}, warn: () => {} },
  })
}

/* ------------------------------------------------------------------------- *
 * Wire shape.
 * ------------------------------------------------------------------------- */

test('an accessor-backed wire survives the adapter, an own-property copy never would (namespace-loss P1)', async () => {
  const { port, state, wire } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
  })
  // The generated Client object exposes namespaces as prototype accessors, so it
  // has nothing own-enumerable to copy: rebuilding the object (`{ ...remote }`,
  // or spreading it into a wrapper) drops EVERY namespace. That is precisely how
  // the P1 defect reached a real Client and made each namespace `undefined`
  // while every structural fake still passed.
  assert.deepEqual({ ...wire }, {}, 'an own-property copy of the wire carries no namespace')
  await port.describe()
  assert.equal(port.configReadiness(), 'ready')
  const tuiSettings = port.tuiSettings
  assert.ok(tuiSettings !== undefined, 'the accessor-backed namespace is served')
  assert.equal(tuiSettings.get().theme, TUI_DEFAULTS.theme)
  assert.equal(state.describeCalls, 1)
})

/* ------------------------------------------------------------------------- *
 * Mirror lifecycle.
 * ------------------------------------------------------------------------- */

test('the invalidation listeners are installed before the first describe', async () => {
  const { port, state } = createBackend()
  assert.equal(state.order.includes('describe'), false, 'no read happens at construction')
  await port.describe()
  const firstDescribe = state.order.indexOf('describe')
  const before = state.order.slice(0, firstDescribe)
  assert.ok(before.length > 0, 'listeners were registered in the constructor')
  assert.ok(before.every(entry => entry.startsWith('$on:')), 'every registration precedes the first read')
  assert.deepEqual(
    [...new Set(before)],
    ['$on:settings/document-updated', '$on:llm/adapters-updated', '$on:permission-presets/catalog-changed'],
  )
})

test('a describe that raced an invalidation discards the stale result and re-describes', async () => {
  const { port, state, emit } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { theme: 'dark' }, revision: 1 })
  })
  let raced = false
  state.describeGate = () => {
    if (raced) return
    raced = true
    // A committed document change lands while the first read is in flight.
    state.namespaces.get(TUI_NS)!.value.theme = 'light'
    emit('settings/document-updated', TUI_NS, 2)
  }
  await port.describe()
  assert.equal(state.describeCalls, 2, 'the raced read is discarded and re-read')
  assert.equal(port.readiness(), 'ready')
  assert.equal(port.tuiSettings?.get().theme, 'light', 'only the fresh commit is authoritative')
})

test('an invalidation reruns the describe so the mirror becomes current again', async () => {
  const { port, state, emit } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS, theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  state.namespaces.get(TUI_NS)!.value.theme = 'light'
  emit('settings/document-updated', TUI_NS, 2)
  assert.equal(port.readiness(), 'stale', 'the invalidation marks the snapshot non-current immediately')
  await port.describe()
  assert.equal(port.readiness(), 'ready')
  assert.equal(port.tuiSettings?.get().theme, 'light')
  assert.equal(port.lastRefreshFailure(), undefined)
})

test('a reconnect marks the snapshot stale until a fresh describe commits', async () => {
  const { port, state, generation } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  assert.equal(port.readiness(), 'ready')

  generation.set(undefined)
  const calls = state.describeCalls
  assert.equal(port.readiness(), 'unavailable')
  await port.describe()
  assert.equal(state.describeCalls, calls, 'a disconnected describe never reads or commits')
  assert.equal(port.readiness(), 'unavailable')
  assert.equal(port.tuiSettings?.get().theme, 'dark', 'the last-known display value stays readable')

  state.namespaces.get(TUI_NS)!.value.theme = 'light'
  generation.set({ id: 'gen-2' })
  assert.equal(port.readiness(), 'stale')
  await port.describe()
  assert.equal(port.readiness(), 'ready')
  assert.equal(port.tuiSettings?.get().theme, 'light', 'the reconnect snapshot is the new authority')
})

test('writes are serialized against other writes, and a superseded whole-document write is refused', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  let release!: () => void
  state.mutateGate = () => new Promise<void>(resolve => { release = resolve })

  const settings = port.tuiSettings!
  // BOTH documents are reconciled against revision 1: the second caller read
  // the mirror BEFORE the first write settled. The second write must therefore
  // be refused by the official revision check instead of being re-authorized
  // against the revision the first write produced.
  const first = settings.replace({ ...settings.get(), theme: 'light' })
  const second = settings.replace({ ...settings.get(), theme: 'solar' })
  await tick()
  assert.equal(state.mutateCalls.length, 1, 'the second write waits for the first to settle')

  release()
  await first
  await assert.rejects(async () => { await second }, /revision 1 != 2/)
  assert.equal(state.mutateCalls.length, 2)
  assert.deepEqual(
    state.mutateCalls.map(call => call.revision),
    [1, 1],
    'each write carries the revision its ops were reconciled against',
  )
  assert.equal(state.namespaces.get(TUI_NS)!.value.theme, 'light', 'the superseded write never reached the document')
})

test('two serialized whole-document writes reconcile against the revision they just read', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS, theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  const settings = port.tuiSettings!
  // The production caller shape: get → modify → replace INSIDE the shared
  // serialization queue, so every write reads a document whose revision the
  // previous write's authoritative refresh already committed. No spurious
  // conflict may appear here.
  await serializeTuiSettingsMutation(settings, async () => { await settings.replace({ ...settings.get(), theme: 'light' }) })
  await serializeTuiSettingsMutation(settings, async () => { await settings.replace({ ...settings.get(), theme: 'dark' }) })
  assert.deepEqual(state.mutateCalls.map(call => call.revision), [1, 2])
  assert.equal(state.namespaces.get(TUI_NS)!.value.theme, 'dark')
  assert.equal(settings.get().theme, 'dark', 'the mirror follows authority after each write')
})

test('a whole-document write whose reconciliation base moved is refused, never applied on the newer revision', async () => {
  const { port, state, emit } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS, theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  const settings = port.tuiSettings!
  const write = settings.replace({ ...settings.get(), theme: 'light' })
  // Between the reconciliation and the queued write's pre-flight refresh, an
  // EXTERNAL writer commits a different value at the next revision.
  const entry = state.namespaces.get(TUI_NS)!
  entry.value.theme = 'solar'
  entry.revision = 2
  emit('settings/document-updated', TUI_NS, 2)

  await assert.rejects(async () => { await write }, /revision 1 != 2/)
  assert.deepEqual(
    state.mutateCalls.map(call => call.revision),
    [1],
    'the fence is the revision the ops were reconciled against, not the refreshed one',
  )
  assert.equal(entry.value.theme, 'solar', 'the concurrent external write is preserved')
  assert.equal(settings.get().theme, 'solar', 'and the mirror reports the authoritative value')
  assert.equal(port.configReadiness(), 'ready')
})

test('a write refreshes from authority after settlement and never patches optimistically', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  const callsBefore = state.describeCalls
  // The Host accepts the write, but the authoritative section is unchanged
  // (for example a concurrent external edit won): the mirror must keep the
  // authoritative value, never the requested one.
  state.mutateApplies = false

  const settings = port.tuiSettings!
  await settings.replace({ ...settings.get(), theme: 'light' })

  const mutateIndex = state.order.indexOf('mutate')
  const refreshIndex = state.order.findIndex((entry, index) => index > mutateIndex && entry === 'describe')
  assert.ok(refreshIndex > mutateIndex, 'a describe runs after the official settlement')
  assert.ok(state.describeCalls > callsBefore)
  assert.equal(settings.get().theme, 'dark', 'authority wins over the requested local edit')
})

test('the mirror dispose releases every subscription exactly once', async () => {
  const { port, state } = createBackend()
  port.dispose()
  port.dispose()
  assert.equal(
    state.order.filter(entry => entry.startsWith('off:')).length,
    3,
    'the three forwarded-event subscriptions are released once each',
  )
})

/* ------------------------------------------------------------------------- *
 * Credentials.
 * ------------------------------------------------------------------------- */

test('credentials reference set/unset/describe maps the official RemoteResult', async () => {
  const { port } = createBackend()
  assert.deepEqual(await port.credentials.describeReference('FOO_API_KEY'), { configured: false })
  await port.credentials.setReference('FOO_API_KEY', 'sk-secret')
  assert.deepEqual(await port.credentials.describeReference('FOO_API_KEY'), { configured: true, source: 'provider' })
  await port.credentials.unsetReference('FOO_API_KEY')
  assert.deepEqual(await port.credentials.describeReference('FOO_API_KEY'), { configured: false })
})

test('credentials change events notify once per event and dispose exactly once', () => {
  const { port, state, emit } = createBackend()
  const seen: number[] = []
  const unsubscribe = port.credentials.onChanged(() => { seen.push(1) })

  emit('credentials/reference-updated', 'FOO_API_KEY')
  assert.equal(seen.length, 1, 'one event is exactly one refresh notification')
  emit('credentials/reference-updated', 'FOO_API_KEY')
  assert.equal(seen.length, 2)
  emit('credentials/record-updated', 'scope/id')
  assert.equal(seen.length, 3)

  unsubscribe()
  unsubscribe()
  emit('credentials/reference-updated', 'FOO_API_KEY')
  assert.equal(seen.length, 3, 'a disposed subscription never notifies again')
  assert.equal(state.order.filter(entry => entry === 'off:credentials/reference-updated').length, 1)
  assert.equal(state.order.filter(entry => entry === 'off:credentials/record-updated').length, 1)
})

test('a port dispose releases an active credential subscription exactly once', () => {
  const { port, state } = createBackend()
  port.credentials.onChanged(() => {})
  port.dispose()
  port.dispose()
  assert.equal(state.order.filter(entry => entry === 'off:credentials/reference-updated').length, 1)
  assert.equal(state.order.filter(entry => entry === 'off:credentials/record-updated').length, 1)
})

test('credential record list/delete map the mounted private namespace (metadata only)', async () => {
  const { port, state, generation } = createBackend(current => {
    current.records = [
      { key: 'llm-pi-ai/f7b-grant', kind: 'grant' },
      { key: 'other-plugin/f7b-orphan', kind: 'api-key' },
    ]
  })
  assert.equal(port.credentials.recordsSupported(), true)
  assert.deepEqual(await port.credentials.listRecords(), [
    { key: 'llm-pi-ai/f7b-grant', kind: 'grant' },
    { key: 'other-plugin/f7b-orphan', kind: 'api-key' },
  ])
  // The exact key deletes exactly one row through the private namespace; it is
  // never an `unset()` of some derived reference.
  await port.credentials.deleteRecord('llm-pi-ai/f7b-grant')
  assert.deepEqual(state.recordsDeleteCalls, ['llm-pi-ai/f7b-grant'])
  assert.deepEqual(await port.credentials.listRecords(), [{ key: 'other-plugin/f7b-orphan', kind: 'api-key' }])
  // The empty store is a REAL answer, and it is never cached.
  state.records = []
  assert.deepEqual(await port.credentials.listRecords(), [])
  // An invalid key is refused locally, before any dispatch.
  await assert.rejects(() => port.credentials.deleteRecord('DEEPSEEK_API_KEY'), /<scope>\/<id>/u)
  assert.deepEqual(state.recordsDeleteCalls, ['llm-pi-ai/f7b-grant'])
  // A replaced Host must not present the old answer as the current list.
  let release!: () => void
  state.recordsGate = () => new Promise<void>(resolve => { release = resolve })
  const stale = port.credentials.listRecords()
  await tick()
  generation.set({ id: 'gen-2' })
  release()
  await assert.rejects(stale, (error: unknown) => error instanceof Error && error.name === 'SupersededReadError')
})

test('a Host without the private record namespace is a truthful capability gap, never an empty list', async () => {
  const { port } = createBackend(undefined, { records: false })
  assert.equal(port.credentials.recordsSupported(), false)
  await assert.rejects(
    () => port.credentials.listRecords(),
    /private record namespace is not mounted/,
  )
  await assert.rejects(
    () => port.credentials.deleteRecord('llm-pi-ai/f7b-grant'),
    /private record namespace is not mounted/,
  )
})

/* ------------------------------------------------------------------------- *
 * Explicitly unsupported classes.
 * ------------------------------------------------------------------------- */

test('a Host without the private authorization namespace reports an unavailable roster, never a fake flow', async () => {
  const { port } = createBackend(undefined, { authorization: false })
  // Before the first authoritative read the roster is STALE, never an empty
  // ready catalog.
  assert.equal(port.authorization.targetsState(), 'stale')
  assert.equal(port.authorization.available(), false)
  assert.deepEqual(port.authorization.listTargets(), [])
  await port.authorization.refreshTargets()
  // The mounted contribution is the only provider of the namespace: its
  // absence is a definite unavailable, distinct from "no flows registered".
  assert.equal(port.authorization.targetsState(), 'unavailable')
  assert.deepEqual(port.authorization.listTargets(), [])
  assert.deepEqual(await port.authorization.begin({ key: 'openai' }), { kind: 'unavailable' })
  const unsubscribe = port.authorization.onEvent(() => {})
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
  // No attempt was admitted, so there is no exact attempt to answer or cancel.
  await assert.rejects(() => port.authorization.respond('a', 'p', 'x'), /no longer active/)
  await assert.rejects(() => port.authorization.cancel('a'), /no longer active/)
})

test('the initial describe loads the REAL authorization roster once; a generation replacement marks it stale', async () => {
  const { port, generation, state } = createBackend(current => {
    current.authorizationRoster = [{
      kind: 'authorization',
      route: 'openai-codex',
      key: 'llm-pi-ai/openai-codex',
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      inFlight: false,
    }]
  })
  assert.equal(port.authorization.targetsState(), 'stale')
  await port.describe()
  assert.equal(port.authorization.targetsState(), 'ready')
  assert.deepEqual(port.authorization.listTargets(), [{
    kind: 'authorization',
    route: 'openai-codex',
    key: 'llm-pi-ai/openai-codex',
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
  }])
  const listCalls = state.order.filter(entry => entry === 'authorization:list').length
  assert.equal(listCalls, 1, 'the initial barrier reads the roster exactly once')
  // A second describe on a still-current generation does not re-poll it.
  await port.describe()
  assert.equal(state.order.filter(entry => entry === 'authorization:list').length, listCalls)
  // A generation replacement immediately invalidates the roster.
  generation.set({ id: 'gen-2' })
  assert.equal(port.authorization.targetsState(), 'stale')
  await port.describe()
  assert.equal(port.authorization.targetsState(), 'ready')
  assert.equal(state.order.filter(entry => entry === 'authorization:list').length, listCalls + 1)
  port.dispose()
})

test('a generation replacement invalidates an UNAVAILABLE roster and describe re-reads the new Host capability', async () => {
  const target = {
    kind: 'authorization' as const,
    route: 'openai-codex',
    key: 'llm-pi-ai/openai-codex',
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
  }
  const { port, generation, state } = createBackend(current => {
    current.authorizationListOutcome = { kind: 'unavailable', reason: 'the Host authorization service is not installed' }
  })
  await port.describe()
  assert.equal(port.authorization.targetsState(), 'unavailable')
  const calls = (): number => state.order.filter(entry => entry === 'authorization:list').length
  const before = calls()

  // Host A had no authorization service; the replacement Host B does. The old
  // definite `unavailable` is a fact about A and must not survive the switch.
  state.authorizationListOutcome = undefined
  state.authorizationRoster = [target]
  generation.set({ id: 'gen-2' })
  assert.equal(port.authorization.targetsState(), 'stale',
    'an unavailable verdict from the old generation is not current for the new one')
  await port.describe()
  assert.equal(port.authorization.targetsState(), 'ready')
  assert.equal(calls(), before + 1, 'describe re-reads the roster for the new generation')
  assert.deepEqual(port.authorization.listTargets(), [target])
  assert.equal(port.authorization.available(), true)
  port.dispose()
})

test('the retired permission approval members are gone (M6-1 F8: SessionPolicyPort owns the semantic)', () => {
  const { port } = createBackend()
  assert.equal('approvalOverrideOf' in port.permissions, false,
    'the retired synchronous approval read no longer exists on the permission sub-domain')
  assert.equal('approvalOverrideAvailable' in port.permissions, false,
    'the retired availability flag no longer exists either')
})

/* ------------------------------------------------------------------------- *
 * Permissions.
 * ------------------------------------------------------------------------- */

test('permission presets map the catalog, the settings default, and the official apply line', async () => {
  const { port, state } = createBackend(current => {
    current.permissionOptions.push(
      { value: 'workspace-write', name: 'Workspace write' },
      { value: 'danger-full-access', name: 'Danger' },
    )
    current.permissionDefaultPreset = 'workspace-write'
  })
  await port.describe()
  assert.deepEqual([...port.permissions.presetNames()], ['workspace-write', 'danger-full-access'])
  assert.equal(port.permissions.defaultPreset(), 'workspace-write')

  // A saved user preference shadows the catalog default.
  state.namespaces.set('permission', {
    ns: 'permission',
    value: { defaultPreset: 'danger-full-access' },
    revision: 2,
  })
  await port.describe()
  assert.equal(port.permissions.defaultPreset(), 'danger-full-access')

  const applySignal = new AbortController().signal
  assert.deepEqual(
    await port.permissions.applyPermissionPreset('session-a', 'danger-full-access', applySignal),
    { kind: 'applied' },
  )
  assert.equal(state.executeCalls.length, 1)
  assert.equal(state.executeCalls[0]?.signal, applySignal,
    'the Remote adapter forwards the caller signal by IDENTICAL reference (never a fake)')
  assert.deepEqual(state.executeCalls[0], {
    sessionId: 'session-a',
    line: '/permission danger-full-access',
    attachments: [],
    signal: applySignal,
  })

  // An unknown preset never reaches the official command line.
  assert.deepEqual(
    await port.permissions.applyPermissionPreset('session-a', 'bogus', applySignal),
    { kind: 'unavailable', cause: 'permission' },
  )
  assert.equal(state.executeCalls.length, 1)

  await port.permissions.setDefaultPreset('workspace-write')
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1], {
    ns: 'permission',
    ops: [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }],
    revision: 2,
  })
})

/* ------------------------------------------------------------------------- *
 * Preset default + subagent model selection.
 * ------------------------------------------------------------------------- */

test('presetDefault falls back to the roster default and round-trips the saved value', async () => {
  const { port, state } = createBackend(current => {
    current.presetRoster.push({ id: 'alpha', isDefault: true }, { id: 'beta' })
  })
  await port.describe()
  assert.equal(port.presetDefault.available(), true)
  assert.equal(port.presetDefault.get(), 'alpha', 'no saved value falls back to the roster default')

  state.namespaces.set('agent-preset-registry', {
    ns: 'agent-preset-registry',
    value: { selectedDefault: 'beta' },
    revision: 1,
  })
  await port.describe()
  assert.equal(port.presetDefault.get(), 'beta')

  await port.presetDefault.set('alpha')
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1], {
    ns: 'agent-preset-registry',
    ops: [{ op: 'set', path: ['selectedDefault'], value: 'alpha' }],
    revision: 1,
  })
  // The authoritative refresh committed the persisted value.
  assert.equal(port.presetDefault.get(), 'alpha')
})

test('subagent model selection validates, writes the official section, and rolls back a failed write', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(SUBAGENT_NS, {
      ns: SUBAGENT_NS,
      value: { enabled: false, allowedModels: [] },
      revision: 1,
    })
  })
  await port.describe()
  assert.equal(port.subagentModelSelection.available(), true)
  assert.deepEqual(port.subagentModelSelection.get(), { enabled: false, allowedModels: [] })

  await assert.rejects(
    () => port.subagentModelSelection.set({ enabled: true, allowedModels: [] }),
    /requires at least one allowed model/,
  )
  await assert.rejects(
    () => port.subagentModelSelection.set({ enabled: false, allowedModels: [{ provider: '', model: 'm' }] }),
    /non-empty provider and model ids/,
  )
  await assert.rejects(
    () => port.subagentModelSelection.set({
      enabled: false,
      allowedModels: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }],
    }),
    /repeats route "p\/m"/,
  )

  await port.subagentModelSelection.set({ enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] })
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1], {
    ns: SUBAGENT_NS,
    ops: [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['allowedModels'], value: [{ provider: 'p', model: 'm' }] },
    ],
    revision: 1,
  })
  assert.deepEqual(port.subagentModelSelection.get(), { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] })

  // A failed Host write must leave the authoritative state intact.
  state.mutateFailure = { code: 'settings/rejected', message: 'refused' }
  await assert.rejects(
    () => port.subagentModelSelection.set({ enabled: true, allowedModels: [{ provider: 'q', model: 'n' }] }),
    /settings\.mutate\(subagent-model-selection-settings\) failed: refused/,
  )
  assert.deepEqual(port.subagentModelSelection.get(), { enabled: true, allowedModels: [{ provider: 'p', model: 'm' }] })
})

/* ------------------------------------------------------------------------- *
 * Footer trust / custom items (USER layer only).
 * ------------------------------------------------------------------------- */

test('footer trust reads ONLY the USER layer: a project-layer command can never grant trust', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, {
      ns: TUI_NS,
      value: {
        footer: 'command',
        footerCommand: { schemaVersion: 1, command: 'echo project-owned' },
        footerLayout: VALID_LAYOUT,
      },
      user: { footer: 'compact' },
      revision: 1,
    })
  })
  await port.describe()
  const trust = port.footerCommandTrust
  assert.equal(trust.userFooterMode, 'compact')
  assert.equal(trust.command === undefined, true, 'the merged project command is not trusted')
  assert.equal(trust.userCommandItemActivationIds.size, 0)
  assert.equal(trust.userCommandItemFallbackActivationIds.size, 0)

  // The USER opts into command mode and fallback: the layout refs authorize.
  state.namespaces.set(TUI_NS, {
    ns: TUI_NS,
    value: {
      footer: 'command',
      footerCommand: { schemaVersion: 1, command: 'echo user-owned' },
      footerLayout: VALID_LAYOUT,
    },
    user: {
      footer: 'command',
      footerFallbackMode: 'custom',
      footerCommand: { schemaVersion: 1, command: 'echo user-owned' },
      footerLayout: VALID_LAYOUT,
    },
    revision: 2,
  })
  await port.describe()
  assert.equal(trust.userFooterMode, 'command')
  assert.equal(trust.command?.command, 'echo user-owned')
  assert.deepEqual([...trust.userCommandItemFallbackActivationIds], ['user:clock'])
  assert.equal(trust.userCommandItemActivationIds.size, 0, 'command mode authorizes no custom item runner')

  // footer: custom authorizes the USER custom layout refs.
  state.namespaces.set(TUI_NS, {
    ns: TUI_NS,
    value: { footer: 'custom', footerLayout: VALID_LAYOUT },
    user: { footer: 'custom', footerLayout: VALID_LAYOUT },
    revision: 3,
  })
  await port.describe()
  assert.deepEqual([...trust.userCommandItemActivationIds], ['user:clock'])
})

test('footerCustomItems reads the USER layer for both the runtime view and persistence', async () => {
  const items = [{ schemaVersion: 1, id: 'user:clock', kind: 'text', text: 'hi' }]
  const { port } = createBackend(current => {
    current.namespaces.set(TUI_NS, {
      ns: TUI_NS,
      value: {},
      user: { footerCustomItems: items },
      revision: 1,
    })
  })
  await port.describe()
  assert.deepEqual(port.footerCustomItems.get(), { items, invalidCount: 0 })
  assert.deepEqual(port.footerCustomItems.rawForPersistence(), { kind: 'available', value: items })
})

/* ------------------------------------------------------------------------- *
 * Providers.
 * ------------------------------------------------------------------------- */

test('a failed provider-directory read is reported, never an authoritative empty catalog', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } }, revision: 1 })
    // The wire directory read FAILS (an empty directory is a successful read).
    current.providers = undefined
  })
  await port.describe()
  const catalog = port.providers.readCatalog()
  assert.ok(catalog.failure !== undefined, 'a failed directory read must be reported')
  assert.match(catalog.failure, /provider directory/u)
  assert.equal(catalog.options.length, 0)
  assert.equal(state.describeCalls >= 1, true)
})

test('the provider create is conditional: an existing route is refused, a new one is revision-checked', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } }, revision: 4 })
  })
  await port.describe()
  // An EXISTING route: the create must refuse it, never overwrite it.
  await assert.rejects(
    () => port.providers.writeProfile('acme', { api: 'openai-completions', baseURL: 'https://acme.example/v1' }),
    /already exists/u,
  )
  assert.equal(state.mutateCalls.length, 0, 'a refused create must not write')
  // A NEW route: the write carries the revision the decision was read at.
  await port.providers.writeProfile('new-route', { api: 'openai-completions', baseURL: 'https://new.example/v1' })
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0]?.revision, 4, 'the write carries the decision read revision')
})

test('a failed directory read does not make the last-known routes a command authority', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: {} }, revision: 1 })
    current.providers = [{
      provider: 'acme',
      displayName: 'Acme',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme'],
    }]
  })
  await port.describe()
  assert.ok(port.providers.listCredentialOptions().some(option => option.route === 'acme'))
  // The directory read now fails: the last-known routes are NOT a current
  // route→credential authority (after a reconnect they may belong to another
  // Host), so the command resolver must not use them.
  state.providers = undefined
  await port.describe()
  const options = port.providers.listCredentialOptions()
  assert.equal(options.some(option => option.route === 'acme'), false, 'the stale route must not be a command authority')
  const official = options.find(option => option.route === 'deepseek-official')
  assert.ok(official !== undefined, 'the builtin target stays addressable')
  // BOTH resolver paths stay on the builtin: the stale route is not an
  // authority for /login or /logout.
  assert.deepEqual(resolveLoginDestination('deepseek-official', options, []), {
    kind: 'models',
    view: 'reference',
    ref: 'DEEPSEEK_API_KEY',
    label: 'deepseek official',
  })
  assert.deepEqual(resolveLogoutDestination('deepseek-official', options, []), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'reference', ref: 'DEEPSEEK_API_KEY', label: 'deepseek official', route: 'deepseek-official' },
  })
  // The dangerous path is /logout: the stale route must not become a clear
  // target (the argument falls back to the documented literal-reference
  // reading, which addresses a reference, never the stale route).
  const logout = resolveLogoutDestination('acme', options, [])
  const clearedRoute = logout.kind === 'models' && logout.view === 'logout' ? logout.target.route : undefined
  assert.notEqual(clearedRoute, 'acme', 'the stale route must not become a clear target')
})

test('a stale mirror never makes the last-known references a command authority', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } }, revision: 3 })
    current.providers = [{
      provider: 'acme',
      displayName: 'Acme',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme'],
    }]
  })
  await port.describe()
  assert.ok(port.providers.listCredentialOptions().some(option => option.route === 'acme'))
  // The settings read now fails: the mirror keeps the LAST KNOWN namespace,
  // and its reference belongs to the previous generation (after a reconnect
  // it may belong to another Host).
  state.describeFailure = { code: 'gateway/unavailable', message: 'host gone' }
  await assert.rejects(() => port.describe())
  const options = port.providers.listCredentialOptions()
  assert.equal(options.some(option => option.route === 'acme'), false, 'a stale route must not be a command authority')
  assert.equal(options.some(option => option.ref === 'ACME_KEY'), false, 'a stale reference must not be a command authority')
  const official = options.find(option => option.route === 'deepseek-official')
  assert.ok(official !== undefined, 'the builtin target stays addressable')
})

test('the keyless profile write refuses to overwrite an existing profile', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } }, revision: 3 })
    current.providers = [{
      provider: 'acme',
      displayName: 'Acme',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme'],
    }]
  })
  await port.describe()
  // The route already has a profile: the keyless write must be SKIPPED.
  assert.deepEqual(await port.providers.writeKeylessProfile('acme'), {
    kind: 'skipped',
    reason: 'provider route "acme" already has a profile',
  })
  assert.equal(state.mutateCalls.length, 0, 'nothing may be written')
  // A route without a profile is written with the decision read's revision.
  state.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: {} }, revision: 8 })
  state.providers = [{
    provider: 'new-route',
    displayName: 'New',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'new-route'],
  }]
  await port.describe()
  assert.deepEqual(await port.providers.writeKeylessProfile('new-route'), { kind: 'written' })
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0]?.revision, 8, 'the write carries the decision read revision')
})

test('a stale configuration mirror is not projected as a current catalog', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } }, revision: 1 })
    current.providers = [{
      provider: 'acme',
      displayName: 'Acme',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme'],
    }]
  })
  await port.describe()
  const fresh = port.providers.readCatalog()
  assert.equal(fresh.failure, undefined)
  assert.equal(fresh.stale, undefined, 'a ready mirror is a current catalog')
  assert.equal(fresh.options.length, 2)
  // The settings read now fails: the mirror keeps the last known values and
  // reports them as NOT current.
  state.describeFailure = { code: 'gateway/unavailable', message: 'host gone' }
  await assert.rejects(() => port.describe())
  const stale = port.providers.readCatalog()
  assert.equal(stale.stale, true, 'a stale mirror must be marked not current')
  assert.equal(stale.failure, undefined)
  assert.equal(stale.options.length, 2, 'the last known values stay readable')
})

test('provider options and keyless writes share one profile-slot rule', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: {} }, revision: 1 })
    current.providers = [{
      provider: 'acme',
      displayName: 'Acme',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'acme'],
    }]
  })
  await port.describe()
  const options = port.providers.listCredentialOptions()
  const official = options.find(option => option.route === 'deepseek-official')
  assert.equal(official?.canProvisionProfile, false, 'the builtin has no provider-profile slot')
  const acme = options.find(option => option.route === 'acme')
  assert.equal(acme?.canProvisionProfile, true)
  assert.equal(acme?.ref, 'ACME_API_KEY')

  assert.deepEqual(await port.providers.writeKeylessProfile('deepseek-official'), {
    kind: 'skipped',
    reason: 'the deepseek official builtin has no provider-profile slot',
  })
  assert.deepEqual(await port.providers.writeKeylessProfile('nope'), {
    kind: 'skipped',
    reason: 'no configurable-provider entry for nope',
  })

  assert.deepEqual(await port.providers.writeKeylessProfile('acme'), { kind: 'written' })
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1].ops, [
    { op: 'set', path: ['providers', 'acme'], value: {} },
  ])

  // The create is CONDITIONAL: `acme` already has the keyless profile, so a
  // second write for it is refused instead of overwriting it.
  await assert.rejects(
    () => port.providers.writeProfile('acme', { apiKeyEnv: 'ACME_API_KEY' }),
    /already exists/u,
  )
  // A route that does not exist yet is written at the SAME conventional slot.
  await port.providers.writeProfile('acme-two', { apiKeyEnv: 'ACME_TWO_API_KEY' })
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1].ops, [
    { op: 'set', path: ['providers', 'acme-two'], value: { apiKeyEnv: 'ACME_TWO_API_KEY' } },
  ])
  await assert.rejects(() => port.providers.writeProfile('deepseek-official', {}), /invalid provider route/)
})

test('a mirrored manual-only route cannot be created in the conventional slot (P1)', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', value: { providers: {} }, revision: 1 })
    // The route exists in the mirrored directory but its profile lives in
    // its own section, so the Remote catalog reports it as manual-only.
    current.providers = [{
      provider: 'legacy',
      displayName: 'Legacy',
      settingsNs: 'vendor-settings',
      settingsPath: ['provider'],
    }]
  })
  await port.describe()
  const catalog = port.providers.readCatalog()
  assert.equal(catalog.failure, undefined)
  const legacy = catalog.options.find(option => option.route === 'legacy')
  assert.ok(legacy !== undefined)
  assert.equal(legacy.configured, false, 'no profile exists yet')
  assert.equal(legacy.canProvisionProfile, false, 'the mirrored slot is not the conventional one')
  const workflow = workflowOver(port.providers)
  const draft = {
    route: 'legacy',
    api: 'openai-completions',
    baseURL: 'https://legacy.example/v1',
    displayName: '',
    models: ['legacy-1'],
    apiKey: '',
  }
  // `configured === false` alone must NOT admit the create: the wire write
  // would land in the conventional slot while the mirror keeps reading the
  // route's own section.
  const rejected = await workflow.createProvider(draft)
  assert.equal(rejected.kind, 'rejected')
  assert.match(rejected.text, /own settings section/u)
  assert.equal(state.mutateCalls.length, 0, 'the refused create never reaches the wire mutation sink')
  // Positive control: a route the mirrored directory does not offer at all
  // is a fresh hand-declared route and creates in the conventional slot.
  const created = await workflow.createProvider({ ...draft, route: 'brand-new' })
  assert.equal(created.kind, 'created')
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0]!.ns, 'llm-pi-ai')
  assert.deepEqual(state.mutateCalls[0]!.ops, [
    { op: 'set', path: ['providers', 'brand-new'], value: { api: 'openai-completions', baseURL: 'https://legacy.example/v1', models: [{ id: 'legacy-1' }] } },
  ])
})

/* ------------------------------------------------------------------------- *
 * Raw settings round-trip.
 * ------------------------------------------------------------------------- */

test('raw settings fields round-trip verbatim and an unrelated write never touches them', async () => {
  const keybindings = { schemaVersion: 1, bindings: { ctrlx: 'app.exit' } }
  const footerCustomItems = [{ schemaVersion: 1, id: 'user:clock', kind: 'text', text: 'hi' }]
  const footerCommand = { schemaVersion: 1, command: 'echo hi', timeoutMs: 300 }
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, {
      ns: TUI_NS,
      value: {
        ...TUI_DEFAULTS,
        theme: 'dark',
        keybindings,
        footerCustomItems,
        footerCommand,
        footerLayout: VALID_LAYOUT,
      },
      revision: 1,
    })
  })
  await port.describe()
  const settings = port.tuiSettings
  assert.ok(settings !== undefined)
  const doc: TuiSettingsDoc = settings.get()
  assert.equal(doc.theme, 'dark')
  assert.equal(doc.gitAttribution, 'off')
  assert.deepEqual(doc.keybindings, keybindings)
  assert.deepEqual(doc.footerCustomItems, footerCustomItems)
  assert.deepEqual(doc.footerCommand, footerCommand)
  assert.deepEqual(doc.footerLayout, VALID_LAYOUT)

  await settings.replace({ ...doc, theme: 'light' })
  const ops = state.mutateCalls[state.mutateCalls.length - 1].ops
  assert.deepEqual(ops, [{ op: 'set', path: ['theme'], value: 'light' }], 'only the changed scalar is written')

  // The authoritative refresh preserves the raw fields verbatim.
  const after = settings.get()
  assert.equal(after.theme, 'light')
  assert.equal(after.gitAttribution, 'off')
  assert.deepEqual(after.keybindings, keybindings)
  assert.deepEqual(after.footerCustomItems, footerCustomItems)
  assert.deepEqual(after.footerCommand, footerCommand)
  assert.deepEqual(after.footerLayout, VALID_LAYOUT)
})

test('terminalProgress keeps Direct/Remote parity: missing resolves dual and the persisted value reads back', async () => {
  // A section that omits the field (an older saved document) still resolves to
  // the schema default `9;4+7501` through the adapter's own defaults.
  const { terminalProgress: _omitted, ...withoutProgress } = TUI_DEFAULTS
  const missing = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...withoutProgress }, revision: 1 })
  })
  await missing.port.describe()
  assert.equal(missing.port.tuiSettings?.get().terminalProgress, '9;4+7501',
    'a missing remote terminalProgress resolves to the dual-protocol default')

  // Every persisted mode is read back verbatim — including the retired `on`
  // value an older USER profile may still carry.
  for (const mode of ['9;4', '7501', '9;4+7501', 'off', 'on']) {
    const explicit = createBackend(current => {
      current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS, terminalProgress: mode }, revision: 1 })
    })
    await explicit.port.describe()
    assert.equal(explicit.port.tuiSettings?.get().terminalProgress, mode,
      `the persisted ${mode} value reads back verbatim`)
  }
})

test('every terminalProgress mode round-trips through the Remote authority with ONE path-scoped op', async () => {
  // The write must go to the OFFICIAL face and the value must come back from a
  // refreshed authority (never from an optimistic local write): the fake
  // `mutate` applies the ops to the namespace, and the mirror re-describes.
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
  })
  await port.describe()
  const settings = port.tuiSettings
  assert.ok(settings !== undefined)
  assert.equal(settings.get().terminalProgress, '9;4+7501')
  const mutatesBefore = state.mutateCalls.length
  for (const mode of ['9;4', '7501', 'off', '9;4+7501'] as const) {
    await settings.replace({ ...settings.get(), terminalProgress: mode })
    assert.equal(settings.get().terminalProgress, mode,
      `the ${mode} write must read back from the refreshed Remote authority`)
  }
  assert.deepEqual(state.mutateCalls.slice(mutatesBefore).map(call => call.ops), [
    [{ op: 'set', path: ['terminalProgress'], value: '9;4' }],
    [{ op: 'set', path: ['terminalProgress'], value: '7501' }],
    [{ op: 'set', path: ['terminalProgress'], value: 'off' }],
    [{ op: 'set', path: ['terminalProgress'], value: '9;4+7501' }],
  ], 'each mode change crosses as exactly ONE path-scoped op and nothing else')
  assert.equal(state.mutateCalls.length, mutatesBefore + 4,
    'no extra write RPC is issued per mode change')

  // Writing the inherited default over a USER override resets it (unset).
  const reset = createBackend(current => {
    current.namespaces.set(TUI_NS, {
      ns: TUI_NS,
      value: { ...TUI_DEFAULTS, terminalProgress: '9;4+7501' },
      user: { terminalProgress: 'off' },
      revision: 1,
    })
  })
  await reset.port.describe()
  const resetSettings = reset.port.tuiSettings
  assert.ok(resetSettings !== undefined)
  assert.equal(resetSettings.get().terminalProgress, '9;4+7501',
    'the effective value serves the inherited default while the USER override shadows it')
  const resetMutates = reset.state.mutateCalls.length
  await resetSettings.replace({ ...resetSettings.get(), terminalProgress: '9;4+7501' })
  assert.deepEqual(reset.state.mutateCalls[resetMutates]?.ops, [{ op: 'unset', path: ['terminalProgress'] }],
    'restating the inherited value unsets the USER override instead of pinning it')
})

test('tuiSettings is undefined until the tui-app namespace is present', async () => {
  const { port } = createBackend()
  await port.describe()
  assert.equal(port.tuiSettings, undefined)
})

test('the event seat stays method-bound: credential change events and mirror invalidation work', async () => {
  // `onChanged` and the mirror's invalidation listeners both go through the
  // Client `$on`, which reads its own service state. The fake `$on` above
  // throws when called detached, so this test fails if the adapter extracts
  // the seat without binding it.
  const { port, state, emit, generation } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
  })
  await port.describe()
  assert.equal(state.describeCalls, 1)

  // A forwarded document update re-reads from authority (invalidation fence).
  emit('settings/document-updated')
  await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  assert.ok(state.describeCalls >= 2, 'the invalidation triggered a re-describe')

  // Credential change events notify the local listener exactly once each and
  // the returned disposer removes both subscriptions.
  let notifications = 0
  const off = port.credentials.onChanged(() => { notifications += 1 })
  emit('credentials/reference-updated')
  emit('credentials/record-updated')
  assert.equal(notifications, 2, 'one notification per credential event')
  off()
  emit('credentials/reference-updated')
  emit('credentials/record-updated')
  assert.equal(notifications, 2, 'a disposed listener never fires again')
  off()
  assert.equal(state.order.filter(entry => entry === 'off:credentials/reference-updated').length, 1,
    'the disposer releases each subscription exactly once')

  // A generation replacement also invalidates the mirror (a new Host may have
  // a different document).
  const before = state.describeCalls
  generation.set({ id: 'gen-2' })
  await new Promise<void>(resolve => { setTimeout(resolve, 5) })
  assert.ok(state.describeCalls > before, 'a replaced generation re-reads')
  assert.equal(port.readiness(), 'ready', 'the committed snapshot belongs to the new generation')

  // dispose() releases the remaining subscriptions exactly once: the two
  // credential listeners were already released by the explicit `off()` above,
  // so only the three mirror subscriptions remain. A second dispose() is a
  // no-op (never a double-off).
  const offsBefore = [...state.order].filter(entry => entry.startsWith('off:')).length
  port.dispose()
  port.dispose()
  assert.equal([...state.order].filter(entry => entry.startsWith('off:')).length, offsBefore + 3,
    'each remaining subscription (3 mirror seats) is released exactly once')
})

test('configReadiness reports the mirror currentness truthfully and refuses writes explicitly', async () => {
  // §9.1: a consumer must be able to tell "this is the value" from "this was
  // the value", and a write against a non-current backend must fail with an
  // explicit reconnecting reason instead of a silent no-op.
  const { port, state, generation } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
  })
  // No committed read means there is nothing authoritative to present — not
  // even last-known values — so the consumer must not show its own built-in
  // defaults as Host values.
  assert.equal(port.configReadiness(), 'unavailable', 'no read yet: no authoritative values exist')
  assert.equal(port.tuiSettings, undefined, 'no namespace view is served before the first read')
  await port.describe()
  assert.equal(port.configReadiness(), 'ready')

  // A disconnected Connection has no authority at all.
  generation.set(undefined)
  assert.equal(port.configReadiness(), 'unavailable')
  await assert.rejects(
    async () => { await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: 'light' }) },
    /unavailable on this connection; the change was not saved/u,
  )

  // A reconnect leaves the last-known snapshot non-current until a read
  // commits. A write then REFRESHES from authority first (never an optimistic
  // local patch): once the refresh succeeds the write proceeds and the mirror
  // is current again.
  generation.set({ id: 'gen-2' })
  assert.equal(port.configReadiness(), 'stale')
  const mutationsBefore = state.mutateCalls.length
  await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: 'light' })
  assert.equal(state.mutateCalls.length, mutationsBefore + 1, 'the write refreshed and dispatched')
  assert.equal(port.configReadiness(), 'ready', 'the post-write authoritative refresh re-currents the mirror')
  assert.equal(port.tuiSettings!.get().theme, 'light')

  // When the pre-flight refresh CANNOT succeed, the write fails with the real
  // reason and dispatches nothing — never a silent no-op and never a local
  // success (no optimistic authority).
  state.describeFailure = { code: 'gateway/unavailable', message: 'host is reconnecting' }
  generation.set({ id: 'gen-3' })
  const mutationsAfter = state.mutateCalls.length
  await assert.rejects(
    async () => { await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: 'dark' }) },
    /settings\.describe failed: host is reconnecting/u,
  )
  assert.equal(state.mutateCalls.length, mutationsAfter, 'a refused write dispatches no mutate')
  assert.equal(port.configReadiness(), 'stale', 'the failed refresh leaves the mirror non-current')
  assert.ok(port.lastRefreshFailure() !== undefined, 'the failure is recorded for the UI')
})

test('a failed FIRST read yields no authoritative values and refuses writes with the real reason', async () => {
  // §9.1: "no snapshot" is not "last-known snapshot". Presenting the panel's
  // own built-in defaults as Host values would fabricate authority the backend
  // never had.
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
    current.describeFailure = { code: 'gateway/unavailable', message: 'offline' }
  })
  await assert.rejects(() => port.describe(), /settings\.describe failed/u)
  assert.equal(port.configReadiness(), 'unavailable', 'no committed snapshot: nothing to present')
  assert.equal(port.tuiSettings, undefined, 'the port serves no settings facade without a read')
  assert.ok(port.lastRefreshFailure() !== undefined, 'the failure is recorded for the UI')
  assert.equal(state.namespaces.get(TUI_NS)?.value.theme, TUI_DEFAULTS.theme,
    'the Host value is untouched: no write was dispatched without a read')
})

test('a committed write whose post-settlement refresh fails is not a refusal — but stays one for a rereading consumer', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS, theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  assert.equal(port.configReadiness(), 'ready')

  // The OTHER direction: the official mutate ITSELF is refused. That IS a refusal
  // and must keep rejecting, with the mirror left authoritative.
  state.mutateFailure = { code: 'settings/rejected', message: 'refused' }
  await assert.rejects(
    async () => { await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: 'light' }) },
    /settings\.mutate\(tui-app\) failed: refused/u,
  )
  assert.equal(port.configReadiness(), 'ready', 'a refused mutate leaves the mirror current')
  assert.equal(port.tuiSettings!.get().theme, 'dark', 'and its authoritative value intact')
  state.mutateFailure = undefined

  // The official write LANDS; only the authoritative refresh that follows it fails.
  state.describeFailure = { code: 'gateway/unavailable', message: 'offline again' }
  await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: 'light' })
  assert.notEqual(port.configReadiness(), 'ready', 'the committed write makes the last snapshot non-current')
  assert.ok(port.lastRefreshFailure() !== undefined, 'the failed refresh is recorded, never swallowed')
  assert.notEqual(port.tuiSettings!.get().theme, 'light', 'the mirror never patches the committed value optimistically')

  // An EXTERNAL writer moved the Host to the value this client is about to request
  // WITHOUT delivering an invalidation: the diff still emits its op (its base is the
  // mirror's previous value), the write is refused, and the forced authoritative re-read
  // then shows that the authority already carries the requested value. That proves the
  // VALUE is in place, never that THIS request was accepted — so a caller can only report
  // an unknown outcome, and must not contradict the authority with a refusal either.
  state.describeFailure = undefined
  await port.describe()
  assert.equal(port.configReadiness(), 'ready')
  const entry = state.namespaces.get(TUI_NS)!
  const external = entry.value.theme === 'dark' ? 'light' : 'dark'
  entry.value.theme = external
  entry.revision += 1
  state.mutateFailure = { code: 'settings/conflict', message: 'the revision moved' }
  await assert.rejects(
    async () => { await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: external }) },
    /settings\.mutate\(tui-app\) failed/u,
  )
  assert.equal(port.configReadiness(), 'ready', 'the forced re-read committed a current snapshot')
  assert.equal(port.tuiSettings!.get().theme, external, 'which already carries the requested value')
  state.mutateFailure = undefined

  // NEGATIVE CONTROL: a direct `mutate` consumer keeps the FAILURE. Its caller
  // re-reads the mirror and would otherwise present a last-known value as the
  // committed one (the subagent model-selection toggle does exactly that).
  const subagent = createBackend(current => {
    current.namespaces.set(SUBAGENT_NS, {
      ns: SUBAGENT_NS,
      value: { enabled: false, allowedModels: [] },
      revision: 1,
    })
  })
  await subagent.port.describe()
  subagent.state.describeFailure = { code: 'gateway/unavailable', message: 'offline again' }
  await assert.rejects(
    async () => {
      await subagent.port.subagentModelSelection.set({
        enabled: true,
        allowedModels: [{ provider: 'smoke', model: 'smoke-model' }],
      })
    },
    /settings\.describe failed/u,
    'the rereading consumer must not treat a stale snapshot as a committed write',
  )
})

test('an empty replace diff is a no-op only once the mirror is current', async () => {
  // A diff computed from a STALE mirror can be empty while the Host's
  // authoritative value differs: returning before the authority fence would
  // report success for a document the UI computed from superseded values.
  const { port, state, generation } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
  })
  await port.describe()
  const mutations = state.mutateCalls.length
  // Current + unchanged: a real no-op, nothing dispatched.
  await port.tuiSettings!.replace(port.tuiSettings!.get())
  assert.equal(state.mutateCalls.length, mutations, 'a current empty diff dispatches nothing')

  // Stale + unchanged + the refresh fails: the write must NOT resolve. The
  // failure is armed BEFORE the generation change so the invalidation-triggered
  // rerun fails too (no racy successful commit).
  state.describeFailure = { code: 'gateway/unavailable', message: 'offline' }
  generation.set({ id: 'gen-2' })
  assert.equal(port.configReadiness(), 'stale')
  await assert.rejects(async () => { await port.tuiSettings!.replace(port.tuiSettings!.get()) },
    /settings\.describe failed/u)
  assert.equal(state.mutateCalls.length, mutations, 'no mutate is dispatched')

  // Stale + unchanged + the refresh succeeds: the mirror becomes current
  // again and the authoritative value is what consumers now read.
  state.describeFailure = undefined
  state.namespaces.get(TUI_NS)!.value.theme = 'light'
  await port.tuiSettings!.replace(port.tuiSettings!.get())
  assert.equal(port.configReadiness(), 'ready')
  assert.equal(port.tuiSettings!.get().theme, 'light', 'the refreshed authority is what the UI reads')
  assert.equal(state.mutateCalls.length, mutations, 'an unchanged document still dispatches no mutate')
})

test('credential WRITES keep a dispatched Host settlement real across a Connection generation replacement (M3-6 PR2 AC11)', async () => {
  // A credential set/unset is a WRITE: once dispatched, the Host result is
  // the settlement authority. A reconnect mid-settlement must NOT reclassify
  // a proven success (or a proven Host refusal) as a transport supersession.
  const writes = [
    (port: ReturnType<typeof createBackend>['port']): Promise<void> => port.credentials.setReference('ACME_KEY', 'secret'),
    (port: ReturnType<typeof createBackend>['port']): Promise<void> => port.credentials.unsetReference('ACME_KEY'),
  ]
  for (const call of writes) {
    // Proven SUCCESS across the replacement: the write resolves.
    const ok = createBackend()
    ok.state.credentialGate = () => { ok.generation.set({ id: 'gen-2' }) }
    await call(ok.port)
    // Proven Host REFUSAL across the replacement keeps the Host's own error.
    const refused = createBackend()
    refused.state.credentialFailure = { code: 'gateway/forbidden', message: 'the host refused the key' }
    refused.state.credentialGate = () => { refused.generation.set({ id: 'gen-2' }) }
    await assert.rejects(() => call(refused.port), /failed: the host refused the key/u,
      'a dispatched Host refusal is preserved, never masked as a supersession')
  }
})

test('credential writes fail closed BEFORE dispatch when the Connection has no generation', async () => {
  const writes = [
    (port: ReturnType<typeof createBackend>['port']): Promise<void> => port.credentials.setReference('ACME_KEY', 'secret'),
    (port: ReturnType<typeof createBackend>['port']): Promise<void> => port.credentials.unsetReference('ACME_KEY'),
  ]
  for (const call of writes) {
    const { port, state, generation } = createBackend()
    generation.set(undefined)
    let dispatched = 0
    state.credentialGate = () => { dispatched += 1 }
    await assert.rejects(() => call(port), (error: unknown) => {
      assert.equal((error as Error).name, 'SupersededReadError')
      return true
    })
    assert.equal(dispatched, 0, 'no current generation means the write provably never dispatches')
  }
})

test('credential READS still supersede a describe from a replaced Connection generation', async () => {
  // A describe is a READ: a value from a replaced Host must never be shown as
  // the current configuration (the /logout picker would render a stale row).
  const { port, state, generation } = createBackend()
  state.credentialGate = async () => { generation.set({ id: 'gen-2' }) }
  await assert.rejects(() => port.credentials.describeReference('ACME_KEY'), (error: unknown) => {
    assert.equal((error as Error).name, 'SupersededReadError')
    return true
  })
  // A describe FAILURE from a replaced connection is superseded too.
  const failing = createBackend()
  failing.state.credentialFailure = { code: 'gateway/unavailable', message: 'the old host is gone' }
  failing.state.credentialGate = () => { failing.generation.set({ id: 'gen-2' }) }
  await assert.rejects(() => failing.port.credentials.describeReference('ACME_KEY'), (error: unknown) => {
    assert.equal((error as Error).name, 'SupersededReadError')
    return true
  })

  // Same-generation operations still settle normally.
  const same = createBackend()
  assert.equal((await same.port.credentials.describeReference('ACME_KEY')).configured, false)
  await same.port.credentials.setReference('ACME_KEY', 'secret')
  assert.equal((await same.port.credentials.describeReference('ACME_KEY')).configured, true)
})

// ── the profile-wide visual tools switch ──────────────────────────────────

test('visualTools mirrors the Host section and writes the exact enabled path through the generated remote', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('pi-tui-visual-tools', {
      ns: 'pi-tui-visual-tools',
      value: { enabled: true },
      revision: 4,
    })
  })
  assert.equal(port.visualTools.read(), undefined, 'a never-described mirror has no authority to report')
  await port.describe()
  assert.deepEqual(port.visualTools.read(), { enabled: true, revision: 4, userOverridden: false, applied: undefined })

  await port.visualTools.setEnabled(false, 4)
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0]!.ns, 'pi-tui-visual-tools')
  assert.deepEqual(state.mutateCalls[0]!.ops, [{ op: 'set', path: ['enabled'], value: false }])
  assert.equal(state.mutateCalls[0]!.revision, 4, 'the write carries the revision the UI decision was read at')
  assert.equal(port.visualTools.read()?.enabled, false, 'the post-settlement mirror refresh is the new authority')
  assert.equal(port.visualTools.read()?.applied, undefined, 'the wire exposes no registry fact, so none is claimed')
})

test('visualTools reports a namespace the Host does not expose instead of fabricating a value', async () => {
  const { port } = createBackend()
  await port.describe()
  assert.equal(port.visualTools.read(), undefined)
  await assert.rejects(port.visualTools.setEnabled(true, 1), /not available in this deployment/u)
})

test('a stale visualTools read stays last-known and the write is refused by the currentness fence', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('pi-tui-visual-tools', {
      ns: 'pi-tui-visual-tools',
      value: { enabled: true },
      revision: 2,
    })
  })
  await port.describe()
  state.describeFailure = { code: 'gateway/disconnected', message: 'connection lost' }
  await assert.rejects(port.describe())
  assert.deepEqual(port.visualTools.read(), { enabled: true, revision: 2, userOverridden: false, applied: undefined },
    'the last-known value remains READABLE but configReadiness reports it non-current')
  assert.equal(port.configReadiness(), 'stale')
  const callsBefore = state.mutateCalls.length
  await assert.rejects(port.visualTools.setEnabled(false, 2), /settings\.describe failed: connection lost/u)
  assert.equal(state.mutateCalls.length, callsBefore, 'a stale mirror never dispatches the switch')
})


test('a visualTools confirm submits the revision the decision was read at, never the refreshed one', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('pi-tui-visual-tools', {
      ns: 'pi-tui-visual-tools',
      value: { enabled: true },
      revision: 5,
    })
  })
  await port.describe()
  const decision = port.visualTools.read()
  assert.equal(decision?.revision, 5)

  // An external writer commits Off between the UI read and the Confirm.
  const entry = state.namespaces.get('pi-tui-visual-tools')!
  entry.value.enabled = false
  entry.revision = 6

  await assert.rejects(port.visualTools.setEnabled(false, decision.revision), /revision 5 != 6/u,
    'the stale decision is refused by the official revision fence')
  assert.deepEqual(state.mutateCalls.at(-1)?.revision, 5,
    'the ORIGINAL decision revision was submitted, not the refreshed mirror revision')
  assert.equal(port.visualTools.read()?.enabled, false, 'the external value remains authoritative')
})

// ── M5-W PR-C: the profile-owned Web startup preference ────────────────────

test('webStartupPreference mirrors the Host section and writes the exact autoStart path', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('pi-tui-web-preferences', {
      ns: 'pi-tui-web-preferences',
      value: { autoStart: false },
      revision: 7,
    })
  })
  assert.equal(port.webStartupPreference.read(), undefined, 'a never-described mirror has no authority to report')
  await port.describe()
  assert.deepEqual(port.webStartupPreference.read(), { autoStart: false, revision: 7, userOverridden: false })

  await port.webStartupPreference.setAutoStart(true, 7)
  assert.equal(state.mutateCalls.length, 1)
  assert.equal(state.mutateCalls[0]!.ns, 'pi-tui-web-preferences')
  assert.deepEqual(state.mutateCalls[0]!.ops, [{ op: 'set', path: ['autoStart'], value: true }])
  assert.equal(state.mutateCalls[0]!.revision, 7, 'the write carries the revision the decision was read at')
  assert.equal(port.webStartupPreference.read()?.autoStart, true,
    'the post-settlement mirror refresh is the new authority')
})

test('webStartupPreference marks a USER-declared value and reports an absent section', async () => {
  const { port } = createBackend(current => {
    current.namespaces.set('pi-tui-web-preferences', {
      ns: 'pi-tui-web-preferences',
      value: { autoStart: true },
      user: { autoStart: true },
      revision: 3,
    })
  })
  await port.describe()
  assert.deepEqual(port.webStartupPreference.read(), { autoStart: true, revision: 3, userOverridden: true })

  const absent = createBackend()
  await absent.port.describe()
  assert.equal(absent.port.webStartupPreference.read(), undefined)
  await assert.rejects(absent.port.webStartupPreference.setAutoStart(true, 1), /not available in this deployment/u)
})

test('a stale webStartupPreference read stays last-known and the write is refused', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set('pi-tui-web-preferences', {
      ns: 'pi-tui-web-preferences',
      value: { autoStart: false },
      revision: 2,
    })
  })
  await port.describe()
  state.describeFailure = { code: 'gateway/disconnected', message: 'connection lost' }
  await assert.rejects(port.describe())
  assert.deepEqual(port.webStartupPreference.read(), { autoStart: false, revision: 2, userOverridden: false },
    'the last-known value remains READABLE but non-current')
  assert.equal(port.configReadiness(), 'stale')
  const callsBefore = state.mutateCalls.length
  await assert.rejects(port.webStartupPreference.setAutoStart(true, 2), /settings\.describe failed: connection lost/u)
  assert.equal(state.mutateCalls.length, callsBefore, 'a stale mirror never dispatches the preference')
})

function seedWebNamespaces(state: FakeState, options: { readonly omit?: 'web' | 'api' } = {}): void {
  if (options.omit !== 'web') {
    state.namespaces.set(WEB_NS, { ns: WEB_NS, value: { ...WEB_DEFAULTS }, revision: 4 })
  }
  if (options.omit !== 'api') {
    state.namespaces.set(WEB_API_NS, { ns: WEB_API_NS, value: { ...WEB_API_DEFAULTS }, revision: 8 })
  }
}

test('the Remote Web adapter reads both Host sections and writes each exact field through the mirror', async () => {
  const { port, state } = createBackend(current => {
    seedWebNamespaces(current)
    current.credentialStore.set('DEEPSEEK_API_KEY', { configured: true, source: 'file' })
  })
  assert.equal(port.web.available(), false, 'an undescribed mirror has not observed the Host sections')
  await port.describe()
  assert.equal(port.web.available(), true)
  assert.deepEqual(await port.web.read(), {
    searchProvider: 'deepseek-official',
    fetchProvider: 'http',
    api: { searchBilling: 'auto', fetchBilling: 'auto', count: 10, sendOriginalQuestion: true },
    advanced: {},
    credential: { configured: true, source: 'file' },
  })

  await port.web.setSearchProvider('deepseek-search-api')
  await port.web.setFetchProvider('deepseek-fetch-api')
  await port.web.setSearchApiCount(20)
  await port.web.setSendOriginalQuestion(false)
  await port.web.setSearchBilling('account')
  await port.web.setFetchBilling('api-key')
  assert.deepEqual(state.mutateCalls.map(call => ({ ns: call.ns, ops: call.ops })), [
    { ns: WEB_NS, ops: [{ op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' }] },
    { ns: WEB_NS, ops: [{ op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' }] },
    { ns: WEB_API_NS, ops: [{ op: 'set', path: ['count'], value: 20 }] },
    { ns: WEB_API_NS, ops: [{ op: 'set', path: ['sendOriginalQuestion'], value: false }] },
    { ns: WEB_API_NS, ops: [{ op: 'set', path: ['searchBilling'], value: 'account' }] },
    { ns: WEB_API_NS, ops: [{ op: 'set', path: ['fetchBilling'], value: 'api-key' }] },
  ])
  assert.deepEqual(await port.web.read(), {
    searchProvider: 'deepseek-search-api',
    fetchProvider: 'deepseek-fetch-api',
    api: { searchBilling: 'account', fetchBilling: 'api-key', count: 20, sendOriginalQuestion: false },
    advanced: {},
    credential: { configured: true, source: 'file' },
  }, 'the values come from the authoritative post-write describe')
})

test('the Remote Web adapter projects the YAML-only overrides and legacy presence as detached facts', async () => {
  const { port } = createBackend(current => {
    seedWebNamespaces(current)
    current.namespaces.get(WEB_API_NS)!.value = {
      ...WEB_API_DEFAULTS,
      searchBaseURL: 'https://search-gateway.example.test/v1/tools',
      searchApiKeyEnv: 'SEARCH_API_KEY_ENV',
      // Legacy single-endpoint keys are NOT rc.2 schema fields; when a
      // descriptor happens to project them only their presence is reported.
      baseURL: 'https://old.example.test/v1/tools',
      apiKey: 'sk-legacy-value-never-echo',
    }
  })
  await port.describe()
  const read = await port.web.read()
  assert.deepEqual(read?.advanced, {
    searchBaseURL: 'https://search-gateway.example.test/v1/tools',
    searchApiKeyEnv: 'SEARCH_API_KEY_ENV',
    legacyOverrideDetected: true,
  }, 'only non-empty string override fields are copied; legacy keys contribute presence only')
  assert.equal(read?.api.searchBilling, 'auto', 'the legacy keys never become effective billing/endpoint values')
  assert.equal(JSON.stringify(read).includes('sk-legacy-value-never-echo'), false,
    'the legacy apiKey value is never echoed through the port')
  assert.equal(JSON.stringify(read).includes('https://old.example.test/v1/tools'), false,
    'the legacy baseURL value is never echoed through the port')
})

test('a displayed Remote URL override is MASKED: userinfo and query/fragment never reach the port', async () => {
  const { port } = createBackend(current => {
    seedWebNamespaces(current)
    current.namespaces.get(WEB_API_NS)!.value = {
      ...WEB_API_DEFAULTS,
      fetchBaseURL: 'https://user:secret@fetch.example.test/v1?token=x#frag',
    }
  })
  await port.describe()
  const read = await port.web.read()
  assert.equal(read?.advanced.fetchBaseURL, 'https://***@fetch.example.test/v1',
    'the userinfo is replaced and the query/fragment dropped')
  const serialized = JSON.stringify(read)
  assert.doesNotMatch(serialized, /secret|user:|token=/u,
    `no credential material survives the projection:\n${serialized}`)
})

test('a foreign Remote billing value is UNAVAILABLE, never a silent auto', async () => {
  const { port } = createBackend(current => {
    seedWebNamespaces(current)
    current.namespaces.get(WEB_API_NS)!.value.fetchBilling = 'subscription'
  })
  await port.describe()
  assert.equal(await port.web.read(), undefined, 'an outside-the-enum value cannot be read as a billing fact')
})

test('the Remote Web adapter preserves a valid Host count outside the UI presets', async () => {
  const { port, state } = createBackend(current => {
    seedWebNamespaces(current)
    current.namespaces.get(WEB_API_NS)!.value.count = 7
  })
  await port.describe()
  assert.equal((await port.web.read())?.api.count, 7)
  assert.deepEqual(state.mutateCalls, [], 'reading the stored value never normalizes it to a preset')
})

test('missing Web settings sections stay unavailable and no defaults or writes are invented', async () => {
  for (const missing of ['web', 'api'] as const) {
    const { port, state } = createBackend(current => { seedWebNamespaces(current, { omit: missing }) })
    assert.equal(port.web.available(), false)
    await port.describe()
    assert.equal(await port.web.read(), undefined)
    const callsBefore = state.mutateCalls.length
    await assert.rejects(port.web.setSearchApiCount(10), /sections are unavailable/u)
    assert.equal(state.mutateCalls.length, callsBefore)
  }
})

test('a stale provider intent is refused after the Remote mirror already refreshed to a custom route', async () => {
  const { port, state, emit } = createBackend(current => { seedWebNamespaces(current) })
  await port.describe()
  const web = state.namespaces.get(WEB_NS)!
  web.value.searchProvider = 'custom-search'
  web.revision += 1
  emit('settings/document-updated')
  assert.equal((await port.web.read())?.searchProvider, 'custom-search',
    'the Host document update has already committed into the current mirror')
  const callsBefore = state.mutateCalls.length
  await assert.rejects(port.web.setSearchProvider('deepseek-search-api'), /custom route/u)
  assert.equal(state.mutateCalls.length, callsBefore, 'the older provider intent never dispatches with the refreshed revision')
  assert.equal(state.namespaces.get(WEB_NS)?.value.searchProvider, 'custom-search')
})

test('invalid Remote Web candidates match Direct validation and never read or mutate the Host', async () => {
  const remote = createBackend()
  const direct = new DirectWebProviderConfig({ get: (_name: string) => undefined } satisfies HostContextLike)
  for (const count of [0, 51, 2.5, Number.NaN]) {
    let remoteMessage = ''
    let directMessage = ''
    await assert.rejects(remote.port.web.setSearchApiCount(count), error => {
      remoteMessage = (error as Error).message
      return true
    })
    await assert.rejects(direct.setSearchApiCount(count), error => {
      directMessage = (error as Error).message
      return true
    })
    assert.equal(remoteMessage, directMessage)
  }
  // The billing mode is the official closed enum on BOTH backends, with the
  // same refusal vocabulary and zero Host contact. The invalid values are cast
  // through the enum type on purpose: the RUNTIME guard is the subject.
  for (const mode of ['subscription', 'AUTO', 'api_key', ''] as readonly string[]) {
    let remoteSearchMessage = ''
    let remoteFetchMessage = ''
    let directSearchMessage = ''
    let directFetchMessage = ''
    await assert.rejects(remote.port.web.setSearchBilling(mode as 'auto' | 'account' | 'api-key'), error => {
      remoteSearchMessage = (error as Error).message
      return true
    })
    await assert.rejects(remote.port.web.setFetchBilling(mode as 'auto' | 'account' | 'api-key'), error => {
      remoteFetchMessage = (error as Error).message
      return true
    })
    await assert.rejects(direct.setSearchBilling(mode as 'auto' | 'account' | 'api-key'), error => {
      directSearchMessage = (error as Error).message
      return true
    })
    await assert.rejects(direct.setFetchBilling(mode as 'auto' | 'account' | 'api-key'), error => {
      directFetchMessage = (error as Error).message
      return true
    })
    assert.equal(remoteSearchMessage, directSearchMessage)
    assert.equal(remoteFetchMessage, directFetchMessage)
  }
  assert.equal(remote.state.describeCalls, 0)
  assert.deepEqual(remote.state.mutateCalls, [])
})

test('a custom Host provider id reads verbatim while a credential RPC failure stays an error', async () => {
  const { port, state } = createBackend(current => {
    seedWebNamespaces(current)
    current.namespaces.get(WEB_NS)!.value.searchProvider = 'custom-search'
  })
  await port.describe()
  assert.equal((await port.web.read())?.searchProvider, 'custom-search')
  state.credentialFailure = { code: 'gateway/service-unavailable', message: 'credential authority unavailable' }
  await assert.rejects(port.web.read(), /credentials\.describe\(DEEPSEEK_API_KEY\) failed: credential authority unavailable/u)
  assert.equal(state.mutateCalls.length, 0)
})

test('a settings invalidation during credential describe discards the mixed-time Remote Web read', async () => {
  const { port, state, emit } = createBackend(current => {
    seedWebNamespaces(current)
    current.credentialStore.set('DEEPSEEK_API_KEY', { configured: true, source: 'file' })
  })
  await port.describe()
  let raced = false
  state.credentialGate = () => {
    if (raced) return
    raced = true
    state.credentialGate = undefined
    const web = state.namespaces.get(WEB_NS)!
    web.value.searchProvider = 'custom-after-invalidation'
    web.revision += 1
    emit('settings/document-updated')
  }
  const result = await port.web.read()
  assert.equal(result?.searchProvider, 'custom-after-invalidation')
  assert.deepEqual(result?.credential, { configured: true, source: 'file' })
  assert.equal(raced, true)
  assert.equal(port.configReadiness(), 'ready')
})

test('a Host revision change before Remote Web dispatch rejects the stale mutation and preserves the winner', async () => {
  const { port, state } = createBackend(current => { seedWebNamespaces(current) })
  await port.describe()
  state.mutateGate = async () => {
    const web = state.namespaces.get(WEB_NS)!
    web.value.searchProvider = 'custom-concurrent-writer'
    web.revision += 1
  }
  await assert.rejects(port.web.setSearchProvider('deepseek-search-api'), /revision 4 != 5/u)
  assert.equal(state.namespaces.get(WEB_NS)?.value.searchProvider, 'custom-concurrent-writer')
  assert.equal(port.configReadiness(), 'ready', 'the failure path refreshed the authoritative winner')
})
