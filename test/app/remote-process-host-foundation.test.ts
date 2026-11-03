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

/** One top-level overlay entry: an in-place row override or an `insert` group. */
interface OverlayEntry extends OverlayRow {
  readonly insert?: readonly OverlayRow[]
}

const OVERLAY_ENTRIES = parseYaml(HOST_ONLY_PATCH) as OverlayEntry[]
const OVERLAY_ROWS = OVERLAY_ENTRIES.flatMap(entry => entry.insert ?? [entry])

function row(id: string): OverlayRow {
  const matches = OVERLAY_ROWS.filter(candidate => candidate.id === id)
  assert.equal(matches.length, 1, `the overlay must own exactly one "${id}" row`)
  return matches[0]
}

/**
 * The ten Host execution rows whose lifetime must not depend on the mutable
 * `tuiStartup` provider: `webserver` / `workspace-files` are the two existing
 * rows overridden in place, the other eight are the Host-only inserted rows.
 */
const HOST_EXECUTION_INJECT: ReadonlyArray<{ id: string; inject: readonly string[] }> = [
  { id: 'webserver', inject: [] },
  { id: 'workspace-files', inject: [] },
  { id: 'split-host-connection', inject: ['credentials', 'webServer'] },
  { id: 'split-host-file-upload', inject: ['agents', 'attachments', 'commands', 'connection'] },
  { id: 'split-host-session-stats', inject: ['sessionProjections'] },
  { id: 'split-host-turn-outline', inject: ['sessionProjections'] },
  {
    id: 'split-host-session-controller',
    inject: [
      'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm',
      'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry',
    ],
  },
  { id: 'split-host-settings-controller', inject: ['typert'] },
  { id: 'split-host-session-log-download', inject: ['commands', 'connection'] },
  { id: 'split-host-pi-tui-runtime', inject: ['typert', 'agents', 'fileReferences', 'workingDirectory'] },
]

/**
 * Pin the exact dependency set of the ten Host execution rows. Shared by the
 * positive assertion and its negative control so the control proves THIS
 * assertion group rejects a reintroduced `tuiStartup`, not a private copy.
 */
function assertHostExecutionInject(entries: readonly OverlayEntry[]): void {
  const rows = entries.flatMap(entry => entry.insert ?? [entry])
  for (const { id, inject } of HOST_EXECUTION_INJECT) {
    const matches = rows.filter(candidate => candidate.id === id)
    assert.equal(matches.length, 1, `the overlay must own exactly one "${id}" row`)
    assert.deepEqual(matches[0].inject, inject, `the "${id}" row inject mismatch`)
    assert.equal(matches[0].inject?.includes('tuiStartup'), false,
      `the "${id}" row must not depend on the mutable tuiStartup provider`)
  }
  // The two existing rows are overridden in place; inserting them again would
  // create a second service owner instead of retuning the production row.
  for (const id of ['webserver', 'workspace-files']) {
    const topLevel = entries.filter(entry => entry.insert === undefined && entry.id === id)
    assert.equal(topLevel.length, 1, `the overlay must declare exactly one top-level "${id}" override`)
    assert.deepEqual(topLevel[0].inject, [], `the "${id}" top-level override must inject nothing`)
  }
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
  assert.deepEqual(row('split-host-session-controller').config, { nativeOpen: false })
  // The exact ten-row dependency contract, including the two in-place overrides.
  assertHostExecutionInject(OVERLAY_ENTRIES)
})

test('the protected ten-row dependency assertion rejects a reintroduced tuiStartup', () => {
  const reintroduced = OVERLAY_ENTRIES.map(entry => entry.insert === undefined ? entry : {
    ...entry,
    insert: entry.insert.map(candidate => candidate.id === 'split-host-turn-outline'
      ? { ...candidate, inject: [...(candidate.inject ?? []), 'tuiStartup'] }
      : candidate),
  })
  assert.throws(
    () => assertHostExecutionInject(reintroduced),
    /split-host-turn-outline/u,
    'the negative control must fail on the protected row id',
  )
})

test('the protected ten-row dependency assertion rejects a duplicated protected row', () => {
  const insertEntry = OVERLAY_ENTRIES.find(entry => entry.insert !== undefined)
  const insertRows = insertEntry?.insert
  assert.ok(insertRows !== undefined, 'the overlay must insert the Host execution rows')
  const protectedRow = insertRows.find(candidate => candidate.id === 'split-host-session-stats')
  assert.ok(protectedRow !== undefined, 'the negative control needs one real protected row to duplicate')
  const duplicated = OVERLAY_ENTRIES.map(entry => entry === insertEntry
    ? { ...entry, insert: [...insertRows, protectedRow] }
    : entry)
  assert.throws(
    () => assertHostExecutionInject(duplicated),
    /the overlay must own exactly one "split-host-session-stats" row/u,
    'the negative control must reject the duplicated row itself',
  )
})

interface FixtureRow {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean }
  readonly fiber?: { readonly state: number; readonly uid?: number }
}

/**
 * One distinct fake Loader fiber UID per row id. A status that caches,
 * serializes or invents a UID therefore cannot match the live row object.
 */
const ROW_FIBER_UIDS = new Map<string, number>()

