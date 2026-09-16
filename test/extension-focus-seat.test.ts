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
import { EditorRegistry } from '../src/editor-registry.ts'
import type { SaveLocationDeps } from '../src/save-location.ts'
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

test('fullscreen closes the ordinary search overlay with its close callback', async () => {
  const ledger = new ExtensionLedger(() => {})
  let searchOpens = 0
  let searchCloses = 0
  const vt = new VirtualTerminal(80, 24)
  const host = new SurfaceHost(ledger, () => app.requestRender())
  let app: TuiApp
  app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchOpen: () => { searchOpens += 1 },
    onSearchClose: () => { searchCloses += 1 },
  }, { extensionHost: host })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  attach(host)
  await settle()

  app.startTranscriptSearch()
  await settle()
  assert.equal(searchOpens, 1)
  assert.equal(searchCloses, 0)

  // The screen swap does not remount the ordinary search overlay: it must
  // be closed properly (the runner's onSearchClose resets the search
  // state/anchor), so the next Ctrl+F reopens a FRESH search.
  app.setFullscreen(true)
  await vt.waitForRender()
  await settle()
  assert.equal(searchCloses, 1, 'the fullscreen teardown closes the search with its callback')

  app.startTranscriptSearch()
  await settle()
  assert.equal(searchOpens, 2, 'the next search opens a fresh overlay')
  app.closeTranscriptSearch()
  await settle()
  assert.equal(searchCloses, 2)
  app.setFullscreen(false)
  await vt.waitForRender()
  app.stop()
})

test('a Save Location prompt owns the overlay seat even across an async overlay close', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  // Open a search overlay first, then mount the Save Location prompt (it
  // suspends the search overlay). Closing the suspended search overlay
  // re-derives the seat — the prompt must keep reporting overlay.
  app.startTranscriptSearch()
  await settle()
  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async () => null,
  }
  const prompt = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    deps,
  )
  await settle()
  assert.equal(seatOf(host), 'overlay', 'Save Location must report overlay while active')

  app.closeTranscriptSearch()
  await settle()
  assert.equal(seatOf(host), 'overlay', 'closing a suspended overlay must not publish editor behind the prompt')

  // Cancel the prompt: the seat returns to editor.
  vt.sendInput('\x1b')
  assert.deepEqual(await prompt, { kind: 'cancelled' })
  await settle()
  assert.equal(seatOf(host), 'editor', 'closing the prompt must restore editor')
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

// ── Approval → underlying capturing overlay focus restoration ──────────────
//
// Closing an approval restores every overlay it hid. A restored CAPTURING
// overlay must own physical keyboard focus — never "overlay visible, editor
// focused" (the bug that left Esc unable to reach the restored overlay).

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
const viewOf = (vt: VirtualTerminal): string => vt.getViewport().map(stripAnsi).join('\n')

/** Open the footer ↓ Quick Tasks surface over the editor. */
function openQuick(app: TuiApp): void {
  app.openTaskBrowser(
    [{ value: 'job:1', label: 'bash · build', status: 'running', active: true, source: 'job', type: 'bash', canStop: true, startedAt: Date.now(), group: 'jobs' }],
    () => 'close',
    () => {},
    { mode: 'quick', header: 'Tasks', enableSearch: true, maxVisible: 8 },
  )
}

test('an approval over Quick restores Quick focus so one Esc closes it', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  app.setEditorText('draft')
  openQuick(app)
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('Open Task Center'), `Quick must be visible:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  void app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Approve bash?'), `approval must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('Open Task Center'), `Quick must be hidden beneath the approval:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  vt.sendInput('y') // settle the approval
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Open Task Center'), `Quick must be restored:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored Quick must own the overlay seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored Quick must hold PHYSICAL focus, not the editor')

  // The physical-focus proof: a printable while Quick is restored must be
  // consumed by Quick, never leak into the editor draft.
  vt.sendInput('X')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'draft', 'the restored Quick must own input (no editor leak)')

  // The critical regression: ONE Esc closes Quick — the editor must not hold
  // physical focus behind the visible overlay.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('Open Task Center'), `one Esc must close Quick:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'editor')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'closing Quick returns physical focus to the editor')
  vt.sendInput('Z')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'draftZ', 'the editor regains ownership after Quick closes')
  app.stop()
})

