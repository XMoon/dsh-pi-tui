/**
 * Phase 3 tests (plan §16): the UNSTABLE raw input stage inside the host's
 * input path (BEFORE protocol decoding) and the emergency fail-safe
 * (triple-Esc, not rewritable by captures). The real low-level component
 * contract lives in pi-component-compat.test.ts.
 * @module @xmoon76/dsh-pi-tui/unstable-interactive.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { UnstableInputRegistry } from '../src/extension/internal/unstable-input.ts'
import type { UnstableRawInputEvent } from '../src/extension/unstable-types.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const startedApps = new Set<DisposableApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A TuiApp with the unstable raw route wired to a fresh registry. */
async function appWithUnstableRoute() {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new UnstableInputRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    unstableInputRoute: (data, surfaceId) => registry.route({ data, surfaceId }),
    unstableInputsLive: () => registry.hasAny(),
    unstableInputsRevision: () => registry.revisionOf(),
    unstableFailSafeRelease: () => registry.disposeAll(),
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  return { vt, app, registry }
}

/** A recording raw capture. */
function rawCapture(id: string, decide?: (data: string) => boolean | 'rewrite') {
  const events: UnstableRawInputEvent[] = []
  return {
    events,
    spec: {
      id,
      handle: (event: UnstableRawInputEvent) => {
        events.push(event)
        if (decide === undefined) return undefined
        const outcome = decide(event.data)
        if (outcome === true) return { action: 'consume' as const }
        if (outcome === 'rewrite') return { action: 'rewrite' as const, data: 'REWRITTEN' }
        return undefined
      },
    },
  }
}

test('raw stage: a consuming capture stops the chunk BEFORE the host sees it', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const capture = rawCapture('consume-all', () => true)
  registry.register(capture.spec, 'owner')
  // A key the host would normally route to the editor.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), '', 'the consumed chunk never reached the editor')
  assert.equal(capture.events.length, 1)
  assert.equal(capture.events[0]?.data, 'x')
  app.stop()
})

test('raw stage: a rewrite replaces the chunk for the Host decoder', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  // Rewrite 'a' into 'REWRITTEN' — the editor must receive the replacement.
  const capture = rawCapture('rewrite-a', (data) => data === 'a' ? 'rewrite' : false)
  registry.register(capture.spec, 'owner')
  vt.sendInput('a')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'REWRITTEN', 'the editor received the REWRITTEN chunk')
  app.stop()
})

test('raw stage: a passing capture lets the chunk continue to the host', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const capture = rawCapture('pass-all')
  registry.register(capture.spec, 'owner')
  vt.sendInput('y')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'y', 'a passing capture lets the host receive the chunk')
  app.stop()
})

test('raw stage: protocol artifacts are visible to raw captures (pre-decode)', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const capture = rawCapture('spy')
  registry.register(capture.spec, 'owner')
  // A Kitty release event: the host filters it AFTER the raw stage, so a
  // raw capture sees it.
  vt.sendInput('\x1b[1;1:3u')
  await vt.waitForRender()
  assert.equal(capture.events.length, 1, 'the raw capture saw the release event')
  assert.equal(capture.events[0]?.data, '\x1b[1;1:3u')
  app.stop()
})

test('emergency fail-safe: triple-Esc releases every capture even when one consumes everything', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const capture = rawCapture('consume-all', () => true)
  registry.register(capture.spec, 'owner')
  // The capture consumes everything — including Esc presses.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The third Esc within the window triggers the fail-safe: the captures
  // are released and the chunk is consumed by the HOST.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(registry.hasAny(), false, 'the fail-safe released every capture')
  // Host input is restored: a normal key reaches the editor now.
  vt.sendInput('z')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'z', 'host input is restored after the fail-safe')
  app.stop()
})

test('emergency fail-safe: the first two Esc presses pass through (a plugin surface may use Esc)', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const seen: string[] = []
  registry.register({
    id: 'spy',
    mode: 'observe',
    handle: (event) => { seen.push(event.data) },
  }, 'owner')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(seen.length, 2, 'the first two Esc presses reached the captures')
  assert.equal(registry.hasAny(), true, 'no release before the third Esc')
  app.stop()
})

test('emergency fail-safe: not armed while no capture is live (ordinary Esc behavior unchanged)', async () => {
  const { vt, app } = await appWithUnstableRoute()
  // No captures: three Esc presses must NOT trigger a release (there is
  // nothing to release) and must not be consumed by the fail-safe.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The host's own Esc handling still works (no crash, no consumption
  // assertion — the app remains responsive).
  vt.sendInput('q')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'q')
  app.stop()
})

test('emergency fail-safe: CSI-u Esc release/repeat events never count as presses (round-2 finding)', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const capture = rawCapture('c', () => true)
  registry.register(capture.spec, 'owner')
  // Two real Esc presses.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // A CSI-u Esc RELEASE and REPEAT arrive (Kitty flag-2 encodings): they
  // match matchesKey('escape') but must NOT count toward the triple.
  vt.sendInput('\x1b[27;1:3u')
  await vt.waitForRender()
  vt.sendInput('\x1b[27;1:2u')
  await vt.waitForRender()
  assert.equal(registry.hasAny(), true, 'release/repeat events did not trigger the fail-safe')
  // One more real press completes the triple (2 presses + 1 press).
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(registry.hasAny(), false, 'three real presses trigger the fail-safe')
  app.stop()
})

test('emergency fail-safe: stale Esc presses from a released capture session never count (round-1 finding)', async () => {
  const { vt, app, registry } = await appWithUnstableRoute()
  const capture = rawCapture('c', () => true)
  registry.register(capture.spec, 'owner')
  // Two Esc presses while the capture is live.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  // The capture is released (owner unload / fail-safe path) and a NEW
  // capture registers within the window — the stale pair must NOT make
  // the next Esc count as the third press.
  registry.disposeAll()
  registry.register(rawCapture('c2', () => true).spec, 'owner')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(registry.hasAny(), true, 'the fail-safe did not fire on the stale pair')
  // Two MORE Esc presses within the window DO trigger it (three fresh
  // presses at the new capture-session revision).
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(registry.hasAny(), false, 'three fresh Esc presses trigger the fail-safe')
  app.stop()
})
