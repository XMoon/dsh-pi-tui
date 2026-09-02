/**
 * Follow-up review P1 gates: the focused-seat derivation and the
 * generation-scoped attachment isolation.
 *
 * Focused seat: `SurfaceSnapshot.focusedSeat` must describe the ACTUAL
 * capturing surface — a transcript-search input, picker, settings panel,
 * approval dialog or question flow all report 'overlay' while they own
 * keyboard focus, and return to 'editor' when closed. The old code only
 * special-cased questions/approvals, so search/picker/settings left a
 * stale 'editor' (the review probe: before/search-open/after all reported
 * editor).
 *
 * Attachment isolation: a `SurfaceHost.dispose()` from an OLD generation
 * must not disable the ledger invalidation sink for a NEWER host attached
 * to the same ledger, and a stale service `detachSurface()` must not tear
 * down a newer generation's bridge.
 * @module @xmoon76/dsh-pi-tui/extension-focus-seat.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Text } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { ExtensionLedger } from '../src/extension/internal/ledger.ts'
import { SurfaceHost } from '../src/extension/internal/surface-host.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** The snapshot surface slice (the focusedSeat field). */
function seatOf(host: SurfaceHost): string {
  return host.state().surface.focusedSeat
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function makeApp(ledger: ExtensionLedger): { vt: VirtualTerminal; app: TuiApp; host: SurfaceHost } {
  const vt = new VirtualTerminal(80, 24)
  const host = new SurfaceHost(ledger, () => app.requestRender())
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host })
  app.start()
  startedApps.add(app)
  return { vt, app, host }
}

/** Attach the host exactly like the runner does (one surface generation). */
function attach(host: SurfaceHost): void {
  host.attach({ header: new Text('', 0, 0), dock: new Text('', 0, 0), footer: new Text('', 0, 0) }, {
    surfaceId: host.surfaceId, generation: 1, width: 80, height: 24, fullscreen: false,
    focusedSeat: 'editor', themeId: 'dark', themeRevision: 0,
  })
}

test('the transcript-search overlay owns the overlay seat and releases it on close', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  assert.equal(seatOf(host), 'editor')

  app.startTranscriptSearch()
  await settle()
  assert.equal(seatOf(host), 'overlay', 'search must report overlay while open (follow-up P1)')

  app.closeTranscriptSearch()
  await settle()
  assert.equal(seatOf(host), 'editor', 'closing search must restore editor (follow-up P1)')
  app.stop()
})

test('a picker overlay owns the overlay seat and releases it when closed', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  const picker = app.openPicker([{ value: 'a', label: 'option a' }], () => {}, () => {})
  await settle()
  assert.equal(seatOf(host), 'overlay', 'picker must report overlay while open (follow-up P1)')

  picker.close()
  await settle()
  assert.equal(seatOf(host), 'editor', 'closing the picker must restore editor (follow-up P1)')
  app.stop()
})

test('a settings overlay owns the overlay seat and releases it when closed', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  const close = app.openSettings([{ id: 'a', label: 'theme', currentValue: 'dark' }], () => {}, () => {})
  await settle()
  assert.equal(seatOf(host), 'overlay', 'settings must report overlay while open (follow-up P1)')

  close()
  await settle()
  assert.equal(seatOf(host), 'editor', 'closing settings must restore editor (follow-up P1)')
  app.stop()
})

test('an approval dialog and a question flow own the overlay seat', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  void app.showApprovalPrompt({ toolName: 'read', reason: 'read a file' })
  await settle()
  assert.equal(seatOf(host), 'overlay', 'approval must report overlay (follow-up P1)')

  // Settle the approval (y), then ask a question: both own the seat.
  vt.sendInput('y')
  await settle()
  assert.equal(seatOf(host), 'editor', 'approval close must restore editor (follow-up P1)')

  const questions = app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await settle()
  assert.equal(seatOf(host), 'overlay', 'question flow must report overlay (follow-up P1)')
  // Esc cancels a LIST-mode question (a free-text question's Esc only
  // exits the input row, so the flow stays open — options keep Esc as the
  // cancel verb).
  vt.sendInput('\x1b')
  await settle()
  assert.equal(seatOf(host), 'editor', 'question close must restore editor (follow-up P1)')
  await questions.catch(() => {})
  app.stop()
})

test('fullscreen keeps the seat correct through the screen swap', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  assert.equal(seatOf(host), 'editor')

  app.setFullscreen(true)
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'editor', 'plain fullscreen keeps the editor seat')

  // An overlay opened in fullscreen owns the seat on the alt screen.
  app.startTranscriptSearch()
  await settle()
  assert.equal(seatOf(host), 'overlay', 'search in fullscreen must report overlay')
  app.closeTranscriptSearch()
  await settle()
  assert.equal(seatOf(host), 'editor', 'search close in fullscreen must restore editor')

  app.setFullscreen(false)
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'editor', 'returning to regular mode keeps the editor seat')
  app.stop()
})

test('disposing an OLD host leaves the NEW host\'s invalidation sink intact (P1)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host: hostA } = makeApp(ledger)
  await vt.waitForRender()
  attach(hostA)

  // Host B attaches to the SAME ledger (a new surface generation).
  const hostB = new SurfaceHost(ledger, () => app.requestRender())
  attach(hostB)

  // Dispose the OLD host: its batcher must die, but the ledger's sink must
  // stay owned by host B (the review repro: dispose A, register, B renders).
  hostA.dispose()
  await settle()

  // A post-dispose registration must still reach host B's chrome.
  ledger.register('chrome.header.badge', { id: 'late-b' }, { text: 'late-b' }, 'p1')
  await settle()
  assert.ok(hostB.headerBadgeText().includes('late-b'), `host B must receive the invalidation (P1): ${hostB.headerBadgeText()}`)
  app.stop()
})

test('disposing the CURRENT host still restores a no-op sink (idempotent)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  host.dispose()
  host.dispose()
  assert.equal(host.isDisposed(), true)
  // A registration after the final dispose must not throw (no-op sink).
  ledger.register('chrome.header.badge', { id: 'post' }, { text: 'post' }, 'p1')
  await settle()
  app.stop()
})
