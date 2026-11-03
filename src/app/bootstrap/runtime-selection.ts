/**
 * The application runtime-selection seam: adopt the ONE application runtime
 * core the composition root already owns, or construct the Direct one.
 *
 * There is no Remote branch here any more. The retired M3 in-process aggregate
 * is test-only (`test/support/m3-inprocess/`), so a production `kind: 'remote'`
 * without a pre-selected core is a programming error and fails closed instead of
 * silently building a second Host graph. The real internal split Client always
 * passes its FULLY ASSEMBLED core (`preselected`), because its Client process
 * composition root owns the Context, transport and Domain mount.
 *
 * This module is COMPOSITION ONLY. It does not read Cordis Host services, own
 * Session or TUI state, construct a `SurfaceRuntime`, or build command /
 * submission owners.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/runtime-selection
 */

import type {
  ApplicationRuntimeSelection,
  SelectedApplicationRuntime,
} from '../application-runtime.ts'

/**
 * Select ONE application runtime core.
 *
 * - `preselected` wins by identity: the split Client already built its ONE core
 *   through `createRemoteApplicationRuntimeFromClient`, and the seam must never
 *   construct a second graph or copy it.
 * - `kind: 'direct'` adapts the existing Direct objects through the supplied
 *   factory, without semantic change.
 * - any other kind without a pre-selected core fails closed.
 *
 * Exported for the selection suites only; no public root export re-exports it.
 */
export async function selectApplicationRuntime(
  selection: ApplicationRuntimeSelection,
): Promise<SelectedApplicationRuntime> {
  if (selection.preselected !== undefined) return selection.preselected
  if (selection.kind !== 'direct') {
    // Fail closed: the only Remote composition that exists is the internal
    // split Client's pre-assembled core. Building the retired M3 in-process
    // aggregate here would create a second production Host graph.
    throw new Error(
      'tui-runner: no pre-assembled Remote application runtime was provided; '
      + 'the in-process Remote composition is test-only',
    )
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