function rowUid(id: string): number {
  const known = ROW_FIBER_UIDS.get(id)
  if (known !== undefined) return known
  const next = 1000 + ROW_FIBER_UIDS.size
  ROW_FIBER_UIDS.set(id, next)
  return next
}

/** The baseline row set every Host-only Profile must expose as ACTIVE. */
function baselineRows(): FixtureRow[] {
  const active = (id: string, name: string, withUid = true): FixtureRow => ({
    options: { id, name },
    fiber: withUid ? { state: 2, uid: rowUid(id) } : { state: 2 },
  })
  return [
    active('agent', '@deepseek-ai/dsh-agent'),
    active('session', '@deepseek-ai/dsh-session'),
    active('job-controller', '@deepseek-ai/dsh-api-job-controller'),
    active('typert-gateway', '@deepseek-ai/dsh-api-gateway'),
    active('split-host-connection', '@deepseek-ai/dsh-client-connection'),
    active('split-host-api-remotes', '@deepseek-ai/dsh-api-remotes'),
    active('pi-tui-performance-host', '@xmoon76/dsh-pi-tui/performance-host'),
    active('pi-tui-visual-tools', '@xmoon76/dsh-pi-tui/visual-tools'),
    ...FOUNDATION_ROWS.map(({ id, name }) => active(id, name)),
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
  services.set('piTuiTerminalProgress', {
    ...typertService('piTuiTerminalProgress', PI_TUI_TERMINAL_PROGRESS_NAMESPACE),
    records: new Map(),
  })
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
  assert.equal(status.terminalProgressWatches, 0, 'the Host reports no live terminal-progress watch')
  assert.deepEqual(status.ownerEntries.piTuiHostRuntime, ['split-host-pi-tui-runtime'])
  assert.deepEqual(status.ownerEntries.performance, ['pi-tui-performance-host'])
  assert.deepEqual(status.ownerEntries.visualTools, ['pi-tui-visual-tools'])
  for (const { owner, id } of FOUNDATION_ROWS) {
    assert.deepEqual(status.ownerEntries[owner], [id], `${owner} owner row mismatch`)
  }
})

test('the Host status reports the live Loader fiber UID of each row and never invents one', () => {
  const status = collectHostEntryStatus(hostContext(baselineRows()), { profile: 'pi-tui' })
  const byId = new Map(status.entries.map(entry => [entry.id, entry]))
  // Positive: every ACTIVE row carries the UID of the live fiber object.
  for (const { id } of FOUNDATION_ROWS) {
    const entry = byId.get(id)
    assert.ok(entry !== undefined, `${id} must appear in the Host status`)
    assert.equal(entry.state, 'active')
    assert.equal(entry.fiberUid, rowUid(id), `${id} must report its live Loader fiber UID`)
  }
  assert.equal(byId.get('agent')?.fiberUid, rowUid('agent'))
  assert.equal(byId.get('pi-tui-performance-host')?.fiberUid, rowUid('pi-tui-performance-host'))
  // Negative control: a row whose fiber object has no UID reports NO UID. The
  // status must never substitute an index, a sequence number or a cached id.
  const withoutUid = baselineRows().map(candidate => candidate.options.id === 'split-host-session-stats'
    ? { ...candidate, fiber: { state: 2 } }
    : candidate)
  const degraded = collectHostEntryStatus(hostContext(withoutUid), { profile: 'pi-tui' })
  const missing = degraded.entries.find(entry => entry.id === 'split-host-session-stats')
  assert.equal(missing?.state, 'active')
  assert.equal(missing?.fiberUid, undefined,
    'a fiber without a UID must not be given a fabricated one')
  // A row that never started has no fiber at all and therefore no UID.
  assert.equal(degraded.entries.find(entry => entry.id === 'tui-app')?.fiberUid, undefined)
})

test('a duplicated or inactive protected row still fails even with fiber UIDs present', () => {
  const duplicated = baselineRows().concat({
    options: { id: 'split-host-turn-outline', name: 'duplicate' },
    fiber: { state: 2, uid: rowUid('split-host-turn-outline') + 500 },
  })
  assert.throws(
    () => collectHostEntryStatus(hostContext(duplicated), { profile: 'pi-tui' }),
    /expected exactly one active turnOutline owner row/u,
  )
  const inactive = baselineRows().map(candidate => candidate.options.id === 'split-host-settings-controller'
    ? { ...candidate, fiber: { state: 1, uid: rowUid('split-host-settings-controller') } }
    : candidate)
  assert.throws(
    () => collectHostEntryStatus(hostContext(inactive), { profile: 'pi-tui' }),
    /expected exactly one active settingsController owner row/u,
  )
})

test('the Host status reports live terminal-progress subscribers, not a cached flag', () => {
  const watched = hostContext(baselineRows(), {
    piTuiTerminalProgress: {
      ...typertService('piTuiTerminalProgress', PI_TUI_TERMINAL_PROGRESS_NAMESPACE),
      records: new Map([['watched-session', { subscribers: new Set([{}, {}]) }]]),
    },
  })
  assert.equal(
    collectHostEntryStatus(watched, { profile: 'pi-tui' }).terminalProgressWatches,
    2,
    'the status must count the actual subscribers in the Host service',
  )
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
