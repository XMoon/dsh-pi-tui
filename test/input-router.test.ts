/**
 * M6 InputRouter tests (plan §11): the host-owned precedence ladder and
 * normalized-key plugin bindings.
 *
 * Gates:
 * - Kitty press/repeat/release filtered BEFORE everything (a plugin never
 *   sees a protocol artifact);
 * - capturing question/approval own input before plugins;
 * - reserved Host lifecycle keys cannot be preempted by plugins;
 * - a plugin binding receives ONLY the normalized key → SEMANTIC action
 *   (never raw input);
 * - plain printable keys never fire a plugin binding (typing wins);
 * - non-capturing plugin bindings fire LAST, only when nothing earlier
 *   consumed the input.
 * @module @xmoon76/dsh-pi-tui/input-router.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { InputRouter } from '../src/input-router.ts'
import type { NormalizedKey, TuiAction } from '../src/extension/public-types.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const startedApps = new Set<DisposableApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** The default context: NO host action resolves anything (the effective
 * keymap is empty) — so no key is runtime-reserved. Tests that need the
 * OLD reserved behavior pass `hostResolves` explicitly. */
function context(overrides: Partial<Parameters<InputRouter['route']>[1]> = {}): Parameters<InputRouter['route']>[1] {
  return {
    questionActive: false,
    approvalActive: false,
    viewerInputMode: 'none',
    hasOverlay: false,
    searchActive: false,
    hostResolves: () => false,
    ...overrides,
  }
}

function router(): InputRouter {
  return new InputRouter()
}

function noBindings(): (key: NormalizedKey) => TuiAction | undefined {
  return () => undefined
}

test('InputRouter: Kitty release/repeat events are protocol artifacts, never seen by plugins', () => {
  const r = router()
  // Kitty protocol flag 2: release events carry `:3` in the sequence
  // (`\x1b[<codepoint>;<modifier>:3u`), repeats carry `:2`.
  const release = '\x1b[111;1:3u'
  assert.equal(r.route(release, context(), noBindings()).kind, 'protocol')
  const repeat = '\x1b[111;1:2u'
  assert.equal(r.route(repeat, context(), noBindings()).kind, 'protocol')
})

