/**
 * Host-only readiness audit for the M4-A0 process entry.
 *
 * The entry boots the ordinary DSH profile through the real launcher
 * (`@deepseek-ai/dsh/profile-boot`). This module runs after that boot and owns
 * only the M4-A0 Host verdict: the shared Remote Host prerequisite set must be
 * live, and the TUI/Client-UI rows the Host-only overlay disables must not be
 * active. It never composes a second Host graph and never mounts a Remote row
 * (B1 owns transport wiring).
 *
 * @module app/remote-process/host-bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  assertRemoteHostPrerequisites,
  REMOTE_HOST_PREREQUISITE_SERVICES,
} from '../remote/host-prerequisites.ts'

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
  readonly transport: 'not-connected'
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

/** Assert the disabled TUI rows did not activate despite the profile patch. */
export function assertHostOnlyComposition(context: Context): void {
  const entries = [...loaderOf(context).entries()]
  const activeForbidden = entries
    .filter(entry => FORBIDDEN_HOST_ENTRY_IDS.includes(entry.options.id as (typeof FORBIDDEN_HOST_ENTRY_IDS)[number]))
    .filter(entry => entry.fiber?.state === FIBER_ACTIVE)
    .map(entry => entry.options.id)
  if (activeForbidden.length > 0) {
    throw new Error(`local host entry: forbidden TUI/Client-UI rows are active: ${activeForbidden.join(', ')}`)
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
  /** Only ACTIVE rows own a service; a disabled/absent row proves nothing. */
  const activeIds = (id: string): readonly string[] => entries
    .filter(entry => entry.options.id === id && entry.fiber?.state === FIBER_ACTIVE)
    .map(entry => entry.options.id)
  const ownerEntries: Record<string, readonly string[]> = {
    agents: activeIds('agent'),
    sessions: activeIds('session'),
    jobController: activeIds('job-controller'),
    // A0 does not mount the official Connection: B1 owns the authenticated
    // loopback transport. Reporting the empty set keeps that absence explicit.
    connection: activeIds('connection'),
  }
  for (const [owner, ids] of Object.entries(ownerEntries)) {
    if (owner === 'connection') {
      if (ids.length !== 0) throw new Error(`local host entry: the A0 Host must not mount a Connection owner (found ${ids.join(', ')})`)
      continue
    }
    if (ids.length !== 1) {
      throw new Error(`local host entry: expected exactly one active ${owner} owner row, found ${String(ids.length)}`)
    }
  }
  const rootFiber = (context as unknown as { readonly fiber?: { readonly uid?: number } }).fiber
  const webServer = context.reflect.get('webServer') as { readonly host?: string; readonly port?: number } | undefined
  return {
    processRole: 'host',
    pid: process.pid,
    ...(identity.processStartIdentity === undefined ? {} : { processStartIdentity: identity.processStartIdentity }),
    phase: 'ready',
    fiberOwner: 'dsh-profile-root',
    ...(rootFiber?.uid == null ? {} : { rootFiberUid: rootFiber.uid }),
    transport: 'not-connected',
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
    ...(webServer?.host === undefined || webServer.port === undefined
      ? {}
      : { webServer: { host: webServer.host, port: webServer.port } }),
  }
}
