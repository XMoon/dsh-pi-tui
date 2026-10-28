/**
 * Client-only pre-connection bootstrap for the M4-A0 process entry.
 *
 * The official Client runtime (`client-runtime.ts`) requires an explicit Host
 * carrier, and M4-B1 owns the authenticated cross-process transport. A0 must
 * therefore prove only what is real today: a Client-owned Cordis root can mount
 * the Client-local TUI startup facts + extension host + first-party builtins
 * without a Host object, and reports `transport: not-connected` instead of a
 * fabricated session. Nothing here creates or imports a Host runtime.
 *
 * @module app/remote-process/client-bootstrap
 */

import type { Context } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../extensions.ts'
import { createRemoteClientUiRuntime, type RemoteClientUiRuntime } from '../remote/client-ui-runtime.ts'
import { mergeCause } from '../remote/dispose-cause.ts'

/** Client-local startup facts handed to the pre-connection subtree. */
export interface LocalClientStartupFacts {
  readonly sessionId?: string
  readonly presetId?: string
}

/** A live Client-only bootstrap with its own disposal owner. */
export interface LocalClientHandle {
  readonly status: {
    readonly processRole: 'client'
    readonly pid: number
    readonly processStartIdentity?: string
    readonly phase: 'client-local-ready'
    readonly transport: 'not-connected'
    readonly sessionOpen: false
    readonly fiberOwner: 'client-root'
    readonly rootFiberUid?: number
    readonly extensionService: { readonly present: true }
    readonly startupFacts: { readonly sessionId?: string; readonly presetId?: string }
  }
  dispose(): Promise<void>
}

/**
 * Mount the Client-local subtree on the supplied Client `Context` and report
 * the pre-connection facts. The caller owns the Context and must dispose this
 * handle before the root; a construction failure unwinds exactly the subtree
 * fibers the shared Client UI runtime mounted.
 */
export async function startLocalClient(
  context: Context,
  startup: LocalClientStartupFacts,
  processStartIdentity?: string,
): Promise<LocalClientHandle> {
  let ui: RemoteClientUiRuntime
  try {
    ui = await createRemoteClientUiRuntime({ context, startup })
  } catch (error) {
    try {
      await context.fiber.dispose()
    } catch (cleanupError) {
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), cleanupError)
    }
    throw error
  }
  const extensionService = context.get(PI_TUI_EXTENSIONS_SERVICE)
  if (extensionService === undefined) {
    await ui.dispose()
    await context.fiber.dispose()
    throw new Error('local client entry: the Client-local extension host did not publish piTuiExtensions')
  }
  let disposed = false
  const status = {
    processRole: 'client' as const,
    pid: process.pid,
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
    phase: 'client-local-ready' as const,
    transport: 'not-connected' as const,
    sessionOpen: false as const,
    fiberOwner: 'client-root' as const,
    ...(context.fiber.uid == null ? {} : { rootFiberUid: context.fiber.uid }),
    extensionService: { present: true as const },
    startupFacts: {
      ...(startup.sessionId === undefined ? {} : { sessionId: startup.sessionId }),
      ...(startup.presetId === undefined ? {} : { presetId: startup.presetId }),
    },
  }
  return {
    status,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      let firstError: unknown
      try {
        await ui.dispose()
      } catch (error) {
        firstError = error
      }
      try {
        await context.fiber.dispose()
      } catch (error) {
        firstError ??= error
      }
      if (firstError !== undefined) throw firstError
    },
  }
}
