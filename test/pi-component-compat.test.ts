/**
 * Issue #26 Gate A: the real Pi custom-component contract on a live TuiApp.
 *
 * These tests deliberately use the repository's real VirtualTerminal and
 * TuiApp surface. They cover the observable low-level contract without
 * introducing a second fake mountComponent implementation.
 * @module @xmoon76/dsh-pi-tui/pi-component-compat.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { UnstableMountedComponent } from '../src/extension/unstable-types.ts'

interface RealSurface {
  vt: import('./virtual-terminal.ts').VirtualTerminal
  app: import('../src/tui-app.ts').TuiApp
  handle: ReturnType<import('../src/tui-app.ts').TuiApp['unstableSurfaceHandle']>
}

interface ComponentState {
  renderWidths: number[]
  inputs: string[]
  disposeCount: number
  revision?: number
}

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
}

function viewportText(vt: RealSurface['vt']): string {
  return vt.getViewport().map(stripAnsi).join('\n')
}

async function realSurface(columns = 80, rows = 24): Promise<RealSurface> {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  return { vt, app, handle: app.unstableSurfaceHandle() }
}

function recordingComponent(state: ComponentState, lines = ['PI_COMPONENT_COMPAT_READY']): UnstableMountedComponent {
  return {
    render: (width) => {
      state.renderWidths.push(width)
      return [...lines, `PI_COMPONENT_COMPAT_WIDTH=${width}`, `PI_COMPONENT_COMPAT_REVISION=${state.revision ?? 0}`]
    },
    handleInput: (data) => {
      state.inputs.push(data)
    },
    dispose: () => {
      state.disposeCount += 1
    },
  }
}

test('Pi component contract: real surface exposes geometry and mounts raw render/input', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  try {
    assert.notEqual(handle.surfaceId, 'inert', 'a live surface handle must expose a non-inert surface id')
    assert.ok(handle.width > 0, 'a live surface handle must expose a positive width')
    assert.ok(handle.height > 0, 'a live surface handle must expose a positive height')
    assert.ok(handle.generation > 0, 'a live surface handle must expose a positive generation')
    assert.equal(handle.width, 80, 'surface width must expose the real terminal width')
    assert.equal(handle.height, 24, 'surface height must expose the real terminal height')
    assert.equal(handle.generation, app.getSurfaceGeneration(), 'surface handle generation must match the live TuiApp')

    const lease = handle.mountComponent(recordingComponent(state))
    try {
      assert.equal(lease.active, true, 'a live component mount must return an active lease')
      assert.equal(lease.focused, true, 'a capturing component mount must own focus')
      await vt.waitForRender()
      const view = viewportText(vt)
      assert.ok(view.includes('PI_COMPONENT_COMPAT_READY'), `real TuiApp must present the component output:\n${view}`)
      assert.ok(state.renderWidths.some(width => width > 0), 'render(width) must receive a positive host width')

      vt.sendInput('r')
      await vt.waitForRender()
      assert.deepEqual(state.inputs, ['r'], 'focused mounts must receive the raw input chunk unchanged')
      assert.equal(app.seatTextForTest(), '', 'focused mount input must not be delivered to the host editor as well')

      const rendersBeforeInvalidate = state.renderWidths.length
      state.revision = 1
      lease.invalidate()
      await vt.waitForRender()
      assert.ok(state.renderWidths.length > rendersBeforeInvalidate, 'lease.invalidate must repaint the mounted component')
      assert.ok(viewportText(vt).includes('PI_COMPONENT_COMPAT_REVISION=1'), 'invalidate must present the component state from the new render')

      const rendersBeforeRequest = state.renderWidths.length
      handle.requestRender()
      await vt.waitForRender()
      assert.ok(state.renderWidths.length > rendersBeforeRequest, 'surface.requestRender must repaint the mounted component')
    } finally {
      lease.close()
    }
  } finally {
    app.dispose()
  }
})

test('Pi component contract: resize propagates fresh geometry to render(width)', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  const lease = handle.mountComponent(recordingComponent(state))
  try {
    await vt.waitForRender()
    const initialWidth = state.renderWidths.at(-1)
    assert.ok(initialWidth !== undefined && initialWidth > 0, 'the initial component render must receive a positive width')

    vt.resize(100, 30)
    await vt.waitForRender()
    const resizedWidth = state.renderWidths.at(-1)
    assert.equal(handle.width, 100, 'surface width must follow a real terminal resize')
    assert.equal(handle.height, 30, 'surface height must follow a real terminal resize')
    assert.ok(resizedWidth !== undefined && resizedWidth > 0, 'the resized component render must receive a positive width')
    assert.notEqual(resizedWidth, initialWidth, 'a terminal resize must deliver fresh component geometry')
  } finally {
    lease.close()
    app.dispose()
  }
})

test('Pi component contract: explicit overlay width remains authoritative after resize', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  const lease = handle.mountComponent(recordingComponent(state), { width: 40 })
  try {
    await vt.waitForRender()
    assert.equal(state.renderWidths.at(-1), 40, 'an explicit mount width must be honored')

    vt.resize(100, 30)
    await vt.waitForRender()
    assert.equal(handle.width, 100, 'the surface itself must still report the resized terminal')
    assert.equal(state.renderWidths.at(-1), 40, 'an explicit mount width must remain fixed after resize')
  } finally {
    lease.close()
    app.dispose()
  }
})

test('Pi component contract: blur releases input, focus restores it, and hide/show preserves the lease', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  const lease = handle.mountComponent(recordingComponent(state))
  try {
    await vt.waitForRender()
    lease.blur()
    assert.equal(lease.focused, false, 'blur must release component focus')
    vt.sendInput('b')
    await vt.waitForRender()
    assert.deepEqual(state.inputs, [], 'a blurred component must not receive editor input')
    assert.equal(app.seatTextForTest(), 'b', 'blurred input must return to the host editor')

    lease.focus()
    assert.equal(lease.focused, true, 'focus must restore component focus')
    vt.sendInput('f')
    await vt.waitForRender()
    assert.deepEqual(state.inputs, ['f'], 'a focused component must receive input again')

    lease.hide()
    await vt.waitForRender()
    assert.equal(lease.active, true, 'hide must keep the component lease active')
    assert.ok(!viewportText(vt).includes('PI_COMPONENT_COMPAT_READY'), 'hidden components must not remain visible')

    lease.show()
    await vt.waitForRender()
    assert.equal(lease.active, true, 'show must keep the same component lease active')
    assert.ok(viewportText(vt).includes('PI_COMPONENT_COMPAT_READY'), 'show must restore the component presentation')
  } finally {
    lease.close()
    app.dispose()
  }
})

test('Pi component contract: close is idempotent and dispose runs exactly once', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  const lease = handle.mountComponent(recordingComponent(state))
  try {
    await vt.waitForRender()
    lease.close()
    lease.close()
    assert.equal(lease.active, false, 'close must make the mount inactive')
    assert.equal(state.disposeCount, 1, 'repeated close must dispose the component exactly once')
    assert.equal(app.ownedUnstableMountLeasesForTest(), 0, 'closed mounts must leave the host lease set')

    app.dispose()
    assert.equal(state.disposeCount, 1, 'surface disposal must not dispose an already closed component again')
  } finally {
    app.dispose()
  }
})

test('Pi component contract: fullscreen migration preserves one live adapter across repeated toggles', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  const lease = handle.mountComponent(recordingComponent(state, ['PI_COMPONENT_FULLSCREEN_READY']))
  try {
    await vt.waitForRender()
    for (let toggle = 0; toggle < 3; toggle += 1) {
      app.setFullscreen(true)
      await vt.waitForRender()
      assert.ok(viewportText(vt).includes('PI_COMPONENT_FULLSCREEN_READY'), `mount missing after fullscreen entry #${toggle}`)
      assert.equal(app.unstableMountAdaptersForTest(), 1, `fullscreen entry #${toggle} must retain exactly one live adapter`)

      app.setFullscreen(false)
      await vt.waitForRender()
      assert.ok(viewportText(vt).includes('PI_COMPONENT_FULLSCREEN_READY'), `mount missing after fullscreen exit #${toggle}`)
      assert.equal(app.unstableMountAdaptersForTest(), 1, `fullscreen exit #${toggle} must retain exactly one live adapter`)
    }
    lease.close()
    assert.equal(app.unstableMountAdaptersForTest(), 0, 'closing after fullscreen migration must remove the live adapter')
    assert.equal(state.disposeCount, 1, 'closing after fullscreen migration must dispose the component once')
  } finally {
    lease.close()
    app.dispose()
  }
})

test('Pi component contract: final surface disposal makes old handles inert', async () => {
  const { vt, app, handle } = await realSurface()
  const state: ComponentState = { renderWidths: [], inputs: [], disposeCount: 0 }
  const lease = handle.mountComponent(recordingComponent(state, ['PI_COMPONENT_STALE_READY']))
  try {
    await vt.waitForRender()
    const rendersBeforeDispose = state.renderWidths.length
    app.dispose()

    assert.equal(lease.active, false, 'surface disposal must close every live component lease')
    assert.equal(state.disposeCount, 1, 'surface disposal must dispose the component')
    assert.equal(app.ownedUnstableMountLeasesForTest(), 0, 'surface disposal must clear the host lease set')

    handle.requestRender()
    const staleLease = handle.mountComponent(recordingComponent(state, ['PI_COMPONENT_MUST_NOT_MOUNT']))
    staleLease.focus()
    staleLease.blur()
    staleLease.hide()
    staleLease.show()
    staleLease.invalidate()
    staleLease.close()
    await vt.waitForRender()

    assert.equal(staleLease.active, false, 'a stale surface handle must return an inert mount lease')
    assert.equal(state.renderWidths.length, rendersBeforeDispose, 'stale handles must not render after final disposal')
    assert.equal(state.disposeCount, 1, 'a late stale mount must not create a second component disposal')
  } finally {
    app.dispose()
  }
})

test('Pi component contract: render and input exceptions do not break host lifecycle', async () => {
  const { vt, app, handle } = await realSurface()
  let renderCalls = 0
  let inputCalls = 0
  const lease = handle.mountComponent({
    render: () => {
      renderCalls += 1
      throw new Error('compatibility render failure')
    },
    handleInput: () => {
      inputCalls += 1
      throw new Error('compatibility input failure')
    },
  })
  try {
    await vt.waitForRender()
    assert.ok(renderCalls > 0, 'the host must attempt to render the mounted component')
    assert.doesNotThrow(() => vt.sendInput('x'), 'a throwing component input handler must be isolated by the host')
    await vt.waitForRender()
    assert.equal(inputCalls, 1, 'the throwing input handler must still be invoked once')

    lease.close()
    vt.sendInput('h')
    await vt.waitForRender()
    assert.equal(app.seatTextForTest(), 'h', 'the host editor must remain usable after component failures')
  } finally {
    lease.close()
    app.dispose()
  }
})
