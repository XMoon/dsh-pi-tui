/**
 * M4-B2-HF Host-only composition contract test.
 *
 * Reads the REAL Host-only overlay the Host entry writes and drives the REAL
 * readiness audit over a Loader-shaped fixture (rows + fiber states + reflect
 * services). It does not boot a DSH Profile: the real cross-process Profile is
 * the split-process smoke's job; this suite pins the exact row inventory and
 * the fail-closed audit conditions.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-host-foundation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import {
  assertHostOnlyComposition,
  collectHostEntryStatus,
} from '../../src/app/remote-process/host-bootstrap.ts'
import { REMOTE_HOST_PREREQUISITE_SERVICES } from '../../src/app/remote/host-prerequisites.ts'
import { PI_TUI_HOST_READY_SERVICE } from '../../src/app/host/pi-tui-host-runtime.ts'
import { PI_TUI_FILE_REFERENCES_NAMESPACE } from '../../src/runtime/remote/pi-tui-file-reference-contract.ts'
import { PI_TUI_TERMINAL_PROGRESS_NAMESPACE } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'

/** One row of the real overlay insert list. */
interface OverlayRow {
  readonly id: string
  readonly name: string
  readonly inject?: readonly string[]
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
}

const OVERLAY_ROWS = (parseYaml(HOST_ONLY_PATCH) as Array<OverlayRow & { insert?: OverlayRow[] }>)
  .flatMap(entry => entry.insert ?? [entry])

function row(id: string): OverlayRow {
  const matches = OVERLAY_ROWS.filter(candidate => candidate.id === id)
  assert.equal(matches.length, 1, `the overlay must own exactly one "${id}" row`)
  return matches[0]
}

