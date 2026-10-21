/**
 * The application runtime-selection seam (TS2): pick ONE application runtime
 * core — the Direct assembly adapted through the caller's factory, or the
 * Remote application aggregate loaded through the single sanctioned lazy
 * boundary — and return the transport-neutral `SelectedApplicationRuntime`
 * the session runtime consumes.
 *
 * This module is COMPOSITION ONLY. It does not read Cordis Host services, own
 * Session or TUI state, construct a `SurfaceRuntime`, or build command /
 * submission owners. The Remote reach stays exactly one dynamic edge:
 *
 * ```text
 * runtime/backend-loader.ts -> app/remote/runtime.ts
 * ```
 *
 * and the static `bootstrap zone -> backend-loader` import is the sanctioned
 * edge; the loader's internal dynamic import is not a static Remote edge.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/runtime-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ApplicationRuntimeSelection,
  SelectedApplicationRuntime,
} from '../application-runtime.ts'
import { loadRemoteApplicationRuntime } from '../../runtime/backend-loader.ts'

/**
 * The loader the selection seam uses to reach the Remote aggregate. The
 * production binding is the module-level `loadRemoteApplicationRuntime`
 * (below); the setter exists ONLY for the selection unit suite to inject a
 * counting double — it never changes what the seam OWNS (the canonical
 * backend-loader reach), and no product path calls it.
 */
let loadRemoteApplicationRuntimeForSelection = loadRemoteApplicationRuntime

/** Test-only loader injection for the selection seam; returns the restore. */
export function __setApplicationRuntimeLoaderForTests(
  loader: typeof loadRemoteApplicationRuntime,
): () => void {
  const previous = loadRemoteApplicationRuntimeForSelection
  loadRemoteApplicationRuntimeForSelection = loader
  return () => {
    loadRemoteApplicationRuntimeForSelection = previous
  }
}

/**
 * Select ONE application runtime core. The Direct branch adapts the existing
 * Direct objects WITHOUT semantic change, constructing them through the
 * supplied factory (a Remote selection invokes no Direct factory — plan
 * §10.2). The Remote branch is THIS SEAM's own ownership: it loads the Remote
 * application aggregate through `runtime/backend-loader.ts` (the sole
 * sanctioned dynamic boundary) and composes it with the caller's input — the
 * canonical selection owner, never an arbitrary injected callback. The
 * selected core exposes exactly kind/backend/owners/retirement/
 * disposeTransport; branch-specific capabilities stay branch-specific. There
 * is no user-visible selector: normal package `apply()` selects Direct.
 *
 * Exported for the selection suites only (tests import the seam directly);
 * no public root export re-exports it.
 */
export async function selectApplicationRuntime(
  selection: ApplicationRuntimeSelection,
): Promise<SelectedApplicationRuntime> {
  if (selection.preselected !== undefined) {
    // The internal L6 Remote composition (M3-4 PR2): the caller already
    // built the ONE aggregate through the canonical construction path; the
    // seam adopts its selected core verbatim (identity, never a copy) and
    // constructs nothing — no second Remote graph, no Direct factory call.
    return selection.preselected
  }
  if (selection.kind === 'remote') {
    if (selection.remote === undefined) {
      throw new Error('tui-runner: the Remote application runtime requires the Remote composition input')
    }
    // THE canonical Remote reach (plan §5): this seam — and nothing else in
    // product code — constructs the Remote application runtime, and only
    // through the lazy backend-loader boundary. The static
    // `bootstrap -> backend-loader` import is the sanctioned edge; the
    // loader's internal dynamic import is not a static Remote edge. The
    // prompt serializer crosses as the structural D2.2 dependency the
    // aggregate declares (the neutral selection type keeps this module
    // transport-clean; the cast only restores the aggregate's declared type).
    const { createRemoteApplicationRuntime } = await loadRemoteApplicationRuntimeForSelection()
    const runtime = await createRemoteApplicationRuntime({
      hostContext: selection.remote.hostContext as Context,
      waitForHostPrerequisites: selection.remote.waitForHostPrerequisites,
      signal: selection.remote.signal,
      promptSerializer: selection.remote.promptSerializer as Parameters<typeof createRemoteApplicationRuntime>[0]['promptSerializer'],
      clientUiStartup: selection.remote.clientUiStartup,
    })
    return runtime.selected
  }
  const direct = selection.createDirect()
  return {
    kind: 'direct',
    backend: direct.backend,
    owners: direct.owners,
    retirement: direct.retirement,
    disposeTransport: async (): Promise<void> => {},
  }
}
