/**
 * PR-D: an HMR/early exit during the TSP SDK handshake after a startup resume
 * must release the CONNECTED renderer and retire the resumed Direct owner
 * exactly once, without mounting PiTui.
 *
 * PRODUCTION PREREQUISITES REPRODUCED:
 *   the real runner composition, real SurfaceRuntime/SurfaceLifecycle/ExitController,
 *   the real production TSP connector (`connectTspRenderer` + the shipped SDK),
 *   and the scripted pane as the process tty.
 * TEST STAND-INS / SUBSTITUTIONS:
 *   the Direct Agent/Session fixture (retirement event recorder); the SDK tty is
 *   a scripted pane. The lifecycle under test (acquisition/release/retirement)
 *   is the production implementation, not a stand-in.
 * DELIBERATELY ABSENT:
 *   a physical terminal/Tern GUI and a real provider.
 * EVIDENCE LIMIT:
 *   headless SDK wire proves protocol/client and application teardown, NOT a
 *   physical GUI's visual/input behavior.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  disposeContext,
  fakeSession,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
} from '../support/runner-harness.ts'
import { installProbe } from '../support/runner-session-fixtures.ts'
import { installTspPane } from '../support/tsp-terminal-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${label}: timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
}

test('an exit during the TSP SDK handshake after a resume releases the renderer and retires the owner once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-prd-resume-handshake-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const pane = installTspPane({})
  life.defer(() => pane.restore())
  const previousRenderer = process.env.DSH_PI_TUI_RENDERER
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  life.defer(() => {
    if (previousRenderer === undefined) delete process.env.DSH_PI_TUI_RENDERER
    else process.env.DSH_PI_TUI_RENDERER = previousRenderer
  })
  pane.queueWithHandshake('\u0004')
  const probe = installProbe()
  life.defer(probe.restore)

  const resumed: FakeSession = fakeSession({
    id: 'prd-resume-handshake',
    header: { id: 'prd-resume-handshake', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  const context = new Context()
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  life.defer(() => disposeContext(context))
  let appExitCalls = 0
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => { appExitCalls += 1 })

  // The production connector reached the SDK DA1 probe; the queued Ctrl+D is
  // decoded in the SAME handshake batch and the legal early-exit gesture runs
  // while the tty is still owned by the acquisition stage.
  await waitUntil(() => pane.probed(), 'the SDK handshake probe')
  await waitUntil(() => appExitCalls === 1, 'the early-exit gesture')
  assert.equal(probe.apps.length, 0, 'no PiTui surface is mounted while the SDK handshake owns the tty')

  // The already-running teardown transaction completes against the inert
  // acquisition stage; it must release the acquired renderer, not mount it.
  await disposeContext(context)
  await settle() // bounded microtask drain, not a wall-clock wait

  assert.equal(probe.apps.length, 0, 'the cancelled startup never starts a PiTui fallback')
  assert.equal(pane.closeFrames(), 1, 'the acquired SDK session is released exactly once')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === `cancel:${resumed.id}`).length, 1, 'the resumed owner is cancelled exactly once')
  assert.equal(events.filter(event => event === `dispose:${resumed.id}`).length, 1, 'the resumed owner is disposed exactly once')
  assert.equal(events.filter(event => event === `flush:${resumed.id}`).length, 1, 'the resumed owner is flushed exactly once')
})