test('an approval over Settings restores Settings focus so Esc closes it', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  app.openSettings(
    [{ id: 'a', label: 'Plugin setting', currentValue: 'on', values: ['on', 'off'] }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  assert.ok(viewOf(vt).includes('Plugin setting'), `settings must be visible:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  void app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Approve bash?'), `approval must be visible:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  vt.sendInput('y')
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Plugin setting'), `settings must be restored:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored Settings must own the overlay seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored Settings must hold PHYSICAL focus, not the editor')

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('Plugin setting'), `one Esc must close settings:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'editor')
  app.stop()
})

test('a standalone approval settles back to the editor and typing reaches it', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  app.setEditorText('draft')
  void app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'overlay')
  assert.ok(viewOf(vt).includes('Approve bash?'), `approval must be visible:\n${viewOf(vt)}`)

  vt.sendInput('y')
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'editor', 'with nothing restored, the editor owns the seat')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the editor must hold physical focus when no overlay remains')
  vt.sendInput('Z')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'draftZ', 'normal typing must reach the editor')
  app.stop()
})

test('a queued approval keeps ownership until it settles, then Quick is restored', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  app.setEditorText('draft')
  openQuick(app)
  await vt.waitForRender()

  const first = app.showApprovalPrompt({ toolName: 'bash', reason: 'first' })
  await vt.waitForRender()
  await settle()
  const second = app.showApprovalPrompt({ toolName: 'fs', reason: 'second' })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Approve bash?'), `approval A must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('Open Task Center'), `Quick must stay hidden:\n${viewOf(vt)}`)

  vt.sendInput('y') // settle A → B takes the screen
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Approve fs?'), `queued approval B must take the screen:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('Open Task Center'), `Quick stays hidden behind B:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the queued approval B must hold physical focus')

  vt.sendInput('y') // settle B → Quick restored
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Open Task Center'), `Quick must be restored after B:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored Quick must hold physical focus after the whole approval chain')

  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('Open Task Center'), `one Esc must close Quick:\n${viewOf(vt)}`)
  vt.sendInput('Z')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'draftZ')
  await first.catch(() => {})
  await second.catch(() => {})
  app.stop()
})

test('cancelling an approval over Quick also restores Quick focus', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  openQuick(app)
  await vt.waitForRender()
  void app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  await settle()

  vt.sendInput('\x1b') // cancel the approval
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Open Task Center'), `Quick must be restored after a cancel:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'a cancelled approval must still restore the underlying focus')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'a cancelled approval must still restore the underlying physical focus')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!viewOf(vt).includes('Open Task Center'), `one Esc must close Quick:\n${viewOf(vt)}`)
  app.stop()
})

// ── Shared close reconciliation across surface kinds ───────────────────────

test('the shared close reconciliation also protects an extension overlay stack (A → B → A)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  const a = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'plugin overlay A' }] })
  await vt.waitForRender()
  await settle()
  const b = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'plugin overlay B' }] })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('plugin overlay B'), `B must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('plugin overlay A'), `A must be hidden beneath B:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  b.close()
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('plugin overlay A'), `A must be restored:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('plugin overlay B'), `B must be gone:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored extension overlay owns the seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored extension overlay holds physical focus')

  a.close()
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'editor')
  app.stop()
})

test('an authorization-style OutputViewer restored from a nested picker keeps focus (one Esc closes it)', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  // No onStop: the standalone notice (same shape as the Sign in notice).
  app.openOutputViewer({ title: 'Sign in', initial: 'device code ABCD', refresh: () => 'device code ABCD' })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('device code ABCD'), `the notice must be visible:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  // The notice's provider prompt opens a picker on top.
  const picker = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('provider option'), `the picker must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('device code ABCD'), `the notice must be hidden beneath the picker:\n${viewOf(vt)}`)

  picker.close?.()
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('device code ABCD'), `the notice must be restored:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored notice owns the seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored notice holds physical focus')

  vt.sendInput('\x1b')
  await vt.waitForRender()
  await settle()
  assert.ok(!viewOf(vt).includes('device code ABCD'), `one Esc must close the restored notice:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'editor')
  app.stop()
})

