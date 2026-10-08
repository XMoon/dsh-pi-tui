/**
 * PR3-A: the ONE experimental renderer selection, extracted from the
 * bootstrap composition root so tests can drive the DECISION (and its
 * fallback/fatal branches) without patching the composition body.
 *
 * Production behaviour is unchanged: `DSH_PI_TUI_RENDERER=tsp` lazily
 * imports the TSP renderer and runs the official SDK connect BEFORE PiTui
 * could take stdin; `null` yields no mount (PiTui); a connect throw
 * propagates to the caller (the runner fatal path).
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/renderer-selection
 */

import type { SurfaceRendererMount } from '../surface/runtime.ts'

/** What the selection needs from the composition root. */
export interface RendererSelectionDeps {
  readonly cwd: string
  /** The exit intent (the TSP quit key routes through the SAME exit path). */
  readonly requestExit: () => void
  /** Diagnostics sink for the selection's own lifecycle facts. */
  readonly log: (message: string, fields?: Record<string, unknown>) => void
  /**
   * The FATAL intent of a mounted renderer failure (the SDK input loop died).
   * The composition root routes it to the runner's fatal lifecycle.
   */
  readonly onFatal: (error: unknown) => void
  /**
   * The lazy TSP connector (the production default imports the renderer
   * module and connects through the official SDK). Tests inject a scripted
   * pane; returning `undefined` mirrors `connect() === null`.
   */
  readonly connectTsp: () => Promise<{
    readonly display: import('../surface/display-seam.ts').SurfaceDisplaySeam
    readonly dispose: () => Promise<void>
  } | undefined>
  /** The environment read (production: `process.env`). */
  readonly env: Record<string, string | undefined>
}

/**
 * Select the renderer once. Returns the mount for `surface.start`, or
 * `undefined` for the unchanged PiTui path.
 */
export async function selectRendererMount(deps: RendererSelectionDeps): Promise<SurfaceRendererMount | undefined> {
  if (deps.env.DSH_PI_TUI_RENDERER !== 'tsp') return undefined
  const tsp = await deps.connectTsp()
  if (tsp === undefined) {
    deps.log('tsp renderer unavailable (SDK declined); mounting PiTui', {})
    return undefined
  }
  deps.log('tsp renderer selected', {})
  // Ownership handshake: `mount()` transfers the SDK session to the surface's
  // ordered disposal; `releaseUnmounted()` closes it when the mount was
  // rejected or never ran (idempotent, and inert after a transfer).
  return {
    mount: () => ({ display: tsp.display, dispose: () => tsp.dispose() }),
    releaseUnmounted: () => tsp.dispose(),
  }
}

/** The PRODUCTION connector inputs: lazy import + the official SDK connect. */
export interface ProductionTspConnectorDeps {
  readonly cwd: string
  readonly requestExit: () => void
  readonly onFatal: (error: unknown) => void
  readonly log: (message: string, fields?: Record<string, unknown>) => void
  readonly logError: (message: string, fields?: Record<string, unknown>) => void
  /**
   * The official SDK connect boundary (`TspRendererOptions.connect`): the
   * production wiring leaves it unset, so the renderer module uses its own
   * shipped `connect`. Tests supply the scripted pane HERE, so the REAL
   * `connectTspRenderer` — and with it the owned-session mount-failure release
   * and its secondary-restoration diagnostics — stays in the path instead of
   * being bypassed by a hand-rolled mount.
   */
  readonly connect?: NonNullable<Parameters<(typeof import('../../tui/tsp/session.ts'))['connectTspRenderer']>[0]['connect']>
}

/** The PRODUCTION connector: lazy import + the official SDK connect. */
export function productionTspConnector(
  deps: ProductionTspConnectorDeps,
): () => Promise<{ readonly display: import('../surface/display-seam.ts').SurfaceDisplaySeam; readonly dispose: () => Promise<void> } | undefined> {
  return async () => {
    const { connectTspRenderer } = await import('../../tui/tsp/session.ts')
    return connectTspRenderer(deps)
  }
}
