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

test('an unproven effective default paints unknown and refuses the guarded write', async () => {
  const calls: string[] = []
  const page = manualController({
    port: cuaPort().port,
    preset: {
      available: () => true,
      get: () => 'ptc',
      set: async () => {},
      readDecision: () => ({ generation: {}, revision: 2, value: undefined }),
      setGuarded: async () => { calls.push('guarded'); return { kind: 'accepted' } },
    },
  })
  await page.refresh()
  assert.equal(page.getSnapshot().preset.value, undefined, 'a capture without a proven effective id is not current')
  assert.equal(page.getSnapshot().preset.decision, undefined)
  await page.setPtcDefault(capture(page.getSnapshot(), 'preset'))
  assert.equal(page.getSnapshot().action?.state, 'failed')
  assert.match(page.getSnapshot().action?.text ?? '', /cannot be proven/u)
  assert.deepEqual(calls, [], 'no guarded write is attempted from an unproven default')
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

function manualController(options: {
  port: CuaAccessPort
  preset?: PresetDefaultConfig
}): CuaAccessSettingsController {
  return new CuaAccessSettingsController({
    cuaAccess: options.port,
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: options.preset ?? presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
}

test('acceptance publishes Waiting synchronously; a buffered second action is refused', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const page = manualController({
    port: {
      ...cuaPort().port,
      revoke: async (id) => { calls.push(`revoke:${id}`); await held },
    },
  })
  await page.refresh()
  const first = page.getSnapshot()
  const write = page.revoke(capture(first, 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  // No await: the same input turn already sees the accepted ownership.
  assert.equal(page.getSnapshot().busy, true)
  assert.equal(cuaActionAdmitted(page.getSnapshot(), capture(first, 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' })).ok, true)
  await page.revoke(capture(first, 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.deepEqual(calls, ['revoke:app-1'], 'a second action in the same turn never dispatches')
  release()
  await write
  assert.equal(page.getSnapshot().busy, false)
  await page.dispose()
})

test('a synchronous subscriber that closes on Waiting prevents the dispatch', async () => {
  const calls: string[] = []
  const page = manualController({
    port: {
      ...cuaPort().port,
      revoke: async (id) => { calls.push(`revoke:${id}`) },
    },
  })
  await page.refresh()
  let closed = false
  page.subscribe(() => {
    if (!closed && page.getSnapshot().busy) {
      closed = true
      page.close()
    }
  })
  await page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.deepEqual(calls, [], 'a subscriber close during the synchronous acceptance notification dispatches nothing')
  await page.dispose()
})

test('an unconfirmed outcome requires a fresh observation before the next write', async () => {
  let basis = 1
  const calls: string[] = []
  const page = manualController({
    port: {
      ...cuaPort().port,
      observation: { readSnapshot: () => basis, subscribe: () => () => {} },
      revoke: async (id) => {
        calls.push(`revoke:${id}`)
        basis = 2 // the provider is silently replaced during the write
        throw new Error('old provider unavailable')
      },
    },
  })
  await page.refresh()
  await page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.equal(page.getSnapshot().action?.state, 'unknown')
  assert.equal(page.getSnapshot().recoveryRequired, true)
  // The write actionability itself is retired until a fresh observation.
  const blocked = cuaActionAdmitted(
    page.getSnapshot(),
    capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }),
  )
  assert.equal(blocked.ok, false)
  assert.match(blocked.ok ? '' : blocked.reason, /Refresh/u)
  // A fresh capture on the SAME published snapshot still cannot write blind.
  const before = calls.length
  await page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.equal(calls.length, before, 'unknown never retries without a fresh authoritative observation')
  assert.match(page.getSnapshot().action?.text ?? '', /Refresh/u)
  await page.refresh()
  assert.equal(page.getSnapshot().recoveryRequired, false)
  await page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.equal(calls.length, before + 1, 'one explicit Refresh re-authorizes exactly one write')
  await page.dispose()
})

test('an explicit unsupported Host denies every CUA write kind, while a failed system read stays usable', async () => {
  const actions: string[] = []
  const winPort: CuaAccessPort = {
    ...cuaPort().port,
    readSystemStatus: async () => ({
      platform: 'win32',
      sessionLocked: false,
      captureAvailable: false,
      elevated: false,
      helper: { pid: 7, name: 'DSH Computer Use' },
    }),
    requestPermission: async () => { actions.push('request'); return STATUS },
    openSettings: async () => { actions.push('open') },
    enablePersistentPtc: async () => { actions.push('persist') },
    revoke: async (id) => { actions.push(`revoke:${id}`) },
    retryApproval: async (id) => { actions.push(`retry:${id}`) },
  }
  const preset = presetDefault()
  const win = manualController({ port: winPort, preset: preset.config })
  await win.refresh()
  const base = win.getSnapshot()
  assert.equal(base.system.phase, 'ready')
  assert.equal((base.system.value as { platform: string }).platform, 'win32')
  const attempts: Array<{ kind: string; run: () => Promise<void> }> = [
    { kind: 'request', run: async () => { await win.requestPermission(capture(base, 'request', { permission: 'accessibility' })) } },
    { kind: 'open', run: async () => { await win.openSettings(capture(base, 'open', { permission: 'accessibility' })) } },
    { kind: 'preset', run: async () => { await win.setPtcDefault(capture(base, 'preset')) } },
    { kind: 'persistent-ptc', run: async () => { await win.enablePersistentPtc(capture(base, 'persistent-ptc')) } },
    { kind: 'revoke', run: async () => { await win.revoke(capture(base, 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' })) } },
    { kind: 'retry', run: async () => { await win.retryApproval(capture(base, 'retry', { applicationId: 'app-2', applicationGroup: 'refused' })) } },
  ]
  for (const attempt of attempts) {
    await attempt.run()
    assert.equal(win.getSnapshot().action?.state, 'failed', `${attempt.kind} must be denied`)
    assert.match(win.getSnapshot().action?.text ?? '', /supports macOS only/u, `${attempt.kind} carries the unsupported reason`)
  }
  assert.deepEqual(actions, [], 'no CUA write reaches any kind-specific port method on win32')
  assert.deepEqual(preset.calls, [], 'no guarded preset write runs on win32')
  // The independent application policy stays usable when only the system read fails.
  const failedSystem = manualController({
    port: {
      ...cuaPort().port,
      readSystemStatus: async () => { throw new Error('native status failed') },
    },
  })
  await failedSystem.refresh()
  assert.equal(failedSystem.getSnapshot().system.phase, 'failed')
  await failedSystem.revoke(capture(failedSystem.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.equal(failedSystem.getSnapshot().action?.state, 'ok')
  await win.dispose()
  await failedSystem.dispose()
})

test('a basis change during the synchronous queue-head notification dispatches nothing', async () => {
  let basis = 1
  const calls: string[] = []
  const page = manualController({
    port: {
      ...cuaPort().port,
      observation: { readSnapshot: () => basis, subscribe: () => () => {} },
      revoke: async (id) => { calls.push(`revoke:${id}`) },
    },
  })
  await page.refresh()
  let busyNotifications = 0
  page.subscribe(() => {
    if (!page.getSnapshot().busy) return
    busyNotifications += 1
    // The FIRST busy publication is acceptance; the queue head re-publishes it
    // right before dispatch. Flip the provider basis on that second one.
    if (busyNotifications === 2) basis = 2
  })
  await page.revoke(capture(page.getSnapshot(), 'revoke', { applicationId: 'app-1', applicationGroup: 'allowed' }))
  assert.deepEqual(calls, [], 'the queued dispatch re-proves the basis after the synchronous notification')
  assert.equal(page.getSnapshot().action?.state, 'unknown')
  assert.match(page.getSnapshot().action?.text ?? '', /nothing was sent/u)
  await page.dispose()
})

test('a roster read that crosses a silent replacement starts no downstream old-generation IO', async () => {
  let basis = 1
  let releaseRoster!: () => void
  const heldRoster = new Promise<void>((resolve) => { releaseRoster = resolve })
  let rosterCalls = 0
  const reads: string[] = []
  const port = cuaPort({
    observation: { readSnapshot: () => basis, subscribe: () => () => {} },
    readSystemStatus: async () => { reads.push('system'); return STATUS },
    readApplications: async () => { reads.push('applications'); return APPLICATIONS },
    readPtcConfiguration: async () => { reads.push('ptc'); return PTC },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: port.port,
    pluginManager: {
      snapshot: async () => {
        rosterCalls += 1
        if (rosterCalls === 1) await heldRoster
        return (pluginManager({ enabled: true }).snapshot as () => Promise<unknown>)()
      },
    } as unknown as PluginManagerPort,
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  const refresh = page.refresh()
  await new Promise(resolve => setTimeout(resolve, 5))
  basis = 2
  releaseRoster()
  await refresh
  for (let attempt = 0; attempt < 100 && page.getSnapshot().reading; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.deepEqual(reads, ['system', 'applications', 'ptc'],
    'the old-generation roster authorizes no downstream read; only the settled re-read runs once')
  assert.equal(page.getSnapshot().system.phase, 'ready')
  await page.dispose()
})

test('a silent Direct provider replacement during a read is never adopted as the new basis', async () => {
  let basis = 1
  let releaseRead!: () => void
  const held = new Promise<void>((resolve) => { releaseRead = resolve })
  const fake = cuaPort({
    observation: { readSnapshot: () => basis, subscribe: () => () => {} },
    // The applications read belongs to the OLD provider and is held while the
    // provider is silently replaced (Direct's subscription is inert).
    readApplications: async () => {
      const forBasis = basis
      if (forBasis === 1) await held
      return forBasis === 1
        ? APPLICATIONS
        : { allowedApps: [{ id: 'app-9', name: 'NewlyAllowed' }], blockedApps: [], persistentAvailable: true }
    },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: fake.port,
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  const published: string[] = []
  const phases: string[] = []
  page.subscribe(() => {
    phases.push(page.getSnapshot().applications.phase)
    const value = page.getSnapshot().applications.value
    if (value !== undefined) published.push(...value.allowedApps.map(application => application.id))
  })
  const refresh = page.refresh()
  await new Promise(resolve => setTimeout(resolve, 5))
  basis = 2
  releaseRead()
  await refresh
  for (let attempt = 0; attempt < 100 && page.getSnapshot().applications.phase !== 'ready'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.ok(!published.includes('app-1'), 'the crossed read\'s old-provider list may never be published')
  assert.ok(phases.includes('unknown'),
    'the crossed read publishes the unknown state before the settled re-read')
  assert.deepEqual(
    page.getSnapshot().applications.value?.allowedApps.map(application => application.id),
    ['app-9'],
    'the settled NEW generation is read once more and adopted',
  )
  await page.dispose()
})

test('a silent Direct replacement before an action dispatches nothing and states it', async () => {
  let basis = 1
  const { port, calls } = cuaPort({
    observation: { readSnapshot: () => basis, subscribe: () => () => {} },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: port,
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  await page.refresh()
  const capture = { epoch: page.getSnapshot().epoch, kind: 'request' as const, permission: 'accessibility' as const }
  // The provider is replaced with NO epoch/subscription event (Direct).
  basis = 2
  await page.requestPermission(capture)
  assert.deepEqual(calls.filter(call => call.startsWith('request:')), [],
    'the old-provider capture dispatches zero writes on the replaced provider')
  assert.equal(page.getSnapshot().action?.state, 'unknown')
  assert.match(page.getSnapshot().action?.text ?? '', /NOT dispatched/u)
  await page.dispose()
})

test('a write rejection from a silently replaced Direct provider is unknown, not failed', async () => {
  let basis = 1
  let rejectRun!: (error: Error) => void
  const held = new Promise<void>((_, reject) => { rejectRun = reject })
  const { port, calls } = cuaPort({
    observation: { readSnapshot: () => basis, subscribe: () => () => {} },
    revoke: async (id) => { calls.push(`revoke:${id}`); await held },
  })
  const page = new CuaAccessSettingsController({
    cuaAccess: port,
    pluginManager: pluginManager({ enabled: true }),
    presetDefault: presetDefault().config,
    locale: () => 'zh',
    diag: quietDiag,
  })
  await page.refresh()
  const write = page.revoke({ epoch: page.getSnapshot().epoch, kind: 'revoke', applicationId: 'app-1', applicationGroup: 'allowed' })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(calls.filter(call => call.startsWith('revoke:')), ['revoke:app-1'])
  // The OLD provider accepts the write, is replaced, then rejects.
  basis = 2
  rejectRun(new Error('old provider unavailable after request'))
  await write
  const receipt = page.getSnapshot().action
  assert.equal(receipt?.state, 'unknown')
  assert.match(receipt?.text ?? '', /unconfirmed/u)
  assert.doesNotMatch(receipt?.text ?? '', /old provider unavailable after request/u,
    'the replaced provider\'s error text is never attributed to the current provider')
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
