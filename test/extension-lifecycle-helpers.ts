/**
 * Shared helper: mount the REAL extension service (startup + extension
 * host) in a fresh Cordis tree and dispose it. Used by the API-surface
 * tests that must assert against the implementation, not locally
 * fabricated metadata.
 * @module test/extension-lifecycle-helpers
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { apply as applyExtensionHost } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'

/** The public service surface the api() contract tests read. */
export interface RealExtensionServiceLike {
  api(): { apiVersion: number; hostVersion: string; capabilities: ReadonlySet<string>; deprecations: ReadonlyMap<string, string> }
  register<T>(slot: string, spec: { id: string; order?: number; description?: string }, value: T): {
    id: string
    replace(next: T): void
    dispose(): void
  }
}

/** Mount startup + extension host; returns the service + a disposer. */
export async function mountRealService(): Promise<{ service: RealExtensionServiceLike; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const startupFiber = ctx.plugin((c) => {
    c.provide(TUI_STARTUP_SERVICE, {})
  })
  await startupFiber
  const hostFiber = ctx.plugin(applyExtensionHost)
  await hostFiber
  const service = ctx.get('piTuiExtensions') as unknown as RealExtensionServiceLike
  return {
    service,
    dispose: async () => {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
      }
    },
  }
}