test('Quick → Job → Approval settles one layer at a time back to the editor', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()
  app.setEditorText('draft')

  // The runner's contract: a Job selection opens the Job detail overlay and
  // reports 'keep-open', so the exact Quick instance survives underneath.
  app.openTaskBrowser(
    [{ value: 'job:1', label: 'bash · build', status: 'running', active: true, source: 'job', type: 'bash', canStop: true, startedAt: Date.now(), group: 'jobs' }],
    (value) => {
      app.openOutputViewer({
        title: 'job detail',
        initial: `selected ${value}`,
        refresh: () => `selected ${value}`,
        onStop: () => {},
        canStop: () => true,
        closeHint: 'back',
      })
      return 'keep-open'
    },
    () => {},
    { mode: 'quick', header: 'Tasks', enableSearch: true, maxVisible: 8 },
  )
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Open Task Center'), `Quick must be visible:\n${viewOf(vt)}`)

  vt.sendInput('\r') // open the Job detail
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('job detail'), `the Job View must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('Open Task Center'), `Quick must be hidden beneath the Job View:\n${viewOf(vt)}`)
  assert.equal(app.overlayGraphState().handles, 2, 'Quick stays mounted beneath the Job View')
  assert.equal(seatOf(host), 'overlay')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the Job View holds physical focus')

  // The approval takes the top of the stack over the Job View.
  void app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('Approve bash?'), `the approval must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('job detail'), `the Job View must be hidden beneath the approval:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  vt.sendInput('y') // settle the approval → the Job View returns
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('job detail'), `the Job View must be restored:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('Open Task Center'), `Quick stays hidden beneath the Job View:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored Job View owns the seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored Job View holds physical focus')

  // ONE Esc closes only the Job View, restoring the exact Quick browser.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  await settle()
  assert.ok(!viewOf(vt).includes('job detail'), `Esc must close the Job View:\n${viewOf(vt)}`)
  assert.ok(viewOf(vt).includes('Open Task Center'), `Quick must be restored:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored Quick owns the seat')
  assert.notEqual(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the restored Quick holds physical focus')

  // The next Esc closes Quick and returns input to the editor.
  vt.sendInput('X') // must be consumed by Quick, never leak into the draft
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'draft', 'the restored Quick must own input')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  await settle()
  assert.ok(!viewOf(vt).includes('Open Task Center'), `the second Esc must close Quick:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'editor')
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the editor regains physical focus')
  vt.sendInput('Z')
  await vt.waitForRender()
  assert.equal(app.seatTextForTest(), 'draftZ')
  app.stop()
})

// ── The seat follows PHYSICAL keyboard ownership ───────────────────────────
//
// An overlay ENTRY alone must not promote the focused seat: a nonCapturing
// overlay never takes focus, and a manually hidden entry owns nothing. The
// shared close reconciliation must therefore re-derive from the live focus.

test('a nonCapturing overlay restored beneath a closed picker never owns the seat', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  // A plugin HUD is visible but must not take keyboard ownership.
  app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'plugin HUD' }] }, { nonCapturing: true })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('plugin HUD'), `the HUD must be visible:\n${viewOf(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'a nonCapturing overlay must not take physical focus')
  assert.equal(seatOf(host), 'editor', 'a nonCapturing overlay must not own the seat')

  const picker = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'overlay', 'the capturing picker owns the seat')

  picker.close?.()
  await vt.waitForRender()
  await settle()
  // The HUD is restored (hidden beneath the capturing picker) but the editor
  // still owns the keyboard: the restored nonCapturing overlay must NOT
  // promote the seat back to 'overlay'.
  assert.ok(viewOf(vt).includes('plugin HUD'), `the HUD must be restored:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('provider option'), `the picker must be gone:\n${viewOf(vt)}`)
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the editor keeps physical focus under a nonCapturing overlay')
  assert.equal(seatOf(host), 'editor', 'a restored nonCapturing overlay must not own the seat')
  app.stop()
})

test('a manually hidden tracked overlay does not own the seat after a later close', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  const hidden = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'hidden overlay' }] })
  await vt.waitForRender()
  await settle()
  hidden.hide() // lease-hidden: still TRACKED, but not visible and not focused
  await vt.waitForRender()
  await settle()

  const picker = app.openPicker([{ value: 'p', label: 'provider option' }], () => {}, () => {})
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'overlay')
  picker.close?.()
  await vt.waitForRender()
  await settle()
  // The hidden handle is still tracked, but it must not resurrect the seat
  // once the capturing picker above it closes.
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component)
  assert.equal(seatOf(host), 'editor', 'a hidden tracked overlay must not own the seat after a close')
  app.stop()
})

test('a plugin-editor seat handoff under a nonCapturing overlay keeps the editor seat', async () => {
  const ledger = new ExtensionLedger(() => {})
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  let app: TuiApp
  const host = new SurfaceHost(ledger, () => app.requestRender())
  app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { extensionHost: host, editorRegistry: registry })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  attach(host)
  await settle()

  // A nonCapturing notice is visible: it owns no keyboard, so it must NOT
  // fence the editor-seat handoff.
  app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'notice HUD' }] }, { nonCapturing: true })
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'editor')

  registry.register({
    id: 'plugin-editor',
    priority: 1,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'plugin editor' }] },
      getText: () => 'draft',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  await settle()

  assert.equal(app.seatEditorForTest().id, 'plugin-editor')
  // Focus follows the new occupant: the nonCapturing notice must not leave
  // the stale host editor physically focused (which made publishFocusSeat
  // report 'overlay').
  assert.equal(app.focusedComponentForTest(), app.seatEditorForTest().component,
    'the plugin editor must hold physical focus under a nonCapturing overlay')
  assert.equal(seatOf(host), 'editor', 'a nonCapturing overlay must not own the seat after a handoff')
  app.stop()
})

test('Save Location keeps the overlay dependency stack across a fullscreen swap', async () => {
  const ledger = new ExtensionLedger(() => {})
  const { vt, app, host } = makeApp(ledger)
  await vt.waitForRender()
  attach(host)
  await settle()

  const a = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'overlay A' }] })
  await vt.waitForRender()
  await settle()
  const b = app.showExtensionOverlay({ kind: 'text', spans: [{ text: 'overlay B' }] })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('overlay B'), `B must be visible:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('overlay A'), `A must be hidden beneath B:\n${viewOf(vt)}`)
  assert.equal(app.overlayGraphState().dependents, 1, 'B owns A')

  const deps: SaveLocationDeps = {
    resolveDirectory: (input) => input,
    isDirectory: () => true,
    targetExists: () => false,
    complete: async () => null,
  }
  const prompt = app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-abc.zip', initialDirectory: './' },
    deps,
  )
  await vt.waitForRender()
  await settle()
  assert.equal(seatOf(host), 'overlay', 'the Save prompt owns the seat')

  // Fullscreen teardown clears the broker graph and re-mounts every
  // remountable lease: the Save suspension must rebuild B → A, not flatten.
  app.setFullscreen(true)
  await vt.waitForRender()
  await settle()
  app.setFullscreen(false)
  await vt.waitForRender()
  await settle()
  assert.equal(app.overlayGraphState().dependents, 1, 'the remount must preserve the dependency chain')

  vt.sendInput('\x1b') // cancel the prompt → B restored
  assert.deepEqual(await prompt, { kind: 'cancelled' })
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('overlay B'), `B must be restored after the prompt:\n${viewOf(vt)}`)
  assert.ok(!viewOf(vt).includes('overlay A'), `A must stay hidden under B:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay')

  b.close()
  await vt.waitForRender()
  await settle()
  assert.ok(viewOf(vt).includes('overlay A'), `A must be revealed when B closes:\n${viewOf(vt)}`)
  assert.equal(seatOf(host), 'overlay', 'the restored A owns the seat')
  a.close()
  app.stop()
})
