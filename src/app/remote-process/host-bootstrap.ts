/**
 * Host-only readiness audit for the M4-B1 process entry.
 *
 * The entry boots the ordinary DSH profile through the real launcher
 * (`@deepseek-ai/dsh/profile-boot`). This module runs after that boot and owns
 * only the Host verdict: the shared Remote Host prerequisite set must be live,
 * the B1-only Connection/API-remotes rows must be the sole active owners, the
 * base Gateway must be active exactly once, the loopback webserver must be
 * bound, and the TUI/Client-UI rows the Host-only overlay disables must not be
 * active. It never composes a second Host graph.
 *
 * @module app/remote-process/host-bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  assertRemoteHostPrerequisites,
  REMOTE_HOST_PREREQUISITE_SERVICES,
} from '../remote/host-prerequisites.ts'
import { PI_TUI_HOST_READY_SERVICE } from '../host/pi-tui-host-runtime.ts'
import { PI_TUI_FILE_REFERENCES_NAMESPACE } from '../../runtime/remote/pi-tui-file-reference-contract.ts'
import { PI_TUI_TERMINAL_PROGRESS_NAMESPACE } from '../../runtime/remote/pi-tui-terminal-progress-contract.ts'

/** Cordis `FiberState.ACTIVE` (the enum is a const enum with no runtime value). */
const FIBER_ACTIVE = 2

/** Loader rows that must never be active in the Host-only process. */
const FORBIDDEN_HOST_ENTRY_IDS = ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'] as const

/** Minimal structural view of one Loader entry. */
interface LoaderEntryLike {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean }
  readonly fiber?: { readonly state: number }
}

/** Minimal structural view of the running Loader service. */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
  await(): Promise<unknown>
}

function loaderOf(context: Context): LoaderLike {
  const loader = (context as unknown as { readonly loader?: LoaderLike }).loader
  if (loader === undefined) throw new Error('local host entry: the booted profile has no Loader service')
  return loader
}

/** The Host-only readiness facts reported to the qualification launcher. */
export interface HostEntryStatus {
  readonly processRole: 'host'
  readonly pid: number
  readonly processStartIdentity?: string
  readonly phase: 'ready'
  readonly fiberOwner: 'dsh-profile-root'
  readonly rootFiberUid?: number
  readonly transport: 'listening'
  readonly sessionOpen: false
  readonly profile: string
  readonly services: Record<string, boolean>
  readonly ownerEntries: Record<string, readonly string[]>
  readonly entries: ReadonlyArray<{ id: string; name: string; state: string }>
  readonly forbiddenActive: readonly string[]
  readonly webServer?: { host: string; port: number }
}

/** A stable label for one fiber state, or `absent` for a disabled/never-started row. */
function fiberStateLabel(entry: LoaderEntryLike): string {
  const state = entry.fiber?.state
  if (state === undefined) return 'absent'
  if (state === FIBER_ACTIVE) return 'active'
  return `state-${String(state)}`
}

/** Minimal structural view of one Typert Gateway binding. */
interface TypertBindingLike {
  readonly serviceKey?: unknown
  readonly namespace?: unknown
}

/** The official Session-serving services whose Typert namespace must be real. */
const OFFICIAL_TYPERT_BINDINGS = [
  { serviceKey: 'sessionController', namespace: 'session' },
  { serviceKey: 'fileUploads', namespace: 'fileUploads' },
  { serviceKey: 'settingsController', namespace: 'settings' },
] as const

/** The package's two private endpoint bindings. */
const PRIVATE_TYPERT_BINDINGS = [
  { serviceKey: 'piTuiFileReferences', namespace: PI_TUI_FILE_REFERENCES_NAMESPACE },
  { serviceKey: 'piTuiTerminalProgress', namespace: PI_TUI_TERMINAL_PROGRESS_NAMESPACE },
] as const

