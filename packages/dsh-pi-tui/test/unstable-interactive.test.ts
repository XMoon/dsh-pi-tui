/**
 * Phase 3 tests (plan §16): the UNSTABLE raw input stage inside the host's
 * input path (BEFORE protocol decoding), the emergency fail-safe
 * (triple-Esc, not rewritable by captures), and the low-level surface
 * seam (handle + mount lifecycle, fullscreen migration, surface dispose).
 * @module @xmoon76/dsh-pi-tui/unstable-interactive.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { UnstableInputRegistry } from '../src/extension/internal/unstable-input.ts'
import type { UnstableMountedComponent, UnstableRawInputEvent } from '../src/extension/unstable-types.ts'

/** A TuiApp with the unstable raw route wired to a fresh registry. */
async function appWithUnstableRoute() {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new UnstableInputRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    unstableInputRoute: (data, surfaceId) => registry.route({ data, surfaceId }),
    unstableInputsLive: () => registry.hasAny(),
    unstableFailSafeRelease: () => registry.disposeAll(),
  })
  app.start()
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

test('low-level surface handle: geometry + requestRender + mount lifecycle', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const handle = app.unstableSurfaceHandle()
  assert.equal(handle.width, 80)
  assert.equal(handle.height, 24)
  assert.equal(handle.generation, 1)
  // Mount a low-level component: RAW lines render, RAW input forwards.
  const state = { disposed: false, inputs: [] as string[] }
  const component: UnstableMountedComponent = {
    render: (width) => [`raw mount w=${width}`],
    handleInput: (raw) => { state.inputs.push(raw) },
    dispose: () => { state.disposed = true },
  }
  const lease = handle.mountComponent(component)
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('raw mount'), `mount content missing:\n${view}`)
  // RAW input reaches the component (the overlay owns the seat).
  vt.sendInput('r')
  await vt.waitForRender()
  assert.deepEqual(state.inputs, ['r'], 'the raw chunk reached the component')
  // close is idempotent and disposes the component.
  lease.close()
  lease.close()
  assert.equal(state.disposed, true)
  assert.equal(app.ownedUnstableMountLeasesForTest(), 0)
  app.stop()
})

test('low-level surface handle: a throwing render/input is isolated; the host keeps working', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const handle = app.unstableSurfaceHandle()
  const lease = handle.mountComponent({
    render: () => { throw new Error('render boom') },
    handleInput: () => { throw new Error('input boom') },
  })
  await vt.waitForRender()
  vt.sendInput('x')
  await vt.waitForRender()
  lease.close()
  app.stop()
})

test('low-level surface handle: the surface dispose closes every still-owned mount (inert after)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const handle = app.unstableSurfaceHandle()
  const state = { disposed: false }
  const lease = handle.mountComponent({
    render: () => ['x'],
    dispose: () => { state.disposed = true },
  })
  await vt.waitForRender()
  app.dispose()
  lease.show()
  lease.hide()
  lease.focus()
  lease.blur()
  lease.invalidate()
  lease.close() // must not throw
  assert.equal(state.disposed, true, 'dispose disposes the plugin component')
  assert.equal(app.ownedUnstableMountLeasesForTest(), 0)
})

test('low-level surface handle: a mount survives a fullscreen toggle (screen migration)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const handle = app.unstableSurfaceHandle()
  const lease = handle.mountComponent({ render: () => ['fs raw mount'] })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('fs raw mount'), `mount content missing:\n${view}`)
  for (let toggle = 0; toggle < 3; toggle += 1) {
    app.setFullscreen(true)
    await vt.waitForRender()
    view = vt.getViewport().map(strip).join('\n')
    assert.ok(view.includes('fs raw mount'), `mount missing after fullscreen #${toggle}:\n${view}`)
    assert.equal(app.unstableMountAdaptersForTest(), 1, `remount #${toggle} drops the old adapter (no set growth)`)
    app.setFullscreen(false)
    await vt.waitForRender()
    view = vt.getViewport().map(strip).join('\n')
    assert.ok(view.includes('fs raw mount'), `mount missing after fullscreen exit #${toggle}:\n${view}`)
    assert.equal(app.unstableMountAdaptersForTest(), 1, `exit #${toggle} also keeps exactly one adapter`)
  }
  lease.close()
  assert.equal(app.unstableMountAdaptersForTest(), 0, 'close drops the adapter')
  app.stop()
})
