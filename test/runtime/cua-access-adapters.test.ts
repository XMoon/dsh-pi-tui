/**
 * Direct/Remote CUA access adapter contracts (PR-5 / MAC-09 v2).
 *
 * These prove the transport-neutral semantics: the Direct adapter resolves
 * the official Host service lazily and fails closed when the bundle is not
 * loaded, the Remote adapter unwraps the official generated RemoteResult and
 * fences a superseded Connection generation, and neither adapter fabricates a
 * permission state.
 * @module @xmoon76/dsh-pi-tui/cua-access-adapters.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DIRECT_CUA_ACCESS_REASON, DirectCuaAccessPort } from '../../src/runtime/direct/cua-access-direct.ts'
import { CuaAccessUnavailableError, type CuaApplicationState, type CuaPtcConfiguration, type CuaSystemStatus } from '../../src/runtime/cua-access-port.ts'
import { RemoteCuaAccessPort, type RemoteCuaAccessNamespace } from '../../src/runtime/remote/cua-access-remote.ts'
import { SupersededReadError } from '../../src/runtime/read-error.ts'

const STATUS: CuaSystemStatus = {
  platform: 'darwin',
  accessibility: false,
  screenRecording: false,
  helper: { pid: 7, name: 'DSH Computer Use', path: '/helper/dsh-cua-native' },
  parent: { pid: 1, path: '/sbin/launchd' },
  launchApplication: { name: 'DSH Computer Use.app', path: '/helper/DSH Computer Use.app' },
}
const APPLICATIONS: CuaApplicationState = {
  allowedApps: [{ id: 'app-1', name: 'TextEdit' }],
  blockedApps: [{ id: 'app-2', name: 'Example' }],
  persistentAvailable: true,
}
const PTC: CuaPtcConfiguration = { persistent: false, writable: true }

test('Direct CUA access resolves the official service per call and fails closed without it', async () => {
  let service: {
    systemStatus(): Promise<CuaSystemStatus>
    applications(): Promise<CuaApplicationState>
    applicationIcons(): Promise<Record<string, string>>
    ptcConfiguration(): CuaPtcConfiguration
    requestPermission(permission: string, locale: string): Promise<CuaSystemStatus>
    openSettings(permission: string, locale: string): Promise<void>
    enablePersistentPtc(): Promise<void>
    revoke(id: string): Promise<void>
    retryApproval(id: string): Promise<void>
  } | undefined
  const calls: string[] = []
  const ctx = { get: (name: string): unknown => name === 'cuaAccess' ? service : undefined }
  const port = new DirectCuaAccessPort(ctx)

  await assert.rejects(port.readSystemStatus(), (error: unknown) =>
    error instanceof CuaAccessUnavailableError && error.message === DIRECT_CUA_ACCESS_REASON)

  service = {
    systemStatus: async () => { calls.push('systemStatus'); return STATUS },
    applications: async () => { calls.push('applications'); return APPLICATIONS },
    applicationIcons: async () => { calls.push('applicationIcons'); return { '/TextEdit': 'icon' } },
    ptcConfiguration: () => { calls.push('ptcConfiguration'); return PTC },
    requestPermission: async (permission: string, locale: string) => { calls.push(`requestPermission:${permission}:${locale}`); return STATUS },
    openSettings: async (permission: string, locale: string) => { calls.push(`openSettings:${permission}:${locale}`) },
    enablePersistentPtc: async () => { calls.push('enablePersistentPtc') },
    revoke: async (id: string) => { calls.push(`revoke:${id}`) },
    retryApproval: async (id: string) => { calls.push(`retryApproval:${id}`) },
  }

  assert.deepEqual(await port.readSystemStatus(), STATUS)
  assert.deepEqual(await port.readApplications(), APPLICATIONS)
  assert.deepEqual(await port.readApplicationIcons(), { '/TextEdit': 'icon' })
  assert.deepEqual(await port.readPtcConfiguration(), PTC)
  assert.deepEqual(await port.requestPermission('accessibility', 'zh'), STATUS)
  await port.openSettings('screenRecording', 'zh')
  await port.enablePersistentPtc()
  await port.revoke('app-1')
  await port.retryApproval('app-2')
  assert.deepEqual(calls, [
    'systemStatus',
    'applications',
    'applicationIcons',
    'ptcConfiguration',
    'requestPermission:accessibility:zh',
    'openSettings:screenRecording:zh',
    'enablePersistentPtc',
    'revoke:app-1',
    'retryApproval:app-2',
  ])

  // The bundle can unload after the first use: the NEXT call re-resolves and
  // fails closed instead of pinning the stale service.
  service = undefined
  await assert.rejects(port.readApplications(), CuaAccessUnavailableError)
})

test('Remote CUA access unwraps the official generated result and fences a superseded generation', async () => {
  let generation: { readonly id: number } = { id: 1 }
  const generationSource = { getSnapshot: () => generation, subscribe: () => () => {} }
  const calls: string[] = []
  const namespace: RemoteCuaAccessNamespace = {
    systemStatus: async () => { calls.push('systemStatus'); return { ok: true, value: STATUS } },
    applications: async () => ({ ok: true, value: APPLICATIONS }),
    applicationIcons: async () => ({ ok: true, value: { '/TextEdit': 'icon' } }),
    ptcConfiguration: async () => ({ ok: true, value: PTC }),
    requestPermission: async (permission, locale) => { calls.push(`requestPermission:${permission}:${locale}`); return { ok: true, value: STATUS } },
    openSettings: async (permission, locale) => { calls.push(`openSettings:${permission}:${locale}`); return { ok: true, value: undefined } },
    enablePersistentPtc: async () => ({ ok: true, value: undefined }),
    revoke: async (id) => { calls.push(`revoke:${id}`); return { ok: true, value: undefined } },
    retryApproval: async (id) => { calls.push(`retryApproval:${id}`); return { ok: true, value: undefined } },
  }
  const port = new RemoteCuaAccessPort(namespace, generationSource)
  assert.deepEqual(await port.readSystemStatus(), STATUS)
  assert.deepEqual(await port.readApplications(), APPLICATIONS)
  assert.deepEqual(await port.readApplicationIcons(), { '/TextEdit': 'icon' })
  assert.deepEqual(await port.readPtcConfiguration(), PTC)
  assert.deepEqual(await port.requestPermission('accessibility', 'zh'), STATUS)
  await port.openSettings('screenRecording', 'zh')
  await port.enablePersistentPtc()
  await port.revoke('app-1')
  await port.retryApproval('app-2')
  assert.deepEqual(calls, [
    'systemStatus',
    'requestPermission:accessibility:zh',
    'openSettings:screenRecording:zh',
    'revoke:app-1',
    'retryApproval:app-2',
  ])

  // A Host result carried by an older Connection generation is not current.
  const superseded = new RemoteCuaAccessPort({
    ...namespace,
    systemStatus: async () => {
      generation = { id: 2 }
      return { ok: true, value: STATUS }
    },
  }, generationSource)
  await assert.rejects(superseded.readSystemStatus(), SupersededReadError)

  // A Host refusal is thrown, never converted to an empty/default value.
  const refusedGeneration = { id: 3 }
  const refused = new RemoteCuaAccessPort({
    ...namespace,
    applications: async () => ({ ok: false, error: new Error('host refused applications') }),
  }, { getSnapshot: () => refusedGeneration, subscribe: () => () => {} })
  await assert.rejects(refused.readApplications(), /host refused applications/)

  const unmounted = new RemoteCuaAccessPort(undefined, { getSnapshot: () => ({ id: 4 }), subscribe: () => () => {} })
  await assert.rejects(unmounted.readSystemStatus(), CuaAccessUnavailableError)
  const disconnected = new RemoteCuaAccessPort(namespace, { getSnapshot: () => undefined, subscribe: () => () => {} })
  await assert.rejects(disconnected.readSystemStatus(), CuaAccessUnavailableError)
})
