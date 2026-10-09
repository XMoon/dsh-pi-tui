/**
 * The shared no-op display seam for suites that drive owners which COMMIT
 * display facts but assert on the fold/window/status state rather than on the
 * rendered output.
 *
 * `session-presentation`, `status-runtime` and `viewer-runtime` all commit
 * through the renderer-neutral `SurfaceDisplaySeam`. A suite that hand-builds a
 * partial surface therefore fails with a bare `TypeError: Cannot read
 * properties of undefined (reading '<seam method>')` from the first commit —
 * indistinguishable from a production wiring bug. This stub declares the WHOLE
 * seam once, so a suite replaces only the fact it actually observes.
 *
 * Use it for state-level suites. Suites that verify the seam CONTRACT itself
 * (the renderer adapters, the TSP mapper) keep their own recording
 * implementation.
 * @module test/support/display-seam-stub
 */

import type { SurfaceDisplaySeam } from '../../src/app/surface/display-seam.ts'

/** Every seam member as a no-op; `overrides` supplies the facts a suite reads. */
export function displaySeamStub(overrides: Partial<SurfaceDisplaySeam> = {}): SurfaceDisplaySeam {
  return {
    setTranscript: () => {},
    commitStatusFacts: () => {},
    commitDisplaySubject: () => {},
    resetSessionFacts: () => {},
    beginSessionHydration: () => {},
    clearActiveDraft: () => {},
    resetInputHistory: () => {},
    setSearchResult: () => {},
    notify: () => {},
    setDockNotice: () => {},
    setWelcomeCard: () => {},
    setWelcomeIdle: () => {},
    setTerminalCwd: () => {},
    setPendingInputPresentation: () => {},
    getSessionTitle: () => '',
    getViewerGeneration: () => 0,
    supportsTaskCenter: true,
    supportsViewer: true,
    supportsModals: true,
    ...overrides,
  }
}
