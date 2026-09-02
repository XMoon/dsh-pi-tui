/**
 * Round-2 review regressions: outbound draft paths must carry EXPANDED
 * paste content (steer / getDraft / the external-editor suspend rollback)
 * and the Windows URL launcher must quote transcript-controlled URLs
 * against cmd.exe metacharacter injection.
 * @module @xmoon76/dsh-pi-tui/re-vendor-round2.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { openerFor } from '../src/open-url.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const pasted = Array.from({ length: 12 }, (_, i) => `real line ${i + 1}`).join('\n')

function pasteLarge(vt: VirtualTerminal): void {
  vt.sendInput(`\x1b[200~${pasted}\x1b[201~`)
}

test('steer carries the EXPANDED paste content, never the marker text', async () => {
  const vt = new VirtualTerminal(80, 24)
  const steered: string[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onSteer: (text: string) => steered.push(text) })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.steer': 'ctrl+x' }))
  await vt.waitForRender()
  pasteLarge(vt)
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x — steer
  await vt.waitForRender()
  assert.equal(steered.length, 1)
  assert.ok(steered[0]!.includes('real line 12'), `the steer wire must carry the real paste content: ${steered[0]}`)
  assert.ok(!steered[0]!.includes('[paste #'), 'marker text must never leave the editor context')
  app.stop()
})

test('getDraft returns the EXPANDED wire form after a marker paste', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  pasteLarge(vt)
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.ok(draft.includes('real line 1'), `getDraft must expand markers: ${draft}`)
  assert.ok(!draft.includes('[paste #'))
  app.stop()
})

test('a partially-applied suspend (stop throws mid-way) is rolled back to a running surface', async () => {
  const vt = new VirtualTerminal(80, 24)
  let calls = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: async () => {
      calls += 1
      return 'edited'
    },
    runOwned: (_label, task) => { Promise.resolve(task()).catch(() => {}) },
  })
  app.start()
  await vt.waitForRender()
  const screen = (app as unknown as { tui: { start: () => void; stop: () => void } }).tui
  const originalStop = screen.stop.bind(screen)
  // stop() PARTIALLY applies (the real stop runs and mutates state), then
  // throws — the suspend must be rolled back so the surface keeps running.
  screen.stop = () => {
    originalStop()
    throw new Error('stop exploded mid-way')
  }
  await assert.rejects(app.launchExternalEditor(), /stop exploded/)
  screen.stop = originalStop
  // The surface still runs: a second round-trip succeeds (the latch
  // released AND the resume path works after the rollback).
  await app.launchExternalEditor()
  assert.equal(calls, 1, 'the editor opened exactly once (the failed suspend never opened it)')
  // And input still renders (the screen is live again).
  app.setDraft('hello')
  await vt.waitForRender()
  const view = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  assert.ok(view.includes('hello'), `the surface must still render after the rollback:\n${view}`)
  app.stop()
})

test('openerFor quotes hostile URLs for cmd.exe (Windows injection guard)', () => {
  const hostile = 'https://example.com/?a=1&b=2&c=<pipe>'
  const { command, args } = openerFor(hostile, 'win32')
  assert.equal(command, 'cmd')
  assert.deepEqual(args, ['/c', 'start', '', `"${hostile}"`], 'the URL must ride as ONE quoted token — & must never split commands')
})

test('openerFor passes the URL through on unix platforms', () => {
  assert.deepEqual(openerFor('https://example.com/x', 'darwin'), { command: 'open', args: ['https://example.com/x'] })
  assert.deepEqual(openerFor('https://example.com/x', 'linux'), { command: 'xdg-open', args: ['https://example.com/x'] })
})

const fakeRun = (output: string) => async () => ({ stdout: Buffer.from(output, 'utf8'), stderr: Buffer.alloc(0), code: 0 })

test('readClipboardText preserves a REAL trailing newline on unix backends', async () => {
  const { readClipboardText } = await import('../src/image/clipboard.ts')
  const env = {
    platform: 'darwin',
    env: {} as Record<string, string | undefined>,
    exists: () => true,
  }
  const text = await readClipboardText(fakeRun('kept\n') as never, env)
  assert.equal(text, 'kept\n', 'pbpaste output must survive verbatim (round-3 P2)')
})

test('readClipboardText preserves a REAL trailing newline on Wayland (no --no-newline)', async () => {
  const { readClipboardText } = await import('../src/image/clipboard.ts')
  const env = {
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' } as Record<string, string | undefined>,
    exists: () => true,
  }
  const text = await readClipboardText(fakeRun('kept\n') as never, env)
  assert.equal(text, 'kept\n', 'wl-paste output must survive verbatim (round-4 P2)')
})

test('readClipboardText strips only the SYNTHETIC PowerShell trailing newline', async () => {
  const { readClipboardText } = await import('../src/image/clipboard.ts')
  const env = {
    platform: 'win32',
    env: {} as Record<string, string | undefined>,
    exists: () => true,
  }
  const text = await readClipboardText(fakeRun('line\r\n') as never, env)
  assert.equal(text, 'line', 'Get-Clipboard synthesizes the CRLF — it is not content')
})

test('openKeybindingEditor disposes a NON-Focusable panel on close (round-5 P2)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  let disposeCount = 0
  // A plain Component panel — NOT Focusable — must still be disposed by
  // the owning FocusForwardingFrame when the overlay closes.
  const panel: import('@xmoon76/pi-tui').Component = {
    render: () => ['panel'],
    invalidate: () => {},
    dispose: () => { disposeCount += 1 },
  }
  const close = app.openKeybindingEditor(panel)
  await vt.waitForRender()
  close()
  await vt.waitForRender()
  assert.equal(disposeCount, 1, 'the non-Focusable panel must be disposed exactly once on close')
  app.stop()
})

test('right-click paste lands in the focused editor with `this` intact (round-9 P2)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (_label, task) => { Promise.resolve(task()).catch(() => {}) },
  }, {
    readClipboardText: async () => 'pasted text',
  })
  app.start()
  app.setFullscreen(true)
  await vt.waitForRender()
  // The seat editor owns focus in fullscreen.
  ;(app as unknown as { rightClickPasteFromClipboard(): void }).rightClickPasteFromClipboard()
  await new Promise(resolve => setTimeout(resolve, 30))
  const draft = app.getDraft()
  assert.ok(draft.includes('pasted text'), `the paste must reach the editor draft with a live this:\n${draft}`)
  app.setFullscreen(false)
  await vt.waitForRender()
  app.stop()
})

test('right-click paste is DROPPED when focus moves during the clipboard read (round-9 P2)', async () => {
  const vt = new VirtualTerminal(80, 24)
  let resolveClipboard!: (text: string) => void
  const clipboard = new Promise<string>(resolve => { resolveClipboard = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (_label, task) => { Promise.resolve(task()).catch(() => {}) },
  }, {
    readClipboardText: () => clipboard,
  })
  app.start()
  await vt.waitForRender()
  const handle = app.unstableSurfaceHandle()
  const aInputs: string[] = []
  const bInputs: string[] = []
  const leaseA = handle.mountComponent({
    render: () => ['A'],
    handleInput: (data: string) => { aInputs.push(data) },
  })
  await vt.waitForRender()
  assert.equal(leaseA.focused, true, 'A owns focus (the right-click target)')
  ;(app as unknown as { rightClickPasteFromClipboard(): void }).rightClickPasteFromClipboard()
  // While the clipboard read is pending, focus moves to B.
  const leaseB = handle.mountComponent({
    render: () => ['B'],
    handleInput: (data: string) => { bInputs.push(data) },
  })
  await vt.waitForRender()
  assert.equal(leaseB.focused, true, 'B owns focus now')
  resolveClipboard('X')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(aInputs, [], 'the stale target must never receive the paste')
  assert.deepEqual(bInputs, [], 'the new focus owner must never receive the paste either')
  leaseA.close()
  leaseB.close()
  app.stop()
})
