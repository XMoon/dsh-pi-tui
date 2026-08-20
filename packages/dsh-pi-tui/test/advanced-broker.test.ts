/**
 * Phase 4 tests (plan §12/§17): the ADVANCED imperative UI broker —
 * select/confirm/input/notify/custom — built on the Host's own picker,
 * question flow and notify infrastructure; fiber cancellation, surface
 * disposal settlement, and throwing-factory isolation.
 * @module @xmoon76/dsh-pi-tui/advanced-broker.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

async function appWithBroker() {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  return { vt, app }
}

test('select: resolves with the picked value; Esc cancels to undefined', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const promise = broker.select({
    items: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
    header: 'Pick one',
  })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Pick one'), `picker header missing:\n${view}`)
  // ↓ moves to Beta, Enter picks it.
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  const picked = await promise
  assert.equal(picked, 'b')
  // Esc cancels to undefined.
  const cancelled = broker.select({ items: [{ value: 'a', label: 'Alpha' }] })
  await vt.waitForRender()
  vt.sendInput('\x1b')
  assert.equal(await cancelled, undefined)
  app.stop()
})

test('select: an abort signal resolves undefined and closes the picker', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const controller = new AbortController()
  const promise = broker.select({
    items: [{ value: 'a', label: 'Alpha' }],
    signal: controller.signal,
  })
  await vt.waitForRender()
  controller.abort()
  assert.equal(await promise, undefined)
  // The picker overlay is gone.
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'the aborted picker closed')
  app.stop()
})

test('confirm: Yes/No resolve the choice; cancel resolves false', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const yes = broker.confirm({ question: 'Proceed?', approveLabel: 'Go', rejectLabel: 'Stop' })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Proceed?'), `question missing:\n${view}`)
  // Enter picks the first option (Go), then Enter submits on the review
  // page.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.equal(await yes, true)
  // The reject option resolves false.
  const no = broker.confirm({ question: 'Again?', approveLabel: 'Go', rejectLabel: 'Stop' })
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.equal(await no, false)
  app.stop()
})

test('input: resolves with the free text; cancel resolves undefined', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const promise = broker.input({ question: 'Your name?' })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Your name?'), `question missing:\n${view}`)
  // Type into the free-text row, commit, then submit on the review page.
  vt.sendInput('Ada')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.equal(await promise, 'Ada')
  app.stop()
})

test('notify: shows a transient notice (bounded, no raw ANSI)', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  broker.notify('hello from the broker', { type: 'info' })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('hello from the broker'), `notice missing:\n${view}`)
  app.stop()
})

test('custom: resolves with the done() result; close resolves undefined', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const promise = broker.custom((host) => ({
    render: () => ({ kind: 'text', spans: [{ text: 'custom panel' }] }),
    handleInput: (event) => {
      if (event.kind === 'key' && event.key.key === 'd') host.done('result-42')
      if (event.kind === 'key' && event.key.key === 'c') host.close()
      return true
    },
  }))
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('custom panel'), `custom surface missing:\n${view}`)
  vt.sendInput('d')
  assert.equal(await promise, 'result-42')
  // close resolves undefined.
  const closed = broker.custom((host) => ({
    render: () => ({ kind: 'text', spans: [{ text: 'x' }] }),
    handleInput: (event) => {
      if (event.kind === 'key' && event.key.key === 'c') host.close()
      return true
    },
  }))
  await vt.waitForRender()
  vt.sendInput('c')
  assert.equal(await closed, undefined)
  app.stop()
})

test('custom: a throwing factory is isolated (resolves undefined, host keeps working)', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const promise = broker.custom(() => {
    throw new Error('factory boom')
  })
  assert.equal(await promise, undefined)
  // The host still works.
  vt.sendInput('q')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'q')
  app.stop()
})

test('the surface dispose settles every still-open broker promise', async () => {
  const { vt, app } = await appWithBroker()
  const broker = app.advancedUiBroker()
  const select = broker.select({ items: [{ value: 'a', label: 'Alpha' }] })
  await vt.waitForRender()
  const custom = broker.custom(() => ({
    render: () => ({ kind: 'text', spans: [{ text: 'x' }] }),
  }))
  await vt.waitForRender()
  app.dispose()
  assert.equal(await select, undefined, 'dispose settles the pending select')
  assert.equal(await custom, undefined, 'dispose settles the pending custom')
})
