/**
 * PR3-B B2 round 3: the PiTui-side busy-parity CONTROL for the Direct TSP
 * matrix (`tern-tsp-direct-admission`).
 *
 * The review's qualification: the SAME persisted preference × the SAME two
 * gestures, on the OTHER renderer, through the SAME authorities — the real
 * `applyRunner` composition reading the real volatile `busyEnter` config, and
 * the Direct writer's delivery observed at the PRODUCER (`followup`/`steer`
 * on the live stand-in agent, exactly the authority `submit-hot-path`'s
 * integration cases read). PiTui mounts over the virtual process terminal, so
 * the comparison isolates the renderer variable: everything below the input
 * gesture is the identical production path the TSP matrix drives.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-busy-parity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** Drain microtasks/timers until `ready` or the deadline (load-tolerant). */
async function drainUntil(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ready()) return true
    if (Date.now() >= deadline) return false
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

for (const busyEnter of ['queue', 'steer'] as const) {
  for (const gesture of ['enter', 'accelerated'] as const) {
    test(`B2 parity/PiTui: a ${gesture === 'enter' ? 'plain Enter' : 'Ctrl+Enter'} into a RUNNING turn takes the ${gesture === 'enter' ? 'configured' : 'OPPOSITE'} busyEnter=${busyEnter}`, async (t) => {
      const { testLifecycle } = await import('./support/temp-lifecycle.ts')
      const life = testLifecycle(t)
      const home = life.tempDir('b2-parity-pitui-')
      const previousHome = process.env.DSH_HOME
      process.env.DSH_HOME = home
      life.defer(() => {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
      })
      const { Context } = await import('@deepseek-ai/cordis')
      const { makeHarness, mountRunner, installVirtualProcessTerminal } = await import('./support/runner-harness.ts')
      const { VirtualTerminal } = await import('./virtual-terminal.ts')
      const { TuiApp } = await import('../src/tui-app.ts')
      const vt = new VirtualTerminal(100, 24)
      const restoreTerminal = installVirtualProcessTerminal(vt)
      life.defer(restoreTerminal)

      const harness = makeHarness(home)
      harness.promptAcceptance.value = true
      const ctx = new Context()
      // The mounted-app probe, armed BEFORE the runner fiber (the same shape
      // every Direct runner suite uses).
      let app: unknown
      const originalStart = TuiApp.prototype.start
      TuiApp.prototype.start = function patchedStart(this: unknown) {
        app = this
        return originalStart.call(this)
      }
      try {
        const fiber = await mountRunner(ctx, home, harness, {}, { busyEnter })
        life.defer(() => { void fiber.dispose() })
        assert.ok(app !== undefined, 'the production runner mounted a TuiApp')
        const editor = (app as unknown as { setDraft(text: string): void; submitDraft(request?: string): void; getDraft(): string })
        // Warm-up: the first submit ensures the deferred session + its live
        // agent (the same shape the TSP matrix's first prompt has).
        editor.setDraft('warm up')
        editor.submitDraft()
        assert.equal(await drainUntil(() => harness.delivered.length === 1, 5_000), true,
          'the warm-up submission committed (the deferred session exists)')
        // The BUSY window: the live agent reports running, exactly the state
        // the TSP matrix's held model stream produces.
        for (const agent of harness.liveAgents()) agent.status = 'running'
        const text = `parity ${busyEnter} ${gesture}`
        editor.setDraft(text)
        editor.submitDraft(gesture)
        assert.equal(await drainUntil(() => harness.delivered.length === 2, 5_000), true,
          'the busy submission delivered')
        const second = harness.delivered[1]!
        const expected: 'queue' | 'steer' = gesture === 'enter'
          ? busyEnter
          : busyEnter === 'queue' ? 'steer' : 'queue'
        assert.equal(second.mode, expected,
          `PiTui ${gesture} into a running turn delivered as ${expected} (busyEnter=${busyEnter}) — the SAME delivery the TSP matrix observes`)
        assert.equal(harness.delivered.length, 2, 'exactly two writes total (one warm-up, one busy)')
      } finally {
        TuiApp.prototype.start = originalStart
      }
    })
  }
}