/**
 * Assert one Host service is readable AND carries the expected Typert binding.
 * A truthy service alone is not proof: the Gateway dispatches on the binding.
 */
function assertTypertBinding(context: Context, serviceKey: string, namespace: string): void {
  const service = context.reflect.get(serviceKey) as { readonly typertRemote?: TypertBindingLike } | undefined
  if (service === undefined) {
    throw new Error(`local host entry: the Host did not publish the "${serviceKey}" service`)
  }
  const binding = service.typertRemote
  if (binding === undefined || binding.serviceKey !== serviceKey || binding.namespace !== namespace) {
    throw new Error(
      `local host entry: the "${serviceKey}" Typert binding is not ${serviceKey}/${namespace}`,
    )
  }
}

/**
 * Assert the disabled TUI rows stayed disabled AND did not activate despite the
 * profile patch. The declaration check is what makes an overlay mutation
 * (`disabled: false`) a deterministic Host startup failure even when the
 * re-enabled TUI plugin fails to mount without a terminal.
 */
export function assertHostOnlyComposition(context: Context): void {
  const entries = [...loaderOf(context).entries()]
  const forbidden = entries.filter(entry =>
    FORBIDDEN_HOST_ENTRY_IDS.includes(entry.options.id as (typeof FORBIDDEN_HOST_ENTRY_IDS)[number]))
  const activeForbidden = forbidden
    .filter(entry => entry.fiber?.state === FIBER_ACTIVE)
    .map(entry => entry.options.id)
  if (activeForbidden.length > 0) {
    throw new Error(`local host entry: forbidden TUI/Client-UI rows are active: ${activeForbidden.join(', ')}`)
  }
  const enabledForbidden = forbidden
    .filter(entry => entry.options.disabled !== true)
    .map(entry => entry.options.id)
  if (enabledForbidden.length > 0) {
    throw new Error(`local host entry: forbidden TUI/Client-UI rows are not disabled: ${enabledForbidden.join(', ')}`)
  }
}

/** Wait for every Loader entry to settle after the profile boot returned. */
export async function settleHostEntries(context: Context): Promise<void> {
  await loaderOf(context).await()
}

/**
 * Prove the production Host prerequisite set is live and collect the readiness
 * facts. Must run after {@link settleHostEntries}; a missing prerequisite is a
 * hard failure, never a degraded ready.
 */
