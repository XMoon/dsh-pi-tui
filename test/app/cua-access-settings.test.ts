/**
 * The per-open Computer Use settings controller (PR-5 / MAC-09 v2, SUX-08).
 *
 * The Host/provider stays the only authority; these tests prove the Client
 * controller's own contract: a disabled bundle is never queried, reads settle
 * independently, a published observation identity retires older captures, an
 * action is re-proved against the exact painted capture, writes are serialized
 * with exact ids, the Computer Use preset default is a GUARDED decision, and a
 * closed page discards late/superseded results.
 * @module @xmoon76/dsh-pi-tui/cua-access-settings.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CuaAccessSettingsController,
  CUA_BUNDLE_NAME,
  cuaActionAdmitted,
  type CuaAccessSettingsSnapshot,
  type CuaActionCapture,
} from '../../src/app/command/cua-access-settings.ts'
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
  blockedApps: [{ id: 'app-2', name: 'Example' }],
  persistentAvailable: true,
}
const PTC: CuaPtcConfiguration = { persistent: false, writable: true }

function capture(
  snapshot: CuaAccessSettingsSnapshot,
  kind: CuaActionCapture['kind'],
  extra: Partial<CuaActionCapture> = {},
): CuaActionCapture {
  return { epoch: snapshot.epoch, kind, ...extra }
}

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

function presetDefault(initial = 'default'): {
  config: PresetDefaultConfig
  calls: string[]
  replaceAuthority: () => void
  setOutcome: (outcome: 'accepted' | 'rejected' | 'conflict' | 'outcome-unconfirmed') => void
} {
  const calls: string[] = []
  let value: string | undefined = initial
  let generation: object = {}
  let guardedOutcome: 'accepted' | 'rejected' | 'conflict' | 'outcome-unconfirmed' = 'accepted'
  const config: PresetDefaultConfig = {
    available: () => true,
    get: () => value,
    set: async (id) => { calls.push(`set:${id}`) },
    readDecision: () => ({ generation, revision: 4, value }),
    setGuarded: async (id, decision) => {
      calls.push(`guarded:${id}:${decision.revision}`)
      if (guardedOutcome === 'accepted') value = id
      return guardedOutcome === 'accepted'
        ? { kind: 'accepted' }
        : guardedOutcome === 'conflict'
          ? { kind: 'conflict', reason: 'the Host settings section changed since it was read' }
          : guardedOutcome === 'rejected'
            ? { kind: 'rejected', reason: 'the Host settings authority changed; refresh before saving' }
            : { kind: 'outcome-unconfirmed', reason: 'the settings write could not be confirmed' }
    },
  }
  return {
    config,
    calls,
    replaceAuthority: () => { generation = {} },
    setOutcome: (outcome) => { guardedOutcome = outcome },
  }
}

function controller(options: {
  bundle?: Parameters<typeof pluginManager>[0]
  port?: CuaAccessPort
  preset?: PresetDefaultConfig
} = {}): { controller: CuaAccessSettingsController; portCalls: string[] } {
  const fake = cuaPort()
  const port = options.port ?? fake.port
  const controller = new CuaAccessSettingsController({
    cuaAccess: port,
    pluginManager: pluginManager(options.bundle ?? { enabled: true, version: '0.2.2-rc.5' }),
    presetDefault: options.preset ?? presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  return { controller, portCalls: fake.calls }
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

test('a failed system read never blocks the application/PTC facts, and no icon read runs', async () => {
  const fake = cuaPort({
    readSystemStatus: async () => { throw new Error('native status failed') },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: fake.port,
    pluginManager: pluginManager({ enabled: true, version: '0.2.2-rc.5' }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  await page.refresh()
  const snapshot = page.getSnapshot()
  assert.equal(snapshot.bundle.phase, 'ready')
  assert.equal(snapshot.system.phase, 'failed')
  assert.match(snapshot.system.reason ?? '', /native status failed/u)
  assert.equal(snapshot.applications.phase, 'ready')
  assert.equal(snapshot.applications.value?.allowedApps.length, 1)
  assert.equal(snapshot.ptc.phase, 'ready')
  assert.deepEqual(snapshot.ptc.value, PTC)
  assert.ok(!fake.calls.includes('icons'), 'the page has no icon consumer, so no icon IO runs')
  assert.ok(!('icons' in snapshot), 'the snapshot publishes no unused icon projection')
  await page.dispose()
})

test('Request is an action receipt followed by a fresh read, never an optimistic Allowed', async () => {
  const { controller: page, portCalls } = controller({ bundle: { enabled: true } })
  await page.refresh()
  const readsBefore = portCalls.filter(call => call === 'system').length
  const snapshot = page.getSnapshot()
  await page.requestPermission(capture(snapshot, 'request', { permission: 'accessibility' }))
  const after = page.getSnapshot()
  assert.equal(after.action?.kind, 'request')
  assert.equal(after.action?.state, 'ok')
  assert.match(after.action?.text ?? '', /does not grant/u)
  assert.ok(portCalls.includes('request:accessibility:zh'))
  assert.equal(portCalls.filter(call => call === 'system').length, readsBefore + 1,
    'the action must be followed by a fresh official systemStatus read')
  assert.equal(after.system.phase, 'ready')
  assert.equal((after.system.value as { accessibility: boolean }).accessibility, false,
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

test('a published observation identity moves on every refresh and retires old captures (same id included)', async () => {
  const { controller: page, portCalls } = controller({ bundle: { enabled: true } })
  await page.refresh()
  const first = page.getSnapshot()
  const stale = capture(first, 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' })
  assert.equal(cuaActionAdmitted(first, stale).ok, true)
  // A later read exposes the SAME application id on a NEW observation identity.
  await page.refresh()
  const fresh = page.getSnapshot()
  assert.notEqual(fresh.epoch, first.epoch, 'the observation identity must be published and move')
  assert.equal(fresh.applications.value?.allowedApps[0]?.id, 'app-1')
  const before = portCalls.filter(call => call.startsWith('revoke:')).length
  await page.revoke(stale)
  assert.equal(portCalls.filter(call => call.startsWith('revoke:')).length, before,
    'the stale capture must never authorize a write on the newer observation')
  assert.equal(page.getSnapshot().action?.state, 'failed')
  assert.match(page.getSnapshot().action?.text ?? '', /observation changed/iu)
  // A FRESH explicit capture on the current observation is admitted once.
  await page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.equal(portCalls.filter(call => call.startsWith('revoke:')).length, before + 1)
  assert.deepEqual(portCalls.filter(call => call.startsWith('revoke:')), ['revoke:app-1'])
  await page.dispose()
})

test('a capture whose exact application group/id no longer matches is refused with zero writes', async () => {
  const { controller: page, portCalls } = controller({ bundle: { enabled: true } })
  await page.refresh()
  const snapshot = page.getSnapshot()
  await page.revoke(capture(snapshot, 'revoke', { applicationId: 'app-2', applicationGroup: 'allowed' }))
  assert.deepEqual(portCalls.filter(call => call.startsWith('revoke:')), [],
    'an id that is not in the painted ALLOWED group can never be revoked')
  assert.equal(page.getSnapshot().action?.state, 'failed')
  assert.match(page.getSnapshot().action?.text ?? '', /no longer in the official list/iu)
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
  await page.refresh()
  const snapshot = page.getSnapshot()
  const revoke = page.revoke(capture(snapshot, 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  const duplicate = page.retryApproval(capture(snapshot, 'retry', { applicationId: 'app-2', applicationGroup: 'refused' }))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(order, ['revoke:app-1'], 'the duplicate buffered action must not be queued')
  assert.equal(page.getSnapshot().busy, true, 'an accepted action owns the page')
  release?.()
  await Promise.all([revoke, duplicate])
  assert.deepEqual(order, ['revoke:app-1', 'revoke:done'], 'exactly one Host write is dispatched')
  await page.retryApproval(capture(page.getSnapshot(), 'retry', { applicationId: 'app-2', applicationGroup: 'refused' }))
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
  await page.refresh()
  const write = page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
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

test('the guarded preset action writes ONCE with the painted decision and confirms from a same-authority readback', async () => {
  const preset = presetDefault('default')
  const { controller: page } = controller({ bundle: { enabled: true }, preset: preset.config })
  await page.refresh()
  const shot = page.getSnapshot()
  assert.equal(shot.preset.value, 'default')
  assert.notEqual(shot.preset.decision, undefined)
  await page.setPtcDefault(capture(shot, 'preset'))
  assert.deepEqual(preset.calls, ['guarded:ptc:4'], 'ONE guarded write at the painted revision')
  assert.equal(page.getSnapshot().preset.value, 'ptc')
  assert.equal(page.getSnapshot().action?.kind, 'preset')
  assert.equal(page.getSnapshot().action?.state, 'ok')
  assert.match(page.getSnapshot().action?.text ?? '', /confirmed by the current Host/u)
  await page.dispose()
})

test('a pre-dispatch refusal is Could not save with zero mutation; an unconfirmed one is unknown', async () => {
  const rejected = presetDefault('default')
  rejected.setOutcome('rejected')
  const first = controller({ bundle: { enabled: true }, preset: rejected.config }).controller
  await first.refresh()
  await first.setPtcDefault(capture(first.getSnapshot(), 'preset'))
  assert.equal(first.getSnapshot().action?.state, 'failed')
  assert.match(first.getSnapshot().action?.text ?? '', /^Could not save/u)
  assert.equal(first.getSnapshot().preset.value, 'default', 'nothing may be painted as saved')
  await first.dispose()

  const unconfirmed = presetDefault('default')
  unconfirmed.setOutcome('outcome-unconfirmed')
  const second = controller({ bundle: { enabled: true }, preset: unconfirmed.config }).controller
  await second.refresh()
  await second.setPtcDefault(capture(second.getSnapshot(), 'preset'))
  assert.equal(second.getSnapshot().action?.state, 'unknown')
  assert.match(second.getSnapshot().action?.text ?? '', /Could not confirm save/u)
  assert.match(second.getSnapshot().action?.text ?? '', /Refresh and check/u)
  await second.dispose()
})

test('an accepted preset write read back from a REPLACED authority is unknown, never ok', async () => {
  const preset = presetDefault('default')
  const { controller: page } = controller({ bundle: { enabled: true }, preset: preset.config })
  await page.refresh()
  const shot = page.getSnapshot()
  // The write is accepted and the value reads back ptc, but the settings
  // authority was replaced: the old decision may not claim that observation.
  preset.replaceAuthority()
  await page.setPtcDefault(capture(shot, 'preset'))
  assert.equal(page.getSnapshot().action?.state, 'unknown')
  assert.match(page.getSnapshot().action?.text ?? '', /may have been saved/u)
  await page.dispose()
})

test('a preset authority without the guarded seam refuses instead of falling back to the unguarded set', async () => {
  const calls: string[] = []
  let value: string | undefined = 'default'
  const unguarded: PresetDefaultConfig = {
    available: () => true,
    get: () => value,
    set: async (id) => { calls.push(`set:${id}`); value = id },
  }
  const { controller: page } = controller({ bundle: { enabled: true }, preset: unguarded })
  await page.refresh()
  await page.setPtcDefault(capture(page.getSnapshot(), 'preset'))
  assert.deepEqual(calls, [], 'the one-argument unguarded write may never stand in for the guarded decision')
  assert.equal(page.getSnapshot().action?.state, 'failed')
  assert.match(page.getSnapshot().action?.text ?? '', /cannot be proven/u)
  await page.dispose()
})

test('a refresh publishes a read-only `reading` state without claiming an accepted action', async () => {
  let release: ((value: CuaSystemStatus) => void) | undefined
  const pending = new Promise<CuaSystemStatus>((resolve) => { release = resolve })
  const page = new CuaAccessSettingsController({
    cuaAccess: { ...cuaPort().port, readSystemStatus: async () => await pending },
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  const refresh = page.refresh()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(page.getSnapshot().reading, true)
  assert.equal(page.getSnapshot().busy, false, 'a read-only observation is not an accepted action')
  release?.(STATUS)
  await refresh
  assert.equal(page.getSnapshot().reading, false)
  assert.equal(page.getSnapshot().system.phase, 'ready')
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