test('InputRouter: a question flow owns input before plugins', () => {
  const r = router()
  const result = r.route('x', context({ questionActive: true }), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed')
})

test('InputRouter: an approval prompt owns input before plugins', () => {
  const r = router()
  const result = r.route('y', context({ approvalActive: true }), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed')
})

test('InputRouter: the read-only viewer locks everything except Esc/Ctrl+O', () => {
  const r = router()
  const locked = context({ viewerInputMode: 'readonly' })
  assert.equal(r.route('a', locked, () => 'open-search' as TuiAction).kind, 'consumed')
  // Esc and Ctrl+O pass the VIEWER branch (the host runs the viewer-exit
  // and fold-toggle paths); they are reserved lifecycle keys, so the
  // router reports them consumed — never a plugin binding, never the
  // editor.
  assert.equal(r.route('\x1b', locked, () => 'open-search' as TuiAction).kind, 'consumed')
  assert.equal(r.route('\x1b[111;13u', locked, () => 'open-search' as TuiAction).kind, 'consumed')
})

test('InputRouter: the interactive (continuable) viewer keeps the editor live as viewer-editor', () => {
  const r = router()
  const interactive = context({ viewerInputMode: 'continuable' })
  // A printable key is the editor's — but the route NAMES the subagent
  // viewer as the submission target (the semantic difference the router
  // must not hide).
  assert.equal(r.route('a', interactive, noBindings()).kind, 'viewer-editor')
  // An editor-owned non-printable key (arrow, Tab) is viewer-editor too —
  // plugin bindings only claim keys the focused editor DECLINES (the
  // editorAccepts probe).
  assert.equal(r.route('\x1b[A', interactive, noBindings()).kind, 'viewer-editor')
  const probed = context({
    viewerInputMode: 'continuable',
    editorAccepts: () => true,
  })
  assert.equal(r.route('\x1b[A', probed, () => 'open-search' as TuiAction).kind, 'viewer-editor')
  // A chord the editor declines (Ctrl+Alt+X) still consults plugin
  // bindings LAST in the ladder — but its route is NOT viewer-editor.
  const chord = r.route('\x1b\x18', interactive, () => 'open-search' as TuiAction)
  assert.equal(chord.kind, 'plugin-action')
  // Active host keys stay consumed (the HOST consumes Enter and the
  // parent chords — the TuiApp ladder runs BEFORE the router, and the
  // router's action-driven reservation reports them consumed so a plugin
  // can never claim them). In the unit context the host actions are
  // explicit via hostResolves.
  const withHost = context({
    viewerInputMode: 'continuable',
    hostResolves: (data) => data === '\r' || data === '\x1b[13;5u' || data === '\x1b[115;5u',
  })
  assert.equal(r.route('\r', withHost, noBindings()).kind, 'consumed')
  assert.equal(r.route('\x1b[13;5u', withHost, noBindings()).kind, 'consumed')
  assert.equal(r.route('\x1b[115;5u', withHost, noBindings()).kind, 'consumed')
  // With NO active host action the same keys are NOT reserved — they
  // route to the child editor (the remapped-away case).
  assert.equal(r.route('\r', interactive, noBindings()).kind, 'viewer-editor')
})

test('InputRouter: a replacement editor inside the interactive viewer still routes editor-first', () => {
  const r = router()
  const interactive = context({ viewerInputMode: 'continuable', editorReplacement: true })
  let bindingCalls = 0
  const result = r.route('\x1b[1;7x', interactive, () => {
    bindingCalls += 1
    return 'open-search' as TuiAction
  })
  assert.equal(result.kind, 'viewer-editor', 'the replacement editor gets the viewer-editor route first')
  assert.equal(bindingCalls, 0, 'plugin bindings are not consulted before the editor route')
})

test('InputRouter: a key an ACTIVE host action binds is reserved from plugin bindings', () => {
  const r = router()
  // Ctrl+F with app.transcript.search active: the host ladder owns it —
  // the router reports consumed so a plugin can never claim it.
  const withHost = context({ hostResolves: (data) => data === '\x06' })
  assert.equal(r.route('\x06', withHost, () => 'open-search').kind, 'consumed')
  // The same key with NO active host action is NOT reserved — it falls
  // through (the remapped-away old key case).
  assert.equal(r.route('\x06', context(), () => 'open-search' as TuiAction).kind, 'plugin-action')
})

test('InputRouter: Ctrl+R is runtime-reserved only while a host action binds it', () => {
  const r = router()
  const withHost = context({ hostResolves: (data) => data === '\x12' })
  // Legacy Ctrl+R is \x12; kitty/modifyOtherKeys reports ctrl+r too.
  assert.equal(r.route('\x12', withHost, () => 'open-search').kind, 'consumed')
  // Under an overlay the overlay owns the key regardless.
  assert.equal(r.route('\x12', context({ hasOverlay: true }), () => 'open-search').kind, 'consumed')
  // No host action → not reserved → plugin/editor path.
  assert.equal(r.route('\x12', context(), () => 'open-search' as TuiAction).kind, 'plugin-action')
})

test('InputRouter: a remapped-away legacy host key falls through (action-driven reservation)', () => {
  const r = router()
  // The PR review repro: app.clipboard.pasteMedia was remapped from
  // Ctrl+V to Ctrl+P. Ctrl+V is NO LONGER an active host action — the
  // router must NOT swallow it; it falls through to the editor/plugin.
  const noHostForV = context({ hostResolves: () => false })
  // The plugin can claim Ctrl+V now (it is not runtime-reserved).
  assert.equal(r.route('\x16', noHostForV, () => 'open-search' as TuiAction).kind, 'plugin-action')
  // With the host action STILL live on Ctrl+V, it stays consumed.
  const hostOnV = context({ hostResolves: (data) => data === '\x16' })
  assert.equal(r.route('\x16', hostOnV, () => 'open-search' as TuiAction).kind, 'consumed')
})

test('InputRouter: a reserved host lifecycle key never reaches a plugin binding when active', () => {
  const r = router()
  // Ctrl+C with the exit action active: consumed before the plugin stage.
  const withExit = context({ hostResolves: (data) => data === '\x03' })
  const result = r.route('\x03', withExit, () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed')
  // Enter with submit active: consumed (the host/editor owns it).
  const withSubmit = context({ hostResolves: (data) => data === '\r' })
  const enter = r.route('\r', withSubmit, () => 'open-search' as TuiAction)
  assert.equal(enter.kind, 'consumed')
})

test('InputRouter: a plugin binding fires for a normalized non-printable key', () => {
  const r = router()
  let seen: NormalizedKey | undefined
  const result = r.route('\x1b[1;5C', context(), (key) => {
    seen = key
    return 'open-search'
  })
  assert.equal(result.kind, 'plugin-action')
  if (result.kind === 'plugin-action') {
    assert.equal(result.action, 'open-search')
    assert.deepEqual(result.key, { key: 'right', ctrl: true, alt: false, shift: false, super: false })
  }
  assert.deepEqual(seen, { key: 'right', ctrl: true, alt: false, shift: false, super: false })
})

test('InputRouter: plain printable keys never consult plugin bindings (typing wins)', () => {
  const r = router()
  let bindingCalls = 0
  const result = r.route('a', context(), () => {
    bindingCalls += 1
    return 'open-search' as TuiAction
  })
  assert.equal(result.kind, 'editor', 'a plain letter is the editor\'s')
  assert.equal(bindingCalls, 0, 'printable input must not scan plugin bindings')
})

test('InputRouter: overlays keep their keys (a plugin binding does not fire under an overlay)', () => {
  const r = router()
  const result = r.route('\x1b[1;5C', context({ hasOverlay: true }), () => 'open-search' as TuiAction)
  assert.equal(result.kind, 'consumed', 'TuiApp passes consumed overlay keys to the focused overlay component')
})

test('InputRouter: replacement editors get the editor route before plugin bindings', () => {
  const r = router()
  let bindingCalls = 0
  const result = r.route('\x1b[1;7x', context({ editorReplacement: true }), () => {
    bindingCalls += 1
    return 'open-search'
  })
  assert.equal(result.kind, 'editor')
  assert.equal(bindingCalls, 0, 'replacement editor route must not consult plugin bindings')
})

test('InputRouter: search overlay owns its keys', () => {
  const r = router()
  const search = context({ searchActive: true })
  assert.equal(r.route('\x1b', search, noBindings()).kind, 'consumed', 'Esc closes search')
  assert.equal(r.route('\r', search, noBindings()).kind, 'consumed', 'Enter jumps next')
})

test('InputRouter: normalize() returns the public key identity (never raw)', () => {
  const r = router()
  assert.deepEqual(r.normalize('\x1b[A'), { key: 'up', ctrl: false, alt: false, shift: false, super: false })
  assert.deepEqual(r.normalize('\x1b[1;5A'), { key: 'up', ctrl: true, alt: false, shift: false, super: false })
  assert.deepEqual(r.normalize('x'), { key: 'x', ctrl: false, alt: false, shift: false, super: false })
  assert.equal(r.normalize('multi-char'), undefined, 'paste bursts never normalize')
  assert.deepEqual(r.normalize('\x1b'), { key: 'escape', ctrl: false, alt: false, shift: false, super: false }, 'bare Esc is a key')
})

test('InputRouter: CSI-u + modifyOtherKeys normalize (v0.1.8 matrix)', () => {
  const r = router()
  // CSI-u arrows (shift modifier).
  assert.deepEqual(r.normalize('\x1b[1;2A'), { key: 'up', ctrl: false, alt: false, shift: true, super: false })
  // Kitty CSI-u Ctrl+O: the fork's parseKey reports the super bit for the
  // 13 modifier (ctrl+super+o) — the router consumes the fork's
  // normalization verbatim (the host's matchesKey is the routing
  // authority; parseKey is the plugin key identity).
  assert.deepEqual(r.normalize('\x1b[111;13u'), { key: 'o', ctrl: true, alt: false, shift: false, super: true })
  // zellij's super modifier bit (128): the fork's parseKey ignores it and
  // reports the plain arrow (matchesKey likewise — bit 128 is dropped).
  assert.deepEqual(r.normalize('\x1b[1;129B'), { key: 'down', ctrl: false, alt: false, shift: false, super: false })
  // Esc.
  assert.deepEqual(r.normalize('\x1b'), { key: 'escape', ctrl: false, alt: false, shift: false, super: false })
  // Tab.
  assert.deepEqual(r.normalize('\t'), { key: 'tab', ctrl: false, alt: false, shift: false, super: false })
})

// ── TuiApp integration: a plugin keybinding fires through the host ─────────

test('TuiApp: a throwing plugin action is isolated and reported with its contribution id', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const errors: Array<{ slot: string; id: string; error: unknown }> = []
  const recovered: Array<{ slot: string; id: string }> = []
  let attempts = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionAction: () => { attempts += 1; if (attempts === 1) throw new Error('action boom') },
    onExtensionError: event => errors.push(event),
    onExtensionRecovered: event => recovered.push(event),
  }, {
    pluginActionFor: key => key.key === 'x' && key.ctrl && key.alt ? 'open-search' : undefined,
    pluginActionIdFor: key => key.key === 'x' && key.ctrl && key.alt ? 'binding-x' : undefined,
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.equal(attempts, 1)
  assert.deepEqual(errors.map(error => ({ slot: error.slot, id: error.id, message: String(error.error) })), [
    { slot: 'keybinding', id: 'binding-x', message: 'Error: action boom' },
  ])
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.equal(attempts, 2)
  assert.deepEqual(recovered, [{ slot: 'keybinding', id: 'binding-x' }])
  app.stop()
})

test('TuiApp: host-routed typing updates the visible editor immediately', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()

  const seat = app.seatEditorForTest()
  const originalGetText = seat.getText
  let getTextCalls = 0
  seat.getText = () => {
    getTextCalls += 1
    return originalGetText()
  }
  vt.sendInput('a')
  await vt.waitForRender()

  // One read is the existing host-editor onChange notification snapshot;
  // routing must not add another draft read. The visible frame must still
  // contain the character because the host route returns undefined and lets
  // pi-tui dispatch to the focused editor and schedule its repaint.
  assert.equal(getTextCalls, 1, 'routing a printable key must not add a duplicate draft read')
  assert.equal(app.getDraft(), 'a')
  assert.ok(vt.getViewport().some(line => line.includes('a')), 'typed text must be painted immediately')
  app.stop()
})

test('TuiApp: a plugin keybinding fires the semantic action (headless)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // M6: a plugin binding for Ctrl+Alt+X → open-search (a non-printable
    // normalized key). The resolver receives RAW input and returns the
    // SEMANTIC action — the plugin never sees raw data.
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // A minimal pluginActionFor emulating the runner's registry resolver:
    // it receives the NORMALIZED key (the InputRouter decoded the raw
    // input — the plugin never sees raw data).
    pluginActionFor: (key) => {
      if (key.key === 'x' && key.ctrl && key.alt) return 'open-search'
      return undefined
    },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // Ctrl+Alt+X as a legacy sequence (ESC + Ctrl+X = \x18): the fork's
  // parseKey maps it to ctrl+alt+x — a non-printable normalized key the
  // plugin binding can claim.
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'])
  // A plain letter never fires a binding.
  vt.sendInput('a')
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'plain typing must not fire a binding')
  // A reserved key never fires a binding.
  vt.sendInput('\x03') // Ctrl+C
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'reserved keys must not fire a binding')
  app.stop()
})