const FOUNDATION_ROWS: ReadonlyArray<{ owner: string; id: string; name: string }> = [
  { owner: 'fileUpload', id: 'split-host-file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
  { owner: 'sessionStats', id: 'split-host-session-stats', name: '@deepseek-ai/dsh-session-stats' },
  { owner: 'turnOutline', id: 'split-host-turn-outline', name: '@deepseek-ai/dsh-session-turn-outline' },
  { owner: 'sessionController', id: 'split-host-session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
  { owner: 'settingsController', id: 'split-host-settings-controller', name: '@deepseek-ai/dsh-api-settings-controller' },
  { owner: 'sessionLogExport', id: 'split-host-session-log-download', name: '@deepseek-ai/dsh-session-log-export' },
  { owner: 'piTuiHostRuntime', id: 'split-host-pi-tui-runtime', name: '@xmoon76/dsh-pi-tui/host-runtime' },
]

test('the Host-only overlay declares the six official rows and ONE built-in Host Runtime row', () => {
  // B1 rows unchanged.
  assert.equal(row('split-host-connection').name, '@deepseek-ai/dsh-client-connection')
  assert.deepEqual(row('split-host-api-remotes').inject, ['typertGateway', 'connection'])
  // TUI/Client-UI rows are disabled by declaration.
  for (const id of ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins']) {
    assert.equal(row(id).disabled, true, `${id} must stay disabled`)
  }
  // Exactly the seven new rows; no separate business-plugin rows.
  assert.equal(OVERLAY_ROWS.filter(candidate => candidate.id.startsWith('split-host-')).length, 9,
    'the overlay must own exactly the two B1 rows and the seven M4-B2-HF rows')
  for (const { id, name } of FOUNDATION_ROWS) {
    assert.equal(row(id).name, name)
  }
  assert.equal(OVERLAY_ROWS.filter(candidate => candidate.name === '@xmoon76/dsh-pi-tui/host-runtime').length, 1,
    'one built-in Host Runtime Loader row')
  assert.equal(OVERLAY_ROWS.some(candidate => /file-reference-host|terminal-progress-host/u.test(candidate.name ?? '')),
    false, 'the private features must not be independent Loader rows')
  assert.deepEqual(row('split-host-pi-tui-runtime').inject,
    ['tuiStartup', 'typert', 'agents', 'fileReferences', 'workingDirectory'])
  assert.deepEqual(row('split-host-session-controller').config, { nativeOpen: false })
  assert.deepEqual(row('split-host-file-upload').inject,
    ['tuiStartup', 'agents', 'attachments', 'commands', 'connection'])
  assert.deepEqual(row('split-host-session-stats').inject, ['tuiStartup', 'sessionProjections'])
  assert.deepEqual(row('split-host-turn-outline').inject, ['tuiStartup', 'sessionProjections'])
  assert.deepEqual(row('split-host-settings-controller').inject, ['tuiStartup', 'typert'])
  assert.deepEqual(row('split-host-session-log-download').inject, ['tuiStartup', 'commands', 'connection'])
})

interface FixtureRow {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean }
  readonly fiber?: { readonly state: number }
}

/** The baseline row set every Host-only Profile must expose as ACTIVE. */
function baselineRows(): FixtureRow[] {
  return [
    { options: { id: 'agent', name: '@deepseek-ai/dsh-agent' }, fiber: { state: 2 } },
    { options: { id: 'session', name: '@deepseek-ai/dsh-session' }, fiber: { state: 2 } },
    { options: { id: 'job-controller', name: '@deepseek-ai/dsh-api-job-controller' }, fiber: { state: 2 } },
    { options: { id: 'typert-gateway', name: '@deepseek-ai/dsh-api-gateway' }, fiber: { state: 2 } },
    { options: { id: 'split-host-connection', name: '@deepseek-ai/dsh-client-connection' }, fiber: { state: 2 } },
    { options: { id: 'split-host-api-remotes', name: '@deepseek-ai/dsh-api-remotes' }, fiber: { state: 2 } },
    { options: { id: 'pi-tui-performance-host', name: '@xmoon76/dsh-pi-tui/performance-host' }, fiber: { state: 2 } },
    { options: { id: 'pi-tui-visual-tools', name: '@xmoon76/dsh-pi-tui/visual-tools' }, fiber: { state: 2 } },
    ...FOUNDATION_ROWS.map(({ id, name }) => ({ options: { id, name }, fiber: { state: 2 } })),
    ...['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'].map(id => ({
      options: { id, name: id, disabled: true },
    })),
  ]
}

function typertService(serviceKey: string, namespace: string): { typertRemote: { serviceKey: string; namespace: string } } {
  return { typertRemote: { serviceKey, namespace } }
}

/** Build the minimal reflect/loader shape the Host readiness audit consumes. */
function hostContext(rows: FixtureRow[], overrides: Record<string, unknown> = {}): Context {
  const services = new Map<string, unknown>()
  for (const service of REMOTE_HOST_PREREQUISITE_SERVICES) services.set(service, {})
  services.set('connection', {})
  services.set('webServer', {
    host: '127.0.0.1',
    port: 4567,
    protocol: 'http:',
    getOrigin: () => 'http://127.0.0.1:4567',
  })
  services.set('sessionController', typertService('sessionController', 'session'))
  services.set('fileUploads', typertService('fileUploads', 'fileUploads'))
  services.set('settingsController', typertService('settingsController', 'settings'))
  services.set('piTuiFileReferences', typertService('piTuiFileReferences', PI_TUI_FILE_REFERENCES_NAMESPACE))
  services.set('piTuiTerminalProgress', typertService('piTuiTerminalProgress', PI_TUI_TERMINAL_PROGRESS_NAMESPACE))
  services.set(PI_TUI_HOST_READY_SERVICE, {})
  services.set('piTuiPerformanceReady', {})
  for (const [name, value] of Object.entries(overrides)) services.set(name, value)
  return {
    reflect: { get: (name: string) => services.get(name) },
    loader: { entries: () => rows, await: async () => undefined },
    fiber: { uid: 1 },
  } as unknown as Context
}

test('the readiness audit passes only when every owner row and binding is real', () => {
  const status = collectHostEntryStatus(hostContext(baselineRows()), { profile: 'pi-tui' })
  assert.equal(status.phase, 'ready')
  assert.equal(status.sessionOpen, false, 'Host RPC readiness is not an open Client Session')
  assert.deepEqual(status.ownerEntries.piTuiHostRuntime, ['split-host-pi-tui-runtime'])
  assert.deepEqual(status.ownerEntries.performance, ['pi-tui-performance-host'])
  assert.deepEqual(status.ownerEntries.visualTools, ['pi-tui-visual-tools'])
  for (const { owner, id } of FOUNDATION_ROWS) {
    assert.deepEqual(status.ownerEntries[owner], [id], `${owner} owner row mismatch`)
  }
})

test('a missing foundation row, a missing binding or a duplicate row fails the audit', () => {
  for (const { owner, id } of FOUNDATION_ROWS) {
    const rows = baselineRows().filter(candidate => candidate.options.id !== id)
    assert.throws(
      () => collectHostEntryStatus(hostContext(rows), { profile: 'pi-tui' }),
      new RegExp(`expected exactly one active ${owner} owner row`, 'u'),
      `missing ${id} must fail the audit`,
    )
    // A second active copy of the same row must also fail the exactly-one rule.
    const duplicated = baselineRows().concat({ options: { id, name: 'duplicate' }, fiber: { state: 2 } })
    assert.throws(
      () => collectHostEntryStatus(hostContext(duplicated), { profile: 'pi-tui' }),
      new RegExp(`expected exactly one active ${owner} owner row`, 'u'),
    )
  }

  const missingBindingContext = hostContext(baselineRows(), { sessionController: {} })
  assert.throws(
    () => collectHostEntryStatus(missingBindingContext, { profile: 'pi-tui' }),
    /sessionController.*Typert binding/u,
  )
  const missingReady = hostContext(baselineRows(), { [PI_TUI_HOST_READY_SERVICE]: undefined })
  assert.throws(
    () => collectHostEntryStatus(missingReady, { profile: 'pi-tui' }),
    /piTuiHostReady/u,
  )
})

test('an active forbidden TUI row or an enabled-but-absent one fails the declaration audit', () => {
  const activeTui = baselineRows().map(candidate =>
    candidate.options.id === 'tui-app' ? { ...candidate, options: { ...candidate.options, disabled: false }, fiber: { state: 2 } } : candidate)
  assert.throws(
    () => assertHostOnlyComposition(hostContext(activeTui)),
    /forbidden TUI\/Client-UI rows are active|not disabled/u,
  )
  const enabledButAbsent = baselineRows().map(candidate =>
    candidate.options.id === 'pi-tui-builtins' ? { ...candidate, options: { ...candidate.options, disabled: false } } : candidate)
  assert.throws(
    () => assertHostOnlyComposition(hostContext(enabledButAbsent)),
    /not disabled/u,
  )
})
