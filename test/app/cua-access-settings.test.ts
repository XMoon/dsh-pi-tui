/**
 * The per-open Computer Use settings controller (PR-5 / MAC-09 v2).
 *
 * The Host/provider stays the only authority; these tests prove the Client
 * controller's own contract: a disabled bundle is never queried, reads settle
 * independently, actions are receipts followed by a fresh read (never an
 * optimistic Allowed), writes are serialized with exact ids, and a closed page
 * discards late/superseded results.
 * @module @xmoon76/dsh-pi-tui/cua-access-settings.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CuaAccessSettingsController, CUA_BUNDLE_NAME } from '../../src/app/command/cua-access-settings.ts'
import type { CuaAccessPort, CuaApplicationState, CuaPtcConfiguration, CuaSystemStatus } from '../../src/runtime/cua-access-port.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import type { PresetDefaultConfig } from '../../src/runtime/config-port.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'

const quietDiag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

const STATUS: CuaSystemStatus = {
  platform: 'darwin',
  accessibility: false,
  screenRecording: false,
  helper: { pid: 7, name: 'DSH Computer Use' },
  parent: { pid: 1, path: '/sbin/launchd' },
}
const APPLICATIONS: CuaApplicationState = {
  allowedApps: [{ id: 'app-1', name: 'TextEdit' }],
  blockedApps: [],
  persistentAvailable: true,
}
const PTC: CuaPtcConfiguration = { persistent: false, writable: true }

function cuaPort(overrides: Partial<CuaAccessPort> = {}): { port: CuaAccessPort; calls: string[] } {
  const calls: string[] = []
  const port: CuaAccessPort = {
        observation: { readSnapshot: () => 1, subscribe: () => () => {} },
    readSystemStatus: async () => { calls.push('system'); return STATUS },
    readApplications: async () => { calls.push('applications'); return APPLICATIONS },
    readApplicationIcons: async () => { calls.push('icons'); return { '/TextEdit': 'icon' } },
    readPtcConfiguration: async () => { calls.push('ptc'); return PTC },
    requestPermission: async (permission, locale) => { calls.push(`request:${permission}:${locale}`); return STATUS },
    openSettings: async (permission, locale) => { calls.push(`open:${permission}:${locale}`) },
    enablePersistentPtc: async () => { calls.push('persist') },
    revoke: async (id) => { calls.push(`revoke:${id}`) },
    retryApproval: async (id) => { calls.push(`retry:${id}`) },
    ...overrides,
  }
  return { port, calls }
}

function pluginManager(bundle?: { enabled: boolean; availability?: 'installation' | 'profile' | 'missing'; version?: string; error?: { code: string } }): PluginManagerPort {
  return {
    snapshot: async () => ({
      bundles: bundle === undefined
        ? []
        : [{
          name: CUA_BUNDLE_NAME,
          official: true,
          availability: bundle.availability ?? 'installation',
          enabled: bundle.enabled,
          installed: false,
          optional: true,
          removable: false,
          rows: [],
          overrides: [],
          ...(bundle.version === undefined ? {} : { version: bundle.version }),
          ...(bundle.error === undefined ? {} : { error: bundle.error }),
        }],
      plugins: [],
      registries: {} as never,
      exemptions: [],
      exemptionWarnings: [],
    }),
  } as unknown as PluginManagerPort
}

function presetDefault(initial = 'ptc'): { config: PresetDefaultConfig; calls: string[] } {
  const calls: string[] = []
  let value: string | undefined = initial
  return {
    calls,
    config: {
      available: () => true,
      get: () => value,
      set: async (id) => { calls.push(`set:${id}`); value = id },
    },
  }
}

function controller(options: {
  bundle?: Parameters<typeof pluginManager>[0]
  port?: CuaAccessPort
  preset?: PresetDefaultConfig
} = {}): { controller: CuaAccessSettingsController; calls: string[]; portCalls: string[] } {
  const fake = cuaPort()
  const port = options.port ?? fake.port
  const preset = options.preset ?? presetDefault().config
  const controller = new CuaAccessSettingsController({
    cuaAccess: port,
    pluginManager: pluginManager(options.bundle ?? { enabled: true, version: '0.2.2-rc.3' }),
    presetDefault: preset,
    locale: () => 'zh',
    diag: quietDiag,
  })
  return { controller, calls: [], portCalls: fake.calls }
}

test('a disabled bundle is never queried and reads as disabled, not denied', async () => {
  const { controller: page, portCalls } = controller({ bundle: { enabled: false } })
  await page.refresh()
  assert.equal(page.getSnapshot().bundle.phase, 'disabled')
  assert.equal(page.getSnapshot().system.phase, 'disabled')
  assert.equal(page.getSnapshot().applications.phase, 'disabled')
  assert.deepEqual(portCalls, [], 'no cuaAccess read may run while the bundle is disabled')
  await page.dispose()
})

test('enabled reads settle independently and an icon failure does not block permissions', async () => {
  const fake = cuaPort()
  const page = new CuaAccessSettingsController({
    cuaAccess: { ...fake.port, readApplicationIcons: async () => { throw new Error('icon decoder failed') } },
    pluginManager: pluginManager({ enabled: true, version: '0.2.2-rc.3' }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  await page.refresh()
  const snapshot = page.getSnapshot()
  assert.equal(snapshot.bundle.phase, 'ready')
  assert.equal(snapshot.system.phase, 'ready')
  assert.deepEqual(snapshot.system.value, STATUS)
  assert.equal(snapshot.applications.phase, 'ready')
  assert.equal(snapshot.ptc.phase, 'ready')
  assert.equal(snapshot.icons.phase, 'failed')
  assert.match(snapshot.icons.reason ?? '', /icon decoder failed/u)
  await page.dispose()
})

test('Request is an action receipt followed by a fresh read, never an optimistic Allowed', async () => {
  const { controller: page, portCalls } = controller({ bundle: { enabled: true } })
  await page.refresh()
  const readsBefore = portCalls.filter(call => call === 'system').length
  await page.requestPermission('accessibility')
  const snapshot = page.getSnapshot()
  assert.equal(snapshot.action?.kind, 'request')
  assert.equal(snapshot.action?.state, 'ok')
  assert.match(snapshot.action?.text ?? '', /does not grant/u)
  assert.ok(portCalls.includes('request:accessibility:zh'))
  assert.equal(portCalls.filter(call => call === 'system').length, readsBefore + 1,
    'the action must be followed by a fresh official systemStatus read')
  assert.equal(snapshot.system.phase, 'ready')
  assert.equal((snapshot.system.value as { accessibility: boolean }).accessibility, false,
    'the fresh read stays denied even though the request action succeeded')
  await page.dispose()
})

test('a superseded connection read becomes Unknown and never keeps a stale Allowed', async () => {
  const page = new CuaAccessSettingsController({
    cuaAccess: {
      ...cuaPort().port,
      readSystemStatus: async () => { throw new SupersededReadError('connection changed') },
    },
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  await page.refresh()
  assert.equal(page.getSnapshot().system.phase, 'unknown')
  assert.equal(page.getSnapshot().system.value, undefined)
  await page.dispose()
})

test('revoke and retry keep the exact painted id and admit ONE write at a time', async () => {
  const order: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fake = cuaPort({
    revoke: async (id) => { order.push(`revoke:${id}`); await gate; order.push('revoke:done') },
    retryApproval: async (id) => { order.push(`retry:${id}`) },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: fake.port,
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  const revoke = page.revoke('app-1')
  const duplicate = page.retryApproval('app-2')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(order, ['revoke:app-1'], 'the duplicate buffered action must not be queued')
  release?.()
  await Promise.all([revoke, duplicate])
  assert.deepEqual(order, ['revoke:app-1', 'revoke:done'], 'exactly one Host write is dispatched')
  await page.retryApproval('app-2')
  assert.deepEqual(order, ['revoke:app-1', 'revoke:done', 'retry:app-2'], 'a later explicit action is admitted')
  await page.dispose()
})

test('a generation rollover during an in-flight write keeps admission and publishes Unknown', async () => {
  let invalidate: (() => void) | undefined
  let basis = 1
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fake = cuaPort({
    observation: {
      readSnapshot: () => basis,
      subscribe: (listener) => { invalidate = listener; return () => {} },
    },
    revoke: async () => { await gate },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: fake.port,
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  const write = page.revoke('app-1')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(page.getSnapshot().busy, true)
  basis = 2
  invalidate?.()
  assert.equal(page.getSnapshot().busy, true, 'the in-flight write keeps the second action refused')
  assert.equal(page.getSnapshot().action, undefined, 'no premature success receipt')
  release?.()
  await write
  assert.equal(page.getSnapshot().action?.state, 'unknown')
  assert.match(page.getSnapshot().action?.text ?? '', /unconfirmed/iu)
  assert.equal(page.getSnapshot().busy, false)
  await page.dispose()
})

test('dispose discards a late read and drops every listener', async () => {
  let release: ((value: CuaSystemStatus) => void) | undefined
  const pending = new Promise<CuaSystemStatus>((resolve) => { release = resolve })
  const page = new CuaAccessSettingsController({
    cuaAccess: { ...cuaPort().port, readSystemStatus: async () => await pending },
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  let updates = 0
  page.subscribe(() => { updates += 1 })
  const refresh = page.refresh()
  await new Promise(resolve => setTimeout(resolve, 5))
  const dispose = page.dispose()
  release?.(STATUS)
  await Promise.all([refresh, dispose])
  assert.equal(page.getSnapshot().system.phase, 'loading')
  assert.equal(page.getSnapshot().system.value, undefined)
  const afterDispose = updates
  await page.refresh()
  assert.equal(updates, afterDispose, 'a disposed page must not notify or mutate')
})