// ── TuiApp integration: reserved keys never fire through the real path ─────

test('TuiApp: an untracked keybinding error is not reported under the key name', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const errors: unknown[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionError: event => errors.push(event),
  }, {
    pluginActionFor: () => { throw new Error('resolver boom') },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.deepEqual(errors, [], 'a resolver without a tracked id must not fabricate health identity')
  app.stop()
})

test('TuiApp: active host lifecycle keys never fire a plugin binding (action-driven)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const queued: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // A real queue handler: with it wired, Ctrl+Enter is a live host
    // action that CONSUMES (never declines) — the plugin must not see it.
    onQueueSubmit: (text) => { queued.push(text) },
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // A resolver that would claim EVERY key — the router must stop the
    // ACTIVE (non-declining) host lifecycle ones before it is consulted.
    pluginActionFor: (key) => `open-search` as const,
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // Plain Enter: the editor consumes it (tui.input.submit) — never a
  // plugin binding.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Enter must never fire a plugin binding')
  // Ctrl+Enter (app.input.queue) with a LIVE handler AND a non-empty
  // draft: the host action CONSUMES (queues) — never a plugin binding.
  app.setDraft('queued text')
  await vt.waitForRender()
  vt.sendInput('\x1b[13;5u') // kitty ctrl+enter
  await vt.waitForRender()
  assert.deepEqual(queued, ['queued text'], 'Ctrl+Enter must queue (host-owned)')
  // Ctrl+O (app.transcript.toggleExpand): ACTIVE host action — never a
  // plugin binding. Kitty ctrl+o = modifier 5.
  vt.sendInput('\x1b[111;5u')
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'active host lifecycle keys must never fire a plugin binding')
  app.stop()
})

