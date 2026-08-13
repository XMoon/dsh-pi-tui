/**
 * Headless tests for the TUI application core: a virtual xterm drives the
 * surface exactly like a real TTY, so rendering and input routing are
 * verified without a terminal or a model connection.
 * @module @dsh-pi-tui/tui-app/tui-app.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp; submitted: string[]; get exits(): number } {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => { exits += 1 },
  })
  app.start()
  // `exits` is a number: returning it by value would copy 0, so expose a getter.
  return { vt, app, submitted, get exits(): number { return exits } }
}

test('renders the header and the editor frame', async () => {
  const { vt } = startApp()
  await vt.waitForRender()
  const viewport = vt.getViewport().join('\n')
  assert.ok(viewport.includes('dsh-pi-tui'), `header missing from viewport:\n${viewport}`)
  assert.ok(viewport.includes('─'), `editor border missing from viewport:\n${viewport}`)
})

test('submits editor content to the onSubmit event', async () => {
  const { vt, submitted } = startApp()
  await vt.waitForRender()
  vt.sendInput('hello')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello'])
})

test('ctrl+c triggers the exit event', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
})
