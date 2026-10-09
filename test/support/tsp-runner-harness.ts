/**
 * The shared "real runner + TSP pane" boot harness (PR3-B B2).
 *
 * Everything the suites built on this helper do runs the REAL composition root
 * (`mountRunner` → `applyRunner` → `startRunner`) with the TSP opt-in over the
 * scripted pane installed as the process tty: the shipped SDK connect,
 * `productionTspConnector`, `selectRendererMount`, `SurfaceRuntime`, the real
 * `SubmissionController` and the Direct Host services all execute for real.
 * Only the tty boundary and the Host stand-in services are simulated.
 *
 * The pane, the Cordis context and the mounted fiber are owned BEFORE the boot,
 * and the real cleanup is registered on the caller's TestLifecycle, so ANY
 * failure path releases a held handshake and only then restores the process
 * streams — never leaving an SDK or a held reply running after the harness.
 * @module @xmoon76/dsh-pi-tui/test/support/tsp-runner-harness
 */

import { installTspPane, type TspPane } from './tsp-terminal-fixture.ts'

export async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Wait a fixed slice so the renderer/application frames can settle. */
export async function settle(millis = 600): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, millis))
}

/** The booted runner's observable surface (the pane + the Direct harness). */
export interface OwnedTspRunner {
  readonly pane: TspPane
  /** The live Direct harness the runner booted with (fixture assertions). */
  readonly harness: {
    readonly createdSessions: ReadonlyArray<{ snapshotEvents(): readonly unknown[] }>
    readonly retirementEvents: readonly string[]
    readonly promptAcceptance: { value: boolean }
  }
  readonly settle: () => Promise<void>
}

/** Mount the REAL runner with the TSP opt-in over the scripted pane. */
export async function ownTspBoot(options: {
  readonly life: import('./temp-lifecycle.ts').TestLifecycle
  readonly home: string
  readonly logFile: string
  readonly session?: { readonly id: string }
  readonly provide?: (ctx: { provide(name: string, value: unknown): void }) => unknown
  readonly shell?: unknown
  readonly appExit?: () => void
  /** Let the Direct writer COMMIT prompts (the harness default is the
   *  historical `session/agent-busy` degradation). */
  readonly acceptPrompts?: boolean
  /** Runs with the owned pane BEFORE the connector can probe it. */
  readonly beforeMount?: (pane: TspPane) => void
}): Promise<OwnedTspRunner> {
  const { makeHarness, mountRunner, disposeContext } = await import('./runner-harness.ts')
  const pane = installTspPane()
  options.beforeMount?.(pane)
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  options.provide?.(ctx)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = options.logFile
  const harness = makeHarness(options.home, options.session as never)
  if (options.shell !== undefined) (harness as { shell?: unknown }).shell = options.shell
  let fiber: { dispose(): Promise<void> } | undefined
  let settlement: Promise<void> | undefined
  const settleAll = (): Promise<void> => {
    settlement ??= (async () => {
      pane.releaseHandshake()
      try {
        await disposeContext(ctx)
        await fiber?.dispose()
      } finally {
        // Restore the process streams/env after the cleanup ATTEMPT, and never
        // swallow a cleanup failure: the caller (and the temp lifecycle) see it.
        pane.restore()
      }
    })()
    return settlement
  }
  // Registered BEFORE the boot and RETURNING the real cleanup promise, so the
  // temp lifecycle AWAITS it.
  options.life.defer(() => settleAll())
  fiber = await mountRunner(
    ctx, options.home, harness,
    options.session === undefined ? {} : { sessionId: options.session.id },
    options.session === undefined ? {} : { sessionId: options.session.id },
    options.appExit ?? (() => {}),
  )
  const owned: OwnedTspRunner = {
    pane,
    harness: harness as unknown as OwnedTspRunner['harness'],
    settle: settleAll,
  }
  if (options.acceptPrompts === true) {
    (harness as unknown as { promptAcceptance: { value: boolean } }).promptAcceptance.value = true
  }
  return owned
}
