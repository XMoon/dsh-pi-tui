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
 * (credential records, authorization, session approval override), permission
 * catalog/apply, preset default, subagent model selection, footer USER-layer
 * trust parity, and raw settings field round-trips.
 * @module @xmoon76/dsh-pi-tui/remote-config-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteConfigPort } from '../src/runtime/remote/config-remote.ts'
import type { ProviderCatalogEntry } from '../src/provider-catalog.ts'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'

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
  readonly executeCalls: { sessionId: string; line: string; attachments: readonly unknown[]; signal?: AbortSignal }[]
  executeResult: { ok: true; value: unknown } | { ok: false; error: unknown }
  readonly order: string[]
}

type EventListener = (...args: unknown[]) => void

const TUI_NS = 'tui-app'
const SUBAGENT_NS = 'subagent-model-selection-settings'

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
  terminalProgress: 'on',
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

function createBackend(seed?: (state: FakeState) => void) {
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
    executeCalls: [],
    executeResult: { ok: true, value: { commandId: 'c' } },
    order: [],
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
    commands: {
      execute: async (sessionId: string, line: string, attachments: readonly unknown[], signal?: AbortSignal) => {
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

test('writes are serialized against other writes on the same mirror', async () => {
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { theme: 'dark' }, revision: 1 })
  })
  await port.describe()
  let release!: () => void
  state.mutateGate = () => new Promise<void>(resolve => { release = resolve })

  const settings = port.tuiSettings!
  const first = settings.replace({ ...settings.get(), theme: 'light' })
  const second = settings.replace({ ...settings.get(), theme: 'solar' })
  await tick()
  assert.equal(state.mutateCalls.length, 1, 'the second write waits for the first to settle')

  release()
  await Promise.all([first, second])
  assert.equal(state.mutateCalls.length, 2)
  assert.deepEqual(state.mutateCalls.map(call => call.ns), [TUI_NS, TUI_NS])
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

test('credential record enumeration/deletion reject as unavailable (never an empty list)', async () => {
  const { port } = createBackend()
  await assert.rejects(
    () => port.credentials.listRecords(),
    /cannot enumerate stored credential records/,
  )
  await assert.rejects(
    () => port.credentials.deleteRecord('scope/id'),
    /cannot delete stored credential record "scope\/id"/,
  )
})

/* ------------------------------------------------------------------------- *
 * Explicitly unsupported classes.
 * ------------------------------------------------------------------------- */

test('authorization is unavailable on the wire and never opens a private RPC', async () => {
  const { port } = createBackend()
  assert.equal(port.authorization.available(), false)
  assert.deepEqual(port.authorization.listTargets(), [])
  assert.deepEqual(await port.authorization.begin({ key: 'openai' }), { kind: 'unavailable' })
  const unsubscribe = port.authorization.onEvent(() => {})
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
  await assert.rejects(() => port.authorization.respond('a', 'p', 'x'), /authorization is unavailable/)
  await assert.rejects(() => port.authorization.cancel('a'), /authorization is unavailable/)
})

test('approvalOverrideOf is always undefined (unavailable, never an ask guess)', () => {
  const { port } = createBackend()
  assert.equal(port.permissions.approvalOverrideOf('session-a'), undefined)
  assert.equal(port.permissions.approvalOverrideOf('session-b'), undefined)
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

  assert.deepEqual(
    await port.permissions.applyPermissionPreset('session-a', 'danger-full-access'),
    { kind: 'applied' },
  )
  assert.equal(state.executeCalls.length, 1)
  assert.deepEqual(state.executeCalls[0], {
    sessionId: 'session-a',
    line: '/permission danger-full-access',
    attachments: [],
    signal: undefined,
  })

  // An unknown preset never reaches the official command line.
  assert.deepEqual(
    await port.permissions.applyPermissionPreset('session-a', 'bogus'),
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

  await port.providers.writeProfile('acme', { apiKeyEnv: 'ACME_API_KEY' })
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1].ops, [
    { op: 'set', path: ['providers', 'acme'], value: { apiKeyEnv: 'ACME_API_KEY' } },
  ])
  await assert.rejects(() => port.providers.writeProfile('deepseek-official', {}), /invalid provider route/)
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

test('terminalProgress keeps Direct/Remote parity: missing resolves on, explicit off reads back, one path-scoped op', async () => {
  // A section that omits the field (an older saved document) still resolves to
  // the schema default `on` through the adapter's own defaults.
  const { terminalProgress: _omitted, ...withoutProgress } = TUI_DEFAULTS
  const missing = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...withoutProgress }, revision: 1 })
  })
  await missing.port.describe()
  assert.equal(missing.port.tuiSettings?.get().terminalProgress, 'on',
    'a missing remote terminalProgress resolves to the on default')

  // An explicit off is read back verbatim.
  const explicit = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS, terminalProgress: 'off' }, revision: 1 })
  })
  await explicit.port.describe()
  assert.equal(explicit.port.tuiSettings?.get().terminalProgress, 'off')

  // A replace writes exactly one path-scoped op and leaves every other field
  // untouched.
  const { port, state } = createBackend(current => {
    current.namespaces.set(TUI_NS, { ns: TUI_NS, value: { ...TUI_DEFAULTS }, revision: 1 })
  })
  await port.describe()
  const settings = port.tuiSettings
  assert.ok(settings !== undefined)
  assert.equal(settings.get().terminalProgress, 'on')
  await settings.replace({ ...settings.get(), terminalProgress: 'off' })
  assert.deepEqual(state.mutateCalls[state.mutateCalls.length - 1].ops,
    [{ op: 'set', path: ['terminalProgress'], value: 'off' }],
    'only the changed field crosses')
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

  // The write path names the actual reason rather than claiming a stale value.
  const facade = {
    get: () => ({ ...TUI_DEFAULTS }),
    replace: async () => {},
  }
  state.describeFailure = undefined
  await port.describe()
  assert.equal(port.configReadiness(), 'ready')
  state.describeFailure = { code: 'gateway/unavailable', message: 'offline again' }
  await assert.rejects(async () => { await port.tuiSettings!.replace({ ...port.tuiSettings!.get(), theme: 'light' }) },
    /settings\.describe failed/u)
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
