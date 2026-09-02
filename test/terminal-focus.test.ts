/**
 * Terminal focus tracking tests (plan §10.3): the tracker's state
 * machine (default focused, ESC[I/ESC[O flips, markFocused on user
 * activity) and the TuiApp-level interception — a focus report fires
 * the host's onTerminalFocus event and never reaches the keybinding
 * manager or autocomplete; in REGULAR mode the host consumes it before
 * the editor, in FULLSCREEN it passes through to the alt screen's
 * viewport listener (existing X036 pass-through — the focused
 * component may still receive it and ignores it). Ordinary input still
 * flows through the normal pipeline and fires the onUserInput seam.
 * @module @xmoon76/dsh-pi-tui/terminal-focus.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { CompletionNotificationController } from '../src/notification/controller.ts'
import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
  TerminalFocusTracker,
  isFocusReport,
} from '../src/notification/terminal-focus.ts'

test('the tracker defaults to focused (the safe assumption)', () => {
  const tracker = new TerminalFocusTracker()
  assert.equal(tracker.state, 'focused')
})

test('ESC[O flips to unfocused; ESC[I restores focused', () => {
  const tracker = new TerminalFocusTracker()
  assert.equal(tracker.handleFocusReport(FOCUS_OUT_SEQUENCE), true)
  assert.equal(tracker.state, 'unfocused')
  assert.equal(tracker.handleFocusReport(FOCUS_IN_SEQUENCE), true)
  assert.equal(tracker.state, 'focused')
})

test('ordinary input is not a focus report and leaves the state untouched', () => {
  const tracker = new TerminalFocusTracker()
  assert.equal(tracker.handleFocusReport('a'), false)
  assert.equal(tracker.handleFocusReport('\x1b[A'), false)
  assert.equal(tracker.state, 'focused')
  tracker.handleFocusReport(FOCUS_OUT_SEQUENCE)
  assert.equal(tracker.handleFocusReport('x'), false)
  assert.equal(tracker.state, 'unfocused', 'ordinary input must not flip the state')
})

test('markFocused restores the safe state defensively', () => {
  const tracker = new TerminalFocusTracker()
  tracker.handleFocusReport(FOCUS_OUT_SEQUENCE)
  tracker.markFocused()
  assert.equal(tracker.state, 'focused')
})

test('isFocusReport recognizes exactly the two report sequences', () => {
  assert.equal(isFocusReport(FOCUS_IN_SEQUENCE), true)
  assert.equal(isFocusReport(FOCUS_OUT_SEQUENCE), true)
  assert.equal(isFocusReport('\x1b[Iextra'), false)
  assert.equal(isFocusReport(''), false)
})

test('the enable/disable sequences are the CSI ? 1004 pair', () => {
  assert.equal(ENABLE_FOCUS_REPORTING, '\x1b[?1004h')
  assert.equal(DISABLE_FOCUS_REPORTING, '\x1b[?1004l')
})

// ── TuiApp-level interception (plan §10.3) ─────────────────────────────

test('TuiApp regular mode: focus reports fire onTerminalFocus and never reach the editor or a keybinding', async () => {
  const vt = new VirtualTerminal(80, 24)
  const focusReports: boolean[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTerminalFocus: (focused) => { focusReports.push(focused) },
  })
  app.start()
  // Type a draft so the editor is live.
  vt.sendInput('hello')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello')
  // A focus report must not alter the draft.
  vt.sendInput(FOCUS_OUT_SEQUENCE)
  vt.sendInput(FOCUS_IN_SEQUENCE)
  await vt.waitForRender()
  assert.deepEqual(focusReports, [false, true], 'the reports must reach the host tracker in order')
  assert.equal(app.getDraft(), 'hello', 'a focus report must never change the editor text')
  // Ordinary input still flows through the normal pipeline.
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello!')
  app.stop()
})

test('TuiApp: a focus report never triggers a plugin keybinding', async () => {
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action) => { actions.push(action) },
  })
  app.start()
  // A live plugin binding: the focus reports share no sequence with it,
  // and the app filters them BEFORE the key ladder — they must never be
  // decoded as a key at all.
  app.keybindingsManager().setPluginRules([{ id: 'test.focus-probe', action: 'test.focus-probe', key: 'ctrl+shift+f' }])
  vt.sendInput(FOCUS_OUT_SEQUENCE)
  vt.sendInput(FOCUS_IN_SEQUENCE)
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'focus reports must never reach the keybinding manager')
  app.stop()
})

test('TuiApp regular mode: focus reports are consumed host-side and never reach the focused editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  // Instrument the focused component: every raw input it receives is
  // recorded. In REGULAR mode no viewport listener exists, so the host
  // consumes the reports itself (handleInputCore) — ESC[I/ESC[O must
  // never arrive here.
  const component = app.seatEditorForTest().component as unknown as { handleInput(data: string): void }
  const received: string[] = []
  const original = component.handleInput.bind(component)
  component.handleInput = (data: string) => { received.push(data); original(data) }
  vt.sendInput(FOCUS_OUT_SEQUENCE)
  vt.sendInput(FOCUS_IN_SEQUENCE)
  await vt.waitForRender()
  assert.ok(!received.includes(FOCUS_OUT_SEQUENCE) && !received.includes(FOCUS_IN_SEQUENCE),
    `focus reports must never reach the focused editor: ${JSON.stringify(received)}`)
  // Ordinary input still flows through the normal pipeline.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.ok(received.length > 0, 'ordinary input must still reach the editor')
  assert.equal(app.getDraft(), 'x')
  app.stop()
})

test('TuiApp: a focus report never triggers autocomplete', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  // The ONLY completion source is the injected extensionSuggest counter
  // (empty host command list — the host provider returns null for plain
  // text, so every Tab consults the injected provider).
  let suggestCalls = 0
  app.setCommandCompletions([], '/tmp', null, async () => {
    suggestCalls += 1
    return null
  })
  await vt.waitForRender()
  // Ordinary input + Tab consults the completion provider.
  vt.sendInput('abc')
  await vt.waitForRender()
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.ok(suggestCalls >= 1, 'Tab must consult the completion provider')
  const before = suggestCalls
  // Focus reports must never consult the completion provider (and never
  // alter the editor text).
  vt.sendInput(FOCUS_OUT_SEQUENCE)
  vt.sendInput(FOCUS_IN_SEQUENCE)
  await vt.waitForRender()
  assert.equal(suggestCalls, before, 'focus reports must never trigger autocomplete')
  assert.equal(app.getDraft(), 'abc', 'focus reports must not alter the editor text')
  app.stop()
})

test('fullscreen toggle-off keeps focus reporting enabled; a full teardown disables it', async () => {
  const vt = new VirtualTerminal(80, 24)
  const writes: string[] = []
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string) => { writes.push(data); originalWrite(data) }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  writes.length = 0
  // A fullscreen toggle-off stops the alt screen (whose mouse-disable
  // turns ?1004 off) and starts the main screen — the app re-asserts
  // ?1004h after the swap, so the NET focus-reporting state stays ON
  // (the host owns the mode: enabled at mount, disabled at exit).
  app.setFullscreen(false)
  await vt.waitForRender()
  const toggleOff = writes.join('')
  const lastFocusWrite = Math.max(toggleOff.lastIndexOf('\x1b[?1004h'), toggleOff.lastIndexOf('\x1b[?1004l'))
  assert.ok(lastFocusWrite >= 0 && toggleOff.slice(lastFocusWrite).startsWith('\x1b[?1004h'),
    `a fullscreen toggle-off must leave focus reporting ENABLED: ${JSON.stringify(toggleOff)}`)
  // A FULL teardown from fullscreen still disables it (the alt screen's
  // full stop writes the complete mouse-disable; the runner's cleanup
  // additionally writes ?1004l — covered by the wiring source audit).
  writes.length = 0
  app.setFullscreen(true)
  await vt.waitForRender()
  writes.length = 0
  app.stop()
  const teardown = writes.join('')
  assert.ok(teardown.includes('\x1b[?1004l'),
    `a full teardown must disable focus reporting: ${JSON.stringify(teardown)}`)
})

test('a throwing focus-reporting reassert cannot crash the fullscreen toggle', async () => {
  const vt = new VirtualTerminal(80, 24)
  const originalWrite = vt.write.bind(vt)
  let reassertThrew = false
  vt.write = (data: string) => {
    // The app's re-assert is a BARE ?1004h chunk (the alt screen's
    // enable rides a longer mouse sequence) — throw exactly there.
    if (data === '\x1b[?1004h') {
      reassertThrew = true
      throw new Error('stream destroyed')
    }
    originalWrite(data)
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  // The toggle-off re-assert throws synchronously — the app must contain
  // it and keep working (a broken stdout degrades focus reporting
  // silently, never crashes the input path).
  app.setFullscreen(false)
  await vt.waitForRender()
  assert.equal(reassertThrew, true, 'precondition: the re-assert write must have thrown')
  assert.equal(app.isFullscreen(), false, 'the toggle must still complete')
  // The surface still accepts input.
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'x')
  app.stop()
})

test('unstable raw captures cannot consume or rewrite focus reports (host-reserved)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const focusReports: boolean[] = []
  const routeCalls: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTerminalFocus: (focused) => { focusReports.push(focused) },
  }, {
    unstableInputRoute: (data) => {
      routeCalls.push(data)
      // A hostile capture tries to consume AND rewrite focus reports.
      if (data === FOCUS_OUT_SEQUENCE) return { action: 'consume' }
      if (data === FOCUS_IN_SEQUENCE) return { action: 'rewrite', data: 'R' }
      return { action: 'pass' }
    },
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput(FOCUS_OUT_SEQUENCE)
  vt.sendInput(FOCUS_IN_SEQUENCE)
  await vt.waitForRender()
  // The focus reports bypass the raw stage entirely: the capture never
  // saw them, the tracker received both, and the editor text is intact.
  assert.deepEqual(routeCalls, [], 'focus reports must never reach the unstable raw route')
  assert.deepEqual(focusReports, [false, true], 'the tracker must receive both reports')
  assert.equal(app.getDraft(), '', 'focus reports must not alter the editor text')
  app.stop()
})

test('unstable raw captures cannot rewrite ordinary input INTO a focus report', async () => {
  const vt = new VirtualTerminal(80, 24)
  const focusReports: boolean[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onTerminalFocus: (focused) => { focusReports.push(focused) },
  }, {
    unstableInputRoute: (data) => {
      // A hostile capture rewrites ordinary input into a focus report.
      if (data === 'x') return { action: 'rewrite', data: FOCUS_OUT_SEQUENCE }
      return { action: 'pass' }
    },
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('x')
  await vt.waitForRender()
  // The rewrite into a focus-control sequence is refused: no focus
  // transition is synthesized, and the chunk is consumed (the editor
  // never sees it).
  assert.deepEqual(focusReports, [], 'a rewritten focus report must not synthesize a focus transition')
  assert.equal(app.getDraft(), '', 'the refused rewrite must not reach the editor')
  app.stop()
})

test('TuiApp: ordinary input fires onUserInput; focus reports do not', async () => {
  const vt = new VirtualTerminal(80, 24)
  let userInputs = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onUserInput: () => { userInputs += 1 },
  })
  app.start()
  await vt.waitForRender()
  // Focus reports are NOT user activity.
  vt.sendInput(FOCUS_OUT_SEQUENCE)
  vt.sendInput(FOCUS_IN_SEQUENCE)
  await vt.waitForRender()
  assert.equal(userInputs, 0, 'focus reports must not count as user activity')
  // Any real input IS user activity (before the raw stage / plugin
  // routing — a chunk a capture later consumes still proves it).
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(userInputs, 1, 'ordinary input must fire onUserInput')
  app.stop()
})

test('user activity restores focused after a missed FOCUS_IN — no false notification (markFocused wiring)', () => {
  // The runner's exact wiring: onTerminalFocus feeds the tracker and the
  // controller; onUserInput restores 'focused'. Scenario: FOCUS_OUT
  // arrives, the FOCUS_IN is dropped by the transport, the user is back
  // and typing — the settle must stay silent under the default
  // unfocused mode.
  const tracker = new TerminalFocusTracker()
  const notifications: string[] = []
  const controller = new CompletionNotificationController((method, title, body) => {
    notifications.push(`${title}: ${body}`)
  })
  controller.setLiveAgent('main')
  const syncFocus = (): void => controller.setFocus(tracker.state)
  // FOCUS_OUT arrives.
  tracker.handleFocusReport(FOCUS_OUT_SEQUENCE)
  syncFocus()
  assert.equal(tracker.state, 'unfocused')
  // The user is back and types; FOCUS_IN was missed — onUserInput
  // restores the safe state.
  tracker.markFocused()
  syncFocus()
  assert.equal(tracker.state, 'focused')
  controller.onAgentStatus('main', 'running')
  controller.onAgentStatus('main', 'idle')
  assert.deepEqual(notifications, [], 'user activity must restore focused → no notification while the user watches')
})