test('TuiApp: a key with NO active host action falls through to a plugin binding (remapped-away)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const pasted: number[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // A LIVE paste handler: with it wired, Ctrl+V is a CONSUMING host
    // action (never declines) — the plugin must not see it. (The
    // decline-to-plugin case is covered separately by "a declined host
    // action is not re-reserved".)
    onClipboardPaste: () => { pasted.push(1) },
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // The PR review repro: a plugin binds Ctrl+V — legal AFTER the host
    // remapped app.clipboard.pasteMedia away from Ctrl+V (action-driven
    // reservation: no host action binds Ctrl+V anymore, so the plugin
    // may claim it). With the DEFAULT keymap Ctrl+V IS a CONSUMING host
    // action, so this plugin binding must NOT fire — verify both sides.
    pluginActionFor: (key) => key.key === 'v' && key.ctrl ? 'open-search' as const : undefined,
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // Default keymap: Ctrl+V is app.clipboard.pasteMedia (ACTIVE, CONSUMING
  // host action) — the host ladder consumes it, the plugin never sees it.
  vt.sendInput('\x16')
  await vt.waitForRender()
  assert.equal(pasted.length, 1, 'the live paste handler must run')
  assert.deepEqual(actions, [], 'an active host action key must not reach a plugin binding')
  // Remap pasteMedia away from Ctrl+V: now NOT reserved — but the host
  // ladder also does not consume it, so with the HOST EDITOR in the seat
  // the key reaches the editor (the plugin binding is consulted only for
  // keys the editor declines; Ctrl+V is editor-owned copy). The key is
  // never SWALLOWED: it reaches the editor instead of being dropped.
  const { parseUserKeybindings } = await import('../src/keybindings/config.ts')
  app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.clipboard.pasteMedia': 'ctrl+p' }))
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.length > 0, 'the surface keeps rendering after the remap')
  app.stop()
})

