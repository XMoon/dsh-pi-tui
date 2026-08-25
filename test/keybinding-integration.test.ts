/**
 * The keybinding integration contract (plan §21): user overrides, the
 * action-based viewer guard (the plan's key test — a remap stays blocked),
 * the leader sequence, the which-key hint, focus-transition cancellation,
 * and safe mode — all through the REAL TuiApp input path.
 * @module @xmoon76/dsh-pi-tui/keybinding-integration.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(
  overrides: Record<string, unknown> = {},
  configure?: (manager: HostKeybindingManager) => void,
): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    ...overrides,
  })
  app.start()
  if (configure !== undefined) configure(app.keybindingsManager())
  return { vt, app }
}

function managerWith(config: Record<string, unknown>): (manager: HostKeybindingManager) => void {
  return (manager) => {
    const parsed = parseUserKeybindings(config)
    manager.setUserConfiguration(parsed)
  }
}

test('user remap: ctrl+x steers, ctrl+s no longer does', async () => {
  const steered: string[] = []
  const { vt, app } = startApp({ onSteer: (text: string) => steered.push(text) }, managerWith({ 'app.input.steer': 'ctrl+x' }))
  vt.sendInput('\x18') // ctrl+x
  await vt.waitForRender()
  assert.deepEqual(steered, [''], 'the remapped key must steer')
  vt.sendInput('\x13') // ctrl+s
  await vt.waitForRender()
  assert.deepEqual(steered, [''], 'the old key must no longer steer')
  app.stop()
})

test('the viewer guard follows the remap: ctrl+x is blocked inside the continuable viewer', async () => {
  // The plan's key test: the user remaps app.input.steer to ctrl+x; the
  // viewer receives ctrl+x — the PARENT must still NOT be steered (the
  // guard is action-based, never a physical-key list).
  const steered: string[] = []
  const { vt, app } = startApp({ onSteer: (text: string) => steered.push(text) }, managerWith({ 'app.input.steer': 'ctrl+x' }))
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'continuable',
    activity: 'inactive',
  })
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x — the remapped steer key
  await vt.waitForRender()
  assert.deepEqual(steered, [], 'the parent must never be steered from inside the viewer')
  app.stop()
})

test('the viewer guard still blocks the DEFAULT parent keys', async () => {
  const steered: string[] = []
  const { vt, app } = startApp({ onSteer: (text: string) => steered.push(text) })
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'continuable',
    activity: 'inactive',
  })
  await vt.waitForRender()
  vt.sendInput('\x13') // ctrl+s
  await vt.waitForRender()
  assert.deepEqual(steered, [], 'the default steer key must be blocked inside the viewer')
  app.stop()
})

test('leader sequence: leader+t opens the task browser', async () => {
  let tasksOpened = 0
  const { vt, app } = startApp({ onOpenTasks: () => { tasksOpened += 1 } }, managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('t') // completing key
  await vt.waitForRender()
  assert.equal(tasksOpened, 1, 'the leader sequence must fire the bound action')
  app.stop()
})

test('a non-matching key cancels the pending leader and passes through', async () => {
  let tasksOpened = 0
  const { vt, app } = startApp({ onOpenTasks: () => { tasksOpened += 1 } }, managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('z') // non-matching: cancels, passes through (types into the editor)
  await vt.waitForRender()
  assert.equal(tasksOpened, 0)
  assert.equal(app.getDraft(), 'z', 'the non-matching key must reach the editor')
  app.stop()
})

test('the pending leader shows the which-key hint in the footer', async () => {
  const { vt, app } = startApp({}, managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Leader: waiting'), `the which-key hint must render:\n${view}`)
  app.stop()
})

test('a focus transition cancels the pending leader', async () => {
  let tasksOpened = 0
  const { vt, app } = startApp({ onOpenTasks: () => { tasksOpened += 1 } }, managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  vt.sendInput('\x18') // leader arms the pending state
  await vt.waitForRender()
  // A viewer open is a focus transition: the pending state must cancel.
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'one-shot',
    activity: 'inactive',
  })
  await vt.waitForRender()
  app.setViewerMode(undefined)
  await vt.waitForRender()
  vt.sendInput('t') // must NOT complete the cancelled sequence
  await vt.waitForRender()
  assert.equal(tasksOpened, 0, 'the cancelled leader must not fire')
  app.stop()
})

test('safe mode ignores user overrides', async () => {
  const steered: string[] = []
  const { vt, app } = startApp({ onSteer: (text: string) => steered.push(text) }, (manager) => {
    managerWith({ 'app.input.steer': 'ctrl+x' })(manager)
    manager.setSafeMode(true)
  })
  vt.sendInput('\x13') // ctrl+s — the builtin steer key
  await vt.waitForRender()
  assert.deepEqual(steered, [''], 'safe mode must keep the builtin defaults')
  vt.sendInput('\x18') // ctrl+x — the overridden key
  await vt.waitForRender()
  assert.deepEqual(steered, [''], 'safe mode must ignore the user override')
  app.stop()
})

test('a leader sequence cannot bypass the viewer parent-action guard', async () => {
  // Review round 1: `<leader>t → app.input.steer` must be inert inside
  // the continuable viewer, exactly like the direct key.
  const steered: string[] = []
  const { vt, app } = startApp({ onSteer: (text: string) => steered.push(text) }, managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.input.steer': '<leader>t' },
  }))
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'continuable',
    activity: 'inactive',
  })
  await vt.waitForRender()
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('t') // completing key → app.input.steer
  await vt.waitForRender()
  assert.deepEqual(steered, [], 'the parent must never be steered from inside the viewer')
  app.stop()
})

test('safe mode disables the leader machine too', async () => {
  // Review round 1: safe mode ignores the user configuration ENTIRELY —
  // including the leader key and its sequences.
  let tasksOpened = 0
  const { vt, app } = startApp({ onOpenTasks: () => { tasksOpened += 1 } }, (manager) => {
    managerWith({
      leader: 'ctrl+x',
      bindings: { 'app.tasks.open': '<leader>t' },
    })(manager)
    manager.setSafeMode(true)
  })
  vt.sendInput('\x18') // leader — must be inert in safe mode
  await vt.waitForRender()
  vt.sendInput('t')
  await vt.waitForRender()
  assert.equal(tasksOpened, 0, 'safe mode must disable the leader sequences')
  assert.equal(app.keybindingsManager().leaderMachine(), undefined, 'no leader machine in safe mode')
  app.stop()
})

test('a remap of the thinking key refreshes cached fold hints (keymap revision)', async () => {
  // Review finding: the transcript component cache keyed the fold hint on
  // the semantic owner only — a remap of the owner action left already-
  // rendered cards showing the OLD key until an unrelated rebuild. The
  // keymap revision now joins the cache identity, so the card copy
  // follows the effective key within one repaint.
  const { vt, app } = startApp()
  // A compact Thinking card renders its hint through ThinkingCompactComponent
  // (the THINKING owner: the effective app.transcript.toggleThinking key).
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'a preview line' }])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('(alt+t to expand)'), `default thinking hint missing:\n${view}`)
  // Remap the thinking owner (hot reload path: manager rebuild bumps the revision).
  managerWith({ 'app.transcript.toggleThinking': 'ctrl+x' })(app.keybindingsManager())
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('(ctrl+x to expand)'), `the cached card must show the remapped key:\n${view}`)
  assert.ok(!view.includes('(alt+t to expand)'), `the old key must not linger in cached cards:\n${view}`)
  app.stop()
})

test('a disabled action no longer fires', async () => {
  const steered: string[] = []
  const { vt, app } = startApp({ onSteer: (text: string) => steered.push(text) }, managerWith({ 'app.input.steer': false }))
  vt.sendInput('\x13') // ctrl+s
  await vt.waitForRender()
  assert.deepEqual(steered, [], 'a disabled action must not fire')
  app.stop()
})

test('the read-only viewer lets a REMAPPED fold key reach the host fold (effective keymap)', async () => {
  // Review finding: the read-only viewer guard hard-coded Ctrl+O as the
  // fold pass-through — a remap of app.transcript.toggleExpand would be
  // consumed as an inert key. The pass-through now resolves the EFFECTIVE
  // fold key, so the remapped chord reaches the host fold path and the
  // OLD key is consumed as inert instead.
  const { vt, app } = startApp({}, managerWith({ 'app.transcript.toggleExpand': 'ctrl+x' }))
  const before = app.isToolOutputExpanded()
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'one-shot',
    activity: 'inactive',
  })
  await vt.waitForRender()
  // ctrl+x (the remapped fold key) passes through the read-only viewer and
  // reaches the host ladder: the fold master flips.
  vt.sendInput('\x18') // ctrl+x
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), !before, 'the remapped fold key must reach the host fold path')
  // ctrl+o is no longer the fold key: consumed as inert (no second flip).
  vt.sendInput('\x0f') // ctrl+o
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), !before, 'the old ctrl+o must stay inert inside the viewer')
  app.stop()
})

test('app.input.submit remap: the NEW key submits and Enter no longer does (PR review)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': 'ctrl+x' }))
  await vt.waitForRender()
  app.setDraft('hello')
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x — the remapped submit key
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello'], 'the remapped key must submit')
  app.setDraft('again')
  await vt.waitForRender()
  vt.sendInput('\r') // Enter — must NOT submit anymore
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello'], 'Enter must no longer submit after the remap')
  assert.equal(app.getDraft(), 'again', 'the draft survives a now-inert Enter')
  app.stop()
})

test('app.input.submit disabled: Enter never submits (PR review)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': false }))
  await vt.waitForRender()
  app.setDraft('keep me')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, [], 'a disabled submit must never fire')
  assert.equal(app.getDraft(), 'keep me', 'the draft is untouched by the inert Enter')
  app.stop()
})

test('leader key colliding with an active host key: disabled with a diagnostic (PR review)', () => {
  const manager = new HostKeybindingManager()
  // leader: ctrl+f collides with app.transcript.search's default ctrl+f.
  manager.setUserConfiguration(parseUserKeybindings({ leader: 'ctrl+f', bindings: { 'app.tasks.open': '<leader>t' } }))
  assert.equal(manager.leaderMachine(), undefined, 'the colliding leader must be disabled')
  assert.ok(manager.diagnosticsList().some(message => message.includes('leader key') && message.includes('active host key')),
    `no collision diagnostic: ${manager.diagnosticsList().join(' | ')}`)
  // A non-colliding leader still works.
  manager.setUserConfiguration(parseUserKeybindings({ leader: 'ctrl+x', bindings: { 'app.tasks.open': '<leader>t' } }))
  assert.ok(manager.leaderMachine() !== undefined, 'a non-colliding leader stays active')
  assert.ok(!manager.diagnosticsList().some(message => message.includes('active host key')))
})

test('pasteMedia remapped: the OLD key is not swallowed by a stale reservation (PR review)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const pasted: number[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onClipboardPaste: () => { pasted.push(1) },
  })
  app.start()
  await vt.waitForRender()
  // Default: Ctrl+V fires pasteMedia.
  vt.sendInput('\x16')
  await vt.waitForRender()
  assert.equal(pasted.length, 1, 'the default Ctrl+V must paste')
  // Remap pasteMedia to Ctrl+P: Ctrl+V is no longer an ACTIVE host key —
  // it must fall through to the editor (NOT be swallowed as a stale
  // reservation, and NOT paste).
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.clipboard.pasteMedia': 'ctrl+p' }))
  await vt.waitForRender()
  vt.sendInput('\x16') // ctrl+v — old key
  await vt.waitForRender()
  assert.equal(pasted.length, 1, 'the remapped-away Ctrl+V must not paste')
  vt.sendInput('\x10') // ctrl+p — the new paste key
  await vt.waitForRender()
  assert.equal(pasted.length, 2, 'the remapped Ctrl+P must paste')
  app.stop()
})

test('exit multi-key binding: the footer hint advertises the Ctrl+C chord specifically (PR review)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.exit.request': ['ctrl+x', 'ctrl+c'] }))
  await vt.waitForRender()
  // Arm the Ctrl+C exit chord: the footer must advertise Ctrl+C (the
  // chord's own key), never the generic primary (Ctrl+X).
  app.setDraft('draft')
  await vt.waitForRender()
  vt.sendInput('\x03') // ctrl+c — first press clears the draft + arms
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Ctrl+C'), `the armed exit hint must name Ctrl+C:\n${view}`)
  assert.ok(!view.includes('Press Ctrl+X'), `the hint must not name the generic primary:\n${view}`)
  app.stop()
})

test('a remapped submit key keeps the editor backslash-newline semantics (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': 'ctrl+x' }))
  await vt.waitForRender()
  // A trailing backslash should insert a NEWLINE, not submit (the fork
  // editor's backslash-Enter workaround) — the remapped key must route
  // through the editor, never the host submitDraft.
  app.setDraft('line\\')
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x — the remapped submit
  await vt.waitForRender()
  assert.deepEqual(submitted, [], 'a trailing backslash must not submit through the remapped key')
  assert.ok(app.getDraft().includes('line'), `the draft must gain a newline, not submit:\n${JSON.stringify(app.getDraft())}`)
  app.stop()
})

test('a remapped submit does not leak into a NEW TuiApp instance (PR review P1)', async () => {
  // The fork keybindings are PROCESS-GLOBAL: the first app remaps/
  // disables submit, then stops. A fresh DEFAULT app must NOT inherit
  // the old state — its Enter must submit again.
  const vt1 = new VirtualTerminal(80, 24)
  const first: string[] = []
  const app1 = new TuiApp(vt1, { onSubmit: (text: string) => first.push(text), onExit: () => {} })
  app1.start()
  app1.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': false }))
  await vt1.waitForRender()
  app1.setDraft('x')
  await vt1.waitForRender()
  vt1.sendInput('\r')
  await vt1.waitForRender()
  assert.deepEqual(first, [], 'the disabled submit must not fire in the first app')
  app1.dispose()

  // A brand-new default app: Enter must submit again (the global binding
  // was restored on dispose).
  const vt2 = new VirtualTerminal(80, 24)
  const second: string[] = []
  const app2 = new TuiApp(vt2, { onSubmit: (text: string) => second.push(text), onExit: () => {} })
  app2.start()
  await vt2.waitForRender()
  app2.setDraft('fresh')
  await vt2.waitForRender()
  vt2.sendInput('\r')
  await vt2.waitForRender()
  assert.deepEqual(second, ['fresh'], 'Enter must submit in the fresh default app')
  app2.dispose()
})

test('disposing the app with an armed leader prefix clears the pending timer (PR review P2)', async () => {
  const vt = new VirtualTerminal(80, 24)
  let tasksOpened = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onOpenTasks: () => { tasksOpened += 1 } })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  await vt.waitForRender()
  vt.sendInput('\x18') // leader — arms the pending state + starts the timeout
  await vt.waitForRender()
  assert.ok(app.keybindingsManager().leaderMachine()?.pending === true, 'the leader must be pending')
  // Dispose with the leader armed: the manager's dispose clears the
  // timeout, so nothing fires against the stopped app afterwards. The
  // assertion is DETERMINISTIC (the repo's race-test rule — no fixed
  // sleeps): flushing the microtask queue lets any (incorrectly) pending
  // continuation land, and the disposed leader machine is gone.
  app.dispose()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(app.keybindingsManager().leaderMachine(), undefined, 'the leader machine is gone after dispose')
  assert.equal(tasksOpened, 0, 'no action may fire after dispose')
})

test('a leader-only submit override: Enter does NOT submit (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  // app.input.submit: <leader>s — NO direct keys. Enter must not submit;
  // only the leader sequence does.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.input.submit': '<leader>s' },
  }))
  await vt.waitForRender()
  app.setDraft('via leader')
  await vt.waitForRender()
  vt.sendInput('\r') // Enter — must NOT submit (the override removed it)
  await vt.waitForRender()
  assert.deepEqual(submitted, [], 'Enter must not submit under a leader-only submit override')
  assert.equal(app.getDraft(), 'via leader', 'the draft survives the inert Enter')
  // The leader sequence DOES submit.
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('s') // completing key
  await vt.waitForRender()
  assert.deepEqual(submitted, ['via leader'], 'the leader sequence must submit')
  app.stop()
})

test('safe mode restores the default Enter submit even after a user disable (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  // User disables submit, then SAFE MODE is enabled: the builtin default
  // must win — Enter submits again.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': false }))
  app.keybindingsManager().setSafeMode(true)
  await vt.waitForRender()
  app.setDraft('safe mode')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['safe mode'], 'safe mode must restore the default Enter submit')
  app.stop()
})

test('leader: enter collides with the editor-owned submit key — leader disabled (PR review P1)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ leader: 'enter', bindings: { 'app.tasks.open': '<leader>t' } }))
  assert.equal(manager.leaderMachine(), undefined, 'a leader key that collides with the editor submit must be disabled')
  assert.ok(manager.diagnosticsList().some(message => message.includes('leader key') && message.includes('active host key')),
    `no collision diagnostic: ${manager.diagnosticsList().join(' | ')}`)
  assert.deepEqual(manager.editorSubmitKeysFor(), ['enter'], 'the editor submit key stays intact')
})

test('a plugin-only key is NOT host-reserved — it reaches the plugin dispatch (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action: string) => { actions.push(action) },
  }, {
    // A plugin binds Ctrl+Alt+X (no host action uses it): the router's
    // hostResolves must NOT claim it — the plugin dispatch fires.
    pluginActionFor: (key) => key.key === 'x' && key.ctrl && key.alt ? 'open-search' : undefined,
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b\x18') // ctrl+alt+x
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'the plugin-only key must reach the plugin dispatch')
  app.stop()
})

test('a plugin submit binding is ADDITIVE — the builtin Enter stays (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text: string) => submitted.push(text),
    onExit: () => {},
  }, {
    // A plugin binds app.input.submit to ctrl+p: additive — Enter must
    // STILL submit (the plugin never replaces the host's key).
    pluginActionFor: (key) => key.key === 'p' && key.ctrl ? 'submit-draft' : undefined,
  })
  app.start()
  app.keybindingsManager().setPluginRules([{ id: 'plugin-submit', action: 'app.input.submit', key: 'ctrl+p' }])
  await vt.waitForRender()
  assert.deepEqual(app.keybindingsManager().editorSubmitKeysFor(), ['enter'], 'the builtin Enter survives a plugin submit binding')
  app.setDraft('via enter')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['via enter'], 'Enter still submits under an additive plugin binding')
  app.stop()
})

test('a plugin key does NOT collide with the leader prefix (PR review P2)', () => {
  const manager = new HostKeybindingManager()
  manager.setPluginRules([{ id: 'plugin-x', action: 'app.tasks.open', key: 'ctrl+alt+x' }])
  manager.setUserConfiguration(parseUserKeybindings({ leader: 'ctrl+alt+x', bindings: { 'app.session.new': '<leader>n' } }))
  assert.ok(manager.leaderMachine() !== undefined, 'a plugin-only key must not disable the leader')
  assert.ok(!manager.diagnosticsList().some(message => message.includes('active host key')),
    `no collision expected: ${manager.diagnosticsList().join(' | ')}`)
})

test('read-only viewer: Esc ALWAYS closes it, even with interrupt remapped (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  let singleEscapes = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSingleEscape: () => { singleEscapes += 1; return true },
  })
  app.start()
  // Remap interrupt away from Esc to Ctrl+X.
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' }))
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'one-shot',
    activity: 'inactive',
  })
  await vt.waitForRender()
  // Esc must still close the read-only viewer (the fixed lifecycle key),
  // even though interrupt no longer resolves on Esc.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 1, 'Esc must run the viewer close (single-Esc) path')
  app.stop()
})

test('read-only viewer: a remapped interrupt key (Ctrl+X) is inert, never the parent (PR review P1)', async () => {
  const vt = new VirtualTerminal(80, 24)
  let singleEscapes = 0
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSingleEscape: () => { singleEscapes += 1; return true },
    onCancel: () => { cancels += 1 },
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' }))
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'one-shot',
    activity: 'inactive',
  })
  await vt.waitForRender()
  // Ctrl+X inside the read-only viewer: consumed as locked — neither the
  // viewer closes nor the parent cancels.
  vt.sendInput('\x18')
  await vt.waitForRender()
  assert.equal(singleEscapes, 0, 'Ctrl+X must not run the viewer close path')
  assert.equal(cancels, 0, 'Ctrl+X must not cancel the parent agent')
  // Esc still closes normally.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 1)
  app.stop()
})

test('a leader-prefix collision stops advertising the leader bindings (PR review P2)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+f', // collides with app.transcript.search's ctrl+f
    bindings: { 'app.session.new': '<leader>n' },
  }))
  assert.equal(manager.leaderMachine(), undefined, 'the colliding leader is disabled')
  assert.ok(manager.diagnosticsList().some(message => message.includes('active host key')))
  // The UI must NOT advertise the dead leader sequence anywhere.
  assert.equal(manager.keyHint('app.session.new'), '', 'keyHint must not advertise the shadowed leader')
  assert.equal(manager.keysLabelFor('app.session.new'), '', 'keysLabelFor must not advertise the shadowed leader')
  const binding = manager.snapshot().bindings.find(entry => entry.action === 'app.session.new')
  assert.equal(binding?.leaderKeys, undefined, 'the snapshot must not carry the shadowed leader')
})

test('closing a viewer with Esc disarms the main-session double-Esc window (PR review P2)', async () => {
  const vt = new VirtualTerminal(80, 24)
  let singleEscapes = 0
  let cancels = 0
  let rewinds = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // P3 test fix: the FIRST main-session Esc must NOT consume (return
    // false) so handleEscapeKey actually ARMS the double-Esc window
    // (lastEscapeAt = now); the viewer-close Esc consumes (returns true).
    // With the old always-true callback the "arm" was a fake — the window
    // was never armed, making the disarm assertion vacuous.
    onSingleEscape: () => { singleEscapes += 1; return singleEscapes === 1 ? false : true },
    onCancel: () => { cancels += 1 },
    onRewind: () => { rewinds += 1 },
  })
  app.start()
  // Arm a double-Esc window in the main session: the first Esc returns
  // false (not consumed) → handleEscapeKey arms the window.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 1, 'the main-session Esc ran the single-Esc path')
  assert.equal(cancels, 0)
  // Open the read-only viewer, then close it with Esc — the consumed
  // close must DISARM the pending window.
  app.setViewerMode({
    parentSessionId: 'session-main',
    childSessionId: 'session-child',
    label: 'child',
    mode: 'one-shot',
    activity: 'inactive',
  })
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 2, 'the viewer-close Esc ran the viewer close path')
  // Back in the main session: a single Esc must NOT read as the second
  // consecutive Esc (no cancel/rewind). If the disarm were missing, this
  // Esc would be within the window and trigger onCancel.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 3, 'the main-session Esc runs the single-Esc path again')
  assert.equal(cancels, 0, 'the disarmed main-session Esc must not cancel')
  assert.equal(rewinds, 0, 'the disarmed main-session Esc must not rewind')
  app.stop()
})

test('a SHADOWED leader-only submit restores the builtin Enter (PR review P1)', () => {
  const manager = new HostKeybindingManager()
  // leader: ctrl+f collides with app.transcript.search — the leader is
  // shadowed, so the <leader>s submit sequence can never fire. The
  // builtin Enter must be restored (fail-soft), NOT disabled alongside
  // the dead leader.
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+f',
    bindings: { 'app.input.submit': '<leader>s' },
  }))
  assert.equal(manager.leaderMachine(), undefined, 'the colliding leader is disabled')
  assert.ok(manager.diagnosticsList().some(message => message.includes('active host key')))
  assert.deepEqual(manager.editorSubmitKeysFor(), ['enter'], 'the dead leader-only submit restores Enter')
  assert.equal(manager.keyHint('app.input.submit'), 'Enter', 'the UI advertises the restored Enter')
})

test('an AMBIGUOUS leader-only submit restores the builtin Enter (PR review P1)', () => {
  const manager = new HostKeybindingManager()
  // Two actions bound to the same completing key <leader>s: ambiguous —
  // neither fires. The submit sequence is dead, so Enter must be restored.
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: {
      'app.input.submit': '<leader>s',
      'app.session.new': '<leader>s',
    },
  }))
  assert.equal(manager.leaderMachine()?.leaderBindings.length ?? 0, 0, 'the ambiguous sequence is dropped')
  assert.ok(manager.diagnosticsList().some(message => message.includes('ambiguous leader sequence')))
  assert.deepEqual(manager.editorSubmitKeysFor(), ['enter'], 'the ambiguous leader-only submit restores Enter')
  assert.equal(manager.keyHint('app.input.submit'), 'Enter', 'the UI advertises the restored Enter')
})