export function collectHostEntryStatus(
  context: Context,
  identity: { readonly profile: string; readonly processStartIdentity?: string },
): HostEntryStatus {
  assertRemoteHostPrerequisites(context)
  assertHostOnlyComposition(context)
  const entries = [...loaderOf(context).entries()]
  const services: Record<string, boolean> = {}
  for (const service of REMOTE_HOST_PREREQUISITE_SERVICES) {
    services[service] = context.reflect.get(service) !== undefined
  }
  // The foundation services this overlay adds are evidence too: the smoke reads
  // the readiness record and must not have to infer them from row names alone.
  for (const service of [
    'sessionController',
    'fileUploads',
    'settingsController',
    PI_TUI_FILE_REFERENCES_NAMESPACE,
    PI_TUI_TERMINAL_PROGRESS_NAMESPACE,
    PI_TUI_HOST_READY_SERVICE,
    'piTuiPerformanceReady',
  ]) {
    services[service] = context.reflect.get(service) !== undefined
  }
  /** Only ACTIVE rows own a service; a disabled/absent row proves nothing. */
  const activeIds = (id: string): readonly string[] => entries
    .filter(entry => entry.options.id === id && entry.fiber?.state === FIBER_ACTIVE)
    .map(entry => entry.options.id)
  const ownerEntries: Record<string, readonly string[]> = {
    agents: activeIds('agent'),
    sessions: activeIds('session'),
    jobController: activeIds('job-controller'),
    // B1 mounts exactly one official Connection owner and one API-remotes
    // event source on the Host-only overlay; the base Gateway is reused, not
    // remounted.
    connection: activeIds('split-host-connection'),
    apiRemotes: activeIds('split-host-api-remotes'),
    typertGateway: activeIds('typert-gateway'),
    // The six official Session-serving rows and the ONE built-in PiTui Host
    // Runtime row the Host-only overlay adds.
    fileUpload: activeIds('split-host-file-upload'),
    sessionStats: activeIds('split-host-session-stats'),
    turnOutline: activeIds('split-host-turn-outline'),
    sessionController: activeIds('split-host-session-controller'),
    settingsController: activeIds('split-host-settings-controller'),
    sessionLogExport: activeIds('split-host-session-log-download'),
    piTuiHostRuntime: activeIds('split-host-pi-tui-runtime'),
    // The pre-existing bundle rows must remain the sole owners: Performance
    // publishes `piTuiPerformanceReady`, Visual Tools stays an independent row.
    performance: activeIds('pi-tui-performance-host'),
    visualTools: activeIds('pi-tui-visual-tools'),
  }
  for (const [owner, ids] of Object.entries(ownerEntries)) {
    if (ids.length !== 1) {
      const visible = entries.map(entry => `${entry.options.id}:${fiberStateLabel(entry)}`)
      throw new Error(
        `local host entry: expected exactly one active ${owner} owner row, found ${String(ids.length)}; entries=${visible.join(',')}`,
      )
    }
  }
  for (const { serviceKey, namespace } of [...OFFICIAL_TYPERT_BINDINGS, ...PRIVATE_TYPERT_BINDINGS]) {
    assertTypertBinding(context, serviceKey, namespace)
  }
  if (context.reflect.get(PI_TUI_HOST_READY_SERVICE) === undefined) {
    throw new Error(`local host entry: the built-in PiTui Host Runtime did not publish "${PI_TUI_HOST_READY_SERVICE}"`)
  }
  if (context.reflect.get('piTuiPerformanceReady') === undefined) {
    throw new Error('local host entry: the existing pi-tui-performance-host row did not publish piTuiPerformanceReady')
  }
  if (context.reflect.get('connection') === undefined) {
    throw new Error('local host entry: the Host did not publish the official Connection service')
  }
  const webServer = context.reflect.get('webServer') as {
    readonly host?: string
    readonly port?: number
    readonly protocol?: string
    getOrigin(): string
  } | undefined
  if (webServer?.host !== '127.0.0.1' || webServer.port === undefined || webServer.port < 1) {
    throw new Error('local host entry: the Host webserver must bind 127.0.0.1 on an OS-assigned port')
  }
  if (webServer.protocol === 'https:') {
    throw new Error('local host entry: B1 requires the plain loopback HTTP webserver')
  }
  const origin = webServer.getOrigin()
  const loopbackPrefix = 'http://127.0.0.1:'
  if (!origin.startsWith(loopbackPrefix) || !/^\d+$/u.test(origin.slice(loopbackPrefix.length))) {
    throw new Error(`local host entry: the Host webserver origin is not loopback HTTP (${origin})`)
  }
  const rootFiber = (context as unknown as { readonly fiber?: { readonly uid?: number } }).fiber
  return {
    processRole: 'host',
    pid: process.pid,
    ...(identity.processStartIdentity === undefined ? {} : { processStartIdentity: identity.processStartIdentity }),
    phase: 'ready',
    fiberOwner: 'dsh-profile-root',
    ...(rootFiber?.uid == null ? {} : { rootFiberUid: rootFiber.uid }),
    transport: 'listening',
    sessionOpen: false,
    profile: identity.profile,
    services,
    ownerEntries,
    entries: entries.map(entry => ({
      id: entry.options.id,
      name: entry.options.name,
      state: fiberStateLabel(entry),
    })),
    forbiddenActive: [],
    webServer: { host: webServer.host, port: webServer.port },
  }
}