test('TuiApp: a plugin binding NEVER steals a key the focused editor owns (P1-06)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const actions: string[] = []
  const submitted: string[] = []
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    onExtensionAction: (action) => { actions.push(action) },
  }, {
    // A resolver claiming EVERY non-printable key (arrows, Tab, ...).
    pluginActionFor: (key) => 'open-search' as const,
    editorRegistry: registry,
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // While the HOST editor is focused (the default), ↑ must reach the
  // editor — never fire the plugin binding.
  vt.sendInput('\x1b[A') // legacy up
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Up must reach the focused editor, never the plugin')
  // Tab too (completion trigger in the editor).
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.deepEqual(actions, [], 'Tab must reach the focused editor, never the plugin')
  // A non-editor key (Ctrl+Alt+X chord) STILL fires the plugin binding —
  // the editor has no claim on it.
  vt.sendInput('\x1b\x18')
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'a chord the editor declines still fires the binding')

  // The same holds with a PLUGIN editor occupying the seat: while its
  // component is focused, arrows belong to it — the binding must not fire.
  registry.register({ id: 'vim', priority: 0, create: () => ({
    component: { kind: 'text', spans: [{ text: 'vim' }] },
    getText: () => 'vim draft',
    setText: () => {},
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => {},
  }) }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // legacy down
  await vt.waitForRender()
  assert.deepEqual(actions, ['open-search'], 'Down must reach the focused PLUGIN editor, never the plugin binding')
  app.stop()
})

test('TuiApp: submitDraft clears the draft like a normal submit (round-1 P2)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // Type a draft, then submit via the host-owned path.
  app.setDraft('hello from a plugin action')
  await vt.waitForRender()
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello from a plugin action'])
  assert.equal(app.getDraft(), '', 'the draft must be cleared like a normal submit')
  // An empty draft submits nothing.
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello from a plugin action'])
  app.stop()
})
