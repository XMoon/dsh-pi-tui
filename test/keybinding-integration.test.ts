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
