/**
 * The keybinding CONVERGENCE contract (plan: the PR #34 architecture
 * convergence). Phase 0: these tests assert the target invariants:
 *
 * 1. ONE canonical physical-key identity (aliases and modifier order can
 *    never bypass conflict / leader collision).
 * 2. declared / effective / shadowed / conflicted rules are distinct —
 *    runtime, /help, /keybindings, footer and editor-submit sync see the
 *    SAME facts; nothing advertises a key that cannot fire.
 * 3. editor-owned submit lives in the unified rule model (conflict /
 *    shadow / fail-soft all apply), while direct submit stays on the fork
 *    editor path.
 * 4. leader availability is unified: Escape completions rejected,
 *    zero-effective leader has no machine, leader obeys action
 *    predicates, viewer blocks direct/leader/remap alike.
 * 5. a declined Host action falls through to editor/plugin — never
 *    re-reserved.
 *
 * Several of these currently FAIL (they are the convergence target).
 * @module @xmoon76/dsh-pi-tui/keybinding-convergence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesKey } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import { deriveKeybindingContext } from '../src/keybindings/context.ts'
import { InputRouter } from '../src/input-router.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const editorContext = deriveKeybindingContext({ focusedSeat: 'editor' })

// ── 4.1 canonical identity ────────────────────────────────────────────────

test('4.1a esc and escape are the SAME physical key (conflict)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.history.search': 'escape',
    'app.todo.toggle': 'esc',
  }))
  // The two USER rules collide on the canonical escape key and are
  // deactivated — neither action may fire on Esc. (The BUILTIN
  // app.agent.interrupt on escape legitimately survives.)
  assert.equal(manager.resolve('\x1b', editorContext)?.action, 'app.agent.interrupt',
    'the conflicting aliases must not fire — only the surviving builtin interrupt may')
  assert.deepEqual(manager.keysFor('app.history.search'), [], 'the conflicted history must not keep escape')
  assert.deepEqual(manager.keysFor('app.todo.toggle'), [], 'the conflicted todo must not keep esc')
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')),
    `no conflict diagnostic for aliases: ${manager.diagnosticsList().join(' | ')}`)
})

test('4.1b enter and return are the SAME physical key (conflict)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.history.search': 'enter',
    'app.todo.toggle': 'return',
  }))
  // The two USER rules conflict and deactivate; the surviving Enter rule is
  // the EDITOR-OWNED builtin submit (owner-aware winner selection — the
  // resolver reports WHO executes, it never erases the key). The host
  // ladder must NOT consume the editor-owned winner.
  assert.equal(manager.resolve('\r', editorContext)?.action, 'app.input.submit',
    'enter/return aliases must conflict — only the builtin editor-owned submit survives')
  assert.equal(manager.resolve('\r', editorContext)?.owner, 'editor')
  assert.equal(manager.hostResolves('\r', editorContext), false,
    'the surviving editor-owned submit must not be host-resolved')
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')))
})

test('4.1c modifier order is canonicalized (ctrl+shift+p == shift+ctrl+p)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.history.search': 'ctrl+shift+p',
    'app.todo.toggle': 'shift+ctrl+p',
  }))
  assert.equal(manager.resolve('\x1b[112;6u', editorContext), undefined,
    'modifier-order variants must conflict (same canonical key)')
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')))
})

test('4.1d leader prefix alias (leader: esc) collides with the escape interrupt', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'esc',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  assert.equal(manager.leaderMachine(), undefined,
    'leader: esc must collide with the default escape interrupt and be disabled')
  assert.ok(manager.diagnosticsList().some(message => message.includes('active host key')),
    `no leader collision diagnostic: ${manager.diagnosticsList().join(' | ')}`)
})

test('4.1e leader completion aliases are ambiguous (enter vs return)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: {
      'app.history.search': '<leader>enter',
      'app.todo.toggle': '<leader>return',
    },
  }))
  assert.equal(manager.leaderMachine()?.leaderBindings.length ?? 0, 0,
    'enter/return completions must be ambiguous — neither fires')
  assert.ok(manager.diagnosticsList().some(message => message.includes('ambiguous')))
})

// ── 4.2 duplicate direct key ──────────────────────────────────────────────

test('4.2a a duplicate direct key dedupes (no self-conflict)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.input.steer': ['ctrl+s', 'ctrl+s'],
  }))
  assert.ok(!manager.diagnosticsList().some(message => message.includes('conflict')),
    `duplicate keys of ONE action must not self-conflict: ${manager.diagnosticsList().join(' | ')}`)
  assert.deepEqual(manager.keysFor('app.input.steer'), ['ctrl+s'])
  assert.equal(manager.resolve('\x13', editorContext)?.action, 'app.input.steer')
})

test('4.2b canonicalized duplicates dedupe (ctrl+shift+s == shift+ctrl+s)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.input.steer': ['ctrl+shift+s', 'shift+ctrl+s'],
  }))
  assert.ok(!manager.diagnosticsList().some(message => message.includes('conflict')))
  assert.deepEqual(manager.keysFor('app.input.steer'), ['ctrl+shift+s'])
})

// ── 4.3 priority shadow: runtime == UI ────────────────────────────────────

test('4.3 priority shadow: the shadowed action is NOT advertised', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.todo.toggle': 'ctrl+s' }))
  assert.equal(manager.resolve('\x13', editorContext)?.action, 'app.todo.toggle')
  assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+s'])
  assert.deepEqual(manager.keysFor('app.input.steer'), [],
    'the shadowed builtin ctrl+s must NOT be advertised for steer')
  assert.equal(manager.keyHint('app.input.steer'), '',
    'steer must not advertise a shadowed Ctrl+S')
  const snapshot = manager.snapshot()
  const steerRow = snapshot.bindings.find(binding => binding.action === 'app.input.steer')
  assert.equal(steerRow, undefined,
    'the snapshot must not carry a shadowed steer row')
})

// ── 4.4 conflict: no fabricated builtin fallback ──────────────────────────

test('4.4 conflict: no fabricated Ctrl+R / Ctrl+T fallback', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.history.search': 'ctrl+x',
    'app.todo.toggle': 'ctrl+x',
  }))
  assert.equal(manager.resolve('\x18', editorContext), undefined, 'neither conflicting rule fires')
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')))
  const snapshot = manager.snapshot()
  const historyRow = snapshot.bindings.find(binding => binding.action === 'app.history.search')
  assert.equal(historyRow, undefined,
    'a conflicted user override must NOT fall back to the builtin Ctrl+R')
  const todoRow = snapshot.bindings.find(binding => binding.action === 'app.todo.toggle')
  assert.equal(todoRow, undefined,
    'a conflicted user override must NOT fall back to the builtin Ctrl+T')
})

// ── 4.6 leader dead bindings ──────────────────────────────────────────────

test('4.6a <leader>escape is rejected by the parser', () => {
  const parsed = parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.history.search': '<leader>escape' },
  })
  assert.deepEqual(parsed.leaderBindings, [],
    'escape completion must be parser-rejected (pending-cancel contract)')
  assert.ok(parsed.diagnostics.some(message => message.includes('leader')))
})

test('4.6b zero effective completions → no leader machine', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: {
      'app.history.search': '<leader>r',
      'app.todo.toggle': '<leader>r',
    },
  }))
  assert.equal(manager.leaderMachine(), undefined,
    'an all-ambiguous leader must not exist (Ctrl+X must not enter a dead pending state)')
})

// ── 4.7 leader obeys the action predicate ─────────────────────────────────

test('4.7 leader completion obeys the action context predicate', async () => {
  const vt = new VirtualTerminal(80, 24)
  let tasksOpened = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onOpenTasks: () => { tasksOpened += 1 },
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  await vt.waitForRender()
  // Editor has text → the tasks predicate is false → the leader must NOT open tasks.
  app.setDraft('text')
  await vt.waitForRender()
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('t')
  await vt.waitForRender()
  assert.equal(tasksOpened, 0, 'a non-empty editor must not open tasks via the leader')
  // Empty editor + tasks ACTIVE → opens (the predicate needs live tasks).
  app.setDraft('')
  app.setTasks([{ id: 'job-1', label: 'bash', status: 'running', kind: 'job' }])
  await vt.waitForRender()
  vt.sendInput('\x18')
  await vt.waitForRender()
  vt.sendInput('t')
  await vt.waitForRender()
  assert.equal(tasksOpened, 1, 'empty editor + active tasks must open tasks via the leader')
  app.stop()
})

// ── 4.8 remapped interrupt ────────────────────────────────────────────────

test('4.8 a remapped interrupt (ctrl+x) keeps its semantic behavior', async () => {
  const vt = new VirtualTerminal(80, 24)
  const cancels: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels.push('cancel') },
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' }))
  await vt.waitForRender()
  // Busy: ctrl+x must interrupt (the semantic action), never fall through
  // to the editor as a plain chord.
  app.setBusy(true)
  await vt.waitForRender()
  vt.sendInput('\x18')
  await vt.waitForRender()
  assert.deepEqual(cancels, ['cancel'], 'a remapped interrupt must cancel the busy agent')
  app.stop()
})

// ── 4.10 viewer stale double-Esc ──────────────────────────────────────────

test('4.10 a real armed window is disarmed by the viewer-close Esc', async () => {
  const vt = new VirtualTerminal(80, 24)
  let singleEscapes = 0
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // First main Esc declines (arms the window); EVERY viewer-close Esc
    // consumes (run the close path). The FINAL main Esc declines again —
    // handleInterruptAction must then genuinely check (and find disarmed)
    // lastEscapeAt.
    onSingleEscape: () => { singleEscapes += 1; return singleEscapes === 2 ? true : false },
    onCancel: () => { cancels += 1 },
  })
  app.start()
  // First main Esc: not consumed → handleInterruptAction ARMS the window.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 1)
  // Open + close the read-only viewer with Esc (the close consumes).
  app.setViewerMode({ parentSessionId: 's', childSessionId: 'c', label: 'c', mode: 'one-shot', activity: 'inactive' })
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 2, 'the viewer-close Esc ran the close path')
  // REALLY return to main: the viewer is gone, so the next Esc enters
  // handleInterruptAction (not the viewer-close branch).
  app.setViewerMode(undefined)
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 3, 'the third Esc runs the main interrupt path (viewer closed)')
  assert.equal(cancels, 0, 'a stale window must not cancel after the viewer close disarmed it')
  app.stop()
})

// ── 4.9 dispatcher decline remainder ─────────────────────────────────────

test('4.9a a declined host action is not re-reserved (reaches the plugin)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // NO onClipboardPaste handler → the host dispatcher DECLINES.
    onExtensionAction: (action: string) => { actions.push(action) },
  }, {
    // A plugin binds Ctrl+V. With pasteMedia's host handler absent, the
    // declined key must reach the plugin dispatch — never be swallowed
    // by a re-reservation of the same (declined) host action.
    pluginActionFor: (key) => key.key === 'v' && key.ctrl ? 'open-search' : undefined,
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x16') // ctrl+v
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'],
    'a declined host action must fall through to the plugin remainder, not be re-reserved')
  app.stop()
})

test('4.9b a declined host action reaches a REPLACEMENT editor', async () => {
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action: string) => { actions.push(action) },
  }, {
    pluginActionFor: (key) => key.key === 'v' && key.ctrl ? 'open-search' : undefined,
    editorRegistry: registry,
  })
  app.start()
  // Register a replacement editor that DECLINES Ctrl+V (handleInput
  // returns undefined). The declined host pasteMedia action must reach
  // the replacement editor first, then the plugin.
  registry.register({
    id: 'declining',
    priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'declining' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      focused: true,
      handleInput: () => false, // declines
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // pasteMedia has no host handler → declined; the replacement editor
  // declines too → the plugin binding fires (the full remainder chain).
  vt.sendInput('\x16') // ctrl+v
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'the declined key must reach the plugin after the editor declines')
  app.stop()
})

// ── 4.11 reserved-unimplemented actions ──────────────────────────────────

test('4.11 reserved session/model actions are not user-configurable', () => {
  const parsed = parseUserKeybindings({ 'app.session.new': 'ctrl+n' })
  assert.deepEqual(parsed.bindings, {}, 'a reserved action must not accept a user binding')
  assert.ok(parsed.diagnostics.some(message => message.includes('not user-configurable')),
    `no diagnostic for a reserved action: ${parsed.diagnostics.join(' | ')}`)
  // Same for model.
  const parsedModel = parseUserKeybindings({ 'app.model.open': 'ctrl+m' })
  assert.deepEqual(parsedModel.bindings, {})
  assert.ok(parsedModel.diagnostics.some(message => message.includes('not user-configurable')))
})

// ── 5.x remapped interrupt: semantic core, double-action, no editor steal ──

test('5.1 a remapped interrupt (ctrl+x) does NOT enter the physical-Escape editor seams', async () => {
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const cancels: number[] = []
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels.push(1) },
  }, {
    editorRegistry: registry,
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' }))
  // A replacement editor whose handleInput CONSUMES Ctrl+X — the remapped
  // interrupt must NOT be routed to it (a replacement editor's Esc seams
  // belong to the PHYSICAL Escape key only, convergence §5).
  registry.register({
    id: 'consuming',
    priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'vim' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      focused: true,
      handleInput: () => true, // consumes everything
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  app.setBusy(true)
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x — the remapped interrupt
  await vt.waitForRender()
  assert.deepEqual(cancels, [1], 'a remapped interrupt must interrupt the busy agent, never the editor')
  app.stop()
})

test('5.2 a remapped interrupt keeps its consecutive-press idle semantics', async () => {
  const vt = new VirtualTerminal(80, 24)
  let cancels = 0
  let rewinds = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
    onRewind: () => { rewinds += 1 },
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' }))
  await vt.waitForRender()
  // Idle: two Ctrl+X presses within the window = the idle double action
  // (rewind on an empty editor). The remapped key must NOT be disarmed by
  // its own first press (convergence §5 finding).
  vt.sendInput('\x18')
  await vt.waitForRender()
  vt.sendInput('\x18')
  await vt.waitForRender()
  assert.equal(rewinds, 1, 'two remapped-interrupt presses must fire the idle double action')
  app.stop()
})

test('5.3 Shift+Enter cannot be bound to submit (the editor newline key)', () => {
  const parsed = parseUserKeybindings({ 'app.input.submit': 'shift+enter' })
  assert.deepEqual(parsed.bindings, {}, 'shift+enter submit must be rejected')
  assert.ok(parsed.diagnostics.some(message => message.includes('newline')),
    `no diagnostic for shift+enter submit: ${parsed.diagnostics.join(' | ')}`)
  // The alias spelling (shift+return) is rejected the same way.
  const aliased = parseUserKeybindings({ 'app.input.submit': 'shift+return' })
  assert.deepEqual(aliased.bindings, {})
  assert.ok(aliased.diagnostics.some(message => message.includes('newline')))
})

// ── 4.5 submit participates in conflict (P1 finding) ──────────────────────

test('4.5a a CONFLICTED submit override fails soft back to the builtin Enter', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.input.submit': 'ctrl+x',
    'app.history.search': 'ctrl+x',
  }))
  // Both user rules conflict on ctrl+x: neither fires — but the dead
  // override must NOT disable Enter (fail-soft on the EFFECTIVE rules).
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')))
  assert.deepEqual(manager.editorSubmitKeysFor(), ['enter'],
    'a conflicted submit override must restore the builtin Enter')
  assert.equal(manager.keyHint('app.input.submit'), 'Enter')
  assert.equal(manager.resolve('\x18', editorContext), undefined, 'the conflicted ctrl+x fires nothing')
})

test('4.5b an explicit false submit stays strictly disabled', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.input.submit': false }))
  assert.deepEqual(manager.editorSubmitKeysFor(), [], 'false must strictly disable submit')
  assert.equal(manager.keyHint('app.input.submit'), '')
})

test('4.5c another action taking Enter does NOT leave submit advertised', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.todo.toggle': 'enter' }))
  // Todo (user, 200) shadows the builtin submit Enter (editor, 100): the
  // runtime resolves Enter to Todo; submit must NOT advertise Enter.
  assert.equal(manager.resolve('\r', editorContext)?.action, 'app.todo.toggle')
  assert.deepEqual(manager.editorSubmitKeysFor(), [],
    'a shadowed submit Enter must not be advertised')
  assert.equal(manager.keyHint('app.input.submit'), '')
})

// ── leader-only action actually EXECUTES (P1 finding) ────────────────────

test('4.6c a leader-only action actually fires its completion', async () => {
  const vt = new VirtualTerminal(80, 24)
  let fullscreenToggles = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.transcript.toggleFullscreen': '<leader>n' },
  }))
  await vt.waitForRender()
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('n')
  await vt.waitForRender()
  assert.ok(app.isFullscreen(), 'the leader-only action must actually fire (fullscreen on)')
  vt.sendInput('\x18')
  await vt.waitForRender()
  vt.sendInput('n')
  await vt.waitForRender()
  assert.ok(!app.isFullscreen(), 'the leader-only action fires again (fullscreen off)')
  app.stop()
})

// ── priority shadow respects predicates (P2 finding) ──────────────────────

test('4.3b a conditional high-priority rule does not shadow a lower rule when its predicate is false', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.tasks.open': 'ctrl+s' }))
  // tasks.open (user, 200) inherits the empty-editor+tasks predicate;
  // steer (builtin, 100) is on ctrl+s. When the tasks predicate is false
  // (editor non-empty / no tasks), Ctrl+S must still STEER.
  const contextWithTasks = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: true, tasksActive: true })
  const contextNoTasks = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: false, tasksActive: false })
  assert.equal(manager.resolve('\x13', contextWithTasks)?.action, 'app.tasks.open', 'predicate holds → tasks')
  assert.equal(manager.resolve('\x13', contextNoTasks)?.action, 'app.input.steer',
    'predicate false → the shadowed lower rule fires (context-aware shadow)')
})

// ── remapped interrupt double-window (P2 finding) ─────────────────────────

test('4.8b Ctrl+X → Esc → Ctrl+X does NOT fire the idle double action', async () => {
  const vt = new VirtualTerminal(80, 24)
  let rewinds = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onRewind: () => { rewinds += 1 },
  })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' }))
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x — arm the interrupt window
  await vt.waitForRender()
  vt.sendInput('\x1b') // a DIFFERENT key (physical Esc is no longer the trigger)
  await vt.waitForRender()
  vt.sendInput('\x18') // ctrl+x again — must NOT read as a second consecutive trigger
  await vt.waitForRender()
  assert.equal(rewinds, 0, 'an intervening non-trigger key must disarm the window')
  app.stop()
})

// ── legacy collisions rejected (P2 finding) ───────────────────────────────

test('4.11b legacy terminal collisions are rejected bindings', () => {
  for (const key of ['ctrl+[', 'ctrl+j', 'ctrl+m']) {
    const parsed = parseUserKeybindings({ 'app.todo.toggle': key })
    assert.deepEqual(parsed.bindings, {}, `"${key}" must be rejected`)
    assert.ok(parsed.diagnostics.some(message => message.includes('legacy terminals') || message.includes('collides')),
      `no rejection diagnostic for "${key}": ${parsed.diagnostics.join(' | ')}`)
  }
})

// ── stop/start lifecycle (full-review findings) ───────────────────────────

test('5.4 stop() cancels a pending leader sequence', async () => {
  const vt = new VirtualTerminal(80, 24)
  let tasksOpened = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onOpenTasks: () => { tasksOpened += 1 } })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.tasks.open': '<leader>t' },
  }))
  await vt.waitForRender()
  vt.sendInput('\x18') // arm the leader
  await vt.waitForRender()
  app.stop() // stop with the leader pending
  app.start() // restart (fresh lifecycle)
  await vt.waitForRender()
  // Complete the OLD sequence on the NEW surface: it must NOT fire.
  vt.sendInput('t')
  await vt.waitForRender()
  assert.equal(tasksOpened, 0, 'a stopped-then-restarted surface must not fire a stale leader sequence')
  app.stop()
})

test('5.5 stop() clears the interrupt double-action window', async () => {
  const vt = new VirtualTerminal(80, 24)
  let cancels = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => { cancels += 1 } })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b') // first Esc (idle) arms the double window
  await vt.waitForRender()
  app.stop()
  app.start()
  await vt.waitForRender()
  // A post-restart single Esc must NOT read as the second press (which
  // would cancel/rewind an empty session).
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancels, 0, 'stop() must clear the pre-stop double-action window')
  app.stop()
})

test('5.6 a plugin cannot bind the space key (it would swallow typing)', () => {
  // isPrintableKey('space') must be true, so the router never routes a
  // plain space to a plugin binding.
  const router = new InputRouter()
  const result = router.route(' ', { questionActive: false, approvalActive: false, viewerInputMode: 'none', hasOverlay: false, searchActive: false, hostDeclined: false }, () => 'open-search')
  assert.equal(result.kind, 'editor', 'a plain space must reach the editor, never a plugin binding')
})

// ── dynamic plugin keybinding lifecycle (full-review finding) ─────────────

test('5.7 the registry notifies subscribers on register/dispose (dynamic sync)', async () => {
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const registry = new KeybindingRegistry()
  let notified = 0
  const unsubscribe = registry.subscribe(() => { notified += 1 })
  registry.register(
    { id: 'late', key: { key: 'z', ctrl: true, alt: true, shift: false, super: false }, action: 'open-search', description: 'late' },
    'plugin',
  )
  assert.equal(notified, 1, 'register must notify subscribers (the runner resyncs the keymap)')
  const handle = registry.register(
    { id: 'second', key: { key: 'y', ctrl: true, alt: false, shift: false, super: false }, action: 'open-search', description: 'second' },
    'plugin',
  )
  assert.equal(notified, 2)
  handle.dispose()
  assert.equal(notified, 3, 'dispose must notify subscribers (an unloaded binding stops firing)')
  unsubscribe()
  registry.register(
    { id: 'after-unsub', key: { key: 'x', ctrl: true, alt: false, shift: false, super: false }, action: 'open-search', description: 'after' },
    'plugin',
  )
  assert.equal(notified, 3, 'unsubscribe must stop notifications')
  // The runner wiring (index.ts) subscribes and calls setPluginRules on
  // every notification — the pieces are now covered: registry notify +
  // the manager's setPluginRules resync.
  const manager = new HostKeybindingManager()
  manager.setPluginRules([{ id: 'late', action: 'app.transcript.toggleFullscreen', key: 'ctrl+alt+z' }])
  assert.deepEqual(manager.keysFor('app.transcript.toggleFullscreen'), ['ctrl+alt+z'])
  manager.setPluginRules([])
  assert.deepEqual(manager.keysFor('app.transcript.toggleFullscreen'), [], 'removing the plugin rule stops it')
})

// ── leaderTimeoutMs override (full-review finding) ────────────────────────

test('5.8 the manager leaderTimeoutMs override is applied to the machine', () => {
  const manager = new HostKeybindingManager({ leaderTimeoutMs: 777 })
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.transcript.toggleFullscreen': '<leader>n' },
  }, { leaderTimeoutMs: 1500 }))
  const machine = manager.leaderMachine()
  const cfg = (machine as unknown as { config: { timeoutMs: number } }).config
  assert.equal(cfg.timeoutMs, 777, 'the manager override must win over the config default')
})

// ── plugin id collision + registry canonicalization (round-4 findings) ────

test('5.9 a plugin rule id cannot shadow-deactivate a HOST rule', () => {
  const manager = new HostKeybindingManager()
  // The plugin uses a public id that EQUALS the host builtin ctrl+s rule
  // id. Two plugins claim the same key with colliding ids — the HOST
  // builtin must survive (its rule id is namespaced away).
  manager.setPluginRules([
    { id: 'app.input.steer@builtin:ctrl+s', action: 'app.todo.toggle', key: 'ctrl+t' },
    { id: 'app.input.steer@builtin:ctrl+s', action: 'app.history.search', key: 'ctrl+t' },
  ])
  assert.deepEqual(manager.keysFor('app.input.steer'), ['ctrl+s'],
    'the host builtin steer ctrl+s must survive plugin-id collisions')
})

test('5.10 the registry canonicalizes modifier-order keys and named-key casing', async () => {
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const registry = new KeybindingRegistry()
  // Register ctrl+shift+p; look up by shift+ctrl+p (modifier order
  // canonicalizes to one identity).
  registry.register(
    { id: 'mod-a', key: { key: 'p', ctrl: true, shift: true, alt: false, super: false }, action: 'open-search', description: 'a' },
    'plugin',
  )
  assert.equal(registry.actionFor({ key: 'p', shift: true, ctrl: true, alt: false, super: false }), 'open-search')
  // Named-key casing: register pageUp; look up pageup (the runtime parser
  // lowercases) — convergence finding: both must be the same key.
  registry.register(
    { id: 'page', key: { key: 'pageUp', ctrl: false, alt: false, shift: false, super: false }, action: 'toggle-fullscreen', description: 'page' },
    'plugin',
  )
  assert.equal(registry.actionFor({ key: 'pageup', ctrl: false, alt: false, shift: false, super: false }), 'toggle-fullscreen')
  // Duplicate detection sees canonical-equivalent keys as one.
  assert.throws(() => registry.register(
    { id: 'mod-b', key: { key: 'p', shift: true, ctrl: true, alt: false, super: false }, action: 'open-search', description: 'b' },
    'plugin',
  ), /duplicate keybinding/, 'ctrl+shift+p and shift+ctrl+p must be detected as the same key')
})

test('5.11 a reserved key ALIAS (esc/return) is rejected at registration', async () => {
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const registry = new KeybindingRegistry()
  // Registering the alias spelling of a reserved key must be rejected
  // AFTER canonicalization (convergence finding — the reserved check ran
  // before canonicalize and let `esc`/`return` through).
  assert.throws(() => registry.register(
    { id: 'alias-esc', key: { key: 'esc', ctrl: false, alt: false, shift: false, super: false }, action: 'open-search', description: 'alias' },
    'plugin',
  ), /reserved by the host/, 'esc is the reserved escape and must be rejected')
  assert.throws(() => registry.register(
    { id: 'alias-return', key: { key: 'return', ctrl: false, alt: false, shift: false, super: false }, action: 'open-search', description: 'alias' },
    'plugin',
  ), /reserved by the host/, 'return is the reserved enter and must be rejected')
})

test('5.12 canonical named keys still display as PageUp/PageDown', async () => {
  const { formatKeyId, formatKeyList } = await import('../src/keybindings/hints.ts')
  const { canonicalizeKeyId } = await import('../src/keybindings/key-identity.ts')
  assert.equal(canonicalizeKeyId('pageUp' as never), 'pageup')
  assert.equal(canonicalizeKeyId('pageDown' as never), 'pagedown')
  // The DISPLAY of the canonical form must be the proper label (a
  // lowercase canonical key must not leak into UI hints).
  assert.equal(formatKeyId('pageup' as never), 'PageUp')
  assert.equal(formatKeyId('pagedown' as never), 'PageDown')
  assert.equal(formatKeyList(['pageup'] as never), 'PageUp')
  // The keymap's canonical rules and the hint renderers agree. The user
  // writes the fork-grammar spelling (pageUp); the parser canonicalizes it
  // to pageup internally and the hint renders PageUp.
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': 'pageUp' }))
  assert.equal(manager.keyHint('app.transcript.toggleExpand'), 'PageUp',
    'a canonical pageup binding must be advertised as PageUp')
  assert.deepEqual(manager.keysFor('app.transcript.toggleExpand'), ['pageup'])
  // The LOWERCASE spelling (pageup) is the same physical key at parse
  // time — one canonical identity regardless of casing.
  const lower = new HostKeybindingManager()
  lower.setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': 'pageup' }))
  assert.deepEqual(lower.keysFor('app.transcript.toggleExpand'), ['pageup'])
  assert.equal(lower.keyHint('app.transcript.toggleExpand'), 'PageUp')
})

// ── uppercase aliases + leader legacy collisions + LF submit (round-7) ────

test('5.13 uppercase aliases canonicalize to the same key (ESC/escape, RETURN/enter)', async () => {
  const { canonicalizeKeyId } = await import('../src/keybindings/key-identity.ts')
  assert.equal(canonicalizeKeyId('ESC' as never), 'escape')
  assert.equal(canonicalizeKeyId('RETURN' as never), 'enter')
  assert.equal(canonicalizeKeyId('CTRL+RETURN' as never), 'ctrl+enter')
  assert.equal(canonicalizeKeyId('Shift+Ctrl+ESC' as never), 'ctrl+shift+escape')
  // An uppercase-alias config conflicts with the canonical spelling.
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.history.search': 'ESC', 'app.todo.toggle': 'escape' }))
  assert.deepEqual(manager.keysFor('app.history.search'), [], 'ESC and escape must conflict as one key')
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')))
})

test('5.14 the leader prefix and completions reject legacy lifecycle collisions', () => {
  // leader: ctrl+[ would swallow Esc on legacy terminals.
  const leader = parseUserKeybindings({ leader: 'ctrl+[', bindings: { 'app.tasks.open': '<leader>t' } })
  assert.equal(leader.leader, undefined, 'a legacy-collision leader must be rejected')
  assert.ok(leader.diagnostics.some(message => message.includes('legacy terminals')))
  // A completion on ctrl+j would swallow Enter on legacy terminals.
  const completion = parseUserKeybindings({ leader: 'ctrl+x', bindings: { 'app.tasks.open': '<leader>ctrl+j' } })
  assert.deepEqual(completion.leaderBindings, [], 'a legacy-collision completion must be rejected')
  assert.ok(completion.diagnostics.some(message => message.includes('legacy terminals')))
})

test('5.15 a disabled submit never fires on LF/Enter through the host editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': false }))
  await vt.waitForRender()
  app.setDraft('stays')
  await vt.waitForRender()
  vt.sendInput('\r') // Enter
  await vt.waitForRender()
  vt.sendInput('\n') // LF (Ctrl+J)
  await vt.waitForRender()
  assert.deepEqual(submitted, [], 'a disabled submit must not fire on Enter or LF')
  app.stop()
})

// ── 6.x owner-aware winner selection (round-9 findings) ────────────────────

test('6.1a submit remapped onto a HOST key: the editor-owned winner submits, steer NEVER fires', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const steered: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text: string) => submitted.push(text),
    onSteer: (text: string) => steered.push(text),
    onExit: () => {},
  })
  app.start()
  // The user moves submit onto Ctrl+S — the steer BUILTIN's key. The user
  // rule (200) beats the builtin (100), and the WINNER's owner decides the
  // executor: editor → the fork editor submits. The host ladder must NOT
  // dispatch steer first (round-9 P1 finding: the resolver used to skip
  // editor-owned rules BEFORE picking a winner, so steer won at runtime
  // while the read model advertised submit).
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.submit': 'ctrl+s' }))
  await vt.waitForRender()
  app.setDraft('draft')
  await vt.waitForRender()
  vt.sendInput('\x13') // ctrl+s
  await vt.waitForRender()
  assert.deepEqual(submitted, ['draft'], 'Ctrl+S must submit through the editor-owned winner')
  assert.deepEqual(steered, [], 'Ctrl+S must NEVER steer')
  // The read model agrees: Ctrl+S belongs to submit only.
  assert.deepEqual(app.keybindingsManager().keysFor('app.input.submit'), ['ctrl+s'])
  assert.deepEqual(app.keybindingsManager().keysFor('app.input.steer'), [],
    'steer must not advertise the ctrl+s it lost')
  const snapshot = app.keybindingsManager().snapshot()
  const submitRow = snapshot.bindings.find(binding => binding.action === 'app.input.submit')
  assert.deepEqual(submitRow?.keys, ['ctrl+s'], 'the snapshot advertises submit on Ctrl+S')
  const steerRow = snapshot.bindings.find(binding => binding.action === 'app.input.steer')
  assert.equal(steerRow, undefined, 'the snapshot must not carry steer on ctrl+s')
  app.stop()
})

test('6.1b resolve() carries the EXECUTING owner; hostResolves follows the winner', () => {
  // Default surface: the builtin Enter resolves to the EDITOR-owned submit.
  const plain = new HostKeybindingManager()
  assert.equal(plain.resolve('\r', editorContext)?.action, 'app.input.submit')
  assert.equal(plain.resolve('\r', editorContext)?.owner, 'editor')
  assert.equal(plain.hostResolves('\r', editorContext), false,
    'the editor-owned winner must never be host-resolved')
  // A host-owned key stays host-resolved.
  assert.equal(plain.resolve('\x13', editorContext)?.owner, 'host') // ctrl+s → steer
  assert.equal(plain.hostResolves('\x13', editorContext), true)
  // submit: ctrl+s — the editor-owned user rule WINS the key; the host
  // must not resolve it.
  const remapped = new HostKeybindingManager()
  remapped.setUserConfiguration(parseUserKeybindings({ 'app.input.submit': 'ctrl+s' }))
  const resolution = remapped.resolve('\x13', editorContext)
  assert.equal(resolution?.action, 'app.input.submit')
  assert.equal(resolution?.owner, 'editor')
  assert.equal(resolution?.ruleId, 'app.input.submit@user:ctrl+s')
  assert.equal(remapped.hostResolves('\x13', editorContext), false)
  // A plugin-owner winner stays out of hostResolves too.
  const withPlugin = new HostKeybindingManager()
  withPlugin.setPluginRules([{ id: 'p1', action: 'app.todo.toggle', key: 'ctrl+alt+x' }])
  assert.equal(withPlugin.resolve('\x1b[120;7u', editorContext)?.owner, 'plugin')
  assert.equal(withPlugin.hostResolves('\x1b[120;7u', editorContext), false)
})

test('6.2 submit on fork-editor PRE-SUBMIT keys is rejected (they can never fire)', () => {
  // The fork editor dispatches these bindings BEFORE its submit check
  // (packages/pi-tui/src/components/editor.ts), so a submit remap onto one
  // of them would be advertised by the read model but could never fire.
  // Same unsupported-key policy as the Shift+Enter newline rejection
  // (round-9 finding: submit: tab silently stayed autocomplete).
  const preSubmit = [
    'tab', 'backspace', 'delete', 'ctrl+a', 'ctrl+e', 'ctrl+u', 'ctrl+k',
    'ctrl+w', 'ctrl+y', 'ctrl+c', 'ctrl+d', 'ctrl+-', 'alt+backspace',
    'alt+delete', 'alt+d', 'alt+y', 'alt+b', 'alt+f', 'alt+left', 'alt+right',
    'ctrl+left', 'ctrl+right', 'home', 'end', 'ctrl+home', 'ctrl+end',
    'shift+backspace', 'shift+delete',
  ]
  for (const key of preSubmit) {
    const parsed = parseUserKeybindings({ 'app.input.submit': key })
    assert.deepEqual(parsed.bindings, {}, `submit on "${key}" must be rejected`)
    assert.ok(parsed.diagnostics.some(message => message.includes('editor consumes')),
      `no rejection diagnostic for "${key}": ${parsed.diagnostics.join(' | ')}`)
  }
  // The alias spellings canonicalize onto the same rejected keys.
  const aliased = parseUserKeybindings({ 'app.input.submit': 'shift+Backspace' })
  assert.deepEqual(aliased.bindings, {}, 'shift+Backspace must canonicalize into the rejected set')
  assert.ok(aliased.diagnostics.some(message => message.includes('editor consumes')))
  // A key the fork editor does NOT consume before submit stays bindable:
  // ctrl+backspace is not in the fork's editor keybindings, so a submit
  // remap on it genuinely reaches the submit check.
  const works = parseUserKeybindings({ 'app.input.submit': 'ctrl+backspace' })
  assert.deepEqual(works.bindings, { 'app.input.submit': 'ctrl+backspace' })
  assert.ok(!works.diagnostics.some(message => message.includes('editor consumes')))
  // OTHER actions may still bind an editor-pre-submit key: the HOST ladder
  // consumes them before the editor, so they really fire.
  const other = parseUserKeybindings({ 'app.todo.toggle': 'tab' })
  assert.deepEqual(other.bindings, { 'app.todo.toggle': 'tab' }, 'tab stays bindable for a host action')
  assert.ok(!other.diagnostics.some(message => message.includes('editor consumes')))
})

test('6.3 mixed direct + leader submit: BOTH triggers stay, Enter is removed', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text: string) => submitted.push(text), onExit: () => {} })
  app.start()
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.input.submit': ['ctrl+z', '<leader>s'] },
  }))
  await vt.waitForRender()
  // The DIRECT key survives the leader sequence (round-9 finding: any
  // leader binding used to clear EVERY direct editor key).
  assert.deepEqual(app.keybindingsManager().editorSubmitKeysFor(), ['ctrl+z'])
  assert.equal(app.keybindingsManager().keyHint('app.input.submit'), 'Ctrl+Z / Leader S')
  const snapshot = app.keybindingsManager().snapshot()
  const submitRow = snapshot.bindings.find(binding => binding.action === 'app.input.submit')
  assert.deepEqual(submitRow?.keys, ['ctrl+z'])
  assert.deepEqual(submitRow?.leaderKeys, ['s'])
  // Ctrl+Z submits…
  app.setDraft('one')
  await vt.waitForRender()
  vt.sendInput('\x1a') // ctrl+z
  await vt.waitForRender()
  assert.deepEqual(submitted, ['one'], 'the direct key submits')
  // …Enter does NOT…
  app.setDraft('two')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['one'], 'Enter must not submit (the override replaced the builtin)')
  // …and the leader sequence submits too.
  app.setDraft('three')
  await vt.waitForRender()
  vt.sendInput('\x18') // leader
  await vt.waitForRender()
  vt.sendInput('s')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['one', 'three'], 'the leader sequence must submit')
  app.stop()
})

test('6.4 canonical casing: ctrl+A == ctrl+a; SPACE/Space are printable', () => {
  // Single-character bases canonicalize to lowercase — ctrl+A and ctrl+a
  // are the SAME physical key and must conflict (round-9 finding: the
  // canonicalizer skipped single-char bases, the fork runtime lowercases,
  // so two spellings of one key coexisted).
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    'app.history.search': 'ctrl+A',
    'app.todo.toggle': 'ctrl+a',
  }))
  assert.deepEqual(manager.keysFor('app.history.search'), [], 'ctrl+A and ctrl+a must conflict')
  assert.deepEqual(manager.keysFor('app.todo.toggle'), [])
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')),
    `no conflict diagnostic: ${manager.diagnosticsList().join(' | ')}`)
  // The canonical spelling is lowercase everywhere.
  const single = new HostKeybindingManager()
  single.setUserConfiguration(parseUserKeybindings({ 'app.transcript.toggleExpand': 'ctrl+A' }))
  assert.deepEqual(single.keysFor('app.transcript.toggleExpand'), ['ctrl+a'])
  // UPPERCASE space spellings are still the printable spacebar: rejected as
  // direct bindings and as the leader prefix (round-9 finding: the policy
  // checks ran on the RAW spelling, so `SPACE` bypassed the typing guard).
  for (const spelling of ['SPACE', 'Space']) {
    const direct = parseUserKeybindings({ 'app.todo.toggle': spelling })
    assert.deepEqual(direct.bindings, {}, `${spelling} direct must be rejected`)
    assert.ok(direct.diagnostics.some(message => message.includes('plain printable')),
      `no printable rejection for ${spelling}: ${direct.diagnostics.join(' | ')}`)
    const leader = parseUserKeybindings({ leader: spelling, bindings: { 'app.tasks.open': '<leader>t' } })
    assert.equal(leader.leader, undefined, `${spelling} leader must be rejected`)
  }
})

test('6.5 a working submit remap is not advertised alongside the replaced Enter (snapshot)', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.input.submit': 'ctrl+x' }))
  assert.deepEqual(manager.editorSubmitKeysFor(), ['ctrl+x'])
  assert.equal(manager.keyHint('app.input.submit'), 'Ctrl+X')
  // Round-9 finding: the keymap snapshot iterated the raw top-trigger set
  // and re-advertised the builtin Enter next to the working override —
  // /keybindings lied while /help was right. Snapshot now projects the
  // SAME visible rules as keysFor/keyHint/editorSubmitKeysFor.
  const binding = manager.snapshot().bindings.find(entry => entry.action === 'app.input.submit')
  assert.ok(binding !== undefined)
  assert.deepEqual(binding!.keys, ['ctrl+x'], 'the snapshot must not re-advertise the replaced Enter')
})

test('6.5b a LEADER-ONLY submit override removes the builtin Enter from the snapshot too', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: { 'app.input.submit': '<leader>s' },
  }))
  // The leader-only override removes Enter from the editor sync and the
  // hints (review round: the leader is the ONLY trigger) — the snapshot
  // must agree (external-review finding: it still advertised the builtin
  // Enter, so /keybindings lied while Enter was inert at runtime).
  assert.deepEqual(manager.editorSubmitKeysFor(), [], 'the leader is the only submit trigger')
  assert.deepEqual(manager.keysFor('app.input.submit'), [])
  assert.equal(manager.keyHint('app.input.submit'), 'Leader S')
  const binding = manager.snapshot().bindings.find(entry => entry.action === 'app.input.submit')
  assert.ok(binding !== undefined)
  assert.deepEqual(binding!.keys, [], 'the snapshot must not advertise the removed Enter')
  assert.deepEqual(binding!.leaderKeys, ['s'], 'the leader sequence is carried')
})

test('6.6 a conditional top rule does not permanently hide the fallback in the read model', () => {
  const manager = new HostKeybindingManager()
  manager.setUserConfiguration(parseUserKeybindings({ 'app.tasks.open': 'ctrl+s' }))
  // tasks.open (conditional — the empty-editor affordance predicate) claims
  // ctrl+s at priority 200; steer's builtin ctrl+s (100) is the CONTEXT
  // FALLBACK. The read model must show BOTH (round-9 finding: the static
  // read model shadowed the lower rule forever, so keyHint/snapshot hid
  // steer even in contexts where steer genuinely fires).
  assert.ok(manager.keysFor('app.tasks.open').includes('ctrl+s'), 'tasks.open advertises its conditional ctrl+s claim')
  assert.deepEqual(manager.keysFor('app.input.steer'), ['ctrl+s'],
    'a conditional claim must not hide the fallback in the read model')
  assert.equal(manager.keyHint('app.input.steer'), 'Ctrl+S')
  const steerRow = manager.snapshot().bindings.find(entry => entry.action === 'app.input.steer')
  assert.ok(steerRow !== undefined, 'the snapshot must carry the fallback steer row')
  assert.deepEqual(steerRow!.keys, ['ctrl+s'])
  // The runtime still resolves by the predicate (the fallback FIRES when
  // the conditional claim cannot).
  const noTasks = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: false, tasksActive: false })
  assert.equal(manager.resolve('\x13', noTasks)?.action, 'app.input.steer')
  // An UNCONDITIONAL higher rule still shadows in the read model.
  const unconditional = new HostKeybindingManager()
  unconditional.setUserConfiguration(parseUserKeybindings({ 'app.todo.toggle': 'ctrl+s' }))
  assert.deepEqual(unconditional.keysFor('app.input.steer'), [], 'an unconditional top trigger still hides the lower rule')
})

// ── 7.x Stable plugin boundary + legacy C0 inventory (round-12 findings) ───

test('7.1 the registry REJECTS a non-public action string (runtime whitelist)', async () => {
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const registry = new KeybindingRegistry()
  // A public TuiAction registers fine.
  registry.register(
    { id: 'good', key: { key: 'x', ctrl: true, alt: false, shift: false, super: false }, action: 'open-search', description: 'ok' },
    'plugin',
  )
  // A Host-private app.* action smuggled through the PUBLIC API must be
  // rejected at registration — the registry has no runtime action
  // whitelist, so a JS/`as any` plugin could otherwise register
  // `app.exit.request` and the plugin-owner winner would reach the Host
  // dispatcher (capability boundary — review finding). The public
  // TuiAction set is the ONLY thing a plugin may trigger.
  assert.throws(() => registry.register(
    { id: 'smuggled-exit', key: { key: 'y', ctrl: true, alt: false, shift: false, super: false }, action: 'app.exit.request' as never, description: 'bad' },
    'plugin',
  ), /not a public TuiAction/, 'a Host-private action string must be rejected')
  // Any arbitrary string is rejected the same way.
  assert.throws(() => registry.register(
    { id: 'smuggled-arbitrary', key: { key: 'z', ctrl: true, alt: false, shift: false, super: false }, action: 'definitely-not-an-action' as never, description: 'bad' },
    'plugin',
  ), /not a public TuiAction/)
  // The rejected actions never entered the registry.
  assert.equal(registry.snapshot().bindings.length, 1)
})

test('7.2 a plugin-owner winner NEVER enters the Host dispatcher', async () => {
  const vt = new VirtualTerminal(80, 24)
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => { exits += 1 },
  })
  app.start()
  // A smuggled plugin rule (the internal keymap path) carrying a
  // HOST-private action — the registry rejects it at registration, and
  // the host dispatcher must never execute it either (review finding:
  // plugin-owner winners used to enter dispatchResolvedAction, so an
  // `app.exit.request` string would run the Host exit path).
  app.keybindingsManager().setPluginRules([{ id: 'smuggled', action: 'app.exit.request' as never, key: 'ctrl+alt+x' }])
  await vt.waitForRender()
  vt.sendInput('\x1b\x18') // ctrl+alt+x
  await vt.waitForRender()
  assert.equal(exits, 0, 'the Host dispatcher must never execute a plugin-supplied action string')
  // The resolution is plugin-owned (the remainder owns it, not the Host).
  const resolution = app.keybindingsManager().resolve('\x1b[120;7u', deriveKeybindingContext({ focusedSeat: 'editor' }))
  assert.equal(resolution?.owner, 'plugin', 'the winner is plugin-owned')
  app.stop()
})

test('7.2b a legit plugin action still executes through the Stable remainder', async () => {
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: (action: string) => { actions.push(action) },
  }, {
    // The router's plugin stage maps the same key to the public action.
    pluginActionFor: (key) => key.key === 'x' && key.ctrl && key.alt ? 'open-search' : undefined,
  })
  app.start()
  app.keybindingsManager().setPluginRules([{ id: 'plugin', action: 'open-search', key: 'ctrl+alt+x' }])
  await vt.waitForRender()
  vt.sendInput('\x1b\x18') // ctrl+alt+x
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'the plugin action executes through the Stable plugin remainder')
  app.stop()
})

test('7.3 the registry rejects plain printable keys (space/letters) at registration', async () => {
  const { KeybindingRegistry } = await import('../src/keybinding-registry.ts')
  const registry = new KeybindingRegistry()
  // The router keeps printable keys with the editor's text entry, so a
  // plugin binding on one can never fire — the registration must be
  // rejected, not advertised as an effective rule (review finding).
  assert.throws(() => registry.register(
    { id: 'space', key: { key: 'space', ctrl: false, alt: false, shift: false, super: false }, action: 'open-search', description: 'space' },
    'plugin',
  ), /printable/, 'the spacebar must be rejected at registration')
  assert.throws(() => registry.register(
    { id: 'letter', key: { key: 'a', ctrl: false, alt: false, shift: false, super: false }, action: 'open-search', description: 'a' },
    'plugin',
  ), /printable/, 'a bare letter must be rejected at registration')
  // A MODIFIED chord stays bindable (it really reaches the plugin stage).
  registry.register(
    { id: 'ctrl-space', key: { key: 'space', ctrl: true, alt: false, shift: false, super: false }, action: 'open-search', description: 'chord' },
    'plugin',
  )
  assert.equal(registry.actionFor({ key: 'space', ctrl: true, alt: false, shift: false, super: false }), 'open-search')
})

test('7.4 a live plugin key disables a colliding leader prefix (never a silent swallow)', () => {
  const manager = new HostKeybindingManager()
  manager.setPluginRules([{ id: 'plugin-x', action: 'app.tasks.open', key: 'ctrl+alt+x' }])
  manager.setUserConfiguration(parseUserKeybindings({
    leader: 'ctrl+alt+x',
    bindings: { 'app.transcript.toggleFullscreen': '<leader>n' },
  }))
  // The leader machine feeds BEFORE the plugin stage, so a leader key
  // that equals a live plugin key would silently swallow the plugin
  // binding while the read model still advertised it (review finding).
  assert.equal(manager.leaderMachine(), undefined, 'the leader must not swallow the plugin key')
  assert.ok(manager.diagnosticsList().some(message => message.includes('leader key') && message.includes('plugin key')),
    `no plugin collision diagnostic: ${manager.diagnosticsList().join(' | ')}`)
  assert.equal(manager.keyHint('app.transcript.toggleFullscreen'), '', 'the dead leader sequence is not advertised')
  assert.ok(manager.keysFor('app.tasks.open').includes('ctrl+alt+x'), 'the plugin binding stays effective')
})

test('7.5 legacy C0 aliases are rejected everywhere (ctrl+i / ctrl+h / ctrl+_)', () => {
  // On legacy terminals Ctrl+I is the Tab byte (0x09), Ctrl+H is
  // Backspace (0x08) and Ctrl+_ / Ctrl+- are 0x1f — indistinguishable
  // from the editor's own keys, so a binding on them is protocol-
  // dependent and unsupported (review finding — same class as
  // ctrl+[/ctrl+j/ctrl+m).
  for (const key of ['ctrl+i', 'ctrl+h', 'ctrl+_']) {
    const direct = parseUserKeybindings({ 'app.todo.toggle': key })
    assert.deepEqual(direct.bindings, {}, `"${key}" direct must be rejected`)
    assert.ok(direct.diagnostics.some(message => message.includes('legacy terminals')),
      `no rejection for "${key}": ${direct.diagnostics.join(' | ')}`)
    const submit = parseUserKeybindings({ 'app.input.submit': key })
    assert.deepEqual(submit.bindings, {}, `"${key}" submit must be rejected`)
    const leader = parseUserKeybindings({ leader: key, bindings: { 'app.tasks.open': '<leader>t' } })
    assert.equal(leader.leader, undefined, `"${key}" leader prefix must be rejected`)
    const completion = parseUserKeybindings({ leader: 'ctrl+x', bindings: { 'app.tasks.open': `<leader>${key}` } })
    assert.deepEqual(completion.leaderBindings, [], `"<leader>${key}" completion must be rejected`)
  }
})

test('7.5b the C0 byte premise: raw \\t / \\x08 / \\x1f are the legacy spellings', () => {
  // Why the rejections exist: the fork's matchesKey accepts the raw
  // control bytes for BOTH spellings of one physical key, so on a legacy
  // terminal a `ctrl+i` binding fires on Tab bytes (and vice versa).
  assert.ok(matchesKey('\t', 'ctrl+i' as never), 'Ctrl+I is the Tab byte on legacy terminals')
  assert.ok(matchesKey('\t', 'tab' as never), '…and the same byte is Tab for the editor')
  assert.ok(matchesKey('\x08', 'ctrl+h' as never), 'Ctrl+H is the Backspace byte on legacy terminals')
  assert.ok(matchesKey('\x08', 'backspace' as never), '…and the same byte is Backspace for the editor')
  assert.ok(matchesKey('\x1f', 'ctrl+_' as never), 'Ctrl+_ is the 0x1f byte')
  assert.ok(matchesKey('\x1f', 'ctrl+-' as never), 'Ctrl+- is the SAME 0x1f byte (the fork maps - to _)')
})
