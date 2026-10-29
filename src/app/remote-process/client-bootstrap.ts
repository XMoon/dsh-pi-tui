/**
 * Client-only pre-connection bootstrap for the M4-B1 process entry.
 *
 * The official Client runtime requires an explicit Host carrier; M4-B1 owns
 * the authenticated cross-process transport in `local-transport.ts`. This
 * module owns only the original A0 Client-local subtree (TUI startup facts,
 * extension host, first-party builtins) on the caller's one Client Context and
 * projects the official Connection state into a status snapshot at call time.
 * It never creates a Host handle, never copies connection state into a
 * long-lived flag, and never calls a Host shutdown.
 *
 * @module app/remote-process/client-bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../extensions.ts'
import { createRemoteClientUiRuntime, type RemoteClientUiRuntime } from '../remote/client-ui-runtime.ts'
import { mergeCause } from '../remote/dispose-cause.ts'
import type { LocalInstanceRecord } from './local-discovery.ts'
import type { LocalClientTransport } from './local-transport.ts'

/** Client-local startup facts handed to the pre-connection subtree. */
export interface LocalClientStartupFacts {
  readonly sessionId?: string
  readonly presetId?: string
}

/** The authenticated Host facts projected into Client status. */
export interface LocalClientHostFacts {
  readonly scopeId: string
  readonly instanceId: string
  readonly hostPid: number
  readonly hostStarttime: string
  readonly origin: string
  readonly protocol: string
  readonly bundleVersion: string
  readonly dshVersion: string
  readonly buildId: string
}

/** A status snapshot built from the official Connection at call time. */
export interface LocalClientStatus {
  readonly processRole: 'client'
  readonly pid: number
  readonly processStartIdentity?: string
  readonly phase: 'client-local-ready'
  readonly transport: 'not-connected' | 'connecting' | 'connected' | 'disconnected'
  readonly sessionOpen: false
  readonly fiberOwner: 'client-root'
  readonly rootFiberUid?: number
  readonly extensionService: { readonly present: true }
  readonly startupFacts: { readonly sessionId?: string; readonly presetId?: string }
  readonly host?: LocalClientHostFacts
  readonly generationId?: number
  readonly hostHome?: string
}

/** The Client composition inputs that are not startup facts. */
export interface LocalClientComposition {
  /** Official transport installed on this same Client Context. */
  readonly transport?: LocalClientTransport
  /** Authenticated Host identity the transport was verified against. */
  readonly host?: LocalInstanceRecord
}

/** A live Client-only bootstrap with its own disposal owner. */
export interface LocalClientHandle {
  /** Fresh snapshot from the official Connection on every read. */
  readonly status: LocalClientStatus
  /**
   * Dispose the Client UI subtree, then the official Client transport, then
   * the Client root. The caller still owns the process seat.
   */
  dispose(): Promise<void>
}

/** Project the authenticated record without the profile path. */
function hostFacts(record: LocalInstanceRecord): LocalClientHostFacts {
  return {
    scopeId: record.scopeId,
    instanceId: record.instanceId,
    hostPid: record.hostPid,
    hostStarttime: record.hostStarttime,
    origin: record.origin,
    protocol: record.protocol,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
  }
}

/**
 * Mount the Client-local subtree on the supplied Client `Context` and report
 * the live status. The caller owns the Context and must dispose this handle
 * before the root; a construction failure unwinds exactly the subtree fibers
 * the shared Client UI runtime mounted and never disposes the root.
 */
export async function startLocalClient(
  context: Context,
  startup: LocalClientStartupFacts,
  processStartIdentity?: string,
  composition: LocalClientComposition = {},
): Promise<LocalClientHandle> {
  if ((composition.transport === undefined) !== (composition.host === undefined)) {
    throw new Error('local client entry: the official transport and the authenticated Host must be supplied together')
  }
  let ui: RemoteClientUiRuntime
  try {
    ui = await createRemoteClientUiRuntime({ context, startup })
  } catch (error) {
    // The UI runtime already unwound the fibers it mounted. The Client root and
    // the official transport belong to the caller.
    throw error
  }
  const extensionService = context.get(PI_TUI_EXTENSIONS_SERVICE)
  if (extensionService === undefined) {
    await ui.dispose()
    throw new Error('local client entry: the Client-local extension host did not publish piTuiExtensions')
  }
  const { transport, host } = composition
  let disposed = false
  const startupFacts = {
    ...(startup.sessionId === undefined ? {} : { sessionId: startup.sessionId }),
    ...(startup.presetId === undefined ? {} : { presetId: startup.presetId }),
  }
  return {
    get status(): LocalClientStatus {
      const base = {
        processRole: 'client' as const,
        pid: process.pid,
        ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
        phase: 'client-local-ready' as const,
        sessionOpen: false as const,
        fiberOwner: 'client-root' as const,
        ...(context.fiber.uid == null ? {} : { rootFiberUid: context.fiber.uid }),
        extensionService: { present: true as const },
        startupFacts,
        ...(host === undefined ? {} : { host: hostFacts(host) }),
      }
      if (transport === undefined) {
        return { ...base, transport: 'not-connected' as const }
      }
      const observed = transport.status()
      return {
        ...base,
        transport: observed.transport,
        ...(observed.generationId === undefined ? {} : { generationId: observed.generationId }),
        ...(observed.hostHome === undefined ? {} : { hostHome: observed.hostHome }),
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      try {
        await ui.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        await transport?.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        await context.fiber.dispose()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 0) return
      const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
      for (const secondary of errors.slice(1)) mergeCause(primary, secondary)
      throw primary
    },
  }
}
