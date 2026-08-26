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
import { TuiApp } from '../src/tui-app.ts'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import { deriveKeybindingContext } from '../src/keybindings/context.ts'
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
  assert.equal(manager.resolve('\r', editorContext), undefined,
    'enter/return aliases must conflict')
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
    onSingleEscape: () => { singleEscapes += 1; return singleEscapes === 1 ? false : true },
    onCancel: () => { cancels += 1 },
  })
  app.start()
  // First main Esc: NOT consumed → handleEscapeKey ARMS the window.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 1)
  // Open + close the read-only viewer with Esc (the close is consumed).
  app.setViewerMode({ parentSessionId: 's', childSessionId: 'c', label: 'c', mode: 'one-shot', activity: 'inactive' })
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 2, 'the viewer-close Esc ran the close path')
  // Back in main: the next Esc must RE-ARM (not read as a double-Esc).
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(singleEscapes, 3)
  assert.equal(cancels, 0, 'a stale window must not cancel after the viewer close')
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
